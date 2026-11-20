import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { toCsv } from '../js/csv.js';
import { classify } from '../js/functions-fr.js';
import { extractWords } from '../js/text.js';

const { words } = JSON.parse(readFileSync(new URL('../data/words.fr.json', import.meta.url)));
const has = (key) => Object.hasOwn(words, key);
const readings = (key) => words[key].slice(1).filter(Boolean).map(([lemma, pos, , form]) => ({ lemma, pos, form }));
const tag = (hit, line) => classify(hit.key, readings(hit.key), line, hit.start, hit.end);

/** The lists a word ends up in when these lyrics are added. */
function listsOf(lyrics) {
  return Object.fromEntries(extractWords(lyrics, has, undefined, tag).map((w) => [w.key, w.tags]));
}

test('feelings are expressive', () => {
  const lists = listsOf("Je t'aime\nJe regrette\nMon cœur est triste");
  assert.deepEqual(lists.aime, ['expressive']);
  assert.deepEqual(lists.regrette, ['expressive']);
  assert.deepEqual(lists.coeur, ['expressive']);
  assert.ok(lists.triste.includes('expressive') && lists.triste.includes('describe'));
});

test('past tenses and time words narrate', () => {
  const lists = listsOf("D'abord il est parti, puis il m'a dit adieu\nEnsuite je t'aimais, enfin");
  for (const key of ["d'abord", 'parti', 'puis', 'dit', 'ensuite', 'enfin']) assert.ok(lists[key].includes('narrate'), key);
  assert.ok(lists.aimais.includes('narrate') && lists.aimais.includes('expressive'));
  assert.deepEqual(lists.est, []); // the auxiliary itself is not a past tense
});

test('adjectives describe', () => {
  const lists = listsOf('Ta robe rouge, la belle nuit');
  assert.deepEqual(lists.rouge, ['describe']);
  assert.deepEqual(lists.belle, ['describe']);
  assert.deepEqual(lists.nuit, []);
});

test('imperatives are directive only where they give an order', () => {
  const lists = listsOf('Viens avec moi, reste ici\nRegarde-moi\nNe me quitte pas\nAllons-y');
  for (const key of ['viens', 'reste', 'regarde', 'quitte', 'allons']) assert.ok(lists[key].includes('directive'), key);
  const plain = listsOf('Tu viens ce soir\nNous allons danser\nLe vent souffle\nVa-t-il partir');
  for (const key of ['viens', 'allons', 'souffle', 'va']) assert.ok(!plain[key].includes('directive'), key);
});

test('the example line is the one that shows what the word does', () => {
  const [viens] = extractWords('Tu viens ce soir\nViens avec moi', (key) => key === 'viens', undefined, tag);
  assert.equal(viens.line, 'Viens avec moi');
  assert.deepEqual(viens.tags, ['directive']);
});

test('greetings and interjections are phatic', () => {
  const lists = listsOf("Salut, allez, ah bon ?\nAu revoir, s'il te plaît, d'accord\nVous allez partir");
  for (const key of ['salut', 'allez', 'ah', 'bon', 'revoir', 'plaît', 'accord']) assert.ok(lists[key].includes('phatic'), key);
  assert.ok(!lists.bon.includes('describe')); // "ah bon" is a reaction, not a description
  assert.ok(!listsOf('Vous allez partir').allez.includes('phatic'));
});

test('CSV lists the language functions when asked', () => {
  const row = { word: 'viens', meaning: 'to come', song: 'S', artist: '', line: 'Viens', english: '', functions: ['directive', 'phatic'] };
  const [header, line] = toCsv([row], 'English', { directive: 'Directive', phatic: 'Phatic' }).trim().split('\r\n');
  assert.ok(header.endsWith('"Language functions"'));
  assert.ok(line.endsWith('"Directive; Phatic"'));
  assert.ok(!toCsv([row]).includes('Language functions'));
});
