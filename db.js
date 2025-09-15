
const { Pool } = require('pg');
const config = require('./settings');

const pool = new Pool(config.db);

async function ensureConnected() {
  await pool.query('SELECT 1');
  console.log('Connected to Postgres:', config.db.database || config.db.connectionString || '');
}

async function shutdown() {
  try {
    await pool.end();
    console.log('Postgres pool closed');
  } catch (e) {
    console.error('Error closing pool:', e);
  }
}

module.exports = { pool, ensureConnected, shutdown };
