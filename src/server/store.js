// JSON file store — no native deps, easy to swap for a DB later
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let storeDir = null;
let charFile = null;
let userFile = null;

function init(dataDir) {
  storeDir = path.join(dataDir, 'marketplace');
  charFile = path.join(storeDir, 'characters.json');
  userFile = path.join(storeDir, 'users.json');
  if (!fs.existsSync(storeDir)) fs.mkdirSync(storeDir, { recursive: true });
  if (!fs.existsSync(charFile)) fs.writeFileSync(charFile, JSON.stringify({ characters: [], nextId: 1 }));
  if (!fs.existsSync(userFile)) fs.writeFileSync(userFile, JSON.stringify({ users: [], sessions: {}, resets: {}, nextId: 1 }));
}

function read() {
  try { return JSON.parse(fs.readFileSync(charFile, 'utf8')); }
  catch { return { characters: [], nextId: 1 }; }
}

function write(data) { fs.writeFileSync(charFile, JSON.stringify(data, null, 2)); }

const store = {
  list(filters = {}) {
    let { characters } = read();
    if (filters.type) characters = characters.filter(c => (c.type || 'character') === filters.type);
    if (filters.q) {
      const q = filters.q.toLowerCase();
      characters = characters.filter(c => c.name.toLowerCase().includes(q) || (c.tags || []).some(t => t.includes(q)));
    }
    if (filters.tag)            characters = characters.filter(c => (c.tags || []).includes(filters.tag));
    if (filters.price === 'free') characters = characters.filter(c => c.price === 0);
    if (filters.price === 'paid') characters = characters.filter(c => c.price > 0);
    if (filters.sort === 'newest') characters.sort((a, b) => b.createdAt - a.createdAt);
    else if (filters.sort === 'price') characters.sort((a, b) => a.price - b.price);
    else characters.sort((a, b) => b.downloads - a.downloads);
    return characters;
  },

  get(id) {
    return read().characters.find(c => c.id === Number(id)) || null;
  },

  add(char) {
    const data = read();
    const entry = { ...char, id: data.nextId++, downloads: 0, likes: 0, createdAt: Date.now() };
    data.characters.push(entry);
    write(data);
    return entry;
  },

  incrementDownloads(id) {
    const data = read();
    const c = data.characters.find(c => c.id === Number(id));
    if (c) { c.downloads++; write(data); }
  },

  incrementLikes(id) {
    const data = read();
    const c = data.characters.find(c => c.id === Number(id));
    if (c) { c.likes++; write(data); }
  },

  uploadsDir() { return path.join(storeDir, 'uploads'); },
};

// ── Accounts ──────────────────────────────────────────────────────────────────
// Local accounts on this machine's server. Passwords are scrypt-hashed (no plain
// text, no extra deps). Sessions are random bearer tokens. Swap for OAuth/DB later.
function readUsers() { try { return JSON.parse(fs.readFileSync(userFile, 'utf8')); } catch { return { users: [], sessions: {}, resets: {}, nextId: 1 }; } }
function writeUsers(d) { fs.writeFileSync(userFile, JSON.stringify(d, null, 2)); }
function publicUser(u) { return { id: u.id, username: u.username, email: u.email || '', owned: u.owned || [] }; }

// Salt + scrypt-hash any secret (password OR recovery code). Constant-time compare on verify.
function hashSecret(secret) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(String(secret || ''), salt, 64).toString('hex') };
}
function verifySecret(secret, salt, hash) {
  if (!salt || !hash) return false;
  try {
    const h = crypto.scryptSync(String(secret || ''), salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hash, 'hex'));
  } catch { return false; }
}
// Human-friendly one-time recovery code: 4 groups of 4 from an unambiguous alphabet
// (no 0/O/1/I/L). e.g. "K7QF-3M9P-RJX2-VH4T".
function genRecoveryCode() {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const g = () => Array.from({ length: 4 }, () => A[crypto.randomInt(A.length)]).join('');
  return `${g()}-${g()}-${g()}-${g()}`;
}
const isEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e || ''));

const users = {
  // Returns { user, recoveryCode } — the recoveryCode is plaintext and shown to the user
  // ONCE (we only store its hash). Email is optional but enables the email reset path.
  create(username, password, email) {
    username = String(username || '').trim();
    email = String(email || '').trim().toLowerCase();
    if (username.length < 2) return { error: 'Username too short' };
    if (String(password || '').length < 4) return { error: 'Password too short (min 4)' };
    if (email && !isEmail(email)) return { error: 'That email doesn\'t look right' };
    const d = readUsers();
    if (d.users.find(u => u.username.toLowerCase() === username.toLowerCase())) return { error: 'Username already taken' };
    if (email && d.users.find(u => (u.email || '').toLowerCase() === email)) return { error: 'Email already registered' };
    const pw = hashSecret(password);
    const recoveryCode = genRecoveryCode();
    const rc = hashSecret(recoveryCode);
    const user = { id: d.nextId++, username, email, salt: pw.salt, hash: pw.hash,
      rcSalt: rc.salt, rcHash: rc.hash, owned: [], createdAt: Date.now() };
    d.users.push(user); writeUsers(d);
    return { user, recoveryCode };
  },
  verify(username, password) {
    const d = readUsers();
    const user = d.users.find(u => u.username.toLowerCase() === String(username || '').toLowerCase());
    if (!user) return null;
    return verifySecret(password, user.salt, user.hash) ? user : null;
  },
  // ── Password recovery ─────────────────────────────────────────────────────────
  // Create a time-limited reset token for the account with this email (or null if no
  // such email — the server still responds 200 so it can't be used to probe accounts).
  createResetToken(email) {
    const d = readUsers();
    email = String(email || '').trim().toLowerCase();
    const user = email && d.users.find(u => (u.email || '').toLowerCase() === email);
    if (!user) return null;
    const token = crypto.randomBytes(24).toString('hex');
    d.resets = d.resets || {};
    d.resets[token] = { userId: user.id, expires: Date.now() + 30 * 60 * 1000 };   // 30 minutes
    writeUsers(d);
    return { token, user };
  },
  // Consume a reset token (single-use) → the user, or null if missing/expired.
  consumeResetToken(token) {
    const d = readUsers(); d.resets = d.resets || {};
    const r = d.resets[token];
    if (!r) return null;
    delete d.resets[token]; writeUsers(d);
    if (r.expires < Date.now()) return null;
    return d.users.find(u => u.id === r.userId) || null;
  },
  // Verify username + recovery code (the offline path). Returns the user or null.
  verifyRecoveryCode(username, code) {
    const d = readUsers();
    const user = d.users.find(u => u.username.toLowerCase() === String(username || '').toLowerCase());
    if (!user) return null;
    return verifySecret(String(code || '').trim().toUpperCase(), user.rcSalt, user.rcHash) ? user : null;
  },
  // Issue a fresh recovery code (recovery codes are single-use). Returns the plaintext.
  regenerateRecoveryCode(userId) {
    const d = readUsers();
    const u = d.users.find(u => u.id === userId); if (!u) return null;
    const code = genRecoveryCode(); const rc = hashSecret(code);
    u.rcSalt = rc.salt; u.rcHash = rc.hash; writeUsers(d);
    return code;
  },
  setPassword(userId, newPassword) {
    if (String(newPassword || '').length < 4) return { error: 'Password too short (min 4)' };
    const d = readUsers();
    const u = d.users.find(u => u.id === userId); if (!u) return { error: 'No such account' };
    const pw = hashSecret(newPassword); u.salt = pw.salt; u.hash = pw.hash;
    // Sign out everywhere on a password change, for safety.
    for (const t of Object.keys(d.sessions || {})) if (d.sessions[t].userId === userId) delete d.sessions[t];
    writeUsers(d);
    return { ok: true };
  },
  createSession(userId) {
    const d = readUsers();
    const token = crypto.randomBytes(24).toString('hex');
    d.sessions[token] = { userId, createdAt: Date.now() };
    writeUsers(d);
    return token;
  },
  byToken(token) {
    if (!token) return null;
    const d = readUsers();
    const s = d.sessions[token];
    return s ? (d.users.find(u => u.id === s.userId) || null) : null;
  },
  logout(token) { const d = readUsers(); if (d.sessions[token]) { delete d.sessions[token]; writeUsers(d); } },
  addOwned(userId, item) {
    const d = readUsers();
    const u = d.users.find(u => u.id === userId); if (!u) return;
    u.owned = u.owned || [];
    if (!u.owned.find(o => o.type === item.type && o.id === item.id)) { u.owned.push({ ...item, at: Date.now() }); writeUsers(d); }
  },
  publicUser,
};

module.exports = { init, store, users, publicUser };
