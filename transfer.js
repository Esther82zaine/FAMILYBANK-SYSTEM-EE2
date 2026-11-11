const { pool } = require('./db');
const { publishEvent } = require('./events');
const { auditEvent } = require('./audit');

const DAILY_LIMIT = 150000;
const FRAUD_THRESHOLD = 20000; // rule R1

// Runs inside an open database transaction: duplicate check, row lock,
// balance check and daily limit.
async function lockAndCheck(client, fromAcc, amount, reference) {
  const dup = await client.query(
    'SELECT 1 FROM transactions WHERE reference = $1', [reference]);
  if (dup.rowCount) throw new Error('Duplicate transaction');
  const s = await client.query(
    'SELECT balance FROM accounts WHERE account_id = $1 FOR UPDATE', [fromAcc]);
  if (Number(s.rows[0].balance) < amount) throw new Error('Insufficient funds');
  const sent = await client.query(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
     WHERE from_account = $1 AND status = 'SUCCESS' AND created_at::date = CURRENT_DATE`,
    [fromAcc]);
  if (Number(sent.rows[0].total) + amount > DAILY_LIMIT) throw new Error('Daily limit exceeded');
}

async function transfer({ fromAcc, toAcc, amount, reference, userId }) {
  amount = Number(amount);
  if (!(amount > 0)) throw new Error('Amount must be greater than zero');
  if (fromAcc === toAcc) throw new Error('You cannot send to your own account');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT user_id FROM accounts WHERE account_id = $1', [toAcc]);
    if (!r.rowCount) throw new Error('Recipient account not found');
    await lockAndCheck(client, fromAcc, amount, reference);
    await client.query('UPDATE accounts SET balance = balance - $1 WHERE account_id = $2',
      [amount, fromAcc]);
    await client.query('UPDATE accounts SET balance = balance + $1 WHERE account_id = $2',
      [amount, toAcc]);
    const t = await client.query(
      `INSERT INTO transactions(from_account,to_account,amount,type,status,reference)
       VALUES($1,$2,$3,'TRANSFER','SUCCESS',$4) RETURNING txn_id`,
      [fromAcc, toAcc, amount, reference]);
    await client.query('COMMIT');
    const txnId = t.rows[0].txn_id;
    // Events are published only after the commit succeeds.
    await publishEvent('transaction.completed', { txnId, userId, amount, direction: 'debited' });
    await publishEvent('transaction.completed',
      { txnId, userId: r.rows[0].user_id, amount, direction: 'credited' });
    if (amount >= FRAUD_THRESHOLD) await auditEvent(userId, 'FRAUD_ALERT_R1');
    return { status: 'SUCCESS', txnId };
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') throw new Error('Duplicate transaction');
    throw e;
  } finally { client.release(); }
}

async function payBill({ fromAcc, amount, reference, userId, biller, accountRef }) {
  amount = Number(amount);
  if (!(amount > 0)) throw new Error('Amount must be greater than zero');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockAndCheck(client, fromAcc, amount, reference);
    await client.query('UPDATE accounts SET balance = balance - $1 WHERE account_id = $2',
      [amount, fromAcc]);
    const t = await client.query(
      `INSERT INTO transactions(from_account,amount,type,status,reference,description)
       VALUES($1,$2,'BILL','SUCCESS',$3,$4) RETURNING txn_id`,
      [fromAcc, amount, reference, `Paid ${biller} (${accountRef})`.slice(0, 120)]);
    await client.query('COMMIT');
    await publishEvent('transaction.completed',
      { txnId: t.rows[0].txn_id, userId, amount, direction: 'debited' });
    return { status: 'SUCCESS', txnId: t.rows[0].txn_id };
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') throw new Error('Duplicate transaction');
    throw e;
  } finally { client.release(); }
}

// Failed attempts stay visible in the customer's history.
async function recordFailed({ fromAcc, amount, type, reference, reason }) {
  if (!(Number(amount) > 0) || reason === 'Duplicate transaction') return;
  const ref = `${reference}-F${Date.now().toString(36)}`.slice(0, 40);
  await pool.query(
    `INSERT INTO transactions(from_account,amount,type,status,reference,description)
     VALUES($1,$2,$3,'FAILED',$4,$5)`,
    [fromAcc, Number(amount), type, ref, reason.slice(0, 120)]);
}

module.exports = { transfer, payBill, recordFailed };
