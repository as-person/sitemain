/* Winter snow for somov.org, loaded by site.js only in the season or for the owner's preview (_src/data/snow.json).
   Written for this site after the idea of Snowhush's Snow mode (no code of it is used):
   - small soft flakes of different size and speed (near ones bigger and faster), slowly swaying in a breeze;
   - snow piles up along the bottom of the screen and slumps into a natural slope;
   - a thin layer settles on the tops of the large cards and moves with them when the page scrolls;
   - the pointer ploughs through the snow and throws it up, and its movement blows the falling flakes near it
     like a light puff of air.
   Falling snow is a background layer (behind every block), the piles and thrown snow a layer in front; both
   let every click through; paused while the tab is hidden.
   Kept cheap: a pile is drawn into its own small picture only when it changes (most frames just stamp it),
   the slope is worked out only after snow fell or was ploughed, the cards are measured on scroll and resize
   (and twice a second), and the canvas is drawn at no more than 1.5x the screen's pixels. */
(function () {
  'use strict';
  if (window.somovSnow) return;

  // Two layers: falling snow is the page's background (behind every block: cards, lists, the footer cover it),
  // the piles and the snow thrown by the pointer are in front, so they are seen
  const layer = name => {
    const c = document.createElement('canvas');
    c.className = 'snow ' + name;
    c.setAttribute('aria-hidden', 'true');
    document.body.append(c);
    return c;
  };
  const backCanvas = layer('snow-back'), canvas = layer('snow-front');
  // The snow on the cards is not drawn on a screen layer: each card gets its own little picture placed in the page,
  // so when the page scrolls (on phones the browser moves it without asking any script) the snow moves with the
  // card in the same frame and never comes off it
  const cardLayer = document.createElement('div');
  cardLayer.className = 'snow-cards';
  cardLayer.setAttribute('aria-hidden', 'true');
  document.body.append(cardLayer);
  const back = backCanvas.getContext('2d'), ctx = canvas.getContext('2d');

  const COL = 3;                                  // width of one column of a snow pile, px
  // Blocks snow settles on: every card-like block with its own background on the site's pages
  const SURFACES = '.composer, .more-card, .tg-card, .panel, .tweak-card, .rows, .support-card, .shot';
  let W = 0, H = 0, dpr = 1, phone = false;
  let flakes = [], ground = null, surfaces = [];
  let running = true, last = 0, frame = 0, breeze = 0, target = 0;
  const pointer = { x: -1, y: -1, px: -1, active: false };

  /* A pile: heights of its columns, and its own small picture redrawn only when they change */
  function pile(count, max, taper, old) {
    const p = { cols: new Float32Array(count), caps: new Float32Array(count), max, taper, settling: 0, dirty: true,
      painted: -99, cache: document.createElement('canvas') };
    // A full pile is not a ruler-straight line: each column has its own ceiling, gentle waves of two lengths
    // (fixed for a pile of this width, so that the snow brought back from the last page fits the same waves)
    const a = count * 0.37, b = count * 1.91;
    for (let i = 0; i < count; i++) {
      const x = i * COL;
      p.caps[i] = taper   // on a card: shorter, more noticeable bumps; the bottom drift: low gentle swells
        ? max * (0.6 + 0.22 * Math.sin(x / 38 + a) + 0.18 * Math.sin(x / 14 + b))
        : max * (0.7 + 0.18 * Math.sin(x / 80 + a) + 0.12 * Math.sin(x / 30 + b));
    }
    if (old) for (let i = 0; i < count; i++) p.cols[i] = Math.min(p.caps[i], old.cols[Math.min(i, old.cols.length - 1)] || 0);
    p.cache.width = Math.ceil((count * COL + COL) * dpr);
    p.cache.height = Math.ceil((max + 4) * dpr);
    p.cctx = p.cache.getContext('2d');
    return p;
  }

  function measure() {
    const page = document.body.getBoundingClientRect();
    for (const s of surfaces) {
      const r = s.rect = s.el.getBoundingClientRect();
      if (s.sticky) continue;                     // drawn on the screen layer where it is (see draw)
      // the card's picture where the card is in the page (not on the screen): set only when it changed
      const x = Math.round(r.left - page.left + s.inset), y = Math.round(r.top - page.top - s.pile.max - 4 + 0.5);
      if (s.x !== x || s.y !== y) {
        s.x = x; s.y = y;
        s.pile.cache.style.transform = `translate(${x}px, ${y}px)`;
      }
    }
  }

  function resize() {
    dpr = 1;   // soft blurred dots look the same at the plain resolution: far fewer pixels on sharp screens
    W = window.innerWidth;
    H = window.innerHeight;
    phone = W < 720;
    for (const [c, g] of [[canvas, ctx], [backCanvas, back]]) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    sprites.clear();
    for (const f of flakes) f.px = 0;
    const first = !ground;
    if (ground) ground.cache.remove();
    ground = pile(Math.ceil(W / COL) + 1, phone ? 8 : 12, false, ground);
    if (first) restore(ground, saved.ground);   // the drift from the previous page
    // The drift is its own element held at the bottom of the screen by the browser (CSS bottom: 0): when a phone's
    // address bar hides or shows while scrolling, it stays on the bottom edge instead of hanging in the air
    ground.cache.className = 'snow-ground';
    ground.cache.setAttribute('aria-hidden', 'true');
    ground.cache.style.width = ground.cache.width / dpr + 'px';
    ground.cache.style.height = ground.cache.height / dpr + 'px';
    document.body.append(ground.cache);
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
      vx: 0,                                    // a puff from the pointer, sideways and down/up (calms down)
      gy: 0,
      sway: Math.random() * Math.PI * 2,
      swaySpeed: 0.004 + Math.random() * 0.007,
      swayWide: 0.15 + Math.random() * 0.35,
      alpha: 0.42 + z * 0.16,                   // about 50% opaque: soft, not bright
      spray: false,
      px: 0,
      carry: 0,                                 // thrown snow: how much of the pile it took along (0: a new flake)
    };
  }

  function findSurfaces() {
    const keep = new Map(surfaces.map(s => [s.el, s]));
    surfaces = [...document.querySelectorAll(SURFACES)].filter(el => el.getBoundingClientRect().width > 120).map((el, index) => {
      const width = el.getBoundingClientRect().width;
      // only the straight part of the top edge: on a rounded corner snow would hang in the air
      const inset = Math.ceil(parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0);
      const count = Math.max(1, Math.ceil((width - 2 * inset) / COL));
      const was = keep.get(el);
      const key = location.pathname + '#' + index;
      let p = was && was.pile.cols.length === count ? was.pile : null;
      // a block that sticks on the screen while the page scrolls (the download panel on a computer): its snow is
      // drawn on the screen layer, where the block is, not placed in the page
      let sticky = false;
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        if (getComputedStyle(n).position === 'sticky') { sticky = true; break; }
      }
      if (!p) {
        p = pile(count, phone ? 7 : 10, true);
        restore(p, saved.cards[key]);
        p.cache.style.width = p.cache.width / dpr + 'px';
        p.cache.style.height = p.cache.height / dpr + 'px';
        if (!sticky) cardLayer.append(p.cache);
      }
      return { el, inset, rect: null, key, pile: p, sticky };
    });
    const now = new Set(surfaces.map(s => s.pile.cache));   // cards gone from the page take their snow along
    for (const c of [...cardLayer.children]) if (!now.has(c)) c.remove();
    measure();
  }

  /* The snow is remembered while the tab is open (sessionStorage): the bottom drift goes with the visitor from page
     to page, the snow on the cards stays on each page for when they come back. Heights are kept in halves of px. */
  const saved = (() => {
    try { return JSON.parse(sessionStorage.getItem('snowPiles')) || { ground: null, cards: {} }; }
    catch (e) { return { ground: null, cards: {} }; }
  })();
  saved.cards = saved.cards || {};
  const pack = p => Array.from(p.cols, h => Math.round(h * 2)).join(',');
  function restore(p, text) {
    if (!text) return;
    const values = text.split(',').map(Number);
    if (!values.length) return;
    for (let i = 0; i < p.cols.length; i++) {   // the window may be of another width now: stretch to fit
      p.cols[i] = Math.min(p.caps[i], (values[Math.floor(i * values.length / p.cols.length)] || 0) / 2);
    }
    p.dirty = true;
  }
  function save() {
    try {
      saved.ground = pack(ground);
      for (const s of surfaces) saved.cards[s.key] = pack(s.pile);
      sessionStorage.setItem('snowPiles', JSON.stringify(saved));
    } catch (e) {}
  }

  // A pile slumps: where a column stands higher than its neighbour by more than the slope, some of it slides down.
  // Only for a while after the pile changed: a still pile costs nothing.
  // How much snow may creep from one column to the next at a time: a trench made by the pointer fills in over
  // minutes (mostly with what falls into it), not in a few seconds as if the drift were drawn again
  const CREEP = 0.006;
  function slump(p, slope) {
    if (p.settling <= 0 || frame % 4) return;     // every 4th frame is plenty for snow sliding down
    p.settling--;
    const cols = p.cols;
    let moved = false;
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < cols.length - 1; i++) {
        const d = cols[i] - cols[i + 1];
        if (d > slope) { const m = Math.min(CREEP, (d - slope) * 0.15); cols[i] -= m; cols[i + 1] += m; moved = true; }
        else if (-d > slope) { const m = Math.min(CREEP, (-d - slope) * 0.15); cols[i + 1] -= m; cols[i] += m; moved = true; }
      }
    }
    if (moved) p.dirty = true; else p.settling = 0;
  }

  // A flake spreads softly over seven columns (sums to 0.8); on the bottom drift over seventeen, so that it grows
  // as a smooth bank, not in sharp spikes
  const bell = n => { const w = Array.from({ length: n }, (_, k) => Math.exp(-(((k - (n - 1) / 2) / (n / 4)) ** 2))), t = w.reduce((a, b) => a + b);
    return w.map(v => v * 0.8 / t); };
  const SPREAD = [0.05, 0.1, 0.15, 0.2, 0.15, 0.1, 0.05], WIDE = bell(17);
  function settle(p, i, amount) {
    const cols = p.cols;
    if (i < 0 || i >= cols.length || cols[i] >= p.caps[i]) return false;
    const spread = p.taper ? SPREAD : WIDE, half = (spread.length - 1) / 2;
    for (let k = 0; k < spread.length; k++) {
      const j = i + k - half;
      if (j >= 0 && j < cols.length) cols[j] = Math.min(p.caps[j], cols[j] + amount * spread[k]);
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
        f.carry = 0.6;                            // what it took (most of it turns to powder on the way)
        flakes.push(f);
      }
    }
  }

  function step(dt) {
    frame++;
    if (frame % 30 === 0) measure();             // cards that moved without a scroll (the page changed)
    for (const s of surfaces) if (s.sticky) s.rect = s.el.getBoundingClientRect();
    breeze += ((Math.sin(frame / 700) * 0.45 + Math.sin(frame / 211) * 0.15) - breeze) * 0.01;
    // A puff of air from the moving pointer: how far it went since the last frame (a still pointer blows nothing)
    let gustX = 0, gustY = 0, gust = false;
    if (pointer.active && pointer.gx !== undefined) {
      gustX = Math.max(-40, Math.min(40, pointer.x - pointer.gx));
      gustY = Math.max(-40, Math.min(40, pointer.y - pointer.gy));
      gust = Math.abs(gustX) + Math.abs(gustY) > 0.5;
    }
    pointer.gx = pointer.x;
    pointer.gy = pointer.y;
    const reach = phone ? 80 : 110, reach2 = reach * reach;
    for (let n = flakes.length - 1; n >= 0; n--) {
      const f = flakes[n];
      const oldY = f.y;
      if (f.spray) {                              // thrown snow: flies up, then falls like any flake
        f.vy += 0.09 * dt;
        f.vx *= 0.98;
        f.x += f.vx * dt;
        f.y += f.vy * dt;
        if (f.vy > 0.6) { f.spray = false; f.vx = 0; f.gy = 0; }
      } else {
        // the puff: along the pointer's way and a little away from it, stronger close by, then it calms down
        if (gust) {
          const dx = f.x - pointer.x, dy = f.y - pointer.y, d2 = dx * dx + dy * dy;
          if (d2 < reach2) {
            const d = Math.sqrt(d2) || 1, k = (1 - d / reach) * (1 - d / reach);
            const speed = Math.abs(gustX) + Math.abs(gustY);
            f.vx += (gustX * 0.05 + dx / d * speed * 0.012) * k;
            f.gy += (gustY * 0.035 + dy / d * speed * 0.008) * k;
          }
        }
        const calm = Math.pow(0.94, dt);
        f.vx *= calm;
        f.gy *= calm;
        f.sway += f.swaySpeed * dt;
        f.x += (Math.sin(f.sway) * f.swayWide + breeze * (0.4 + f.z) + f.vx) * dt;
        f.y += (f.vy + f.gy) * dt;
      }
      if (f.x < -10) f.x += W + 20; else if (f.x > W + 10) f.x -= W + 20;
      let landed = false;
      const falling = !f.spray && f.vy > 0;
      for (const s of surfaces) {
        const r = s.rect;
        if (f.x <= r.left || f.x >= r.right || f.y < r.top - s.pile.max - 2 || f.y >= r.bottom) continue;
        if (f.y > r.top) {                         // behind the card: hidden by it, falls on
          if (falling && oldY <= r.top && f.x > r.left + s.inset && f.x < r.right - s.inset
              && settle(s.pile, Math.floor((f.x - r.left - s.inset) / COL), f.carry ? f.carry / 0.8 : 4.4)) { landed = true; break; }
          continue;
        }
        if (falling && f.x > r.left + s.inset && f.x < r.right - s.inset) {   // above the top: on the layer?
          const i = Math.floor((f.x - r.left - s.inset) / COL);
          if (f.y >= r.top - (s.pile.cols[i] || 0) && settle(s.pile, i, f.carry ? f.carry / 0.8 : 4.4)) { landed = true; break; }
        }
      }
      // the bottom of the screen
      if (!landed && falling) {
        const i = Math.floor(f.x / COL);
        if (f.y >= H - (ground.cols[i] || 0)) { settle(ground, i, f.carry ? f.carry / 0.8 : 5.2); landed = true; }
      }
      if (landed || f.y > H + 20) {
        if (flakes.length > target) flakes.splice(n, 1);   // thrown snow beyond the usual number: gone
        else Object.assign(f, flake(false));
      }
    }
    // snow holds a steep wall (only a nearly sheer side slides, slowly): a trench made by the pointer stays and
    // fills with what falls into it, not by the drift flowing back
    slump(ground, 5);
    for (const s of surfaces) slump(s.pile, 3.5);
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
    back.clearRect(0, 0, W, H);
    ctx.clearRect(0, 0, W, H);
    for (const f of flakes) {
      const g = f.spray ? ctx : back;             // falling snow behind the content, thrown snow in front
      g.globalAlpha = f.alpha;
      const px = f.px || (f.px = Math.max(2, Math.round(f.r * 4 * dpr)));   // a soft glowing dot, not a hard disc
      const d = px / dpr;
      g.drawImage(sprite(px), Math.round((f.x - d / 2) * dpr) / dpr, Math.round((f.y - d / 2) * dpr) / dpr, d, d);
    }
    back.globalAlpha = 1;
    // the drift and the cards' pictures live in the page: only repaint the ones whose snow changed (10 times a second)
    for (const p of [ground, ...surfaces.filter(s => !s.sticky).map(s => s.pile)]) {
      if (p.dirty && frame - p.painted >= 6) { paint(p); p.painted = frame; }
    }
    ctx.globalAlpha = 0.92;
    for (const s of surfaces) {
      const r = s.rect;
      if (s.sticky && r && r.bottom > 0 && r.top < H + 10) stamp(s.pile, r.left + s.inset, r.top + 0.5);
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
  window.addEventListener('pagehide', save);      // leaving the page: take the snow along
  setInterval(save, 5000);
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
    heights: () => Array.from(ground.cols),       // the drift's columns, for checks from the browser console
    stop() {
      running = false;
      canvas.remove();
      backCanvas.remove();
      cardLayer.remove();
      ground.cache.remove();
      delete window.somovSnow;
    },
  };
})();
