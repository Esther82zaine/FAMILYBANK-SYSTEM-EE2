const fs = require('fs');
const { Pool } = require('pg');

const password = process.env.DB_PASSWORD_FILE
  ? fs.readFileSync(process.env.DB_PASSWORD_FILE, 'utf8').trim()
  : process.env.DB_PASSWORD;

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'familybank',
  user: process.env.DB_USER || 'fbuser',
  password,
  max: 10,
});

const query = (text, params) => pool.query(text, params);

async function findUserByPhone(phone) {
  const r = await query('SELECT * FROM users WHERE phone = $1', [phone]);
  return r.rows[0];
}
async function findUserById(id) {
  const r = await query('SELECT * FROM users WHERE user_id = $1', [id]);
  return r.rows[0];
}
async function lockUser(id) {
  await query("UPDATE users SET status = 'LOCKED' WHERE user_id = $1", [id]);
}
async function accountOfUser(userId) {
  const r = await query('SELECT * FROM accounts WHERE user_id = $1 ORDER BY account_id LIMIT 1', [userId]);
  return r.rows[0];
}
async function accountByNumber(number) {
  const r = await query('SELECT * FROM accounts WHERE account_number = $1', [number]);
  return r.rows[0];
}
async function saveOtp(userId, codeHash, ttlSeconds) {
  await query(
    'INSERT INTO otp_codes(user_id, code_hash, expires_at) VALUES($1, $2, NOW() + make_interval(secs => $3))',
    [userId, codeHash, ttlSeconds]);
}
async function latestOtp(userId) {
  const r = await query(
    `SELECT * FROM otp_codes WHERE user_id = $1 AND used = FALSE AND expires_at > NOW()
     ORDER BY otp_id DESC LIMIT 1`, [userId]);
  return r.rows[0];
}
async function markOtpUsed(otpId) {
  await query('UPDATE otp_codes SET used = TRUE WHERE otp_id = $1', [otpId]);
}
async function saveNotification(evt) {
  await query(
    "INSERT INTO notifications(user_id, txn_id, channel, message) VALUES($1, $2, 'IN_APP', $3)",
    [evt.userId, evt.txnId || null, `Transaction of KES ${evt.amount} successful`]);
}

module.exports = {
  pool, query, findUserByPhone, findUserById, lockUser, accountOfUser,
  accountByNumber, saveOtp, latestOtp, markOtpUsed, saveNotification,
};
