const { WebSocketServer } = require('ws');
const { subscribe } = require('./events');
const { verifyToken } = require('./auth');
const push = require('./push');
const sms = require('./sms');
const db = require('./db');

const clients = new Map(); // userId -> socket

function attachWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws, req) => {
    let user;
    try { user = verifyToken(req); }          // reject if token invalid
    catch (e) { return ws.close(4401, 'Unauthorized'); }
    clients.set(user.sub, ws);
    ws.on('close', () => clients.delete(user.sub));
  });
}

async function startNotifications() {
  await subscribe('transaction.completed', async (evt) => {
    const ws = clients.get(evt.userId);
    if (ws && ws.readyState === 1)
      ws.send(JSON.stringify({ type: 'TXN', txnId: evt.txnId, amount: evt.amount }));
    await push.send(evt.userId, `Transaction of KES ${evt.amount} successful`);
    await sms.sendToUser(evt.userId, `KES ${evt.amount} transaction successful.`);
    await db.saveNotification(evt);
  });
}

module.exports = { attachWebSocket, startNotifications };
