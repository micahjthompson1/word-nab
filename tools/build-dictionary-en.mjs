#!/usr/bin/env node
// Builds the common-English-word lists for the English-learner version:
//   data/words.en-es.json   meanings in Spanish
//   data/words.en-zh.json   meanings in Chinese (simplified)
//   data/words.en-ru.json   meanings in Russian
//
// The three files hold the same English words in the same order, so a saved
// word list keeps working when the learner switches language.
//
//   node tools/build-dictionary-en.mjs                 # cutoff 10 per million (default)
//   node tools/build-dictionary-en.mjs --min-freq 20   # shorter list
//   node tools/build-dictionary-en.mjs --review        # also print the words worth checking by hand
//
// Sources (downloaded once into tools/.cache/, which is git-ignored):
//   FrequencyWords en_50k — word counts from film subtitles (OpenSubtitles 2018), CC BY-SA 4.0
//   AGID infl.txt         — which word forms belong to which dictionary word
//                           ("went" → "go"), © Kevin Atkinson, free to use
//   WikDict en-es, en-ru  — Spanish and Russian translations from Wiktionary, CC BY-SA 3.0
//   ECDICT ecdict.csv     — Chinese translations, MIT licence (Wiktionary has
//                           no Chinese for about half of the common words)
//
// Requires Node 22.13+ (uses the built-in node:sqlite module). No npm install.

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAPITALISED, EXTRA_WORDS, IGNORE, LEMMA_OVERRIDES, MAIN_CLASS, PREFER_INFLECTION, PREFER_OWN, WORD_OVERRIDES,
} from './overrides-en.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = ['es', 'zh', 'ru'];
const SOURCES = {
  frequency: {
    file: 'en_50k.txt',
    url: 'https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/en/en_50k.txt',
  },
  forms: {
    file: 'infl.txt',
    url: 'https://raw.githubusercontent.com/en-wl/wordlist/master/agid/infl.txt',
  },
  es: { file: 'en-es.sqlite3', url: 'https://download.wikdict.com/dictionaries/sqlite/2/en-es.sqlite3' },
  ru: { file: 'en-ru.sqlite3', url: 'https://download.wikdict.com/dictionaries/sqlite/2/en-ru.sqlite3' },
  zh: { file: 'ecdict.csv', url: 'https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv' },
};

const args = parseArgs(process.argv.slice(2));
const MIN_FREQ = Number(args['min-freq'] ?? 10);
const OUT_DIR = resolve(args.out ?? join(ROOT, 'data'));
const CACHE = resolve(args.cache ?? join(ROOT, 'tools', '.cache'));
const MAX_GLOSSES = 3;
const MAX_GLOSS_LENGTH = 32;
// A second class of the same word ("love": verb, also noun) is shown when the
// evidence for it is at least this share of the evidence for the first.
const SECOND_CLASS_SHARE = 0.7;
// A translation is listed only if it is at least this well supported
// compared with the best one.
const MIN_GLOSS_SHARE = 0.35;
const RARE_BASE_SHARE = 0.05;
// How many other English words a translation may be credited for. Beyond
// this it is just a vague word ("край", "cosa"), not a better one.
const MAX_REACH = 7;

// Wiktionary part-of-speech tags (from WikDict's lexentry ids) → the coarse
// classes used in the output. Names, phrases, prefixes and so on are left out.
const WIKDICT_POS = {
  Noun: 'noun', Verb: 'verb', Adjective: 'adj', Adverb: 'adv', Preposition: 'prep',
  Conjunction: 'conj', Interjection: 'interj', Pronoun: 'pron', Determiner: 'det',
  Article: 'det', Numeral: 'num', Number: 'num', Particle: 'adv', Postposition: 'adv',
};
const POS_ORDER = ['verb', 'noun', 'adj', 'adv', 'pron', 'det', 'prep', 'conj', 'num', 'interj'];
const AGID_POS = { V: 'verb', N: 'noun', A: 'adj' };
// How to write words that take a capital letter ("monday" → "Monday").
const SPELLINGS = new Map();
const FIXED_SPELLINGS = [['i', 'I'], ...CAPITALISED.map((word) => [word, word[0].toUpperCase() + word.slice(1)])];
// The labels ECDICT puts in front of each line of a translation ("vt. 得到, 获得").
const ECDICT_POS = {
  'n.': 'noun', 'pl.': 'noun', 'a.': 'adj', 'v.': 'verb', 'vt.': 'verb', 'vi.': 'verb', 'aux.': 'verb',
  'vbl.': 'verb', 'adv.': 'adv', 'prep.': 'prep', 'pron.': 'pron', 'conj.': 'conj', 'interj.': 'interj',
  'int.': 'interj', 'num.': 'num', 'art.': 'det',
};

async function main() {
  mkdirSync(CACHE, { recursive: true });
  const counts = readFrequencies(await ensureSource(SOURCES.frequency));
  const { inflections, paradigms } = readForms(await ensureSource(SOURCES.forms));
  const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
  for (const [word, source] of Object.entries(EXTRA_WORDS)) counts.set(word, counts.get(source) ?? 0);
  const perMillion = (word) => ((counts.get(word) ?? 0) / total) * 1e6;

  const glossaries = {
    es: readWikdict(await ensureSource(SOURCES.es), 'es'),
    ru: readWikdict(await ensureSource(SOURCES.ru), 'ru'),
    zh: readEcdict(await ensureSource(SOURCES.zh), counts),
  };
  for (const [word, spelling] of FIXED_SPELLINGS) SPELLINGS.set(word, spelling);
  const classesOf = classRanker(glossaries, counts, paradigms);
  // The Chinese dictionary also lists plain forms ("kids", "children") as
  // entries, so only Wiktionary counts as proof that a form is a word in
  // its own right.
  const isHeadword = (word) => ['es', 'ru'].some((target) => entryFor(word, glossaries[target]));

  const common = [...counts.keys()]
    .filter((word) => perMillion(word) >= MIN_FREQ && keepWord(word))
    .sort((a, b) => counts.get(b) - counts.get(a) || a.localeCompare(b, 'en'));

  const entries = [];
  const review = [];
  for (const word of common) {
    const readings = readingsOf(word, { counts, inflections, paradigms, classesOf, isHeadword, review });
    if (readings.length) entries.push({ word, readings });
  }

  // Keep a word only if every language has a meaning for it, so the three
  // lists stay in step. A language missing the first reading uses the second.
  const kept = [];
  const dropped = Object.fromEntries(TARGETS.map((target) => [target, []]));
  for (const entry of entries) {
    const senses = {};
    for (const target of TARGETS) {
      senses[target] = entry.readings
        .map((r) => toSense(entry.word, r, target, glossaries[target]))
        .filter((sense) => sense[2]);
    }
    const missing = TARGETS.filter((target) => !senses[target].length);
    for (const target of missing) dropped[target].push(entry.word);
    if (!missing.length) kept.push({ word: entry.word, senses });
  }

  for (const target of TARGETS) {
    const words = {};
    kept.forEach(({ word, senses }, i) => {
      const [main, second] = senses[target];
      // A second reading only helps if it says something new.
      words[word] = second && second[2] !== main[2] ? [i + 1, main, second] : [i + 1, main];
    });
    const out = {
      meta: {
        language: 'en',
        target,
        minFrequencyPerMillion: MIN_FREQ,
        count: kept.length,
        format: 'words[form] = [rank, [dictionaryWord, partOfSpeech, meaning, form|null], …second reading]',
        sources: [
          'FrequencyWords en_50k, from OpenSubtitles 2018 (github.com/hermitdave/FrequencyWords) — CC BY-SA 4.0',
          'AGID inflection list (github.com/en-wl/wordlist) — © Kevin Atkinson',
          target === 'zh'
            ? 'ECDICT (github.com/skywind3000/ECDICT) — MIT'
            : `WikDict en-${target} (wikdict.com), from Wiktionary — CC BY-SA 3.0`,
        ],
        license: 'CC BY-SA 4.0',
      },
      words,
    };
    const path = join(OUT_DIR, `words.en-${target}.json`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(out) + '\n');
    const kb = (Buffer.byteLength(JSON.stringify(out)) / 1024).toFixed(0);
    console.log(`${kept.length} words written to ${path} (${kb} KB).`);
  }
  for (const target of TARGETS) {
    const shown = args.review ? dropped[target] : dropped[target].slice(0, 40);
    console.log(`No ${target} meaning for ${dropped[target].length} words: ${shown.join(' ')}${shown.length < dropped[target].length ? ' …' : ''}`);
  }
  if (args.review) {
    console.log('\nWords that are both a dictionary word and a form of another (first = chosen):');
    for (const line of review) console.log('  ' + line);
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i] ?? true;
  }
  return out;
}

async function ensureSource({ file, url }) {
  const path = join(CACHE, file);
  if (existsSync(path)) return path;
  console.log(`Downloading ${url} …`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  return path;
}

// The subtitle counts include names, noises ("uh", "mm") and the pieces of
// contractions ("'s", "don"). Names drop out later because they have no
// dictionary translation; the rest is filtered here. The app itself splits
// contractions ("don't" → "do" + "not") when it reads a lyric.
function keepWord(word) {
  if (Object.hasOwn(EXTRA_WORDS, word)) return true;
  if (IGNORE.has(word)) return false;
  if (word.length === 1) return word === 'a' || word === 'i';
  return /^[a-z]+(-[a-z]+)*$/.test(word);
}

function readFrequencies(path) {
  const counts = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const [word, count] = line.split(' ');
    if (word && count) counts.set(word, Number(count));
  }
  return counts;
}

// AGID lines look like:
//   go V: went | gone | going | goes
//   child N: children
//   good A: better | best
// Marks after a form ("?", "!", "~", a number, "{note}") rate how usual it is.
function readForms(path) {
  const inflections = new Map(); // form → [{ lemma, pos, label }]
  const paradigms = new Map(); // "lemma/pos" → [{ form, label }]
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^([a-z'-]+) ([VNA]): (.+)$/.exec(line); // skips capitalised words and "V?" guesses
    if (!match) continue;
    const [, lemma, tag, rest] = match;
    const pos = AGID_POS[tag];
    const slots = rest.split(' | ').map((slot) =>
      slot
        .replace(/\{[^}]*\}/g, '')
        .split(',')
        .map((variant) => /^\s*([a-z'-]+)([~<!?]*)/.exec(variant))
        .filter((m) => m && !/[!?]/.test(m[2]))
        .map((m) => m[1]),
    );
    const labels = slotLabels(pos, slots.length);
    if (!labels) continue; // "be" has its own pattern; its forms are in overrides-en.mjs
    const all = [];
    slots.forEach((forms, i) => {
      for (const form of forms) {
        all.push({ form, label: labels[i] });
        if (form === lemma) continue;
        if (!inflections.has(form)) inflections.set(form, []);
        const known = inflections.get(form).find((r) => r.lemma === lemma && r.pos === pos);
        if (!known) inflections.get(form).push({ lemma, pos, label: labels[i] });
      }
    });
    paradigms.set(`${lemma}/${pos}`, all);
  }
  return { inflections, paradigms };
}

function slotLabels(pos, count) {
  if (pos === 'noun') return count === 1 ? ['plural'] : null;
  if (pos === 'adj') return count === 2 ? ['comparative', 'superlative'] : null;
  if (count === 3) return ['past', '-ing form', 'he/she/it form'];
  if (count === 4) return ['past', 'past participle', '-ing form', 'he/she/it form'];
  return null;
}

function readWikdict(path, target) {
  const db = new DatabaseSync(path, { readOnly: true });
  const rows = db
    .prepare('SELECT lexentry, written_rep, trans_list, score FROM translation WHERE lexentry IS NOT NULL AND trans_list IS NOT NULL AND is_good = 1')
    .all();
  const glossary = new Map(); // word → pos → [{ glosses, score }]
  const capitalised = new Map(); // the same for "Monday", "English"…, keyed in lower case
  const usedBy = new Map(); // translation → the English words it translates
  for (const row of rows) {
    const pos = WIKDICT_POS[/__(.+?)__\d+$/.exec(row.lexentry)?.[1]];
    if (!pos) continue; // also skips names: they are tagged "Proper_noun"
    const glosses = cleanGlosses(row.trans_list.split(' | '), target);
    if (!glosses.length) continue;
    const word = row.written_rep.replaceAll('’', "'");
    const lower = word.toLowerCase();
    const isTitleCase = word === word[0].toUpperCase() + lower.slice(1);
    if (word !== lower && !isTitleCase) continue; // acronyms
    const into = word === lower ? glossary : capitalised;
    let byPos = into.get(lower);
    if (!byPos) into.set(lower, (byPos = new Map()));
    if (word !== lower) SPELLINGS.set(lower, word);
    if (!byPos.has(pos)) byPos.set(pos, []);
    byPos.get(pos).push({ glosses, score: Number(row.score) || 0 });
    for (const gloss of glosses) {
      if (!usedBy.has(gloss)) usedBy.set(gloss, new Set());
      usedBy.get(gloss).add(lower);
    }
  }
  db.close();
  glossary.reach = new Map([...usedBy].map(([gloss, words]) => [gloss, words.size]));
  // A capitalised entry is used only when there is no lower-case word of the
  // same spelling ("Polish" must not replace "polish").
  for (const [lower, byPos] of capitalised) {
    if (!glossary.has(lower)) glossary.set(lower, byPos);
    else SPELLINGS.delete(lower);
  }
  return glossary;
}

// British and American spellings share one Wiktionary entry, and the
// subtitles use both. Returns the other spellings worth trying.
function spellingVariants(word) {
  const swaps = [
    [/our$/, 'or'], [/or$/, 'our'], [/re$/, 'er'], [/er$/, 're'], [/is(e|ed|es|ing)$/, 'iz$1'],
    [/iz(e|ed|es|ing)$/, 'is$1'], [/ence$/, 'ense'], [/ense$/, 'ence'], [/^grey$/, 'gray'], [/^gray$/, 'grey'],
    [/^jewelry$/, 'jewellery'], [/^mom$/, 'mum'],
  ];
  return swaps.filter(([pattern]) => pattern.test(word)).map(([pattern, to]) => word.replace(pattern, to));
}

/** The glossary entry for a word, trying its other spelling if need be. */
function entryFor(word, glossary) {
  return glossary.get(word) ?? spellingVariants(word).map((variant) => glossary.get(variant)).find(Boolean);
}

// ECDICT is a CSV; the fourth column holds the Chinese translation as lines
// such as "n. 爱, 恋爱, 爱情\nvt. 爱, 爱好" (the \n is written out literally).
function readEcdict(path, counts) {
  const glossary = new Map(); // word → pos → [{ glosses, score }], first class first
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const written = line.slice(0, line.indexOf(','));
    const word = written.toLowerCase();
    // "God" and "North" are listed with a capital; a lower-case entry wins.
    if (!counts.has(word) || (written !== word && glossary.has(word))) continue;
    const translation = csvFields(line)[3] ?? '';
    const byPos = new Map();
    for (const part of translation.split('\\n')) {
      const match = /^([a-z]+\.)\s*(.+)$/.exec(part.trim());
      const pos = match && ECDICT_POS[match[1]];
      if (!pos) continue;
      const glosses = cleanGlosses(match[2].split(/[,，;；]\s*/), 'zh');
      if (!glosses.length) continue;
      // "vt." and "vi." lines are one verb.
      if (byPos.has(pos)) byPos.get(pos)[0].glosses.push(...glosses.filter((g) => !byPos.get(pos)[0].glosses.includes(g)));
      else byPos.set(pos, [{ glosses, score: 1 }]);
    }
    if (byPos.size && (written === word || !glossary.has(word))) glossary.set(word, byPos);
  }
  return glossary;
}

function csvFields(line) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char !== '"') field += char;
      else if (line[i + 1] === '"') field += line[i++];
      else quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      fields.push(field);
      field = '';
    } else field += char;
  }
  fields.push(field);
  return fields;
}

// Many English words are several classes at once ("watch": a verb and a
// noun). No source says which use is the common one, so three clues are
// added up:
//   - how strongly Wiktionary backs each class (its translation scores),
//   - which class the Chinese dictionary lists first,
//   - for verbs, how often the word's verb-only forms ("watched",
//     "watching") occur compared with the word itself.
// Returns the classes of a word, likeliest first, with their evidence.
function classRanker(glossaries, counts, paradigms) {
  const cache = new Map();
  const freq = (word) => counts.get(word) ?? 0;
  return (word) => {
    if (cache.has(word)) return cache.get(word);
    const evidence = new Map();
    const add = (pos, amount) => evidence.set(pos, (evidence.get(pos) ?? 0) + amount);
    for (const target of ['es', 'ru']) {
      for (const [pos, rows] of entryFor(word, glossaries[target]) ?? []) add(pos, Math.max(...rows.map((r) => r.score)));
    }
    const chinese = [...(entryFor(word, glossaries.zh)?.keys() ?? [])];
    chinese.forEach((pos, i) => add(pos, i === 0 ? 60 : 1));
    if (evidence.has('verb')) {
      const verbOnly = new Set(
        (paradigms.get(`${word}/verb`) ?? []).filter((f) => f.label !== 'he/she/it form' && f.form !== word).map((f) => f.form),
      );
      const share = [...verbOnly].reduce((sum, form) => sum + freq(form), 0) / (freq(word) || 1);
      add('verb', 100 * Math.min(1, share / 0.25));
    }
    if (MAIN_CLASS[word] && evidence.has(MAIN_CLASS[word])) add(MAIN_CLASS[word], 10_000);
    const ranked = [...evidence]
      .sort((a, b) => b[1] - a[1] || POS_ORDER.indexOf(a[0]) - POS_ORDER.indexOf(b[0]))
      .map(([pos, strength]) => ({ pos, strength }));
    cache.set(word, ranked);
    return ranked;
  };
}

// GB2312 is the classic simplified-Chinese character set, so a character
// outside it is (nearly always) a traditional form. Wiktionary lists both
// ("爱 | 愛"); the app shows the simplified one.
const SIMPLIFIED = (() => {
  const decoder = new TextDecoder('gbk');
  const set = new Set();
  for (let lead = 0xb0; lead <= 0xf7; lead++) {
    for (let trail = 0xa1; trail <= 0xfe; trail++) set.add(decoder.decode(new Uint8Array([lead, trail])));
  }
  return set;
})();
const isSimplified = (text) => [...text].every((char) => !/\p{Script=Han}/u.test(char) || SIMPLIFIED.has(char));

function cleanGlosses(glosses, target) {
  let clean = glosses
    .map((gloss) =>
      gloss
        .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1') // [[link|shown]] → shown
        .replace(/^[(（][^)）]*[)）]\s*/, '') // a leading label such as "(非正式)"
        .normalize('NFD')
        .replace(target === 'ru' ? /[̀́]/g : /(?!)/g, '') // stress marks, which Russians do not write
        .normalize('NFC')
        .trim(),
    )
    .filter((gloss) => gloss && gloss.length <= MAX_GLOSS_LENGTH && !/[+[\]{}<>=]/.test(gloss));
  // Leftover English or template text ("чем + comp."): not a translation.
  if (target !== 'es') clean = clean.filter((gloss) => !/[a-z]/i.test(gloss));
  if (target === 'zh') {
    const simplified = clean.filter(isSimplified);
    if (simplified.length) clean = simplified;
  }
  return [...new Set(clean)];
}

// Work out what a word form is: a dictionary word in its own right ("evening"),
// a form of another word ("went" → "go"), or both ("left": past of "leave",
// and the opposite of right). Returns the likelier reading first.
function readingsOf(word, { counts, inflections, paradigms, classesOf, isHeadword, review }) {
  const override = WORD_OVERRIDES[word];
  if (override) return [{ lemma: override.from ?? word, pos: override.pos, label: override.form ?? null }];

  const freq = (w) => counts.get(w) ?? 0;
  const classes = classesOf(word);
  const owns = classes
    .filter((c) => c.strength >= classes[0].strength * SECOND_CLASS_SHARE)
    .slice(0, 2)
    .map((c) => ({ lemma: word, pos: c.pos, label: null }));
  const own = owns[0];
  // "number" is not really "numb" + "-er": a base word used far less than the
  // form itself is ignored.
  const inflected = (inflections.get(word) ?? [])
    .filter((r) => classesOf(r.lemma).some((c) => c.pos === r.pos) && freq(r.lemma) >= freq(word) * RARE_BASE_SHARE)
    .sort((a, b) => freq(b.lemma) - freq(a.lemma))[0];

  if (!inflected) return owns;
  if (!own || !isHeadword(word)) return [inflected];

  // Both readings exist. The form reading wins unless the word clearly has a
  // life of its own: it is used more than its base word ("married" vs
  // "marry"), or — for an -ing form — the base is hardly used as a verb at
  // all ("evening" is not really "even" + "-ing").
  let ownFirst = freq(word) > freq(inflected.lemma);
  if (inflected.label === '-ing form' && !PREFER_INFLECTION.has(word)) {
    const otherForms = new Set(
      (paradigms.get(`${inflected.lemma}/verb`) ?? []).map((f) => f.form).filter((f) => f !== word && f !== inflected.lemma),
    );
    if (freq(word) > 3 * [...otherForms].reduce((sum, f) => sum + freq(f), 0)) return owns;
  }
  if (PREFER_OWN.has(word)) ownFirst = true;
  if (PREFER_INFLECTION.has(word)) ownFirst = false;

  const chosen = ownFirst ? [own, inflected] : [inflected, own];
  review.push(`${word}: ${chosen.map((r) => (r.label ? `${r.lemma} (${r.label})` : `${r.lemma} [${r.pos}]`)).join('  |  ')}`);
  return chosen;
}

/** @returns [dictionaryWord, partOfSpeech, meaning|null, form|null] */
function toSense(word, reading, target, glossary) {
  const meaning =
    WORD_OVERRIDES[word]?.[target] ??
    LEMMA_OVERRIDES[`${reading.lemma}/${reading.pos}`]?.[target] ??
    lookup(reading.lemma, reading.pos, glossary, target);
  return [SPELLINGS.get(reading.lemma) ?? reading.lemma, reading.pos, meaning ?? null, reading.label];
}

function lookup(word, pos, glossary, target) {
  const byPos = entryFor(word, glossary);
  if (!byPos) return null;
  // The class asked for, otherwise the first one this language's data has.
  const rows = byPos.get(pos) ?? byPos.values().next().value;
  // Wiktionary has a row per sense, each listing its translations best first.
  // The everyday translation heads several senses ("bueno" for "good"), and
  // usually translates a few other English words too. One found nowhere else
  // is often a regional synonym ("fetén"), so it counts for less.
  const weights = new Map();
  for (const row of rows) {
    row.glosses.forEach((gloss, i) => weights.set(gloss, (weights.get(gloss) ?? 0) + row.score / (1 + i)));
  }
  for (const [gloss, weight] of weights) {
    weights.set(gloss, weight * Math.log2(1 + Math.min(glossary.reach?.get(gloss) ?? 1, MAX_REACH)));
  }
  const ranked = [...weights].sort((a, b) => b[1] - a[1]);
  const glosses = ranked.filter(([, weight]) => weight >= ranked[0][1] * MIN_GLOSS_SHARE).map(([gloss]) => gloss);
  return glosses.slice(0, MAX_GLOSSES).join(target === 'zh' ? '，' : ', ') || null;
}

await main();
