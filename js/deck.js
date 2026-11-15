// What a practice session contains: which cards, in what order, which side is
// asked, and whether a typed answer is right. Pure functions (see srs.js for
// the timing).

import { dictionaryKey, wordsInLine } from './text.js';

function shuffle(items, random) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/**
 * The cards to go through now: everything that is due, plus a limited number
 * of new words. New words are spread evenly between the reviews, and the most
 * common (most useful) ones are introduced first.
 * @param {{ key: string, rank: number }[]} words
 * @param {Record<string, import('./srs.js').Card>} cards
 * @param {number} today
 * @param {number} newAllowed  how many never-practised words may be added
 */
export function buildQueue(words, cards, today, newAllowed, random = Math.random) {
  const queue = shuffle(
    words.filter((word) => cards[word.key] && cards[word.key].due <= today),
    random,
  );
  const reviews = queue.length;
  const fresh = words
    .filter((word) => !cards[word.key])
    .sort((a, b) => a.rank - b.rank)
    .slice(0, Math.max(0, newAllowed));
  fresh.forEach((word, i) => queue.splice(Math.round((i * reviews) / fresh.length) + i, 0, word));
  return queue;
}

/** How many of these words are new, being re-learned after a miss, or due for review. */
export function tally(words, cards, today) {
  const counts = { fresh: 0, again: 0, due: 0 };
  for (const word of words) {
    const card = cards[word.key];
    if (!card) counts.fresh++;
    else if (card.learning) counts.again++;
    else if (card.due <= today) counts.due++;
  }
  return counts;
}

// The saved occurrence must be the word itself (not "j'" standing for "je"),
// and the line must have something left once it is blanked out.
function canGap(word) {
  const shown = word.line.slice(word.start, word.end);
  return dictionaryKey(shown.toLowerCase()) === word.key && word.line.trim().length > shown.length;
}

/**
 * Which side of the card to ask.
 *   'word' — show the French word, recall the meaning (recognition)
 *   'gap'  — show the lyric with the word missing, recall the word (production)
 * In 'mix' a word is met the easy way first; once it has been answered
 * correctly the two take turns, because producing a word is harder and
 * strengthens the memory more than recognising it.
 * @param {'mix'|'word'|'gap'} style
 */
export function cardFace(word, card, style) {
  if (style === 'word' || !canGap(word)) return 'word';
  if (style === 'gap') return 'gap';
  if (!card || card.learning) return 'word';
  return card.reps % 2 === 1 ? 'gap' : 'word';
}

/**
 * The lyric line cut into pieces, with every use of the word marked as a gap
 * so a repeat later in the line does not give the answer away.
 * @returns {{ text: string, gap: boolean }[]}
 */
export function gapSegments(word) {
  const repeats = wordsInLine(word.line, (key) => key === word.key).filter((hit) => !hit.elided);
  const starts = new Map([...repeats, word].map(({ start, end }) => [start, end]));
  const segments = [];
  let position = 0;
  for (const [start, end] of [...starts].sort((a, b) => a[0] - b[0])) {
    if (start < position) continue;
    if (start > position) segments.push({ text: word.line.slice(position, start), gap: false });
    segments.push({ text: word.line.slice(start, end), gap: true });
    position = end;
  }
  if (position < word.line.length) segments.push({ text: word.line.slice(position), gap: false });
  return segments;
}

const tidy = (text) => dictionaryKey(text.trim().toLowerCase().replace(/[’‘ʼ]/g, "'"));
const withoutAccents = (text) => tidy(text).normalize('NFD').replace(/\p{M}/gu, '');

/**
 * Compare what was typed with the expected word.
 * @returns {'right'|'accents'|'wrong'}  'accents' = right letters, wrong or missing accents
 */
export function checkAnswer(typed, answer) {
  if (tidy(typed) === tidy(answer)) return 'right';
  return withoutAccents(typed) === withoutAccents(answer) ? 'accents' : 'wrong';
}
