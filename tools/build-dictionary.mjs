#!/usr/bin/env node
// Builds data/words.fr.json — the common-French-word list the app ships with.
//
// This replaces the old MySQL table `common_words_fr_freq20`. It only needs to
// be re-run if you want a different frequency cutoff; the generated file is
// committed, so the app itself has no build step.
//
//   node tools/build-dictionary.mjs                 # cutoff 20 per million (default)
//   node tools/build-dictionary.mjs --min-freq 10   # bigger list (~5,600 words)
//
// Sources (downloaded once into tools/.cache/, which is git-ignored):
//   Lexique 3.83  — word forms, lemmas and film/book frequencies (CC BY-SA 4.0)
//   WikDict fr-en — French→English translations from Wiktionary   (CC BY-SA 3.0)
//
// Requires Node 22.13+ (uses the built-in node:sqlite module). No npm install.

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEMMA_OVERRIDES, WORD_OVERRIDES } from './overrides.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = {
  lexique: {
    file: 'Lexique383.tsv',
    url: 'https://www.lexique.org/databases/Lexique383/Lexique383.tsv',
  },
  wikdict: {
    file: 'fr-en.sqlite3',
    url: 'https://download.wikdict.com/dictionaries/sqlite/2/fr-en.sqlite3',
  },
};

const args = parseArgs(process.argv.slice(2));
const MIN_FREQ = Number(args['min-freq'] ?? 20);
const OUT = resolve(args.out ?? join(ROOT, 'data', 'words.fr.json'));
const CACHE = resolve(args.cache ?? join(ROOT, 'tools', '.cache'));

// A second reading of a word is kept when it is at least this share of the
// main one ("suis" = être, but also suivre).
const SECOND_SENSE_SHARE = 0.1;
const MAX_GLOSSES = 3;

// Lexique part-of-speech tags → the coarse classes used in the output.
const LEXIQUE_POS = {
  NOM: 'noun', VER: 'verb', AUX: 'verb', ADJ: 'adj', ADV: 'adv', PRE: 'prep',
  CON: 'conj', ONO: 'interj', 'ART:def': 'det', 'ART:ind': 'det',
  'ADJ:dem': 'det', 'ADJ:ind': 'det', 'ADJ:int': 'det', 'ADJ:pos': 'det',
  'ADJ:num': 'num', 'PRO:per': 'pron', 'PRO:dem': 'pron', 'PRO:ind': 'pron',
  'PRO:int': 'pron', 'PRO:pos': 'pron', 'PRO:rel': 'pron',
};

// Wiktionary part-of-speech tags (from WikDict's lexentry ids) → same classes.
function wikdictPos(tag) {
  if (tag === 'nom') return 'noun';
  if (tag === 'verb') return 'verb';
  if (tag === 'adj') return 'adj';
  if (tag.startsWith('adv')) return 'adv';
  if (tag === 'préposition') return 'prep';
  if (tag.startsWith('conjonction')) return 'conj';
  if (tag === 'interjection' || tag === 'onomatopée') return 'interj';
  if (tag.startsWith('pronom')) return 'pron';
  if (tag === 'adjectif_numéral') return 'num';
  if (tag.startsWith('article') || tag.startsWith('adjectif_')) return 'det';
  return null; // proper nouns, phrases, proverbs… not wanted
}

// Closed-class words are interchangeable between these tags often enough
// (Lexique says determiner, Wiktionary says pronoun) that a miss on the exact
// class should try the neighbours before giving up.
const POS_NEIGHBOURS = {
  det: ['pron', 'adj', 'num'], pron: ['det'], num: ['det', 'adj', 'noun'],
  adj: ['det', 'noun'], adv: ['prep', 'conj'], prep: ['adv'], conj: ['adv'],
  interj: ['adv', 'noun'], noun: ['adj'], verb: [],
};

// Verb form codes in Lexique's `infover` column. When a spelling is several
// forms at once ("aime" is present, subjunctive and imperative) the most
// frequent wins, and this order breaks ties.
const VERB_FORMS = [
  ['inf', 'infinitive'], ['ind:pre', 'present'], ['par:pas', 'past participle'],
  ['ind:fut', 'future'], ['cnd:pre', 'conditional'], ['ind:imp', 'imperfect'],
  ['ind:pas', 'simple past'], ['sub:pre', 'subjunctive'], ['imp:pre', 'imperative'],
  ['par:pre', 'present participle'], ['sub:imp', 'imperfect subjunctive'],
];

await main();

async function main() {
  mkdirSync(CACHE, { recursive: true });
  const lexiquePath = await ensureSource(SOURCES.lexique);
  const wikdictPath = await ensureSource(SOURCES.wikdict);

  const forms = readLexique(lexiquePath);
  const glossary = readWikdict(wikdictPath);

  const common = [...forms.entries()]
    .map(([word, e]) => ({ word, freq: (e.films + e.books) / 2, readings: e.readings }))
    .filter((e) => e.freq >= MIN_FREQ && keepWord(e.word))
    .sort((a, b) => b.freq - a.freq || a.word.localeCompare(b.word, 'fr'));

  const words = {};
  let rank = 0;
  const untranslated = [];
  for (const entry of common) {
    let senses = pickReadings(entry.readings).map((r) => toSense(entry.word, r, glossary));
    if (WORD_OVERRIDES[entry.word] && senses.length) {
      // A hand-written meaning already covers every reading of the word.
      senses = [[senses[0][0], senses[0][1], WORD_OVERRIDES[entry.word], senses[0][3]]];
    }
    senses = senses.filter((s) => s[2]);
    if (!senses.length) { untranslated.push(entry.word); continue; }
    // A second reading only helps if it says something new.
    const unique = senses.filter((s, i) => i === 0 || s[2] !== senses[0][2]);
    words[entry.word] = [++rank, ...unique.slice(0, 2)];
  }

  const out = {
    meta: {
      language: 'fr',
      target: 'en',
      minFrequencyPerMillion: MIN_FREQ,
      count: rank,
      format: 'words[form] = [rank, [lemma, partOfSpeech, meaning, verbForm|null], …second reading]',
      sources: [
        'Lexique 3.83 (lexique.org) — CC BY-SA 4.0',
        'WikDict fr-en (wikdict.com), from Wiktionary — CC BY-SA 3.0',
      ],
      license: 'CC BY-SA 4.0',
    },
    words,
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out) + '\n');
  const kb = (Buffer.byteLength(JSON.stringify(out)) / 1024).toFixed(0);
  console.log(`${rank} words written to ${OUT} (${kb} KB).`);
  if (untranslated.length) console.log(`Skipped ${untranslated.length} with no translation: ${untranslated.join(' ')}`);
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

// One-letter "words" in Lexique are letter names (the noun "j"), which would
// match every elision in a lyric. Only the real one-letter words stay.
// Elided forms ("l'", "d'") are left out too: the app expands them to the full
// word ("le", "de") when it reads a lyric.
function keepWord(word) {
  if (word.length === 1) return ['a', 'à', 'y', 'ô'].includes(word);
  return /^[a-zàâäçéèêëîïôöùûüÿ'-]+$/.test(word) && !/^['-]|['-]$/.test(word);
}

function readLexique(path) {
  const lines = readFileSync(path, 'utf8').split('\n');
  const col = Object.fromEntries(lines[0].split('\t').map((name, i) => [name, i]));
  const forms = new Map();
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split('\t');
    if (c.length < 11) continue;
    const word = c[col.ortho].toLowerCase();
    const films = Number(c[col.freqfilms2]) || 0;
    const books = Number(c[col.freqlivres]) || 0;
    const pos = LEXIQUE_POS[c[col.cgram]];
    let entry = forms.get(word);
    if (!entry) forms.set(word, (entry = { films: 0, books: 0, readings: new Map() }));
    entry.films += films;
    entry.books += books;
    if (!pos) continue;
    // AUX and VER rows of the same verb are one reading.
    const key = `${c[col.lemme]}\t${pos}`;
    let reading = entry.readings.get(key);
    if (!reading) entry.readings.set(key, (reading = { lemma: c[col.lemme], pos, freq: 0, forms: new Map() }));
    const freq = (films + books) / 2;
    reading.freq += freq;
    for (const [code, label] of VERB_FORMS) {
      if (c[col.infover].includes(code)) reading.forms.set(label, (reading.forms.get(label) ?? 0) + freq);
    }
  }
  return forms;
}

function readWikdict(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  const rows = db
    .prepare('SELECT lexentry, written_rep, trans_list, score FROM translation WHERE lexentry IS NOT NULL AND trans_list IS NOT NULL')
    .all();
  const glossary = new Map(); // word → pos → [{ glosses, score }]
  for (const row of rows) {
    const tag = /__(.+?)__\d+$/.exec(row.lexentry)?.[1];
    const pos = tag && wikdictPos(tag);
    if (!pos) continue;
    const word = row.written_rep.toLowerCase().replaceAll('’', "'");
    let byPos = glossary.get(word);
    if (!byPos) glossary.set(word, (byPos = new Map()));
    if (!byPos.has(pos)) byPos.set(pos, []);
    byPos.get(pos).push({ glosses: row.trans_list.split(' | '), score: Number(row.score) || 0 });
  }
  db.close();
  return glossary;
}

function pickReadings(readings) {
  const sorted = [...readings.values()].sort((a, b) => b.freq - a.freq);
  if (!sorted.length) return [];
  return sorted.filter((r, i) => i === 0 || r.freq >= sorted[0].freq * SECOND_SENSE_SHARE).slice(0, 2);
}

function toSense(word, reading, glossary) {
  const { lemma } = reading;
  const meaning =
    LEMMA_OVERRIDES[`${lemma}/${reading.pos}`] ?? lookup(lemma, reading.pos, glossary) ?? lookup(word, reading.pos, glossary);
  // Lexique writes "oeil" and "coeur"; show the lemma as French spells it.
  const shown = lemma.replace(/oe(?=[ui])/g, 'œ');
  return [shown, reading.pos, meaning, reading.pos === 'verb' ? verbForm(word, lemma, reading.forms) : null];
}

function lookup(word, pos, glossary) {
  // Lexique writes "oeil"/"coeur"; Wiktionary writes "œil"/"cœur".
  const byPos = glossary.get(word) ?? glossary.get(word.replaceAll('oe', 'œ'));
  if (!byPos) return null;
  // Exact class, then a neighbouring one, then whatever Wiktionary has.
  const rows = byPos.get(pos) ?? POS_NEIGHBOURS[pos].map((p) => byPos.get(p)).find(Boolean) ?? [...byPos.values()].flat();
  const best = Math.max(...rows.map((r) => r.score));
  const glosses = [];
  for (const row of [...rows].sort((a, b) => b.score - a.score)) {
    if (row.score < best * 0.75) break;
    for (const gloss of row.glosses) {
      const clean = gloss.trim();
      if (clean && !glosses.includes(clean)) glosses.push(clean);
    }
  }
  if (!glosses.length) return null;
  const text = glosses.slice(0, MAX_GLOSSES).join(', ');
  return pos === 'verb' && !text.startsWith('to ') ? `to ${text}` : text;
}

// Lexique's codes are noisy (it lists "essayer" as a present-tense form too),
// so: a form identical to its lemma is the infinitive, nothing else is, and
// otherwise the most frequent code wins.
function verbForm(word, lemma, forms) {
  if (word === lemma) return forms.has('infinitive') ? 'infinitive' : null;
  let best = null;
  for (const [, label] of VERB_FORMS) {
    if (label === 'infinitive' || !forms.has(label)) continue;
    if (best === null || forms.get(label) > forms.get(best)) best = label;
  }
  return best;
}
