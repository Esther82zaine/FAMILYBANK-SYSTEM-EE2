// Sandbox SMS gateway: prints the message. Replace the body of send() with a
// call to a real SMS provider (for example Africa's Talking) for live use.
const db = require('./db');

async function send(phone, message) {
  console.log(`[SMS sandbox] to ${phone}: ${message}`);
}

async function sendToUser(userId, message) {
  const user = await db.findUserById(userId);
  if (user) await send(user.phone, message);
}

module.exports = { send, sendToUser };
