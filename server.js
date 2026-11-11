const http = require('http');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const db = require('./db');
const redis = require('./redis');
const auth = require('./auth');
const { audit, auditEvent } = require('./audit');
const { connectQueue } = require('./events');
const { transfer, payBill, recordFailed } = require('./transfer');
const mpesa = require('./mpesa');
const { attachWebSocket, startNotifications } = require('./notifications');

const app = express();
app.set('trust proxy', 1);                       // behind the nginx proxy
app.use(helmet());
app.use(express.json({ limit: '10kb' }));
app.use(rateLimit({ windowMs: 60 * 1000, limit: 100, standardHeaders: true, legacyHeaders: false }));
const authLimiter = rateLimit({ windowMs: 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false });

const isStr = (v, re) => typeof v === 'string' && re.test(v);
const device = (req) => req.headers['x-device-id'] || null;

// Our own errors show their message; database or network errors do not.
const handler = (fn) => (req, res) => fn(req, res).catch((e) => {
  if (e.code) { console.error(e); return res.status(500).json({ error: 'Request failed' }); }
  res.status(400).json({ error: e.message });
});

app.get('/health', (req, res) => res.json({ ok: true }));

/* ---------- authentication ---------- */
app.post('/api/auth/login', authLimiter, handler(async (req, res) => {
  const { phone, pin } = req.body;
  if (!isStr(phone, /^0\d{9}$/) || !isStr(pin, /^\d{4}$/))
    return res.status(400).json({ error: 'Enter a valid phone number and 4-digit PIN' });
  try {
    const r = await auth.login(phone, pin);
    await auditEvent(null, 'LOGIN_PIN_OK', req.ip, device(req));
    res.json(r);
  } catch (e) {
    await auditEvent(null, 'LOGIN_FAILED', req.ip, device(req));
    res.status(401).json({ error: e.message });
  }
}));

app.post('/api/auth/verify-otp', authLimiter, handler(async (req, res) => {
  const { phone, code } = req.body;
  if (!isStr(phone, /^0\d{9}$/) || !isStr(code, /^\d{6}$/))
    return res.status(400).json({ error: 'Enter the 6-digit code' });
  try {
    const { user, token } = await auth.verifyOtp(phone, code);
    await auditEvent(user.user_id, 'LOGIN', req.ip, device(req));
    res.json({ token, name: user.full_name, role: user.role });
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
}));

/* ---------- customer: account and history ---------- */
app.get('/api/accounts/me', auth.requireAuth(), handler(async (req, res) => {
  const a = await db.accountOfUser(req.user.sub);
  res.json({ accountNumber: a.account_number, balance: a.balance, currency: a.currency });
}));

app.get('/api/transactions', auth.requireAuth(), handler(async (req, res) => {
  const a = await db.accountOfUser(req.user.sub);
  const r = await db.query(
    `SELECT txn_id, type, status, amount, reference, description, created_at,
            (to_account = $1) AS incoming
     FROM transactions WHERE from_account = $1 OR to_account = $1
     ORDER BY created_at DESC LIMIT 50`, [a.account_id]);
  res.json(r.rows);
}));

/* ---------- customer: transfer, bills, M-Pesa ---------- */
app.post('/api/transfers', auth.requireAuth(), handler(async (req, res) => {
  const { toAccountNumber, amount, reference, pin } = req.body;
  if (!isStr(reference, /^[A-Za-z0-9-]{6,40}$/)) throw new Error('A reference is required');
  await auth.verifyPin(req.user.sub, pin);
  const from = await db.accountOfUser(req.user.sub);
  const to = await db.accountByNumber(String(toAccountNumber));
  if (!to) throw new Error('Recipient account not found');
  try {
    const r = await transfer({ fromAcc: from.account_id, toAcc: to.account_id,
      amount, reference, userId: req.user.sub });
    await audit(req, 'TRANSFER');
    res.json(r);
  } catch (e) {
    await recordFailed({ fromAcc: from.account_id, amount, type: 'TRANSFER',
      reference, reason: e.message });
    await audit(req, 'TRANSFER_REJECTED');
    throw e;
  }
}));

app.post('/api/payments/bills', auth.requireAuth(), handler(async (req, res) => {
  const { biller, accountRef, amount, reference, pin } = req.body;
  if (!isStr(reference, /^[A-Za-z0-9-]{6,40}$/)) throw new Error('A reference is required');
  if (!isStr(biller, /^.{2,40}$/) || !isStr(accountRef, /^.{1,30}$/))
    throw new Error('Enter the biller and the account or meter number');
  await auth.verifyPin(req.user.sub, pin);
  const from = await db.accountOfUser(req.user.sub);
  try {
    const r = await payBill({ fromAcc: from.account_id, amount, reference,
      userId: req.user.sub, biller, accountRef });
    await audit(req, 'BILL');
    res.json(r);
  } catch (e) {
    await recordFailed({ fromAcc: from.account_id, amount, type: 'BILL',
      reference, reason: e.message });
    await audit(req, 'BILL_REJECTED');
    throw e;
  }
}));

app.post('/api/payments/mpesa/deposit', auth.requireAuth(), handler(async (req, res) => {
  const { phone, amount } = req.body;
  if (!isStr(phone, /^0\d{9}$/) || !(Number(amount) >= 1)) throw new Error('Enter a valid number and amount');
  const user = await db.findUserById(req.user.sub);
  res.json(await mpesa.startDeposit(user, phone, Number(amount)));
}));

// Called by Safaricom, so it carries no token. It is protected by matching the
// CheckoutRequestID and amount to a pending request and by the unique receipt.
app.post('/api/payments/mpesa/callback', handler(async (req, res) => {
  const cb = req.body?.Body?.stkCallback;
  if (!cb) return res.status(400).json({ error: 'Bad callback' });
  if (cb.ResultCode === 0) await mpesa.creditOnce(cb);
  else await mpesa.markFailed(cb);
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
}));

/* ---------- support: tickets and feedback ---------- */
app.post('/api/tickets', auth.requireAuth(), handler(async (req, res) => {
  const { subject, description } = req.body;
  if (!isStr(subject, /^.{3,100}$/) || !isStr(description, /^[\s\S]{3,2000}$/))
    throw new Error('Add a subject and a description');
  const r = await db.query(
    'INSERT INTO tickets(user_id, subject, description) VALUES($1,$2,$3) RETURNING ticket_id, status',
    [req.user.sub, subject, description]);
  await audit(req, 'TICKET_CREATED');
  res.status(201).json(r.rows[0]);
}));

app.get('/api/tickets', auth.requireAuth(), handler(async (req, res) => {
  const staff = ['ADMIN', 'SUPPORT'].includes(req.user.role);
  const r = await db.query(
    `SELECT * FROM tickets ${staff ? '' : 'WHERE user_id = $1'} ORDER BY ticket_id DESC LIMIT 100`,
    staff ? [] : [req.user.sub]);
  res.json(r.rows);
}));

app.patch('/api/tickets/:id', auth.requireAuth(['ADMIN', 'SUPPORT']), handler(async (req, res) => {
  const { status } = req.body;
  if (!['OPEN', 'IN PROGRESS', 'RESOLVED'].includes(status)) throw new Error('Invalid status');
  await db.query('UPDATE tickets SET status = $1, assigned_to = $2 WHERE ticket_id = $3',
    [status, req.user.sub, Number(req.params.id)]);
  await audit(req, 'TICKET_' + status.replace(' ', '_'));
  res.json({ ok: true });
}));

app.post('/api/feedback', auth.requireAuth(), handler(async (req, res) => {
  const { ticketId, txnId, rating, comment } = req.body;
  const n = Number(rating);
  if (!(n >= 1 && n <= 5)) throw new Error('Rating must be 1 to 5');
  await db.query(
    'INSERT INTO feedback(user_id, ticket_id, txn_id, rating, comment) VALUES($1,$2,$3,$4,$5)',
    [req.user.sub, ticketId || null, txnId || null, n, comment || null]);
  res.status(201).json({ ok: true });
}));

/* ---------- administrator ---------- */
app.get('/api/admin/summary', auth.requireAuth(['ADMIN']), handler(async (req, res) => {
  const r = await db.query(
    `SELECT
       (SELECT COUNT(*) FROM transactions WHERE status = 'SUCCESS') AS successful,
       (SELECT COUNT(*) FROM transactions WHERE status = 'FAILED')  AS failed,
       (SELECT COUNT(*) FROM tickets WHERE status <> 'RESOLVED')    AS open_tickets,
       (SELECT COUNT(*) FROM audit_logs WHERE action = 'FRAUD_ALERT_R1') AS fraud_alerts`);
  res.json(r.rows[0]);
}));

app.get('/api/admin/audit', auth.requireAuth(['ADMIN']), handler(async (req, res) => {
  const r = await db.query('SELECT * FROM audit_logs ORDER BY log_id DESC LIMIT 100');
  res.json(r.rows);
}));

app.post('/api/admin/users/:id/unlock', auth.requireAuth(['ADMIN']), handler(async (req, res) => {
  await db.query("UPDATE users SET status = 'ACTIVE' WHERE user_id = $1", [Number(req.params.id)]);
  await redis.del(`fail:${Number(req.params.id)}`);
  await audit(req, 'ADMIN_UNLOCK');
  res.json({ ok: true });
}));

/* ---------- start ---------- */
async function start() {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not set');
  await redis.connect();
  await connectQueue();
  const server = http.createServer(app);
  attachWebSocket(server);
  await startNotifications();
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, () => console.log(`Gateway listening on port ${port}`));
}

start().catch((e) => { console.error(e); process.exit(1); });
