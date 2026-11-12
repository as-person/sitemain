/* Winter snow for somov.org, loaded by site.js only while the owner switched it on (node _src/snow.mjs on|off).
   Written for this site after the idea of Snowhush's Snow mode (no code of it is used):
   - flakes of different size and speed (near ones bigger and faster), each swaying in a slow breeze;
   - snow piles up along the bottom of the screen and slumps into a natural slope, never higher than MAX_GROUND;
   - a thin layer settles on the tops of the large cards and moves with them when the page scrolls;
   - the pointer ploughs through the snow and throws it up.
   One canvas over the page that lets every click through; paused while the tab is hidden. */
(function () {
  'use strict';
  if (window.somovSnow) return;

  const canvas = document.createElement('canvas');
  canvas.className = 'snow';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.append(canvas);
  const ctx = canvas.getContext('2d');

  const COL = 3;                                  // width of one column of a snow pile, px
  const SURFACES = '.composer, .more-card, .tg-card, .build-panel, .tweak-card';
  let W = 0, H = 0, dpr = 1, phone = false;
  let flakes = [], ground = new Float32Array(0), maxGround = 34;
  let surfaces = [];                              // { el, cols: Float32Array, max }
  let running = true, last = 0, frame = 0, breeze = 0, target = 0;
  const pointer = { x: -1, y: -1, px: -1, py: -1, active: false };

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    phone = W < 720;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    maxGround = phone ? 34 : 52;
    const old = ground;
    ground = new Float32Array(Math.ceil(W / COL) + 1);
    for (let i = 0; i < ground.length; i++) ground[i] = old[Math.min(i, old.length - 1)] || 0;
    target = Math.round(Math.min(phone ? 70 : 170, W * H / (phone ? 9000 : 8000)));
    while (flakes.length < target) flakes.push(flake(true));
    flakes.length = target;
    findSurfaces();
  }

  function flake(anywhere) {
    const z = Math.random();                      // 0 far .. 1 near
    return {
      x: Math.random() * W,
      y: anywhere ? Math.random() * H : -10 - Math.random() * 40,
      z,
      r: 0.55 + z * z * 1.7,
      vy: 0.35 + z * 1.05 + Math.random() * 0.25,
      vx: 0,
      sway: Math.random() * Math.PI * 2,
      swaySpeed: 0.008 + Math.random() * 0.014,
      swayWide: 0.25 + Math.random() * 0.55,
      alpha: 0.42 + z * 0.16,                   // about 50% opaque: soft, not bright
      spray: false,
    };
  }

  function findSurfaces() {
    const keep = new Map(surfaces.map(s => [s.el, s]));
    surfaces = [...document.querySelectorAll(SURFACES)].map(el => {
      const width = el.getBoundingClientRect().width;
      // only the straight part of the top edge: on a rounded corner snow would hang in the air
      const inset = Math.ceil(parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0);
      const cols = Math.max(1, Math.ceil((width - 2 * inset) / COL));
      const was = keep.get(el);
      return { el, inset, cols: was && was.cols.length === cols ? was.cols : new Float32Array(cols), max: phone ? 9 : 14, rect: null };
    }).filter(s => s.el.getBoundingClientRect().width > 120);
  }

  // A pile slumps: where a column stands higher than its neighbour by more than the slope, some of it slides down
  function slump(cols, slope) {
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < cols.length - 1; i++) {
        const d = cols[i] - cols[i + 1];
        if (d > slope) { const m = (d - slope) * 0.4; cols[i] -= m; cols[i + 1] += m; }
        else if (-d > slope) { const m = (-d - slope) * 0.4; cols[i + 1] -= m; cols[i] += m; }
      }
    }
  }

  const SPREAD = [0.05, 0.1, 0.15, 0.2, 0.15, 0.1, 0.05];   // a flake spreads softly over seven columns (sums to 0.8)
  function settle(cols, i, amount, max) {
    if (i < 0 || i >= cols.length || cols[i] >= max) return false;
    for (let k = 0; k < SPREAD.length; k++) {
      const j = i + k - 3;
      if (j >= 0 && j < cols.length) cols[j] = Math.min(max, cols[j] + amount * SPREAD[k]);
    }
    return true;
  }

  // The pointer ploughs: snow under it is taken away and thrown up as spray that falls again
  function plough(cols, i0, depth, baseY, x0) {
    const reach = phone ? 5 : 7;
    for (let k = -reach; k <= reach; k++) {
      const i = i0 + k;
      if (i < 0 || i >= cols.length) continue;
      const take = Math.min(cols[i], depth * (1 - Math.abs(k) / (reach + 1)));
      if (take <= 0.2) continue;
      cols[i] -= take;
      if (Math.random() < take / 3) {
        const f = flake(false);
        f.x = x0 + k * COL;
        f.y = baseY - cols[i] - 2;
        f.vy = -1.2 - Math.random() * 1.6;
        f.vx = (pointer.x - pointer.px) * 0.15 + (Math.random() - 0.5) * 1.6;
        f.spray = true;
        f.r = 0.6 + Math.random() * 1;
        f.alpha = 0.55;
        flakes.push(f);
      }
    }
  }

  function step(dt) {
    frame++;
    breeze += ((Math.sin(frame / 700) * 0.45 + Math.sin(frame / 211) * 0.15) - breeze) * 0.01;
    for (const s of surfaces) s.rect = s.el.getBoundingClientRect();
    const groundTop = H;
    for (let n = flakes.length - 1; n >= 0; n--) {
      const f = flakes[n];
      const oldY = f.y;
      if (f.spray) {                              // thrown snow: flies up, then falls like any flake
        f.vy += 0.09 * dt;
        f.vx *= 0.98;
        f.x += f.vx * dt;
        f.y += f.vy * dt;
        if (f.vy > 0.6) f.spray = false;
      } else {
        f.sway += f.swaySpeed * dt;
        f.x += (Math.sin(f.sway) * f.swayWide + breeze * (0.4 + f.z)) * dt;
        f.y += f.vy * dt;
      }
      if (f.x < -10) f.x += W + 20; else if (f.x > W + 10) f.x -= W + 20;
      let landed = false;
      if (!f.spray && f.vy > 0) {
        // the tops of the cards that are on the screen
        for (const s of surfaces) {
          const r = s.rect;
          if (r.bottom < 0 || r.top > H || f.x < r.left + s.inset || f.x > r.right - s.inset) continue;
          const i = Math.floor((f.x - r.left - s.inset) / COL);
          const top = r.top - (s.cols[i] || 0);
          if (oldY <= top && f.y >= top) {
            if (settle(s.cols, i, f.r * 2.4, s.max)) landed = true;
            else if (f.y > r.top + 4) landed = true;    // the layer is full: the flake melts on it
            break;
          }
        }
        // the bottom of the screen
        if (!landed) {
          const i = Math.floor(f.x / COL);
          const top = groundTop - (ground[i] || 0);
          if (f.y >= top) { settle(ground, i, f.r * 2.8, maxGround); landed = true; }
        }
      }
      // No snow over a card that snow lies on: a flake that got inside one (blown in from the side, a card
      // scrolled onto it, thrown snow) melts at once
      if (!landed) {
        for (const s of surfaces) {
          const r = s.rect;
          if (f.x > r.left && f.x < r.right && f.y > r.top && f.y < r.bottom) { landed = true; break; }
        }
      }
      if (landed || f.y > H + 20) {
        if (flakes.length > target) flakes.splice(n, 1);   // thrown snow beyond the usual number: gone
        else Object.assign(f, flake(false));
      }
    }
    slump(ground, 1.6);
    for (const s of surfaces) slump(s.cols, 1.2);
    // the pointer through the snow
    if (pointer.active) {
      const gi = Math.floor(pointer.x / COL);
      if (pointer.y > groundTop - (ground[gi] || 0) - 10) plough(ground, gi, 4, groundTop, pointer.x);
      for (const s of surfaces) {
        const r = s.rect;
        if (pointer.x < r.left + s.inset || pointer.x > r.right - s.inset) continue;
        const i = Math.floor((pointer.x - r.left - s.inset) / COL);
        if (Math.abs(pointer.y - (r.top - (s.cols[i] || 0) / 2)) < 12) plough(s.cols, i, 3, r.top, pointer.x);
      }
      pointer.px = pointer.x;
      pointer.py = pointer.y;
    }
  }

  // The top of a pile as a smooth curve through the middles of the columns, not steps
  function drawPile(cols, left, baseY, taper) {
    const n = cols.length;
    const h = i => (taper ? cols[i] * Math.min(1, (i + 1) / 6, (n - i) / 6) : cols[i]);
    ctx.beginPath();
    ctx.moveTo(left, baseY);
    ctx.lineTo(left, baseY - h(0));
    for (let i = 0; i < n - 1; i++) {
      const x = left + i * COL, y = baseY - h(i);
      ctx.quadraticCurveTo(x, y, x + COL / 2, baseY - (h(i) + h(i + 1)) / 2);
    }
    ctx.lineTo(left + (cols.length - 1) * COL, baseY);
    ctx.closePath();
    ctx.fill();
  }

  // The header stays in front of the snow: flakes are not drawn over it, so they seem to come from under its edge
  const header = document.querySelector('.topbar');

  function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#ffffff';
    const hb = header ? header.getBoundingClientRect().bottom : 0;
    for (const f of flakes) {
      if (f.y < hb) continue;
      ctx.globalAlpha = f.alpha;
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = '#eef3fa';
    drawPile(ground, 0, H);
    for (const s of surfaces) {
      const r = s.rect;
      if (!r || r.bottom < 0 || r.top > H + 10) continue;
      drawPile(s.cols, r.left + s.inset, r.top + 0.5, true);
    }
    ctx.globalAlpha = 1;
  }

  function loop(t) {
    if (!running) return;
    const dt = last ? Math.min(3, (t - last) / 16.67) : 1;   // in 60 fps frames, whatever the screen does
    last = t;
    if (!document.hidden) { step(dt); draw(); }
    requestAnimationFrame(loop);
  }

  window.addEventListener('resize', () => { clearTimeout(resize.t); resize.t = setTimeout(resize, 150); });
  window.addEventListener('pointermove', e => {
    if (!pointer.active) { pointer.px = e.clientX; pointer.py = e.clientY; }
    pointer.x = e.clientX; pointer.y = e.clientY; pointer.active = true;
  }, { passive: true });
  document.addEventListener('pointerleave', () => { pointer.active = false; });
  document.addEventListener('visibilitychange', () => { last = 0; });
  new MutationObserver(() => { clearTimeout(findSurfaces.t); findSurfaces.t = setTimeout(findSurfaces, 300); })
    .observe(document.body, { childList: true, subtree: true });

  resize();
  requestAnimationFrame(loop);

  window.somovSnow = {
    stop() {
      running = false;
      canvas.remove();
      delete window.somovSnow;
    },
  };
})();
