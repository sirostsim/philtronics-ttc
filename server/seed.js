/**
 * seed.js – Seed initial users and sample item master data.
 * Run via: node seed.js
 * Safe to re-run: uses INSERT OR IGNORE.
 */

'use strict';

require('dotenv').config();
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

// Run migrations first
require('./migrations/runner');

const ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12', 10);

async function seed() {
  const users = [
    {
      id:        'usr_admin_001',
      username:  'admin',
      password:  'ChangeMeNow!',
      full_name: 'System Administrator',
      role:      'administrator',
    },
    {
      id:        'usr_manager_001',
      username:  'manager1',
      password:  'Manager123!',
      full_name: 'Production Manager',
      role:      'manager',
    },
    {
      id:        'usr_supervisor_001',
      username:  'supervisor1',
      password:  'Super123!',
      full_name: 'Line Supervisor',
      role:      'supervisor',
    },
    {
      id:        'usr_operator_001',
      username:  'operator1',
      password:  'Oper123!',
      full_name: 'John Smith',
      role:      'operator',
    },
    {
      id:        'usr_operator_002',
      username:  'operator2',
      password:  'Oper123!',
      full_name: 'Jane Doe',
      role:      'operator',
    },
  ];

  const insertUser = db.prepare(`
    INSERT OR IGNORE INTO users (id, username, password_hash, full_name, role)
    VALUES (@id, @username, @password_hash, @full_name, @role)
  `);

  for (const u of users) {
    const hash = await bcrypt.hash(u.password, ROUNDS);
    insertUser.run({ ...u, password_hash: hash });
    console.log(`  [seed] user: ${u.username} (${u.role})`);
  }

  // Sample item master entries
  const items = [
    { id: uuidv4(), item_number: 'PHL-1001', description: 'Main Control PCB Assembly' },
    { id: uuidv4(), item_number: 'PHL-1002', description: 'Power Supply Unit' },
    { id: uuidv4(), item_number: 'PHL-2001', description: 'Front Panel Sub-Assembly' },
    { id: uuidv4(), item_number: 'PHL-2002', description: 'Rear Connector Panel' },
    { id: uuidv4(), item_number: 'PHL-3001', description: 'Cable Harness A' },
    { id: uuidv4(), item_number: 'PHL-3002', description: 'Cable Harness B' },
  ];

  const insertItem = db.prepare(`
    INSERT OR IGNORE INTO item_master (id, item_number, description)
    VALUES (@id, @item_number, @description)
  `);

  for (const item of items) {
    insertItem.run(item);
    console.log(`  [seed] item: ${item.item_number}`);
  }

  console.log('\nSeed complete.');
  console.log('\n⚠️  CHANGE DEFAULT PASSWORDS before going live!');
  console.log('   admin / ChangeMeNow!');
}

seed().catch(err => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
