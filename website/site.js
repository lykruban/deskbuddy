/* ============================================================================
   DeskBuddy — site behaviour (everything that isn't the 3D hero).
   Gallery from the CONFIG media manifest, waitlist → live API, download
   wiring + OS detect, scroll reveals, taskbar clocks, announcement toast.
   ============================================================================ */
(function () {
  'use strict';
  const CFG = window.DESKBUDDY_CONFIG;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /* ------------------------------------------------------- scroll reveals */
  const reveals = $$('.reveal');
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
      });
    }, { threshold: 0.12 });
    reveals.forEach((el) => io.observe(el));
    // belt-and-braces: anchor jumps / quirky engines can slip past IO
    const syncReveal = () => reveals.forEach((el) => {
      if (!el.classList.contains('in') &&
          el.getBoundingClientRect().top < window.innerHeight * 0.96) {
        el.classList.add('in');
      }
    });
    syncReveal();
    window.addEventListener('scroll', syncReveal, { passive: true });
  } else {
    reveals.forEach((el) => el.classList.add('in'));
  }

  /* ------------------------------------------------------------- gallery */
  const strip = $('#gallery-strip');
  if (strip) {
    CFG.MEDIA.forEach((m) => {
      const card = document.createElement('figure');
      card.className = 'gallery-card reveal';
      card.style.margin = '0';

      const media = document.createElement('div');
      media.className = 'gallery-media';
      media.style.aspectRatio = m.aspect;

      if (m.src && m.type === 'video') {
        const v = document.createElement('video');
        v.src = m.src;
        v.muted = true; v.loop = true; v.autoplay = true; v.playsInline = true;
        v.setAttribute('aria-label', m.title);
        v.preload = 'metadata';
        media.appendChild(v);
      } else if (m.src) {
        const img = document.createElement('img');
        img.src = m.src;
        img.alt = m.title + ' — ' + m.caption;
        img.loading = 'lazy';
        media.appendChild(img);
      } else {
        const ph = document.createElement('div');
        ph.className = 'media-placeholder';
        ph.innerHTML =
          '<span class="ph-paw" aria-hidden="true">🐾</span>' +
          '<span class="ph-slot">' + m.title + ' — capture coming</span>' +
          '<span class="ph-ideal">slot: ' + m.id + ' · ' + (m.ideal || m.aspect) + '</span>';
        media.appendChild(ph);
      }

      const cap = document.createElement('figcaption');
      cap.className = 'gallery-caption';
      cap.innerHTML = '<h3>' + m.title + '</h3><p>' + m.caption + '</p>';

      card.appendChild(media);
      card.appendChild(cap);
      strip.appendChild(card);
      card.classList.add('in'); // strip items reveal immediately (horizontal scroll)
    });

    const scrollByCard = (dir) => {
      const card = strip.firstElementChild;
      const w = card ? card.getBoundingClientRect().width + 20 : 400;
      strip.scrollBy({ left: dir * w, behavior: 'smooth' });
    };
    const prev = $('#gallery-prev'), next = $('#gallery-next');
    if (prev) prev.addEventListener('click', () => scrollByCard(-1));
    if (next) next.addEventListener('click', () => scrollByCard(1));
  }

  /* ------------------------------------------------------------ download */
  const hasInstaller = !!(CFG.DOWNLOAD_URL && CFG.DOWNLOAD_URL !== 'INSTALLER_URL');
  $$('.js-download').forEach((btn) => {
    if (hasInstaller) {
      btn.href = CFG.DOWNLOAD_URL;
      btn.removeAttribute('aria-disabled');
    } else {
      btn.href = '#marketplace';
      btn.setAttribute('aria-disabled', 'true');
      const label = btn.querySelector('.js-dl-label');
      if (label) label.textContent = 'Almost ready — join the waitlist';
    }
  });
  const portable = $('#dl-portable');
  if (portable) {
    if (CFG.PORTABLE_URL) portable.href = CFG.PORTABLE_URL;
    else portable.parentElement.style.display = 'none';
  }
  $$('.js-version').forEach((el) => { el.textContent = 'v' + CFG.VERSION; });
  $$('.js-size').forEach((el) => { el.textContent = CFG.FILE_SIZE; });

  // OS detect: nudge non-Windows visitors gently
  const ua = navigator.userAgent;
  if (!/Windows/i.test(ua)) {
    const note = $('#os-note');
    if (note) {
      const os = /Mac/i.test(ua) ? 'macOS' : /Linux|X11/i.test(ua) ? 'Linux' : 'your OS';
      note.textContent = 'Looks like you’re on ' + os + ' — DeskBuddy is Windows-only for now. ' +
        'macOS & Linux are on the roadmap; the waitlist hears about it first.';
      note.style.display = 'block';
    }
  }

  /* ------------------------------------------------------------ waitlist */
  $$('.waitlist-form').forEach((form) => {
    const input = form.querySelector('input[type="email"]');
    const msg = form.parentElement.querySelector('.waitlist-msg');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = (input.value || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        msg.textContent = 'That email looks a little imaginary. Try again?';
        msg.className = 'waitlist-msg err';
        return;
      }
      const btn = form.querySelector('button');
      const old = btn.textContent;
      btn.textContent = 'Sending…';
      btn.disabled = true;
      try {
        const res = await fetch(CFG.API_BASE + '/api/waitlist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok !== false) {
          msg.textContent = '🐾 You’re in. We only write when something actually ships.';
          msg.className = 'waitlist-msg ok';
          input.value = '';
        } else {
          throw new Error(data.error || 'server said no');
        }
      } catch (err) {
        msg.textContent = 'Hmm, that didn’t go through. Give it another shot in a minute.';
        msg.className = 'waitlist-msg err';
      } finally {
        btn.textContent = old;
        btn.disabled = false;
      }
    });
  });

  /* ------------------------------------------- little OS details in hero */
  const clocks = $$('.tb-clock');
  const tickClock = () => {
    const now = new Date();
    const s = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    clocks.forEach((c) => { c.textContent = s; });
  };
  if (clocks.length) { tickClock(); setInterval(tickClock, 20000); }

  // latest dev announcement → toast in monitor 1 (fails silently)
  const toast = $('#hero-toast');
  if (toast) {
    fetch(CFG.API_BASE + '/api/announcements')
      .then((r) => r.ok ? r.json() : null)
      .then((list) => {
        const items = Array.isArray(list) ? list : (list && list.items);
        if (!items || !items.length) return;
        const latest = items[items.length - 1];
        if (!latest || !latest.title) return;
        toast.innerHTML = '<b>🔔 ' + escapeHtml(latest.title) + '</b>' +
          escapeHtml((latest.body || '').slice(0, 90));
        setTimeout(() => toast.classList.add('show'), 2200);
        setTimeout(() => toast.classList.remove('show'), 12000);
      })
      .catch(() => {});
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  /* --------------------------------------------------------------- misc */
  const yr = $('#year');
  if (yr) yr.textContent = new Date().getFullYear();
})();
