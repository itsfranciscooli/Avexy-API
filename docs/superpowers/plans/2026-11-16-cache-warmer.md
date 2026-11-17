# Cache Warmer Implementation Plan (simplified)

> **Superseded (2026-11-17):** the hourly / six-hourly jobs were replaced. The warmer now uses the
> API's own per-show rule (`isProbeDue` in `core/episode-cache.js`: re-check 15 min after the last
> probe, every 5 min from 10 min before airing until 6 h after; re-scrape only when `shouldRebuild`).
> The tracked lists are cached for 30 days and re-fetched every 15 min; a one-minute tick warms the
> shows that are due. See `core/warmup.js` and the README "Cache warming" section.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Proactively cache the `/episodes/:id` response for popular anime on two fixed cadences: an **hourly** job for "essential" data and a **6-hourly** job for everything else.

**Architecture:** Two independent jobs in `core/warmup.js`, each = *collect IDs → warm them 3 at a time*. No per-show bookkeeping: each job warms its whole set every time it runs; the episode cache itself decides whether a cached show actually needs re-scraping. `core/episode-cache.js` exposes an awaitable `warmEpisodes(id)` so the warmer's throttle is real. Started from `server.js` only.

**Tech Stack:** Node ESM, built-in `fetch`, `node:test` (no new deps).

**Spec:** `docs/superpowers/specs/2026-11-16-cache-warmer-design.md` (cadence section superseded by this plan — see "Jobs").

## Jobs

| Job | Every | IDs |
|---|---|---|
| **hourly** | 1 h | MyAnimeZone community trending (`mostSaved` + `mostSeen`) **+** AniList trending (top `WARMUP_LIMIT`) **+** shows airing today (AniList airing schedule, `airingAt ∈ [now − 6 h, now + 24 h]`) |
| **six-hourly** | 6 h | AniList all-time popular (top `WARMUP_LIMIT`) **+** current season (all) **+** airing this week (all) — minus IDs the hourly job just covered |

Both jobs run once immediately at startup. If a job is still running when its timer fires, that run is skipped (no overlap). A failed list fetch contributes no IDs that run; a failed show is logged and skipped. Nothing is persisted: cached entries keep their own TTLs.

## Global Constraints

- Node only: started from `server.js`; `index.js` must not import `core/warmup.js`.
- Runs only when `CACHE_ENABLED` is truthy and `WARMUP_ENABLED` is not `false`.
- Never blocks startup or requests; never throws out of a job.
- Config: `WARMUP_ENABLED` (true), `WARMUP_LIMIT` (50), `WARMUP_CONCURRENCY` (3), `WARMUP_COMMUNITY_URL` (`https://myanimezone.xyz/api/community/trending`; empty string disables). Bad numbers fall back to defaults.
- Season by UTC month: Winter Jan–Mar, Spring Apr–Jun, Summer Jul–Sep, Fall Oct–Dec.

## Review Focus

1. MyAnimeZone or AniList down / returns HTML → that source contributes nothing; the other sources still warm. (Task 1 tolerance tests; Task 3 `collect* tolerates a failing source`.)
2. A slow six-hourly run overlaps the next timer → second run is skipped, not stacked. (Task 3 `job skips while running`.)
3. A show in both jobs → warmed once per six-hourly run, not twice. (Task 3 `collectSixHourly excludes hourly ids`.)
4. One show's scrape throws → the rest of the job continues. (Task 3 `runWithConcurrency continues after errors`.)
5. Finished, unchanged shows → not re-scraped every run. (Task 2: `warmEpisodes` reuses `shouldRebuild`.)

---

### Task 1: Data sources

**Files:** Modify `core/anilist.js`; create `core/community-trending.js`; tests `test/sources.test.js`; `package.json` gets `"test": "node --test test/"`.

**Produces:**
- `core/anilist.js`: `fetchTopAnimeIds(sort, limit, fetchImpl = fetch): Promise<number[]>`; `fetchSeasonAnimeIds(season, year, fetchImpl?): Promise<number[]>` (paginated, perPage 50); `fetchAiringSchedule(fromSec, toSec, fetchImpl?): Promise<{mediaId, airingAt}[]>` (paginated). All POST `https://graphql.anilist.co` with the existing `UA`; return `[]` on first-page failure, collected-so-far on later failure.
- `core/community-trending.js`: `fetchCommunityTrendingIds(url, fetchImpl = fetch): Promise<number[]>` — deduped positive-integer `animeId`s from `mostSaved` then `mostSeen`; `[]` on any failure.

- [ ] Write tests: one page of top ids; season pagination follows `hasNextPage`; airing schedule pairs; all three `[]` on `{ ok:false }`; community merges + dedupes `[130003, 877] + [877, 21] → [130003, 877, 21]`; community `[]` on non-OK, throw, non-JSON, and junk entries.
- [ ] `npm test` → fails (not exported).
- [ ] Implement.
- [ ] `npm test` → passes. Commit `feat: anilist list queries and community trending fetcher`.

### Task 2: Awaitable warm in episode cache

**Files:** Modify `core/episode-cache.js`.

**Produces:** `warmEpisodes(anilistId): Promise<void>` — no cache entry (or stale providers) → same build path as `getEpisodesResponse`; cached → run the refresh task now and await it (re-check AniList/ani.zip, rebuild only if `shouldRebuild`), bypassing the 15/5-min probe gate but respecting the existing `refreshing` set. Refactor: move `scheduleRefresh`'s task body into `refreshEpisodes(anilistId, entry, oldState)` used by both; `scheduleRefresh` behaviour unchanged.

- [ ] Refactor + add `warmEpisodes`; verify with `node -e` import that both exports exist and the existing smoke path (`getEpisodesResponse`) is untouched. Commit `refactor: awaitable warmEpisodes in episode cache`.

### Task 3: Warmer

**Files:** Create `core/warmup.js`; test `test/warmup.test.js`.

**Produces:** `readConfig(env)`, `currentSeason(date)`, `mergeIds(lists)`, `runWithConcurrency(items, n, fn)`, `collectHourlyIds(cfg, nowMs, src)`, `collectSixHourlyIds(cfg, nowMs, src, excludeIds)`, `createJob(name, collect, warm, cfg, log)` → `{ run(): Promise<void> }`, `startWarmup(env = process.env): { stop() } | null`. `src` = `{ top, season, airing, community }` (Task 1 functions; injected for tests).

- [ ] Write tests: `readConfig` defaults + bad values + empty community URL; `currentSeason` four boundaries; `mergeIds` dedupe; `runWithConcurrency` peak = n and continues after a throw; `collectHourlyIds` = community ∪ ids airing in window (excludes +25 h and −7 h); `collectSixHourlyIds` = top ∪ popular ∪ season ∪ week, minus exclude set; collect* tolerates a source that throws; `job skips while running` (second `run()` during first resolves without calling `collect`).
- [ ] `npm test` → fails.
- [ ] Implement. `startWarmup` wires `warm = warmEpisodes`, runs both jobs immediately, `setInterval` 1 h / 6 h (`.unref()` so tests/CLI can exit), six-hourly job excludes the last hourly set. One log line per job run: name, id count, warmed/failed counts, duration.
- [ ] `npm test` → passes. Commit `feat: hourly and six-hourly cache warmer`.

### Task 4: Wire + docs

**Files:** `server.js`, `.env.example`, `README.md`.

- [ ] `server.js`: import `startWarmup`, call it inside the `listen` callback after the log line.
- [ ] Add the four `WARMUP_*` vars to `.env.example` and the README env table; add a short "Cache warming" paragraph (two jobs, sources, cadences).
- [ ] Boot test A: `CACHE_ENABLED=true WARMUP_ENABLED=false` → `/` returns 200, no warmup logs.
- [ ] Boot test B: `CACHE_ENABLED=true WARMUP_LIMIT=2 WARMUP_CONCURRENCY=2` for ~60 s → `/` answers 200 while warming; hourly job log line appears; cache files appear in `core/.cache/`.
- [ ] `npm test` passes. Commit `feat: start cache warmer from server and document config`.
