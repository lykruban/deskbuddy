// ═══════════════════════════════════════════════════════════════════════════
//  Page logic: gallery (from CONFIG.MEDIA), waitlist → live API, download
//  buttons (from CONFIG), scroll reveals. No dependencies.
// ═══════════════════════════════════════════════════════════════════════════
(() => {
  const CFG = window.DB_CONFIG || {};
  const $ = (id) => document.getElementById(id);

  // ── scroll reveal ──────────────────────────────────────────────────────────
  const io = new IntersectionObserver((es) => es.forEach(e => {
    if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }), { threshold: 0.12 });
  document.querySelectorAll('.reveal').forEach(el => io.observe(el));

  // ── gallery from CONFIG.MEDIA ──────────────────────────────────────────────
  const gal = $('gallery');
  if (gal && Array.isArray(CFG.MEDIA)) {
    gal.innerHTML = CFG.MEDIA.map(m => {
      const wide = (m.ratio || '').startsWith('32') ? ' wide' : '';
      const pad = (() => { const [w, h] = (m.ratio || '16/10').split('/').map(Number); return (h / w * 100).toFixed(2); })();
      const media = m.src
        ? (m.kind === 'video'
            ? `<video class="g-media" src="${m.src}" autoplay muted loop playsinline></video>`
            : `<img class="g-media" src="${m.src}" alt="${m.label}" loading="lazy">`)
        : `<div class="g-ph"><b>${m.label}</b><span>${m.hint || 'capture coming soon'}</span></div>`;
      const cap = m.src ? `<figcaption class="g-cap">${m.label}</figcaption>` : '';
      return `<figure class="g-item${wide}"><div class="g-frame" style="padding-top:${pad}%">${media}</div>${cap}</figure>`;
    }).join('');
  }

  // ── download buttons ───────────────────────────────────────────────────────
  const vEl = $('dl-version'), sEl = $('dl-size');
  if (vEl) vEl.textContent = CFG.VERSION || 'v1.0.0';
  if (sEl) sEl.textContent = CFG.SIZE || '';
  const wire = (el, url, kind) => {
    if (!el) return;
    if (url) { el.href = url; }
    else el.addEventListener('click', (e) => {
      e.preventDefault();
      alert(`The ${kind} download is being hosted right now — check back very soon!\n(Or grab it from github.com/lykruban/deskbuddy releases.)`);
    });
  };
  wire($('dl-btn'), CFG.DOWNLOAD_URL, 'installer');
  wire($('dl-portable'), CFG.PORTABLE_URL, 'portable');

  // ── waitlist → live backend ────────────────────────────────────────────────
  const form = $('waitlist-form'), msg = $('wl-msg'), btn = $('wl-btn'), email = $('wl-email');
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const val = (email.value || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(val)) { flash('That email looks… improvised. Try again?', false); return; }
    btn.disabled = true; btn.textContent = 'Adding…';
    try {
      const r = await fetch((CFG.API_BASE || '') + '/api/waitlist', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: val }),
      });
      if (r.ok) { flash('You\'re on the list. Talk soon.', true); email.value = ''; }
      else { const d = await r.json().catch(() => ({})); flash(d.error || 'Hmm, that didn\'t save. Try again?', false); }
    } catch { flash('Couldn\'t reach the server — try again in a moment.', false); }
    btn.disabled = false; btn.textContent = 'Notify me';
  });
  function flash(text, ok) { if (!msg) return; msg.textContent = text; msg.className = 'wl-msg ' + (ok ? 'ok' : 'err'); }
})();
