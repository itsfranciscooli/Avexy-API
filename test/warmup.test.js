import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readConfig, currentSeason, mergeIds, runWithConcurrency,
  collectHourlyIds, collectSixHourlyIds, createJob, createSchedule,
} from "../core/warmup.js";

const H = 3_600_000;
const COMMUNITY = "https://myanimezone.xyz/api/community/trending";
const sec = (ms) => Math.floor(ms / 1000);

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

test("collectHourlyIds = community + AniList trending + shows airing in [now-6h, now+24h]", async () => {
  const now = 1000 * H;
  let window, topCall;
  const src = {
    community: async () => [50, 1],
    top: async (sort, limit) => { topCall = [sort, limit]; return [3, 1]; },
    airing: async (from, to) => { window = [from, to]; return [{ mediaId: 1, airingAt: sec(now + H) }, { mediaId: 2, airingAt: sec(now - 5 * H) }]; },
  };
  assert.deepEqual(await collectHourlyIds(readConfig({}), now, src), [50, 1, 3, 2]);
  assert.deepEqual(topCall, ["TRENDING_DESC", 50]);
  assert.deepEqual(window, [sec(now - 6 * H), sec(now + 24 * H)]);
});

test("collectHourlyIds skips community when the url is empty", async () => {
  let called = false;
  const src = { community: async () => { called = true; return [9]; }, top: async () => [], airing: async () => [] };
  assert.deepEqual(await collectHourlyIds(readConfig({ WARMUP_COMMUNITY_URL: "" }), 0, src), []);
  assert.equal(called, false);
});

test("collectSixHourlyIds = popular + season + week, minus excluded", async () => {
  const now = Date.parse("2026-11-16T00:00:00Z");
  const calls = [];
  const src = {
    top: async (sort, limit) => { calls.push([sort, limit]); return [2, 3]; },
    season: async (season, year) => { calls.push([season, year]); return [4]; },
    airing: async (from, to) => { calls.push([to - from]); return [{ mediaId: 5, airingAt: 0 }]; },
  };
  assert.deepEqual(await collectSixHourlyIds(readConfig({}), now, src, new Set([3])), [2, 4, 5]);
  assert.deepEqual(calls, [["POPULARITY_DESC", 50], ["FALL", 2026], [7 * 86400]]);
});

test("collect functions tolerate a failing source", async () => {
  const boom = async () => { throw new Error("down"); };
  assert.deepEqual(await collectHourlyIds(readConfig({}), 0, { community: boom, top: boom, airing: async () => [{ mediaId: 7, airingAt: 0 }] }), [7]);
  assert.deepEqual(await collectSixHourlyIds(readConfig({}), 0, { top: boom, season: async () => [8], airing: boom }, new Set()), [8]);
});

test("job skips a run while the previous one is still going", async () => {
  let release, collects = 0;
  const gate = new Promise((r) => { release = r; });
  const job = createJob("t", async () => { collects++; await gate; return [1]; }, async () => {}, { ...readConfig({}), spacingMs: 0 }, () => {});
  const first = job.run();
  assert.equal(await job.run(), null);
  release();
  assert.deepEqual(await first, [1]);
  assert.equal(collects, 1);
});

test("job warms every collected id and never throws", async () => {
  const warmed = [];
  const job = createJob("t", async () => [1, 2], async (id) => { warmed.push(id); if (id === 1) throw new Error("x"); }, { ...readConfig({}), spacingMs: 0 }, () => {});
  assert.deepEqual(await job.run(), [1, 2]);
  assert.deepEqual(warmed.sort(), [1, 2]);
  const broken = createJob("t", async () => { throw new Error("collect failed"); }, async () => {}, { ...readConfig({}), spacingMs: 0 }, () => {});
  assert.deepEqual(await broken.run(), []);
});

test("runWithConcurrency spaces out the start of each item", async () => {
  const starts = [];
  await runWithConcurrency([1, 2, 3, 4], 3, async () => { starts.push(Date.now()); }, 40);
  starts.sort((a, b) => a - b);
  // Cumulative check: the start rate is what matters; single gaps jitter with the ~15ms Windows timer.
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[0] >= i * 40 - 16, `start ${i} at +${starts[i] - starts[0]}ms`);
});

test("readConfig spaces shows 1s apart by default", () => {
  assert.equal(readConfig({}).spacingMs, 1000);
});

test("schedule runs six-hourly after hourly, on start and every 6th hourly tick", async () => {
  const order = [];
  let tick;
  const schedule = createSchedule(
    async () => { order.push("h"); },
    async () => { order.push("6"); },
    { setInterval: (fn, ms) => { assert.equal(ms, 3_600_000); tick = fn; return 1; }, clearInterval: () => {} },
  );
  await schedule.start();
  for (let i = 0; i < 6; i++) await tick();
  assert.deepEqual(order, ["h", "6", "h", "h", "h", "h", "h", "h", "6"]);
});
