import { getMedia } from "../core/anilist.js";
import {
  UA,
  buildTitles,
  decodeEntities,
  episodeMeta,
  expectedCount,
  fetchHtml,
  findTopSlugs,
  getPrequelOffset,
  json,
  selectSeries,
  stripTags,
} from "../core/new-provider-utils.js";
import { get, set, isFresh, SHOW_IDENTITY_TTL } from "../core/smartcache.js";

const BASE = "https://gogoanime.by";
const SERIES_TTL = 10 * 60_000;
const DUB_TITLE = /\s*(?:\(\s*dub\s*\)|english\s+dub(?:bed)?)\s*$/i;
const MEGAVID = /^https?:\/\/(?:www\.)?megavid\.[a-z]+\/mal\/\d+\/\d+\/(?:sub|dub)\/?$/i;
const seriesCache = new Map();

export function isDubSeries(title = "", slug = "") {
  return DUB_TITLE.test(title) || /(?:^|-)dub(?:bed)?(?:-|$)/i.test(slug);
}

export function cleanSeriesTitle(title = "") {
  return title.replace(DUB_TITLE, "").trim();
}

// WordPress REST search: up to 50 series per query, where the HTML search
// page stops at 10 and can push the main series off the first page.
export function parseSearch(data) {
  const results = [];
  for (const item of Array.isArray(data) ? data : []) {
    if (item?.subtype && item.subtype !== "series") continue;
    const slug = String(item?.url ?? "").match(/\/series\/([^/?#]+)/)?.[1];
    if (!slug) continue;
    const title = decodeEntities(String(item.title ?? ""));
    results.push({ slug, title, text: cleanSeriesTitle(title), dub: isDubSeries(title, slug) });
  }
  return results;
}

async function search(query) {
  const res = await fetch(`${BASE}/wp-json/wp/v2/search?search=${encodeURIComponent(query)}&per_page=50`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Gogoanime search HTTP ${res.status}`);
  return parseSearch(await res.json());
}

export function parseSeriesEpisodes(html) {
  const episodes = new Map();
  for (const m of html.matchAll(/data-episode-number=["'](\d+)["'][^>]*>\s*<a\b[^>]*href=["']([^"']+)["']/gi)) {
    const number = Number(m[1]);
    if (!episodes.has(number)) episodes.set(number, { number, url: decodeEntities(m[2]) });
  }
  return [...episodes.values()].sort((a, b) => a.number - b.number);
}

export function parseServers(html) {
  const servers = [];
  for (const group of html.matchAll(/<div\b[^>]*class=["']type["'][^>]*data-type=["']([a-z]+)["'][^>]*>([\s\S]*?)<\/ul>/gi)) {
    for (const item of group[2].matchAll(/<li\b[^>]*data-src=["']([^"']+)["'][^>]*>([\s\S]*?)<\/li>/gi)) {
      servers.push({
        audio: group[1].toLowerCase(),
        name: stripTags(item[2]) || "Gogoanime",
        url: decodeEntities(item[1]),
      });
    }
  }
  return servers;
}

export function parsePlayerSources(html) {
  const raw = html.match(/var\s+sources\s*=\s*(\[[\s\S]*?\]);/)?.[1];
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    const seen = new Set();
    return (Array.isArray(parsed) ? parsed : []).filter((s) => s?.file && !seen.has(s.file) && seen.add(s.file));
  } catch {
    return [];
  }
}

export function parsePlayerIframe(html) {
  const src = html.match(/<iframe\b[^>]*\bsrc=["']([^"']+)["']/i)?.[1];
  return src ? decodeEntities(src) : null;
}

export function parseEmbedFiles(html) {
  const files = new Set();
  for (const m of html.matchAll(/\bfile\s*:\s*["']([^"']+\.(?:m3u8|mp4)(?:\?[^"']*)?)["']/gi)) files.add(m[1]);
  return [...files];
}

function streamType(url, hint) {
  if (hint === "hls" || /\.m3u8(?:\?|$)/i.test(url)) return "hls";
  if (hint === "mp4" || /\.mp4(?:\?|$)|mime=video%2Fmp4|mime=video\/mp4/i.test(url)) return "mp4";
  return hint || "hls";
}

function megavidSubtitles(tracks) {
  return (Array.isArray(tracks) ? tracks : [])
    .filter((t) => t?.file && (!t.kind || /captions|subtitles/i.test(t.kind)))
    .map((t) => ({ url: t.file, label: t.label ?? null, default: Boolean(t.default) }));
}

async function resolveMegavid(embedUrl, server) {
  const base = embedUrl.replace(/\/$/, "");
  const variants = [
    { query: "noax=1", label: server },
    { query: "provider=1", label: `${server}-Provider` },
    { query: "", label: `${server}-Mirror` },
  ];
  const results = await Promise.allSettled(variants.map(async (variant) => {
    const res = await fetch(`${base}/source${variant.query ? `?${variant.query}` : ""}`, {
      headers: { Accept: "application/json", Referer: embedUrl, "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) throw new Error(`megavid HTTP ${res.status}`);
    const data = await res.json();
    if (data?.status !== "ok" || !data.source) throw new Error(data?.message || "megavid: no source");
    return {
      url: data.source,
      type: streamType(data.source, data.type),
      server: variant.label,
      referer: `${new URL(embedUrl).origin}/`,
      subtitles: megavidSubtitles(data.tracks),
    };
  }));
  const seen = new Set();
  return results
    .filter((r) => r.status === "fulfilled" && !seen.has(r.value.url) && seen.add(r.value.url))
    .map((r) => r.value);
}

async function resolveFileEmbed(embedUrl, server) {
  const html = await fetchHtml(embedUrl, { Referer: `${BASE}/` });
  return parseEmbedFiles(html).map((url) => ({
    url,
    type: streamType(url),
    server,
    referer: `${new URL(embedUrl).origin}/`,
  }));
}

async function resolveServer(server) {
  const html = await fetchHtml(server.url, { Referer: `${BASE}/` });
  const direct = parsePlayerSources(html).map((s) => ({
    url: s.file,
    type: streamType(s.file, s.type),
    quality: s.label ?? null,
    server: server.name,
  }));
  if (direct.length) return direct;

  const embedUrl = parsePlayerIframe(html);
  if (!embedUrl) return [];
  const resolved = MEGAVID.test(embedUrl)
    ? await resolveMegavid(embedUrl, server.name)
    : await resolveFileEmbed(embedUrl, server.name).catch(() => []);
  return [
    ...resolved,
    { url: embedUrl, type: "embed", server: `${server.name}-embed`, referer: `${BASE}/` },
  ];
}

async function scrapeSeries(slug) {
  const hit = seriesCache.get(slug);
  if (hit && hit.expires > Date.now()) return hit.episodes;
  const episodes = parseSeriesEpisodes(await fetchHtml(`${BASE}/series/${slug}/`));
  seriesCache.set(slug, { episodes, expires: Date.now() + SERIES_TTL });
  return episodes;
}

async function resolveSeries(anilistId, ctx = {}) {
  const cacheKey = `np:match2:gogoanime:${anilistId}`;
  const cached = get(cacheKey);
  if (isFresh(cached)) return cached.data;

  const media = ctx.media ?? await getMedia(anilistId);
  const titles = buildTitles(media, ctx.anizip);
  const pool = new Map();
  const searchFn = async (query) => {
    const results = await search(query);
    for (const r of results) pool.set(r.slug, r);
    return results.map((r) => ({ slug: r.slug, text: r.text }));
  };
  const candidates = await findTopSlugs(titles, searchFn, 12);
  const expected = expectedCount(media, ctx.anizip);
  const offset = await getPrequelOffset(anilistId).catch(() => 0);
  const isSingleMovie = String(media?.format ?? "").toUpperCase() === "MOVIE" || expected === 1;
  const options = { minScore: isSingleMovie ? 0.9 : 0.65 };
  const pick = (dub) => selectSeries(
    candidates.filter((c) => Boolean(pool.get(c.slug)?.dub) === dub).slice(0, 6),
    scrapeSeries,
    expected,
    media?.status,
    offset,
    options,
  );
  const [sub, dub] = await Promise.all([pick(false), pick(true)]);
  if (!sub && !dub) throw new Error(`Gogoanime match not found for AniList ${anilistId}`);

  const shape = (s) => s && { slug: s.slug, title: s.title, mode: s.mode, offset, score: s.score };
  const data = { sub: shape(sub), dub: shape(dub) };
  set(cacheKey, data, SHOW_IDENTITY_TTL);
  return data;
}

function buildEpisodeList(anilistId, series, providerEpisodes, audio, ctx, expected) {
  if (!series) return [];
  const list = [];
  for (const src of providerEpisodes) {
    const number = series.mode === "offset" ? src.number - series.offset : src.number;
    if (number < 1) continue;
    if (expected && number > expected) continue;
    const meta = episodeMeta(number, ctx);
    list.push({
      id: `watch/gogoanime/${anilistId}/${audio}/gogoanime-${number}`,
      number,
      title: meta.title ?? `Episode ${number}`,
      duration: meta.duration,
      filler: meta.filler,
      uncensored: meta.uncensored,
      description: meta.description,
      image: meta.image,
      airDate: meta.airDate,
      sourceNumber: src.number,
      audio,
    });
  }
  return list;
}

export async function getEpisodes(anilistId, ctx = {}) {
  const media = ctx.media ?? await getMedia(anilistId);
  const localCtx = { ...ctx, media };
  const series = await resolveSeries(anilistId, localCtx);
  const expected = expectedCount(media, ctx.anizip);
  const [subEpisodes, dubEpisodes] = await Promise.all([
    series.sub ? scrapeSeries(series.sub.slug) : [],
    series.dub ? scrapeSeries(series.dub.slug) : [],
  ]);
  const primary = series.sub ?? series.dub;
  return {
    meta: {
      id: primary.slug,
      title: primary.title,
      dubId: series.dub?.slug ?? null,
      source: "gogoanime",
      matchScore: Number(primary.score.toFixed(3)),
      numbering: primary.mode,
      episodeOffset: primary.mode === "offset" ? primary.offset : 0,
    },
    episodes: {
      sub: buildEpisodeList(anilistId, series.sub, subEpisodes, "sub", localCtx, expected),
      dub: buildEpisodeList(anilistId, series.dub, dubEpisodes, "dub", localCtx, expected),
    },
  };
}

async function handleWatch(anilistId, audio, epNum) {
  const series = (await resolveSeries(anilistId))[audio];
  if (!series) return json({ error: `Gogoanime: no ${audio} series for AniList ${anilistId}` }, 404);

  const providerEp = series.mode === "offset" ? Number(epNum) + series.offset : Number(epNum);
  const ep = (await scrapeSeries(series.slug)).find((e) => e.number === providerEp);
  if (!ep) return json({ error: `Gogoanime episode ${providerEp} not found` }, 404);

  const servers = parseServers(await fetchHtml(ep.url, { Referer: `${BASE}/` }));
  const matching = servers.filter((s) => s.audio === audio);
  const chosen = matching.length ? matching : servers;
  const results = await Promise.allSettled(chosen.map(resolveServer));
  const streams = results.flatMap((r) => r.status === "fulfilled" ? r.value : []);
  if (!streams.length) return json({ error: `Gogoanime: no streams for episode ${providerEp}` }, 404);

  const active = Math.max(0, streams.findIndex((s) => s.type !== "embed"));
  return json({
    anilistId: Number(anilistId),
    episode: Number(epNum),
    providerEpisode: providerEp,
    audio,
    streams: streams.map((s, i) => ({
      ...s,
      audio,
      priority: streams.length - i,
      isActive: i === active,
    })),
  });
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS", "Access-Control-Allow-Headers": "*" } });
    }
    const url = new URL(request.url);
    try {
      const m = url.pathname.match(/^\/watch\/gogoanime\/(\d+)\/(sub|dub)\/gogoanime-(\d+)\/?$/);
      if (m) return await handleWatch(m[1], m[2], m[3]);
      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err.message, stack: err.stack }, 500);
    }
  },
};
