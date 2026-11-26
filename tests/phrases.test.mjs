import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cardFace, checkAnswer, gapSegments } from '../js/deck.js';
import { french } from '../js/lang-fr.js';
import { catalogueLines, compileCatalogue, findPhrases, phraseKey, phraseText } from '../js/phrases.js';
import { PHRASES } from '../js/phrases-fr.js';
import { FUNCTIONS } from '../js/functions-fr.js';

const catalogue = compileCatalogue(PHRASES, french);
const found = (lyrics) => findPhrases(lyrics, catalogue, french);

test('every built-in phrase is well formed and unique', () => {
  const ids = new Set(FUNCTIONS.map((f) => f.id));
  const keys = new Set();
  for (const entry of PHRASES) {
    assert.ok(entry.phrase && entry.meaning, entry.phrase);
    assert.ok(entry.lists.length && entry.lists.every((id) => ids.has(id)), entry.phrase);
    const key = phraseKey(entry.phrase, french);
    assert.ok(!keys.has(key), `listed twice: ${entry.phrase}`);
    keys.add(key);
  }
});

test('phrases match whatever the spelling, spacing and elision', () => {
  const [hit] = found("Oh TU M'MANQUES tellement");
  assert.equal(hit.key, phraseKey('tu me manques', french));
  assert.equal(hit.line.slice(hit.start, hit.end), "TU M'MANQUES");
  assert.equal(found('Tu me manques').length, 1);
  assert.equal(found('Dis moi la vérité')[0]?.key, phraseKey('dis-moi', french));
  assert.equal(found('Non, je ne regrette rien')[0]?.key, phraseKey('je ne regrette rien', french));
  assert.equal(found("J'regrette rien")[0]?.key, phraseKey('je ne regrette rien', french));
  assert.equal(found('Je regrette Rien').length, 1);
});

test('only whole words match, and the longer of two overlapping phrases wins', () => {
  assert.deepEqual(found('Ça vaut le coup'), []);
  const keys = found('Comment ça va ?').map((hit) => hit.key);
  assert.deepEqual(keys, [phraseKey('comment ça va', french)]);
});

test('a phrase is kept once per song, with the first line it is in', () => {
  const hits = found('Je t’aime\nmoi je t’aime aussi');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 'Je t’aime');
  assert.equal(hits[0].count, 2);
});

test('hand-picked text is tidied and keyed like the built-in list', () => {
  const line = '« Ne me quitte pas ! »';
  assert.equal(phraseText(line, 0, line.length), 'ne me quitte pas');
  assert.equal(phraseKey('Ne me quitte pas !', french), phraseKey('ne me quitte pas', french));
  assert.notEqual(phraseKey('je', french), 'je'); // never mixed up with a word
});

test('phrase flashcards blank the whole phrase and accept typing without hyphens', () => {
  const phrase = { kind: 'phrase', key: 'p:dis moi', word: 'dis-moi', line: 'Dis-moi pourquoi', start: 0, end: 7 };
  assert.deepEqual(gapSegments(phrase, french), [
    { text: 'Dis-moi', gap: true },
    { text: ' pourquoi', gap: false },
  ]);
  assert.equal(cardFace(phrase, null, 'gap', french), 'gap');
  assert.equal(cardFace({ ...phrase, line: 'Dis-moi', end: 7 }, null, 'gap', french), 'word');
  assert.equal(checkAnswer('dis moi', 'dis-moi', french), 'right');
  assert.equal(checkAnswer('Tu me manques !', 'tu me manques', french), 'right');
  assert.equal(checkAnswer('je taime', "je t'aime", french), 'wrong');
});

test('hand-picked phrases are written as lines for the built-in list', () => {
  const lines = catalogueLines(
    [
      { key: phraseKey("je t'aime", french), word: "je t'aime", meaning: 'I love you', functions: ['expressive'] },
      { key: phraseKey("l'amour est mort", french), word: "l'amour est mort", meaning: "love's dead", functions: ['expressive', 'describe'] },
      { key: phraseKey('sous le ciel', french), word: 'sous le ciel', meaning: 'under the sky', functions: [] },
      { key: phraseKey('dans la rue', french), word: 'dans la rue', meaning: '', functions: ['describe'] },
      { key: phraseKey('dans la rue', french), word: 'dans la rue', meaning: 'in the street', functions: ['describe'] },
    ],
    { byKey: new Map([[phraseKey("je t'aime", french), {}]]) },
  );
  assert.deepEqual(lines, [
    `  { phrase: "l'amour est mort", meaning: "love's dead", lists: ['expressive', 'describe'] },`,
    `  { phrase: 'sous le ciel', meaning: 'under the sky', lists: [] }, // TODO: add a list`,
    `  { phrase: 'dans la rue', meaning: '', lists: ['describe'] }, // TODO: add a meaning`,
  ]);
});
