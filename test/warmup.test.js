import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readConfig, currentSeason, mergeIds, runWithConcurrency,
  listFetchers, refreshLists, createWarmer, createTicker,
} from "../core/warmup.js";

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const COMMUNITY = "https://myanimezone.xyz/api/community/trending";
const sec = (ms) => Math.floor(ms / 1000);

// In-memory stand-in for smartcache with the same get/set/needsRefresh contract.
function fakeCache(clock) {
  const store = new Map();
  return {
    get: (k) => store.get(k) ?? null,
    set: (k, data, ttl, refreshAfter) => { store.set(k, { data, cachedAt: clock.now, ttl, refreshAfter }); },
    needsRefresh: (e) => !e || clock.now - e.cachedAt > e.refreshAfter,
  };
}

test("readConfig defaults", () => {
  assert.deepEqual(readConfig({}), { enabled: true, limit: 50, concurrency: 3, communityUrl: COMMUNITY, spacingMs: 1000 });
});

test("readConfig falls back on bad values and honours an empty community url", () => {
  const c = readConfig({ WARMUP_LIMIT: "abc", WARMUP_CONCURRENCY: "0", WARMUP_ENABLED: "false", WARMUP_COMMUNITY_URL: "" });
  assert.deepEqual(c, { enabled: false, limit: 50, concurrency: 3, communityUrl: "", spacingMs: 1000 });
});

test("currentSeason boundaries", () => {
  assert.deepEqual(currentSeason(new Date("2026-03-31T23:59:59Z")), { season: "WINTER", year: 2026 });
  assert.deepEqual(currentSeason(new Date("2026-04-01T00:00:00Z")), { season: "SPRING", year: 2026 });
  assert.deepEqual(currentSeason(new Date("2026-07-15T00:00:00Z")), { season: "SUMMER", year: 2026 });
  assert.deepEqual(currentSeason(new Date("2026-11-16T00:00:00Z")), { season: "FALL",   year: 2026 });
});

test("mergeIds dedupes across lists in first-seen order", () => {
  assert.deepEqual(mergeIds([[1, 2], [2, 3], [3, 1, 4]]), [1, 2, 3, 4]);
});

test("runWithConcurrency caps in-flight work and continues after errors", async () => {
  let inFlight = 0, peak = 0;
  const seen = [];
  const stats = await runWithConcurrency([1, 2, 3, 4, 5, 6], 3, async (id) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    seen.push(id);
    if (id === 2) throw new Error("boom");
  });
  assert.equal(peak, 3);
  assert.deepEqual(seen.sort(), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(stats, { ok: 5, failed: 1 });
});

test("runWithConcurrency spaces out the start of each item", async () => {
  const starts = [];
  await runWithConcurrency([1, 2, 3, 4], 3, async () => { starts.push(Date.now()); }, 40);
  starts.sort((a, b) => a - b);
  // Cumulative check: the start rate is what matters; single gaps jitter with the ~15ms Windows timer.
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[0] >= i * 40 - 16, `start ${i} at +${starts[i] - starts[0]}ms`);
});

test("listFetchers: community, trending, airing (today + week), season, popular", async () => {
  const now = Date.parse("2026-11-16T00:00:00Z");
  const calls = [];
  const src = {
    community: async (url) => { calls.push(["community", url]); return [1]; },
    top: async (sort, limit) => { calls.push([sort, limit]); return sort === "TRENDING_DESC" ? [2] : [5]; },
    airing: async (from, to) => { calls.push(["airing", from, to]); return [{ mediaId: 3, airingAt: 0 }]; },
    season: async (season, year) => { calls.push([season, year]); return [4]; },
  };
  const f = listFetchers(readConfig({}), src);
  assert.deepEqual(Object.keys(f), ["community", "trending", "airing", "season", "popular"]);
  assert.deepEqual(await f.community(now), [1]);
  assert.deepEqual(await f.trending(now), [2]);
  assert.deepEqual(await f.airing(now), [3]);
  assert.deepEqual(await f.season(now), [4]);
  assert.deepEqual(await f.popular(now), [5]);
  assert.deepEqual(calls, [
    ["community", COMMUNITY],
    ["TRENDING_DESC", 50],
    ["airing", sec(now - 6 * H), sec(now + 7 * DAY)],
    ["FALL", 2026],
    ["POPULARITY_DESC", 50],
  ]);
});

test("listFetchers drops community when the url is empty", () => {
  assert.equal("community" in listFetchers(readConfig({ WARMUP_COMMUNITY_URL: "" }), {}), false);
});

test("refreshLists stores each list for 30 days and re-fetches it after 15 minutes", async () => {
  const clock = { now: 0 };
  const cache = fakeCache(clock);
  let fetches = 0;
  const fetchers = { a: async () => { fetches++; return [1, 2]; }, b: async () => [2, 3] };

  assert.deepEqual(await refreshLists(fetchers, clock.now, cache), [1, 2, 3]);
  assert.deepEqual(cache.get("warmup:list:a"), { data: [1, 2], cachedAt: 0, ttl: 30 * DAY, refreshAfter: 15 * MIN });

  clock.now = 14 * MIN;
  await refreshLists(fetchers, clock.now, cache);
  assert.equal(fetches, 1);

  clock.now = 16 * MIN;
  await refreshLists(fetchers, clock.now, cache);
  assert.equal(fetches, 2);
});

test("refreshLists keeps the cached list when a fetch fails and waits 15 minutes to retry", async () => {
  const clock = { now: 0 };
  const cache = fakeCache(clock);
  let ok = true, fetches = 0;
  const fetchers = { a: async () => { fetches++; if (!ok) throw new Error("down"); return [7]; } };
  await refreshLists(fetchers, clock.now, cache);

  ok = false;
  clock.now = 16 * MIN;
  assert.deepEqual(await refreshLists(fetchers, clock.now, cache), [7]);
  clock.now = 20 * MIN;
  await refreshLists(fetchers, clock.now, cache);
  assert.equal(fetches, 2);
  clock.now = 32 * MIN;
  await refreshLists(fetchers, clock.now, cache);
  assert.equal(fetches, 3);
});

test("refreshLists treats an empty result as a failure", async () => {
  const clock = { now: 0 };
  const cache = fakeCache(clock);
  let result = [7];
  const fetchers = { a: async () => result };
  await refreshLists(fetchers, clock.now, cache);
  result = [];
  clock.now = 16 * MIN;
  assert.deepEqual(await refreshLists(fetchers, clock.now, cache), [7]);
});

test("warmer tick warms only shows whose probe is due", async () => {
  const warmed = [];
  const warmer = createWarmer({
    cfg: { ...readConfig({}), spacingMs: 0 },
    collect: async () => [1, 2, 3],
    isDue: (id) => id !== 2,
    warm: async (id) => { warmed.push(id); },
    log: () => {},
  });
  await warmer.tick();
  assert.deepEqual(warmed.sort(), [1, 3]);
});

test("warmer tick skips while the previous tick is still running and never throws", async () => {
  let release, collects = 0;
  const gate = new Promise((r) => { release = r; });
  const warmer = createWarmer({
    cfg: { ...readConfig({}), spacingMs: 0 },
    collect: async () => { collects++; await gate; return [1]; },
    isDue: () => true,
    warm: async () => { throw new Error("x"); },
    log: () => {},
  });
  const first = warmer.tick();
  await warmer.tick();
  release();
  await first;
  assert.equal(collects, 1);

  const broken = createWarmer({ cfg: readConfig({}), collect: async () => { throw new Error("no"); }, isDue: () => true, warm: async () => {}, log: () => {} });
  await broken.tick();
});

test("ticker runs immediately and then every minute", async () => {
  let runs = 0, interval;
  const ticker = createTicker(async () => { runs++; }, { setInterval: (fn, ms) => { interval = ms; return 1; }, clearInterval: () => {} });
  await ticker.start();
  assert.equal(runs, 1);
  assert.equal(interval, 60_000);
});
