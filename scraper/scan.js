// Scans a Letterboxd profile and incrementally enriches a local film database.
//
// Only pages Letterboxd serves to anonymous visitors without a bot challenge are used:
//   /<user>/films/ (page 1), /<user>/watchlist/, /<user>/lists/, /<user>/list/<slug>/(page/N/),
//   /<user>/rss/, /<user>/film/<slug>/ (200 = watched, 404 = not watched), /film/<slug>/,
//   /director/<slug>/.
// The rest of the watched history is discovered by checking directors' filmographies and related
// films one by one against /<user>/film/<slug>/.
import path from 'node:path';
import { Http, Blocked } from './http.js';
import * as P from './parse.js';
import { ShardedStore, readJson, writeJson, paths, ROOT } from './store.js';
import { slugify } from './names.js';
import { directorIndex, resolveName, resolveTop100, diffSnapshots } from '../analysis/top100.js';

const cfg = readJson(path.join(ROOT, 'config.json'), {});
const USER = String(process.env.LB_USER || cfg.username || '').toLowerCase();
if (!USER) throw new Error('Set "username" in config.json');
const LB = process.env.LB_BASE || 'https://letterboxd.com';
const BUDGET_MIN = +(process.env.RADAR_BUDGET_MIN || cfg.budgetMinutes || 20);
const FULL_EVERY_H = +(cfg.fullScanHours || 6);
const MODE = process.env.RADAR_MODE || 'auto';

const t0 = Date.now();
const deadline = t0 + BUDGET_MIN * 60e3;
const timeLeft = () => deadline - Date.now();
const today = () => new Date().toISOString().slice(0, 10);
const nowIso = () => new Date().toISOString();
const daysSince = d => (d ? (Date.now() - Date.parse(d)) / 864e5 : Infinity);
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s]`, ...a);

const rps = +(cfg.requestsPerSecond || 2);
const http = new Http({ concurrency: +(cfg.concurrency || 3), minIntervalMs: Math.round(1000 / rps), log });

const films = new ShardedStore('films', 64);
const seen = new ShardedStore('seen', 32);
const directors = new ShardedStore('directors', 32);
const profile = readJson(paths.profile(), {});
const events = readJson(paths.events(), []);
const diary = readJson(paths.diary(), []);
const history = readJson(paths.history(), { snapshots: [] });
const baseline = !profile.firstScan; // first ever run: record state, emit no "new" events
const run = { t: nowIso(), mode: MODE, jobs: {}, blocked: 0, notes: [] };

function emit(ev) {
  if (baseline) return;
  events.push({ t: nowIso(), ...ev });
}

// ---------- seen-state helpers: [status 1|0, rating, liked 1|0, lastWatched, checked, source] ----------
function markSeen(slug, { rating = null, liked = null, date = null, source, title = null, year = null }) {
  const prev = seen.get(slug);
  const wasSeen = prev?.[0] === 1;
  const rec = [
    1,
    rating ?? prev?.[1] ?? null,
    liked == null ? prev?.[2] ?? 0 : liked ? 1 : 0,
    date || prev?.[3] || null,
    today(),
    wasSeen && source === 'list' ? prev[5] : source,
  ];
  if (!wasSeen) {
    // A film we had verified as unseen is now watched, or a new film appeared on page 1.
    if (prev?.[0] === 0 || (source === 'p1' && profile.firstScan)) emit({ type: 'watch', slug, title, year, rating: rec[1], via: source });
  } else if (source !== 'list') {
    if (rating != null && prev[1] != null && rating !== prev[1]) emit({ type: 'rate', slug, title, from: prev[1], to: rating });
    if (liked === true && !prev[2]) emit({ type: 'like', slug, title });
  }
  seen.set(slug, rec);
}

function markUnseen(slug) {
  const prev = seen.get(slug);
  if (prev && prev[0] === 1) {
    // Removed from the watched set (rare): record it.
    emit({ type: 'unwatch', slug });
  }
  seen.set(slug, [0, null, 0, null, today(), 'm']);
}

// ---------- fetchers ----------
async function page(url) {
  const r = await http.get(url);
  return r.status === 200 ? r.text : null;
}

function compactFilm(f) {
  return {
    t: f.title,
    y: f.year,
    d: f.directors.map(d => [d.slug, d.name]),
    g: f.genres,
    th: f.themes.slice(0, 10),
    c: f.countries.slice(0, 3),
    l: (f.languages || []).slice(0, 2),
    rt: f.runtime,
    a: f.avg,
    n: f.ratings,
    p: f.poster ? f.poster.replace('https://a.ltrbxd.com/resized/', '') : null,
    tv: f.tv ? 1 : 0,
    tmdb: f.tmdb,
    cast: f.cast.slice(0, 8).map(p => [p.slug, p.name]),
    st: f.studios.slice(0, 2),
    rel: f.related.slice(0, 8),
    syn: f.synopsis.slice(0, 260),
    at: today(),
  };
}

async function fetchFilm(slug) {
  const r = await http.get(`${LB}/film/${slug}/`);
  if (r.status === 404) {
    films.set(slug, { gone: 1, at: today() });
    return null;
  }
  const rec = compactFilm(P.parseFilmPage(r.text, slug));
  films.set(slug, rec);
  return rec;
}

async function checkSeen(slug) {
  const r = await http.get(`${LB}/${USER}/film/${slug}/`);
  if (r.status === 404) return markUnseen(slug);
  const m = P.parseMemberFilm(r.text);
  markSeen(slug, { rating: m.rating, liked: m.liked, date: m.watchedDate, source: 'm', title: m.title });
}

async function fetchDirector(slug, { announce = false } = {}) {
  const r = await http.get(`${LB}/director/${slug}/`);
  if (r.status === 404) {
    directors.set(slug, { n: null, f: [], c: today(), gone: 1 });
    return null;
  }
  const items = P.parsePosterGrid(r.text);
  const rec = { n: P.parsePersonName(r.text), f: items.map(i => [i.slug, i.title, i.year]), c: today() };
  const prev = directors.get(slug);
  if (announce && prev && prev.f && prev.f.length && !baseline) {
    const old = new Set(prev.f.map(x => x[0]));
    for (const it of items) if (!old.has(it.slug)) emit({ type: 'newfilm', director: slug, name: rec.n, slug: it.slug, title: it.title, year: it.year });
  }
  directors.set(slug, rec);
  return rec;
}

// Fetch every page of a list (list pagination via /page/N/ is allowed).
async function fetchList(owner, slug) {
  const first = await page(`${LB}/${owner}/list/${slug}/`);
  if (!first) return null;
  const meta = P.parseListMeta(first);
  let items = P.parsePosterGrid(first);
  const last = Math.min(P.parseLastPage(first), 20);
  for (let p = 2; p <= last; p++) {
    const html = await page(`${LB}/${owner}/list/${slug}/page/${p}/`);
    if (html) items = items.concat(P.parsePosterGrid(html));
  }
  return { meta, items };
}

// ---------- phase 1: profile ----------
async function scanRss() {
  const r = await http.get(`${LB}/${USER}/rss/`);
  const items = P.parseRss(r.text);
  const known = new Set(diary.map(d => d.id));
  let added = 0;
  // Oldest first so events are in chronological order.
  for (const it of [...items].reverse()) {
    if (known.has(it.id)) continue;
    diary.push(it);
    added++;
    const prev = seen.get(it.slug);
    if (!baseline && (!prev || prev[0] !== 1 || it.rewatch))
      emit({ type: 'watch', slug: it.slug, title: it.title, year: it.year, rating: it.rating, liked: it.liked, rewatch: it.rewatch, date: it.watchedDate, via: 'diary', review: it.review ? it.review.slice(0, 200) : undefined });
    const prevRating = prev?.[1];
    seen.set(it.slug, [1, it.rating ?? prevRating ?? null, it.liked ? 1 : prev?.[2] ?? 0, it.watchedDate || prev?.[3] || null, today(), prev?.[5] === 'm' ? 'm' : 'rss']);
    if (!baseline && prev && prev[0] === 1 && prevRating != null && it.rating != null && prevRating !== it.rating)
      emit({ type: 'rate', slug: it.slug, title: it.title, from: prevRating, to: it.rating });
  }
  diary.sort((a, b) => (a.watchedDate || '').localeCompare(b.watchedDate || '') || a.id.localeCompare(b.id));
  log(`rss: ${items.length} items, ${added} new diary entries`);
}

async function scanFilmsPage1() {
  const html = await page(`${LB}/${USER}/films/`);
  if (!html) throw new Error('Could not load the films page');
  const total = P.parseWatchedCount(html);
  if (total) profile.watchedTotal = total;
  const items = P.parsePosterGrid(html);
  for (const it of items) markSeen(it.slug, { rating: it.rating, liked: it.liked, source: 'p1', title: it.title, year: it.year });
  profile.recent = items.map(i => i.slug);
  log(`films page 1: ${items.length} films, profile total ${total}`);
}

async function scanWatchlist() {
  const html = await page(`${LB}/${USER}/watchlist/`);
  if (!html) return;
  let items = P.parsePosterGrid(html);
  const last = Math.min(P.parseLastPage(html), 30);
  for (let p = 2; p <= last; p++) {
    const more = await page(`${LB}/${USER}/watchlist/page/${p}/`);
    if (more) items = items.concat(P.parsePosterGrid(more));
  }
  const cur = items.map(i => i.slug);
  const prev = new Set(profile.watchlist || []);
  const now = new Set(cur);
  for (const s of cur) if (!prev.has(s)) emit({ type: 'wl+', slug: s, title: items.find(i => i.slug === s)?.title });
  for (const s of prev) if (!now.has(s)) emit({ type: 'wl-', slug: s });
  profile.watchlist = cur;
  log(`watchlist: ${cur.length} films`);
}

function pickTopList(lists) {
  if (cfg.top100List) return lists.find(l => l.slug === cfg.top100List) || { slug: cfg.top100List, title: cfg.top100List };
  const people = /(film\s*-?makers?|directors?|auteurs?)/i;
  return (
    lists.find(l => /top\s*100/i.test(l.title) && people.test(l.title)) ||
    lists.find(l => people.test(l.title) && (l.count || 0) >= 50) ||
    lists.find(l => people.test(l.title)) ||
    null
  );
}

async function scanLists(full) {
  const html = await page(`${LB}/${USER}/lists/`);
  const index = html ? P.parseListsIndex(html) : profile.listsIndex || [];
  if (html) profile.listsIndex = index.map(({ slug, title, count, description }) => ({ slug, title, count, description: description.slice(0, 300) }));
  const top = pickTopList(index);
  profile.top100 = profile.top100 || {};
  const lists = profile.lists || {};
  for (const l of index) {
    const isTop = top && l.slug === top.slug;
    const stale = !lists[l.slug] || lists[l.slug].count !== l.count || full;
    if (!isTop && !stale) continue;
    const got = await fetchList(USER, l.slug);
    if (!got) continue;
    lists[l.slug] = {
      title: l.title,
      count: l.count,
      ranked: got.meta.ranked,
      updated: got.meta.updated,
      at: today(),
      items: got.items.map(i => [i.slug, i.ownerRating || 0]),
    };
    // A rating on a list entry is the owner's rating: proof they have seen it.
    for (const i of got.items) if (i.ownerRating) markSeen(i.slug, { rating: i.ownerRating, source: 'list', title: i.title, year: i.year });
    if (isTop) {
      profile.top100.slug = l.slug;
      profile.top100.title = l.title;
      profile.top100.updated = got.meta.updated;
      profile.top100.notes = P.parseRankedNotes(got.meta.description);
      profile.top100.items = got.items.map(i => ({ slug: i.slug, title: i.title, year: i.year }));
    }
  }
  // Drop lists that no longer exist.
  if (html) for (const k of Object.keys(lists)) if (!index.some(l => l.slug === k)) delete lists[k];
  profile.lists = lists;
  log(`lists: ${index.length} lists; top list = ${top ? top.title : 'not found'}`);
}

// Resolve the top list into director identities and record a snapshot if it changed.
async function trackTop100() {
  const t = profile.top100;
  if (!t || !t.items) return;
  // Metadata for every list film is needed to know whose film it is.
  const missing = t.items.map(i => i.slug).filter(s => !films.has(s));
  await Promise.all(missing.map(s => fetchFilm(s).catch(e => onJobError(e, 'meta', s))));
  const index = directorIndex(films, seen);
  const entries = resolveTop100({ items: t.items, notes: t.notes, filmMeta: s => films.get(s), index });
  // "Possibly soon" and any other sections under the ranking.
  const sections = (t.notes?.sections || []).map(sec => ({
    heading: sec.heading,
    names: sec.names.map(n => ({ name: n, slugs: resolveName(n, { index }) })),
  }));
  // Try direct slugs for unresolved multi-word names ("Carol Reed" -> /director/carol-reed/).
  for (const sec of sections) {
    for (const x of sec.names) {
      if (x.slugs.length || x.name.trim().split(/\s+/).length < 2) continue;
      const guess = slugify(x.name);
      if (!directors.has(guess)) await fetchDirector(guess).catch(e => onJobError(e, 'director', guess));
      const d = directors.get(guess);
      if (d && d.f && d.f.length) x.slugs = [guess];
    }
  }
  t.entries = entries;
  t.sections = sections;
  const cur = { t: nowIso(), list: t.slug, e: entries.map(e => [e.key, e.name, e.film]) };
  const soon = sections.flatMap(s => s.names.map(n => n.name));
  const last = history.snapshots[history.snapshots.length - 1];
  const changes = last ? diffSnapshots(last.e, cur.e) : [];
  const soonChanged = last && JSON.stringify(last.soon || []) !== JSON.stringify(soon);
  if (!last || changes.length || soonChanged) {
    cur.soon = soon;
    history.snapshots.push(cur);
    if (last) {
      for (const c of changes) events.push({ t: cur.t, ...c });
      const before = new Set(last.soon || []);
      for (const n of soon) if (!before.has(n)) events.push({ t: cur.t, type: 'soon+', name: n });
      for (const n of before) if (!soon.includes(n)) events.push({ t: cur.t, type: 'soon-', name: n });
    }
    log(`top100: ${last ? `${changes.length} changes recorded` : 'baseline snapshot recorded'}`);
  } else {
    // Same order and names: refresh identities in place (resolution improves as data arrives).
    last.e = cur.e;
    log('top100: no changes');
  }
}

// ---------- phase 2: enrichment ----------
function onJobError(e, type, key) {
  if (e instanceof Blocked) {
    run.blocked++;
    return;
  }
  run.notes.push(`${type} ${key}: ${String(e.message || e).slice(0, 120)}`);
}

// Work queues in priority order, recomputed between batches as new data arrives. Each queue has
// a per-run cap so long discovery queues cannot starve the ones after them.
function planJobs() {
  const q = [];
  const add = (name, type, keys, cap = Infinity) => keys.length && q.push({ name, type, keys, cap });
  const rec = s => seen.get(s);
  const unverified = list => [...new Set(list)].filter(s => !seen.has(s));
  const t = profile.top100 || {};
  const topSlugs = new Set((t.entries || []).flatMap(e => e.slugs));
  const soonSlugs = new Set((t.sections || []).flatMap(s => s.names.flatMap(n => n.slugs)));
  const coreDirs = [...new Set([...topSlugs, ...soonSlugs])];
  const coreSet = new Set(coreDirs);

  // 1. Metadata for films known to be seen (taste model + director stats), best-rated first.
  const seenNoMeta = [];
  for (const [s, r] of seen.entries()) if (r[0] === 1 && !films.has(s)) seenNoMeta.push([s, r[1] || 0]);
  seenNoMeta.sort((a, b) => b[1] - a[1]);
  add('meta:seen', 'meta', seenNoMeta.map(x => x[0]));

  // 2. Filmographies of the top 100 + possibly-soon directors, then seen-check all of their films.
  add('director:core', 'director', coreDirs.filter(d => !directors.has(d)));
  const coreFilms = coreDirs.flatMap(d => (directors.get(d)?.f || []).map(x => x[0]));
  add('verify:core', 'verify', unverified(coreFilms));
  add('meta:core-unseen', 'meta', coreFilms.filter(s => rec(s)?.[0] === 0 && !films.has(s)));

  // 3. Discovery: directors of seen films (most-watched first), related films, other filmographies.
  const dirCount = new Map();
  for (const [s, r] of seen.entries()) {
    if (r[0] !== 1) continue;
    for (const [ds] of films.get(s)?.d || []) dirCount.set(ds, (dirCount.get(ds) || 0) + 1);
  }
  const dirsByWeight = [...dirCount.entries()].sort((a, b) => b[1] - a[1]);
  add('director:seen', 'director', dirsByWeight.map(x => x[0]).filter(d => !directors.has(d)), 400);
  const related = [];
  for (const [s, r] of seen.entries()) if (r[0] === 1 && (r[1] || 0) >= 3.5) for (const x of films.get(s)?.rel || []) related.push(x);
  add('verify:related', 'verify', unverified(related), 700);
  const other = [];
  for (const [d, n] of dirsByWeight) {
    if (coreSet.has(d)) continue;
    const depth = n >= 3 ? 80 : n === 2 ? 30 : 12;
    for (const x of (directors.get(d)?.f || []).slice(0, depth)) other.push(x[0]);
  }
  add('verify:other', 'verify', unverified(other), 1200);

  // 4. Recommendation candidates: related films of loved films, canon lists, well-liked directors.
  const canon = [...new Set(Object.values(profile.canon || {}).flatMap(c => c.items || []))];
  add('verify:canon', 'verify', unverified(canon), 400);
  const cand = new Set(canon);
  for (const [s, r] of seen.entries()) if (r[0] === 1 && (r[1] || 0) >= 4) for (const x of films.get(s)?.rel || []) cand.add(x);
  for (const [d, n] of dirsByWeight) if (n >= 2) for (const x of (directors.get(d)?.f || []).slice(0, 30)) cand.add(x[0]);
  for (const s of profile.watchlist || []) cand.add(s);
  add('meta:candidates', 'meta', [...cand].filter(s => (rec(s)?.[0] === 0 || (profile.watchlist || []).includes(s)) && !films.has(s)), 800);

  // 5. Maintenance: new releases, rating changes, films watched without a diary entry, crowd drift.
  add('director:refresh', 'director', [...coreDirs, ...dirsByWeight.slice(0, 250).map(x => x[0])].filter(d => daysSince(directors.get(d)?.c) > 30), 40);
  const reverify = [];
  for (const [s, r] of seen.entries()) if (r[0] === 0 && daysSince(r[4]) > 21 && (films.get(s)?.n || 0) > 20000) reverify.push([s, films.get(s).n]);
  reverify.sort((a, b) => b[1] - a[1]);
  add('verify:recheck-unseen', 'verify', reverify.map(x => x[0]), 40);
  const reSeen = [];
  for (const [s, r] of seen.entries()) if (r[0] === 1 && r[5] !== 'p1' && daysSince(r[4]) > 60) reSeen.push(s);
  add('verify:recheck-seen', 'verify', reSeen, 30);
  const staleMeta = [];
  for (const [s, f] of films.entries()) if (!f.gone && daysSince(f.at) > 60) staleMeta.push(s);
  add('meta:refresh', 'meta', staleMeta, 80);
  return { queues: q, coreSet };
}

async function runJob(type, key, coreSet) {
  if (type === 'meta') return fetchFilm(key);
  if (type === 'verify') return checkSeen(key);
  if (type === 'director') return fetchDirector(key, { announce: coreSet.has(key) });
}

async function enrich() {
  let batches = 0;
  const done = new Set();
  const used = {};
  let round = 0;
  while (timeLeft() > 30e3) {
    const { queues, coreSet } = planJobs();
    let picked = null;
    for (const qu of queues) {
      if ((used[qu.name] || 0) >= qu.cap * (round + 1)) continue;
      const todo = qu.keys.filter(k => !done.has(qu.type + ':' + k));
      if (!todo.length) continue;
      const room = qu.cap * (round + 1) - (used[qu.name] || 0);
      picked = { ...qu, keys: todo.slice(0, Math.min(qu.type === 'director' ? 12 : 60, room)) };
      break;
    }
    if (!picked) {
      // Every queue hit its cap: start another round if anything is left.
      const remaining = queues.some(qu => qu.keys.some(k => !done.has(qu.type + ':' + k)));
      if (!remaining) break;
      round++;
      continue;
    }
    used[picked.name] = (used[picked.name] || 0) + picked.keys.length;
    await Promise.all(
      picked.keys.map(async k => {
        done.add(picked.type + ':' + k);
        if (timeLeft() < 20e3) return;
        run.jobs[picked.name] = (run.jobs[picked.name] || 0) + 1;
        await runJob(picked.type, k, coreSet).catch(e => onJobError(e, picked.type, k));
      }),
    );
    if (http.challengeStreak >= 8) {
      run.notes.push('stopped early: repeated Cloudflare challenges');
      log('too many challenges in a row; stopping enrichment for this run');
      break;
    }
    if (++batches % 10 === 0) {
      saveStores();
      log(`progress: ${JSON.stringify(run.jobs)} | seen ${countSeen()}/${profile.watchedTotal ?? '?'} | films ${films.size} | directors ${directors.size}`);
    }
  }
  const { queues } = planJobs();
  run.pending = Object.fromEntries(queues.map(qu => [qu.name, qu.keys.length]));
}

async function scanCanon(force) {
  profile.canon = profile.canon || {};
  for (const ref of cfg.canonLists || []) {
    const c = profile.canon[ref];
    if (!force && c && daysSince(c.at) < 7) continue;
    if (timeLeft() < 60e3) return;
    const [owner, , slug] = ref.split('/');
    const got = await fetchList(owner, slug).catch(e => onJobError(e, 'list', ref));
    profile.canon[ref] = got ? { title: got.meta.title, at: today(), items: got.items.map(i => i.slug) } : { title: ref, at: today(), items: [], missing: true };
  }
}

function countSeen() {
  let n = 0;
  for (const r of seen.values()) if (r[0] === 1) n++;
  return n;
}

function saveStores() {
  films.save();
  seen.save();
  directors.save();
}

function saveAll() {
  saveStores();
  if (!profile.firstScan) profile.firstScan = run.t;
  profile.username = USER;
  profile.lastScan = run.t;
  writeJson(paths.profile(), profile, { pretty: true });
  writeJson(paths.diary(), diary.slice(-3000), { pretty: true });
  writeJson(paths.history(), history, { pretty: false });
  writeJson(paths.events(), events.slice(-3000), { pretty: true });
  // One stats row per day for trend charts.
  const daily = readJson(paths.daily(), {});
  let rated = 0, sum = 0, n = 0;
  for (const r of seen.values())
    if (r[0] === 1) {
      n++;
      if (r[1]) {
        rated++;
        sum += r[1];
      }
    }
  daily[today()] = { found: n, total: profile.watchedTotal ?? null, rated, avg: rated ? +(sum / rated).toFixed(3) : null, watchlist: (profile.watchlist || []).length, films: films.size, directors: directors.size };
  writeJson(paths.daily(), daily, { pretty: true });
  const scanLog = readJson(paths.scanLog(), []);
  scanLog.push({ ...run, seconds: Math.round((Date.now() - t0) / 1000), http: http.stats, found: n, total: profile.watchedTotal ?? null });
  writeJson(paths.scanLog(), scanLog.slice(-300), { pretty: true });
}

async function main() {
  log(`scan start: user=${USER} mode=${MODE} budget=${BUDGET_MIN}m baseline=${baseline}`);
  const full = MODE === 'full' || baseline || daysSince(profile.lastFull) * 24 >= FULL_EVERY_H;
  run.full = full;
  try {
    await scanRss();
    await scanFilmsPage1();
    await scanWatchlist();
    await scanLists(full);
    await trackTop100();
    if (full) profile.lastFull = run.t;
    await scanCanon(false);
    if (MODE !== 'quick') await enrich();
  } catch (e) {
    run.notes.push(`fatal: ${e.message}`);
    log('ERROR', e);
    saveAll();
    process.exitCode = 1;
    return;
  }
  saveAll();
  log(`done: ${JSON.stringify(run.jobs)} blocked=${run.blocked} http=${JSON.stringify(http.stats)} seen=${countSeen()}/${profile.watchedTotal}`);
}

main();
