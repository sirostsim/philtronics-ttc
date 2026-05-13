/**
 * migrations/runner.js
 * Simple file-based migration runner.
 * Migrations are plain SQL files named NNN_description.sql
 * Already-applied migrations are tracked in the `migrations` table.
 */

'use strict';

const db   = require('../db');
const fs   = require('fs');
const path = require('path');

// Ensure migrations tracking table exists
db.exec(`
  CREATE TABLE IF NOT EXISTS migrations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    filename   TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const migrationsDir = path.join(__dirname);

const files = fs.readdirSync(migrationsDir)
  .filter(f => f.endsWith('.sql'))
  .sort();

for (const file of files) {
  const applied = db.prepare('SELECT 1 FROM migrations WHERE filename = ?').get(file);
  if (applied) {
    console.log(`  [skip]  ${file}`);
    continue;
  }

  const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
  try {
    db.exec(sql);
    db.prepare('INSERT INTO migrations (filename) VALUES (?)').run(file);
    console.log(`  [apply] ${file}`);
  } catch (err) {
    console.error(`  [ERROR] ${file}: ${err.message}`);
    process.exit(1);
  }
}

console.log('Migrations complete.');
