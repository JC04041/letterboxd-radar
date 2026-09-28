// Polite HTTP client for letterboxd.com: global rate limit, bounded concurrency, retries with
// backoff, and Cloudflare-challenge detection. Challenged URLs are skipped, never worked around.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

export class Blocked extends Error {
  constructor(url) {
    super(`Cloudflare challenge for ${url}`);
    this.url = url;
  }
}

export class Http {
  constructor({ concurrency = 3, minIntervalMs = 400, maxRetries = 4, log = console.log } = {}) {
    this.concurrency = concurrency;
    this.minIntervalMs = minIntervalMs;
    this.maxRetries = maxRetries;
    this.log = log;
    this.active = 0;
    this.queue = [];
    this.nextSlot = 0;
    this.stats = { requests: 0, ok: 0, notFound: 0, challenged: 0, errors: 0, bytes: 0 };
    this.challengeStreak = 0;
  }

  async acquire() {
    if (this.active >= this.concurrency) await new Promise(r => this.queue.push(r));
    this.active++;
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    this.nextSlot = Math.max(now, this.nextSlot) + this.minIntervalMs;
    if (wait) await sleep(wait);
  }

  release() {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }

  // Returns {status, text}. 404 resolves with status 404. Challenges throw Blocked.
  async get(url) {
    await this.acquire();
    try {
      for (let attempt = 0; ; attempt++) {
        this.stats.requests++;
        let status = 0, text = '', headers;
        try {
          const res = await fetch(url, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(45000) });
          status = res.status;
          headers = res.headers;
          text = await res.text();
          this.stats.bytes += text.length;
        } catch (e) {
          this.stats.errors++;
          if (attempt >= this.maxRetries) throw e;
          await sleep(1000 * 2 ** attempt + Math.random() * 500);
          continue;
        }
        if (status === 200) {
          this.stats.ok++;
          this.challengeStreak = 0;
          return { status, text };
        }
        if (status === 404) {
          this.stats.notFound++;
          return { status, text: '' };
        }
        const challenged = headers?.get('cf-mitigated') === 'challenge' || /Just a moment|_cf_chl_opt/.test(text);
        if (challenged) {
          this.stats.challenged++;
          this.challengeStreak++;
          throw new Blocked(url);
        }
        if ((status === 429 || status >= 500) && attempt < this.maxRetries) {
          const ra = +headers?.get('retry-after');
          const backoff = ra ? ra * 1000 : 2000 * 2 ** attempt + Math.random() * 1000;
          this.log(`  ${status} on ${url}, retrying in ${Math.round(backoff / 1000)}s`);
          // Slow everyone down a little after a rate limit.
          if (status === 429) this.minIntervalMs = Math.min(this.minIntervalMs * 1.5, 5000);
          await sleep(backoff);
          continue;
        }
        this.stats.errors++;
        const err = new Error(`HTTP ${status} for ${url}`);
        err.status = status;
        throw err;
      }
    } finally {
      this.release();
    }
  }
}
