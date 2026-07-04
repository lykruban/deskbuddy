// ═══════════════════════════════════════════════════════════════════════════
//  Site logic (all pages — each block guards on element presence).
//  Gallery + waitlist + download (home), FAQ + feedback forms (support),
//  blog render (blog), directory scroll-spy (docs). No dependencies.
// ═══════════════════════════════════════════════════════════════════════════
(() => {
  const CFG = window.DB_CONFIG || {};
  const $ = (id) => document.getElementById(id);

  // ── scroll reveal ──────────────────────────────────────────────────────────
  const io = new IntersectionObserver((es) => es.forEach(e => {
    if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }), { threshold: 0.12 });
  document.querySelectorAll('.reveal').forEach(el => io.observe(el));

  // ── gallery (home) ─────────────────────────────────────────────────────────
  const gal = $('gallery');
  if (gal && Array.isArray(CFG.MEDIA)) {
    gal.innerHTML = CFG.MEDIA.map(m => {
      const wide = (m.ratio || '').startsWith('32') ? ' wide' : '';
      const pad = (() => { const [w, h] = (m.ratio || '16/10').split('/').map(Number); return (h / w * 100).toFixed(2); })();
      const media = m.src
        ? (m.kind === 'video'
            ? `<video class="g-media" src="${m.src}" autoplay muted loop playsinline preload="metadata"></video>`
            : `<img class="g-media" src="${m.src}" alt="${m.label}" loading="lazy">`)
        : `<div class="g-ph"><b>${m.label}</b><span>${m.hint || 'capture coming soon'}</span></div>`;
      const cap = m.src ? `<figcaption class="g-cap">${m.label}</figcaption>` : '';
      return `<figure class="g-item${wide}"><div class="g-frame" style="padding-top:${pad}%">${media}</div>${cap}</figure>`;
    }).join('');
  }

  // ── download buttons (home + download page) ────────────────────────────────
  const vEl = $('dl-version'), sEl = $('dl-size');
  if (vEl) vEl.textContent = CFG.VERSION || 'v1.0.0';
  if (sEl) sEl.textContent = CFG.SIZE || '';
  const wire = (el, url, kind) => {
    if (!el) return;
    if (url) el.href = url;
    else el.addEventListener('click', (e) => { e.preventDefault(); alert(`The ${kind} download is being hosted — check back soon!`); });
  };
  wire($('dl-btn'), CFG.DOWNLOAD_URL, 'installer');
  wire($('dl-portable'), CFG.PORTABLE_URL, 'portable');

  // ── waitlist (home) ────────────────────────────────────────────────────────
  const wlForm = $('waitlist-form'), wlMsg = $('wl-msg'), wlBtn = $('wl-btn'), wlEmail = $('wl-email');
  wlForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const val = (wlEmail.value || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(val)) { wlFlash('That email looks… improvised. Try again?', false); return; }
    wlBtn.disabled = true; wlBtn.textContent = 'Adding…';
    try {
      const r = await fetch((CFG.API_BASE || '') + '/api/waitlist', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: val }),
      });
      if (r.ok) { wlFlash('You\'re on the list. Talk soon.', true); wlEmail.value = ''; }
      else { const d = await r.json().catch(() => ({})); wlFlash(d.error || 'Hmm, that didn\'t save. Try again?', false); }
    } catch { wlFlash('Couldn\'t reach the server — try again in a moment.', false); }
    wlBtn.disabled = false; wlBtn.textContent = 'Notify me';
  });
  function wlFlash(t, ok) { if (wlMsg) { wlMsg.textContent = t; wlMsg.className = 'wl-msg ' + (ok ? 'ok' : 'err'); } }

  // ── feedback forms (support page: data-feedback="bug"|"question") ──────────
  document.querySelectorAll('form[data-feedback]').forEach(form => {
    const msg = form.querySelector('.form-msg'), btn = form.querySelector('button');
    const flash = (t, ok) => { if (msg) { msg.textContent = t; msg.className = 'form-msg ' + (ok ? 'ok' : 'err'); } };
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const message = (form.message?.value || '').trim();
      const email = (form.email?.value || '').trim();
      if (message.length < 5) { flash('Tell us a little more than that 🙂', false); return; }
      btn.disabled = true;
      try {
        const r = await fetch((CFG.API_BASE || '') + '/api/feedback', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: form.dataset.feedback, message, email }),
        });
        if (r.ok) { flash('Got it — thank you! We read everything. 🐾', true); form.reset(); }
        else { const d = await r.json().catch(() => ({})); flash(d.error || 'That didn\'t send — try again?', false); }
      } catch { flash('Couldn\'t reach the server — try again in a moment.', false); }
      btn.disabled = false;
    });
  });

  // ── FAQ (support page) ─────────────────────────────────────────────────────
  const faq = $('faq-list');
  if (faq && Array.isArray(CFG.FAQ)) {
    faq.innerHTML = CFG.FAQ.map(f =>
      `<details><summary>${f.q}</summary><div class="faq-a">${f.a}</div></details>`).join('');
  }

  // ── blog ───────────────────────────────────────────────────────────────────
  const blog = $('blog-list');
  if (blog && Array.isArray(CFG.BLOG)) {
    blog.innerHTML = CFG.BLOG.length ? CFG.BLOG.map(p =>
      `<article class="post" id="${p.id}"><div class="date">${p.date}</div><h2>${p.title}</h2><div class="body">${p.body}</div></article>`).join('')
      : '<p style="color:var(--muted)">Nothing here yet — first post soon.</p>';
  }

  // ── docs directory scroll-spy ──────────────────────────────────────────────
  const side = $('docs-side');
  if (side) {
    const links = [...side.querySelectorAll('a[href^="#"]')];
    const secs = links.map(a => document.getElementById(a.getAttribute('href').slice(1))).filter(Boolean);
    const spy = new IntersectionObserver((es) => {
      for (const e of es) if (e.isIntersecting) {
        links.forEach(a => a.classList.toggle('on', a.getAttribute('href') === '#' + e.target.id));
      }
    }, { rootMargin: '-15% 0px -70% 0px' });
    secs.forEach(s => spy.observe(s));
  }
})();
