// English spelling rules: how the words in a lyric map to dictionary words.
// Pure functions with no browser APIs (see text.js for how they are used).
//
// Song lyrics are full of contractions and clipped spellings. Each is opened
// up into the full words, so the learner sees real vocabulary:
//   don't → do + not      I'm → I + am       she's → she + is
//   lovin' → loving       'cause → because   y'all → you + all

// "n't" forms whose first half is not simply the word minus "n".
const NEGATIVES = { can: 'can', won: 'will', shan: 'shall' };

// What a contraction's ending stands for.
const ENDINGS = { m: 'am', re: 'are', ve: 'have', ll: 'will', d: 'would' };

// After these words "'s" is "is" (or "has"); after a noun it marks possession.
const IS_AFTER = new Set([
  'it', 'he', 'she', 'that', 'what', 'there', 'here', 'who', 'where', 'how', 'when', 'why', 'everything',
  'nothing', 'something', 'everybody', 'everyone', 'nobody', 'somebody', 'someone', 'one',
]);

// Words written short, with an apostrophe where the missing letters were.
const CLIPPED = { cause: 'because', em: 'them', til: 'until', bout: 'about', round: 'around' };
// The same, for the half before an apostrophe ("y'all").
const CLIPPED_HEADS = { y: 'you' };

const isApostrophe = (char) => char === "'" || char === '’' || char === '‘' || char === 'ʼ';

const key = (word) => word;

/**
 * Find the dictionary words in one piece of a lyric (lower case, no hyphens)
 * and add them to `found`.
 * @param {string} part
 * @param {number} start  where `part` begins in the line
 * @param {(word: string) => boolean} known
 * @param {{ key: string, start: number, end: number, elided: boolean }[]} found
 *   `elided` marks a word that is spelled out differently from the lyric
 * @param {string} line   the whole lyric line, to look at the characters around `part`
 */
function resolve(part, start, known, found, line) {
  if (!part) return;
  const end = start + part.length;
  const add = (word, from, to, elided) => {
    if (known(word)) found.push({ key: word, start: from, end: to, elided });
    return known(word);
  };

  // 'cause, 'em, 'til
  if (isApostrophe(line[start - 1]) && CLIPPED[part] && add(CLIPPED[part], start - 1, end, true)) return;
  if (add(part, start, end, false)) return;

  const apostrophe = part.indexOf("'");
  if (apostrophe === -1) {
    // lovin', nothin' — with the apostrophe, or without it for longer words
    const dropped = isApostrophe(line[end]);
    if (part.endsWith('in') && (dropped || part.length >= 4)) add(`${part}g`, start, end + (dropped ? 1 : 0), true);
    return;
  }

  const head = part.slice(0, apostrophe);
  const tail = part.slice(apostrophe + 1);
  const split = start + apostrophe;

  if (tail === 't' && head.endsWith('n')) {
    // don't, isn't, can't, won't
    const irregular = NEGATIVES[head];
    if (irregular) add(irregular, start, start + (irregular === head ? head.length : head.length - 1), irregular !== head);
    else add(head.slice(0, -1), start, split - 1, false);
    add('not', irregular === head ? split : split - 1, end, true);
  } else if (ENDINGS[tail]) {
    // I'm, you're, we've, I'll, I'd
    resolve(head, start, known, found, line);
    add(ENDINGS[tail], split, end, true);
  } else if (tail === 's') {
    resolve(head, start, known, found, line);
    if (head === 'let') add('us', split, end, true);
    else if (IS_AFTER.has(head)) add('is', split, end, true);
  } else {
    // y'all, rock'n'roll
    if (!(CLIPPED_HEADS[head] && add(CLIPPED_HEADS[head], start, split + 1, true))) resolve(head, start, known, found, line);
    resolve(tail, split + 1, known, found, line);
  }
}

// A flashcard can blank a word out of its lyric only where the word stands on
// its own: "____'ll be your friend" is not a fair question.
const standsAlone = (line, start, end) => !isApostrophe(line[start - 1]) && !isApostrophe(line[end]);

export const english = { code: 'en', key, resolve, standsAlone };
