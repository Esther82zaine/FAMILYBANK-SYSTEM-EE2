const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('./db');
const redis = require('./redis');
const sms = require('./sms');

// Step 1: check the PIN, then send a six-digit OTP valid for five minutes.
async function login(phone, pin) {
  const user = await db.findUserByPhone(phone);
  if (!user || user.status === 'LOCKED') throw new Error('Access denied');
  const ok = await bcrypt.compare(pin, user.pin_hash);
  if (!ok) {
    const n = await redis.incr(`fail:${user.user_id}`);
    await redis.expire(`fail:${user.user_id}`, 900);
    if (n >= 3) await db.lockUser(user.user_id);
    throw new Error('Invalid credentials');
  }
  const otp = String(crypto.randomInt(100000, 999999));
  await db.saveOtp(user.user_id, await bcrypt.hash(otp, 8), 5 * 60);
  await sms.send(user.phone, `Your code is ${otp}`);
  return { step: 'OTP_REQUIRED' };
}

function issueToken(user) {
  return jwt.sign({ sub: user.user_id, role: user.role },
    process.env.JWT_SECRET, { expiresIn: '15m' });
}

// Step 2: check the OTP. Only now is a signed token issued.
async function verifyOtp(phone, code) {
  const user = await db.findUserByPhone(phone);
  if (!user || user.status === 'LOCKED') throw new Error('Access denied');
  const otp = await db.latestOtp(user.user_id);
  if (!otp) throw new Error('Code expired. Tap resend.');
  if (!(await bcrypt.compare(String(code), otp.code_hash))) throw new Error('Wrong code');
  await db.markOtpUsed(otp.otp_id);
  await redis.del(`fail:${user.user_id}`);
  return { user, token: issueToken(user) };
}

// Re-check the PIN before any action that moves money.
async function verifyPin(userId, pin) {
  const user = await db.findUserById(userId);
  if (!user || user.status === 'LOCKED') throw new Error('Access denied');
  if (!(await bcrypt.compare(String(pin), user.pin_hash))) {
    const n = await redis.incr(`fail:${userId}`);
    await redis.expire(`fail:${userId}`, 900);
    if (n >= 3) await db.lockUser(userId);
    throw new Error('Wrong PIN');
  }
}

function verifyToken(req) {
  const url = new URL(req.url, 'http://localhost');
  const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
  const token = bearer || url.searchParams.get('token') || '';
  return jwt.verify(token, process.env.JWT_SECRET);
}

// Express middleware: reject any request without a valid token (HTTP 401).
function requireAuth(roles) {
  return (req, res, next) => {
    try {
      req.user = verifyToken(req);
    } catch (e) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (roles && !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

module.exports = { login, issueToken, verifyOtp, verifyPin, verifyToken, requireAuth };
