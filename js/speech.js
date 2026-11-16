// Pronunciation through the browser's own speech synthesis (Web Speech API).
//
// It costs nothing and needs no server, account or audio files; with a voice
// installed on the device it also works offline. How natural it sounds depends
// on the voices the device has, so the best one for the language being learned
// is picked automatically and the user can choose another.

import { LEARNING } from './edition.js';
import { load, save } from './storage.js';

const VOICE = 'voice.v1';
const RATE = 0.9; // slightly slower than normal speech: easier to follow
const SETTLE_MS = 60;

const synth = globalThis.speechSynthesis ?? null;

export const supported = Boolean(synth);

// What is being said now. Holding on to the utterance also stops Chrome from
// discarding it before it has finished.
let active = null;
let cancelledAt = -Infinity;

// macOS ships these joke voices, several of them in every language.
const NOVELTY =
  /^(eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley|albert|bad news|bahh|bells|boing|bubbles|cellos|wobble|fred|good news|jester|junior|kathy|organ|ralph|superstar|trinoids|whisper|zarvox)\b/i;

/**
 * How good a voice is for hearing the language: higher is better, -Infinity
 * for a voice in another language. The standard accent (France for French,
 * the United States for English) comes first, then voice quality.
 * @param {{ name: string, lang: string }} voice
 * @param {string} [accent]  the preferred accent, such as "fr-FR"
 */
export function voiceScore(voice, accent = LEARNING.speech) {
  const lang = voice.lang.replace('_', '-').toLowerCase();
  if (!lang.startsWith(accent.slice(0, 2).toLowerCase())) return -Infinity;
  let score = lang === accent.toLowerCase() ? 30 : 0;
  if (/premium|enhanced|natural|neural/i.test(voice.name)) score += 20;
  else if (/google/i.test(voice.name)) score += 10;
  if (NOVELTY.test(voice.name)) score -= 50;
  return score;
}

/** The device's voices for the language being learned, best first. Empty until the browser has loaded them. */
export function voices() {
  if (!synth) return [];
  const usable = synth
    .getVoices()
    .filter((voice) => voiceScore(voice) > -Infinity)
    .sort((a, b) => voiceScore(b) - voiceScore(a));
  // Leave the joke voices out unless they are all there is.
  const serious = usable.filter((voice) => voiceScore(voice) >= 0);
  return serious.length ? serious : usable;
}

/** The voice in use: the one the user chose, otherwise the best available. */
export function currentVoice() {
  const available = voices();
  const chosen = load(VOICE, '');
  return available.find((voice) => voice.voiceURI === chosen) ?? available[0] ?? null;
}

export function chooseVoice(voiceURI) {
  save(VOICE, voiceURI);
}

/** Voices arrive a moment after the page loads in most browsers. */
export function onVoicesChanged(callback) {
  synth?.addEventListener?.('voiceschanged', callback);
}

export function stop() {
  if (!synth) return;
  const was = active;
  active = null;
  if (synth.speaking || synth.pending) {
    synth.cancel();
    cancelledAt = performance.now();
  }
  was?.onDone();
}

/**
 * Say text aloud in the language being learned, replacing anything still being said.
 * @param {string} text
 * @param {() => void} [onDone]  called once when it ends or is interrupted
 * @returns {'ok'|'no-voice'|'unsupported'}  'no-voice': the device has no voice for the language
 */
export function speak(text, onDone = () => {}) {
  if (!synth) return 'unsupported';
  stop();

  const voice = currentVoice();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = voice ? voice.lang.replace('_', '-') : LEARNING.speech;
  if (voice) utterance.voice = voice;
  utterance.rate = RATE;

  const entry = { utterance, onDone };
  const finish = () => {
    if (active !== entry) return;
    active = null;
    onDone();
  };
  utterance.onend = finish;
  utterance.onerror = finish;
  active = entry;

  // Some browsers silently drop an utterance queued right after cancel().
  const wait = SETTLE_MS - (performance.now() - cancelledAt);
  if (wait > 0) setTimeout(() => active === entry && synth.speak(utterance), wait);
  else synth.speak(utterance);

  // An empty list means the voices have not loaded yet, not that none exist.
  return voice || synth.getVoices().length === 0 ? 'ok' : 'no-voice';
}
