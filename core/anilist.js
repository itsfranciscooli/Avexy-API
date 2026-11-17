const __name = (fn, _) => fn;

var resolved = new Map();
var inflight = new Map();
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
var ARM = "https://arm.haglund.dev/api/v2/ids";
var ANILIST_WEB = "https://anilist.co";

const AL_STATUS_MAP = {
  RELEASING: "RELEASING",
  FINISHED: "FINISHED",
  NOT_YET_RELEASED: "NOT_YET_RELEASED",
  CANCELLED: "FINISHED",
  HIATUS: "HIATUS",
};

function cookiesFromHeaders(headers) {
  const values = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [headers.get("set-cookie")].filter(Boolean);
  return values.map((value) => String(value).split(";")[0]).join("; ");
}

async function mediaFromResponse(res) {
  if (!res?.ok) return null;
  try {
    const json = await res.json();
    return json.data?.Media ?? null;
  } catch {
    return null;
  }
}

async function fetchFromAniListWeb(body) {
  const home = await fetch(`${ANILIST_WEB}/`, {
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
  }).catch(() => null);
  if (!home?.ok) return null;
  const html = await home.text();
  const token = html.match(/window\.al_token\s*=\s*"([^"]+)"/)?.[1];
  const cookie = cookiesFromHeaders(home.headers);
  if (!token || !cookie) return null;
  const res = await fetch(`${ANILIST_WEB}/graphql`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": UA,
      Referer: `${ANILIST_WEB}/home`,
      "x-csrf-token": token,
      schema: "default",
      Cookie: cookie,
    },
    body,
  }).catch(() => null);
  return mediaFromResponse(res);
}

async function fetchFromAniList(id) {
  const fullQuery = `query($id:Int){Media(id:$id,type:ANIME){id idMal title{english romaji native} status format episodes seasonYear startDate{year} genres synonyms nextAiringEpisode{episode airingAt timeUntilAiring}}}`;
  const body = JSON.stringify({ query: fullQuery, variables: { id } });
  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "User-Agent": UA },
    body,
  }).catch(() => null);
  return await mediaFromResponse(res) ?? fetchFromAniListWeb(body);
}

async function getMedia(anilistId) {
  const id = Number(anilistId);
  if (resolved.has(id)) return resolved.get(id);
  if (inflight.has(id)) return inflight.get(id);
  const promise = (async () => {
    const arm = await fetch(`${ARM}?source=anilist&id=${id}`, {
      headers: { "User-Agent": UA, "Accept": "application/json" }
    }).then((r) => {
      if (!r.ok) return null;
      return r.json();
    }).catch(() => null);

    const al = await fetchFromAniList(id);
    if (!al) throw new Error(`No data found for AniList ID ${id}`);
    const media = {
      id,
      idMal: al.idMal ?? arm?.myanimelist ?? null,
      title: {
        english: al.title?.english ?? null,
        romaji: al.title?.romaji ?? null,
        native: al.title?.native ?? null,
      },
      status: AL_STATUS_MAP[al.status] ?? "RELEASING",
      format: al.format ?? null,
      episodes: al.episodes ?? null,
      seasonYear: al.seasonYear ?? null,
      startDate: al.startDate ?? null,
      genres: Array.isArray(al.genres) ? al.genres : [],
      nextAiringEpisode: al.nextAiringEpisode ?? null,
      synonyms: Array.isArray(al.synonyms) ? al.synonyms : [],
    };
    resolved.set(id, media);
    inflight.delete(id);
    return media;
  })().catch((e) => {
    inflight.delete(id);
    throw e;
  });
  inflight.set(id, promise);
  return promise;
}
__name(getMedia, "getMedia");

function forgetMedia(anilistId) {
  resolved.delete(Number(anilistId));
}

async function graphql(query, variables, fetchImpl = fetch) {
  try {
    const res = await fetchImpl("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json", "User-Agent": UA },
      body: JSON.stringify({ query, variables }),
    });
    if (!res?.ok) return null;
    const json = await res.json();
    return json?.data ?? null;
  } catch {
    return null;
  }
}

// Walks every page of a Page{} query; on a failed page keeps what was collected so far.
async function collectPages(query, variables, pick, fetchImpl) {
  const out = [];
  for (let page = 1; page <= 50; page++) {
    const data = await graphql(query, { ...variables, page }, fetchImpl);
    if (!data?.Page) break;
    out.push(...pick(data.Page));
    if (!data.Page.pageInfo?.hasNextPage) break;
  }
  return out;
}

const ids = (media) => (Array.isArray(media) ? media : []).map((m) => m?.id).filter(Number.isInteger);

async function fetchTopAnimeIds(sort, limit, fetchImpl = fetch) {
  const query = `query($sort:[MediaSort],$perPage:Int){Page(page:1,perPage:$perPage){media(type:ANIME,sort:$sort,isAdult:false){id}}}`;
  const data = await graphql(query, { sort: [sort], perPage: limit }, fetchImpl);
  return ids(data?.Page?.media);
}

async function fetchSeasonAnimeIds(season, year, fetchImpl = fetch) {
  const query = `query($page:Int,$season:MediaSeason,$year:Int){Page(page:$page,perPage:50){pageInfo{hasNextPage} media(type:ANIME,season:$season,seasonYear:$year,isAdult:false){id}}}`;
  return collectPages(query, { season, year }, (p) => ids(p.media), fetchImpl);
}

async function fetchAiringSchedule(fromSec, toSec, fetchImpl = fetch) {
  const query = `query($page:Int,$from:Int,$to:Int){Page(page:$page,perPage:50){pageInfo{hasNextPage} airingSchedules(airingAt_greater:$from,airingAt_lesser:$to){mediaId airingAt}}}`;
  return collectPages(query, { from: fromSec, to: toSec }, (p) =>
    (Array.isArray(p.airingSchedules) ? p.airingSchedules : [])
      .filter((a) => Number.isInteger(a?.mediaId) && Number.isFinite(a?.airingAt))
      .map(({ mediaId, airingAt }) => ({ mediaId, airingAt })), fetchImpl);
}

export { getMedia, forgetMedia, fetchTopAnimeIds, fetchSeasonAnimeIds, fetchAiringSchedule };
