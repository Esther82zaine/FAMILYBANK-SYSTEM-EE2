const axios = require('axios');
const db = require('./db');
const { pool } = require('./db');
const { publishEvent } = require('./events');

const DARAJA_URL = process.env.DARAJA_URL || 'https://sandbox.safaricom.co.ke';
const SHORTCODE = process.env.MPESA_SHORTCODE;
const PASSKEY = process.env.MPESA_PASSKEY;

// Daraja keys come from environment variables and never appear in the code.
async function getDarajaToken() {
  const basic = Buffer.from(
    `${process.env.DARAJA_CONSUMER_KEY}:${process.env.DARAJA_CONSUMER_SECRET}`).toString('base64');
  const r = await axios.get(`${DARAJA_URL}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${basic}` } });
  return r.data.access_token;
}

// 0712345678 -> 254712345678
const toMsisdn = (phone) => phone.replace(/^0/, '254');

async function stkPush(phone, amount, ref) {
  const token = await getDarajaToken();
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const pwd = Buffer.from(SHORTCODE + PASSKEY + ts).toString('base64');
  return axios.post(DARAJA_URL + '/mpesa/stkpush/v1/processrequest', {
    BusinessShortCode: SHORTCODE, Password: pwd, Timestamp: ts,
    TransactionType: 'CustomerPayBillOnline', Amount: amount,
    PartyA: phone, PartyB: SHORTCODE, PhoneNumber: phone,
    CallBackURL: process.env.MPESA_CALLBACK_URL,
    AccountReference: ref, TransactionDesc: 'Account deposit'
  }, { headers: { Authorization: `Bearer ${token}` } });
}

// Called by the route: sends the prompt and remembers the pending request.
async function startDeposit(user, phone, amount) {
  const acc = await db.accountOfUser(user.user_id);
  const msisdn = toMsisdn(phone);
  const res = await stkPush(msisdn, Math.round(amount), acc.account_number);
  await db.query(
    `INSERT INTO mpesa_requests(checkout_id,user_id,account_id,phone,amount)
     VALUES($1,$2,$3,$4,$5)`,
    [res.data.CheckoutRequestID, user.user_id, acc.account_id, msisdn, amount]);
  return { checkoutId: res.data.CheckoutRequestID };
}

const meta = (cb, name) =>
  (cb.CallbackMetadata?.Item || []).find((i) => i.Name === name)?.Value;

// Credit once: only a pending request whose amount matches and whose
// receipt number (unique constraint) has not been seen before.
async function creditOnce(cb) {
  const receipt = String(meta(cb, 'MpesaReceiptNumber'));
  const paid = Number(meta(cb, 'Amount'));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const q = await client.query(
      'SELECT * FROM mpesa_requests WHERE checkout_id = $1 FOR UPDATE', [cb.CheckoutRequestID]);
    const req = q.rows[0];
    if (!req || req.status !== 'PENDING' || Number(req.amount) !== paid) {
      await client.query('ROLLBACK');
      return { credited: false };
    }
    await client.query(
      "UPDATE mpesa_requests SET status = 'SUCCESS', receipt = $2 WHERE checkout_id = $1",
      [req.checkout_id, receipt]);
    await client.query('UPDATE accounts SET balance = balance + $1 WHERE account_id = $2',
      [paid, req.account_id]);
    const t = await client.query(
      `INSERT INTO transactions(to_account,amount,type,status,reference,description)
       VALUES($1,$2,'MPESA','SUCCESS',$3,$4) RETURNING txn_id`,
      [req.account_id, paid, receipt, `M-Pesa deposit from ${req.phone}`]);
    await client.query('COMMIT');
    await publishEvent('transaction.completed',
      { txnId: t.rows[0].txn_id, userId: req.user_id, amount: paid, direction: 'credited' });
    return { credited: true };
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return { credited: false }; // repeated receipt number
    throw e;
  } finally { client.release(); }
}

async function markFailed(cb) {
  const q = await db.query(
    `UPDATE mpesa_requests SET status = 'FAILED'
     WHERE checkout_id = $1 AND status = 'PENDING' RETURNING account_id, amount`,
    [cb.CheckoutRequestID]);
  if (q.rowCount) {
    await db.query(
      `INSERT INTO transactions(to_account,amount,type,status,reference,description)
       VALUES($1,$2,'MPESA','FAILED',$3,'M-Pesa deposit cancelled') ON CONFLICT DO NOTHING`,
      [q.rows[0].account_id, q.rows[0].amount, cb.CheckoutRequestID.slice(0, 40)]);
  }
}

module.exports = { stkPush, startDeposit, creditOnce, markFailed, getDarajaToken };
