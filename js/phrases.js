// Phrases: stretches of a lyric line saved as one item, either found from a
// built-in list of expressions (phrases-fr.js) or picked by hand in the
// lyrics. Pure functions with no browser APIs.
//
// A phrase is matched word by word, not letter by letter, so spacing,
// punctuation, capitals, hyphens and elisions do not matter: "Tu m'manques",
// "tu me manques" and "TU ME MANQUES !" are the same phrase.

import { cleanLines, looksForeign } from './text.js';

// A word, or an elided word with what follows it ("j'ai" is "j'" + "ai").
const TOKEN = /\p{L}+'?/gu;
const fold = (text) => text.toLowerCase().replace(/[’‘ʼ]/g, "'");

/**
 * The words of a line with where each sits in it.
 * @param {string} line
 * @param {{ expand: (token: string) => string }} rules
 * @returns {{ word: string, start: number, end: number }[]}
 */
export function tokens(line, rules) {
  return [...fold(line).matchAll(TOKEN)].map((m) => ({
    word: rules.expand(m[0]),
    start: m.index,
    end: m.index + m[0].length,
  }));
}

/** The key a phrase is saved under. "p:" keeps it apart from single words. */
export function phraseKey(text, rules) {
  return `p:${tokens(text, rules).map((t) => t.word).join(' ')}`;
}

/**
 * Prepare the built-in list for matching.
 * @param {{ phrase: string, forms?: string[] }[]} list
 */
export function compileCatalogue(list, rules) {
  const byKey = new Map();
  const patterns = [];
  for (const entry of list) {
    const key = phraseKey(entry.phrase, rules);
    byKey.set(key, { ...entry, key });
    for (const form of [entry.phrase, ...(entry.forms ?? [])]) {
      const words = tokens(form, rules).map((t) => t.word);
      if (words.length) patterns.push({ key, words });
    }
  }
  return { byKey, patterns };
}

/**
 * Every built-in phrase in a song, with the first line it appears in. Where
 * two overlap in a line ("ça va" inside "comment ça va"), only the longer counts.
 * @param {string} lyrics
 * @param {ReturnType<typeof compileCatalogue>} catalogue
 * @param {{ code: string, expand: Function }} rules
 * @returns {{ key: string, line: string, start: number, end: number, count: number }[]}
 */
export function findPhrases(lyrics, catalogue, rules) {
  const found = new Map();
  for (const line of cleanLines(lyrics)) {
    if (looksForeign(line, rules.code)) continue;
    const words = tokens(line, rules);
    const hits = [];
    for (const { key, words: pattern } of catalogue.patterns) {
      for (let i = 0; i + pattern.length <= words.length; i++) {
        if (pattern.every((word, j) => words[i + j].word === word)) {
          hits.push({ key, from: i, to: i + pattern.length - 1 });
        }
      }
    }
    const longest = hits.filter(
      (hit) =>
        !hits.some(
          (other) =>
            other !== hit &&
            other.from <= hit.from &&
            other.to >= hit.to &&
            other.to - other.from > hit.to - hit.from,
        ),
    );
    for (const hit of longest) {
      const seen = found.get(hit.key);
      if (seen) {
        seen.count++;
        continue;
      }
      found.set(hit.key, { key: hit.key, line, start: words[hit.from].start, end: words[hit.to].end, count: 1 });
    }
  }
  return [...found.values()];
}

/**
 * How a phrase is written in the list: as sung, in lower case, without the
 * punctuation around it.
 */
export function phraseText(line, start, end) {
  return fold(line.slice(start, end))
    .replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '')
    .replace(/\s+/g, ' ');
}
