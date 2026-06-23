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
  if (!fs.existsSync(userFile)) fs.writeFileSync(userFile, JSON.stringify({ users: [], sessions: {}, nextId: 1 }));
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
function readUsers() { try { return JSON.parse(fs.readFileSync(userFile, 'utf8')); } catch { return { users: [], sessions: {}, nextId: 1 }; } }
function writeUsers(d) { fs.writeFileSync(userFile, JSON.stringify(d, null, 2)); }
function publicUser(u) { return { id: u.id, username: u.username, owned: u.owned || [] }; }

const users = {
  create(username, password) {
    username = String(username || '').trim();
    if (username.length < 2) return { error: 'Username too short' };
    if (String(password || '').length < 4) return { error: 'Password too short (min 4)' };
    const d = readUsers();
    if (d.users.find(u => u.username.toLowerCase() === username.toLowerCase())) return { error: 'Username already taken' };
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    const user = { id: d.nextId++, username, salt, hash, owned: [], createdAt: Date.now() };
    d.users.push(user); writeUsers(d);
    return { user };
  },
  verify(username, password) {
    const d = readUsers();
    const user = d.users.find(u => u.username.toLowerCase() === String(username || '').toLowerCase());
    if (!user) return null;
    const hash = crypto.scryptSync(String(password || ''), user.salt, 64).toString('hex');
    try { if (crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'))) return user; } catch {}
    return null;
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
