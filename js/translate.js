// Translation of a lyric line (the "context" for a word) from the language
// being learned into the reader's own language.
//
// The old app paid for Google Cloud Translation and needed a Celery worker and
// Redis to run it in the background. This tries two free routes instead:
//   1. The browser's built-in Translator (Chrome 138+ on desktop). It runs on
//      the device: free, unlimited, and the lyric never leaves the computer.
//   2. MyMemory's public API: free, no key, about 5,000 characters a day per
//      visitor — a few hundred lyric lines.
//
// Every translation is cached in the browser, so a line is only ever
// translated once.

import { EDITION, LANGUAGES } from './edition.js';
import { createCache } from './storage.js';

const MYMEMORY = 'https://api.mymemory.translated.net/get';
const MAX_LENGTH = 450; // MyMemory rejects queries over 500 bytes

const SETUP_WAIT_MS = 3000;
const ON_DEVICE_WAIT_MS = 8000;

const cache = createCache('translations.v1', 600);
// The browser's Translator for each target language: `translator` once it is
// ready, `setup` the Promise started on first use.
const onDevice = new Map();

// A version with one target language keeps the plain line as the cache key
// (as the first release did); with several, the language is part of the key.
const cacheKey = (line, native) => (EDITION.natives.length > 1 ? `${native}|${line}` : line);

/** Thrown when the free daily allowance is used up. */
export class TranslationQuotaError extends Error {}

/** @returns {string|undefined} a translation already known for this line */
export function cachedTranslation(line, native = EDITION.natives[0]) {
  return cache.get(cacheKey(line, native));
}

/**
 * @param {string} line    one line of lyrics
 * @param {string} native  the language to translate into (one of EDITION.natives)
 * @returns {Promise<string>} the translation
 */
export async function translateLine(line, native = EDITION.natives[0]) {
  const known = cache.get(cacheKey(line, native));
  if (known) return known;
  const text = line.slice(0, MAX_LENGTH);
  const translated = (await translateOnDevice(text, native)) ?? (await translateWithMyMemory(text, native));
  cache.set(cacheKey(line, native), translated);
  return translated;
}

// Some browsers expose the Translator API but never answer it, and a first
// use may be busy downloading a language pack. So the on-device route gets a
// short time budget: the first line waits a few seconds for it, and until it
// is ready every line goes to MyMemory instead. If it becomes ready later,
// later lines use it.
async function translateOnDevice(text, native) {
  let state = onDevice.get(native);
  if (!state) {
    onDevice.set(native, (state = { translator: null, waited: false }));
    state.setup = setUpOnDevice(native, state);
  }
  if (!state.waited) {
    await withTimeout(state.setup, SETUP_WAIT_MS);
    state.waited = true;
  }
  if (!state.translator) return null;
  try {
    return (await withTimeout(state.translator.translate(text), ON_DEVICE_WAIT_MS)) || null;
  } catch {
    return null;
  }
}

async function setUpOnDevice(native, state) {
  try {
    if (!('Translator' in globalThis)) return;
    const pair = { sourceLanguage: EDITION.learn, targetLanguage: native };
    if ((await globalThis.Translator.availability(pair)) === 'unavailable') return;
    state.translator = await globalThis.Translator.create(pair);
  } catch {
    // Not supported here after all: MyMemory handles it.
  }
}

/** Resolves with the promise's value, or undefined if it takes longer than `ms`. */
function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))]);
}

async function translateWithMyMemory(text, native) {
  const langpair = `${LANGUAGES[EDITION.learn].memory}|${LANGUAGES[native].memory}`;
  let data;
  try {
    const response = await fetch(`${MYMEMORY}?${new URLSearchParams({ q: text, langpair })}`, {
      signal: AbortSignal.timeout(12_000),
    });
    data = await response.json();
  } catch {
    throw new Error('The translation service could not be reached. Try again in a moment.');
  }
  const translated = data?.responseData?.translatedText ?? '';
  if (data?.quotaFinished || Number(data?.responseStatus) === 429 || /MYMEMORY WARNING/i.test(translated)) {
    throw new TranslationQuotaError(
      "Today's free translations are used up. They reset tomorrow — or open the app in Chrome on a computer, which translates on the device with no limit.",
    );
  }
  if (Number(data?.responseStatus) !== 200 || !translated) {
    throw new Error('The translation service returned an error. Try again in a moment.');
  }
  return decodeEntities(translated);
}

// MyMemory sometimes returns "l&#39;amour".
function decodeEntities(text) {
  if (!text.includes('&')) return text;
  return new DOMParser().parseFromString(text, 'text/html').documentElement.textContent ?? text;
}
