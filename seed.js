// Creates synthetic demo customers, one administrator and one support agent.
// Run after the stack is up:  docker compose exec gateway node scripts/seed.js
const bcrypt = require('bcrypt');
const db = require('../src/db');

const people = [
  { name: 'Amina Wanjiku', phone: '0712345678', pin: '1234', role: 'CUSTOMER', acc: '1001234567', bal: 48500 },
  { name: 'Brian Otieno',  phone: '0722111222', pin: '4321', role: 'CUSTOMER', acc: '1007654321', bal: 12000 },
  { name: 'Grace Mwende',  phone: '0733555666', pin: '1111', role: 'CUSTOMER', acc: '1009988776', bal: 90000 },
  { name: 'Demo Admin',    phone: '0700000001', pin: '9999', role: 'ADMIN',    acc: '1000000001', bal: 0 },
  { name: 'Demo Support',  phone: '0700000002', pin: '8888', role: 'SUPPORT',  acc: '1000000002', bal: 0 },
];

(async () => {
  for (const p of people) {
    const u = await db.query(
      `INSERT INTO users(full_name, phone, pin_hash, role) VALUES($1,$2,$3,$4)
       ON CONFLICT (phone) DO NOTHING RETURNING user_id`,
      [p.name, p.phone, await bcrypt.hash(p.pin, 10), p.role]);
    if (u.rowCount) {
      await db.query('INSERT INTO accounts(user_id, account_number, balance) VALUES($1,$2,$3)',
        [u.rows[0].user_id, p.acc, p.bal]);
    }
  }
  console.log('Seed complete');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
