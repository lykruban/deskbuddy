// ═══════════════════════════════════════════════════════════════════════════
//  Website-facing endpoints for deskbuddy.yuvexel.com — public app stats
//  (real download counts from GitHub releases, likes) and the guestbook
//  reviews. Data lives in dataDir/site-stats.json + site-reviews.json,
//  reviewed by the owner the same way as feedback.json.
// ═══════════════════════════════════════════════════════════════════════════
const path = require('path');
const fs = require('fs');

const GH_RELEASES = 'https://api.github.com/repos/lykruban/deskbuddy/releases';
const GH_TTL = 10 * 60 * 1000;               // re-ask GitHub at most every 10 min
const RL_WINDOW = 10 * 60 * 1000, RL_MAX = 5; // 5 review posts / 10 min / IP

function mount(app, dataDir, clientIp) {
  const statsFile = path.join(dataDir, 'site-stats.json');
  const reviewsFile = path.join(dataDir, 'site-reviews.json');
  const readJson = (f, fb) => { try { const d = JSON.parse(fs.readFileSync(f, 'utf8')); return d ?? fb; } catch { return fb; } };
  const writeJson = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2));

  // Download count = sum of asset download_count across all GitHub releases (real
  // installer downloads). Cached in memory and persisted, so the site still shows
  // the last-known number when GitHub is slow or unreachable.
  let gh = { at: 0, downloads: readJson(statsFile, {}).downloads || 0 };
  async function downloadCount() {
    if (Date.now() - gh.at < GH_TTL || typeof fetch !== 'function') return gh.downloads;
    gh.at = Date.now();   // set first so failures don't hammer GitHub
    try {
      const r = await fetch(GH_RELEASES, { headers: { 'User-Agent': 'deskbuddy-site' } });
      if (r.ok) {
        const rels = await r.json();
        gh.downloads = rels.reduce((s, rel) => s + (rel.assets || []).reduce((a, x) => a + (x.download_count || 0), 0), 0);
        const st = readJson(statsFile, {}); st.downloads = gh.downloads; writeJson(statsFile, st);
      }
    } catch {}
    return gh.downloads;
  }

  app.get('/api/app/stats', async (_req, res) => {
    const st = readJson(statsFile, {});
    const reviews = readJson(reviewsFile, []);
    const rating = reviews.length ? reviews.reduce((s, r) => s + (r.rating || 0), 0) / reviews.length : 0;
    res.json({
      downloads: await downloadCount(),
      likes: st.likes || 0,
      reviews: reviews.length,
      rating: Math.round(rating * 10) / 10,
    });
  });

  // Like / unlike (the site guards repeats client-side; this just counts).
  app.post('/api/app/like', (req, res) => {
    const st = readJson(statsFile, {});
    st.likes = Math.max(0, (st.likes || 0) + ((req.body || {}).undo ? -1 : 1));
    writeJson(statsFile, st);
    res.json({ ok: true, likes: st.likes });
  });

  // Newest 60 reviews, public fields only.
  app.get('/api/app/reviews', (_req, res) => {
    const list = readJson(reviewsFile, []);
    res.json(list.slice(-60).reverse().map(r => ({ name: r.name, rating: r.rating, text: r.text, at: r.at })));
  });

  const buckets = new Map();
  app.post('/api/app/review', (req, res) => {
    const key = clientIp(req), now = Date.now();
    let b = buckets.get(key);
    if (!b || now - b.start > RL_WINDOW) { b = { start: now, n: 0 }; buckets.set(key, b); }
    if (++b.n > RL_MAX) return res.status(429).json({ error: 'Easy there — try again in a few minutes 🙂' });

    const rating = parseInt((req.body || {}).rating);
    const text = String((req.body || {}).text || '').trim().slice(0, 800);
    const name = String((req.body || {}).name || '').trim().slice(0, 40);
    if (!(rating >= 1 && rating <= 5)) return res.status(400).json({ error: 'Pick a star rating first' });
    if (text.length < 5) return res.status(400).json({ error: 'Tell us a little more than that 🙂' });

    const list = readJson(reviewsFile, []);
    const entry = { name: name || 'Anonymous buddy', rating, text, at: now,
      ua: String(req.headers['user-agent'] || '').slice(0, 200), ip: key };
    list.push(entry);
    writeJson(reviewsFile, list);
    res.status(201).json({ ok: true, review: { name: entry.name, rating, text, at: now } });
  });
}

module.exports = { mount };
