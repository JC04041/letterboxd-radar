// Matching free-text director names (from list notes) to Letterboxd director records.

export function norm(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/[^a-z0-9& ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function slugify(s) {
  return norm(s).replace(/&/g, ' ').trim().replace(/\s+/g, '-');
}

// "Josh & Benny Safdie" -> ["josh safdie", "benny safdie"]; "Michael Powell & Emeric Pressburger"
// -> ["michael powell", "emeric pressburger"]; "Joel & Ethan Coen" -> ["joel coen", "ethan coen"].
export function expandNames(name) {
  const parts = norm(name)
    .split(/\s*(?:&|\band\b|\/|,)\s*/)
    .map(p => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return parts;
  const last = parts[parts.length - 1].split(' ');
  const surname = last.length > 1 ? last[last.length - 1] : null;
  return parts.map(p => (p.split(' ').length === 1 && surname && p !== parts[parts.length - 1] ? `${p} ${surname}` : p));
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// How well a free-text name matches a director's full name (0 = no match, higher = better).
export function nameScore(query, fullName) {
  const q = norm(query), f = norm(fullName);
  if (!q || !f) return 0;
  if (q === f) return 100;
  const qt = q.split(' '), ft = f.split(' ');
  const qLast = qt[qt.length - 1], fLast = ft[ft.length - 1];
  // Single-word query: surname match ("Melville", "Wyler", "Demme").
  if (qt.length === 1) {
    if (qLast === fLast) return 70;
    if (ft.includes(qLast)) return 55;
    if (qLast.length > 5 && levenshtein(qLast, fLast) <= 1) return 45;
    return 0;
  }
  // Multi-word: surname must match (allowing a typo), first names should agree.
  const lastDist = levenshtein(qLast, fLast);
  if (lastDist > (qLast.length > 6 ? 2 : 1)) return 0;
  const firstQ = qt[0], firstF = ft[0];
  let s = 60 - lastDist * 8;
  if (firstQ === firstF) s += 25;
  else if (levenshtein(firstQ, firstF) <= 1) s += 15;
  else if (firstQ[0] === firstF[0]) s += 5;
  else s -= 30;
  if (levenshtein(q, f) <= 2) s = Math.max(s, 90);
  return Math.max(0, s);
}

// Pick the best director for a query from candidates [{slug, name, weight}] (weight breaks ties,
// e.g. how many of their films the user has watched).
export function bestMatch(query, candidates, minScore = 40) {
  let best = null;
  for (const c of candidates) {
    const s = nameScore(query, c.name);
    if (s < minScore) continue;
    const key = s * 1000 + (c.weight || 0);
    if (!best || key > best.key) best = { ...c, score: s, key };
  }
  return best;
}
