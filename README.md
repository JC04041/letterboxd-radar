# Film Radar

A self-updating companion site for [letterboxd.com/JosephCurrid](https://letterboxd.com/JosephCurrid/).

**Live site:** https://jc04041.github.io/letterboxd-radar/

Nothing needs to be run by hand. A GitHub Actions workflow scans the profile every 30 minutes,
rebuilds the analysis and republishes the site.

## What it does

- **Top 100 tracker.** Reads the ranked list *Favourite From My Top 100 Filmmakers* (the
  numbered names in its notes, matched to the film for each rank). Every scan takes a snapshot;
  each reorder, entry, exit or favourite-film swap is logged with how many places a filmmaker
  moved, with movement since the last change, over 7 days and over 30 days, plus a rank history
  per filmmaker.
- **Next up.** A model trained on your list learns what separates Top 100 filmmakers from
  everyone else you've watched (your ratings, films seen, 4½★+ and 5★ films, likes, crowd
  scores, unseen potential). It ranks every contender, tracks the names under "Possibly Soon",
  flags listed filmmakers on the bubble, and says which single unseen film could push a
  contender over the line.
- **Filmmakers.** Type any director: their full filmography, what you've seen with your ratings,
  and every unseen film ranked by how much you're predicted to like it, with the reasons.
  Directors outside your history fall back to a live Wikidata lookup.
- **For you.** Picks without naming anyone: top predictions, unseen films from your Top 100,
  your watchlist ranked, hidden gems, canon blind spots, new directors, "because you loved…",
  what's coming from your Top 100, and a filterable explorer.
- **Taste.** A cross-validated ridge-regression model of your ratings (genre, themes, era,
  country, director, cast, runtime, crowd score). Shows its accuracy against the Letterboxd
  average, what moves your ratings, your hot takes and your biggest surprises.
- **Activity.** Diary, detected changes (new watches, re-ratings, likes, watchlist edits) and
  the scanner's own progress.

## How the scanning works

Letterboxd challenges automated requests to some pages (paginated film grids, the diary,
profile root), so the scanner never uses them. It only reads pages served normally to visitors:

| Page | Used for |
| --- | --- |
| `/<user>/films/` | Total watched count and the 72 most recent releases you've watched, with ratings and likes |
| `/<user>/rss/` | Every new diary entry (date, rating, like, rewatch, review) |
| `/<user>/watchlist/` | Watchlist |
| `/<user>/lists/`, `/<user>/list/<slug>/` | Your lists, the Top 100 and its notes, and your ratings on list entries |
| `/<user>/film/<slug>/` | Whether you've watched a film (404 = not watched), your rating, like and last watch date |
| `/film/<slug>/` | Directors, genres, themes, cast, runtime, country, crowd rating, poster, related films |
| `/director/<slug>/` | Complete filmographies |

Your full history is rebuilt by checking directors' filmographies, related films and the Top 250
lists against `/<user>/film/<slug>/`, most likely films first. The first few hours of runs do this
backfill at about two requests a second; after that each run makes a handful of requests.
A film is only recommended after it has been checked and confirmed unwatched.

## Layout

```
config.json            profile name, Top 100 list slug, pacing
scraper/               fetch + parse Letterboxd, incremental scan with a time budget
analysis/              taste model, director stats, Top 100 history, site data build
site/                  static website (no build step)
data/                  scanned state, committed by the workflow
.github/workflows/     the scheduled workflow
```

Run locally: `npm ci && node scraper/scan.js && node analysis/build.js`, then serve `site/`.
