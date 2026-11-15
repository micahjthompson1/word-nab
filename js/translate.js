// French → English translation of a lyric line (the "context" for a word).
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

import { createCache } from './storage.js';

const MYMEMORY = 'https://api.mymemory.translated.net/get';
const MAX_LENGTH = 450; // MyMemory rejects queries over 500 bytes

const SETUP_WAIT_MS = 3000;
const ON_DEVICE_WAIT_MS = 8000;

const cache = createCache('translations.v1', 600);
let onDevice = null; // the browser's Translator, once it is ready
let onDeviceSetup; // Promise, started on first use
let waitedForSetup = false;

/** Thrown when the free daily allowance is used up. */
export class TranslationQuotaError extends Error {}

/** @returns {string|undefined} a translation already known for this line */
export function cachedTranslation(line) {
  return cache.get(line);
}

/**
 * @param {string} line  one line of French lyrics
 * @returns {Promise<string>} the English translation
 */
export async function translateLine(line) {
  const known = cache.get(line);
  if (known) return known;
  const text = line.slice(0, MAX_LENGTH);
  const english = (await translateOnDevice(text)) ?? (await translateWithMyMemory(text));
  cache.set(line, english);
  return english;
}

// Some browsers expose the Translator API but never answer it, and a first
// use may be busy downloading a language pack. So the on-device route gets a
// short time budget: the first line waits a few seconds for it, and until it
// is ready every line goes to MyMemory instead. If it becomes ready later,
// later lines use it.
async function translateOnDevice(text) {
  onDeviceSetup ??= setUpOnDevice();
  if (!waitedForSetup) {
    await withTimeout(onDeviceSetup, SETUP_WAIT_MS);
    waitedForSetup = true;
  }
  if (!onDevice) return null;
  try {
    return (await withTimeout(onDevice.translate(text), ON_DEVICE_WAIT_MS)) || null;
  } catch {
    return null;
  }
}

async function setUpOnDevice() {
  try {
    if (!('Translator' in globalThis)) return;
    const pair = { sourceLanguage: 'fr', targetLanguage: 'en' };
    if ((await globalThis.Translator.availability(pair)) === 'unavailable') return;
    onDevice = await globalThis.Translator.create(pair);
  } catch {
    // Not supported here after all: MyMemory handles it.
  }
}

/** Resolves with the promise's value, or undefined if it takes longer than `ms`. */
function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))]);
}

async function translateWithMyMemory(text) {
  let data;
  try {
    const response = await fetch(`${MYMEMORY}?${new URLSearchParams({ q: text, langpair: 'fr|en' })}`, {
      signal: AbortSignal.timeout(12_000),
    });
    data = await response.json();
  } catch {
    throw new Error('The translation service could not be reached. Try again in a moment.');
  }
  const english = data?.responseData?.translatedText ?? '';
  if (data?.quotaFinished || Number(data?.responseStatus) === 429 || /MYMEMORY WARNING/i.test(english)) {
    throw new TranslationQuotaError(
      "Today's free translations are used up. They reset tomorrow — or open the app in Chrome on a computer, which translates on the device with no limit.",
    );
  }
  if (Number(data?.responseStatus) !== 200 || !english) {
    throw new Error('The translation service returned an error. Try again in a moment.');
  }
  return decodeEntities(english);
}

// MyMemory sometimes returns "l&#39;amour".
function decodeEntities(text) {
  if (!text.includes('&')) return text;
  return new DOMParser().parseFromString(text, 'text/html').documentElement.textContent ?? text;
}
