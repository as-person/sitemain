/* Winter snow for somov.org, loaded by site.js only in the season or for the owner's preview (_src/data/snow.json).
   Written for this site after the idea of Snowhush's Snow mode (no code of it is used):
   - small soft flakes of different size and speed (near ones bigger and faster), slowly swaying in a breeze;
   - snow piles up along the bottom of the screen and slumps into a natural slope;
   - a thin layer settles on the tops of the large cards and moves with them when the page scrolls;
   - the pointer ploughs through the snow and throws it up.
   One canvas over the page that lets every click through; paused while the tab is hidden.
   Kept cheap: a pile is drawn into its own small picture only when it changes (most frames just stamp it),
   the slope is worked out only after snow fell or was ploughed, the cards are measured on scroll and resize
   (and twice a second), and the canvas is drawn at no more than 1.5x the screen's pixels. */
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
  let flakes = [], ground = null, surfaces = [];
  let running = true, last = 0, frame = 0, breeze = 0, target = 0, headerBottom = 0;
  const pointer = { x: -1, y: -1, px: -1, active: false };
  const header = document.querySelector('.topbar');

  /* A pile: heights of its columns, and its own small picture redrawn only when they change */
  function pile(count, max, taper, old) {
    const p = { cols: new Float32Array(count), max, taper, settling: 0, dirty: true, painted: -99,
      cache: document.createElement('canvas') };
    if (old) for (let i = 0; i < count; i++) p.cols[i] = Math.min(max, old.cols[Math.min(i, old.cols.length - 1)] || 0);
    p.cache.width = Math.ceil((count * COL + COL) * dpr);
    p.cache.height = Math.ceil((max + 4) * dpr);
    p.cctx = p.cache.getContext('2d');
    return p;
  }

  function measure() {
    for (const s of surfaces) s.rect = s.el.getBoundingClientRect();
    headerBottom = header ? header.getBoundingClientRect().bottom : 0;
  }

  function resize() {
    dpr = 1;   // soft blurred dots look the same at the plain resolution: far fewer pixels on sharp screens
    W = window.innerWidth;
    H = window.innerHeight;
    phone = W < 720;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sprites.clear();
    for (const f of flakes) f.px = 0;
    ground = pile(Math.ceil(W / COL) + 1, phone ? 34 : 52, false, ground);
    target = Math.round(Math.min(phone ? 100 : 240, W * H / (phone ? 6500 : 5600)));
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
      r: 0.35 + z * z * 0.95,                   // small: the near ones about 1.3 px
      vy: 0.18 + z * 0.42 + Math.random() * 0.1,  // slow, like a windless night
      vx: 0,
      sway: Math.random() * Math.PI * 2,
      swaySpeed: 0.004 + Math.random() * 0.007,
      swayWide: 0.15 + Math.random() * 0.35,
      alpha: 0.42 + z * 0.16,                   // about 50% opaque: soft, not bright
      spray: false,
      px: 0,
    };
  }

  function findSurfaces() {
    const keep = new Map(surfaces.map(s => [s.el, s]));
    surfaces = [...document.querySelectorAll(SURFACES)].filter(el => el.getBoundingClientRect().width > 120).map(el => {
      const width = el.getBoundingClientRect().width;
      // only the straight part of the top edge: on a rounded corner snow would hang in the air
      const inset = Math.ceil(parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0);
      const count = Math.max(1, Math.ceil((width - 2 * inset) / COL));
      const was = keep.get(el);
      return { el, inset, rect: null, pile: was && was.pile.cols.length === count ? was.pile : pile(count, phone ? 9 : 14, true) };
    });
    measure();
  }

  // A pile slumps: where a column stands higher than its neighbour by more than the slope, some of it slides down.
  // Only for a while after the pile changed: a still pile costs nothing.
  function slump(p, slope) {
    if (p.settling <= 0 || frame % 4) return;     // every 4th frame is plenty for snow sliding down
    p.settling--;
    const cols = p.cols;
    let moved = false;
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < cols.length - 1; i++) {
        const d = cols[i] - cols[i + 1];
        if (d > slope) { const m = (d - slope) * 0.4; cols[i] -= m; cols[i + 1] += m; moved = true; }
        else if (-d > slope) { const m = (-d - slope) * 0.4; cols[i + 1] -= m; cols[i] += m; moved = true; }
      }
    }
    if (moved) p.dirty = true; else p.settling = 0;
  }

  const SPREAD = [0.05, 0.1, 0.15, 0.2, 0.15, 0.1, 0.05];   // a flake spreads softly over seven columns (sums to 0.8)
  function settle(p, i, amount) {
    const cols = p.cols;
    if (i < 0 || i >= cols.length || cols[i] >= p.max) return false;
    for (let k = 0; k < SPREAD.length; k++) {
      const j = i + k - 3;
      if (j >= 0 && j < cols.length) cols[j] = Math.min(p.max, cols[j] + amount * SPREAD[k]);
    }
    p.dirty = true;
    p.settling = 12;
    return true;
  }

  // The pointer ploughs: snow under it is taken away and thrown up as spray that falls again
  function plough(p, i0, depth, baseY, x0) {
    const cols = p.cols;
    const reach = phone ? 5 : 7;
    for (let k = -reach; k <= reach; k++) {
      const i = i0 + k;
      if (i < 0 || i >= cols.length) continue;
      const take = Math.min(cols[i], depth * (1 - Math.abs(k) / (reach + 1)));
      if (take <= 0.2) continue;
      cols[i] -= take;
      p.dirty = true;
      p.settling = 12;
      if (Math.random() < take / 3) {
        const f = flake(false);
        f.x = x0 + k * COL;
        f.y = baseY - cols[i] - 2;
        f.vy = -1.2 - Math.random() * 1.6;
        f.vx = (pointer.x - pointer.px) * 0.15 + (Math.random() - 0.5) * 1.6;
        f.spray = true;
        f.r = 0.6 + Math.random() * 1;
        f.px = 0;
        f.alpha = 0.55;
        flakes.push(f);
      }
    }
  }

  function step(dt) {
    frame++;
    if (frame % 30 === 0) measure();             // cards that moved without a scroll (the page changed)
    breeze += ((Math.sin(frame / 700) * 0.45 + Math.sin(frame / 211) * 0.15) - breeze) * 0.01;
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
      const falling = !f.spray && f.vy > 0;
      for (const s of surfaces) {
        const r = s.rect;
        if (f.x <= r.left || f.x >= r.right || f.y < r.top - s.pile.max - 2 || f.y >= r.bottom) continue;
        if (f.y > r.top) {                         // inside a card (blown in from the side, scrolled onto it): melts
          if (falling && oldY <= r.top && f.x > r.left + s.inset && f.x < r.right - s.inset) {
            settle(s.pile, Math.floor((f.x - r.left - s.inset) / COL), 4.4);   // or lands on its top first
          }
          landed = true;
          break;
        }
        if (falling && f.x > r.left + s.inset && f.x < r.right - s.inset) {   // above the top: on the layer?
          const i = Math.floor((f.x - r.left - s.inset) / COL);
          if (f.y >= r.top - (s.pile.cols[i] || 0) && settle(s.pile, i, 4.4)) { landed = true; break; }
        }
      }
      // the bottom of the screen
      if (!landed && falling) {
        const i = Math.floor(f.x / COL);
        if (f.y >= H - (ground.cols[i] || 0)) { settle(ground, i, 5.2); landed = true; }
      }
      if (landed || f.y > H + 20) {
        if (flakes.length > target) flakes.splice(n, 1);   // thrown snow beyond the usual number: gone
        else Object.assign(f, flake(false));
      }
    }
    slump(ground, 1.6);
    for (const s of surfaces) slump(s.pile, 1.2);
    // the pointer through the snow
    if (pointer.active) {
      const gi = Math.floor(pointer.x / COL);
      if (pointer.y > H - (ground.cols[gi] || 0) - 10) plough(ground, gi, 4, H, pointer.x);
      for (const s of surfaces) {
        const r = s.rect;
        if (pointer.x < r.left + s.inset || pointer.x > r.right - s.inset) continue;
        const i = Math.floor((pointer.x - r.left - s.inset) / COL);
        if (Math.abs(pointer.y - (r.top - (s.pile.cols[i] || 0) / 2)) < 12) plough(s.pile, i, 3, r.top, pointer.x);
      }
      pointer.px = pointer.x;
    }
  }

  // A pile into its own picture: the top as a smooth curve through the middles of the columns, not steps;
  // a layer on a card thins out towards its ends instead of ending in a cliff
  function paint(p) {
    const c = p.cctx, cols = p.cols, n = cols.length, base = p.max + 4;
    const h = i => (p.taper ? cols[i] * Math.min(1, (i + 1) / 6, (n - i) / 6) : cols[i]);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, n * COL + COL, base);
    c.fillStyle = '#eef3fa';
    c.beginPath();
    c.moveTo(0, base);
    c.lineTo(0, base - h(0));
    for (let i = 0; i < n - 1; i++) c.quadraticCurveTo(i * COL, base - h(i), i * COL + COL / 2, base - (h(i) + h(i + 1)) / 2);
    c.lineTo((n - 1) * COL, base);
    c.closePath();
    c.fill();
    p.dirty = false;
  }

  function stamp(p, left, baseY) {
    if (p.dirty && frame - p.painted >= 6) { paint(p); p.painted = frame; }   // at most 10 times a second
    const w = p.cache.width / dpr, h = p.cache.height / dpr;
    ctx.drawImage(p.cache, left, baseY - h, w, h);
  }

  // Soft flakes, drawn once per size in device pixels and then only copied: a bright middle fading into nothing.
  // Copying a ready picture of the right size is far cheaper than shrinking one big picture for every flake.
  const sprites = new Map();
  function sprite(px) {
    let c = sprites.get(px);
    if (!c) {
      c = document.createElement('canvas');
      c.width = c.height = px;
      const g = c.getContext('2d');
      const half = px / 2;
      const glow = g.createRadialGradient(half, half, 0, half, half, half);
      glow.addColorStop(0, 'rgba(255,255,255,1)');
      glow.addColorStop(0.32, 'rgba(255,255,255,.9)');
      glow.addColorStop(0.6, 'rgba(255,255,255,.28)');
      glow.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = glow;
      g.fillRect(0, 0, px, px);
      sprites.set(px, c);
    }
    return c;
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    // the header stays in front of the snow: flakes are not drawn over it, they seem to come from under its edge
    for (const f of flakes) {
      if (f.y < headerBottom) continue;
      ctx.globalAlpha = f.alpha;
      const px = f.px || (f.px = Math.max(2, Math.round(f.r * 4 * dpr)));   // a soft glowing dot, not a hard disc
      const d = px / dpr;
      ctx.drawImage(sprite(px), Math.round((f.x - d / 2) * dpr) / dpr, Math.round((f.y - d / 2) * dpr) / dpr, d, d);
    }
    ctx.globalAlpha = 0.92;
    stamp(ground, 0, H);
    for (const s of surfaces) {
      const r = s.rect;
      if (!r || r.bottom < 0 || r.top > H + 10) continue;
      stamp(s.pile, r.left + s.inset, r.top + 0.5);
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
  window.addEventListener('scroll', measure, { passive: true });
  window.addEventListener('pointermove', e => {
    if (!pointer.active) pointer.px = e.clientX;
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
