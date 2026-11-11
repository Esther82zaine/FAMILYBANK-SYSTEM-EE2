// Sandbox push service: prints the message. Replace with Firebase Cloud
// Messaging (firebase-admin) and a stored device token for live use.
async function send(userId, message) {
  console.log(`[FCM sandbox] to user ${userId}: ${message}`);
}

module.exports = { send };
