// French spelling rules: how the words in a lyric map to dictionary words.
// Pure functions with no browser APIs (see text.js for how they are used).

// "j'ai" is "je" + "ai". The elided half is expanded to the full word so the
// learner sees a real vocabulary item.
export const ELISIONS = {
  l: 'le', d: 'de', n: 'ne', t: 'te', s: 'se', m: 'me', j: 'je', c: 'ce', qu: 'que',
  jusqu: 'jusque', lorsqu: 'lorsque', puisqu: 'puisque', quoiqu: 'quoique',
  quelqu: 'quelque', presqu: 'presque',
};

// The word list spells "cœur" as "coeur"; lyrics use either.
const key = (word) => word.replaceAll('œ', 'oe').replaceAll('æ', 'ae');

/**
 * Find the dictionary words in one piece of a lyric (lower case, no hyphens)
 * and add them to `found`.
 * @param {string} part
 * @param {number} start  where `part` begins in the line
 * @param {(word: string) => boolean} known
 * @param {{ key: string, start: number, end: number, elided: boolean }[]} found
 */
function resolve(part, start, known, found) {
  if (!part) return;
  if (known(part)) {
    found.push({ key: key(part), start, end: start + part.length, elided: false });
    return;
  }
  const apostrophe = part.indexOf("'");
  if (apostrophe === -1) return;
  const head = part.slice(0, apostrophe);
  const full = ELISIONS[head];
  if (full && known(full)) {
    found.push({ key: full, start, end: start + apostrophe + 1, elided: true });
  } else if (!full && known(head)) {
    found.push({ key: key(head), start, end: start + apostrophe, elided: false });
  }
  resolve(part.slice(apostrophe + 1), start + apostrophe + 1, known, found);
}

// One token of a phrase as it is matched: "m'" and "me" are the same word.
function expand(token) {
  const full = token.endsWith("'") && ELISIONS[token.slice(0, -1)];
  return full || key(token);
}

export const french = { code: 'fr', key, resolve, expand };
