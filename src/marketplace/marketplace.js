// DeskBuddy Marketplace — characters + animation packs
let API = 'https://api.yuvexel.com/api';   // production default; overridden by the app's shared SERVER_BASE at init
let SERVER = API.replace(/\/api$/, '');   // for /uploads (thumbnails)
const thumbUrl = (f) => (f ? `${SERVER}/uploads/${f}` : '');

// State
let contentType = 'characters'; // 'characters' | 'animations'
let activeFilter = 'all', activePrice = 'all', activeSort = 'popular';
let activeTab = 'browse', searchQuery = '';
let allItems = [];

// Publish: the user's studio library + current selection (path → item)
let library = [];
let librarySelection = new Map();

// ── Accounts ──────────────────────────────────────────────────────────────────
let token = localStorage.getItem('db_token') || null;
let currentUser = null;
let authMode = 'login';   // 'login' | 'signup'

function $(id) { return document.getElementById(id); }
function authHeaders(extra = {}) { return token ? { Authorization: 'Bearer ' + token, ...extra } : extra; }

async function checkAuth() {
  if (token) {
    try {
      const r = await fetch(`${API}/auth/me`, { headers: authHeaders() });
      if (r.ok) { currentUser = (await r.json()).user; return enterMarketplace(); }
    } catch {}
    token = null; localStorage.removeItem('db_token');
  }
  showGate();
}
function showGate() { $('auth-gate').style.display = 'flex'; $('acct-chip').style.display = 'none'; }
function enterMarketplace() {
  $('auth-gate').style.display = 'none';
  $('acct-chip').style.display = '';
  $('acct-name').textContent = currentUser?.username || '';
  fetchItems();
}
window.authToggle = () => {
  authMode = authMode === 'login' ? 'signup' : 'login';
  $('auth-title').textContent = authMode === 'login' ? 'Sign in' : 'Create account';
  $('auth-btn').textContent = authMode === 'login' ? 'Sign in' : 'Create account';
  $('auth-switch-txt').textContent = authMode === 'login' ? 'No account?' : 'Already have one?';
  $('auth-switch-lbl').textContent = authMode === 'login' ? 'Create one' : 'Sign in';
  $('auth-err').textContent = '';
};
window.authSubmit = async () => {
  const username = $('auth-user').value.trim(), password = $('auth-pass').value;
  if (!username || !password) { $('auth-err').textContent = 'Enter a username and password'; return; }
  try {
    const r = await fetch(`${API}/auth/${authMode === 'login' ? 'login' : 'signup'}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await r.json();
    if (!r.ok) { $('auth-err').textContent = data.error || 'Failed'; return; }
    token = data.token; currentUser = data.user; localStorage.setItem('db_token', token);
    $('auth-pass').value = '';
    enterMarketplace();
  } catch { $('auth-err').textContent = 'Cannot reach the server'; }
};
window.logout = async () => {
  try { await fetch(`${API}/auth/logout`, { method: 'POST', headers: authHeaders() }); } catch {}
  token = null; currentUser = null; localStorage.removeItem('db_token');
  showGate();
};

// ── Fetch ────────────────────────────────────────────────────────────────────
async function fetchItems() {
  if (activeTab === 'my-chars') return renderMyLibrary();
  const params = new URLSearchParams({ sort: activeSort });
  if (searchQuery)            params.set('q',     searchQuery);
  if (activeFilter !== 'all') params.set('tag',   activeFilter);
  if (activePrice  !== 'all') params.set('price', activePrice);

  const endpoint = contentType === 'animations' ? 'animations' : 'characters';
  try {
    const res = await fetch(`${API}/${endpoint}?${params}`, { headers: authHeaders() });
    allItems = await res.json();
    if (activeTab === 'published') allItems = allItems.filter(it => it.ownerId === currentUser?.id);
  } catch {
    allItems = [];
    $('card-grid').innerHTML = '<div class="no-items">Cannot connect to marketplace server. Make sure the app is running.</div>';
    return;
  }
  renderCards();
}

// ── Render ───────────────────────────────────────────────────────────────────
const CHAR_EMOJIS = ['🦊','🤖','🧝','🐉','🐱','👻','⚔️','🐺','👾','🧸'];
const ANIM_EMOJIS = ['💃','🕺','🌊','⚡','🎭','🎪','🌙','✨','🏃','🤸'];

function renderCards() {
  const grid = $('card-grid');
  grid.innerHTML = '';

  if (!allItems.length) {
    grid.innerHTML = `<div class="no-items">${activeTab === 'published' ? "You haven't published anything yet." : `No ${contentType === 'animations' ? 'animation packs' : 'characters'} found. Be the first to publish one!`}</div>`;
    return;
  }

  const emojis = contentType === 'animations' ? ANIM_EMOJIS : CHAR_EMOJIS;

  allItems.forEach((item, i) => {
    const isFree = item.price === 0;
    const priceLabel = isFree ? 'Free' : `$${item.price.toFixed(2)}`;
    const emoji = emojis[i % emojis.length];
    const tags = Array.isArray(item.tags) ? item.tags : (item.tags ? String(item.tags).split(',') : []);
    const isNew = (Date.now() - item.createdAt) < 7 * 24 * 60 * 60 * 1000;
    const isAnim = contentType === 'animations';

    // Thumb: characters show their rendered model image (fallback emoji); animation packs
    // show an emoji at rest and play a little skeleton preview on hover.
    let thumbInner;
    if (isAnim) {
      thumbInner = `<canvas class="anim-canvas" width="220" height="160"></canvas><span class="card-emoji anim-emoji">${emoji}</span>`;
    } else if (item.thumbnail) {
      thumbInner = `<img class="card-img" src="${thumbUrl(item.thumbnail)}" alt="" loading="lazy"
        onerror="this.remove()"><span class="card-emoji" style="position:absolute;z-index:-1">${emoji}</span>`;
    } else {
      thumbInner = `<span class="card-emoji">${emoji}</span>`;
    }

    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="card-thumb">
        ${thumbInner}
        ${isNew ? '<span class="badge badge-new">NEW</span>' : ''}
        <span class="badge ${isFree ? 'badge-free' : 'badge-paid'}" style="top:${isNew ? 30 : 8}px">${priceLabel}</span>
        ${isAnim ? '<span class="badge" style="bottom:8px;top:auto;background:rgba(139,92,246,.3);color:#c4b5fd;border:1px solid rgba(139,92,246,.4)">' + (item.clipCount || '?') + ' clips · hover to preview</span>' : ''}
      </div>
      <div class="card-body">
        <div class="card-name">${item.name}</div>
        <div class="card-meta">
          <span>by ${item.author || 'Anonymous'}</span>
          <span style="margin-left:auto;font-size:11px;color:var(--muted)">${item.downloads || 0} ↓  ${item.likes || 0} ♥</span>
        </div>
        <div class="card-meta" style="margin-top:4px;flex-wrap:wrap;gap:3px">
          ${tags.filter(Boolean).slice(0,3).map(t => `<span style="background:rgba(99,102,241,.1);color:#a5b4fc;padding:1px 6px;border-radius:8px;font-size:10px">${t}</span>`).join('')}
        </div>
      </div>
      <div class="card-actions">
        <button class="btn btn-sm-sec" onclick="previewItem(${item.id})">Info</button>
        <button class="btn btn-primary" onclick="downloadItem(${item.id},'${encodeURIComponent(item.name)}')">${isFree ? (isAnim ? 'Get Pack' : 'Get') : 'Buy · ' + priceLabel}</button>
      </div>`;
    grid.appendChild(card);

    if (isAnim) attachAnimPreview(card, item.id);
  });
}

// ── Animation hover preview ───────────────────────────────────────────────────
// Plays a pack's first clip on a tiny 2D canvas so people see the motion before they
// get it. Builds an approximate Mixamo-named humanoid and applies the clip's quaternion
// tracks via forward kinematics — no Three.js, no rigged model needed. The seeded packs
// author tracks as small local rotations from an upright rest pose, which is exactly what
// this expects, so nods/waves/sways/dances read correctly.
const SKELETON = [
  // [bone, parent, restOffset(x,y,z)] — ordered parents-before-children
  ['mixamorigHips', null, [0, 0, 0]],
  ['mixamorigSpine', 'mixamorigHips', [0, 0.11, 0]],
  ['mixamorigSpine1', 'mixamorigSpine', [0, 0.11, 0]],
  ['mixamorigNeck', 'mixamorigSpine1', [0, 0.09, 0]],
  ['mixamorigHead', 'mixamorigNeck', [0, 0.10, 0]],
  ['mixamorigLeftShoulder', 'mixamorigSpine1', [0.045, 0.07, 0]],
  ['mixamorigLeftArm', 'mixamorigLeftShoulder', [0.10, 0, 0]],
  ['mixamorigLeftForeArm', 'mixamorigLeftArm', [0.15, 0, 0]],
  ['mixamorigLeftHand', 'mixamorigLeftForeArm', [0.13, 0, 0]],
  ['mixamorigRightShoulder', 'mixamorigSpine1', [-0.045, 0.07, 0]],
  ['mixamorigRightArm', 'mixamorigRightShoulder', [-0.10, 0, 0]],
  ['mixamorigRightForeArm', 'mixamorigRightArm', [-0.15, 0, 0]],
  ['mixamorigRightHand', 'mixamorigRightForeArm', [-0.13, 0, 0]],
  ['mixamorigLeftUpLeg', 'mixamorigHips', [0.06, -0.03, 0]],
  ['mixamorigLeftLeg', 'mixamorigLeftUpLeg', [0, -0.20, 0]],
  ['mixamorigLeftFoot', 'mixamorigLeftLeg', [0, -0.19, 0]],
  ['mixamorigRightUpLeg', 'mixamorigHips', [-0.06, -0.03, 0]],
  ['mixamorigRightLeg', 'mixamorigRightUpLeg', [0, -0.20, 0]],
  ['mixamorigRightFoot', 'mixamorigRightLeg', [0, -0.19, 0]],
];

function qMul(a, b) {   // Hamilton product (x,y,z,w)
  return [
    a[3]*b[0] + a[0]*b[3] + a[1]*b[2] - a[2]*b[1],
    a[3]*b[1] - a[0]*b[2] + a[1]*b[3] + a[2]*b[0],
    a[3]*b[2] + a[0]*b[1] - a[1]*b[0] + a[2]*b[3],
    a[3]*b[3] - a[0]*b[0] - a[1]*b[1] - a[2]*b[2],
  ];
}
function qRot(q, v) {    // rotate vec3 by quaternion
  const [x, y, z, w] = q, [vx, vy, vz] = v;
  const tx = 2*(y*vz - z*vy), ty = 2*(z*vx - x*vz), tz = 2*(x*vy - y*vx);
  return [vx + w*tx + (y*tz - z*ty), vy + w*ty + (z*tx - x*tz), vz + w*tz + (x*ty - y*tx)];
}
function qNlerp(a, b, t) {
  let d = a[0]*b[0] + a[1]*b[1] + a[2]*b[2] + a[3]*b[3];
  const s = d < 0 ? -1 : 1;
  const r = [a[0] + (b[0]*s - a[0])*t, a[1] + (b[1]*s - a[1])*t, a[2] + (b[2]*s - a[2])*t, a[3] + (b[3]*s - a[3])*t];
  const m = Math.hypot(r[0], r[1], r[2], r[3]) || 1;
  return [r[0]/m, r[1]/m, r[2]/m, r[3]/m];
}
// Sample a quaternion track at time t (track.times sorted; values flat [x,y,z,w]*).
function sampleTrack(track, t) {
  const times = track.times, vals = track.values;
  if (!times || !times.length) return [0, 0, 0, 1];
  if (t <= times[0]) return vals.slice(0, 4);
  const last = times.length - 1;
  if (t >= times[last]) return vals.slice(last*4, last*4 + 4);
  let i = 0; while (i < last && times[i+1] < t) i++;
  const t0 = times[i], t1 = times[i+1];
  const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
  return qNlerp(vals.slice(i*4, i*4 + 4), vals.slice((i+1)*4, (i+1)*4 + 4), f);
}

const _previewCache = new Map();   // id → pack data (or null while loading / on error)
async function fetchPreview(id) {
  if (_previewCache.has(id)) return _previewCache.get(id);
  _previewCache.set(id, null);
  try {
    const r = await fetch(`${API}/animations/${id}/preview`);
    if (r.ok) { const d = await r.json(); _previewCache.set(id, d); return d; }
  } catch {}
  return null;
}

function drawSkeleton(ctx, clip, time, W, H) {
  // Build a name→track map once per clip (cached on the clip object).
  if (!clip._byBone) {
    clip._byBone = {};
    for (const tr of (clip.tracks || [])) {
      const bone = String(tr.name).split('.')[0];
      if (String(tr.name).endsWith('.quaternion')) clip._byBone[bone] = tr;
    }
  }
  const nodes = {};
  for (const [bone, parent, off] of SKELETON) {
    const tr = clip._byBone[bone];
    const local = tr ? sampleTrack(tr, time) : [0, 0, 0, 1];
    if (!parent) { nodes[bone] = { wq: local, wp: [0, 0, 0] }; continue; }
    const p = nodes[parent];
    nodes[bone] = { wq: qMul(p.wq, local), wp: addV(p.wp, qRot(p.wq, off)) };
  }
  const S = H * 0.62, cx = W / 2, cy = H * 0.60;
  const px = (p) => [cx + p[0] * S, cy - p[1] * S];
  ctx.clearRect(0, 0, W, H);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = '#a5b4fc'; ctx.lineWidth = Math.max(2, H * 0.022);
  for (const [bone, parent] of SKELETON) {
    if (!parent) continue;
    const a = px(nodes[parent].wp), b = px(nodes[bone].wp);
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
  }
  // head
  const hp = px(nodes['mixamorigHead'].wp);
  ctx.fillStyle = '#c4b5fd';
  ctx.beginPath(); ctx.arc(hp[0], hp[1] - H * 0.02, H * 0.055, 0, Math.PI * 2); ctx.fill();
  // joints
  ctx.fillStyle = '#8b5cf6';
  for (const [bone] of SKELETON) { const p = px(nodes[bone].wp); ctx.beginPath(); ctx.arc(p[0], p[1], H * 0.014, 0, Math.PI * 2); ctx.fill(); }
}
function addV(a, b) { return [a[0]+b[0], a[1]+b[1], a[2]+b[2]]; }

function attachAnimPreview(card, id) {
  const canvas = card.querySelector('.anim-canvas');
  const emoji = card.querySelector('.anim-emoji');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let raf = null, start = 0, clip = null;
  const loop = (now) => {
    if (!clip) return;
    const dur = clip.duration || 2;
    const t = ((now - start) / 1000) % dur;
    drawSkeleton(ctx, clip, t, canvas.width, canvas.height);
    raf = requestAnimationFrame(loop);
  };
  card.addEventListener('mouseenter', async () => {
    const data = await fetchPreview(id);
    const c = data && Array.isArray(data.animations) && data.animations[0];
    if (!c) return;   // no data → keep the emoji
    clip = c;
    canvas.classList.add('show'); if (emoji) emoji.style.opacity = '0';
    start = performance.now();
    cancelAnimationFrame(raf); raf = requestAnimationFrame(loop);
  });
  card.addEventListener('mouseleave', () => {
    cancelAnimationFrame(raf); raf = null;
    canvas.classList.remove('show'); if (emoji) emoji.style.opacity = '';
  });
}

// ── Item actions ──────────────────────────────────────────────────────────────
window.previewItem = async (id) => {
  const endpoint = contentType === 'animations' ? 'animations' : 'characters';
  try {
    const r = await fetch(`${API}/${endpoint}/${id}`);
    const item = await r.json();
    const tags = Array.isArray(item.tags) ? item.tags.join(', ') : item.tags;
    const extra = contentType === 'animations' ? `\nClips: ${item.clipCount || 'unknown'}` : '';
    alert(`${item.name}\nBy: ${item.author}\nDescription: ${item.description || '—'}\nTags: ${tags || '—'}\nDownloads: ${item.downloads}${extra}`);
  } catch { alert('Could not fetch item info.'); }
};

window.downloadItem = (id, encodedName) => {
  const name = decodeURIComponent(encodedName);
  const item = allItems.find(x => x.id === id);
  if (!item) return;
  const type = contentType === 'animations' ? 'animation' : 'character';
  if (item.price > 0) {
    if (!confirm(`Purchase “${name}” for $${item.price.toFixed(2)}?\n\nDeskBuddy is in free preview — there's no real charge. This unlocks the item and installs it into the app.`)) return;
    purchaseThenInstall(type, id, name);
  } else {
    doInstall(type, id, name);
  }
};
window.installOwned = (type, id, enc) => doInstall(type, id, decodeURIComponent(enc));

// Record the sale, then install. Ownership persists so it stays in My Library and can
// be re-installed without paying again.
async function purchaseThenInstall(type, id, name) {
  const endpoint = type === 'animation' ? 'animations' : 'characters';
  try {
    const r = await fetch(`${API}/${endpoint}/${id}/purchase`, { method: 'POST', headers: authHeaders() });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || `HTTP ${r.status}`); }
  } catch (err) { alert('Purchase error: ' + err.message); return; }
  doInstall(type, id, name);
}

// Download from the server and install straight into the app (no manual folder
// juggling): characters → your library, animation packs → the global anim library.
async function doInstall(type, id, name) {
  const endpoint = type === 'animation' ? 'animations' : 'characters';
  try {
    const res = await fetch(`${API}/${endpoint}/${id}/download`, { headers: authHeaders() });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))).error) || 'Download failed');
    if (type === 'animation') {
      const data = await res.json();
      if (window.deskbuddy?.installAnimationPack) {
        await window.deskbuddy.installAnimationPack({ name, data });
        toast(`✓ "${name}" added to your animation library — usable by every character.`);
      } else { triggerDownload(new Blob([JSON.stringify(data)], { type: 'application/json' }), `${name}.animpack`); }
    } else {
      const buf = await res.arrayBuffer();
      if (window.deskbuddy?.installCharacter) {
        await window.deskbuddy.installCharacter({ name, bytes: buf });
        toast(`✓ "${name}" added — open it from Character Studio.`);
      } else { triggerDownload(new Blob([buf]), `${name}.charpack`); }
    }
    fetch(`${API}/${endpoint}/${id}/like`, { method: 'POST', headers: authHeaders() }).catch(() => {});
    if (activeTab === 'browse') fetchItems();
  } catch (err) { alert('Install error: ' + err.message); }
}

async function renderMyLibrary() {
  const grid = $('card-grid'); grid.innerHTML = '';
  let owned = [];
  try { owned = await (await fetch(`${API}/me/library`, { headers: authHeaders() })).json(); } catch {}
  if (!owned.length) {
    grid.innerHTML = '<div class="no-items">Nothing yet — download a character or animation pack and it\'ll appear here, already installed in the app.</div>';
    return;
  }
  owned.slice().reverse().forEach(o => {
    const isAnim = o.type === 'animation';
    const card = document.createElement('div'); card.className = 'card';
    card.innerHTML = `
      <div class="card-thumb">${isAnim ? '💃' : '🐾'}</div>
      <div class="card-body"><div class="card-name">${o.name}</div>
        <div class="card-meta"><span>${isAnim ? 'Animation pack' : 'Character'} · owned</span></div></div>
      <div class="card-actions"><button class="btn btn-primary" onclick="installOwned('${o.type}',${o.id},'${encodeURIComponent(o.name)}')">Re-install</button></div>`;
    grid.appendChild(card);
  });
}

function toast(msg) {
  let t = $('mk-toast');
  if (!t) { t = document.createElement('div'); t.id = 'mk-toast';
    t.style.cssText = 'position:fixed;bottom:22px;left:50%;transform:translateX(-50%);background:#1a1a2e;border:1px solid var(--border);color:var(--text);padding:11px 20px;border-radius:10px;font-size:13px;z-index:300;box-shadow:0 8px 24px rgba(0,0,0,.45);transition:opacity .3s';
    document.body.appendChild(t); }
  t.textContent = msg; t.style.opacity = '1';
  clearTimeout(t._timer); t._timer = setTimeout(() => { t.style.opacity = '0'; }, 3400);
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ── Content type toggle ───────────────────────────────────────────────────────
window.setContentType = (type, el) => {
  contentType = type;
  document.querySelectorAll('.ctype-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  fetchItems();
};

// ── Filters / tabs ─────────────────────────────────────────────────────────────
window.setFilter = (val, el) => { activeFilter = val; el.closest('.filter-group').querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active')); el.classList.add('active'); fetchItems(); };
window.setPrice  = (val, el) => { activePrice  = val; el.closest('.filter-group').querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active')); el.classList.add('active'); fetchItems(); };
window.setSort   = (val, el) => { activeSort   = val; el.closest('.filter-group').querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active')); el.classList.add('active'); fetchItems(); };
window.setTab    = (val, el) => { activeTab    = val; document.querySelectorAll('.tab').forEach(t => t.classList.remove('active')); el.classList.add('active'); fetchItems(); };
window.filterCards = (q) => { searchQuery = q.toLowerCase(); fetchItems(); };

// ── Publish modal: browse the studio library, multi-select, publish ─────────────
window.showUploadModal = async () => {
  librarySelection.clear();
  $('upload-modal').classList.add('show');
  await loadLibrary();
};
window.closeUploadModal = () => {
  $('upload-modal').classList.remove('show');
  $('up-progress').style.display = 'none';
  $('up-form').style.display     = 'block';
};

// Pull every character + animation pack straight from the Character Studio library.
async function loadLibrary() {
  const box = $('up-library');
  if (!window.deskbuddy?.listCharacters) { box.innerHTML = '<div class="up-empty">Studio library unavailable.</div>'; return; }
  box.innerHTML = '<div class="up-empty">Loading your studio library…</div>';
  try {
    const [chars, anims] = await Promise.all([
      window.deskbuddy.listCharacters().catch(() => []),
      window.deskbuddy.listAnimationPacks?.().catch(() => []) || [],
    ]);
    library = [
      ...chars.map(c => ({ kind: 'character', name: c.name || c.filename, filename: c.filename, path: c.path,
        mtime: c.mtime || 0, description: c.manifest?.description || '', tags: c.manifest?.tags || [],
        thumbnail: c.manifest?.thumbnail || '',
        meta: ((c.manifest?.animationCount ?? c.manifest?.importedClips?.length) ? `${c.manifest.animationCount ?? c.manifest.importedClips.length} clips` : (c.filename.split('.').pop() || '').toUpperCase()) })),
      ...anims.map(a => ({ kind: 'animation', name: a.name || a.filename, filename: a.filename, path: a.path,
        mtime: a.mtime || 0, description: a.description || '', tags: a.tags || [],
        clipCount: (a.animations || []).length, meta: `${(a.animations || []).length} clips` })),
    ];
  } catch (e) { box.innerHTML = `<div class="up-empty">Couldn't load library: ${e.message}</div>`; return; }
  renderLibrary();
}

window.renderLibrary = () => {
  const box = $('up-library'); if (!box) return;
  const sort = $('up-sort')?.value || 'name';
  const items = [...library].sort((a, b) => {
    if (sort === 'name')      return a.name.localeCompare(b.name);
    if (sort === 'name-desc') return b.name.localeCompare(a.name);
    if (sort === 'recent')    return (b.mtime || 0) - (a.mtime || 0);
    if (sort === 'type')      return a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name);
    return 0;
  });
  if (!items.length) { box.innerHTML = '<div class="up-empty">Nothing in your studio yet. Create or import a character first.</div>'; updateUpCount(); return; }
  box.innerHTML = items.map(it => {
    const checked = librarySelection.has(it.path) ? 'checked' : '';
    const ic = it.thumbnail
      ? `<img class="up-thumb" src="${escapeHtml(it.thumbnail)}" alt="">`
      : `<span class="up-ic">${it.kind === 'animation' ? '🎞️' : '🧍'}</span>`;
    const badge = it.kind === 'animation' ? '<span class="up-badge anim">Animation</span>' : '<span class="up-badge">Character</span>';
    return `<label class="up-item">
      <input type="checkbox" data-path="${encodeURIComponent(it.path)}" ${checked} onchange="toggleLibraryItem(this)">
      ${ic}
      <span class="up-name">${escapeHtml(it.name)}</span>
      ${badge}
      <span class="up-meta">${escapeHtml(it.meta || '')}</span>
    </label>`;
  }).join('');
  updateUpCount();
};

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

window.toggleLibraryItem = (el) => {
  const path = decodeURIComponent(el.dataset.path);
  const item = library.find(i => i.path === path);
  if (!item) return;
  if (el.checked) librarySelection.set(path, item); else librarySelection.delete(path);
  updateUpCount();
};
window.selectAllLibrary = () => { for (const it of library) librarySelection.set(it.path, it); renderLibrary(); };
window.clearLibrarySelection = () => { librarySelection.clear(); renderLibrary(); };
function updateUpCount() {
  const n = librarySelection.size;
  $('up-count').textContent = `${n} selected`;
  const btn = $('up-submit'); if (btn) { btn.disabled = n === 0; btn.textContent = n > 1 ? `Publish ${n} Items` : 'Publish Selected'; }
}

window.submitUpload = async () => {
  const items = [...librarySelection.values()];
  if (!items.length) { alert('Select at least one character or animation to publish.'); return; }
  const price = $('up-price').value;

  $('up-form').style.display     = 'none';
  $('up-progress').style.display = 'block';

  const ok = [], failed = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    $('up-progress-lbl').textContent = `Publishing ${i + 1} of ${items.length}: ${it.name}…`;
    try {
      const buf = await window.deskbuddy.readCharacterFile(it.path);
      if (!buf) throw new Error('could not read file');
      const endpoint = it.kind === 'animation' ? 'animations' : 'characters';
      const fd = new FormData();
      fd.append('name', it.name);
      fd.append('description', it.description || '');
      fd.append('tags', JSON.stringify(it.tags || []));
      fd.append('price', price);
      if (it.kind === 'animation') fd.append('clipCount', String(it.clipCount || 0));
      if (it.kind === 'character' && it.thumbnail) fd.append('thumbnail', it.thumbnail);   // rendered model image
      fd.append('file', new Blob([buf]), it.filename);
      const res = await fetch(`${API}/${endpoint}`, { method: 'POST', headers: authHeaders(), body: fd });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `HTTP ${res.status}`); }
      ok.push(it.name);
    } catch (err) { failed.push(`${it.name} (${err.message})`); }
  }

  closeUploadModal();
  let msg = ok.length ? `Published ${ok.length} item${ok.length > 1 ? 's' : ''}: ${ok.join(', ')}.` : '';
  if (failed.length) msg += `${msg ? '\n\n' : ''}Failed: ${failed.join(', ')}`;
  alert(msg || 'Nothing was published.');
  fetchItems();
};

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  // Use the app's shared SERVER_BASE (defaults to the live server) so the marketplace and the
  // rest of the app always talk to the same backend.
  try { const b = await window.deskbuddy?.authServerBase?.(); if (b) { SERVER = b.replace(/\/+$/, ''); API = SERVER + '/api'; } } catch {}
  checkAuth();
})();
