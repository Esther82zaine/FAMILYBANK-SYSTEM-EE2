const amqp = require('amqplib');

const EXCHANGE = 'events';
let channel;

async function connectQueue() {
  for (let attempt = 1; attempt <= 20; attempt++) {
    try {
      const conn = await amqp.connect(process.env.AMQP_URL);
      channel = await conn.createChannel();
      await channel.assertExchange(EXCHANGE, 'topic', { durable: true });
      console.log('Connected to RabbitMQ');
      return;
    } catch (e) {
      console.log(`RabbitMQ not ready (attempt ${attempt}): ${e.message}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new Error('Could not connect to RabbitMQ');
}

async function publishEvent(topic, payload) {
  channel.publish(EXCHANGE, topic, Buffer.from(JSON.stringify(payload)), { persistent: true });
}

async function subscribe(topic, handler) {
  const queue = `q.${topic}`;
  await channel.assertQueue(queue, { durable: true });
  await channel.bindQueue(queue, EXCHANGE, topic);
  await channel.consume(queue, async (msg) => {
    if (!msg) return;
    try {
      await handler(JSON.parse(msg.content.toString()));
      channel.ack(msg);
    } catch (e) {
      console.error('Event handler failed:', e.message);
      channel.nack(msg, false, false);
    }
  });
}

module.exports = { connectQueue, publishEvent, subscribe };
