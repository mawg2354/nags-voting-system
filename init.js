require('dotenv').config();
const { Client } = require('pg');

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

async function initDb() {
  try {
    await client.connect();

    await client.query(`CREATE TABLE IF NOT EXISTS elections (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Draft',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // Added abstain_votes column
    await client.query(`CREATE TABLE IF NOT EXISTS portfolios (
      id SERIAL PRIMARY KEY,
      election_id INTEGER NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      abstain_votes INTEGER NOT NULL DEFAULT 0
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS candidates (
      id SERIAL PRIMARY KEY,
      portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      bio TEXT,
      photo_url TEXT,
      votes INTEGER NOT NULL DEFAULT 0
    )`);

    // Added sent_to column to optionally track emails
    await client.query(`CREATE TABLE IF NOT EXISTS tokens (
      id SERIAL PRIMARY KEY,
      election_id INTEGER NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
      token TEXT UNIQUE NOT NULL,
      sent_to TEXT,
      has_voted BOOLEAN NOT NULL DEFAULT FALSE
    )`);

    console.log('Database initialized successfully with Abstain and Email tracking schema.');
  } catch (err) {
    console.error('Error initializing database', err);
  } finally {
    await client.end();
  }
}

initDb();
