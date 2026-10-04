// Film Radar front end. Plain DOM, no framework; all data is inserted with textContent.
const S = { radar: null, films: {}, dirs: {}, move: 'delta', dirIndex: [] };
const LB = 'https://letterboxd.com';

// ------------------------------------------------------------------ helpers
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v);
  for (const kid of kids.flat(Infinity)) if (kid != null) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}
const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem('radar.' + k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('radar.' + k, JSON.stringify(v));
    } catch {}
  },
};
const fmt = n => (n == null ? '–' : Number(n).toLocaleString('en'));
const compact = n => (n == null ? '–' : n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K' : String(n));
const pct = x => (x == null ? '–' : Math.round(x * 100) + '%');
function stars(r) {
  if (r == null) return '';
  const full = Math.floor(r);
  return '★'.repeat(full) + (r - full >= 0.5 ? '½' : '');
}
function ago(iso) {
  if (!iso) return '–';
  const d = (Date.now() - Date.parse(iso)) / 1000;
  if (d < 90) return 'just now';
  if (d < 3600) return Math.round(d / 60) + ' min ago';
  if (d < 86400 * 1.5) return Math.round(d / 3600) + ' h ago';
  if (d < 86400 * 45) return Math.round(d / 86400) + ' days ago';
  return new Date(iso).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' });
}
const dateShort = iso => (iso ? new Date(iso.length === 10 ? iso + 'T12:00:00Z' : iso).toLocaleDateString('en', { day: 'numeric', month: 'short' }) : '');
function posterUrl(p, size = 230) {
  if (!p) return null;
  const dims = { 70: '0-70-0-105', 150: '0-150-0-225', 230: '0-230-0-345', 500: '0-500-0-750' }[size];
  return 'https://a.ltrbxd.com/resized/' + p.replace(/0-\d+-0-\d+-crop/, dims + '-crop');
}
const film = slug => S.films[slug] || { t: slug.replace(/-/g, ' ') };
const dirName = slug => S.dirs[slug]?.name || slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const user = () => S.radar?.stats?.username || '';
const byPred = (a, b) => (film(b).pr ?? 0) - (film(a).pr ?? 0);

// ------------------------------------------------------------------ components
function Poster(slug, size = 230, cls = '') {
  const f = film(slug);
  const url = posterUrl(f.p, size);
  return h(
    'div',
    { class: 'poster ' + cls },
    url
      ? h('img', { src: url, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', onerror: e => e.target.replaceWith(h('div', { class: 'ph' }, f.t || slug)) })
      : h('div', { class: 'ph' }, f.t || slug),
  );
}

function FilmCard(slug, { note, badge } = {}) {
  const f = film(slug);
  const meta = [];
  if (f.s === 1 && f.r != null) meta.push(h('span', { class: 'stars' }, stars(f.r)));
  else if (f.s === 1) meta.push(h('span', null, 'Seen'));
  else if (f.pr != null) meta.push(h('span', { class: 'pred', title: 'Predicted rating for you' }, '≈' + f.pr.toFixed(1) + '★'));
  if (f.y) meta.push(h('span', null, f.y));
  const p = Poster(slug);
  if (badge) p.append(h('span', { class: 'badge-corner' }, badge));
  else if (f.s !== 1 && f.m != null && f.m >= 80) p.append(h('span', { class: 'badge-corner' }, 'Top ' + Math.max(1, 100 - f.m) + '%'));
  if (f.wl) p.append(h('span', { class: 'badge-corner right', title: 'On your watchlist' }, 'WL'));
  return h(
    'button',
    { class: 'film', type: 'button', onclick: () => openFilm(slug), 'aria-label': `${f.t || slug}${f.y ? ' (' + f.y + ')' : ''}` },
    p,
    h('div', { class: 'ft' }, f.t || slug),
    h('div', { class: 'fm' }, meta),
    note ? h('div', { class: 'fm' }, note) : null,
  );
}

function Shelf(title, blurb, slugs, opts = {}) {
  if (!slugs?.length) return null;
  return h(
    'section',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('div', null, h('h3', null, title), blurb ? h('p', null, blurb) : null), opts.action || null),
    h('div', { class: 'shelf' }, slugs.map(sl => FilmCard(sl, opts.card ? opts.card(sl) : {}))),
  );
}

function Move(v) {
  if (v === 'new') return h('span', { class: 'mv new', title: 'New entry' }, 'NEW');
  if (v == null || v === 0) return h('span', { class: 'mv same', title: v == null ? 'No earlier snapshot yet' : 'No change' }, '–');
  return v > 0
    ? h('span', { class: 'mv up', title: `Up ${v} place${v > 1 ? 's' : ''}` }, '▲', String(v))
    : h('span', { class: 'mv down', title: `Down ${-v} place${v < -1 ? 's' : ''}` }, '▼', String(-v));
}

function Tile(label, value, sub, meter) {
  return h(
    'div',
    { class: 'tile' },
    h('div', { class: 'label' }, label),
    h('div', { class: 'value' }, value),
    meter != null ? h('div', { class: 'meter', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(meter * 100) }, h('span', { style: { width: Math.min(100, meter * 100) + '%' } })) : null,
    sub ? h('div', { class: 'sub' }, sub) : null,
  );
}

function Chips(why) {
  if (!why?.length) return null;
  return h(
    'div',
    { class: 'chips' },
    why.map(([label, delta, kind]) => h('span', { class: 'chip ' + (delta > 0 ? 'pos' : 'neg'), title: `${kindName(kind)}: ${delta > 0 ? '+' : ''}${delta.toFixed(2)}★ versus the baseline` }, label)),
  );
}
const kindName = k => ({ d: 'Director', a: 'Actor', g: 'Genre', th: 'Theme', c: 'Country', lang: 'Language', dec: 'Decade', nb: 'Related films you rated' })[k] || 'Feature';

// ------------------------------------------------------------------ charts
// Charts are drawn at the container's real pixel width so text never scales down.
function responsive(draw) {
  const wrap = h('div', { class: 'chart' });
  let lastW = 0;
  const paint = () => {
    const w = Math.round(wrap.clientWidth);
    if (!w || Math.abs(w - lastW) < 4) return;
    lastW = w;
    wrap.replaceChildren();
    draw(wrap, w);
  };
  if ('ResizeObserver' in window) new ResizeObserver(paint).observe(wrap);
  requestAnimationFrame(paint);
  return wrap;
}
function tipLayer(wrap) {
  const tip = h('div', { class: 'tip', hidden: true });
  wrap.append(tip);
  return {
    show(x, y, strong, sub) {
      tip.replaceChildren(h('b', null, strong), sub ? h('span', null, sub) : null);
      tip.hidden = false;
      tip.style.left = x + 'px';
      tip.style.top = y + 'px';
    },
    hide() {
      tip.hidden = true;
    },
  };
}

// Vertical columns, one series. data: [{label, value, tip}]
function ColumnChart(data, opts = {}) {
  return responsive((wrap, W) => drawColumns(wrap, W, data, opts));
}
function drawColumns(wrap, W, data, { height = 180, fmtV = v => fmt(v), title } = {}) {
  const H = height, padL = 34, padB = 22, padT = 16;
  const max = Math.max(1, ...data.map(d => d.value));
  const nice = niceMax(max);
  const band = (W - padL) / data.length;
  const bw = Math.min(24, band * 0.62);
  const y = v => padT + (H - padT - padB) * (1 - v / nice);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': title || 'Column chart' });
  const ticks = [0, nice / 2, nice];
  for (const t of ticks) {
    svg.append(s('line', { class: t === 0 ? 'axis' : 'gridline', x1: padL, x2: W, y1: y(t), y2: y(t) }));
    svg.append(s('text', { x: padL - 6, y: y(t) + 4, 'text-anchor': 'end', class: 'tnum' }, fmtV(t)));
  }
  const tip = tipLayer(wrap);
  data.forEach((d, i) => {
    const cx = padL + band * i + band / 2;
    const top = y(d.value), base = y(0);
    const hgt = Math.max(0, base - top);
    const r = Math.min(4, hgt);
    const path = hgt > 0 ? `M${cx - bw / 2},${base} V${top + r} Q${cx - bw / 2},${top} ${cx - bw / 2 + r},${top} H${cx + bw / 2 - r} Q${cx + bw / 2},${top} ${cx + bw / 2},${top + r} V${base} Z` : '';
    const bar = s('path', { class: 'bar', d: path });
    const hit = s('rect', { class: 'hit', x: padL + band * i, y: padT, width: band, height: H - padT - padB, tabindex: 0, 'aria-label': `${d.label}: ${fmtV(d.value)}` });
    const on = () => {
      bar.classList.add('hover');
      const rect = svg.getBoundingClientRect();
      const sx = rect.width / W;
      tip.show(cx * sx, top * (rect.height / H), fmtV(d.value), d.tip || d.label);
    };
    const off = () => {
      bar.classList.remove('hover');
      tip.hide();
    };
    hit.addEventListener('pointerenter', on);
    hit.addEventListener('pointerleave', off);
    hit.addEventListener('focus', on);
    hit.addEventListener('blur', off);
    svg.append(bar, hit);
    svg.append(s('text', { x: cx, y: H - 6, 'text-anchor': 'middle' }, d.label));
  });
  // Label the tallest column only.
  const iMax = data.reduce((m, d, i) => (d.value > data[m].value ? i : m), 0);
  if (data.length) svg.append(s('text', { class: 'val', x: padL + band * iMax + band / 2, y: y(data[iMax].value) - 6, 'text-anchor': 'middle' }, fmtV(data[iMax].value)));
  // Thin out x labels when columns get narrow.
  if (band < 22) svg.querySelectorAll('text[y="' + (H - 6) + '"]').forEach((t, i) => i % Math.ceil(22 / band) && t.remove());
  wrap.append(svg);
}

function niceMax(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

// Horizontal diverging bars around zero. items: [{label, value, sub}]
function DivergingBars(items, opts = {}) {
  return responsive((wrap, W) => drawDiverging(wrap, W, items, opts));
}
function drawDiverging(wrap, W, items, { fmtV = v => (v > 0 ? '+' : '') + v.toFixed(2) + '★' } = {}) {
  const labelW = Math.min(170, Math.round(W * 0.34));
  const rowH = 26, H = items.length * rowH + 8;
  const max = Math.max(0.05, ...items.map(i => Math.abs(i.value)));
  const plotL = labelW + 50, plotR = W - 50;
  const zero = plotL + (plotR - plotL) / 2;
  const scale = (plotR - plotL) / 2 / max;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': 'Effect on your ratings' });
  const maxChars = Math.max(8, Math.floor(labelW / 6.6));
  const tip = tipLayer(wrap);
  items.forEach((it, i) => {
    const y = 4 + i * rowH;
    const w = Math.abs(it.value) * scale;
    const x = it.value >= 0 ? zero : zero - w;
    const bh = 14;
    const r = Math.min(4, w);
    const by = y + (rowH - bh) / 2;
    let d;
    if (it.value >= 0) d = `M${x},${by} H${x + w - r} Q${x + w},${by} ${x + w},${by + r} V${by + bh - r} Q${x + w},${by + bh} ${x + w - r},${by + bh} H${x} Z`;
    else d = `M${x + w},${by} H${x + r} Q${x},${by} ${x},${by + r} V${by + bh - r} Q${x},${by + bh} ${x + r},${by + bh} H${x + w} Z`;
    const label = it.label.length > maxChars ? it.label.slice(0, maxChars - 1) + '…' : it.label;
    svg.append(s('text', { class: 'lbl', x: labelW, y: y + rowH / 2 + 4, 'text-anchor': 'end' }, label));
    const bar = s('path', { class: 'bar' + (it.value < 0 ? ' neg' : ''), d: w > 0 ? d : '' });
    svg.append(bar);
    svg.append(s('text', { class: 'val tnum', x: it.value >= 0 ? zero + w + 5 : zero - w - 5, y: y + rowH / 2 + 4, 'text-anchor': it.value >= 0 ? 'start' : 'end' }, fmtV(it.value)));
    const hit = s('rect', { class: 'hit', x: 0, y, width: W, height: rowH, tabindex: 0, 'aria-label': `${it.label}: ${fmtV(it.value)}` });
    const on = () => {
      bar.classList.add('hover');
      const rect = svg.getBoundingClientRect();
      tip.show(zero * (rect.width / W), y * (rect.height / H), fmtV(it.value), `${it.label}${it.sub ? ' · ' + it.sub : ''}`);
    };
    const off = () => {
      bar.classList.remove('hover');
      tip.hide();
    };
    hit.addEventListener('pointerenter', on);
    hit.addEventListener('pointerleave', off);
    hit.addEventListener('focus', on);
    hit.addEventListener('blur', off);
    svg.append(hit);
  });
  svg.append(s('line', { class: 'zero', x1: zero, x2: zero, y1: 0, y2: H }));
  wrap.append(svg);
}

// Line over time with crosshair. points: [{t: Date, v}], invert for ranks.
function LineChart(points, opts = {}) {
  return responsive((wrap, W) => points.length && drawLine(wrap, W, points, opts));
}
function drawLine(wrap, W, points, { height = 200, invert = false, fmtV = v => String(v), label = 'value', domain } = {}) {
  const H = height, padL = 44, padR = 12, padT = 12, padB = 24;
  const xs = points.map(p => +p.t);
  let x0 = Math.min(...xs), x1 = Math.max(...xs);
  if (x0 === x1) {
    x0 -= 864e5;
    x1 += 864e5;
  }
  const vs = points.map(p => p.v).filter(v => v != null);
  let [lo, hi] = domain || [Math.min(...vs), Math.max(...vs)];
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const X = t => padL + ((t - x0) / (x1 - x0)) * (W - padL - padR);
  const Y = v => (invert ? padT + ((v - lo) / (hi - lo)) * (H - padT - padB) : padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB));
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': label + ' over time' });
  const ticks = [lo, (lo + hi) / 2, hi].map(v => (invert ? Math.round(v) : v));
  for (const t of ticks) {
    svg.append(s('line', { class: 'gridline', x1: padL, x2: W - padR, y1: Y(t), y2: Y(t) }));
    svg.append(s('text', { x: padL - 6, y: Y(t) + 4, 'text-anchor': 'end', class: 'tnum' }, fmtV(t)));
  }
  svg.append(s('text', { x: padL, y: H - 6 }, new Date(x0).toLocaleDateString('en', { day: 'numeric', month: 'short' })));
  svg.append(s('text', { x: W - padR, y: H - 6, 'text-anchor': 'end' }, new Date(x1).toLocaleDateString('en', { day: 'numeric', month: 'short' })));
  // Step line for ranks (a rank holds until the next change).
  let d = '';
  let prev = null;
  for (const p of points) {
    if (p.v == null) {
      prev = null;
      continue;
    }
    if (!prev) d += `M${X(+p.t)},${Y(p.v)}`;
    else d += invert ? `H${X(+p.t)}V${Y(p.v)}` : `L${X(+p.t)},${Y(p.v)}`;
    prev = p;
  }
  const last = points.filter(p => p.v != null).pop();
  if (invert && last && +last.t < Date.now()) d += `H${W - padR}`;
  svg.append(s('path', { class: 'line', d }));
  if (last) svg.append(s('circle', { class: 'dot', cx: invert ? W - padR : X(+last.t), cy: Y(last.v), r: 4 }));
  const cross = s('line', { class: 'cross', y1: padT, y2: H - padB, visibility: 'hidden' });
  svg.append(cross);
  const tip = tipLayer(wrap);
  const hit = s('rect', { x: padL, y: 0, width: W - padL - padR, height: H, fill: 'transparent' });
  hit.addEventListener('pointermove', ev => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    const t = x0 + ((px - padL) / (W - padL - padR)) * (x1 - x0);
    let best = points[0];
    for (const p of points) if (+p.t <= t) best = p;
    const cx = X(+best.t);
    cross.setAttribute('x1', cx);
    cross.setAttribute('x2', cx);
    cross.setAttribute('visibility', 'visible');
    tip.show(cx * (rect.width / W), Y(best.v ?? lo) * (rect.height / H), best.v == null ? 'Out' : fmtV(best.v), new Date(best.t).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' }));
  });
  hit.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden');
    tip.hide();
  });
  svg.append(hit);
  wrap.append(svg);
}

function Sparkline(history) {
  const pts = (history || []).filter(p => p[1] != null);
  const W = 96, H = 26;
  const svg = s('svg', { class: 'spark', viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' });
  if (!pts.length) return svg;
  const ranks = pts.map(p => p[1]);
  const lo = Math.max(1, Math.min(...ranks) - 3), hi = Math.min(100, Math.max(...ranks) + 3);
  const Y = r => 4 + ((r - lo) / Math.max(1, hi - lo)) * (H - 8);
  if (pts.length === 1) {
    svg.append(s('path', { d: `M4,${Y(ranks[0])} H${W - 6}`, opacity: 0.35 }));
    svg.append(s('circle', { cx: W - 6, cy: Y(ranks[0]), r: 3 }));
    return svg;
  }
  const t0 = Date.parse(pts[0][0]), t1 = Math.max(Date.now(), Date.parse(pts[pts.length - 1][0]) + 1);
  const X = t => 4 + ((Date.parse(t) - t0) / (t1 - t0)) * (W - 10);
  let d = `M${X(pts[0][0])},${Y(ranks[0])}`;
  for (let i = 1; i < pts.length; i++) d += `H${X(pts[i][0])}V${Y(ranks[i])}`;
  d += `H${W - 6}`;
  svg.append(s('path', { d }));
  svg.append(s('circle', { cx: W - 6, cy: Y(ranks[ranks.length - 1]), r: 3 }));
  return svg;
}

// ------------------------------------------------------------------ film modal
const dlg = () => document.getElementById('film-modal');
function openFilm(slug) {
  const f = film(slug);
  const body = h('div', { class: 'modal-body' });
  const left = h('div', null, Poster(slug, 500));
  const right = h('div', null);
  right.append(h('h2', null, f.t || slug));
  const dirs = (f.d || []).map((d, i) => [i ? ', ' : '', h('a', { href: '#/director/' + d, onclick: () => dlg().close() }, dirName(d))]);
  right.append(h('div', { class: 'ink2', style: { marginTop: '6px' } }, f.y ? String(f.y) : '', dirs.length ? [' · ', dirs] : null));
  if (f.s === 1) {
    right.append(h('p', null, h('span', { class: 'stars', style: { fontSize: '22px' } }, f.r != null ? stars(f.r) : 'Watched'), f.l ? h('span', { class: 'muted' }, '  ♥ liked') : null, f.wd ? h('span', { class: 'muted' }, '  · last logged ' + dateShort(f.wd)) : null));
    if (f.ex != null) right.append(h('p', { class: 'small muted' }, `The model expected about ${f.ex.toFixed(1)}★ from you${f.r != null ? ` (you gave ${f.r}★)` : ''}.`));
  } else if (f.pr != null) {
    right.append(
      h('p', null, h('span', { class: 'pred', style: { fontSize: '22px' } }, '≈ ' + f.pr.toFixed(1) + '★'), h('span', { class: 'muted' }, ' predicted for you'), f.m != null ? h('span', { class: 'muted' }, ` · better than ${f.m}% of films you've seen`) : null),
    );
    if (f.why?.length) right.append(h('div', { class: 'small muted', style: { margin: '8px 0 4px' } }, 'Why'), Chips(f.why));
    if (f.s === 0) right.append(h('p', { class: 'small muted' }, 'Checked against your profile: not watched yet.'));
    else right.append(h('p', { class: 'small muted' }, 'Not checked against your profile yet.'));
  }
  const kv = h('dl', { class: 'kv' });
  const add = (k, v) => v && kv.append(h('dt', null, k), h('dd', null, v));
  add('Runtime', f.rt ? `${f.rt} min` : null);
  add('Genres', f.g?.length ? f.g.map(g => g.replace(/-/g, ' ')).join(', ') : null);
  add('Country', f.c);
  add('Letterboxd', f.a != null ? `${f.a.toFixed(2)}★ from ${compact(f.n)} ratings` : f.up ? 'Not released yet' : null);
  add('Watchlist', f.wl ? 'On your watchlist' : null);
  right.append(kv);
  right.append(
    h(
      'div',
      { class: 'chips' },
      h('a', { class: 'btn primary', href: `${LB}/film/${slug}/`, target: '_blank', rel: 'noopener' }, 'Open on Letterboxd'),
      f.s === 1 ? h('a', { class: 'btn', href: `${LB}/${user()}/film/${slug}/`, target: '_blank', rel: 'noopener' }, 'Your entry') : null,
    ),
  );
  body.append(left, right);
  const d = dlg();
  d.replaceChildren(h('button', { class: 'icon-btn modal-close', type: 'button', 'aria-label': 'Close', onclick: () => d.close() }, '✕'), body);
  d.showModal();
}

// ------------------------------------------------------------------ views
function viewOverview() {
  const R = S.radar, st = R.stats, T = R.top100;
  const v = h('div', { class: 'view' });
  const pick = (R.shelves.find(x => x.id === 'top') || R.shelves[0])?.films?.[0];
  if (pick) {
    const f = film(pick);
    v.append(
      h(
        'section',
        { class: 'card hero' },
        h('button', { class: 'film', type: 'button', onclick: () => openFilm(pick), 'aria-label': f.t }, Poster(pick, 500)),
        h(
          'div',
          null,
          h('div', { class: 'kicker' }, "Tonight's best bet"),
          h('h2', null, f.t),
          h('div', { class: 'meta' }, [f.y, (f.d || []).map(dirName).join(' & '), f.rt ? f.rt + ' min' : null].filter(Boolean).join(' · ')),
          h('div', null, h('span', { class: 'pred', style: { fontSize: '20px' } }, '≈ ' + (f.pr ?? 0).toFixed(1) + '★'), h('span', { class: 'muted' }, ` predicted · better than ${f.m ?? '–'}% of what you've watched`)),
          f.why?.length ? h('div', { style: { marginTop: '10px' } }, Chips(f.why)) : null,
          h('div', { class: 'chips', style: { marginTop: '14px' } }, h('button', { class: 'btn primary', type: 'button', onclick: () => openFilm(pick) }, 'Details'), h('a', { class: 'btn', href: '#/foryou' }, 'More picks'), h('button', { class: 'btn', type: 'button', onclick: surprise }, 'Surprise me')),
        ),
      ),
    );
  }
  if (!pick) v.append(WarmingUp());
  const cov = st.coverage;
  v.append(
    h(
      'div',
      { class: 'tiles' },
      Tile('Films watched', fmt(st.watchedTotal), `${fmt(st.rated)} rated · avg ${st.avgRating ?? '–'}★`),
      Tile('History mapped', pct(cov), `${fmt(st.found)} of ${fmt(st.watchedTotal)} found by the scanner`, cov),
      T.snapshots > 1
        ? Tile('Top 100 last changed', ago(T.lastChange), `${T.snapshots - 1} change${T.snapshots > 2 ? 's' : ''} tracked since ${dateShort(T.tracking)}`)
        : Tile('Top 100 changes', 'None yet', T.tracking ? `Baseline taken ${dateShort(T.tracking)}` : 'Waiting for the first scan'),
      Tile('Taste model', R.model.trained ? '±' + R.model.mae.toFixed(2) + '★' : 'Training', R.model.trained ? `Typical error on ${fmt(R.model.n)} films you rated` : 'Needs more rated films'),
    ),
  );
  // Top 100 pulse + contenders
  const pulse = h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('div', null, h('h3', null, 'Top 100 pulse'), h('p', null, T.list?.title || '')), h('a', { href: '#/top100' }, 'Full list →')));
  const rankEv = T.events.slice(0, 8);
  if (rankEv.length) pulse.append(h('div', { class: 'feed' }, rankEv.map(EventRow)));
  else
    pulse.append(
      h('p', { class: 'note' }, `Baseline recorded ${ago(T.tracking)}. Every time you reorder, add or drop a filmmaker, the move shows up here within the hour, with how many places they moved.`),
      h('div', { class: 'feed' }, T.entries.slice(0, 5).map(e => h('div', { class: 'ev', style: { cursor: 'pointer' }, onclick: () => go(dirLink(e)) }, h('div', { class: 'rank-dot' }, '#' + e.rank), h('div', null, h('b', null, e.name), h('div', { class: 'small muted' }, e.stats ? `${e.stats.n} seen · ${e.stats.avg ?? '–'}★ avg` : '')), Move(e[S.move])))),
    );
  const cands = h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('div', null, h('h3', null, 'Next up'), h('p', null, 'Directors most likely to break into your Top 100')), h('a', { href: '#/next' }, 'All contenders →')), CandList(T.nextUp.slice(0, 5), T.cutline));
  v.append(h('div', { class: 'grid-2' }, pulse, cands));
  // recent diary
  if (R.diary.length) v.append(Shelf('Recently watched', 'From your diary feed', dedupe(R.diary.map(d => d.slug)).slice(0, 20)));
  const other = R.events.slice(0, 8);
  const statusCard = h(
    'section',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('div', null, h('h3', null, 'Scanner'), h('p', null, 'Checks your profile every 30 minutes')), h('a', { href: '#/activity' }, 'Activity →')),
    ScanStatus(),
  );
  v.append(h('div', { class: 'grid-2' }, h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, 'Latest activity')), other.length ? h('div', { class: 'feed' }, other.map(EventRow)) : h('p', { class: 'empty' }, 'New watches, ratings and watchlist changes will appear here.')), statusCard));
  return v;
}

function WarmingUp() {
  const p = S.radar.stats.lastRun?.pending || {};
  const queued = Object.entries(p).filter(([k]) => !/refresh|recheck/.test(k)).reduce((a, [, n]) => a + n, 0);
  return h(
    'section',
    { class: 'card' },
    h('div', { class: 'kicker', style: { color: 'var(--accent-ink)', fontSize: '12px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '6px' } }, 'Recommendations warming up'),
    h('h3', null, 'Picks appear after the next scan'),
    h('p', { class: 'ink2', style: { margin: '6px 0 0' } }, `The scanner is still checking which films you haven't seen and fetching their details${queued ? ` (${fmt(queued)} checks queued)` : ''}. Only films confirmed unwatched get recommended. This page refreshes itself.`),
  );
}

function dedupe(a) {
  return [...new Set(a)];
}

function ScanStatus() {
  const st = S.radar.stats;
  const lr = st.lastRun;
  const pending = lr?.pending ? Object.entries(lr.pending).filter(([k]) => !k.includes('refresh') && !k.includes('recheck')).reduce((a, [, n]) => a + n, 0) : 0;
  return h(
    'div',
    { class: 'kv' },
    h('dt', null, 'Last scan'),
    h('dd', null, ago(st.lastScan)),
    h('dt', null, 'Films in database'),
    h('dd', null, fmt(st.filmsInDb)),
    h('dt', null, 'Filmmakers'),
    h('dd', null, fmt(st.directorsInDb)),
    h('dt', null, 'Checked unseen'),
    h('dd', null, fmt(st.verifiedUnseen)),
    h('dt', null, 'Backfill'),
    h('dd', null, pending ? `${fmt(pending)} checks queued` : 'Up to date'),
  );
}

function EventRow(e) {
  const f = e.slug ? film(e.slug) : null;
  const title = e.title || f?.t || e.slug || '';
  let icon = '•', text, sub = null, click = null;
  switch (e.type) {
    case 'watch':
      icon = e.rewatch ? '↻' : '👁';
      text = [e.rewatch ? 'Rewatched ' : 'Watched ', h('b', null, title), e.rating != null ? h('span', { class: 'stars' }, ' ' + stars(e.rating)) : null, e.liked ? ' ♥' : null];
      sub = e.review || null;
      click = () => openFilm(e.slug);
      break;
    case 'rate':
      icon = '★';
      text = ['Re-rated ', h('b', null, title), ` ${stars(e.from)} → `, h('span', { class: 'stars' }, stars(e.to))];
      click = () => openFilm(e.slug);
      break;
    case 'like':
      icon = '♥';
      text = ['Liked ', h('b', null, title)];
      click = () => openFilm(e.slug);
      break;
    case 'wl+':
      icon = '+';
      text = ['Added ', h('b', null, title), ' to watchlist'];
      click = () => openFilm(e.slug);
      break;
    case 'wl-':
      icon = '−';
      text = ['Removed ', h('b', null, title), ' from watchlist'];
      break;
    case 'move':
      icon = e.to < e.from ? '▲' : '▼';
      text = [h('b', null, e.name), ` moved ${e.to < e.from ? 'up' : 'down'} ${Math.abs(e.from - e.to)} to #${e.to}`];
      sub = `was #${e.from}`;
      break;
    case 'enter':
      icon = '★';
      text = [h('b', null, e.name), ` entered your Top 100 at #${e.rank}`];
      break;
    case 'exit':
      icon = '✕';
      text = [h('b', null, e.name), ` dropped out (was #${e.from})`];
      break;
    case 'fav':
      icon = '⇄';
      text = [h('b', null, e.name), ': favourite film changed to ', h('b', null, film(e.to).t || e.to)];
      break;
    case 'soon+':
      icon = '⏳';
      text = [h('b', null, e.name), ' added to Possibly Soon'];
      break;
    case 'soon-':
      icon = '⏳';
      text = [h('b', null, e.name), ' removed from Possibly Soon'];
      break;
    case 'newfilm':
      icon = '🎬';
      text = ['New on ', h('b', null, e.name || dirName(e.director)), "'s filmography: ", h('b', null, e.title || e.slug), e.year ? ` (${e.year})` : ''];
      click = () => openFilm(e.slug);
      break;
    case 'unwatch':
      icon = '−';
      text = ['Removed ', h('b', null, title), ' from watched'];
      break;
    default:
      text = e.type;
  }
  return h('div', { class: 'ev', style: click ? { cursor: 'pointer' } : null, onclick: click }, f?.p ? Poster(e.slug, 70) : h('div', { class: 'ic', 'aria-hidden': 'true' }, icon), h('div', { style: { minWidth: 0 } }, h('div', null, text), sub ? h('div', { class: 'small muted', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, sub) : null), h('div', { class: 'when' }, ago(e.t)));
}

const dirLink = e => (e.slugs?.length ? '#/director/' + e.slugs[0] : '#/top100');

function CandList(list, cut) {
  if (!list.length) return h('p', { class: 'empty' }, 'Contenders appear once enough of your history has been mapped.');
  return h(
    'div',
    { class: 'cands' },
    list.map((c, i) =>
      h(
        'div',
        { class: 'cand', onclick: () => go('#/director/' + c.slug), role: 'link', tabindex: 0, onkeydown: e => e.key === 'Enter' && go('#/director/' + c.slug) },
        h('div', { class: 'n' }, i + 1),
        h(
          'div',
          { style: { minWidth: 0 } },
          h('div', null, h('b', null, c.name), c.flagged ? h('span', { class: 'flag', title: 'On your Possibly Soon list' }, 'POSSIBLY SOON') : null),
          h('div', { class: 'why' }, `${c.stats.n} seen · ${c.stats.avg ?? '–'}★ avg · ${c.stats.loved} loved`, c.path ? [' · next: ', h('b', null, film(c.path.film).t), c.path.crosses && !c.aboveCut ? h('span', { class: 'muted' }, ' could push them over the line') : null] : null),
        ),
        FitBar(c.prob, cut),
      ),
    ),
  );
}

function FitBar(p, cut) {
  return h(
    'div',
    { class: 'fit', title: `Top-100 fit ${pct(p)} (cut line ${pct(cut)})` },
    h('div', { class: 'pct' }, pct(p)),
    h('div', { class: 'bar' }, h('span', { style: { width: Math.round(p * 100) + '%' } }), cut != null ? h('i', { style: { left: `calc(${Math.round(cut * 100)}% - 1px)` } }) : null),
  );
}

// ---- Top 100
function viewTop100() {
  const T = S.radar.top100;
  const v = h('div', { class: 'view' });
  const q = { sort: store.get('t100sort', 'rank'), filter: '' };
  const head = h(
    'section',
    { class: 'card' },
    h(
      'div',
      { class: 'card-head' },
      h('div', null, h('h2', null, 'Your Top 100 filmmakers'), h('p', null, T.list?.title ? [h('a', { href: T.list.url, target: '_blank', rel: 'noopener' }, T.list.title), ` · last edited ${ago(T.list.updated)} · tracking since ${dateShort(T.tracking)}`] : 'No ranked filmmaker list found.')),
      h('div', { class: 'controls' }, moveToggle(() => render()), sortSelect(), h('input', { class: 'input', type: 'search', placeholder: 'Filter…', 'aria-label': 'Filter filmmakers', oninput: e => ((q.filter = e.target.value.toLowerCase()), draw()) })),
    ),
  );
  if (T.snapshots <= 1) head.append(h('p', { class: 'note' }, 'This is the baseline. From now on every reorder is captured within the hour: arrows show how many places each filmmaker moved since your last change, over 7 days, or over 30 days.'));
  const rows = h('div', { class: 'rows' });
  head.append(h('div', { class: 'rows-head' }, h('div', { style: { textAlign: 'right' } }, '#'), h('div', null, 'Move'), h('div', null), h('div', null, 'Filmmaker'), h('div', null, 'History'), h('div', { class: 'st' }, 'Your record'), h('div', { class: 'mr' }, 'Ratings say')), rows);
  function sortSelect() {
    const sel = h(
      'select',
      { class: 'input', 'aria-label': 'Sort', onchange: e => ((q.sort = e.target.value), store.set('t100sort', q.sort), draw()) },
      [
        ['rank', 'Your order'],
        ['move', 'Biggest movers'],
        ['gap', 'Ratings disagree most'],
        ['avg', 'Average rating'],
        ['seen', 'Films seen'],
        ['completion', 'Completion'],
      ].map(([k, l]) => h('option', { value: k, selected: q.sort === k }, l)),
    );
    return sel;
  }
  function draw() {
    let list = T.entries.filter(e => !q.filter || e.name.toLowerCase().includes(q.filter));
    const mv = e => (e[S.move] === 'new' ? 1000 : Math.abs(e[S.move] || 0));
    const gap = e => (e.modelRank ? Math.abs(e.rank - e.modelRank) : -1);
    const sorters = { rank: (a, b) => a.rank - b.rank, move: (a, b) => mv(b) - mv(a) || a.rank - b.rank, gap: (a, b) => gap(b) - gap(a), avg: (a, b) => (b.stats?.avg ?? 0) - (a.stats?.avg ?? 0), seen: (a, b) => (b.stats?.n ?? 0) - (a.stats?.n ?? 0), completion: (a, b) => (b.stats?.completion ?? 0) - (a.stats?.completion ?? 0) };
    list = [...list].sort(sorters[q.sort] || sorters.rank);
    rows.replaceChildren(
      ...list.map(e => {
        const st = e.stats;
        const mr = e.modelRank;
        const hint = mr == null ? '' : mr < e.rank - 8 ? `#${mr} ↑` : mr > e.rank + 8 ? `#${mr} ↓` : `#${mr}`;
        return h(
          'div',
          { class: 'row', role: 'link', tabindex: 0, onclick: () => go(dirLink(e)), onkeydown: ev => ev.key === 'Enter' && go(dirLink(e)) },
          h('div', { class: 'rk' }, e.rank),
          Move(e[S.move]),
          e.film ? Poster(e.film, 70, 'mini') : h('div'),
          h('div', { class: 'nm' }, e.name, h('small', null, e.film ? `Favourite: ${film(e.film).t || e.film}` : '')),
          Sparkline(e.history),
          h('div', { class: 'st' }, st ? [h('span', null, `${st.n} seen`), h('span', { class: 'stars' }, st.avg != null ? st.avg.toFixed(2) + '★' : ''), h('span', null, st.completion != null ? pct(st.completion) + ' complete' : ''), st.unseenCount ? h('span', { class: 'muted' }, `${st.unseenCount} to go`) : null] : h('span', { class: 'muted' }, 'Not matched yet')),
          h('div', { class: 'mr', title: 'Where your ratings alone would place them' }, hint),
        );
      }),
    );
    if (!list.length) rows.append(h('p', { class: 'empty' }, 'No matches.'));
  }
  function render() {
    draw();
  }
  draw();
  v.append(head);
  // Side analyses
  const dropped = T.dropped.length ? h('section', { class: 'card' }, h('h3', null, 'Dropped out'), h('div', { class: 'feed' }, T.dropped.map(d => h('div', { class: 'ev' }, h('div', { class: 'ic' }, '✕'), h('div', null, h('b', null, d.name), ` was #${d.lastRank}`), h('div', { class: 'when' }, ago(d.when)))))) : null;
  const log = h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, 'Movement log')), T.events.length ? h('div', { class: 'feed' }, T.events.slice(0, 40).map(EventRow)) : h('p', { class: 'empty' }, 'No moves yet. The first change you make to the list will appear here.'));
  const movers = T.movers.up.length || T.movers.down.length ? h('section', { class: 'card' }, h('h3', null, 'Biggest movers, last 30 days'), h('div', { class: 'grid-2', style: { marginTop: '10px' } }, h('div', null, T.movers.up.map(m => h('div', { class: 'li' }, h('span', { class: 'l' }, m.name), Move(m.net)))), h('div', null, T.movers.down.map(m => h('div', { class: 'li' }, h('span', { class: 'l' }, m.name), Move(m.net)))))) : null;
  v.append(h('div', { class: 'grid-2' }, log, h('div', { class: 'view' }, movers, dropped, h('section', { class: 'card' }, h('h3', null, 'How "Ratings say" works'), h('p', { class: 'small ink2' }, `A model trained on your list learns how your ratings, number of films seen, favourites and likes map to a position. It ranks each filmmaker without seeing their actual spot (cross-validated). Big gaps flag candidates to move: “#12 ↑” means your ratings argue for a higher place. Agreement with your order: ${T.rankModel ? 'Spearman ' + T.rankModel.spearman : 'n/a'}.`)))));
  return v;
}

function moveToggle(onChange) {
  const opts = [
    ['delta', 'Since last change'],
    ['d7', '7 days'],
    ['d30', '30 days'],
  ];
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Movement window' });
  for (const [k, l] of opts)
    seg.append(
      h('button', { type: 'button', 'aria-pressed': String(S.move === k), onclick: () => {
        S.move = k;
        store.set('move', k);
        seg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.textContent === l)));
        onChange();
      } }, l),
    );
  return seg;
}

// ---- Contenders
function viewNext() {
  const T = S.radar.top100;
  const v = h('div', { class: 'view' });
  const m = T.member;
  v.append(
    h(
      'section',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('div', null, h('h2', null, 'Who could be next'), h('p', null, 'Every filmmaker you have watched, scored by how closely your record with them matches the directors already in your Top 100.'))),
      h('p', { class: 'note' }, `Fit is the model's probability that a director belongs in your Top 100. The marker on each bar is the cut line (${pct(T.cutline)}), where your #86–100 currently sit. ${m ? `Trained on ${m.positives} listed vs ${fmt(m.negatives)} other directors; it separates them with ${Math.round(m.auc * 100)}% accuracy (AUC) on held-out data.` : 'The model switches on once enough of your history is mapped.'}`),
      CandList(T.nextUp.slice(0, 25), T.cutline),
    ),
  );
  const soon = T.possiblySoon;
  if (soon.length)
    v.append(
      h(
        'section',
        { class: 'card' },
        h('div', { class: 'card-head' }, h('div', null, h('h3', null, soon[0].heading || 'Possibly soon'), h('p', null, 'From the notes on your list: how each of them is tracking.'))),
        h(
          'div',
          { class: 'cands' },
          soon.map((p, i) =>
            h(
              'div',
              { class: 'cand', onclick: () => p.slugs[0] && go('#/director/' + p.slugs[0]) },
              h('div', { class: 'n' }, i + 1),
              h('div', null, h('b', null, p.displayName || p.name), p.displayName && p.displayName !== p.name ? h('span', { class: 'muted small' }, ` (“${p.name}”)`) : null, h('div', { class: 'why' }, p.stats ? `${p.stats.n} seen · ${p.stats.avg ?? '–'}★ avg · ${p.stats.unseenCount} unseen${p.contenderRank ? ` · #${p.contenderRank} among contenders` : ''}` : 'Not matched to a Letterboxd filmmaker yet')),
              p.prob != null ? FitBar(p.prob, T.cutline) : h('div'),
            ),
          ),
        ),
      ),
    );
  const risk = T.atRisk;
  if (risk.length)
    v.append(
      h(
        'section',
        { class: 'card' },
        h('div', { class: 'card-head' }, h('div', null, h('h3', null, 'On the bubble'), h('p', null, 'Listed filmmakers with the weakest fit: the likeliest to drop if a contender rises.'))),
        h('div', { class: 'cands' }, risk.map(r => h('div', { class: 'cand', onclick: () => go(dirLink(T.entries.find(e => e.key === r.key) || {})) }, h('div', { class: 'n' }, '#' + r.rank), h('div', null, h('b', null, r.name), r.threat ? h('div', { class: 'why' }, `${r.threat} already scores higher`) : null), FitBar(r.prob, T.cutline)))),
      ),
    );
  if (m) {
    const labels = { taste: 'Average rating (shrunk)', depth: 'Films seen', loved: '4½★+ films', perfect: '5★ films', liked: 'Share liked', crowd: 'Crowd rating of their films', potential: 'Predicted score of unseen films' };
    v.append(h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('div', null, h('h3', null, 'What gets a filmmaker into your Top 100'), h('p', null, 'Learned weights (standardised). Longer bars matter more.'))), DivergingBars(Object.entries(m.weights).map(([k, w]) => ({ label: labels[k] || k, value: w })).sort((a, b) => b.value - a.value), { fmtV: v => (v > 0 ? '+' : '') + v.toFixed(2) })));
  }
  return v;
}

// ---- Filmmaker
function viewFilmmaker(slug) {
  const v = h('div', { class: 'view' });
  v.append(SearchBox());
  if (!slug) {
    const T = S.radar.top100;
    v.append(h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, 'Your Top 100')), h('div', { class: 'chips' }, T.entries.map(e => h('a', { class: 'chip', href: dirLink(e) }, `${e.rank}. ${e.name}`)))));
    const cont = S.radar.top100.nextUp.slice(0, 20);
    if (cont.length) v.append(h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, 'Contenders')), h('div', { class: 'chips' }, cont.map(c => h('a', { class: 'chip', href: '#/director/' + c.slug }, c.name)))));
    return v;
  }
  const d = S.dirs[slug];
  if (!d) {
    v.append(WikidataView(slug.replace(/-/g, ' ')));
    return v;
  }
  const T = S.radar.top100;
  const entry = T.entries.find(e => e.slugs.includes(slug));
  const cand = T.nextUp.find(c => c.slug === slug);
  const soon = T.possiblySoon.find(p => p.slugs.includes(slug));
  const status = entry
    ? h('div', { class: 'chips' }, h('span', { class: 'chip' }, `#${entry.rank} in your Top 100`), Move(entry[S.move]), entry.modelRank ? h('span', { class: 'chip', title: 'Where your ratings alone would place them' }, `Ratings say #${entry.modelRank}`) : null, entry.best !== entry.worst ? h('span', { class: 'chip' }, `Range #${entry.best}–#${entry.worst}`) : null)
    : h('div', { class: 'chips' }, cand ? h('span', { class: 'chip' }, `Contender · ${pct(cand.prob)} fit`) : d.prob != null ? h('span', { class: 'chip' }, `${pct(d.prob)} Top-100 fit`) : null, soon ? h('span', { class: 'flag' }, 'POSSIBLY SOON') : null);
  const stats = entry?.stats;
  v.append(
    h(
      'section',
      { class: 'card' },
      h(
        'div',
        { class: 'dhead' },
        h('div', null, h('h2', null, entry && entry.slugs.length > 1 ? entry.name : d.name), h('div', { style: { marginTop: '8px' } }, status)),
        h('a', { class: 'btn', href: `${LB}/director/${slug}/`, target: '_blank', rel: 'noopener' }, 'Letterboxd ↗'),
      ),
      h(
        'div',
        { class: 'facts' },
        Fact(`${d.n}`, 'features seen'),
        Fact(d.avg != null ? d.avg.toFixed(2) + '★' : '–', `your average (overall ${S.radar.stats.avgRating ?? '–'}★)`),
        Fact(String(d.loved ?? 0), '4½★ or higher'),
        Fact(d.completion != null ? pct(d.completion) : '–', `complete · ${d.unseenCount} unseen`),
        d.potential != null ? Fact('≈' + d.potential.toFixed(1) + '★', 'best unseen, predicted') : null,
      ),
      d.pending ? h('p', { class: 'small muted' }, `${d.pending} more of their films are still being checked against your profile.`) : null,
    ),
  );
  if (entry && entry.history.length > 1)
    v.append(h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, 'Rank history')), LineChart(entry.history.map(([t, r]) => ({ t: new Date(t + 'T12:00:00Z'), v: r })), { invert: true, fmtV: r => '#' + r, label: 'Rank', domain: [Math.max(1, entry.best - 3), Math.min(100, entry.worst + 3)] })));
  // Your own ranked list of this filmmaker (e.g. "Christopher Nolan Ranked").
  const mine = new Set(d.films);
  const ranked = S.radar.lists.filter(l => l.ranked && l.items.length >= 4 && l.items.filter(x => mine.has(x)).length / l.items.length >= 0.7);
  for (const l of ranked)
    v.append(Shelf(`Your ranking: ${l.title}`, 'From your own ranked list on Letterboxd', l.items, { card: sl => ({ badge: '#' + (l.items.indexOf(sl) + 1) }) }));
  if (entry?.film) v.append(h('p', { class: 'small muted' }, 'Your pick from them in the Top 100 list: ', h('a', { href: '#', onclick: e => (e.preventDefault(), openFilm(entry.film)) }, film(entry.film).t || entry.film)));
  const filmsAll = d.films.filter(sl => S.films[sl]);
  const unseen = filmsAll.filter(sl => film(sl).s !== 1 && !film(sl).k && !film(sl).up && film(sl).pr != null).sort(byPred);
  if (unseen.length) v.append(Shelf('Watch next', 'Their unseen films, ranked for you', unseen.slice(0, 12), { card: sl => ({ note: film(sl).s === 0 ? null : 'unchecked' }) }));
  // Filmography grid with filters
  const q = { show: 'all', sort: 'pred', extras: false };
  const grid = h('div', { class: 'gridfilms' });
  const controls = h(
    'div',
    { class: 'controls' },
    segSimple(
      [
        ['all', 'All'],
        ['unseen', 'Unseen'],
        ['seen', 'Seen'],
      ],
      q.show,
      k => ((q.show = k), draw()),
    ),
    h(
      'select',
      { class: 'input', 'aria-label': 'Sort films', onchange: e => ((q.sort = e.target.value), draw()) },
      [
        ['pred', 'Best for you'],
        ['new', 'Newest'],
        ['old', 'Oldest'],
        ['crowd', 'Letterboxd rating'],
        ['pop', 'Most popular'],
      ].map(([k, l]) => h('option', { value: k }, l)),
    ),
    h('label', { class: 'small ink2' }, h('input', { type: 'checkbox', onchange: e => ((q.extras = e.target.checked), draw()) }), ' Shorts, TV & upcoming'),
  );
  function draw() {
    let list = d.films.map(sl => [sl, film(sl)]);
    if (!q.extras) list = list.filter(([, f]) => !f.k && !f.up);
    if (q.show === 'unseen') list = list.filter(([, f]) => f.s !== 1);
    if (q.show === 'seen') list = list.filter(([, f]) => f.s === 1);
    const val = f => (f.s === 1 ? f.r ?? f.pr ?? 0 : f.pr ?? 0);
    const sorters = { pred: (a, b) => val(b[1]) - val(a[1]), new: (a, b) => (b[1].y || 0) - (a[1].y || 0), old: (a, b) => (a[1].y || 9999) - (b[1].y || 9999), crowd: (a, b) => (b[1].a || 0) - (a[1].a || 0), pop: (a, b) => (b[1].n || 0) - (a[1].n || 0) };
    list.sort(sorters[q.sort]);
    grid.replaceChildren(...list.map(([sl]) => FilmCard(sl)));
    if (!list.length) grid.append(h('p', { class: 'empty' }, 'Nothing here.'));
  }
  draw();
  v.append(h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('div', null, h('h3', null, 'Filmography'), h('p', null, `${d.films.length} titles on Letterboxd`)), controls), grid));
  return v;
}

function Fact(v, k) {
  return h('div', { class: 'fact' }, h('div', { class: 'v' }, v), h('div', { class: 'k' }, k));
}

function segSimple(opts, cur, on) {
  const seg = h('div', { class: 'seg', role: 'group' });
  for (const [k, l] of opts)
    seg.append(
      h('button', { type: 'button', 'aria-pressed': String(cur === k), onclick: () => {
        seg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.k === k)));
        on(k);
      }, 'data-k': k }, l),
    );
  return seg;
}

function SearchBox() {
  const input = h('input', { class: 'input big-search', type: 'search', placeholder: 'Type any filmmaker…', 'aria-label': 'Search filmmakers', autocomplete: 'off' });
  const list = h('div', { class: 'suggest', hidden: true, role: 'listbox' });
  let sel = -1, items = [];
  const norm = x => x.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  function update() {
    const q = norm(input.value.trim());
    if (!q) {
      list.hidden = true;
      return;
    }
    const scored = [];
    for (const [slug, name, weight] of S.dirIndex) {
      const n = norm(name);
      const i = n.indexOf(q);
      if (i < 0) continue;
      const wordStart = i === 0 || n[i - 1] === ' ';
      scored.push([slug, name, (wordStart ? 1000 : 0) + weight]);
    }
    scored.sort((a, b) => b[2] - a[2]);
    items = scored.slice(0, 10);
    sel = -1;
    list.replaceChildren(
      ...items.map(([slug, name], i) => {
        const d = S.dirs[slug];
        const t = S.radar.top100.entries.find(e => e.slugs.includes(slug));
        return h('button', { type: 'button', role: 'option', onclick: () => go('#/director/' + slug), 'data-i': i }, h('span', null, name), h('span', { class: 'muted small' }, t ? `#${t.rank}` : d?.n ? `${d.n} seen` : ''));
      }),
      h('button', { type: 'button', onclick: () => go('#/wikidata/' + encodeURIComponent(input.value.trim())) }, h('span', null, `Search everywhere for “${input.value.trim()}”`), h('span', { class: 'muted small' }, 'Wikidata')),
    );
    list.hidden = false;
  }
  input.addEventListener('input', update);
  input.addEventListener('keydown', e => {
    const btns = [...list.querySelectorAll('button')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sel = Math.max(0, Math.min(btns.length - 1, sel + (e.key === 'ArrowDown' ? 1 : -1)));
      btns.forEach((b, i) => b.setAttribute('aria-selected', String(i === sel)));
    } else if (e.key === 'Enter') {
      (btns[sel] || btns[0])?.click();
    } else if (e.key === 'Escape') list.hidden = true;
  });
  document.addEventListener('click', e => {
    if (!list.contains(e.target) && e.target !== input) list.hidden = true;
  });
  return h('div', { class: 'search-wrap' }, input, list);
}

// Filmmakers outside the scanned set: Wikidata (no key needed) supplies the filmography.
function WikidataView(query) {
  const box = h('section', { class: 'card' }, h('p', { class: 'muted' }, `Looking up “${query}”…`));
  (async () => {
    try {
      const sr = await fetch(`https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(query)}&language=en&type=item&limit=8&format=json&origin=*`).then(r => r.json());
      const ids = (sr.search || []).map(x => x.id);
      if (!ids.length) throw new Error('No match');
      const sparql = `SELECT ?p ?pLabel ?film ?filmLabel ?date ?lb ?sl WHERE {
        VALUES ?p { ${ids.map(i => 'wd:' + i).join(' ')} }
        ?film wdt:P57 ?p .
        OPTIONAL { ?film wdt:P577 ?date. }
        OPTIONAL { ?film wdt:P6127 ?lb. }
        OPTIONAL { ?film wikibase:sitelinks ?sl. }
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
      }`;
      const res = await fetch('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(sparql), { headers: { Accept: 'application/sparql-results+json' } }).then(r => r.json());
      const byPerson = new Map();
      for (const b of res.results.bindings) {
        const pid = b.p.value.split('/').pop();
        const p = byPerson.get(pid) || { name: b.pLabel?.value, films: new Map() };
        const fid = b.film.value;
        const cur = p.films.get(fid) || { title: b.filmLabel?.value, year: null, lb: b.lb?.value || null, sl: +(b.sl?.value || 0) };
        const y = b.date ? +b.date.value.slice(0, 4) : null;
        if (y && (!cur.year || y < cur.year)) cur.year = y;
        if (b.lb) cur.lb = b.lb.value;
        p.films.set(fid, cur);
        byPerson.set(pid, p);
      }
      const best = ids.map(i => byPerson.get(i)).filter(Boolean).sort((a, b) => b.films.size - a.films.size)[0];
      if (!best) throw new Error('No filmography found');
      const filmsArr = [...best.films.values()].sort((a, b) => b.sl - a.sl);
      const known = filmsArr.filter(f => f.lb && S.films[f.lb]);
      const seenN = known.filter(f => S.films[f.lb].s === 1).length;
      box.replaceChildren(
        h('div', { class: 'dhead' }, h('div', null, h('h2', null, best.name), h('p', { class: 'muted' }, `${filmsArr.length} films on Wikidata · ${seenN} in your history`)), h('a', { class: 'btn', href: `https://letterboxd.com/search/${encodeURIComponent(best.name)}/`, target: '_blank', rel: 'noopener' }, 'Letterboxd ↗')),
        h('p', { class: 'note' }, 'This filmmaker is outside your scanned history, so these come from Wikidata, ordered by how widely each film is covered. Films already in your history are marked.'),
        h(
          'div',
          { class: 'rows', style: { marginTop: '10px' } },
          filmsArr.map(f => {
            const k = f.lb && S.films[f.lb];
            return h(
              'div',
              { class: 'li' },
              h('span', { class: 'l' }, f.lb ? h('a', { href: `${LB}/film/${f.lb}/`, target: '_blank', rel: 'noopener' }, f.title) : f.title, f.year ? h('span', { class: 'muted' }, ` (${f.year})`) : null),
              h('span', { class: k?.s === 1 ? 'stars' : 'muted small' }, k?.s === 1 ? (k.r != null ? stars(k.r) : 'Seen') : k?.pr != null ? `≈${k.pr.toFixed(1)}★` : ''),
            );
          }),
        ),
      );
    } catch (e) {
      box.replaceChildren(h('p', { class: 'empty' }, `Couldn't find “${query}”. Try the full name.`));
    }
  })();
  return box;
}

// ---- For you
function viewForYou() {
  const R = S.radar;
  const v = h('div', { class: 'view' });
  // Explore: client-side filters over every checked-unseen film.
  const genres = new Map();
  const pool = Object.entries(S.films).filter(([, f]) => f.s === 0 || (f.wl && f.s !== 1));
  for (const [, f] of pool) for (const g of f.g || []) genres.set(g, (genres.get(g) || 0) + 1);
  const q = store.get('explore', { genre: '', decade: '', maxrt: '', minpop: '1000' });
  const grid = h('div', { class: 'gridfilms' });
  const more = h('button', { class: 'btn', type: 'button' }, 'Show more');
  let limit = 36;
  const decades = [...new Set(pool.map(([, f]) => f.y && Math.floor(f.y / 10) * 10).filter(Boolean))].sort();
  const sel = (k, label, opts) => h('select', { class: 'input', 'aria-label': label, onchange: e => ((q[k] = e.target.value), store.set('explore', q), (limit = 36), draw()) }, opts.map(([val, l]) => h('option', { value: val, selected: String(q[k]) === String(val) }, l)));
  function draw() {
    let list = pool.filter(([, f]) => !f.k && !f.up && f.pr != null);
    if (q.genre) list = list.filter(([, f]) => (f.g || []).includes(q.genre));
    if (q.decade) list = list.filter(([, f]) => f.y && Math.floor(f.y / 10) * 10 === +q.decade);
    if (q.maxrt) list = list.filter(([, f]) => f.rt && f.rt <= +q.maxrt);
    if (q.minpop) list = list.filter(([, f]) => (f.n || 0) >= +q.minpop);
    list.sort((a, b) => b[1].pr - a[1].pr);
    grid.replaceChildren(...list.slice(0, limit).map(([sl]) => FilmCard(sl)));
    if (!list.length) grid.append(h('p', { class: 'empty' }, 'Nothing matches those filters yet.'));
    more.hidden = list.length <= limit;
  }
  more.onclick = () => {
    limit += 36;
    draw();
  };
  const explore = h(
    'section',
    { class: 'card' },
    h(
      'div',
      { class: 'card-head' },
      h('div', null, h('h2', null, 'Explore'), h('p', null, `${fmt(pool.length)} films checked against your profile and not yet watched, ranked by predicted rating.`)),
      h(
        'div',
        { class: 'controls' },
        sel('genre', 'Genre', [['', 'Any genre'], ...[...genres.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => [g, g.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())])]),
        sel('decade', 'Decade', [['', 'Any decade'], ...decades.map(d => [d, d + 's'])]),
        sel('maxrt', 'Runtime', [['', 'Any length'], ['90', '≤ 90 min'], ['105', '≤ 105 min'], ['120', '≤ 2 hours']]),
        sel('minpop', 'Popularity', [['0', 'Any popularity'], ['1000', '1K+ ratings'], ['20000', '20K+ ratings'], ['200000', '200K+ ratings']]),
        h('button', { class: 'btn', type: 'button', onclick: surprise }, 'Surprise me'),
      ),
    ),
    grid,
    h('div', { style: { marginTop: '14px' } }, more),
  );
  draw();
  const shelves = R.shelves.map(sh => Shelf(sh.title, sh.blurb, sh.films));
  if (!shelves.length) v.append(WarmingUp());
  v.append(shelves[0] || null);
  for (const b of R.because) v.append(Shelf(`Because you loved ${film(b.source).t}`, null, b.films));
  v.append(...shelves.slice(1));
  if (R.completion.length)
    v.append(
      h(
        'section',
        { class: 'card' },
        h('div', { class: 'card-head' }, h('div', null, h('h3', null, 'Close to completing'), h('p', null, 'Top 100 filmmakers where only a few features remain.'))),
        h('div', { class: 'view' }, R.completion.map(c => h('div', null, h('div', { class: 'li' }, h('a', { class: 'l', href: '#/director/' + c.key.split('+')[0] }, `#${c.rank} ${c.name}`), h('span', { class: 'muted' }, pct(c.completion) + ' complete')), h('div', { class: 'shelf', style: { marginTop: '8px' } }, c.remaining.map(sl => FilmCard(sl)))))),
      ),
    );
  if (R.comingSoon.length) v.append(Shelf('Coming from your Top 100', 'Announced and upcoming features from filmmakers you rank.', R.comingSoon.map(c => c.film), { card: sl => ({ note: R.comingSoon.find(c => c.film === sl)?.name }) }));
  v.append(explore);
  return v;
}

function surprise() {
  const pool = Object.entries(S.films)
    .filter(([, f]) => f.s === 0 && !f.k && !f.up && f.pr != null && (f.n || 0) >= 1000)
    .sort((a, b) => b[1].pr - a[1].pr)
    .slice(0, 150);
  if (!pool.length) return;
  // Weighted toward the top, but never the same obvious pick.
  const w = pool.map(([, f], i) => Math.exp(-i / 50));
  let r = Math.random() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < pool.length; i++) {
    r -= w[i];
    if (r <= 0) return openFilm(pool[i][0]);
  }
  openFilm(pool[0][0]);
}

// ---- Taste
function viewTaste() {
  const R = S.radar, M = R.model, T = R.taste;
  const v = h('div', { class: 'view' });
  v.append(
    h(
      'div',
      { class: 'tiles' },
      Tile('Prediction error', M.trained ? '±' + M.mae.toFixed(2) + '★' : '–', M.trained ? `Cross-validated on ${fmt(M.n)} of your ratings` : 'Waiting for more rated films'),
      Tile('Letterboxd average alone', M.crowdMae != null ? '±' + M.crowdMae.toFixed(2) + '★' : '–', 'Error if you just trusted the crowd'),
      Tile('You vs the crowd', T.vsCrowd ? (T.vsCrowd.meanDiff > 0 ? '+' : '') + T.vsCrowd.meanDiff.toFixed(2) + '★' : '–', T.vsCrowd ? `Average difference · correlation ${T.vsCrowd.corr}` : ''),
      Tile('Your average', (R.stats.avgRating ?? '–') + '★', `${fmt(R.stats.rated)} ratings`),
    ),
  );
  const histCard = h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('div', null, h('h3', null, 'How you rate'), h('p', null, 'Number of films at each rating'))), ColumnChart(T.hist.map(b => ({ label: b.r % 1 ? b.r.toFixed(1) : String(b.r), value: b.n, tip: stars(b.r) })), { title: 'Rating distribution' }));
  const decCard = h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('div', null, h('h3', null, 'Films by decade'), h('p', null, 'Hover for your average in each decade'))), ColumnChart(T.decades.map(d => ({ label: "'" + String(d.decade).slice(2), value: d.n, tip: `${d.decade}s · avg ${d.avg ?? '–'}★` })), { title: 'Films by decade' }));
  v.append(h('div', { class: 'grid-2' }, histCard, decCard));
  if (T.genres.length)
    v.append(
      h(
        'section',
        { class: 'card' },
        h('div', { class: 'card-head' }, h('div', null, h('h3', null, 'Genres, net of everything else'), h('p', null, 'How much each genre moves your rating once crowd score, director, era and cast are accounted for.'))),
        DivergingBars(T.genres.slice().sort((a, b) => b.effect - a.effect).map(g => ({ label: g.label, value: g.effect, sub: `${g.n} films · avg ${g.avg}★` }))),
      ),
    );
  const listCard = (title, blurb, rows, fmtRow) => h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('div', null, h('h3', null, title), blurb ? h('p', null, blurb) : null)), rows.length ? h('div', null, rows.map(fmtRow)) : h('p', { class: 'empty' }, 'Not enough data yet.'));
  const effRow = e => h('div', { class: 'li' }, h('span', { class: 'l' }, e.label, h('span', { class: 'muted small' }, ` · ${e.n} films · ${e.avg}★`)), h('span', { class: e.effect >= 0 ? 'pred' : 'muted' }, (e.effect > 0 ? '+' : '') + e.effect.toFixed(2)));
  v.append(h('div', { class: 'grid-2' }, listCard('Themes that land', 'Letterboxd themes you rate above expectation', T.themesUp, effRow), listCard("Themes that don't", null, T.themesDown, effRow)));
  v.append(h('div', { class: 'grid-2' }, listCard('Directors who overdeliver for you', 'Beyond what their films’ crowd scores predict', T.directorsUp, e => h('div', { class: 'li' }, h('a', { class: 'l', href: '#/director/' + e.key }, e.label, h('span', { class: 'muted small' }, ` · ${e.n} films · ${e.avg}★`)), h('span', { class: 'pred' }, '+' + e.effect.toFixed(2)))), listCard('Actors you respond to', null, T.actorsUp, effRow)));
  const filmRow = ([sl, d]) => h('div', { class: 'li', style: { cursor: 'pointer' }, onclick: () => openFilm(sl) }, h('span', { class: 'l' }, film(sl).t, h('span', { class: 'muted small' }, film(sl).y ? ` (${film(sl).y})` : '')), h('span', null, h('span', { class: 'stars' }, stars(film(sl).r)), h('span', { class: 'muted small' }, ` vs ${film(sl).a?.toFixed(1) ?? '–'}`)));
  if (T.vsCrowd) v.append(h('div', { class: 'grid-2' }, listCard('Your hot takes', 'Where you rate far above the Letterboxd average', T.vsCrowd.above, filmRow), listCard('Where you part ways', 'Crowd favourites you rated well below average', T.vsCrowd.below, filmRow)));
  const surRow = ([sl, d]) => h('div', { class: 'li', style: { cursor: 'pointer' }, onclick: () => openFilm(sl) }, h('span', { class: 'l' }, film(sl).t), h('span', { class: 'muted small' }, `${stars(film(sl).r)} · expected ${film(sl).ex?.toFixed(1) ?? '–'}`));
  v.append(h('div', { class: 'grid-2' }, listCard('Pleasant surprises', 'Films you liked far more than the model expected', T.surprisesUp, surRow), listCard('Letdowns', 'Films that fell short of your likely rating', T.surprisesDown, surRow)));
  if (T.countries.length) v.append(listCard('Countries', 'Net effect on your ratings', T.countries, effRow));
  return v;
}

// ---- Activity
function viewActivity() {
  const R = S.radar;
  const v = h('div', { class: 'view' });
  const diary = h(
    'section',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', null, 'Diary')),
    R.diary.length
      ? h(
          'div',
          { class: 'feed' },
          R.diary.slice(0, 40).map(d =>
            h('div', { class: 'ev', style: { cursor: 'pointer' }, onclick: () => openFilm(d.slug) }, S.films[d.slug]?.p ? Poster(d.slug, 70) : h('div', { class: 'ic' }, '🎞'), h('div', { style: { minWidth: 0 } }, h('div', null, h('b', null, d.title), d.year ? h('span', { class: 'muted' }, ` ${d.year}`) : null, d.rating != null ? h('span', { class: 'stars' }, ' ' + stars(d.rating)) : null, d.liked ? ' ♥' : null, d.rewatch ? h('span', { class: 'muted' }, ' ↻') : null), d.review ? h('div', { class: 'small muted', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, d.review) : null), h('div', { class: 'when' }, dateShort(d.watchedDate))),
          ),
        )
      : h('p', { class: 'empty' }, 'No diary entries yet.'),
  );
  const feed = h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, 'Changes detected')), R.events.length ? h('div', { class: 'feed' }, R.events.slice(0, 60).map(EventRow)) : h('p', { class: 'empty' }, 'Nothing yet. The scanner records new watches, rating changes, likes and watchlist edits from here on.'));
  v.append(h('div', { class: 'grid-2' }, diary, feed));
  const st = R.stats;
  const daily = st.daily.filter(d => d.found != null);
  const scan = h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('div', null, h('h3', null, 'Scanner'), h('p', null, 'Runs every 30 minutes on GitHub Actions. The first days map your full history; after that each run takes a few seconds.'))), ScanStatus());
  if (daily.length > 1) scan.append(h('h4', { class: 'small muted', style: { margin: '12px 0 4px' } }, 'Watched films found'), LineChart(daily.map(d => ({ t: new Date(d.d + 'T12:00:00Z'), v: d.found })), { label: 'Films found', fmtV: v => fmt(Math.round(v)) }));
  if (st.runs.length > 1) scan.append(h('h4', { class: 'small muted', style: { margin: '12px 0 4px' } }, 'Requests per run'), ColumnChart(st.runs.slice(-24).map(r => ({ label: '', value: r.req, tip: `${ago(r.t)} · ${r.s}s · ${fmt(r.found)} found` })), { height: 120, title: 'Requests per scan run' }));
  const lists = h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, 'Your lists')), h('div', null, R.lists.map(l => h('div', { class: 'li' }, h('a', { class: 'l', href: `${LB}/${user()}/list/${l.slug}/`, target: '_blank', rel: 'noopener' }, l.title), h('span', { class: 'muted small' }, `${fmt(l.count)} films`)))));
  v.append(h('div', { class: 'grid-2' }, scan, lists));
  return v;
}

// ------------------------------------------------------------------ router & boot
const routes = [
  [/^#?\/?$/, () => viewOverview(), 'overview'],
  [/^#\/top100$/, () => viewTop100(), 'top100'],
  [/^#\/next$/, () => viewNext(), 'next'],
  [/^#\/director\/(.+)$/, m => viewFilmmaker(decodeURIComponent(m[1])), 'filmmaker'],
  [/^#\/filmmaker$/, () => viewFilmmaker(null), 'filmmaker'],
  [/^#\/wikidata\/(.+)$/, m => h('div', { class: 'view' }, SearchBox(), WikidataView(decodeURIComponent(m[1]))), 'filmmaker'],
  [/^#\/foryou$/, () => viewForYou(), 'foryou'],
  [/^#\/taste$/, () => viewTaste(), 'taste'],
  [/^#\/activity$/, () => viewActivity(), 'activity'],
];
function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}
function render() {
  const main = document.getElementById('main');
  const hash = location.hash || '#/';
  for (const [re, fn, tab] of routes) {
    const m = hash.match(re);
    if (m) {
      document.querySelectorAll('nav.tabs a').forEach(a => a.setAttribute('aria-current', a.dataset.tab === tab ? 'page' : 'false'));
      main.replaceChildren(fn(m));
      return;
    }
  }
  location.hash = '#/';
}

function header() {
  const st = S.radar.stats;
  document.getElementById('who').textContent = `letterboxd.com/${st.username}`;
  const fresh = st.lastScan && Date.now() - Date.parse(st.lastScan) < 3 * 3600e3;
  const pulse = document.getElementById('pulse');
  pulse.className = 'pulse' + (fresh ? '' : ' stale');
  pulse.replaceChildren(h('i'), `Scanned ${ago(st.lastScan)}`);
  document.getElementById('foot').textContent = `Data from Letterboxd (public pages) and Wikidata. Built ${ago(S.radar.generatedAt)}. Posters © their owners.`;
}

async function load(first) {
  const bust = '?v=' + Math.floor(Date.now() / 60000);
  const [radar, films, dirs] = await Promise.all(['radar', 'films', 'directors'].map(n => fetch(`data/${n}.json${bust}`, { cache: 'no-store' }).then(r => (r.ok ? r.json() : Promise.reject(new Error(n + ' ' + r.status))))));
  if (!first && S.radar && radar.generatedAt === S.radar.generatedAt) return;
  S.radar = radar;
  S.films = films;
  S.dirs = dirs;
  S.dirIndex = Object.entries(dirs).map(([slug, d]) => [slug, d.name || slug, (d.rank ? 500 - d.rank : 0) + (d.n || 0)]);
  header();
  render();
}

function initTheme() {
  const btn = document.getElementById('theme');
  const apply = t => {
    if (t) document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
  };
  apply(store.get('theme', null));
  btn.addEventListener('click', () => {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark' || (!document.documentElement.getAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches);
    const t = dark ? 'light' : 'dark';
    store.set('theme', t);
    apply(t);
  });
}

S.move = store.get('move', 'delta');
initTheme();
window.addEventListener('hashchange', () => {
  render();
  window.scrollTo(0, 0);
});
load(true).catch(e => {
  document.getElementById('main').replaceChildren(h('div', { class: 'loading' }, h('div', null, h('h2', null, 'Warming up'), h('p', { class: 'muted' }, 'The first scan is still running. This page fills in automatically.'), h('p', { class: 'small muted' }, String(e.message || e)))));
  setTimeout(() => location.reload(), 60000);
});
// Pick up new scans without a reload.
setInterval(() => load(false).catch(() => {}), 5 * 60e3);
