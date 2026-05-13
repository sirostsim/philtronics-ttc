/**
 * migrations/runner.js – PostgreSQL async migration runner
 */

'use strict';

require('dotenv').config();
const { pool } = require('../db');
const fs   = require('fs');
const path = require('path');

async function runMigrations() {
  const client = await pool.connect();
  try {
    // Ensure migrations table exists first
    await client.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id         SERIAL PRIMARY KEY,
        filename   TEXT   NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const files = fs.readdirSync(__dirname)
      .filter(f => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const { rows } = await client.query(
        'SELECT 1 FROM migrations WHERE filename = $1', [file]
      );
      if (rows.length > 0) {
        console.log(`  [skip]  ${file}`);
        continue;
      }

      const sql = fs.readFileSync(path.join(__dirname, file), 'utf8');
      await client.query(sql);
      await client.query(
        'INSERT INTO migrations (filename) VALUES ($1)', [file]
      );
      console.log(`  [apply] ${file}`);
    }

    console.log('Migrations complete.');
  } finally {
    client.release();
  }
}

module.exports = runMigrations;

// Allow running directly: node migrations/runner.js
if (require.main === module) {
  runMigrations()
    .then(() => process.exit(0))
    .catch(err => { console.error(err.message); process.exit(1); });
}
