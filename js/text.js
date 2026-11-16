// Text handling: finding dictionary words in lyrics and guessing a song's
// language. Pure functions with no browser APIs, so they also run under
// `node --test`.
//
// This replaces two things the old server did: the SQL lookup in
// /api/match-words and the Google Translate call in /api/detect-language.
//
// What counts as a word differs by language ("j'ai" in French, "don't" in
// English), so the functions take that language's rules (lang-fr.js,
// lang-en.js). French is the default.

import { french } from './lang-fr.js';

const WORD = /\p{L}+(?:['’‘ʼ-]\p{L}+)*/gu;

// Same length as the input, so offsets into the folded text are offsets into
// the original line too (that is what lets the UI highlight the word).
function fold(text) {
  return text.toLowerCase().replace(/[’‘ʼ]/g, "'");
}

/**
 * Split one lyric line into the dictionary words it contains.
 * @param {string} line
 * @param {(key: string) => boolean} has  true if the key is in the dictionary
 * @param {object} [rules]  the spelling rules of the lyric's language
 * @returns {{ key: string, start: number, end: number, elided: boolean }[]}
 *   `elided` marks a word the lyric writes differently ("j'" for "je", "n't" for "not")
 */
export function wordsInLine(line, has, rules = french) {
  const known = (word) => has(rules.key(word));
  const found = [];
  for (const match of line.matchAll(WORD)) {
    const token = fold(match[0]);
    const base = match.index;
    // A hyphenated dictionary word ("peut-être") is one word. Anything else
    // is looked at piece by piece ("dis-moi").
    if (token.includes('-') && known(token)) {
      found.push({ key: rules.key(token), start: base, end: base + token.length, elided: false });
      continue;
    }
    let offset = 0;
    for (const part of token.split('-')) {
      rules.resolve(part, base + offset, known, found, line);
      offset += part.length + 1;
    }
  }
  return found;
}

/**
 * Every dictionary word in a song, with the first line it appears in.
 * @param {string} lyrics
 * @param {(key: string) => boolean} has
 * @param {object} [rules]  the spelling rules of the lyric's language
 * @returns {{ key: string, display: string, line: string, start: number, end: number, count: number }[]}
 *   in order of first appearance
 */
export function extractWords(lyrics, has, rules = french) {
  const words = new Map();
  for (const line of cleanLines(lyrics)) {
    if (looksForeign(line, rules.code)) continue;
    for (const hit of wordsInLine(line, has, rules)) {
      const seen = words.get(hit.key);
      if (seen) {
        seen.count++;
        continue;
      }
      words.set(hit.key, {
        key: hit.key,
        // What the learner should memorise: the full word for an elision or
        // contraction, otherwise the spelling used in the song.
        display: hit.elided ? hit.key : fold(line.slice(hit.start, hit.end)),
        line,
        start: hit.start,
        end: hit.end,
        count: 1,
      });
    }
  }
  return [...words.values()];
}

/** Lyric lines worth reading: trimmed, no blanks, no "[Refrain]" markers. */
export function cleanLines(lyrics) {
  return lyrics
    .normalize('NFC')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^[\[(][^\])]*[\])]$/.test(line));
}

// ---------------------------------------------------------------------------
// Language detection
//
// Counts very common words that belong to only one of the languages below.
// It is crude next to a translation API, but it is instant, free, works
// offline, and a whole song gives it plenty of evidence.

// A word listed under two languages ("le" is French and Italian, "mais" is
// French and Portuguese) is ignored, so each list deliberately includes the
// look-alikes from its neighbours.
const COMMON_WORDS = {
  fr: 'le les une des du et est je il elle nous vous ils pas ne qui dans pour sur avec mais mon ton son ma ta ce cette au aux plus tout comme suis sont ai quand où moi toi lui ça j qu très rien jamais toujours encore sans oui ou leur ses mes tes été être avoir fait faire dit veux peux sais vais cœur coeur alors parce chez trop non si y en eu foi mai',
  en: 'the and you i to of is it that my your we be are was for with not do don all love know what so this but have just like when can will if they she he her his from up out now get got never there where were been how say see want need come die as',
  es: 'el los las y o en es por para pero más mas yo eso esta está soy eres tengo quiero cuando como mi lo una del al muy porque también nada todo siempre nunca aquí qué tú corazón ella ellos estoy hay sin si ti cosa son con',
  pt: 'o os as um uma em é não meu minha você eu com mas mais está sou tem pra muito tudo aqui só vai coração ele isso essa nós são foi quero como porque nada todo nunca sempre jamais ou',
  it: 'il lo gli o di che è non mi ti si mio tuo per con come ma più io sono sei ho hai questo anche perché tutto sempre mai amore cuore della nel cosa lei noi lui ne le qui una al',
  de: 'der die das und ich du nicht ein eine ist es mir mich dich zu den mit auf für wie wir sie er bin hast dem aber auch nur noch wenn dein mein',
};

export const LANGUAGE_NAMES = {
  fr: 'French', en: 'English', es: 'Spanish', pt: 'Portuguese', it: 'Italian', de: 'German',
};

// Keep only the words that appear in a single language's list.
const MARKERS = (() => {
  const owners = new Map();
  for (const [language, list] of Object.entries(COMMON_WORDS)) {
    for (const word of new Set(list.split(' '))) {
      owners.set(word, owners.has(word) ? null : language);
    }
  }
  return new Map([...owners].filter(([, language]) => language));
})();

function countMarkers(text) {
  const counts = {};
  for (const [word] of fold(text).matchAll(/\p{L}+/gu)) {
    const language = MARKERS.get(word);
    if (language) counts[language] = (counts[language] ?? 0) + 1;
  }
  return counts;
}

const MIN_EVIDENCE = 8;

/**
 * @param {string} text  a song's lyrics
 * @returns {{ primary: string|null, shares: Record<string, number> }}
 *   `primary` is a language code, or null when there is too little to go on.
 *   `shares` is each language's share of the evidence (0–1).
 */
export function detectLanguage(text) {
  const counts = countMarkers(text);
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  if (total < MIN_EVIDENCE) return { primary: null, shares: {} };
  const shares = Object.fromEntries(Object.entries(counts).map(([language, n]) => [language, n / total]));
  const primary = Object.keys(shares).reduce((a, b) => (shares[a] >= shares[b] ? a : b));
  return { primary, shares };
}

// A line with clear signs of another language and none of the one being
// learned, such as the English hook in a French song. Skipping it avoids
// "learning" that English "on" or "a" are French words.
function looksForeign(line, learning) {
  const counts = countMarkers(line);
  const other = Object.entries(counts).reduce((sum, [language, n]) => (language === learning ? sum : sum + n), 0);
  return !counts[learning] && other >= 2;
}
