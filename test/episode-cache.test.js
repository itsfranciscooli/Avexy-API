import { test } from "node:test";
import assert from "node:assert/strict";
import * as episodeCache from "../core/episode-cache.js";

test("episode cache exposes an awaitable warmEpisodes alongside getEpisodesResponse", () => {
  assert.equal(typeof episodeCache.warmEpisodes, "function");
  assert.equal(typeof episodeCache.getEpisodesResponse, "function");
});
