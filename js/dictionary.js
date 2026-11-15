// The common-French-word list, loaded once from a static JSON file.
// (The old app kept this in a MySQL table and queried it per song.)

const POS_LABELS = {
  noun: 'noun', verb: 'verb', adj: 'adjective', adv: 'adverb', prep: 'preposition',
  conj: 'conjunction', pron: 'pronoun', det: 'determiner', num: 'number', interj: 'interjection',
};

let loading;

/**
 * @returns {Promise<{ size: number, has(key: string): boolean, get(key: string): WordInfo|null }>}
 *
 * @typedef {{ rank: number, meaning: string, note: string, also: string }} WordInfo
 *   rank    — 1 is the most common word in French
 *   meaning — English meaning of the most likely reading
 *   note    — grammar hint, e.g. "verb · from être · present"
 *   also    — a second reading when there is one, e.g. "to follow (suivre)"
 */
export function loadDictionary() {
  loading ??= fetch(new URL('../data/words.fr.json', import.meta.url))
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
      loading = undefined; // allow a retry
      throw error;
    });
  return loading;
}

function describe(key, [rank, main, second]) {
  const [lemma, pos, meaning, verbForm] = main;
  // Keys are spelled without the œ ligature ("coeur"); lemmas keep it ("cœur").
  const isOwnLemma = (word) => word.replaceAll('œ', 'oe') === key;
  const note = [POS_LABELS[pos], !isOwnLemma(lemma) && `from ${lemma}`, verbForm].filter(Boolean).join(' · ');
  const also = second ? `${second[2]} (${isOwnLemma(second[0]) ? POS_LABELS[second[1]] : second[0]})` : '';
  return { rank, meaning, note, also };
}
