// Resolving the ranked "Top 100 filmmakers" list into director identities, and comparing
// snapshots of it over time. Shared by the scanner (which records history) and the build.
import { bestMatch, expandNames, norm, slugify } from '../scraper/names.js';

const clean = s => String(s || '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// Candidate directors known to the system: [{slug, name, weight}] where weight = films seen.
export function directorIndex(films, seen) {
  const idx = new Map();
  for (const [slug, f] of films.entries()) {
    if (!f || !f.d) continue;
    const s = seen.get(slug);
    const w = s && s[0] === 1 ? 1 : 0;
    for (const [ds, dn] of f.d) {
      const cur = idx.get(ds) || { slug: ds, name: dn, weight: 0 };
      cur.weight += w;
      idx.set(ds, cur);
    }
  }
  return [...idx.values()];
}

// Resolve a free-text name ("Melville", "Joel & Ethan Coen") to director slugs.
export function resolveName(name, { preferred = [], index = [] } = {}) {
  const parts = expandNames(name);
  const slugs = [];
  for (const p of parts) {
    const m = bestMatch(p, preferred, 40) || bestMatch(p, index, p.split(' ').length === 1 ? 60 : 50);
    if (m) slugs.push(m.slug);
  }
  return [...new Set(slugs)].sort();
}

// items: list entries in order [{slug}], notes: {ranked:[{rank,name}]}, filmMeta(slug) -> record
export function resolveTop100({ items, notes, filmMeta, index }) {
  const byRank = new Map((notes?.ranked || []).map(r => [r.rank, r.name]));
  const maxNoteRank = byRank.size ? Math.max(...byRank.keys()) : 0;
  const n = Math.max(items.length, maxNoteRank);
  const entries = [];
  for (let i = 0; i < n; i++) {
    const rank = i + 1;
    const item = items[i] || null;
    const noteName = byRank.has(rank) ? clean(byRank.get(rank)) : null;
    const meta = item ? filmMeta(item.slug) : null;
    const filmDirs = meta?.d ? meta.d.map(([slug, name]) => ({ slug, name, weight: 1 })) : [];
    let slugs, name;
    if (noteName) {
      slugs = resolveName(noteName, { preferred: filmDirs, index });
      name = noteName;
    } else {
      slugs = filmDirs.map(d => d.slug).sort();
      name = filmDirs.map(d => d.name).join(' & ') || item?.slug || `#${rank}`;
    }
    const key = slugs.length ? slugs.join('+') : `name:${slugify(name)}`;
    entries.push({
      rank,
      key,
      name,
      slugs,
      film: item?.slug || null,
      filmMatches: slugs.length > 0 && slugs.every(s => filmDirs.some(d => d.slug === s)),
    });
  }
  return entries;
}

// Identity of an entry across snapshots: resolved key, else normalised name.
const ident = e => ({ key: e[0], name: norm(e[1]) });

// Compare two snapshot entry arrays ([key, name, film]) and describe what changed.
export function diffSnapshots(prev, cur) {
  const prevByKey = new Map(), prevByName = new Map();
  (prev || []).forEach((e, i) => {
    const id = ident(e);
    if (!id.key.startsWith('name:')) prevByKey.set(id.key, i);
    prevByName.set(id.name, i);
  });
  const matched = new Set();
  const changes = [];
  cur.forEach((e, i) => {
    const id = ident(e);
    let j = prevByKey.has(id.key) ? prevByKey.get(id.key) : prevByName.get(id.name);
    if (j != null && matched.has(j)) j = undefined;
    if (j == null) {
      changes.push({ type: 'enter', key: e[0], name: e[1], rank: i + 1 });
      return;
    }
    matched.add(j);
    if (j !== i) changes.push({ type: 'move', key: e[0], name: e[1], from: j + 1, to: i + 1 });
    if (prev[j][2] && e[2] && prev[j][2] !== e[2]) changes.push({ type: 'fav', key: e[0], name: e[1], from: prev[j][2], to: e[2] });
  });
  (prev || []).forEach((e, j) => {
    if (!matched.has(j)) changes.push({ type: 'exit', key: e[0], name: e[1], from: j + 1 });
  });
  return changes;
}

// Rank of each identity at each snapshot: Map(identity -> [[t, rank|null], ...]) keyed by the
// entry's current key (identities are threaded through renames/re-resolutions).
export function rankHistory(snapshots) {
  const series = new Map(); // current key -> points
  let prev = null;
  let prevKeys = []; // position -> series key
  for (const snap of snapshots) {
    const keys = [];
    if (!prev) {
      snap.e.forEach((e, i) => {
        keys[i] = e[0];
        series.set(e[0], [[snap.t, i + 1]]);
      });
    } else {
      const prevByKey = new Map(), prevByName = new Map();
      prev.e.forEach((e, i) => {
        if (!e[0].startsWith('name:')) prevByKey.set(e[0], i);
        prevByName.set(norm(e[1]), i);
      });
      const used = new Set();
      snap.e.forEach((e, i) => {
        let j = prevByKey.has(e[0]) ? prevByKey.get(e[0]) : prevByName.get(norm(e[1]));
        if (j != null && used.has(j)) j = undefined;
        let sk;
        if (j != null) {
          used.add(j);
          sk = prevKeys[j];
          if (sk !== e[0] && !series.has(e[0])) {
            // Re-key the series to the latest identity.
            series.set(e[0], series.get(sk));
            series.delete(sk);
            sk = e[0];
          }
        } else {
          sk = e[0];
          if (!series.has(sk)) series.set(sk, []);
        }
        keys[i] = sk;
        series.get(sk).push([snap.t, i + 1]);
      });
      prev.e.forEach((e, j) => {
        if (!used.has(j) && series.has(prevKeys[j])) series.get(prevKeys[j]).push([snap.t, null]);
      });
    }
    prev = snap;
    prevKeys = keys;
  }
  return series;
}
