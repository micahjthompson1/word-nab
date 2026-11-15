// Lyrics lookup, straight from the browser.
//
// The old app called api.lyrics.ovh through a /proxy route on the server.
// Both services used here send CORS headers, so no server is needed:
//   1. LRCLIB (lrclib.net) — free, no key, large catalogue. Tried first.
//   2. lyrics.ovh — kept as a fallback because it goes down for long stretches.
//
// Results are cached in the browser, so a song you replay all week is looked
// up once.

import { createCache } from './storage.js';

const LRCLIB = 'https://lrclib.net/api';
const LYRICS_OVH = 'https://api.lyrics.ovh/v1';
const TIMEOUT_MS = 10_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const cache = createCache('lyrics.v1', 150);

/**
 * @param {{ title: string, artist: string, album?: string, durationMs?: number }} track
 * @returns {Promise<{ status: 'found'|'instrumental'|'missing'|'unavailable', text: string }>}
 *   'missing' means the services answered and have no lyrics for the song;
 *   'unavailable' means they could not be reached, so it is worth retrying.
 */
export async function fetchLyrics(track) {
  const key = `${track.artist}|${track.title}`.toLowerCase();
  // A miss is only remembered for a day: the song may be added later.
  const cached = cache.get(key);
  if (cached && (cached.status !== 'missing' || cache.get(key, DAY_MS))) return cached;

  let lrclibDown = false;
  const attempt = async (source, isLrclib) => {
    try {
      return await source(track);
    } catch {
      lrclibDown ||= isLrclib;
      return null;
    }
  };
  const result =
    (await attempt(fromLrclibExact, true)) ??
    (await attempt(fromLrclibSearch, true)) ??
    (await attempt(fromLyricsOvh, false));

  if (result) {
    cache.set(key, result);
    return result;
  }
  if (lrclibDown) return { status: 'unavailable', text: '' }; // not cached
  const missing = { status: 'missing', text: '' };
  cache.set(key, missing);
  return missing;
}

/**
 * Free-text song search, for adding a song that is not in the Spotify list.
 * @param {string} query  e.g. "papaoutai stromae"
 * @returns {Promise<{ id: string, title: string, artist: string, album: string, lyrics: { status: string, text: string } }[]>}
 */
export async function searchSongs(query) {
  const results = await getJson(`${LRCLIB}/search?${new URLSearchParams({ q: query })}`);
  if (!Array.isArray(results)) return [];
  // LRCLIB is crowd-sourced and usually has several uploads of one song, some
  // labelled "Artist - Title (Official Video)". Uploads that open with the
  // same words are the same song: keep one of each, the most tidily labelled.
  const songs = new Map();
  for (const record of results) {
    const lyrics = toResult(record);
    if (lyrics.status !== 'found') continue;
    const opening = lyrics.text.toLowerCase().replace(/[^\p{L}]/gu, '').slice(0, 24);
    const kept = songs.get(opening);
    if (!kept || untidiness(record) < untidiness(kept.record)) songs.set(opening, { record, lyrics });
  }
  return [...songs.values()].slice(0, 5).map(({ record, lyrics }) => ({
    id: `lrclib:${record.id}`,
    title: record.trackName,
    artist: record.artistName,
    album: record.albumName ?? '',
    lyrics,
  }));
}

function untidiness({ trackName = '', artistName = '' }) {
  const title = trackName.toLowerCase();
  return (
    (title.includes(' - ') ? 2 : 0) +
    (artistName && title.includes(artistName.toLowerCase()) ? 2 : 0) +
    (/[([]/.test(title) ? 1 : 0)
  );
}

async function fromLrclibExact({ title, artist, album, durationMs }) {
  const params = new URLSearchParams({ track_name: title, artist_name: artist });
  if (album) params.set('album_name', album);
  if (durationMs) params.set('duration', String(Math.round(durationMs / 1000)));
  const record = await getJson(`${LRCLIB}/get?${params}`);
  return record ? usable(toResult(record)) : null;
}

async function fromLrclibSearch({ title, artist, durationMs }) {
  const params = new URLSearchParams({ track_name: simplifyTitle(title), artist_name: artist });
  const records = await getJson(`${LRCLIB}/search?${params}`);
  if (!Array.isArray(records) || !records.length) return null;
  const seconds = durationMs ? durationMs / 1000 : null;
  // Prefer a version with lyrics, then the one closest in length to the
  // track that was actually played.
  const ranked = records
    .map((record) => ({ record, result: toResult(record) }))
    .filter(({ result }) => result.status !== 'missing')
    .sort((a, b) => {
      const byLyrics = Number(b.result.status === 'found') - Number(a.result.status === 'found');
      if (byLyrics || seconds === null) return byLyrics;
      return Math.abs((a.record.duration ?? 0) - seconds) - Math.abs((b.record.duration ?? 0) - seconds);
    });
  return ranked[0]?.result ?? null;
}

async function fromLyricsOvh({ title, artist }) {
  const url = `${LYRICS_OVH}/${encodeURIComponent(artist)}/${encodeURIComponent(simplifyTitle(title))}`;
  const data = await getJson(url);
  if (!data?.lyrics) return null;
  // lyrics.ovh sometimes prefixes "Paroles de la chanson … par …".
  const text = data.lyrics.replace(/^Paroles de la chanson[^\n]*\n/i, '').trim();
  return text ? { status: 'found', text } : null;
}

function toResult(record) {
  if (record.instrumental) return { status: 'instrumental', text: '' };
  const text = record.plainLyrics?.trim() || stripTimestamps(record.syncedLyrics ?? '');
  return text ? { status: 'found', text } : { status: 'missing', text: '' };
}

// An exact match with no lyrics should not stop the search for another upload.
function usable(result) {
  return result.status === 'missing' ? null : result;
}

function stripTimestamps(synced) {
  return synced.replace(/^\[[\d:.]+\]\s?/gm, '').trim();
}

// "Alors on danse - Radio Edit" and "Tous les mêmes (feat. X)" are filed
// under the plain title by lyrics sites.
export function simplifyTitle(title) {
  return title
    .replace(/\s+-\s+.*$/, '')
    .replace(/\s*[([](?:feat|ft|with|avec)\b[^)\]]*[)\]]/gi, '')
    .trim() || title;
}

/** GET a URL as JSON. Returns null for "not found"; throws on timeouts and outages. */
async function getJson(url, retry = true) {
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (response.status === 404) return null;
  if (response.status === 429 && retry) {
    // Asked to slow down: wait as told (a few seconds at most) and try once more.
    const seconds = Math.min(Number(response.headers.get('Retry-After')) || 1.5, 5);
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    return getJson(url, false);
  }
  if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}`);
  return response.json();
}
