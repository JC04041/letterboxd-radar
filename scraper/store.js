// Persistent state kept in data/ and committed by the workflow. Large caches are sharded so an
// hourly commit only touches the shards that changed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = process.env.RADAR_DATA ? path.resolve(process.env.RADAR_DATA) : path.join(ROOT, 'data');

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Writes only when content changed (keeps git diffs and commits minimal).
export function writeJson(file, value, { pretty = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = pretty ? JSON.stringify(value, null, 1) + '\n' : JSON.stringify(value) + '\n';
  let old = null;
  try {
    old = fs.readFileSync(file, 'utf8');
  } catch {}
  if (old === text) return false;
  fs.writeFileSync(file, text);
  return true;
}

function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

// Map-like store split into N JSON shards on disk. Each record is stored one per line so git can
// delta-compress efficiently.
export class ShardedStore {
  constructor(dir, shards = 32) {
    this.dir = path.join(DATA, dir);
    this.shards = shards;
    this.map = new Map();
    this.dirty = new Set();
    this.load();
  }
  shardOf(key) {
    return fnv1a(key) % this.shards;
  }
  file(i) {
    return path.join(this.dir, `${String(i).padStart(2, '0')}.json`);
  }
  load() {
    for (let i = 0; i < this.shards; i++) {
      const obj = readJson(this.file(i), {});
      for (const [k, v] of Object.entries(obj)) this.map.set(k, v);
    }
  }
  get(key) {
    return this.map.get(key);
  }
  has(key) {
    return this.map.has(key);
  }
  set(key, value) {
    this.map.set(key, value);
    this.dirty.add(this.shardOf(key));
  }
  delete(key) {
    if (this.map.delete(key)) this.dirty.add(this.shardOf(key));
  }
  get size() {
    return this.map.size;
  }
  entries() {
    return this.map.entries();
  }
  values() {
    return this.map.values();
  }
  save() {
    if (!this.dirty.size) return 0;
    const buckets = new Map([...this.dirty].map(i => [i, []]));
    for (const [k, v] of this.map) {
      const i = this.shardOf(k);
      if (buckets.has(i)) buckets.get(i).push([k, v]);
    }
    fs.mkdirSync(this.dir, { recursive: true });
    for (const [i, rows] of buckets) {
      rows.sort((a, b) => (a[0] < b[0] ? -1 : 1));
      const body = '{\n' + rows.map(([k, v]) => JSON.stringify(k) + ':' + JSON.stringify(v)).join(',\n') + '\n}\n';
      fs.writeFileSync(this.file(i), body);
    }
    const n = this.dirty.size;
    this.dirty.clear();
    return n;
  }
}

export const paths = {
  profile: () => path.join(DATA, 'profile.json'),
  top100: () => path.join(DATA, 'top100.json'),
  history: () => path.join(DATA, 'history', 'top100-snapshots.json'),
  events: () => path.join(DATA, 'history', 'events.json'),
  daily: () => path.join(DATA, 'history', 'daily.json'),
  scanLog: () => path.join(DATA, 'scan-log.json'),
  diary: () => path.join(DATA, 'diary.json'),
};
