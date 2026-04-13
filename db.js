const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'serval.db'));

// Enable WAL mode for better concurrent reads
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS companies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    github_org TEXT NOT NULL,
    github_token TEXT NOT NULL,
    manager_password TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS repos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id TEXT NOT NULL,
    key TEXT NOT NULL,
    github_name TEXT NOT NULL,
    description TEXT DEFAULT '',
    departments TEXT DEFAULT '[]',
    requires_approval INTEGER DEFAULT 0,
    approver TEXT DEFAULT '',
    FOREIGN KEY (company_id) REFERENCES companies(id)
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id TEXT NOT NULL,
    name TEXT NOT NULL,
    email TEXT DEFAULT '',
    division TEXT NOT NULL,
    github TEXT NOT NULL,
    role TEXT DEFAULT 'employee',
    session_id TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (company_id) REFERENCES companies(id)
  );

  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id TEXT NOT NULL,
    company_id TEXT NOT NULL,
    type TEXT NOT NULL,
    description TEXT DEFAULT '',
    status TEXT DEFAULT 'Open',
    requester TEXT DEFAULT '',
    assignee TEXT DEFAULT 'AI Agent',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    resolved_at TEXT
  );

  CREATE TABLE IF NOT EXISTS access_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id TEXT NOT NULL,
    user_name TEXT NOT NULL,
    github TEXT NOT NULL,
    division TEXT DEFAULT '',
    repo_key TEXT NOT NULL,
    repo_name TEXT NOT NULL,
    action TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS pending_approvals (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    user_name TEXT NOT NULL,
    github TEXT NOT NULL,
    division TEXT DEFAULT '',
    repo_key TEXT NOT NULL,
    repo_name TEXT NOT NULL,
    ticket_id TEXT,
    session_id TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id TEXT NOT NULL,
    target TEXT NOT NULL,
    github TEXT DEFAULT '',
    session_id TEXT DEFAULT '',
    message TEXT NOT NULL,
    is_read INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
`);

module.exports = db;
