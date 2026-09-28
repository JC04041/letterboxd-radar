import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as P from '../scraper/parse.js';
import { bestMatch, expandNames } from '../scraper/names.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fx = name => zlib.gunzipSync(fs.readFileSync(path.join(dir, `${name}.html.gz`))).toString('utf8');

test('profile films grid: slugs, ratings, likes, pagination', () => {
  const html = fx('films1');
  const films = P.parsePosterGrid(html);
  assert.equal(films.length, 72);
  assert.deepEqual(
    { slug: films[1].slug, title: films[1].title, year: films[1].year, rating: films[1].rating, liked: films[1].liked },
    { slug: 'resident-evil-2026', title: 'Resident Evil', year: 2026, rating: 4, liked: true },
  );
  assert.ok(films.every(f => f.rating == null || (f.rating >= 0.5 && f.rating <= 5)));
  assert.equal(P.parseLastPage(html), 30);
});

test('ranked list: order, owner ratings and notes', () => {
  const html = fx('list7');
  const items = P.parsePosterGrid(html);
  assert.equal(items.length, 100);
  assert.equal(items[0].slug, 'goodfellas');
  assert.equal(items[0].listNumber, 1);
  assert.equal(items[0].ownerRating, 5);
  assert.equal(items[99].listNumber, 100);
  const meta = P.parseListMeta(html);
  assert.ok(meta.ranked);
  const notes = P.parseRankedNotes(meta.description);
  assert.equal(notes.ranked.length, 100);
  assert.deepEqual(notes.ranked[0], { rank: 1, name: 'Martin Scorsese' });
  assert.equal(notes.ranked[15].name, 'Josh & Benny Safdie');
  assert.equal(notes.sections[0].heading, 'Possibly Soon');
  assert.ok(notes.sections[0].names.includes('Carol Reed'));
});

test('lists index', () => {
  const lists = P.parseListsIndex(fx('lists'));
  assert.ok(lists.length >= 10);
  const top = lists.find(l => l.slug === 'favourite-from-my-top-100-filmmakers');
  assert.equal(top.count, 100);
  assert.equal(top.title, 'Favourite From My Top 100 Filmmakers');
});

test('film page: JSON-LD metadata, themes, related films', () => {
  const f = P.parseFilmPage(fx('film'), 'pulp-fiction');
  assert.equal(f.title, 'Pulp Fiction');
  assert.equal(f.year, 1994);
  assert.deepEqual(f.directors, [{ slug: 'quentin-tarantino', name: 'Quentin Tarantino' }]);
  assert.ok(f.genres.includes('crime'));
  assert.ok(f.themes.length > 3);
  assert.equal(f.runtime, 154);
  assert.ok(f.avg > 3 && f.avg <= 5);
  assert.ok(f.ratings > 1e6);
  assert.match(f.poster, /^https:\/\/a\.ltrbxd\.com\//);
  assert.equal(f.tmdb, 680);
  assert.ok(f.related.includes('reservoir-dogs'));
  assert.ok(!f.related.includes('pulp-fiction'));
});

test('director filmography', () => {
  const html = fx('director');
  const films = P.parsePosterGrid(html);
  assert.equal(P.parsePersonName(html), 'Quentin Tarantino');
  assert.ok(films.some(f => f.slug === 'pulp-fiction'));
  assert.ok(films.length >= 10);
});

test('rss diary feed', () => {
  const items = P.parseRss(fx('rss'));
  assert.ok(items.length > 10);
  const first = items[0];
  assert.ok(first.id.startsWith('letterboxd-'));
  assert.match(first.watchedDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(first.slug);
});

test('watchlist grid', () => {
  assert.ok(P.parsePosterGrid(fx('watchlist')).length > 0);
});

test('name matching for list notes', () => {
  const c = [
    { slug: 'jean-pierre-melville', name: 'Jean-Pierre Melville', weight: 3 },
    { slug: 'kenneth-lonergan', name: 'Kenneth Lonergan', weight: 2 },
    { slug: 'jonathan-demme', name: 'Jonathan Demme', weight: 5 },
    { slug: 'ted-demme', name: 'Ted Demme', weight: 1 },
    { slug: 'bong-joon-ho', name: 'Bong Joon Ho' },
  ];
  assert.equal(bestMatch('Melville', c).slug, 'jean-pierre-melville');
  assert.equal(bestMatch('Kenneth Lonnergan', c).slug, 'kenneth-lonergan');
  assert.equal(bestMatch('Demme', c).slug, 'jonathan-demme');
  assert.equal(bestMatch('Bong Joon-ho', c).slug, 'bong-joon-ho');
  assert.equal(bestMatch('Carol Reed', c), null);
  assert.deepEqual(expandNames('Joel & Ethan Coen'), ['joel coen', 'ethan coen']);
});

test('member film page: rating, like, watch date', () => {
  assert.deepEqual(P.parseMemberFilm(fx('m_goodfellas')), { rating: 5, liked: true, watchedDate: '2023-03-21', title: 'GoodFellas' });
  const h = P.parseMemberFilm(fx('m_heart'));
  assert.equal(h.rating, 3);
  assert.equal(h.liked, false);
});

test('watched total from films page', () => {
  assert.equal(P.parseWatchedCount(fx('films1')), 2098);
});
