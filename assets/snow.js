/* Winter snow for somov.org, loaded by site.js only in the season or for the owner's preview (_src/data/snow.json).
   Written for this site after the idea of Snowhush's Snow mode (no code of it is used):
   - small soft flakes of different size and speed (near ones bigger and faster) drifting down calmly, like snow on a
     windless night: each sways slowly from side to side, lingers for a moment at the end of a swing and glides on,
     the near ones softly brightening and dimming as they turn; a slow breeze;
   - snow piles up along the bottom of the screen and slumps into a natural slope;
   - a thin layer settles on the tops of the large cards and moves with them when the page scrolls;
   - the pointer ploughs through the snow: it pushes it aside into little banks, throws up clumps that fly in an
     arc and drop back onto the snow, with a puff of powder; its movement blows the falling flakes near it.
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
  // Words snow lies on: the "© somov.org" standing on its own in the footer's corner, a thinner layer right on the letters
  const WORDS = '.footer-copy';
  const measurer = document.createElement('canvas').getContext('2d');
  let W = 0, H = 0, dpr = 1, phone = false;
  let flakes = [], bits = [], ground = null, surfaces = [];
  let running = true, last = 0, frame = 0, breeze = 0, target = 0;
  const pointer = { x: -1, y: -1, px: -1, active: false };

  /* A pile: heights of its columns, and its own small picture redrawn only when they change */
  // |v| with the sharp point at 0 rounded off: humps that meet in smooth dips (0 .. 1)
  const hump = v => (Math.sqrt(v * v + 0.09) - 0.3) / (Math.sqrt(1.09) - 0.3);
  function pile(count, max, taper, old) {
    const p = { cols: new Float32Array(count), caps: new Float32Array(count), max, taper, settling: 0, dirty: true,
      painted: -99, cache: document.createElement('canvas') };
    // A full pile is not a ruler-straight line: each column has its own ceiling, gentle waves of two lengths
    // (fixed for a pile of this width, so that the snow brought back from the last page fits the same waves)
    const a = count * 0.37, b = count * 1.91;
    for (let i = 0; i < count; i++) {
      const x = i * COL;
      p.caps[i] = taper   // on a card: shorter, more noticeable bumps
        ? max * (0.6 + 0.22 * Math.sin(x / 38 + a) + 0.18 * Math.sin(x / 14 + b))
        // the bottom drift: a row of rounded humps of uneven width that meet in soft dips, on a slow swell
        : max * (0.5 + 0.08 * Math.sin(x / 200 + a) + 0.42 * hump(Math.sin(x / 36 + 0.8 * Math.sin(x / 90 + b) + a)));
    }
    p.waves = p.caps.slice();
    if (old) for (let i = 0; i < count; i++) p.cols[i] = Math.min(p.caps[i], old.cols[Math.min(i, old.cols.length - 1)] || 0);
    p.cache.width = Math.ceil((count * COL + COL) * dpr);
    p.cache.height = Math.ceil((max + 4) * dpr);
    p.cctx = p.cache.getContext('2d');
    return p;
  }

  // Where snow lies on a surface: the top edge of a block; on a word, on its letters (the box of a line of text
  // starts well above them)
  function boxOf(s) {
    const r = s.el.getBoundingClientRect();
    if (!s.word) return r;
    const cs = getComputedStyle(s.el);
    measurer.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    // the letters only: a sign like © has no snow on it (it stands apart) and must not lift the layer over the rest
    const letters = s.el.textContent.replace(/[^\p{L}\p{N}]/gu, '') || 'о';
    const m = measurer.measureText(letters), small = measurer.measureText('о').actualBoundingBoxAscent;
    const size = parseFloat(cs.fontSize) || 14;
    // between the tops of the tall letters and of the small ones, nearer the small: the snow touches the word (no gap
    // of air over the small letters) and only nips the tops of the capitals
    const tall = m.actualBoundingBoxAscent, rest = tall - (tall - small) * 0.65;
    // (phones draw the letters a hair lower than the canvas measures them: a pixel more, or a thin gap of air shows)
    const drop = (m.fontBoundingBoxAscent ? m.fontBoundingBoxAscent - rest : size * 0.4) + (phone ? 1 : 0);
    return { left: r.left, right: r.right, width: r.width, top: r.top + drop, bottom: r.bottom };
  }

  // No snow over the space between words ("Поддержать проект"): there the ceiling is 0, and towards it the layer
  // thins out over a few columns, as at the ends of the word
  function cutGaps(s) {
    const p = s.pile, text = s.el.textContent;
    p.caps.set(p.waves);
    if (!text.includes(' ')) return;
    const cs = getComputedStyle(s.el);
    measurer.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const scale = s.el.getBoundingClientRect().width / (measurer.measureText(text).width || 1);
    const gaps = [];
    for (let k = text.indexOf(' '); k >= 0; k = text.indexOf(' ', k + 1)) {
      gaps.push([measurer.measureText(text.slice(0, k)).width * scale - 1, measurer.measureText(text.slice(0, k + 1)).width * scale + 1]);
    }
    for (let i = 0; i < p.caps.length; i++) {
      const x = i * COL + COL / 2;
      let near = Infinity;
      for (const [a, b] of gaps) near = Math.min(near, x >= a && x <= b ? 0 : Math.min(Math.abs(x - a), Math.abs(x - b)));
      p.caps[i] *= Math.min(1, near / (6 * COL));
      if (p.cols[i] > p.caps[i]) { p.cols[i] = p.caps[i]; p.dirty = true; }
    }
  }

  function measure() {
    const page = document.body.getBoundingClientRect();
    for (const s of surfaces) {
      const r = s.rect = boxOf(s);
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
    // only the first page of the tab: on the next ones the snow is already falling, like the drift already lying
    let dropIn = false;
    if (first) {
      try { dropIn = !sessionStorage.getItem('snowFell'); sessionStorage.setItem('snowFell', '1'); } catch (e) {}
    }
    while (flakes.length < target) {
      const f = flake(true);
      // On the tab's first page the snow does not pop up all over the screen: each flake starts above its place and drops
      // into it quickly, slowing down to the usual pace, so the snowfall comes in from the top
      if (dropIn) { f.intro = H * (0.3 + Math.random() * 0.5); f.y -= f.intro; }
      flakes.push(f);
    }
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
      vy: 0.15 + z * 0.34 + Math.random() * 0.08,  // slow, like a windless night
      vx: 0,                                    // a puff from the pointer, sideways and down/up (calms down)
      gy: 0,
      sway: Math.random() * Math.PI * 2,         // a slow drift to one side and back
      swaySpeed: 0.004 + Math.random() * 0.007,
      swayWide: 0.08 + Math.random() * 0.17,
      flutter: Math.random() * Math.PI * 2,      // the unhurried swing of a falling flake (7 to 13 s), wider near by
      flutterSpeed: 0.008 + Math.random() * 0.007,
      flutterWide: (0.18 + Math.random() * 0.22) * (0.6 + z * 0.7),
      alpha: 0.42 + z * 0.16,                   // about 50% opaque: soft, not bright
      px: 0,
      intro: 0,                                 // on page load: how far it still drops faster than usual
    };
  }

  function findSurfaces() {
    const keep = new Map(surfaces.map(s => [s.el, s]));
    const blocks = [...document.querySelectorAll(SURFACES)].filter(el => el.getBoundingClientRect().width > 120);
    const words = [...document.querySelectorAll(WORDS)].filter(el => el.getBoundingClientRect().width > 20);   // the shown language
    surfaces = [...blocks, ...words].map((el, index) => {
      const word = index >= blocks.length;
      const width = el.getBoundingClientRect().width;
      // only the straight part of the top edge: on a rounded corner snow would hang in the air
      // (and 2 px more, whatever the screen's scaling rounds), the layer a whole number of columns, in the middle
      let inset = 0, count = Math.max(1, Math.ceil(width / COL));
      if (!word) {
        const edge = Math.ceil(parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0) + 2;
        count = Math.max(1, Math.floor((width - 2 * edge) / COL));
        inset = edge + (width - 2 * edge - count * COL) / 2;
      }
      const was = keep.get(el);
      // the footer's words are the same on every page: their snow goes along from page to page, like the drift
      const key = word ? 'footer#' + (index - blocks.length) : location.pathname + '#' + index;
      let p = was && was.pile.cols.length === count ? was.pile : null;
      // a block that sticks on the screen while the page scrolls (the download panel on a computer): its snow is
      // drawn on the screen layer, where the block is, not placed in the page
      let sticky = false;
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        if (getComputedStyle(n).position === 'sticky') { sticky = true; break; }
      }
      if (!p) {
        p = pile(count, word ? (phone ? 5 : 6) : (phone ? 7 : 10), true);
        restore(p, saved.cards[key]);
        p.cache.style.width = p.cache.width / dpr + 'px';
        p.cache.style.height = p.cache.height / dpr + 'px';
        if (!sticky) cardLayer.append(p.cache);
      }
      const surface = { el, inset, rect: null, key, pile: p, sticky, word };
      if (word) cutGaps(surface);
      return surface;
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

  /* The pointer ploughs. What it takes from under itself is not lost:
     - most is pushed aside: ahead of the pointer when it moves along, to both sides when it pokes in, so a trench
       gets soft banks and the snow heaps up where the pointer stops;
     - some is thrown up as clumps that fly in an arc and drop back onto the snow as little heaps (see bits);
     - with them, a puff of powder that melts away. */
  const BANK = [0.1, 0.22, 0.3, 0.22, 0.16];      // how pushed snow lies beside the trench (sums to 1)
  function plough(p, i0, depth, baseY, x0) {
    const cols = p.cols;
    const reach = phone ? 9 : 7;                  // a finger is wider than a mouse pointer
    const move = pointer.x - pointer.px;
    const dir = Math.abs(move) > 0.5 ? Math.sign(move) : 0;
    let taken = 0;
    for (let k = -reach; k <= reach; k++) {
      const i = i0 + k;
      if (i < 0 || i >= cols.length) continue;
      const take = Math.min(cols[i], depth * (1 - Math.abs(k) / (reach + 1)));
      if (take <= 0.2) continue;
      cols[i] -= take;
      taken += take;
    }
    if (!taken) return;
    p.dirty = true;
    p.settling = 12;
    const fast = Math.min(1, Math.abs(move) / 12);   // a quick swipe throws more, a slow push mostly shoves
    const pushed = taken * (0.75 - 0.35 * fast), thrown = taken * (0.2 + 0.3 * fast);
    // the banks: in front when moving along, on both sides when pressing in
    const sides = dir ? [[dir, 1]] : [[-1, 0.5], [1, 0.5]];
    for (const [side, share] of sides) {
      for (let k = 0; k < BANK.length; k++) {
        const i = i0 + side * (reach + 1 + k);
        if (i >= 0 && i < cols.length && p.caps[i] > 0) cols[i] = Math.min(p.max, cols[i] + pushed * share * BANK[k]);
      }
    }
    // the clumps: each holds about 2.4 of snow; what does not make a whole clump waits for the next frame
    p.toss = Math.min(6, (p.toss || 0) + thrown);
    while (p.toss >= 2.4 && bits.length < (phone ? 70 : 140)) {
      p.toss -= 2.4;
      const k = Math.round((Math.random() * 2 - 1) * reach * 0.7);
      const i = Math.max(0, Math.min(cols.length - 1, i0 + k));
      bits.push({
        clump: true, x: x0 + k * COL, y: baseY - cols[i] - 1,
        vx: move * (0.25 + Math.random() * 0.25) + (Math.random() - 0.5) * 1.4,
        vy: -(1.6 + Math.random() * 2.2) - Math.min(2, Math.abs(move) * 0.08),
        r: 1.3 + Math.random() * 1.2, amount: 2.4,
        // a lump, not a perfect ball: a second smaller blob stuck to it
        ox: (Math.random() - 0.5) * 1.6, oy: (Math.random() - 0.5) * 1.6, or: 0.5 + Math.random() * 0.4,
      });
      if (Math.random() < 0.5) puff(x0 + k * COL, baseY - cols[i] - 2, move * 0.15, 1);
    }
  }

  // Powder: a few faint specks that drift up a little, spread and melt away in about half a second
  function puff(x, y, vx, count) {
    for (let n = 0; n < count && bits.length < (phone ? 110 : 220); n++) {
      bits.push({ clump: false, x: x + (Math.random() - 0.5) * 6, y: y + (Math.random() - 0.5) * 3,
        vx: vx + (Math.random() - 0.5) * 0.9, vy: -0.2 - Math.random() * 0.6, life: 1, r: 0.8 + Math.random() * 0.9, px: 0 });
    }
  }

  // A clump falls back onto the snow: a small heap where it hits (it may stand a bit above the usual top: it slumps)
  const HEAP = [0.12, 0.22, 0.32, 0.22, 0.12];
  function drop(p, i, amount) {
    const cols = p.cols;
    for (let k = 0; k < HEAP.length; k++) {
      const j = i + k - 2;
      if (j >= 0 && j < cols.length && p.caps[j] > 0) cols[j] = Math.min(p.max, cols[j] + amount * HEAP[k]);
    }
    p.dirty = true;
    p.settling = 12;
  }

  // Clumps fly with real weight (much faster than a flake falls); powder floats and fades
  function stepBits(dt) {
    for (let n = bits.length - 1; n >= 0; n--) {
      const b = bits[n];
      if (!b.clump) {
        const drag = Math.pow(0.93, dt);
        b.vx *= drag;
        b.vy = b.vy * drag + 0.006 * dt;
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.life -= dt / 32;
        if (b.life <= 0) bits.splice(n, 1);
        continue;
      }
      const oldY = b.y;
      b.vy += 0.2 * dt;
      b.vx *= Math.pow(0.99, dt);
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      let hit = null, at = 0, top = 0;
      if (b.vy > 0) {
        for (const s of surfaces) {
          const r = s.rect;
          if (!r || b.x <= r.left + s.inset || b.x >= r.right - s.inset) continue;
          const i = Math.floor((b.x - r.left - s.inset) / COL);
          const surface = r.top - (s.pile.cols[i] || 0);
          if (oldY <= surface + 1 && b.y >= surface) { hit = s.pile; at = i; top = surface; break; }
        }
        if (!hit) {
          const i = Math.floor(b.x / COL);
          const surface = H - (ground.cols[i] || 0);
          if (b.y >= surface) { hit = ground; at = i; top = surface; }
        }
      }
      if (hit) {
        drop(hit, at, b.amount);
        puff(b.x, top - 1, b.vx * 0.2, 2);
        bits.splice(n, 1);
      } else if (b.y > H + 20 || b.x < -20 || b.x > W + 20) {
        bits.splice(n, 1);
      }
    }
  }

  function step(dt) {
    frame++;
    if (frame % 30 === 0) measure();             // cards that moved without a scroll (the page changed)
    for (const s of surfaces) if (s.sticky) s.rect = boxOf(s);
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
      {
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
        f.flutter += f.flutterSpeed * dt;
        const swing = Math.sin(f.flutter);
        f.x += (swing * f.flutterWide + Math.sin(f.sway) * f.swayWide + breeze * (0.4 + f.z) + f.vx) * dt;
        // lingering a little at the ends of the swing, gliding through the middle (the same pace on the whole)
        f.y += (f.vy * (0.75 + 0.5 * swing * swing) + f.gy) * dt;
        if (f.intro) {
          const d = Math.min(f.intro, Math.min(2 + f.z, Math.max(0.3, f.intro * 0.012)) * dt);   // never faster than a soft flurry
          f.y += d;
          f.intro = f.intro - d < 0.5 ? 0 : f.intro - d;
        }
      }
      if (f.x < -10) f.x += W + 20; else if (f.x > W + 10) f.x -= W + 20;
      let landed = false;
      const falling = f.vy > 0 && !f.intro;   // dropping in on page load: passes by, lands later
      for (const s of surfaces) {
        const r = s.rect;
        if (f.x <= r.left || f.x >= r.right || f.y < r.top - s.pile.max - 2 || f.y >= r.bottom) continue;
        if (f.y > r.top) {                         // behind the card: hidden by it, falls on
          if (falling && oldY <= r.top && f.x > r.left + s.inset && f.x < r.right - s.inset
              && settle(s.pile, Math.floor((f.x - r.left - s.inset) / COL), 4.4)) { landed = true; break; }
          continue;
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
        Object.assign(f, flake(false));
      }
    }
    stepBits(dt);
    // all the snow has come in (on the tab's first page it drops in from the top): site.js may now point at the switch
    if (!api.ready && !flakes.some(f => f.intro)) {
      api.ready = true;
      window.dispatchEvent(new Event('somov-snow-ready'));
    }
    // snow holds a steep wall (only a nearly sheer side slides, slowly): a trench made by the pointer stays and
    // fills with what falls into it, not by the drift flowing back
    slump(ground, 5);
    for (const s of surfaces) slump(s.pile, 3.5);
    // the pointer through the snow
    if (pointer.active) {
      const gi = Math.floor(pointer.x / COL);
      if (pointer.y > H - (ground.cols[gi] || 0) - (phone ? 26 : 10)) plough(ground, gi, phone ? 6 : 4, H, pointer.x);
      for (const s of surfaces) {
        const r = s.rect;
        if (pointer.x < r.left + s.inset || pointer.x > r.right - s.inset) continue;
        const i = Math.floor((pointer.x - r.left - s.inset) / COL);
        if (Math.abs(pointer.y - (r.top - (s.pile.cols[i] || 0) / 2)) < (phone ? 20 : 12)) plough(s.pile, i, phone ? 5 : 3, r.top, pointer.x);
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
    for (const f of flakes) {                     // falling snow behind the content
      back.globalAlpha = f.z > 0.55 ? f.alpha * (0.86 + 0.14 * Math.cos(f.flutter)) : f.alpha;   // the near ones softly breathe
      const px = f.px || (f.px = Math.max(2, Math.round(f.r * 4 * dpr)));   // a soft glowing dot, not a hard disc
      const d = px / dpr;
      back.drawImage(sprite(px), Math.round((f.x - d / 2) * dpr) / dpr, Math.round((f.y - d / 2) * dpr) / dpr, d, d);
    }
    back.globalAlpha = 1;
    // what the pointer threw, in front: powder as soft specks, clumps as solid bits of the same snow as the piles
    if (bits.length) {
      for (const b of bits) {
        if (b.clump) continue;
        ctx.globalAlpha = 0.45 * b.life * b.life;
        const px = b.px || (b.px = Math.max(2, Math.round(b.r * 4 * dpr)));
        const d = px / dpr;
        ctx.drawImage(sprite(px), b.x - d / 2, b.y - d / 2, d, d);
      }
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = '#eef3fa';
      ctx.beginPath();
      for (const b of bits) {
        if (!b.clump) continue;
        ctx.moveTo(b.x + b.r, b.y);
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.moveTo(b.x + b.ox + b.r * b.or, b.y + b.oy);
        ctx.arc(b.x + b.ox, b.y + b.oy, b.r * b.or, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.globalAlpha = 1;
    }
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
  // A finger: once the page starts scrolling under it the browser stops sending pointer moves, so the touch itself is
  // followed (it keeps coming while scrolling); lifted, it ploughs no more
  const touch = (e, start) => {
    const t = e.touches[0];
    if (!t) return;
    if (start || !pointer.active) pointer.px = t.clientX;
    pointer.x = t.clientX; pointer.y = t.clientY; pointer.active = true;
  };
  window.addEventListener('touchstart', e => touch(e, true), { passive: true });
  window.addEventListener('touchmove', e => touch(e, false), { passive: true });
  window.addEventListener('touchend', e => { if (!e.touches.length) pointer.active = false; }, { passive: true });
  window.addEventListener('touchcancel', () => { pointer.active = false; }, { passive: true });
  document.addEventListener('visibilitychange', () => { last = 0; });
  const refind = () => { clearTimeout(findSurfaces.t); findSurfaces.t = setTimeout(findSurfaces, 300); };
  new MutationObserver(refind).observe(document.body, { childList: true, subtree: true });
  // the language switched: the footer's words are others (and of another width)
  new MutationObserver(refind).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  // the letters' height and the spaces' places are known for sure once the font is in
  if (document.fonts) document.fonts.ready.then(() => { for (const s of surfaces) if (s.word) cutGaps(s); measure(); });

  resize();
  requestAnimationFrame(loop);

  const api = window.somovSnow = {
    ready: false,
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
