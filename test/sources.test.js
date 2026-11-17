import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchTopAnimeIds, fetchSeasonAnimeIds, fetchAiringSchedule } from "../core/anilist.js";
import { fetchCommunityTrendingIds } from "../core/community-trending.js";

const reply = (data) => async () => ({ ok: true, json: async () => ({ data }) });
const fail = async () => ({ ok: false });
const URL = "https://example.test/trending";

test("fetchTopAnimeIds returns ids from one page", async () => {
  const f = reply({ Page: { media: [{ id: 1 }, { id: 2 }] } });
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

test("fetchSeasonAnimeIds keeps collected pages when a later page fails", async () => {
  let n = 0;
  const f = async () => n++ === 0
    ? { ok: true, json: async () => ({ data: { Page: { pageInfo: { hasNextPage: true }, media: [{ id: 10 }] } } }) }
    : { ok: false };
  assert.deepEqual(await fetchSeasonAnimeIds("FALL", 2026, f), [10]);
});

test("fetchAiringSchedule returns mediaId/airingAt pairs", async () => {
  const f = reply({ Page: { pageInfo: { hasNextPage: false }, airingSchedules: [{ mediaId: 5, airingAt: 1000 }] } });
  assert.deepEqual(await fetchAiringSchedule(0, 2000, f), [{ mediaId: 5, airingAt: 1000 }]);
});

test("AniList list fetchers return [] when AniList fails", async () => {
  assert.deepEqual(await fetchTopAnimeIds("POPULARITY_DESC", 50, fail), []);
  assert.deepEqual(await fetchSeasonAnimeIds("FALL", 2026, fail), []);
  assert.deepEqual(await fetchAiringSchedule(0, 1, fail), []);
});

test("fetchCommunityTrendingIds merges and dedupes mostSaved and mostSeen", async () => {
  const f = async () => ({ ok: true, json: async () => ({
    windowDays: 7,
    mostSaved: [{ animeId: 130003 }, { animeId: 877 }],
    mostSeen:  [{ animeId: 877 }, { animeId: 21 }],
  }) });
  assert.deepEqual(await fetchCommunityTrendingIds(URL, f), [130003, 877, 21]);
});

test("fetchCommunityTrendingIds returns [] on bad responses", async () => {
  assert.deepEqual(await fetchCommunityTrendingIds(URL, fail), []);
  assert.deepEqual(await fetchCommunityTrendingIds(URL, async () => { throw new Error("down"); }), []);
  assert.deepEqual(await fetchCommunityTrendingIds(URL, async () => ({ ok: true, json: async () => { throw new SyntaxError("html"); } })), []);
  assert.deepEqual(await fetchCommunityTrendingIds(URL, async () => ({ ok: true, json: async () => ({ mostSaved: [{ animeId: "x" }, {}, { animeId: -1 }] }) })), []);
});
