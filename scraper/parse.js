// Parsers for Letterboxd pages. Written against the live markup (LazyPoster react components,
// JSON-LD on film pages) with fallbacks for the older poster markup.
import * as cheerio from 'cheerio';

const decode = s =>
  s == null
    ? s
    : String(s)
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;|&apos;/g, "'")
        .replace(/&#034;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&');

export function isChallenge(status, body) {
  if (status === 403 || status === 503 || status === 429) {
    return /Just a moment|challenge-platform|cf-mitigated|_cf_chl_opt|Attention Required/i.test(body || '') || status !== 404;
  }
  return false;
}

function slugFromLink(link) {
  const m = /\/film\/([^/]+)\//.exec(link || '');
  return m ? m[1] : null;
}

// Split "Title (1999)" into title + year.
export function splitNameYear(name) {
  const m = /^(.*)\s+\((\d{4})\)$/.exec(name || '');
  return m ? { title: m[1], year: +m[2] } : { title: name || '', year: null };
}

// Parse any poster grid (profile films, watchlist, lists, director pages, similar films).
// Returns [{slug, title, year, filmId, rating (0.5-5|null), liked, listNumber, ownerRating}]
export function parsePosterGrid(html) {
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  const nodes = $('[data-item-slug], [data-film-slug], div.film-poster[data-target-link]');
  nodes.each((_, el) => {
    const $el = $(el);
    const slug =
      $el.attr('data-item-slug') ||
      $el.attr('data-film-slug') ||
      slugFromLink($el.attr('data-item-link') || $el.attr('data-target-link'));
    if (!slug) return;
    // Items inside the page header / sidebars (e.g. the "backdrop" film) are not grid items.
    const $li = $el.closest('li');
    if (!$li.length) return;
    const key = slug + '|' + ($li.attr('data-object-id') || $li.index());
    if (seen.has(key)) return;
    seen.add(key);
    const name = decode($el.attr('data-item-name') || $el.attr('data-film-name') || $el.find('img').attr('alt') || '');
    const { title, year } = splitNameYear(name);
    let filmId = null;
    const ident = $el.attr('data-postered-identifier');
    if (ident) {
      const m = /film:(\d+)/.exec(decode(ident));
      if (m) filmId = +m[1];
    }
    if (!filmId && $el.attr('data-film-id')) filmId = +$el.attr('data-film-id');
    const $vd = $li.find('.poster-viewingdata');
    let rating = null;
    const rm = /rated-(\d+)/.exec($vd.find('.rating').attr('class') || '');
    if (rm) rating = +rm[1] / 2;
    const liked = $vd.find('.like, .icon-liked, .liked-micro').length > 0 || /-liked/.test($vd.attr('class') || '');
    const numTxt = $li.find('.list-number').first().text().trim();
    const ownerRating = $li.attr('data-owner-rating');
    out.push({
      slug,
      title,
      year: year ?? null,
      filmId,
      rating,
      liked,
      listNumber: numTxt ? +numTxt : null,
      ownerRating: ownerRating && +ownerRating ? +ownerRating / 2 : null,
    });
  });
  return out;
}

export function parseLastPage(html) {
  const $ = cheerio.load(html);
  let max = 1;
  $('.paginate-pages a, .paginate-page a').each((_, a) => {
    const n = parseInt($(a).text().trim(), 10);
    if (n > max) max = n;
  });
  return max;
}

// The user's lists index.
export function parseListsIndex(html) {
  const $ = cheerio.load(html);
  const lists = [];
  $('article.list-summary, section.list, div.listitem').each((_, el) => {
    const $el = $(el);
    const a = $el.find('h2 a, h2.name a, .title-2 a').first();
    const href = a.attr('href');
    if (!href || !/\/list\//.test(href)) return;
    if (lists.some(l => l.href === href)) return;
    const countTxt = $el.find('.value').first().text();
    const cm = /([\d,]+)\s*film/.exec(countTxt.replace(/ /g, ' '));
    const desc = $el.find('.body-text, .notes').first().text().trim();
    lists.push({
      href,
      slug: /\/list\/([^/]+)\//.exec(href)[1],
      title: a.text().trim(),
      count: cm ? +cm[1].replace(/,/g, '') : null,
      description: desc,
      filmListId: $el.find('[data-film-list-id]').addBack('[data-film-list-id]').attr('data-film-list-id') || null,
    });
  });
  return lists;
}

// Page title + description for a list page.
export function parseListMeta(html) {
  const $ = cheerio.load(html);
  const title = $('h1.title-1, .list-title-intro h1, h1.headline-1').first().text().trim() || $('meta[property="og:title"]').attr('content') || '';
  let notesHtml = $('#list-notes').html() || $('.list-title-intro .body-text, .body-text.-prose').first().html() || '';
  notesHtml = notesHtml.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>\s*<p[^>]*>/gi, '\n\n');
  const description = cheerio.load(`<div>${notesHtml}</div>`)('div').text().replace(/\r/g, '').trim();
  const updated = $('.list-date time, .published time, .updated time').last().attr('datetime') || null;
  const ranked = $('.numbered-list-item, .list-number').length > 0;
  return { title, description, updated, ranked };
}

function jsonLd(html) {
  const m = /<script type="application\/ld\+json">\s*(?:\/\*\s*<!\[CDATA\[\s*\*\/)?([\s\S]*?)(?:\/\*\s*\]\]>\s*\*\/)?\s*<\/script>/.exec(html);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

const personSlug = url => {
  const m = /\/(?:director|actor|writer|producer)\/([^/]+)\/?/.exec(url || '');
  return m ? m[1] : null;
};

function parseDuration(iso) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?/.exec(iso || '');
  if (!m) return null;
  const mins = (+m[1] || 0) * 60 + (+m[2] || 0);
  return mins || null;
}

// A film page: /film/<slug>/
export function parseFilmPage(html, slug) {
  const ld = jsonLd(html) || {};
  const $ = cheerio.load(html);
  const og = $('meta[property="og:title"]').attr('content') || '';
  const { title: ogTitle, year: ogYear } = splitNameYear(decode(og));
  const directors = (ld.director || []).map(d => ({ slug: personSlug(d.sameAs), name: d.name })).filter(d => d.slug);
  if (!directors.length) {
    $('a[href^="/director/"]').each((_, a) => {
      const s = personSlug($(a).attr('href'));
      if (s && !directors.some(d => d.slug === s)) directors.push({ slug: s, name: $(a).text().trim() });
    });
  }
  const cast = (ld.actors || ld.actor || []).slice(0, 12).map(p => ({ slug: personSlug(p.sameAs), name: p.name })).filter(p => p.slug);
  const genresLinks = [];
  $('a[href^="/films/genre/"]').each((_, a) => {
    const g = /\/films\/genre\/([^/]+)\//.exec($(a).attr('href'));
    if (g && !genresLinks.includes(g[1])) genresLinks.push(g[1]);
  });
  const themes = [];
  $('a[href^="/films/theme/"], a[href^="/films/mini-theme/"], a[href^="/films/nanogenre/"]').each((_, a) => {
    const t = /\/films\/(?:theme|mini-theme|nanogenre)\/([^/]+)\//.exec($(a).attr('href'));
    if (t && !themes.includes(t[1])) themes.push(t[1]);
  });
  const languages = [];
  $('a[href^="/films/language/"]').each((_, a) => {
    const l = /\/films\/language\/([^/]+)\//.exec($(a).attr('href'));
    if (l && !languages.includes(l[1])) languages.push(l[1]);
  });
  const countries = [];
  $('a[href^="/films/country/"]').each((_, a) => {
    const c = /\/films\/country\/([^/]+)\//.exec($(a).attr('href'));
    if (c && !countries.includes(c[1])) countries.push(c[1]);
  });
  let runtime = parseDuration(ld.duration);
  if (!runtime) {
    const rm = /(\d+)(?:&nbsp;|\s)mins/.exec(html);
    if (rm) runtime = +rm[1];
  }
  const agg = ld.aggregateRating || {};
  let avg = agg.ratingValue != null ? +agg.ratingValue : null;
  if (avg == null) {
    const tm = /twitter:data2" content="([\d.]+) out of 5"/.exec(html);
    if (tm) avg = +tm[1];
  }
  const tmdb = /data-tmdb-id="(\d+)"/.exec(html);
  const tmdbType = /data-tmdb-type="(\w+)"/.exec(html);
  const idm = /"uid":"film:(\d+)"|film:(\d+)/.exec(decode(html));
  // "Related films" strip (Letterboxd's similar films).
  const related = [];
  $('#related [data-item-slug], section.related-films [data-item-slug], .related-films [data-item-slug]').each((_, el) => {
    const s = $(el).attr('data-item-slug');
    if (s && s !== slug && !related.includes(s)) related.push(s);
  });
  if (!related.length) {
    // Fallback: every other poster on the page that is not this film.
    $('[data-item-slug]').each((_, el) => {
      const s = $(el).attr('data-item-slug');
      if (s && s !== slug && !related.includes(s)) related.push(s);
    });
  }
  const year =
    ogYear ||
    (ld.releasedEvent && ld.releasedEvent[0] && +String(ld.releasedEvent[0].startDate).slice(0, 4)) ||
    null;
  const desc = ld.description || $('meta[name="description"]').attr('content') || '';
  const isTv = tmdbType && tmdbType[1] === 'tv';
  return {
    slug,
    title: decode(ld.name) || ogTitle || slug,
    year,
    directors,
    genres: (ld.genre && ld.genre.length ? ld.genre : genresLinks).map(g => String(g).toLowerCase().replace(/\s+/g, '-')),
    themes,
    countries: (ld.countryOfOrigin || []).map(c => c.name).filter(Boolean).length
      ? (ld.countryOfOrigin || []).map(c => c.name)
      : countries,
    languages: ld.inLanguage || languages,
    runtime,
    avg,
    ratings: agg.ratingCount != null ? +agg.ratingCount : null,
    reviews: agg.reviewCount != null ? +agg.reviewCount : null,
    poster: ld.image || null,
    tmdb: tmdb ? +tmdb[1] : null,
    tv: !!isTv,
    filmId: idm ? +(idm[1] || idm[2]) : null,
    cast,
    studios: (ld.productionCompany || []).map(p => p.name).slice(0, 4),
    related: related.slice(0, 12),
    synopsis: decode(desc).slice(0, 400),
  };
}

// /director/<slug>/ header name
export function parsePersonName(html) {
  const $ = cheerio.load(html);
  return $('h1.contextual-title .name, h1.title-1 .prettify, h1 .name').first().text().trim() || null;
}

// RSS feed of recent diary activity.
export function parseRss(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  const tag = (s, t) => {
    const r = new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`).exec(s);
    return r ? decode(r[1].replace(/^<!\[CDATA\[|\]\]>$/g, '').trim()) : null;
  };
  while ((m = re.exec(xml))) {
    const it = m[1];
    const link = tag(it, 'link') || '';
    const slugM = /\/film\/([^/]+)\//.exec(link);
    const guid = tag(it, 'guid') || '';
    if (!slugM) continue; // list activity, not a film diary entry
    const rating = tag(it, 'letterboxd:memberRating');
    const desc = tag(it, 'description') || '';
    const review = desc
      .replace(/<p><img[^>]*\/?><\/p>/g, '')
      .replace(/<p>Watched on [^<]*<\/p>/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const img = /<img src="([^"]+)"/.exec(desc);
    items.push({
      id: guid,
      slug: slugM[1],
      title: tag(it, 'letterboxd:filmTitle'),
      year: +tag(it, 'letterboxd:filmYear') || null,
      watchedDate: tag(it, 'letterboxd:watchedDate'),
      published: tag(it, 'pubDate'),
      rewatch: tag(it, 'letterboxd:rewatch') === 'Yes',
      rating: rating ? +rating : null,
      liked: tag(it, 'letterboxd:memberLike') === 'Yes',
      tmdb: +tag(it, 'tmdb:movieId') || null,
      poster: img ? img[1] : null,
      review: review.length > 3 ? review.slice(0, 600) : '',
    });
  }
  return items;
}

// Notes like "1. Martin Scorsese\n2. Paul Thomas Anderson ... \n\nPossibly Soon\nCarol Reed\n..."
// -> { ranked: [{rank, name}], sections: [{heading, names: []}] }
export function parseRankedNotes(text) {
  const ranked = [];
  const sections = [];
  let current = null;
  for (const raw of String(text || '').split(/\n/)) {
    const line = raw.replace(/\u00a0/g, ' ').trim();
    if (!line) continue;
    const m = /^(\d{1,3})\s*[.):-]\s*(.+)$/.exec(line);
    if (m) {
      ranked.push({ rank: +m[1], name: m[2].trim() });
      current = null;
      continue;
    }
    if (ranked.length && !current) {
      current = { heading: line.replace(/:$/, ''), names: [] };
      sections.push(current);
      continue;
    }
    if (current) current.names.push(line);
  }
  return { ranked, sections };
}

// /<user>/film/<slug>/ : 200 when the member has watched the film (404 otherwise).
export function parseMemberFilm(html) {
  const $ = cheerio.load(html);
  const strip = $('.content-reactions-strip.-viewing').first();
  const starsText = strip.find('.inline-rating title').first().text().trim() || ($('meta[name="twitter:data2"]').attr('content') || '').trim();
  let rating = null;
  if (/^[★½]+$/.test(starsText)) rating = (starsText.match(/★/g) || []).length + (starsText.includes('½') ? 0.5 : 0);
  let liked = false;
  strip.find('title').each((_, t) => {
    if ($(t).text().trim() === 'Liked') liked = true;
  });
  const dateLink = $('p.view-date a[href*="/diary/for/"]').first().attr('href') || '';
  const dm = /\/diary\/for\/(\d{4})\/(\d{2})\/(\d{2})\//.exec(dateLink);
  const title = $('.inline-production-masthead .primaryname a').first().text().trim() || null;
  return { rating, liked, watchedDate: dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : null, title };
}

// "Watched" heading tooltip on /<user>/films/: title="2,098&nbsp;films"
export function parseWatchedCount(html) {
  const m = /class="section-heading"><span class="tooltip" title="([\d,]+)(?:&nbsp;|\s)films?"/.exec(html);
  return m ? +m[1].replace(/,/g, '') : null;
}
