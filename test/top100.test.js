import test from 'node:test';
import assert from 'node:assert/strict';
import { diffSnapshots, rankHistory, resolveTop100 } from '../analysis/top100.js';

const snap = (t, names) => ({ t, e: names.map(n => [n.toLowerCase().replace(/ /g, '-'), n, 'film-' + n.toLowerCase().replace(/ /g, '-')]) });

test('diff: moves, entries and exits with place counts', () => {
  const a = snap('2026-01-01T00:00:00Z', ['Scorsese', 'Anderson', 'Nolan', 'Fincher']).e;
  const b = snap('2026-01-02T00:00:00Z', ['Anderson', 'Scorsese', 'Fincher', 'Kubrick']).e;
  const ch = diffSnapshots(a, b);
  assert.deepEqual(ch.find(c => c.name === 'Anderson'), { type: 'move', key: 'anderson', name: 'Anderson', from: 2, to: 1 });
  assert.deepEqual(ch.find(c => c.name === 'Scorsese'), { type: 'move', key: 'scorsese', name: 'Scorsese', from: 1, to: 2 });
  assert.deepEqual(ch.find(c => c.name === 'Fincher'), { type: 'move', key: 'fincher', name: 'Fincher', from: 4, to: 3 });
  assert.deepEqual(ch.find(c => c.type === 'enter'), { type: 'enter', key: 'kubrick', name: 'Kubrick', rank: 4 });
  assert.deepEqual(ch.find(c => c.type === 'exit'), { type: 'exit', key: 'nolan', name: 'Nolan', from: 3 });
});

test('diff: identity survives a key re-resolution (same name)', () => {
  const a = [['name:ryan-fleck-anna-boden', 'Ryan Fleck & Anna Boden', 'half-nelson']];
  const b = [['anna-boden+ryan-fleck', 'Ryan Fleck & Anna Boden', 'half-nelson']];
  assert.deepEqual(diffSnapshots(a, b), []);
});

test('diff: favourite film swap is reported', () => {
  const a = [['martin-scorsese', 'Martin Scorsese', 'goodfellas']];
  const b = [['martin-scorsese', 'Martin Scorsese', 'taxi-driver']];
  assert.deepEqual(diffSnapshots(a, b), [{ type: 'fav', key: 'martin-scorsese', name: 'Martin Scorsese', from: 'goodfellas', to: 'taxi-driver' }]);
});

test('rank history threads identities across snapshots', () => {
  const s1 = snap('2026-01-01T00:00:00Z', ['A', 'B', 'C']);
  const s2 = snap('2026-01-05T00:00:00Z', ['B', 'A', 'C']);
  const s3 = snap('2026-01-09T00:00:00Z', ['B', 'C', 'D']);
  const h = rankHistory([s1, s2, s3]);
  assert.deepEqual(h.get('a').map(p => p[1]), [1, 2, null]);
  assert.deepEqual(h.get('b').map(p => p[1]), [2, 1, 1]);
  assert.deepEqual(h.get('d').map(p => p[1]), [3]);
});

test('resolve: notes names map onto the directors of each ranked film', () => {
  const films = {
    goodfellas: { d: [['martin-scorsese', 'Martin Scorsese']] },
    'uncut-gems': { d: [['josh-safdie', 'Josh Safdie'], ['benny-safdie', 'Benny Safdie']] },
    'half-nelson': { d: [['ryan-fleck', 'Ryan Fleck']] },
  };
  const entries = resolveTop100({
    items: [{ slug: 'goodfellas' }, { slug: 'uncut-gems' }, { slug: 'half-nelson' }],
    notes: { ranked: [{ rank: 1, name: 'Martin Scorsese' }, { rank: 2, name: 'Josh & Benny Safdie' }, { rank: 3, name: 'Ryan Fleck & Anna Boden' }] },
    filmMeta: s => films[s],
    index: [{ slug: 'anna-boden', name: 'Anna Boden', weight: 1 }],
  });
  assert.equal(entries[0].key, 'martin-scorsese');
  assert.equal(entries[1].key, 'benny-safdie+josh-safdie');
  assert.equal(entries[2].key, 'anna-boden+ryan-fleck');
  assert.ok(entries[0].filmMatches);
});
