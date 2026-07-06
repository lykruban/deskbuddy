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

  // ── nav state + scroll progress (rAF-throttled, transform-only) ────────────
  const nav = document.querySelector('.nav');
  const prog = document.createElement('div');
  prog.className = 'progress'; prog.setAttribute('aria-hidden', 'true');
  document.body.prepend(prog);
  let raf = 0;
  const onScroll = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      const h = document.documentElement;
      nav?.classList.toggle('scrolled', h.scrollTop > 8);
      prog.style.transform = `scaleX(${h.scrollTop / Math.max(1, h.scrollHeight - h.clientHeight)})`;
      raf = 0;
    });
  };
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // ── mobile nav menu (hamburger dropdown) ────────────────────────────────────
  const burger = document.querySelector('.nav-burger');
  const navLinks = document.querySelector('.nav-links');
  if (burger && navLinks) {
    const closeMenu = () => { navLinks.classList.remove('open'); burger.setAttribute('aria-expanded', 'false'); };
    burger.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = navLinks.classList.toggle('open');
      burger.setAttribute('aria-expanded', String(open));
    });
    navLinks.querySelectorAll('a').forEach(a => a.addEventListener('click', closeMenu));
    document.addEventListener('click', (e) => {
      if (navLinks.classList.contains('open') && !navLinks.contains(e.target) && e.target !== burger) closeMenu();
    });
    addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
    addEventListener('resize', () => { if (innerWidth > 820) closeMenu(); });
  }

  // ── videos only run while on screen (saves CPU/GPU + battery) ──────────────
  const vio = new IntersectionObserver((es) => es.forEach(e => {
    const v = e.target;
    if (e.isIntersecting) v.play().catch(() => {});
    else v.pause();
  }), { threshold: 0.2 });
  const watchVideos = (root) =>
    (root || document).querySelectorAll('video').forEach(v => vio.observe(v));

  // ── mouse-tracked card glow (pointer devices only) ─────────────────────────
  if (matchMedia('(pointer:fine)').matches) {
    document.addEventListener('pointermove', (e) => {
      const el = e.target.closest?.('.card, .tier');
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', (e.clientX - r.left) + 'px');
      el.style.setProperty('--my', (e.clientY - r.top) + 'px');
    }, { passive: true });
  }

  // ── gallery (home) ─────────────────────────────────────────────────────────
  const gal = $('gallery');
  if (gal && Array.isArray(CFG.MEDIA)) {
    gal.innerHTML = CFG.MEDIA.map(m => {
      const wide = (m.ratio || '').startsWith('32') ? ' wide' : '';
      const pad = (() => { const [w, h] = (m.ratio || '16/10').split('/').map(Number); return (h / w * 100).toFixed(2); })();
      const media = m.src
        ? (m.kind === 'video'
            ? `<video class="g-media" src="${m.src}" muted loop playsinline preload="none"></video>`
            : `<img class="g-media" src="${m.src}" alt="${m.label}" loading="lazy">`)
        : `<div class="g-ph"><b>${m.label}</b><span>${m.hint || 'capture coming soon'}</span></div>`;
      const cap = m.src ? `<figcaption class="g-cap">${m.label}</figcaption>` : '';
      return `<figure class="g-item${wide}"><div class="g-frame" style="padding-top:${pad}%">${media}</div>${cap}</figure>`;
    }).join('');
  }
  watchVideos();

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

  // ── app stats + likes + reviews (home) ─────────────────────────────────────
  const API = CFG.API_BASE || '';
  const nf = new Intl.NumberFormat('en-US');
  const starStr = (r) => { const n = Math.round(r); return '★★★★★☆☆☆☆☆'.slice(5 - n, 10 - n); };
  const setText = (id, v) => { const el = $(id); if (el) el.textContent = v; };

  // animate a number from 0 → target once (cheap, one rAF loop, respects RM)
  function countUp(el, target) {
    if (!el) return;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || target < 1) { el.textContent = nf.format(target); return; }
    const dur = 900, t0 = performance.now();
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      el.textContent = nf.format(Math.round(target * e));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  const statBar = $('stat-bar');
  const revList = $('reviews-list');
  if (statBar || revList) {
    const LS_LIKED = 'db_liked', LS_REVIEWED = 'db_reviewed';
    const fb = CFG.STATS_FALLBACK || { downloads: 0, likes: 0, reviews: 0, rating: 0 };

    const paintStats = (s) => {
      countUp($('stat-downloads'), s.downloads || 0);
      countUp($('stat-likes'), s.likes || 0);
      setText('stat-reviews', nf.format(s.reviews || 0));
      setText('stat-rating', (s.rating || 0).toFixed(1));
      const st = $('stat-stars'); if (st) st.textContent = starStr(s.rating || 0);
      setText('rev-avg', (s.rating || 0) ? (s.rating).toFixed(1) : '—');
      $('rev-rating')?.querySelector('.rev-big')?.classList.toggle('has-rating', (s.rating || 0) > 0);
      setText('rev-count', nf.format(s.reviews || 0));
      setText('rev-dl', nf.format(s.downloads || 0));
      const rs = $('rev-stars'); if (rs) rs.textContent = starStr(s.rating || 0);
    };
    paintStats(fb);
    fetch(API + '/api/app/stats').then(r => r.json()).then(paintStats).catch(() => {});

    // like (once per browser, toggleable) ───────────────────────────────────────
    const likeBtn = $('like-btn');
    if (likeBtn) {
      let liked = localStorage.getItem(LS_LIKED) === '1';
      const paintLike = () => { likeBtn.classList.toggle('on', liked); likeBtn.setAttribute('aria-pressed', liked); };
      paintLike();
      likeBtn.addEventListener('click', async () => {
        liked = !liked;
        localStorage.setItem(LS_LIKED, liked ? '1' : '0');
        paintLike();
        likeBtn.classList.remove('pop'); void likeBtn.offsetWidth; likeBtn.classList.add('pop');
        try {
          const r = await fetch(API + '/api/app/like', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ undo: !liked }),
          });
          const d = await r.json().catch(() => ({}));
          if (typeof d.likes === 'number') setText('stat-likes', nf.format(d.likes));
        } catch {}
      });
    }

    // reviews list ────────────────────────────────────────────────────────────
    const timeAgo = (ts) => {
      const s = (Date.now() - ts) / 1000;
      if (s < 3600) return Math.max(1, Math.floor(s / 60)) + 'm ago';
      if (s < 86400) return Math.floor(s / 3600) + 'h ago';
      if (s < 2592000) return Math.floor(s / 86400) + 'd ago';
      return new Date(ts).toLocaleDateString();
    };
    const esc = (s) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const revCard = (r) => `<figure class="rev-card"><div class="rev-head">
        <span class="rev-name">${esc(r.name || 'Anonymous buddy')}</span>
        <span class="rev-stars-sm stars">${starStr(r.rating)}</span></div>
      <blockquote>${esc(r.text || '')}</blockquote>
      <figcaption class="rev-when">${r.at ? timeAgo(r.at) : ''}</figcaption></figure>`;
    const renderReviews = (list) => {
      if (!revList) return;
      revList.innerHTML = list && list.length
        ? list.map(revCard).join('')
        : `<p class="rev-empty">No reviews yet — be the first to say hi 🐾</p>`;
    };
    if (revList) fetch(API + '/api/app/reviews').then(r => r.json()).then(renderReviews).catch(() => renderReviews([]));

    // star picker + submit ────────────────────────────────────────────────────
    const pick = $('star-pick'), form = $('review-form'), rBtn = $('rev-btn'), rMsg = $('rev-msg');
    let rating = 0;
    if (pick) {
      const stars = [...pick.querySelectorAll('button')];
      const paint = (n) => stars.forEach((b, i) => b.classList.toggle('lit', i < n));
      stars.forEach(b => {
        b.addEventListener('mouseenter', () => paint(+b.dataset.v));
        b.addEventListener('click', () => { rating = +b.dataset.v; paint(rating); });
      });
      pick.addEventListener('mouseleave', () => paint(rating));
    }
    const revFlash = (t, ok) => { if (rMsg) { rMsg.textContent = t; rMsg.className = 'form-msg ' + (ok ? 'ok' : 'err'); } };
    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (localStorage.getItem(LS_REVIEWED) === '1') { revFlash('You already left a review — thank you! 🐾', true); return; }
      const text = ($('rev-text').value || '').trim();
      const name = ($('rev-name').value || '').trim();
      if (!rating) { revFlash('Pick a star rating first ⭐', false); return; }
      if (text.length < 5) { revFlash('Tell us a little more than that 🙂', false); return; }
      rBtn.disabled = true; rBtn.textContent = 'Posting…';
      try {
        const r = await fetch(API + '/api/app/review', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rating, text, name }),
        });
        const d = await r.json().catch(() => ({}));
        if (r.ok && d.review) {
          localStorage.setItem(LS_REVIEWED, '1');
          revFlash('Posted — thank you! 🐾', true);
          form.reset(); rating = 0; pick?.querySelectorAll('button').forEach(b => b.classList.remove('lit'));
          if (revList) {
            const empty = revList.querySelector('.rev-empty'); if (empty) revList.innerHTML = '';
            revList.insertAdjacentHTML('afterbegin', revCard(d.review));
          }
        } else revFlash(d.error || 'That didn\'t post — try again?', false);
      } catch { revFlash('Couldn\'t reach the server — try again in a moment.', false); }
      rBtn.disabled = false; rBtn.textContent = 'Post review';
    });
  }

  // ── docs directory toggle (mobile/tablet dropdown) ──────────────────────────
  const docsToggle = $('docs-toggle'), docsList = $('docs-side-list');
  if (docsToggle && docsList) {
    const closeDocsMenu = () => { docsList.classList.remove('open'); docsToggle.setAttribute('aria-expanded', 'false'); };
    docsToggle.addEventListener('click', () => {
      const open = docsList.classList.toggle('open');
      docsToggle.setAttribute('aria-expanded', String(open));
    });
    docsList.querySelectorAll('a').forEach(a => a.addEventListener('click', closeDocsMenu));
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
