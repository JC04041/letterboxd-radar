// Turns the scanned state in data/ into the JSON the website reads (site/data/).
//
//  * A ridge-regression taste model predicts your rating for every film (cross-validated).
//  * Director statistics, completion and best unseen films.
//  * The Top 100 tracker: movement since the last change / 7 days / 30 days, rank history,
//    a model of what gets a director into your Top 100, who is next up and who is at risk.
//  * Recommendation shelves and a taste profile.
import fs from 'node:fs';
import path from 'node:path';
import { ShardedStore, readJson, paths, ROOT } from '../scraper/store.js';
import { norm } from '../scraper/names.js';
import * as M from './models.js';
import { rankHistory, directorIndex, resolveName } from './top100.js';

const OUT = process.env.RADAR_OUT ? path.resolve(process.env.RADAR_OUT) : path.join(ROOT, 'site', 'data');
const NOW = Date.now();
const YEAR = new Date().getUTCFullYear();
const DAY = 864e5;

const films = new ShardedStore('films', 64);
const seen = new ShardedStore('seen', 32);
const directors = new ShardedStore('directors', 32);
const profile = readJson(paths.profile(), {});
const events = readJson(paths.events(), []);
const diary = readJson(paths.diary(), []);
const history = readJson(paths.history(), { snapshots: [] });
const daily = readJson(paths.daily(), {});
const scanLog = readJson(paths.scanLog(), []);
const cfg = readJson(path.join(ROOT, 'config.json'), {});

const log = (...a) => console.log('[build]', ...a);

// ---------------------------------------------------------------- film universe
const F = new Map();
for (const [slug, f] of films.entries()) if (f && !f.gone && f.t) F.set(slug, f);
const S = slug => seen.get(slug);
const isSeen = slug => S(slug)?.[0] === 1;
const isUnseen = slug => S(slug)?.[0] === 0;
const myRating = slug => S(slug)?.[1] ?? null;
const watchlist = new Set(profile.watchlist || []);
const kind = f => (f.tv ? 'tv' : f.rt && f.rt < 40 ? 'short' : 'feature');
const released = f => !!f.y && (f.y < YEAR || (f.y === YEAR && (f.n || 0) > 0));
const people = new Map(); // director slug -> name
for (const f of F.values()) for (const [s, n] of f.d || []) people.set(s, n);
for (const [s, d] of directors.entries()) if (d?.n) people.set(s, d.n);

const titleCase = slug =>
  String(slug)
    .replace(/-/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());

// ---------------------------------------------------------------- related-film graph
// Letterboxd's "related films" links, made undirected. How you rated a film's neighbours
// relative to the crowd is an item-based collaborative signal.
const neighbours = new Map();
const link = (a, b) => (neighbours.get(a) || neighbours.set(a, new Set()).get(a)).add(b);
for (const [slug, f] of F) for (const r of f.rel || []) if (r !== slug) {
  link(slug, r);
  link(r, slug);
}
const residual = slug => {
  const f = F.get(slug), r = seen.get(slug);
  return f && r?.[0] === 1 && r[1] != null && f.a != null ? r[1] - f.a : null;
};
function neighbourSignal(slug) {
  const vals = [];
  for (const n of neighbours.get(slug) || []) {
    const v = residual(n);
    if (v != null) vals.push([n, v]);
  }
  const sum = vals.reduce((a, [, v]) => a + v, 0);
  return { mean: sum / (vals.length + 2), n: vals.length, vals };
}

// ---------------------------------------------------------------- rating model
const train = [];
for (const [slug, f] of F) {
  const r = myRating(slug);
  if (isSeen(slug) && r != null) train.push([slug, f, r]);
}
const allRatings = [];
for (const r of seen.values()) if (r[0] === 1 && r[1] != null) allRatings.push(r[1]);
const MU = allRatings.length ? M.mean(allRatings) : 3.5;

const vocabCount = new Map();
const bump = k => vocabCount.set(k, (vocabCount.get(k) || 0) + 1);
const catKeys = f => {
  const k = [];
  for (const g of f.g || []) k.push('g:' + g);
  for (const t of (f.th || []).slice(0, 5)) k.push('th:' + t);
  for (const c of f.c || []) k.push('c:' + c);
  if (f.l?.[0]) k.push('lang:' + f.l[0]);
  for (const [d] of f.d || []) k.push('d:' + d);
  for (const [a] of (f.cast || []).slice(0, 5)) k.push('a:' + a);
  if (f.y) k.push('dec:' + Math.floor(f.y / 10) * 10);
  return k;
};
for (const [, f] of train) for (const k of new Set(catKeys(f))) bump(k);
const minCount = { g: 3, th: 8, c: 5, lang: 5, d: 2, a: 3, dec: 3 };
const numeric = ['crowd', 'crowd2', 'nocrowd', 'pop', 'runtime', 'short', 'recency', 'nb', 'nbn'];
const feats = [...numeric];
for (const [k, n] of vocabCount) if (n >= (minCount[k.split(':')[0]] ?? 3)) feats.push(k);
const fIndex = new Map(feats.map((k, i) => [k, i]));
const penalties = feats.map(k => (numeric.includes(k) ? 0.02 : k.startsWith('d:') ? 0.3 : 1));

function row(f, slug) {
  const r = [];
  const put = (k, v) => fIndex.has(k) && v && r.push([fIndex.get(k), v]);
  if (f.a != null) {
    put('crowd', f.a - 3.5);
    put('crowd2', (f.a - 3.5) ** 2);
  } else put('nocrowd', 1);
  put('pop', Math.log10((f.n || 0) + 10) - 4);
  if (f.rt) put('runtime', M.clamp((f.rt - 110) / 30, -2, 3));
  put('short', f.rt && f.rt < 60 ? 1 : 0);
  if (f.y) put('recency', (f.y - 2000) / 25);
  const nb = neighbourSignal(slug);
  put('nb', nb.mean);
  put('nbn', Math.log1p(nb.n) / 3);
  for (const k of new Set(catKeys(f))) put(k, 1);
  return r;
}

let model = null, modelInfo = { trained: false, n: train.length };
const oofBySlug = new Map();
if (train.length >= 40) {
  const rows = train.map(([slug, f]) => row(f, slug));
  const y = train.map(([, , r]) => r);
  const cv = M.cvRidge(rows, y, feats.length, [10, 25, 50, 100, 200], 5, penalties);
  // Crowd-only baseline, for an honest "how much better than the Letterboxd average" number.
  const baseRows = train.map(([slug, f]) => row(f, slug).filter(([j]) => j < 7));
  const base = M.cvRidge(baseRows, y, feats.length, [1, 10], 5, penalties);
  const crowdOnly = train.filter(([, f]) => f.a != null);
  const crowdMae = crowdOnly.length ? M.mean(crowdOnly.map(([, f, r]) => Math.abs(f.a - r))) : null;
  model = M.fitRidge(rows, y, feats.length, cv.lambda, penalties);
  train.forEach(([slug], i) => oofBySlug.set(slug, cv.oof[i]));
  modelInfo = {
    trained: true,
    n: train.length,
    features: feats.length,
    lambda: cv.lambda,
    mae: +cv.mae.toFixed(3),
    rmse: +cv.rmse.toFixed(3),
    baselineMae: +base.mae.toFixed(3),
    crowdMae: crowdMae != null ? +crowdMae.toFixed(3) : null,
    corr: +M.pearson(cv.oof.map(p => M.clamp(p, 0.5, 5)), y).toFixed(3),
    meanRating: +MU.toFixed(3),
  };
  log(`taste model: n=${train.length} p=${feats.length} lambda=${cv.lambda} MAE=${cv.mae.toFixed(3)} (crowd-only ${base.mae.toFixed(3)})`);
} else {
  log(`taste model: only ${train.length} rated films with metadata so far; using crowd average`);
}

const actorNames = new Map();
for (const f of F.values()) for (const [s, n] of f.cast || []) actorNames.set(s, n);
const LANGS = { en: 'English', fr: 'French', ja: 'Japanese', ko: 'Korean', it: 'Italian', de: 'German', es: 'Spanish', sv: 'Swedish', zh: 'Chinese', cn: 'Cantonese', ru: 'Russian', da: 'Danish', pt: 'Portuguese', hi: 'Hindi', fa: 'Persian', pl: 'Polish' };
const langName = c => LANGS[c] || String(c).toUpperCase();

const featLabel = k => {
  const [p, ...rest] = k.split(':');
  const v = rest.join(':');
  if (p === 'd') return people.get(v) || titleCase(v);
  if (p === 'a') return actorNames.get(v) || titleCase(v);
  if (p === 'g') return titleCase(v);
  if (p === 'th') return titleCase(v);
  if (p === 'c') return v;
  if (p === 'lang') return langName(v);
  if (p === 'dec') return v + 's';
  return k;
};


function predict(f, slug) {
  if (!model) return f.a != null ? M.clamp(MU + (f.a - 3.4) * 0.9, 0.5, 5) : MU;
  return M.clamp(M.predictSparse(model, row(f, slug)), 0.5, 5);
}

// Top reasons behind a prediction: the largest non-numeric feature contributions.
function reasons(f, slug) {
  if (!model) return [];
  const out = [];
  const nbJ = fIndex.get('nb');
  for (const [j, v] of row(f, slug)) {
    if (j === nbJ) {
      // Name the related films that drive this signal.
      const c = model.w[j] * v;
      if (Math.abs(c) < 0.04) continue;
      const drivers = neighbourSignal(slug).vals.filter(([, r]) => (c > 0 ? r > 0 : r < 0)).sort((a, b) => (c > 0 ? b[1] - a[1] : a[1] - b[1]));
      if (drivers.length) out.push([`Like ${F.get(drivers[0][0])?.t || drivers[0][0]}`, +c.toFixed(2), 'nb']);
      continue;
    }
    if (j < numeric.length) continue;
    const c = model.w[j] * v;
    if (Math.abs(c) >= 0.04) out.push([featLabel(feats[j]), +c.toFixed(2), feats[j].split(':')[0]]);
  }
  out.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const pos = out.filter(x => x[1] > 0).slice(0, 3);
  const neg = out.filter(x => x[1] < 0).slice(0, 1);
  return [...pos, ...neg];
}

const pred = new Map();
for (const [slug, f] of F) pred.set(slug, +predict(f, slug).toFixed(2));
// Percentile against films you've actually watched ("better than N% of what you've seen").
const oofSorted = [...(oofBySlug.size ? oofBySlug.values() : allRatings)].map(x => M.clamp(x, 0.5, 5)).sort((a, b) => a - b);
const pct = p => {
  if (!oofSorted.length) return null;
  let lo = 0, hi = oofSorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (oofSorted[mid] < p) lo = mid + 1;
    else hi = mid;
  }
  return Math.round((lo / oofSorted.length) * 100);
};

// ---------------------------------------------------------------- director statistics
const filmsByDirector = new Map();
for (const [s, f] of F) for (const [d] of f.d || []) (filmsByDirector.get(d) || filmsByDirector.set(d, []).get(d)).push(s);
const listedTitle = new Map(); // slug -> [title, year] from filmography pages
for (const d of directors.values()) for (const [s, t, y] of d?.f || []) if (!listedTitle.has(s)) listedTitle.set(s, [t, y]);

function filmographyOf(slug) {
  const rec = directors.get(slug);
  const list = rec?.f?.length ? rec.f.map(x => x[0]) : [];
  const have = new Set(list);
  return [...list, ...(filmsByDirector.get(slug) || []).filter(s => !have.has(s))];
}

const dirFilmsCache = new Map();
function dirFilms(slug) {
  if (!dirFilmsCache.has(slug)) dirFilmsCache.set(slug, filmographyOf(slug));
  return dirFilmsCache.get(slug);
}

// Stats for a set of director slugs (a duo like the Coens is treated as one filmmaker).
function statsFor(slugs, extraSeen = null) {
  const all = [...new Set(slugs.flatMap(dirFilms))];
  const seenF = [], unseenF = [], pending = [], upcoming = [];
  for (const s of all) {
    const f = F.get(s);
    if (f && kind(f) !== 'feature') continue;
    if (isSeen(s)) seenF.push(s);
    else if (f && !released(f)) upcoming.push(s);
    else if (isUnseen(s) || watchlist.has(s)) unseenF.push(s);
    else pending.push(s);
  }
  const ratings = seenF.map(myRating).filter(r => r != null);
  if (extraSeen != null) ratings.push(extraSeen);
  const n = seenF.length + (extraSeen != null ? 1 : 0);
  const k = 3;
  const sum = ratings.reduce((a, b) => a + b, 0);
  const avg = ratings.length ? sum / ratings.length : null;
  const shrunk = (sum + k * MU) / (ratings.length + k);
  const loved = ratings.filter(r => r >= 4.5).length;
  const fives = ratings.filter(r => r >= 5).length;
  const liked = seenF.filter(s => S(s)?.[2]).length;
  const crowd = seenF.map(s => F.get(s)?.a).filter(x => x != null);
  const unseenRanked = unseenF.filter(s => F.has(s)).sort((a, b) => pred.get(b) - pred.get(a));
  const potential = unseenRanked.slice(0, 3).map(s => pred.get(s));
  const best = seenF.filter(s => myRating(s) != null).sort((a, b) => myRating(b) - myRating(a) || (F.get(b)?.n || 0) - (F.get(a)?.n || 0))[0] || null;
  const dates = seenF.map(s => S(s)?.[3]).filter(Boolean).sort();
  return {
    n,
    rated: ratings.length,
    avg: avg != null ? +avg.toFixed(2) : null,
    shrunk: +shrunk.toFixed(3),
    loved,
    fives,
    liked,
    likedFrac: seenF.length ? liked / seenF.length : 0,
    crowd: crowd.length ? +M.mean(crowd).toFixed(2) : null,
    best,
    seen: seenF,
    unseen: unseenRanked.map(s => s),
    unseenCount: unseenF.length,
    pending: pending.length,
    upcoming,
    completion: seenF.length + unseenF.length ? seenF.length / (seenF.length + unseenF.length) : null,
    potential: potential.length ? +M.mean(potential).toFixed(2) : null,
    last: dates[dates.length - 1] || null,
  };
}

// Feature vector used by both the Top-100 membership model and the rank model.
const featNames = ['taste', 'depth', 'loved', 'perfect', 'liked', 'crowd', 'potential'];
const dirVec = st => [
  st.shrunk - MU,
  Math.log1p(st.n),
  Math.log1p(st.loved),
  Math.log1p(st.fives),
  st.likedFrac,
  (st.crowd ?? 3.5) - 3.5,
  (st.potential ?? MU) - MU,
];

// ---------------------------------------------------------------- top 100
const t100 = profile.top100 || {};
const entries = t100.entries || [];
const series = rankHistory(history.snapshots || []);
const snapshots = history.snapshots || [];
const index = directorIndex(films, seen);

function seriesFor(e) {
  if (series.has(e.key)) return series.get(e.key);
  // Fall back to matching by name (identity re-keyed since the snapshot).
  const nm = norm(e.name);
  for (const [k, pts] of series) {
    const last = snapshots[snapshots.length - 1];
    const hit = last?.e.find(x => x[0] === k);
    if (hit && norm(hit[1]) === nm) return pts;
  }
  return [];
}

function rankAt(points, t) {
  let r;
  for (const [ts, rank] of points) {
    if (Date.parse(ts) <= t) r = rank;
    else break;
  }
  return r;
}

const entryStats = entries.map(e => ({ e, st: e.slugs.length ? statsFor(e.slugs) : null }));

// Candidate directors (not in the Top 100) with at least one seen feature.
const inTop = new Set(entries.flatMap(e => e.slugs));
const candStats = [];
for (const d of index) {
  if (inTop.has(d.slug) || !d.weight) continue;
  const st = statsFor([d.slug]);
  if (st.n >= 1) candStats.push({ slug: d.slug, name: people.get(d.slug) || d.name, st });
}

// Membership model: what separates your Top 100 from everyone else you've watched?
let member = null, memberInfo = null;
const posRows = entryStats.filter(x => x.st && x.st.n >= 1);
if (posRows.length >= 20 && candStats.length >= 20) {
  const X = [...posRows.map(x => dirVec(x.st)), ...candStats.map(c => dirVec(c.st))];
  const y = [...posRows.map(() => 1), ...candStats.map(() => 0)];
  const sd = M.standardiser(X);
  const Xs = X.map(sd.apply);
  // Unweighted, so the output is a calibrated probability rather than a class-balanced score.
  const weights = y.map(() => 1);
  const m = M.fitLogistic(Xs, y, { lambda: 2, iters: 2500, lr: 0.2, weights });
  // Out-of-fold AUC for honesty.
  const order = M.seededOrder(Xs.length);
  const oof = new Array(Xs.length);
  for (let f = 0; f < 5; f++) {
    const test = order.filter((_, i) => i % 5 === f);
    const ts = new Set(test);
    const tr = order.filter(i => !ts.has(i));
    const mf = M.fitLogistic(tr.map(i => Xs[i]), tr.map(i => y[i]), { lambda: 2, iters: 1500, lr: 0.2, weights: tr.map(i => weights[i]) });
    for (const i of test) oof[i] = M.logisticProb(mf, Xs[i]);
  }
  member = { m, sd };
  memberInfo = {
    auc: +(M.auc(oof, y) ?? 0).toFixed(3),
    weights: Object.fromEntries(featNames.map((n, j) => [n, +m.w[j].toFixed(3)])),
    positives: posRows.length,
    negatives: candStats.length,
  };
  log(`top-100 membership model: AUC=${memberInfo.auc} on ${posRows.length}+${candStats.length}`);
}
const memberProb = st => (member ? M.logisticProb(member.m, member.sd.apply(dirVec(st))) : Math.min(1, Math.max(0, (st.shrunk - MU + 1) / 2)));

// Rank model: which order would your ratings alone suggest? (out-of-fold ridge on -log(rank))
const modelRank = new Map();
let rankInfo = null;
if (posRows.length >= 20) {
  const X = posRows.map(x => dirVec(x.st));
  const sd = M.standardiser(X);
  const Xs = X.map(sd.apply);
  const y = posRows.map(x => -Math.log(x.e.rank));
  const order = M.seededOrder(Xs.length);
  const scores = new Array(Xs.length);
  for (let f = 0; f < 5; f++) {
    const test = order.filter((_, i) => i % 5 === f);
    const ts = new Set(test);
    const tr = order.filter(i => !ts.has(i));
    const mf = M.fitDenseRidge(tr.map(i => Xs[i]), tr.map(i => y[i]), 3);
    for (const i of test) scores[i] = M.predictSparse(mf, Xs[i].map((v, j) => [j, v]));
  }
  const sorted = scores.map((s, i) => [s, i]).sort((a, b) => b[0] - a[0]);
  sorted.forEach(([, i], k) => modelRank.set(posRows[i].e.key, k + 1));
  rankInfo = { spearman: +M.spearman(posRows.map(x => x.e.rank), posRows.map(x => modelRank.get(x.e.key))).toFixed(3), n: posRows.length };
}

const lastSnap = snapshots[snapshots.length - 1];
const prevSnap = snapshots[snapshots.length - 2];
const top100 = entryStats.map(({ e, st }) => {
  const pts = seriesFor(e);
  const prevRank = prevSnap ? rankAt(pts, Date.parse(prevSnap.t)) : undefined;
  const r7 = rankAt(pts, NOW - 7 * DAY);
  const r30 = rankAt(pts, NOW - 30 * DAY);
  const ranks = pts.map(p => p[1]).filter(r => r != null);
  const entered = pts.length ? pts[0][0] : null;
  return {
    rank: e.rank,
    key: e.key,
    name: e.name,
    slugs: e.slugs,
    film: e.film,
    filmMatches: e.filmMatches,
    delta: prevSnap ? (prevRank == null ? 'new' : prevRank - e.rank) : null,
    d7: r7 === undefined ? null : r7 == null ? 'new' : r7 - e.rank,
    d30: r30 === undefined ? null : r30 == null ? 'new' : r30 - e.rank,
    best: ranks.length ? Math.min(...ranks) : e.rank,
    worst: ranks.length ? Math.max(...ranks) : e.rank,
    since: entered,
    history: pts.map(([t, r]) => [t.slice(0, 10), r]),
    modelRank: modelRank.get(e.key) ?? null,
    prob: st ? +memberProb(st).toFixed(3) : null,
    stats: st ? slimStats(st) : null,
  };
});

function slimStats(st) {
  return {
    n: st.n,
    rated: st.rated,
    avg: st.avg,
    loved: st.loved,
    fives: st.fives,
    liked: st.liked,
    crowd: st.crowd,
    best: st.best,
    completion: st.completion != null ? +st.completion.toFixed(3) : null,
    unseenCount: st.unseenCount,
    pending: st.pending,
    nextUp: st.unseen.slice(0, 5),
    upcoming: st.upcoming.slice(0, 4),
    potential: st.potential,
    last: st.last,
  };
}

// Dropped directors: in the previous snapshot but not now.
const dropped = [];
if (prevSnap && lastSnap) {
  const nowIds = new Set(lastSnap.e.flatMap(x => [x[0], norm(x[1])]));
  prevSnap.e.forEach((x, i) => {
    if (!nowIds.has(x[0]) && !nowIds.has(norm(x[1]))) dropped.push({ name: x[1], key: x[0], lastRank: i + 1, when: lastSnap.t });
  });
}

// The cut line: how likely the model thinks the bottom of your list is.
const bottom = top100.filter(x => x.prob != null && x.rank > 85).map(x => x.prob).sort((a, b) => a - b);
const cutline = bottom.length ? bottom[Math.floor(bottom.length / 2)] : 0.5;

// Next up: strongest directors not yet in the Top 100, and what it would take.
const soonNames = (t100.sections || []).flatMap(s => s.names.map(n => ({ ...n, heading: s.heading })));
const soonBySlug = new Map();
for (const n of soonNames) for (const s of n.slugs) soonBySlug.set(s, n.name);
const nextUp = candStats
  .filter(c => c.st.n >= 2 || soonBySlug.has(c.slug))
  .map(c => ({ ...c, prob: memberProb(c.st) }))
  .sort((a, b) => b.prob - a.prob)
  .slice(0, 30)
  .map(c => {
    const target = c.st.unseen.find(s => F.has(s)) || null;
    let boosted = null;
    if (target) boosted = memberProb(statsFor([c.slug], Math.max(4.5, Math.round(pred.get(target) * 2) / 2)));
    return {
      slug: c.slug,
      name: c.name,
      prob: +c.prob.toFixed(3),
      aboveCut: c.prob >= cutline,
      flagged: soonBySlug.has(c.slug),
      stats: slimStats(c.st),
      path: target ? { film: target, pred: pred.get(target), probAfter: +boosted.toFixed(3), crosses: boosted >= cutline } : null,
    };
  });

const possiblySoon = soonNames.map(n => {
  const st = n.slugs.length ? statsFor(n.slugs) : null;
  const prob = st ? memberProb(st) : null;
  const contenderRank = prob != null ? candStats.filter(c => memberProb(c.st) > prob).length + 1 : null;
  return { name: n.name, heading: n.heading, slugs: n.slugs, displayName: n.slugs.map(s => people.get(s) || titleCase(s)).join(' & ') || n.name, prob: prob != null ? +prob.toFixed(3) : null, contenderRank, stats: st ? slimStats(st) : null };
});

const atRisk = top100
  .filter(x => x.prob != null && x.rank > 60)
  .sort((a, b) => a.prob - b.prob)
  .slice(0, 10)
  .map(x => ({ rank: x.rank, key: x.key, name: x.name, prob: x.prob, threat: nextUp.find(n => n.prob > x.prob)?.name || null }));

const rankEvents = events.filter(e => ['move', 'enter', 'exit', 'fav', 'soon+', 'soon-'].includes(e.type)).slice(-300);
const biggestMovers = (() => {
  const agg = new Map();
  for (const ev of rankEvents) {
    if (ev.type !== 'move') continue;
    if (NOW - Date.parse(ev.t) > 30 * DAY) continue;
    const k = ev.key;
    const cur = agg.get(k) || { key: k, name: ev.name, net: 0 };
    cur.net += ev.from - ev.to;
    agg.set(k, cur);
  }
  const arr = [...agg.values()].filter(x => x.net);
  return { up: arr.filter(x => x.net > 0).sort((a, b) => b.net - a.net).slice(0, 5), down: arr.filter(x => x.net < 0).sort((a, b) => a.net - b.net).slice(0, 5) };
})();

// ---------------------------------------------------------------- recommendation shelves
const topDirSet = new Set(entries.flatMap(e => e.slugs));
const pool = [];
for (const [slug, f] of F) {
  if (isSeen(slug)) continue;
  if (!(isUnseen(slug) || watchlist.has(slug))) continue; // only verified-unseen films
  if (kind(f) !== 'feature' || !released(f)) continue;
  pool.push(slug);
}
const byPred = arr => [...arr].sort((a, b) => pred.get(b) - pred.get(a));
function diverse(arr, perDir = 2, n = 24) {
  const out = [], per = new Map();
  for (const s of arr) {
    const d = (F.get(s).d || []).map(x => x[0]).join('+');
    if ((per.get(d) || 0) >= perDir) continue;
    per.set(d, (per.get(d) || 0) + 1);
    out.push(s);
    if (out.length >= n) break;
  }
  return out;
}
const seenDirs = new Set();
for (const [slug, f] of F) if (isSeen(slug)) for (const [d] of f.d || []) seenDirs.add(d);
const canonSet = new Set(Object.values(profile.canon || {}).flatMap(c => c.items || []));

const lovedRecent = [...seen.entries()]
  .filter(([s, r]) => r[0] === 1 && (r[1] || 0) >= 4.5 && F.has(s))
  .sort((a, b) => String(b[1][3] || '').localeCompare(String(a[1][3] || '')))
  .slice(0, 8)
  .map(([s]) => s);
const poolSet = new Set(pool);

const shelves = [
  { id: 'top', title: 'Top picks for you', blurb: 'Highest predicted ratings among films you have not seen.', films: diverse(byPred(pool.filter(s => (F.get(s).n || 0) >= 2000)), 2, 30) },
  { id: 'top100', title: 'Unseen from your Top 100', blurb: 'The best gaps in the filmographies of directors you rank.', films: diverse(byPred(pool.filter(s => (F.get(s).d || []).some(([d]) => topDirSet.has(d)))), 2, 30) },
  { id: 'watchlist', title: 'Your watchlist, ranked', blurb: 'Everything on your watchlist, in order of how much you should like it.', films: byPred([...watchlist].filter(s => F.has(s))) },
  { id: 'gems', title: 'Hidden gems', blurb: 'High predicted scores on films with under 15,000 ratings.', films: diverse(byPred(pool.filter(s => { const n = F.get(s).n || 0; return n >= 300 && n < 15000; })), 1, 24) },
  { id: 'canon', title: 'Canon blind spots', blurb: 'Letterboxd and IMDb Top 250 films you have not logged.', films: byPred(pool.filter(s => canonSet.has(s))).slice(0, 30) },
  { id: 'new-voices', title: 'Directors you have never tried', blurb: 'Your best bets from filmmakers with no films in your history.', films: diverse(byPred(pool.filter(s => (F.get(s).n || 0) >= 5000 && !(F.get(s).d || []).some(([d]) => seenDirs.has(d)))), 1, 24) },
  { id: 'quick', title: 'Under 100 minutes', blurb: 'Short on time, high on match.', films: diverse(byPred(pool.filter(s => (F.get(s).rt || 999) <= 100 && (F.get(s).n || 0) >= 2000)), 2, 24) },
  { id: 'deep', title: 'Long-haul masterpieces', blurb: 'Two and a half hours or more, and worth it.', films: diverse(byPred(pool.filter(s => (F.get(s).rt || 0) >= 150 && (F.get(s).n || 0) >= 2000)), 2, 18) },
].filter(s => s.films.length);

const because = lovedRecent
  .map(src => ({ source: src, films: byPred((F.get(src).rel || []).filter(s => poolSet.has(s))).slice(0, 8) }))
  .filter(x => x.films.length >= 2)
  .slice(0, 5);

const comingSoon = [];
for (const e of entries)
  for (const s of e.slugs)
    for (const fs_ of dirFilms(s)) {
      const f = F.get(fs_);
      if (f && !released(f) && kind(f) === 'feature' && !comingSoon.some(c => c.film === fs_)) comingSoon.push({ film: fs_, rank: e.rank, name: e.name });
    }
comingSoon.sort((a, b) => a.rank - b.rank);

const completion = top100
  .filter(x => x.stats && x.stats.completion != null && x.stats.completion >= 0.5 && x.stats.unseenCount > 0 && x.stats.unseenCount <= 6)
  .sort((a, b) => b.stats.completion - a.stats.completion)
  .slice(0, 12)
  .map(x => ({ rank: x.rank, name: x.name, key: x.key, completion: x.stats.completion, remaining: statsFor(x.slugs).unseen }));

// ---------------------------------------------------------------- taste profile
function effects(prefix, minN, limit, flip = false) {
  if (!model) return [];
  const out = [];
  for (const [k, j] of fIndex) {
    if (!k.startsWith(prefix + ':')) continue;
    const n = vocabCount.get(k) || 0;
    if (n < minN) continue;
    const rs = train.filter(([, f]) => catKeys(f).includes(k)).map(([, , r]) => r);
    out.push({ key: k.slice(prefix.length + 1), label: featLabel(k), n, avg: +M.mean(rs).toFixed(2), effect: +model.w[j].toFixed(3) });
  }
  out.sort((a, b) => (flip ? a.effect - b.effect : b.effect - a.effect));
  return limit ? out.slice(0, limit) : out;
}
const withCrowd = train.filter(([, f]) => f.a != null);
const diffs = withCrowd.map(([s, f, r]) => [s, r - f.a]);
diffs.sort((a, b) => b[1] - a[1]);
const hist = Array.from({ length: 10 }, (_, i) => ({ r: (i + 1) / 2, n: 0 }));
for (const r of allRatings) hist[Math.round(r * 2) - 1] && hist[Math.round(r * 2) - 1].n++;
const decades = {};
for (const [slug, f] of F)
  if (isSeen(slug) && f.y) {
    const d = Math.floor(f.y / 10) * 10;
    decades[d] = decades[d] || { decade: d, n: 0, sum: 0, rated: 0 };
    decades[d].n++;
    const r = myRating(slug);
    if (r != null) {
      decades[d].sum += r;
      decades[d].rated++;
    }
  }
const surprises = [...oofBySlug.entries()].map(([s, p]) => [s, myRating(s) - M.clamp(p, 0.5, 5)]).sort((a, b) => b[1] - a[1]);

const taste = {
  genres: effects('g', 3, 0),
  themesUp: effects('th', 8, 12),
  themesDown: effects('th', 8, 8, true),
  countries: effects('c', 5, 12),
  decadesEffect: effects('dec', 3, 0).sort((a, b) => a.key - b.key),
  directorsUp: effects('d', 3, 15),
  directorsDown: effects('d', 3, 8, true),
  actorsUp: effects('a', 3, 15),
  actorsDown: effects('a', 3, 8, true),
  vsCrowd: withCrowd.length
    ? { n: withCrowd.length, meanDiff: +M.mean(diffs.map(d => d[1])).toFixed(3), corr: +M.pearson(withCrowd.map(([, f]) => f.a), withCrowd.map(([, , r]) => r)).toFixed(3), above: diffs.slice(0, 12).map(([s, d]) => [s, +d.toFixed(2)]), below: diffs.slice(-12).reverse().map(([s, d]) => [s, +d.toFixed(2)]) }
    : null,
  hist,
  decades: Object.values(decades).sort((a, b) => a.decade - b.decade).map(d => ({ decade: d.decade, n: d.n, avg: d.rated ? +(d.sum / d.rated).toFixed(2) : null })),
  surprisesUp: surprises.slice(0, 10).map(([s, d]) => [s, +d.toFixed(2)]),
  surprisesDown: surprises.slice(-10).reverse().map(([s, d]) => [s, +d.toFixed(2)]),
};

// ---------------------------------------------------------------- directors index (filmmaker search)
const dirOut = {};
const dirSlugs = new Set([...index.filter(d => d.weight > 0).map(d => d.slug), ...entries.flatMap(e => e.slugs), ...soonNames.flatMap(n => n.slugs), ...directors.map.keys()]);
for (const d of dirSlugs) {
  const rec = directors.get(d);
  if (rec?.gone) continue;
  const st = statsFor([d]);
  const filmsList = dirFilms(d);
  if (!filmsList.length) continue;
  const topEntry = entries.find(e => e.slugs.includes(d));
  dirOut[d] = {
    name: people.get(d) || rec?.n || titleCase(d),
    films: filmsList,
    fetched: !!rec?.f?.length,
    n: st.n,
    avg: st.avg,
    loved: st.loved,
    completion: st.completion != null ? +st.completion.toFixed(3) : null,
    unseenCount: st.unseenCount,
    pending: st.pending,
    rank: topEntry ? topEntry.rank : null,
    prob: st.n ? +memberProb(st).toFixed(3) : null,
    potential: st.potential,
  };
}

// ---------------------------------------------------------------- film catalogue for the site
const catalogue = {};
const include = new Set([...pool, ...Object.values(dirOut).flatMap(d => d.films)]);
for (const [slug, r] of seen.entries()) if (r[0] === 1) include.add(slug);
for (const slug of include) {
  const f = F.get(slug);
  const s = S(slug);
  const o = {};
  if (f) {
    o.t = f.t;
    o.y = f.y;
    o.d = (f.d || []).map(x => x[0]);
    o.g = f.g;
    o.rt = f.rt;
    o.a = f.a;
    o.n = f.n;
    o.p = f.p;
    o.c = f.c?.[0];
    if (kind(f) !== 'feature') o.k = kind(f);
    if (!released(f)) o.up = 1;
  } else {
    // Not fetched yet: keep what the filmography told us.
    const hit = listedTitle.get(slug);
    if (hit) {
      o.t = hit[0];
      o.y = hit[1];
    } else o.t = titleCase(slug);
    o.nm = 1;
  }
  if (s?.[0] === 1) {
    o.s = 1;
    if (s[1] != null) o.r = s[1];
    if (s[2]) o.l = 1;
    if (s[3]) o.wd = s[3];
  } else if (s?.[0] === 0) o.s = 0;
  if (watchlist.has(slug)) o.wl = 1;
  if (f) {
    o.pr = pred.get(slug);
    if (o.s !== 1) {
      o.m = pct(o.pr);
      const why = reasons(f, slug);
      if (why.length) o.why = why;
    } else if (oofBySlug.has(slug)) o.ex = +M.clamp(oofBySlug.get(slug), 0.5, 5).toFixed(2);
  }
  catalogue[slug] = o;
}

// ---------------------------------------------------------------- stats + status
let found = 0, rated = 0, liked = 0, verifiedUnseen = 0;
for (const r of seen.values()) {
  if (r[0] === 1) {
    found++;
    if (r[1] != null) rated++;
    if (r[2]) liked++;
  } else verifiedUnseen++;
}
const lastRun = scanLog[scanLog.length - 1] || null;
const stats = {
  username: profile.username || cfg.username,
  watchedTotal: profile.watchedTotal ?? null,
  found,
  coverage: profile.watchedTotal ? +(found / profile.watchedTotal).toFixed(3) : null,
  rated,
  liked,
  avgRating: allRatings.length ? +M.mean(allRatings).toFixed(2) : null,
  watchlist: watchlist.size,
  filmsInDb: F.size,
  directorsInDb: directors.size,
  verifiedUnseen,
  firstScan: profile.firstScan || null,
  lastScan: profile.lastScan || null,
  lastRun: lastRun ? { t: lastRun.t, seconds: lastRun.seconds, jobs: lastRun.jobs, pending: lastRun.pending || {}, blocked: lastRun.blocked, requests: lastRun.http?.requests } : null,
  runs: scanLog.slice(-60).map(r => ({ t: r.t, s: r.seconds, req: r.http?.requests || 0, found: r.found, blocked: r.blocked })),
  daily: Object.entries(daily).sort().map(([d, v]) => ({ d, ...v })),
};

const recentDiary = diary.slice(-60).reverse();
const out = {
  generatedAt: new Date(NOW).toISOString(),
  stats,
  model: modelInfo,
  top100: {
    list: { slug: t100.slug, title: t100.title, updated: t100.updated, url: t100.slug ? `https://letterboxd.com/${profile.username}/list/${t100.slug}/` : null },
    snapshots: snapshots.length,
    tracking: snapshots[0]?.t || null,
    lastChange: lastSnap?.t || null,
    entries: top100,
    dropped,
    nextUp,
    possiblySoon,
    atRisk,
    cutline: +cutline.toFixed(3),
    member: memberInfo,
    rankModel: rankInfo,
    movers: biggestMovers,
    events: rankEvents.slice(-150).reverse(),
  },
  shelves,
  because,
  comingSoon: comingSoon.slice(0, 30),
  completion,
  taste,
  diary: recentDiary,
  events: events.filter(e => !['move', 'enter', 'exit', 'fav', 'soon+', 'soon-'].includes(e.type)).slice(-300).reverse(),
  lists: Object.entries(profile.lists || {}).map(([slug, l]) => ({ slug, title: l.title, count: l.count, ranked: l.ranked, items: l.items.map(x => x[0]) })),
};

fs.mkdirSync(OUT, { recursive: true });
const write = (name, obj) => {
  const text = JSON.stringify(obj);
  fs.writeFileSync(path.join(OUT, name), text);
  log(`wrote ${name} (${(text.length / 1024).toFixed(0)} KB)`);
};
write('radar.json', out);
write('films.json', catalogue);
write('directors.json', dirOut);
