/**
 * db.js – PostgreSQL connection pool using the 'pg' library.
 * Railway automatically provides DATABASE_URL when you add a Postgres service.
 * 
 * Usage: const { query, getClient } = require('./db');
 *   query(text, params)  – run a single query, returns rows array
 *   getClient()          – get a pool client for transactions
 */

'use strict';

require('dotenv').config();
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('❌  DATABASE_URL environment variable is not set.');
  console.error('    Add a PostgreSQL database to your Railway project.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway Postgres requires SSL in production
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
  max: 10,               // max pool connections
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err.message);
});

/**
 * query(text, params) – convenience wrapper, returns result.rows
 */
async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    return res.rows;
  } catch (err) {
    console.error('DB query error:', err.message, '| SQL:', text);
    throw err;
  }
}

/**
 * queryOne(text, params) – returns first row or null
 */
async function queryOne(text, params) {
  const rows = await query(text, params);
  return rows[0] || null;
}

/**
 * getClient() – returns a pool client (caller must release it)
 */
async function getClient() {
  return pool.connect();
}

/**
 * waitForConnection() -- wait for Postgres to accept connections, retrying with
 * exponential backoff. Called at boot (before migrations/seed) so a transient
 * database blip does not crash the process and fail the Railway healthcheck.
 * Throws once the attempts are exhausted so a genuine outage still surfaces.
 */
async function waitForConnection({ retries = 10, baseDelayMs = 1000, maxDelayMs = 5000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const client = await pool.connect();
      try { await client.query('SELECT 1'); } finally { client.release(); }
      if (attempt > 1) console.log(`Database reachable after ${attempt} attempt(s).`);
      return;
    } catch (err) {
      if (attempt >= retries) {
        console.error(`Database not reachable after ${attempt} attempt(s): ${err.message}`);
        throw err;
      }
      const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
      console.warn(`Database not ready (attempt ${attempt}/${retries}): ${err.message}. Retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

module.exports = { query, queryOne, getClient, pool, waitForConnection };
