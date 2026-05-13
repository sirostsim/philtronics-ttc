/**
 * db.js – SQLite connection singleton using better-sqlite3
 * All queries are synchronous (better-sqlite3 is sync by design).
 */

'use strict';

require('dotenv').config();
const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

const dbPath = process.env.DB_PATH || './data/philtronics.db';

// Ensure data directory exists
const dir = path.dirname(path.resolve(dbPath));
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(path.resolve(dbPath));

// Performance & integrity pragmas
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

module.exports = db;
