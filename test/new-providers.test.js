import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSearch,
  parseSeriesEpisodes,
  parseServers,
  parsePlayerSources,
  parsePlayerIframe,
  parseEmbedFiles,
  isDubSeries,
  cleanSeriesTitle,
} from "../providers/gogoanime.js";
import {
  parseFilterResults,
  parseAnimePage,
  parseEmbedParams,
  decodeSaturn,
  searchQueries,
  isItaDub,
} from "../providers/animesaturn.js";

test("gogoanime: REST search keeps series only and flags dubs", () => {
  const data = [
    { title: "One Piece English Dubbed", url: "https://gogoanime.by/series/one-piece-english-dubbed-online/", subtype: "series" },
    { title: "One Piece", url: "https://gogoanime.by/series/one-piece-1/", subtype: "series" },
    { title: "One Piece &#8211; Wano Kuni SP", url: "https://gogoanime.by/series/one-piece-wano-kuni-sp/", subtype: "series" },
    { title: "Some Post", url: "https://gogoanime.by/some-post/", subtype: "post" },
  ];
  assert.deepEqual(parseSearch(data), [
    { slug: "one-piece-english-dubbed-online", title: "One Piece English Dubbed", text: "One Piece", dub: true },
    { slug: "one-piece-1", title: "One Piece", text: "One Piece", dub: false },
    { slug: "one-piece-wano-kuni-sp", title: "One Piece – Wano Kuni SP", text: "One Piece – Wano Kuni SP", dub: false },
  ]);
});

test("gogoanime: dub detection ignores 'eng' sub slugs", () => {
  assert.equal(isDubSeries("Sousou no Frieren 2nd Season", "sousou-no-frieren-2nd-season-eng"), false);
  assert.equal(isDubSeries("Naruto (Dub)", "naruto-dub"), true);
  assert.equal(cleanSeriesTitle("One Piece English Dubbed"), "One Piece");
});

test("gogoanime: series page episodes are parsed, deduped and sorted", () => {
  const html = `<div class="episodes-container"><div style="display: flex;" class="episode-item" data-episode-number="2">
      <a href="https://gogoanime.by/x-episode-2-english-subbed/">Episode 2</a></div>
    <div class="episode-item" data-episode-number="1">
      <a href="https://gogoanime.by/x-episode-1-english-subbed/">Episode 1</a></div>
    <div class="episode-item" data-episode-number="1"><a href="https://gogoanime.by/dupe/">Episode 1</a></div></div>`;
  assert.deepEqual(parseSeriesEpisodes(html), [
    { number: 1, url: "https://gogoanime.by/x-episode-1-english-subbed/" },
    { number: 2, url: "https://gogoanime.by/x-episode-2-english-subbed/" },
  ]);
});

test("gogoanime: series pages with the gapi episode grid are parsed", () => {
  const html = `<div id="gapi-list"><p class="hd">Episodes — 25 total.</p><div class="eg">
      <a class="e" href="https://gogoanime.by/watch/shingeki-no-kyojin/ep-2" title="That Day">2</a>
      <a class="e" href="https://gogoanime.by/watch/shingeki-no-kyojin/ep-1" title="To You">1</a>
    </div></div>
    <a href="https://gogoanime.by/shingeki-no-kyojin-episode-7-english-subbed/">Episode 7</a>`;
  assert.deepEqual(parseSeriesEpisodes(html), [
    { number: 1, url: "https://gogoanime.by/watch/shingeki-no-kyojin/ep-1" },
    { number: 2, url: "https://gogoanime.by/watch/shingeki-no-kyojin/ep-2" },
  ]);
});

test("gogoanime: episode page servers keep their audio group", () => {
  const html = `<div class="type" data-type="sub">
      <label>SUB:</label>
      <ul>
        <li class="player-type-link" data-src="https://gogoanime.by/player/?source=embed&amp;url=abc">Mega</li>
        <li class="player-type-link" data-src="https://gogoanime.by/player/?source=blogger&amp;url=def">SD</li>
      </ul>
    </div>
    <div class="type" data-type="dub"><label>DUB:</label><ul>
        <li class="player-type-link" data-src="https://gogoanime.by/player/?source=embed&amp;url=ghi">HD</li>
    </ul></div>`;
  assert.deepEqual(parseServers(html), [
    { audio: "sub", name: "Mega", url: "https://gogoanime.by/player/?source=embed&url=abc" },
    { audio: "sub", name: "SD", url: "https://gogoanime.by/player/?source=blogger&url=def" },
    { audio: "dub", name: "HD", url: "https://gogoanime.by/player/?source=embed&url=ghi" },
  ]);
});

test("gogoanime: player pages yield JW sources, iframes and embed files", () => {
  const jw = `var sources = [{"file":"https://v.example/a.mp4","type":"mp4","label":"360p"},{"file":"https://v.example/a.mp4","type":"mp4"}];`;
  assert.deepEqual(parsePlayerSources(jw), [{ file: "https://v.example/a.mp4", type: "mp4", label: "360p" }]);
  assert.equal(parsePlayerSources("no sources here").length, 0);
  assert.equal(
    parsePlayerIframe(`<iframe class="player-iframe" src="https://megavid.buzz/mal/21/1/sub" allowfullscreen></iframe>`),
    "https://megavid.buzz/mal/21/1/sub",
  );
  assert.deepEqual(
    parseEmbedFiles(`jwplayer().setup({ file: "https://megaplay.su/uploads/hls/x/index.m3u8?v=1", tracks: [] })`),
    ["https://megaplay.su/uploads/hls/x/index.m3u8?v=1"],
  );
});

test("animesaturn: filter cards give slug, title, year, poster id and dub flag", () => {
  const html = `<a href="/anime/boku-no-hero-academia-Lt3ac" class="ac group">
      <div class="ac__poster"><img src="https://img.saturncdn.net/static/images/locandine/bx21459-RoPwgrZ32gM3.jpg"></div>
      <div class="ac__caption"><h3 class="ac__title">Boku no Hero Academia</h3>
      <p class="ac__sub">03 Aprile 2016 &middot; 13 ep</p></div></a>
    <a href="/anime/boku-no-hero-academia-ita-LEh8G" class="ac group">
      <div class="ac__poster"><img src="https://img.saturncdn.net/static/images/locandine/kbcPv.jpg"></div>
      <div class="ac__caption"><h3 class="ac__title">Boku no Hero Academia (ITA)</h3></div></a>`;
  assert.deepEqual(parseFilterResults(html), [
    { slug: "boku-no-hero-academia-Lt3ac", title: "Boku no Hero Academia", text: "Boku no Hero Academia", year: 2016, posterId: 21459, dub: false },
    { slug: "boku-no-hero-academia-ita-LEh8G", title: "Boku no Hero Academia (ITA)", text: "Boku no Hero Academia", year: null, posterId: null, dub: true },
  ]);
  assert.equal(isItaDub("Frieren", "frieren-beyond-journey-s-end-ita-JVrzc"), true);
});

test("animesaturn: anime page gives ids and episodes for that slug only", () => {
  const slug = "frieren-beyond-journey-s-end-QEd4Q";
  const html = `<a href="https://anilist.co/anime/154587">AniList</a>
    <a href="https://myanimelist.net/anime/52991">MAL</a>
    <a href="/episode/${slug}/ep-2" class="ep-tile">2</a>
    <a href="/episode/${slug}/ep-1" class="ep-tile">1</a>
    <a href="/episode/${slug}/ep-1" class="ep-tile">1</a>
    <a href="/episode/other-show-AAAAA/ep-9" class="ep-tile">9</a>`;
  assert.deepEqual(parseAnimePage(html, slug), {
    anilistId: 154587,
    malId: 52991,
    episodes: [
      { number: 1, path: `${slug}/ep-1` },
      { number: 2, path: `${slug}/ep-2` },
    ],
  });
});

test("animesaturn: embed params and XOR-decoded playlist source", () => {
  const key = "a872e560810319ccd9d1ecbaca05ed2e";
  assert.deepEqual(
    parseEmbedParams(`window.__E={i:60415,k:"${key}",e:1794971692};window.__JW={}`),
    { id: "60415", key, expires: "1794971692" },
  );
  const src = "https://srv42.example.org/DDL/ANIME/Ep_01_SUB_ITA.mp4?token=x";
  let xored = "";
  for (let i = 0; i < src.length; i++) xored += String.fromCharCode(src.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  assert.equal(decodeSaturn(Buffer.from(xored, "latin1").toString("base64"), key), src);
  assert.equal(decodeSaturn("", key), "");
});

test("animesaturn: search queries start broad and skip non-Latin titles", () => {
  assert.deepEqual(
    searchQueries(["Frieren: Beyond Journey’s End Season 2", "Sousou no Frieren 2nd Season", "葬送のフリーレン 第2期"]),
    ["Frieren: Beyond Journey's End", "Frieren", "Sousou no Frieren", "Sousou no Frieren 2nd Season", "Frieren: Beyond Journey's End Season 2"],
  );
});
