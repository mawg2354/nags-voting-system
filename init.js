const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./database.sqlite');

db.serialize(() => {
  db.run('PRAGMA foreign_keys = ON');

  db.run(`CREATE TABLE IF NOT EXISTS elections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Draft',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Added abstain_votes column
  db.run(`CREATE TABLE IF NOT EXISTS portfolios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    election_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    abstain_votes INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(election_id) REFERENCES elections(id) ON DELETE CASCADE
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    portfolio_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    bio TEXT,
    photo_url TEXT,
    votes INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(portfolio_id) REFERENCES portfolios(id) ON DELETE CASCADE
  )`);

  // Added sent_to column to optionally track emails
  db.run(`CREATE TABLE IF NOT EXISTS tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    election_id INTEGER NOT NULL,
    token TEXT UNIQUE NOT NULL,
    sent_to TEXT,
    has_voted BOOLEAN NOT NULL DEFAULT 0,
    FOREIGN KEY(election_id) REFERENCES elections(id) ON DELETE CASCADE
  )`);

  console.log('Database initialized successfully with Abstain and Email tracking schema.');
});

db.close();
