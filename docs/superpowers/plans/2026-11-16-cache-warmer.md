# Cache Warmer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Proactively cache the `/episodes/:id` response for trending, all-time-popular, this-week-airing and current-season anime, refreshing each on a 6 h / 1 h-on-release-day cadence.

**Architecture:** `core/anilist.js` gains list queries against AniList GraphQL. A new `core/warmup.js` holds pure scheduling logic (merge, season, airs-today, due) plus a throttled hourly runner that calls the existing `getEpisodesResponse(id)`. `server.js` starts the runner after listen; the edge entry (`index.js`) never imports it.

**Tech Stack:** Node ESM, built-in `fetch`, `node:test` + `node:assert` (no new deps).

**Spec:** `docs/superpowers/specs/2026-11-16-cache-warmer-design.md`

## Global Constraints

- Node only: started from `server.js`; `index.js` must not import `core/warmup.js`.
- Runs only when `CACHE_ENABLED=true` and `WARMUP_ENABLED` is not `false`.
- Never blocks startup; every per-show failure is caught, logged, and skipped.
- Defaults: `WARMUP_LIMIT=50`, `WARMUP_CONCURRENCY=3`, `WARMUP_REFRESH_HOURS=6`, `WARMUP_AIRING_REFRESH_HOURS=1`.
- Tick interval: 1 h. List re-fetch interval: 6 h.
- Airs today window: `airingAt ∈ [now − 6 h, now + 24 h]`.
- Season: Winter Jan–Mar, Spring Apr–Jun, Summer Jul–Sep, Fall Oct–Dec (UTC month).
- `WARMUP_LIMIT` caps trending/popular only; week, season and community lists are complete.
- Community trending: `GET https://myanimezone.xyz/api/community/trending` (overridable via `WARMUP_COMMUNITY_URL`; empty disables), ids from `mostSaved[].animeId` and `mostSeen[].animeId` (AniList IDs), fetched every tick (1 h).
- Env parsing follows `core/smartcache.js` (`envBool` / `envInt` semantics).

## Review Focus

1. AniList returns an error/429 or an empty result mid-run → the tick keeps the previously known list and proceeds; it never clears the set to empty. (Task 3 test `keeps previous lists when fetch fails`.)
2. A show that appears in several lists is refreshed once per tick, not once per list. (Task 2 test `mergeIds dedupes across lists`.)
3. `getEpisodesResponse` throws for one ID → other IDs in the same tick still run, and that ID is retried next tick (its `lastAt` is not updated). (Task 3 test `a failing refresh does not stop the tick and stays due`.)
4. Clock crosses a season boundary while running → the next 6 h list refresh uses the new season. (Task 2 test `currentSeason boundaries`; Task 3 recomputes season on every list fetch.)
5. Env values like `WARMUP_LIMIT=abc` or `0` → fall back to defaults rather than warming nothing / crashing. (Task 2 test `readConfig falls back on bad values`.)
6. MyAnimeZone is down, returns HTML, or drops a field → the tick keeps the previous community list and the AniList lists still warm. (Task 1 test `fetchCommunityTrendingIds tolerates bad responses`; Task 3 test `community list refetches every tick and survives failure`.)

---

### Task 1: AniList list queries + community trending fetcher

**Files:**
- Modify: `core/anilist.js`
- Create: `core/community-trending.js`
- Test: `test/anilist-lists.test.js`, `test/community-trending.test.js`
- Modify: `package.json` (add `"test": "node --test test/"`)

**Interfaces:**
- Produces:
  - `graphql(query: string, variables: object, fetchImpl = fetch): Promise<object|null>` — POST to `https://graphql.anilist.co` with the existing `UA` header; returns parsed `json.data` or `null` on non-OK / parse error.
  - `fetchTopAnimeIds(sort: "TRENDING_DESC"|"POPULARITY_DESC", limit: number, fetchImpl?): Promise<number[]>` — single page `Page(page:1, perPage:$limit){ media(type:ANIME, sort:[$sort]){ id } }`.
  - `fetchSeasonAnimeIds(season: "WINTER"|"SPRING"|"SUMMER"|"FALL", year: number, fetchImpl?): Promise<number[]>` — paginates `Page(page:$p, perPage:50){ pageInfo{hasNextPage} media(type:ANIME, season:$season, seasonYear:$year){ id } }` until `hasNextPage` is false.
  - `fetchWeekAiringSchedule(fromSec: number, toSec: number, fetchImpl?): Promise<Array<{mediaId:number, airingAt:number}>>` — paginates `Page(page:$p, perPage:50){ pageInfo{hasNextPage} airingSchedules(airingAt_greater:$from, airingAt_lesser:$to){ mediaId airingAt } }`.
  - All three return `[]` (not throw) when `graphql` returns `null` on the first page; on a later page failure they return what was collected so far.
  - `fetchCommunityTrendingIds(url: string, fetchImpl = fetch): Promise<number[]|null>` in `core/community-trending.js` — GET `url`, return deduped positive integer `animeId`s from `mostSaved` then `mostSeen` (missing arrays treated as empty); return `null` on network error, non-OK status, or non-JSON body (so the caller can tell "failed" from "empty").

- [ ] **Step 1: Write the failing tests**

```js
// test/community-trending.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchCommunityTrendingIds } from "../core/community-trending.js";

const U = "https://example.test/trending";

test("fetchCommunityTrendingIds merges mostSaved and mostSeen", async () => {
  const f = async () => ({ ok: true, json: async () => ({
    windowDays: 7,
    mostSaved: [{ animeId: 130003 }, { animeId: 877 }],
    mostSeen:  [{ animeId: 877 }, { animeId: 21 }],
  }) });
  assert.deepEqual(await fetchCommunityTrendingIds(U, f), [130003, 877, 21]);
});

test("fetchCommunityTrendingIds tolerates bad responses", async () => {
  assert.equal(await fetchCommunityTrendingIds(U, async () => ({ ok: false })), null);
  assert.equal(await fetchCommunityTrendingIds(U, async () => { throw new Error("down"); }), null);
  assert.equal(await fetchCommunityTrendingIds(U, async () => ({ ok: true, json: async () => { throw new SyntaxError("html"); } })), null);
  assert.deepEqual(await fetchCommunityTrendingIds(U, async () => ({ ok: true, json: async () => ({ mostSaved: [{ animeId: "x" }, {}] }) })), []);
});
```

```js
// test/anilist-lists.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchTopAnimeIds, fetchSeasonAnimeIds, fetchWeekAiringSchedule } from "../core/anilist.js";

const ok = (data) => async () => ({ ok: true, json: async () => ({ data }) });

test("fetchTopAnimeIds returns ids from one page", async () => {
  const f = ok({ Page: { media: [{ id: 1 }, { id: 2 }] } });
  assert.deepEqual(await fetchTopAnimeIds("TRENDING_DESC", 50, f), [1, 2]);
});

test("fetchSeasonAnimeIds follows hasNextPage", async () => {
  const pages = [
    { Page: { pageInfo: { hasNextPage: true },  media: [{ id: 10 }] } },
    { Page: { pageInfo: { hasNextPage: false }, media: [{ id: 11 }] } },
  ];
  const f = async () => ({ ok: true, json: async () => ({ data: pages.shift() }) });
  assert.deepEqual(await fetchSeasonAnimeIds("FALL", 2026, f), [10, 11]);
});

test("fetchWeekAiringSchedule returns mediaId/airingAt pairs", async () => {
  const f = ok({ Page: { pageInfo: { hasNextPage: false }, airingSchedules: [{ mediaId: 5, airingAt: 1000 }] } });
  assert.deepEqual(await fetchWeekAiringSchedule(0, 2000, f), [{ mediaId: 5, airingAt: 1000 }]);
});

test("list fetchers return [] when AniList fails", async () => {
  const f = async () => ({ ok: false });
  assert.deepEqual(await fetchTopAnimeIds("POPULARITY_DESC", 50, f), []);
  assert.deepEqual(await fetchSeasonAnimeIds("FALL", 2026, f), []);
  assert.deepEqual(await fetchWeekAiringSchedule(0, 1, f), []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `fetchTopAnimeIds` is not exported.

- [ ] **Step 3: Implement `graphql`, `fetchTopAnimeIds`, `fetchSeasonAnimeIds`, `fetchWeekAiringSchedule` in `core/anilist.js`** and add them to the `export { … }` line. Reuse the existing `UA` constant and the `https://graphql.anilist.co` endpoint already used by `fetchFromAniList`. Implement `fetchCommunityTrendingIds` in `core/community-trending.js`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add core/anilist.js core/community-trending.js test/anilist-lists.test.js test/community-trending.test.js package.json
git commit -m "feat: add AniList list queries and community trending fetcher"
```

---

### Task 2: Warmup scheduling logic (pure)

**Files:**
- Create: `core/warmup.js`
- Test: `test/warmup-logic.test.js`

**Interfaces:**
- Produces (all pure, all exported):
  - `readConfig(env: object): { enabled: boolean, limit: number, concurrency: number, refreshMs: number, airingRefreshMs: number, communityUrl: string }` — defaults per Global Constraints; non-numeric or `<= 0` values fall back to the default. `communityUrl` is `env.WARMUP_COMMUNITY_URL` when defined (an empty string means disabled), else the MyAnimeZone URL.
  - `currentSeason(date: Date): { season: "WINTER"|"SPRING"|"SUMMER"|"FALL", year: number }` (UTC month).
  - `mergeIds(lists: number[][]): number[]` — deduped, first-seen order.
  - `airsToday(airingAts: number[], nowMs: number): boolean` — any `airingAt*1000 ∈ [now − 6 h, now + 24 h]`.
  - `isDue(lastAtMs: number|undefined, airing: boolean, nowMs: number, cfg): boolean` — `undefined` is always due; otherwise `now − lastAt >= (airing ? cfg.airingRefreshMs : cfg.refreshMs)`.

- [ ] **Step 1: Write the failing tests**

```js
// test/warmup-logic.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readConfig, currentSeason, mergeIds, airsToday, isDue } from "../core/warmup.js";

const H = 3_600_000;

test("readConfig defaults", () => {
  assert.deepEqual(readConfig({}), {
    enabled: true, limit: 50, concurrency: 3, refreshMs: 6 * H, airingRefreshMs: 1 * H,
    communityUrl: "https://myanimezone.xyz/api/community/trending",
  });
  assert.equal(readConfig({ WARMUP_COMMUNITY_URL: "" }).communityUrl, "");
});

test("readConfig falls back on bad values", () => {
  const c = readConfig({ WARMUP_LIMIT: "abc", WARMUP_CONCURRENCY: "0", WARMUP_ENABLED: "false" });
  assert.equal(c.limit, 50); assert.equal(c.concurrency, 3); assert.equal(c.enabled, false);
});

test("currentSeason boundaries", () => {
  assert.deepEqual(currentSeason(new Date("2026-03-31T23:59:59Z")), { season: "WINTER", year: 2026 });
  assert.deepEqual(currentSeason(new Date("2026-04-01T00:00:00Z")), { season: "SPRING", year: 2026 });
  assert.deepEqual(currentSeason(new Date("2026-07-15T00:00:00Z")), { season: "SUMMER", year: 2026 });
  assert.deepEqual(currentSeason(new Date("2026-11-16T00:00:00Z")), { season: "FALL",   year: 2026 });
});

test("mergeIds dedupes across lists", () => {
  assert.deepEqual(mergeIds([[1, 2], [2, 3], [3, 1, 4]]), [1, 2, 3, 4]);
});

test("airsToday window is [-6h, +24h]", () => {
  const now = 100 * H;
  const s = (ms) => Math.floor(ms / 1000);
  assert.equal(airsToday([s(now - 5 * H)], now), true);
  assert.equal(airsToday([s(now - 7 * H)], now), false);
  assert.equal(airsToday([s(now + 23 * H)], now), true);
  assert.equal(airsToday([s(now + 25 * H)], now), false);
  assert.equal(airsToday([], now), false);
});

test("isDue uses 6h normally and 1h on release day", () => {
  const cfg = readConfig({});
  const now = 100 * H;
  assert.equal(isDue(undefined, false, now, cfg), true);
  assert.equal(isDue(now - 5 * H, false, now, cfg), false);
  assert.equal(isDue(now - 6 * H, false, now, cfg), true);
  assert.equal(isDue(now - 0.5 * H, true, now, cfg), false);
  assert.equal(isDue(now - 1 * H, true, now, cfg), true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — cannot find module `core/warmup.js`.

- [ ] **Step 3: Implement the five functions in `core/warmup.js`.** Copy the `envBool`/`envInt`-style parsing from `core/smartcache.js` but read from the `env` argument rather than `process.env`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add core/warmup.js test/warmup-logic.test.js
git commit -m "feat: warmup config, season, merge, airs-today and due logic"
```

---

### Task 3: Warmup runner

**Files:**
- Modify: `core/warmup.js`
- Test: `test/warmup-runner.test.js`

**Interfaces:**
- Consumes: Task 1 fetchers (incl. `fetchCommunityTrendingIds`); Task 2 pure functions; `getEpisodesResponse(anilistId, env)` from `core/episode-cache.js`.
- Produces:
  - `runWithConcurrency(items, n, fn): Promise<void>` — at most `n` in flight; rejections from `fn` are swallowed (fn is expected to catch its own).
  - `createWarmer(deps): { tick(): Promise<void>, start(): void, stop(): void }` where `deps = { cfg, fetchLists, fetchCommunity = async () => [], refresh, now = Date.now, setInterval = globalThis.setInterval, clearInterval = globalThis.clearInterval, log = console.log }`:
    - `fetchLists(cfg, nowMs): Promise<{ ids: number[], airingByMedia: Map<number, number[]> }>` — the four AniList lists.
    - `fetchCommunity(cfg): Promise<number[]|null>` — called on **every** tick; `null` or a throw keeps the previous community ids.
    - `refresh(id: number): Promise<void>` — defaults to `(id) => getEpisodesResponse(id)`.
    - `tick()`: if AniList lists are missing or older than 6 h, call `fetchLists`; on failure (throw, or `ids.length === 0` while a previous list exists) keep the previous lists. Always call `fetchCommunity` (failure keeps the previous community ids). The working set is `mergeIds([anilistIds, communityIds])`. Then for each id compute `airsToday(airingByMedia.get(id) ?? [], now)` and `isDue(lastAt.get(id), airing, now, cfg)`; run due ids via `runWithConcurrency(…, cfg.concurrency, …)`; on success `lastAt.set(id, now)`, on error `log` and leave `lastAt` untouched. `tick()` must not throw.
    - `start()`: runs `tick()` immediately (not awaited) and schedules it every 1 h; `stop()` clears the interval.
  - `defaultFetchLists(cfg, nowMs)` — assembles the four lists via Task 1 fetchers using `currentSeason(new Date(nowMs))`, `fromSec = floor(nowMs/1000)`, `toSec = fromSec + 7*86400`, `cfg.limit` for the two top lists; merges with `mergeIds`; groups `airingAt` by `mediaId`; logs one line with the four list sizes.
  - `startWarmup(env = process.env): { stop(): void } | null` — reads `readConfig(env)`; returns `null` without starting when `!cfg.enabled` or `env.CACHE_ENABLED` is not truthy; otherwise `createWarmer` with default deps (`fetchLists: defaultFetchLists`, `fetchCommunity: (cfg) => cfg.communityUrl ? fetchCommunityTrendingIds(cfg.communityUrl) : []`) and `start()`. Log one line per tick with the community list size.

- [ ] **Step 1: Write the failing tests**

```js
// test/warmup-runner.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWarmer, runWithConcurrency, readConfig } from "../core/warmup.js";

const H = 3_600_000;
const noTimers = { setInterval: () => 0, clearInterval: () => {}, log: () => {} };

test("runWithConcurrency never exceeds n in flight", async () => {
  let inFlight = 0, peak = 0;
  await runWithConcurrency([1, 2, 3, 4, 5, 6], 3, async () => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
  });
  assert.equal(peak, 3);
});

test("first tick refreshes every id once", async () => {
  const now = { t: 100 * H };
  const refreshed = [];
  const w = createWarmer({ cfg: readConfig({}), now: () => now.t, ...noTimers,
    fetchLists: async () => ({ ids: [1, 2, 3], airingByMedia: new Map() }),
    refresh: async (id) => { refreshed.push(id); } });
  await w.tick();
  assert.deepEqual(refreshed, [1, 2, 3]);
});

test("non-airing ids wait 6h, airing-today ids wait 1h", async () => {
  const now = { t: 100 * H };
  const s = Math.floor((now.t + 2 * H) / 1000);
  const refreshed = [];
  const w = createWarmer({ cfg: readConfig({}), now: () => now.t, ...noTimers,
    fetchLists: async () => ({ ids: [1, 2], airingByMedia: new Map([[2, [s]]]) }),
    refresh: async (id) => { refreshed.push(id); } });
  await w.tick();
  refreshed.length = 0;
  now.t += 1 * H; await w.tick();
  assert.deepEqual(refreshed, [2]);
  refreshed.length = 0;
  now.t += 5 * H; await w.tick();
  assert.deepEqual(refreshed.sort(), [1, 2]);
});

test("a failing refresh does not stop the tick and stays due", async () => {
  const now = { t: 100 * H };
  const calls = [];
  const w = createWarmer({ cfg: readConfig({}), now: () => now.t, ...noTimers,
    fetchLists: async () => ({ ids: [1, 2], airingByMedia: new Map() }),
    refresh: async (id) => { calls.push(id); if (id === 1) throw new Error("boom"); } });
  await w.tick();
  assert.deepEqual(calls, [1, 2]);
  calls.length = 0;
  now.t += 1 * H; await w.tick();           // only the failed one is due again
  assert.deepEqual(calls, [1]);
});

test("keeps previous lists when fetch fails", async () => {
  const now = { t: 100 * H };
  let n = 0;
  const refreshed = [];
  const w = createWarmer({ cfg: readConfig({}), now: () => now.t, ...noTimers,
    fetchLists: async () => { if (n++ === 0) return { ids: [7], airingByMedia: new Map() }; throw new Error("anilist down"); },
    refresh: async (id) => { refreshed.push(id); } });
  await w.tick();
  now.t += 7 * H; await w.tick();           // lists >6h old → refetch fails → keep [7]
  assert.deepEqual(refreshed, [7, 7]);
});

test("community list refetches every tick and survives failure", async () => {
  const now = { t: 100 * H };
  const community = [[50], null, [50, 60]]; // tick1 ok, tick2 fails, tick3 adds 60
  let aniCalls = 0, comCalls = 0;
  const refreshed = [];
  const w = createWarmer({ cfg: readConfig({}), now: () => now.t, ...noTimers,
    fetchLists: async () => { aniCalls++; return { ids: [1], airingByMedia: new Map() }; },
    fetchCommunity: async () => community[comCalls++],
    refresh: async (id) => { refreshed.push(id); } });
  await w.tick();
  assert.deepEqual(refreshed.sort(), [1, 50]);
  refreshed.length = 0;
  now.t += 1 * H; await w.tick();           // community fails → keeps [50]; nothing due yet
  assert.deepEqual(refreshed, []);
  now.t += 1 * H; await w.tick();           // new community id 60 is warmed immediately
  assert.deepEqual(refreshed, [60]);
  assert.equal(comCalls, 3);                // hourly
  assert.equal(aniCalls, 1);                // AniList lists still 6-hourly
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `createWarmer` / `runWithConcurrency` not exported.

- [ ] **Step 3: Implement `runWithConcurrency`, `createWarmer`, `defaultFetchLists`, `startWarmup` in `core/warmup.js`.**

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add core/warmup.js test/warmup-runner.test.js
git commit -m "feat: throttled hourly cache warmer runner"
```

---

### Task 4: Wire into server, config, docs

**Files:**
- Modify: `server.js` (inside the `server.listen` callback)
- Modify: `.env.example`
- Modify: `README.md` (env table + one paragraph under "Self-hosted")

**Interfaces:**
- Consumes: `startWarmup(env)` from Task 3.

- [ ] **Step 1: Wire `startWarmup`** — in `server.js`, `import { startWarmup } from "./core/warmup.js";` and inside the `listen` callback, after the existing log line, `startWarmup(process.env);`. Do **not** touch `index.js`.

- [ ] **Step 2: Add the six `WARMUP_*` variables to `.env.example`** with their defaults, and a row for each in the README env table. Add a short "Cache warming" paragraph under *Self-hosted* stating the five sources (four AniList lists + MyAnimeZone community trending, fetched hourly) and the 6 h / 1 h cadence.

- [ ] **Step 3: Boot test (warmer off)**

Run: `CACHE_ENABLED=true WARMUP_ENABLED=false PORT=4124 node server.js` (background), `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4124/`, then kill.
Expected: `200`, no warmup log lines.

- [ ] **Step 4: Boot test (warmer on, real AniList)**

Run: `CACHE_ENABLED=true WARMUP_LIMIT=2 PORT=4124 node server.js` for ~20 s, then kill.
Expected: a log line reporting the four list sizes, a line reporting the community list size, then per-ID warm log lines; the HTTP server answers `200` on `/` *before* warming finishes. Provider errors are logged and skipped, not fatal.

- [ ] **Step 5: Run the full suite and commit**

Run: `npm test` → all passing.

```bash
git add server.js .env.example README.md
git commit -m "feat: start cache warmer from server.js and document config"
```
