const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const { init, store, users, publicUser } = require('./store');

const PORT = 4242;
let serverInstance = null;

function startServer(dataDir) {
  if (serverInstance) return Promise.resolve(PORT);

  init(dataDir);

  const uploadsDir = store.uploadsDir();
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

  // Seed free animation packs if none exist
  seedFreeAnimations(dataDir);

  const app = express();
  app.use(cors({ origin: '*' }));
  app.use(express.json());

  const storage = multer.diskStorage({
    destination: uploadsDir,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`),
  });
  const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

  // ── Auth ─────────────────────────────────────────────────────────────────────
  // Reads `Authorization: Bearer <token>` → req.user. `requireAuth` 401s without it.
  const auth = (req, _res, next) => {
    const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    req.user = users.byToken(t);
    req.token = t;
    next();
  };
  const requireAuth = (req, res, next) => req.user ? next() : res.status(401).json({ error: 'Sign in required' });
  app.use(auth);

  app.post('/api/auth/signup', (req, res) => {
    const { username, password } = req.body || {};
    const r = users.create(username, password);
    if (r.error) return res.status(400).json({ error: r.error });
    const token = users.createSession(r.user.id);
    res.status(201).json({ token, user: publicUser(r.user) });
  });
  app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body || {};
    const u = users.verify(username, password);
    if (!u) return res.status(401).json({ error: 'Wrong username or password' });
    res.json({ token: users.createSession(u.id), user: publicUser(u) });
  });
  app.post('/api/auth/logout', (req, res) => { users.logout(req.token); res.json({ ok: true }); });
  app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));
  app.get('/api/me/library', requireAuth, (req, res) => res.json(req.user.owned || []));

  // ── Characters ─────────────────────────────────────────────────────────────
  app.get('/api/characters', (req, res) => {
    res.json(store.list({ ...req.query, type: 'character' }));
  });

  app.get('/api/characters/:id', (req, res) => {
    const c = store.get(req.params.id);
    if (!c || c.type !== 'character') return res.status(404).json({ error: 'Not found' });
    res.json(c);
  });

  app.post('/api/characters', requireAuth, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'File required' });
    const { name, description, price } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    let tags = [];
    try { tags = JSON.parse(req.body.tags || '[]'); } catch { tags = String(req.body.tags || '').split(',').map(t => t.trim()).filter(Boolean); }
    const entry = store.add({ type: 'character', name, author: req.user.username, ownerId: req.user.id, description: description || '', tags, price: parseFloat(price) || 0, filename: req.file.filename, size: req.file.size });
    users.addOwned(req.user.id, { type: 'character', id: entry.id, name: entry.name });   // you own what you publish
    res.status(201).json({ id: entry.id, name: entry.name });
  });

  app.get('/api/characters/:id/download', requireAuth, (req, res) => {
    const c = store.get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    const fp = path.join(uploadsDir, c.filename);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'File missing' });
    store.incrementDownloads(c.id);
    users.addOwned(req.user.id, { type: 'character', id: c.id, name: c.name });
    res.download(fp, `${c.name}.charpack`);
  });

  app.post('/api/characters/:id/like', (req, res) => { store.incrementLikes(req.params.id); res.json({ ok: true }); });

  // ── Animations ─────────────────────────────────────────────────────────────
  app.get('/api/animations', (req, res) => {
    res.json(store.list({ ...req.query, type: 'animation' }));
  });

  app.get('/api/animations/:id', (req, res) => {
    const a = store.get(req.params.id);
    if (!a || a.type !== 'animation') return res.status(404).json({ error: 'Not found' });
    res.json(a);
  });

  app.post('/api/animations', requireAuth, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'File required' });
    const { name, description, price, clipCount } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    let tags = [];
    try { tags = JSON.parse(req.body.tags || '[]'); } catch { tags = String(req.body.tags || '').split(',').map(t => t.trim()).filter(Boolean); }
    const entry = store.add({ type: 'animation', name, author: req.user.username, ownerId: req.user.id, description: description || '', tags, price: parseFloat(price) || 0, clipCount: parseInt(clipCount) || 0, filename: req.file.filename, size: req.file.size });
    users.addOwned(req.user.id, { type: 'animation', id: entry.id, name: entry.name });
    res.status(201).json({ id: entry.id, name: entry.name });
  });

  // Download animation pack — returns the JSON pack data
  app.get('/api/animations/:id/download', requireAuth, (req, res) => {
    const a = store.get(req.params.id);
    if (!a || a.type !== 'animation') return res.status(404).json({ error: 'Not found' });
    users.addOwned(req.user.id, { type: 'animation', id: a.id, name: a.name });

    // If it's a seeded pack (no file, has inlineData), return inline JSON
    if (a.inlineData) {
      store.incrementDownloads(a.id);
      return res.json(a.inlineData);
    }

    const fp = path.join(uploadsDir, a.filename);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'File missing' });
    store.incrementDownloads(a.id);

    // Return as JSON (animpack files are JSON)
    try {
      const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
      res.json(data);
    } catch {
      res.download(fp, `${a.name}.animpack`);
    }
  });

  app.post('/api/animations/:id/like', (req, res) => { store.incrementLikes(req.params.id); res.json({ ok: true }); });

  // ── Combined search ─────────────────────────────────────────────────────────
  app.get('/api/search', (req, res) => {
    const chars = store.list({ ...req.query, type: 'character' });
    const anims = store.list({ ...req.query, type: 'animation' });
    res.json({ characters: chars, animations: anims });
  });

  app.use('/uploads', express.static(uploadsDir));

  return new Promise((resolve, reject) => {
    serverInstance = app.listen(PORT, '127.0.0.1', () => {
      console.log(`[DeskBuddy] Server: http://localhost:${PORT}`);
      resolve(PORT);
    });
    serverInstance.on('error', reject);
  });
}

// ── Seed free animation packs ─────────────────────────────────────────────────
function seedFreeAnimations(dataDir) {
  const db = require('./store').store;
  const existing = db.list({ type: 'animation' });
  if (existing.length > 0) return; // already seeded

  const freePacks = [
    {
      name: 'Idle Collection',
      author: 'DeskBuddy',
      description: 'Breathing, sway, float, and tap-foot idle loops for Mixamo rigs.',
      tags: ['idle', 'loop', 'mixamo'],
      price: 0,
      clipCount: 4,
      inlineData: {
        name: 'Idle Collection',
        version: '1.0.0',
        author: 'DeskBuddy',
        description: 'Idle animations for Mixamo-rigged characters',
        animations: makeIdleAnimData(),
      },
    },
    {
      name: 'Reactions Pack',
      author: 'DeskBuddy',
      description: 'Wave, nod, shrug, excited jump, and shake head reactions.',
      tags: ['reaction', 'one-shot', 'mixamo'],
      price: 0,
      clipCount: 5,
      inlineData: {
        name: 'Reactions Pack',
        version: '1.0.0',
        author: 'DeskBuddy',
        description: 'Reaction animations for Mixamo-rigged characters',
        animations: makeReactionAnimData(),
      },
    },
    {
      name: 'Sleep & Dance Pack',
      author: 'DeskBuddy',
      description: 'Sleep drooping loop and a groove dance for any occasion.',
      tags: ['sleep', 'dance', 'loop', 'mixamo'],
      price: 0,
      clipCount: 2,
      inlineData: {
        name: 'Sleep & Dance Pack',
        version: '1.0.0',
        author: 'DeskBuddy',
        description: 'Sleep and dance animations for Mixamo-rigged characters',
        animations: makeSleepDanceAnimData(),
      },
    },
  ];

  freePacks.forEach(p => {
    store.add({ type: 'animation', filename: '', size: 0, downloads: 0, likes: 0, ...p });
  });

  console.log('[DeskBuddy] Seeded 3 free animation packs');
}

// Inline animation data (keyframe arrays for Mixamo rig)
function makeIdleAnimData() {
  return [
    {
      name: 'Idle - Breathe', duration: 4.0,
      tracks: [
        qt('mixamorigSpine.quaternion',  [0,2,4], [4,0,0], [7,0,0], [4,0,0]),
        qt('mixamorigSpine1.quaternion', [0,2,4], [2,0,0], [4,0,0], [2,0,0]),
        qt('mixamorigNeck.quaternion',   [0,2,4], [-1,0,0],[-2,0,0],[-1,0,0]),
      ],
    },
    {
      name: 'Idle - Sway', duration: 6.0,
      tracks: [
        qt('mixamorigHips.quaternion',  [0,1.5,3,4.5,6], [0,0,-2],[0,0,0],[0,0,2],[0,0,0],[0,0,-2]),
        qt('mixamorigSpine.quaternion', [0,1.5,3,4.5,6], [4,0,1], [4,0,0],[4,0,-1],[4,0,0],[4,0,1]),
        qt('mixamorigHead.quaternion',  [0,1.5,3,4.5,6], [0,3,0], [0,0,0],[0,-3,0],[0,0,0],[0,3,0]),
      ],
    },
    {
      name: 'Idle - Float', duration: 5.0,
      tracks: [
        qt('mixamorigSpine.quaternion',       [0,2.5,5], [4,0,0],[6,0,0],[4,0,0]),
        qt('mixamorigLeftArm.quaternion',     [0,2.5,5], [0,0,-20],[0,0,-15],[0,0,-20]),
        qt('mixamorigRightArm.quaternion',    [0,2.5,5], [0,0,20], [0,0,15], [0,0,20]),
      ],
    },
    {
      name: 'Idle - Tap Foot', duration: 2.0,
      tracks: [
        qt('mixamorigRightUpLeg.quaternion', [0,0.25,0.5,0.75,1,1.25,1.5,1.75,2],
           [-5,0,0],[5,0,0],[-5,0,0],[5,0,0],[-5,0,0],[5,0,0],[-5,0,0],[5,0,0],[-5,0,0]),
      ],
    },
  ];
}

function makeReactionAnimData() {
  return [
    {
      name: 'Wave Hello', duration: 2.5,
      tracks: [
        qt('mixamorigRightArm.quaternion',    [0,0.4,2.5], [0,0,30],[-60,0,80],[0,0,30]),
        qt('mixamorigRightForeArm.quaternion',[0,0.4,0.9,1.4,1.9,2.5], [0,0,0],[0,0,50],[0,0,20],[0,0,50],[0,0,20],[0,0,0]),
      ],
    },
    {
      name: 'Nod Yes', duration: 1.5,
      tracks: [
        qt('mixamorigHead.quaternion', [0,0.4,0.75,1.1,1.5], [0,0,0],[20,0,0],[0,0,0],[20,0,0],[0,0,0]),
        qt('mixamorigNeck.quaternion', [0,0.4,0.75,1.1,1.5], [-1,0,0],[5,0,0],[-1,0,0],[5,0,0],[-1,0,0]),
      ],
    },
    {
      name: 'Shake Head', duration: 1.5,
      tracks: [
        qt('mixamorigHead.quaternion', [0,0.25,0.75,1.25,1.5], [0,0,0],[0,-25,0],[0,25,0],[0,-25,0],[0,0,0]),
      ],
    },
    {
      name: 'Excited Jump', duration: 1.2,
      tracks: [
        qt('mixamorigSpine.quaternion',    [0,0.3,0.6,0.9,1.2], [5,0,0],[10,0,0],[4,0,0],[8,0,0],[5,0,0]),
        qt('mixamorigLeftArm.quaternion',  [0,0.3,0.6,0.9,1.2], [0,0,-20],[-40,0,-40],[-20,0,-10],[-40,0,-40],[0,0,-20]),
        qt('mixamorigRightArm.quaternion', [0,0.3,0.6,0.9,1.2], [0,0,20],[-40,0,40],[-20,0,10],[-40,0,40],[0,0,20]),
      ],
    },
    {
      name: 'Shrug', duration: 1.8,
      tracks: [
        qt('mixamorigLeftShoulder.quaternion',  [0,0.6,1.2,1.8], [0,0,0],[-30,0,0],[-30,0,0],[0,0,0]),
        qt('mixamorigRightShoulder.quaternion', [0,0.6,1.2,1.8], [0,0,0],[-30,0,0],[-30,0,0],[0,0,0]),
        qt('mixamorigHead.quaternion',          [0,0.6,1.2,1.8], [0,0,0],[5,0,3],[5,0,3],[0,0,0]),
      ],
    },
  ];
}

function makeSleepDanceAnimData() {
  return [
    {
      name: 'Sleep - Drooping', duration: 8.0,
      tracks: [
        qt('mixamorigHead.quaternion',   [0,3,6,8], [0,0,0],[30,0,0],[28,0,0],[30,0,0]),
        qt('mixamorigNeck.quaternion',   [0,3,6,8], [-1,0,0],[12,0,0],[10,0,0],[12,0,0]),
        qt('mixamorigSpine.quaternion',  [0,3,6,8], [5,0,0],[10,0,0],[9,0,0],[10,0,0]),
        qt('mixamorigSpine1.quaternion', [0,3,6,8], [3,0,0],[7,0,0],[6,0,0],[7,0,0]),
      ],
    },
    {
      name: 'Dance - Groove', duration: 4.0,
      tracks: [
        qt('mixamorigHips.quaternion',        [0,0.5,1,1.5,2,2.5,3,3.5,4],
           [0,0,-5],[0,5,-3],[0,0,5],[0,-5,-3],[0,0,-5],[0,5,-3],[0,0,5],[0,-5,-3],[0,0,-5]),
        qt('mixamorigSpine.quaternion',       [0,1,2,3,4], [5,0,2],[5,0,-2],[5,0,2],[5,0,-2],[5,0,2]),
        qt('mixamorigLeftArm.quaternion',     [0,1,2,3,4], [0,0,-20],[-30,0,-40],[0,0,-20],[-30,0,-40],[0,0,-20]),
        qt('mixamorigRightArm.quaternion',    [0,1,2,3,4], [0,0,20],[-30,0,40],[0,0,20],[-30,0,40],[0,0,20]),
      ],
    },
  ];
}

// Helper: convert Euler angles (degrees) to quaternion track data
const R = Math.PI / 180;
function eulerToQ(xd, yd, zd) {
  const sin = Math.sin, cos = Math.cos;
  const x = xd*R/2, y = yd*R/2, z = zd*R/2;
  return [
    sin(x)*cos(y)*cos(z) - cos(x)*sin(y)*sin(z),
    cos(x)*sin(y)*cos(z) + sin(x)*cos(y)*sin(z),
    cos(x)*cos(y)*sin(z) - sin(x)*sin(y)*cos(z),
    cos(x)*cos(y)*cos(z) + sin(x)*sin(y)*sin(z),
  ];
}

function qt(name, times, ...eulers) {
  const values = eulers.flatMap(e => eulerToQ(e[0], e[1], e[2]));
  return { type: 'quaternion', name, times, values };
}

function stopServer() {
  if (serverInstance) { serverInstance.close(); serverInstance = null; }
}

module.exports = { startServer, stopServer, PORT };
