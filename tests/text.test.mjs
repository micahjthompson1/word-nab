// Run with: npm test

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { toCsv } from '../js/csv.js';
import { simplifyTitle } from '../js/lyrics.js';
import { codeChallenge } from '../js/spotify.js';
import { cleanLines, detectLanguage, extractWords, wordsInLine } from '../js/text.js';

const { words } = JSON.parse(readFileSync(new URL('../data/words.fr.json', import.meta.url), 'utf8'));
const has = (key) => Object.hasOwn(words, key);
const keys = (line) => wordsInLine(line, has).map((hit) => hit.key);

test('finds plain words and ignores unknown ones', () => {
  assert.deepEqual(keys('Maman dit que zzzxq'), ['maman', 'dit', 'que']);
});

test('expands elisions to the full word', () => {
  assert.deepEqual(keys("J'ai dit qu'il m'aime"), ['je', 'ai', 'dit', 'que', 'il', 'me', 'aime']);
});

test('keeps words that contain an apostrophe or hyphen whole', () => {
  assert.deepEqual(keys("Aujourd'hui peut-être"), ["aujourd'hui", 'peut-être']);
});

test('splits hyphenated phrases that are not words themselves', () => {
  assert.deepEqual(keys('Dites-moi'), ['dites', 'moi']);
});

test('accepts typographic apostrophes and the œ ligature', () => {
  assert.deepEqual(keys('J’ai le cœur'), ['je', 'ai', 'le', 'coeur']);
});

test('does not match inside longer words', () => {
  // The old app used substring matching, so "a" matched any line with an "a".
  assert.deepEqual(keys('Papaoutai'), []);
});

test('reports where the word sits in the line', () => {
  const line = "Dis-moi d'où il vient";
  const hit = wordsInLine(line, has).find((h) => h.key === 'vient');
  assert.equal(line.slice(hit.start, hit.end), 'vient');
  const elided = wordsInLine(line, has).find((h) => h.key === 'de');
  assert.equal(line.slice(elided.start, elided.end), "d'");
});

test('extractWords keeps the first line of each word and counts repeats', () => {
  const found = extractWords("Où est ton papa ?\nDis-moi, où est ton papa ?\n[Refrain]\nJ'ai le cœur lourd", has);
  const papa = found.find((w) => w.key === 'papa');
  assert.equal(papa.line, 'Où est ton papa ?');
  assert.equal(papa.count, 2);
  assert.equal(found.find((w) => w.key === 'je').display, 'je');
  assert.equal(found.find((w) => w.key === 'coeur').display, 'cœur');
  assert.ok(!found.some((w) => w.line === '[Refrain]'));
});

test('extractWords skips lines that are clearly another language', () => {
  const found = extractWords("I love you so much\nJe t'aime tellement", has);
  assert.ok(found.every((w) => w.line === "Je t'aime tellement"));
});

test('cleanLines drops blanks and section markers', () => {
  assert.deepEqual(cleanLines('a\r\n\r\n[Couplet 1]\n(x2)\n  b  '), ['a', 'b']);
});

test('detects French, English and mixed songs', () => {
  const french = "Dites-moi d'où il vient\nEnfin je saurai où je vais\nMaman dit que lorsqu'on cherche bien\nOn finit toujours par trouver\nElle dit qu'il n'est jamais très loin";
  const english = "I know that you love me\nAnd I want to be with you\nWhen the night is over we will get there\nYou were never mine but I need you now";
  assert.equal(detectLanguage(french).primary, 'fr');
  assert.ok(detectLanguage(french).shares.fr > 0.8);
  assert.equal(detectLanguage(english).primary, 'en');
  const mixed = detectLanguage(`${french}\n${english}`);
  assert.ok(mixed.shares.fr > 0.3 && mixed.shares.en > 0.3);
  assert.equal(detectLanguage('La la la').primary, null);
});

test('simplifyTitle strips versions and features', () => {
  assert.equal(simplifyTitle('Alors on danse - Radio Edit'), 'Alors on danse');
  assert.equal(simplifyTitle('Tous les mêmes (feat. Someone)'), 'Tous les mêmes');
  assert.equal(simplifyTitle('Papaoutai'), 'Papaoutai');
});

test('CSV keeps the original first two columns and escapes safely', () => {
  const csv = toCsv([
    { word: 'cœur', meaning: 'heart', song: 'A "song"', artist: 'X', line: '=cmd()', english: '' },
  ]);
  const [header, row] = csv.trim().split('\r\n');
  assert.ok(header.startsWith('"Common Word","Translation"'));
  assert.equal(row, `"cœur","heart","A ""song"" - X","'=cmd()",""`);
});

test('PKCE challenge matches the RFC 7636 example', async () => {
  assert.equal(
    await codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  );
});
