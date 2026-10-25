// Once, for a database made before the account rework (October 2026): the users table to invites, passkeys and
// monthly budgets. Stop the server and worker first, back the database up, then (see docs/hosting.md):
//   node deploy/upgrade-accounts.cjs <path to gd.sqlite>
// Old users keep their user name and password and become active with a $10 monthly budget. An account that still
// had a one-time password (must_change_password) becomes invited instead: the script prints its new invite code
// (link: <site>/#/invite/<code>), and its user name stays. Running it twice does nothing.
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2], { timeout: 10000 });
const cols = db.prepare("SELECT name FROM pragma_table_info('users')").all().map((c) => c.name);
if (cols.includes('status')) {
  console.log('already migrated');
  process.exit(0);
}
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const code = () => {
  const c = Array.from({ length: 12 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`;
};
db.exec('BEGIN IMMEDIATE');
const old = db.prepare('SELECT * FROM users').all();
db.exec('DROP TABLE users');
db.exec(`CREATE TABLE users (
    id TEXT PRIMARY KEY, username TEXT UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL, password_hash TEXT, salt TEXT,
    created_at INTEGER NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, invite_code TEXT UNIQUE, invite_expires INTEGER,
    monthly_budget_usd REAL NOT NULL
  )`);
db.exec(`CREATE TABLE IF NOT EXISTS passkeys (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, public_key BLOB NOT NULL, counter INTEGER NOT NULL,
    transports TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER
  )`);
db.exec('CREATE INDEX IF NOT EXISTS passkeys_user ON passkeys (user_id)');
const insert = db.prepare(`INSERT INTO users (id, username, display_name, password_hash, salt, created_at, is_admin, status, invite_code,
  invite_expires, monthly_budget_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 10)`);
for (const u of old) {
  const invite = u.must_change_password ? code() : null;
  insert.run(u.id, u.username, u.username, invite ? null : u.password_hash, invite ? null : u.salt, u.created_at, invite ? 0 : u.is_admin,
    invite ? 'invited' : 'active', invite, invite ? Date.now() + 5 * 86400_000 : null);
  if (invite) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  console.log(`${u.username}: ${invite ? `invited again, code ${invite}` : 'active'}`);
}
db.exec('COMMIT');
