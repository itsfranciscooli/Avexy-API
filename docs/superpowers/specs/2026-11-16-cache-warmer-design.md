# Cache warmer — design

**Date:** 2026-11-16

## Intent

Today the cache only fills when a user requests an anime, so the first visitor to
`/episodes/:id` pays the full cost of scraping all providers. The server should warm the
cache on its own for the anime people are most likely to request, and keep those entries
current, so even a first visitor gets a fast hit.

## Goals / non-goals

- **Goals:** proactively cache the full `/episodes/:id` response for popular, trending,
  currently-airing and current-season anime; keep them fresh on a cadence that is tighter
  on a show's release day; never block startup or request handling; never hammer upstream
  sites.
- **Non-goals:** warming `/watch` streams (signed, short-lived); warming on edge runtimes;
  persisting warmer state across restarts (a cold boot simply re-warms everything).
- **Anti-goals:** re-scraping finished, unchanged shows on every tick; a boot that stalls
  because warming is synchronous.

## Approaches considered

1. **AniList lists (chosen).** Self-updating, zero config, reflects real demand.
2. Hand-maintained ID list via env/file — goes stale, needs upkeep.
3. Locally most-requested IDs — only warms what was already visited; defeats the purpose.

## What gets warmed

Four AniList lists, merged and deduplicated by AniList ID:

1. Top `WARMUP_LIMIT` (default 50) **trending now** — `Page.media(sort: TRENDING_DESC)`.
2. Top `WARMUP_LIMIT` **most popular of all time** — `Page.media(sort: POPULARITY_DESC)`.
3. **Everything airing this week** — `Page.airingSchedules(airingAt_greater: now,
   airingAt_lesser: now + 7d)`, paginated. Supplies each show's `airingAt`.
4. **Every anime of the current season** — `Page.media(season, seasonYear)`, paginated to
   exhaustion. Season from today's date: Winter Jan–Mar, Spring Apr–Jun, Summer Jul–Sep,
   Fall Oct–Dec.

5. **MyAnimeZone community trending** — `GET https://myanimezone.xyz/api/community/trending`,
   which returns `{ windowDays, mostSaved: [{ animeId, … }], mostSeen: [{ animeId, … }] }`.
   `animeId` is an AniList ID. Both arrays are used.

`WARMUP_LIMIT` caps lists 1 and 2 only; lists 3–5 are always complete.

## Cadence

- The warmer ticks **every hour**.
- A show is **due** when its last refresh is older than:
  - `WARMUP_AIRING_REFRESH_HOURS` (default **1 h**) if it **airs today**;
  - `WARMUP_REFRESH_HOURS` (default **6 h**) otherwise.
- **Airs today** = has an episode with `airingAt` in `[now − 6 h, now + 24 h]` (covers the
  whole release day including the hours after it drops, while providers pick it up).
- The four AniList lists are re-fetched every 6 h; the airs-today set is recomputed every
  tick from the cached week schedule (no extra fetch).
- The community trending list (5) is re-fetched **every tick (hourly)**. A newly listed show
  has never been refreshed, so it is warmed on that same tick; after that it follows the
  same 6 h / 1 h rule as everything else. If the fetch fails, the previous community list
  is kept.
- On boot every show is due, so the whole set warms immediately.
- Work is throttled to `WARMUP_CONCURRENCY` (default **3**) shows at a time.

## Refresh semantics

A refresh calls `getEpisodesResponse(id)` from `core/episode-cache.js` — the same path as
`/episodes/:id`. For an uncached show this builds and caches the full response (providers +
mappings). For a cached show it re-checks AniList / ani.zip and rebuilds provider data when
something changed or the show is still releasing; finished, unchanged shows are left alone.

## Constraints

- Node only: started from `server.js`, never from the edge entry (`index.js`).
- Only runs when `CACHE_ENABLED=true` and `WARMUP_ENABLED` is not `false`.
- Must not block startup; every failure is logged and skipped.
- AniList rate limit (~90 req/min): list fetches are few and 6-hourly; provider scraping is
  the real load and is bounded by `WARMUP_CONCURRENCY`.

## Config (env, all optional)

| Variable | Default |
|---|---|
| `WARMUP_ENABLED` | `true` |
| `WARMUP_LIMIT` | `50` |
| `WARMUP_CONCURRENCY` | `3` |
| `WARMUP_REFRESH_HOURS` | `6` |
| `WARMUP_AIRING_REFRESH_HOURS` | `1` |
| `WARMUP_COMMUNITY_URL` | `https://myanimezone.xyz/api/community/trending` (empty string disables) |

## Files

- New `core/warmup.js` — list assembly, due-calculation, throttled runner, hourly tick.
- `core/anilist.js` — add list queries (trending, popular, season, weekly airing schedule).
- `server.js` — start the warmer after listen.
- `.env.example`, `README.md` — document the config.

## Left to the builder

Exact pagination page size for AniList; log format; whether the in-memory "last refreshed"
map is keyed only by ID (it is — no persistence needed).

## Testing

Unit tests (Node's built-in `node:test`, no new framework) for: list merge/dedupe, season
derivation from a date, airs-today classification, and due-calculation with a fake clock,
using a stubbed AniList fetcher. A boot test confirms the warmer logs warmed IDs and the
cache fills without blocking the HTTP server.
