const db = require('./db');

// Metadata only: never log PINs, one-time passwords or message contents.
function auditEvent(userId, action, ip, deviceId) {
  return db.query(
    'INSERT INTO audit_logs(user_id, action, ip_address, device_id) VALUES($1,$2,$3,$4)',
    [userId || null, action, ip || null, deviceId || null]);
}

function audit(req, action) {
  return db.query(
    'INSERT INTO audit_logs(user_id, action, ip_address, device_id) VALUES($1,$2,$3,$4)',
    [req.user?.sub || null, action, req.ip, req.headers['x-device-id'] || null]);
}

module.exports = { audit, auditEvent };
