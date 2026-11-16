// The list of common words, loaded once from a static JSON file.
// (The old app kept this in a MySQL table and queried it per song.)

import { EDITION } from './edition.js';

const POS_LABELS = {
  noun: 'noun', verb: 'verb', adj: 'adjective', adv: 'adverb', prep: 'preposition',
  conj: 'conjunction', pron: 'pronoun', det: 'determiner', num: 'number', interj: 'interjection',
};

const loading = new Map(); // word-list file → Promise of its dictionary

/**
 * @param {string} native  the language the meanings are in (one of EDITION.natives)
 * @returns {Promise<{ size: number, has(key: string): boolean, get(key: string): WordInfo|null }>}
 *
 * @typedef {{ rank: number, meaning: string, note: string, also: string, spelling: string|null }} WordInfo
 *   rank     — 1 is the most common word in the language
 *   meaning  — meaning of the most likely reading
 *   note     — grammar hint, e.g. "verb · from être · present"
 *   also     — a second reading when there is one, e.g. "to follow (suivre)"
 *   spelling — how to write the word when it takes a capital ("Monday", "I"), otherwise null
 */
export function loadDictionary(native = EDITION.natives[0]) {
  const file = EDITION.wordList(native);
  if (loading.has(file)) return loading.get(file);
  const request = fetch(new URL(`../${file}`, import.meta.url))
    .then((response) => {
      if (!response.ok) throw new Error(`Word list failed to load (${response.status})`);
      return response.json();
    })
    .then(({ words }) => ({
      size: Object.keys(words).length,
      has: (key) => Object.hasOwn(words, key),
      get: (key) => (Object.hasOwn(words, key) ? describe(key, words[key]) : null),
    }))
    .catch((error) => {
      loading.delete(file); // allow a retry
      throw error;
    });
  loading.set(file, request);
  return request;
}

function describe(key, [rank, main, second]) {
  const [lemma, pos, meaning, form] = main;
  // Keys are lower case and spelled without the œ ligature ("coeur",
  // "monday"); dictionary words keep both ("cœur", "Monday").
  const isOwnLemma = (word) => word.toLowerCase().replaceAll('œ', 'oe') === key;
  const note = [POS_LABELS[pos], !isOwnLemma(lemma) && `from ${lemma}`, form].filter(Boolean).join(' · ');
  const also = second ? `${second[2]} (${isOwnLemma(second[0]) ? POS_LABELS[second[1]] : second[0]})` : '';
  const spelling = lemma !== key && lemma.toLowerCase() === key ? lemma : null;
  return { rank, meaning, note, also, spelling };
}
