// Spotify sign-in and the "recently played" list.
//
// The old app used the implicit grant (response_type=token), which Spotify
// switched off on 27 November 2025. This uses the replacement, Authorization
// Code with PKCE. It runs entirely in the browser and needs no client secret,
// so there is still no server involved.
//
// Docs: https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow

import { CONFIG } from './config.js';
import { load, remove, save } from './storage.js';

const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';
const PENDING_KEY = 'wordnab.spotify.pending'; // sessionStorage: one login attempt
const TOKENS = 'spotify.tokens'; // localStorage: stay signed in between visits

/** Thrown when the user has to connect (again) before Spotify will answer. */
export class SpotifyAuthError extends Error {}

/**
 * The address Spotify sends the user back to: this page, without query or
 * hash. It must be listed, character for character, under "Redirect URIs" in
 * the Spotify developer dashboard.
 */
export function redirectUri() {
  return new URL('.', window.location.href.split(/[?#]/)[0]).href;
}

export function isConnected() {
  return Boolean(load(TOKENS, null));
}

export function disconnect() {
  remove(TOKENS);
}

/** Send the user to Spotify to approve access. Does not return. */
export async function beginLogin() {
  const verifier = randomString(64);
  const state = randomString(16);
  sessionStorage.setItem(PENDING_KEY, JSON.stringify({ verifier, state }));
  const params = new URLSearchParams({
    client_id: CONFIG.spotifyClientId,
    response_type: 'code',
    redirect_uri: redirectUri(),
    scope: CONFIG.spotifyScope,
    code_challenge_method: 'S256',
    code_challenge: await codeChallenge(verifier),
    state,
  });
  window.location.assign(`${AUTHORIZE_URL}?${params}`);
}

/**
 * Call once on page load. If Spotify has just sent the user back, finish the
 * sign-in and tidy the address bar.
 * @returns {Promise<'connected'|'none'>}
 * @throws {SpotifyAuthError} if the sign-in was refused or could not be completed
 */
export async function completeLogin() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const error = params.get('error');
  if (!code && !error) return 'none';

  const pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? 'null');
  sessionStorage.removeItem(PENDING_KEY);
  // Drop ?code=… so a reload does not replay it.
  window.history.replaceState(null, '', redirectUri());

  if (error) {
    throw new SpotifyAuthError(
      error === 'access_denied' ? 'Spotify access was not approved.' : `Spotify sign-in failed (${error}).`,
    );
  }
  if (!pending || pending.state !== params.get('state')) {
    throw new SpotifyAuthError('That sign-in link was not started from this tab. Please connect again.');
  }
  await requestTokens({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    code_verifier: pending.verifier,
  });
  return 'connected';
}

/**
 * The user's recently played tracks, most recent first, each song once.
 * @returns {Promise<{ id: string, title: string, artist: string, album: string, durationMs: number, image: string }[]>}
 */
export async function fetchRecentTracks() {
  const data = await apiGet(`/me/player/recently-played?limit=${CONFIG.recentPlays}`);
  const tracks = new Map();
  for (const { track } of data.items ?? []) {
    if (!track?.id || tracks.has(track.id)) continue;
    const images = track.album?.images ?? [];
    tracks.set(track.id, {
      id: track.id,
      title: track.name,
      // Main artist only: that is how lyrics sites file songs.
      artist: track.artists?.[0]?.name ?? '',
      album: track.album?.name ?? '',
      durationMs: track.duration_ms ?? 0,
      image: images.at(-1)?.url ?? '', // the smallest size Spotify offers
    });
  }
  return [...tracks.values()];
}

async function apiGet(path, retried = false) {
  const token = await accessToken();
  const response = await fetch(API + path, { headers: { Authorization: `Bearer ${token}` } });
  if (response.status === 401 && !retried) {
    // The token was revoked or expired early: force a refresh and try once more.
    const tokens = load(TOKENS, null);
    if (tokens) save(TOKENS, { ...tokens, expiresAt: 0 });
    return apiGet(path, true);
  }
  if (response.status === 401) {
    disconnect();
    throw new SpotifyAuthError('Your Spotify session ended. Please connect again.');
  }
  if (response.status === 403) {
    throw new Error(
      'Spotify refused the request. In the Spotify developer dashboard, check that this account is ' +
        'listed under User Management for the app, and that the app owner has Spotify Premium ' +
        '(required for development-mode apps since 2026).',
    );
  }
  if (response.status === 429) {
    const wait = response.headers.get('Retry-After');
    throw new Error(`Spotify is rate-limiting requests. Try again ${wait ? `in ${wait} seconds` : 'in a minute'}.`);
  }
  if (!response.ok) throw new Error(`Spotify answered with an error (${response.status}).`);
  return response.json();
}

async function accessToken() {
  const tokens = load(TOKENS, null);
  if (!tokens) throw new SpotifyAuthError('Connect Spotify to see your recent songs.');
  if (Date.now() < tokens.expiresAt - 60_000) return tokens.accessToken;
  if (!tokens.refreshToken) {
    disconnect();
    throw new SpotifyAuthError('Your Spotify session ended. Please connect again.');
  }
  const fresh = await requestTokens({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken });
  return fresh.accessToken;
}

async function requestTokens(fields) {
  let response;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CONFIG.spotifyClientId, ...fields }),
    });
  } catch {
    throw new Error('Could not reach Spotify. Check your connection and try again.');
  }
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    disconnect();
    throw new SpotifyAuthError(
      detail.error === 'invalid_grant'
        ? 'Your Spotify session ended. Please connect again.'
        : `Spotify sign-in failed (${detail.error_description ?? detail.error ?? response.status}).`,
    );
  }
  const data = await response.json();
  const tokens = {
    accessToken: data.access_token,
    // Spotify may or may not send a new refresh token; keep the old one if not.
    refreshToken: data.refresh_token ?? fields.refresh_token ?? null,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  save(TOKENS, tokens);
  return tokens;
}

function randomString(length) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

export async function codeChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}
