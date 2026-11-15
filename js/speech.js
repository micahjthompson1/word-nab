// Pronunciation through the browser's own speech synthesis (Web Speech API).
//
// It costs nothing and needs no server, account or audio files; with a voice
// installed on the device it also works offline. How natural it sounds depends
// on the voices the device has, so the best French one is picked automatically
// and the user can choose another.

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

// macOS lists these joke voices under French too.
const NOVELTY = /^(eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley)\b/i;

/**
 * How good a voice is for hearing French: higher is better, -Infinity for a
 * voice that is not French. A France accent comes first, then voice quality.
 * @param {{ name: string, lang: string }} voice
 */
export function voiceScore(voice) {
  const lang = voice.lang.replace('_', '-').toLowerCase();
  if (!lang.startsWith('fr')) return -Infinity;
  let score = lang === 'fr-fr' ? 30 : 0;
  if (/premium|enhanced|natural|neural/i.test(voice.name)) score += 20;
  else if (/google/i.test(voice.name)) score += 10;
  if (NOVELTY.test(voice.name)) score -= 50;
  return score;
}

/** The device's French voices, best first. Empty until the browser has loaded them. */
export function frenchVoices() {
  if (!synth) return [];
  const french = synth
    .getVoices()
    .filter((voice) => voiceScore(voice) > -Infinity)
    .sort((a, b) => voiceScore(b) - voiceScore(a));
  // Leave the joke voices out unless they are all there is.
  const serious = french.filter((voice) => voiceScore(voice) >= 0);
  return serious.length ? serious : french;
}

/** The voice in use: the one the user chose, otherwise the best available. */
export function currentVoice() {
  const voices = frenchVoices();
  const chosen = load(VOICE, '');
  return voices.find((voice) => voice.voiceURI === chosen) ?? voices[0] ?? null;
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
 * Say French text aloud, replacing anything still being said.
 * @param {string} text
 * @param {() => void} [onDone]  called once when it ends or is interrupted
 * @returns {'ok'|'no-french-voice'|'unsupported'}
 */
export function speak(text, onDone = () => {}) {
  if (!synth) return 'unsupported';
  stop();

  const voice = currentVoice();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = voice ? voice.lang.replace('_', '-') : 'fr-FR';
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
  return voice || synth.getVoices().length === 0 ? 'ok' : 'no-french-voice';
}
