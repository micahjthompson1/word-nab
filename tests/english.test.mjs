// The English-learner version. Run with: npm test

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { toCsv } from '../js/csv.js';
import { cardFace, checkAnswer, gapSegments } from '../js/deck.js';
import { english } from '../js/lang-en.js';
import { voiceScore } from '../js/speech.js';
import { extractWords, wordsInLine } from '../js/text.js';

const list = (language) => JSON.parse(readFileSync(new URL(`../data/words.en-${language}.json`, import.meta.url), 'utf8'));
const lists = { es: list('es'), zh: list('zh'), ru: list('ru') };
const { words } = lists.es;
const has = (key) => Object.hasOwn(words, key);
const hits = (line) => wordsInLine(line, has, english);
const keys = (line) => hits(line).map((hit) => hit.key);

test('finds plain English words and ignores unknown ones', () => {
  assert.deepEqual(keys('Hello darkness my old friend zzzxq'), ['hello', 'darkness', 'my', 'old', 'friend']);
});

test('opens up "n\'t" into the verb and "not"', () => {
  assert.deepEqual(keys("I don't know"), ['i', 'do', 'not', 'know']);
  assert.deepEqual(keys("You can't and you won't"), ['you', 'can', 'not', 'and', 'you', 'will', 'not']);
  assert.deepEqual(keys("It isn't, she doesn't, we couldn't"), ['it', 'is', 'not', 'she', 'does', 'not', 'we', 'could', 'not']);
});

test('opens up the other contractions', () => {
  assert.deepEqual(keys("I'm here and you're there"), ['i', 'am', 'here', 'and', 'you', 'are', 'there']);
  assert.deepEqual(keys("We've said I'll go, I'd stay"), ['we', 'have', 'said', 'i', 'will', 'go', 'i', 'would', 'stay']);
});

test('"\'s" is "is" after a pronoun, "us" in "let\'s", and nothing after a noun', () => {
  assert.deepEqual(keys("She's my baby's mother"), ['she', 'is', 'my', 'baby', 'mother']);
  assert.deepEqual(keys("Let's go, what's wrong"), ['let', 'us', 'go', 'what', 'is', 'wrong']);
});

test('restores clipped spellings', () => {
  assert.deepEqual(keys("I'm lovin' it"), ['i', 'am', 'loving', 'it']);
  assert.deepEqual(keys('Nothin on you'), ['nothing', 'on', 'you']);
  assert.deepEqual(keys("'Cause I told 'em"), ['because', 'i', 'told', 'them']);
  assert.deepEqual(keys("Y'all wait 'til morning"), ['you', 'all', 'wait', 'until', 'morning']);
  // "cause" on its own is still the noun, and short words are not stretched.
  assert.deepEqual(keys('A lost cause'), ['a', 'lost', 'cause']);
  assert.deepEqual(keys('kin'), []);
});

test('keeps contractions that are words in their own right', () => {
  assert.deepEqual(keys("Ain't no sunshine at five o'clock"), ["ain't", 'no', 'sunshine', 'at', 'five', "o'clock"]);
  assert.deepEqual(keys('I wanna, you gonna'), ['i', 'wanna', 'you', 'gonna']);
});

test('accepts typographic apostrophes', () => {
  assert.deepEqual(keys('I don’t know, ’cause I’m lovin’ it'), ['i', 'do', 'not', 'know', 'because', 'i', 'am', 'loving', 'it']);
});

test('reports where each half of a contraction sits in the line', () => {
  const line = "We won't stop, don't";
  const text = (hit) => line.slice(hit.start, hit.end);
  const [, will, not, , doHit, not2] = hits(line);
  assert.deepEqual([text(will), will.elided], ['wo', true]);
  assert.deepEqual([text(not), not.elided], ["n't", true]);
  assert.deepEqual([text(doHit), doHit.elided], ['do', false]);
  assert.equal(text(not2), "n't");
  const [loving] = hits("lovin' you");
  assert.equal("lovin' you".slice(loving.start, loving.end), "lovin'");
});

test('extractWords shows the full word for a contraction and skips other languages', () => {
  const found = extractWords("I don't wanna be lovin' you\nYo no quiero nada más que esto\nI don't know", has, english);
  const display = (key) => found.find((word) => word.key === key)?.display;
  assert.equal(display('not'), 'not');
  assert.equal(display('loving'), 'loving');
  assert.equal(display('do'), 'do');
  assert.equal(found.find((word) => word.key === 'do').count, 2);
  assert.ok(found.every((word) => !word.line.startsWith('Yo no')));
});

test('the three word lists hold the same words in the same order', () => {
  const order = Object.keys(lists.es.words);
  assert.ok(order.length > 3500);
  assert.deepEqual(Object.keys(lists.zh.words), order);
  assert.deepEqual(Object.keys(lists.ru.words), order);
  for (const language of ['es', 'zh', 'ru']) {
    assert.equal(lists[language].meta.target, language);
    for (const entry of Object.values(lists[language].words)) assert.ok(entry[1][2], `empty meaning in ${language}`);
  }
});

test('word forms point at their dictionary word in every language', () => {
  for (const language of ['es', 'zh', 'ru']) {
    const { words: w } = lists[language];
    assert.deepEqual(w.went[1].slice(0, 2).concat(w.went[1][3]), ['go', 'verb', 'past']);
    assert.deepEqual(w.children[1].slice(0, 2).concat(w.children[1][3]), ['child', 'noun', 'plural']);
    assert.deepEqual(w.better[1].slice(0, 2).concat(w.better[1][3]), ['good', 'adj', 'comparative']);
    assert.equal(w.i[1][0], 'I');
    assert.equal(w.monday[1][0], 'Monday');
  }
  assert.equal(lists.es.words.love[1][2], 'amar, querer');
  assert.equal(lists.zh.words.love[1][2], '爱，喜爱');
  assert.equal(lists.ru.words.love[1][2], 'любить');
});

test('Chinese meanings are simplified characters and Russian ones carry no stress marks', () => {
  for (const [, ...senses] of Object.values(lists.zh.words)) {
    for (const sense of senses) assert.ok(!/[愛時臟與這個們說還沒對會來]/.test(sense[2]), sense[2]);
  }
  for (const [, ...senses] of Object.values(lists.ru.words)) {
    for (const sense of senses) assert.ok(!/[̀́]/.test(sense[2].normalize('NFD').replace(/[йЙёЁ]/g, '')), sense[2]);
  }
});

test('flashcards work with English words', () => {
  const know = { key: 'know', word: 'know', line: "I don't know why you know", start: 8, end: 12 };
  assert.equal(cardFace(know, { reps: 1 }, 'mix', english), 'gap');
  assert.deepEqual(gapSegments(know, english), [
    { text: "I don't ", gap: false },
    { text: 'know', gap: true },
    { text: ' why you ', gap: false },
    { text: 'know', gap: true },
  ]);
  // "not" was found inside "don't", so there is no clean gap to leave.
  const not = { key: 'not', word: 'not', line: "I don't know", start: 4, end: 7 };
  assert.equal(cardFace(not, { reps: 1 }, 'gap', english), 'word');
  const me = { key: 'i', word: 'I', line: 'I know', start: 0, end: 1 };
  assert.equal(cardFace(me, { reps: 1 }, 'gap', english), 'gap');
  // …and "I" is not blanked out of "I'll".
  const contracted = { key: 'i', word: 'I', line: "And I'll be your friend", start: 4, end: 5 };
  assert.equal(cardFace(contracted, { reps: 1 }, 'gap', english), 'word');
  assert.equal(checkAnswer(' Know ', 'know', english), 'right');
  assert.equal(checkAnswer('i', 'I', english), 'right');
  assert.equal(checkAnswer('now', 'know', english), 'wrong');
});

test('voiceScore prefers a good American English voice when English is being learned', () => {
  const score = (name, lang) => voiceScore({ name, lang }, 'en-US');
  assert.equal(score('Thomas', 'fr-FR'), -Infinity);
  assert.ok(score('Samantha (Enhanced)', 'en-US') > score('Google US English', 'en-US'));
  assert.ok(score('Google US English', 'en-US') > score('Samantha', 'en-US'));
  assert.ok(score('Samantha', 'en-US') > score('Daniel', 'en-GB'));
  assert.ok(score('Daniel', 'en-GB') > score('Zarvox', 'en-US'));
});

test('the CSV names the language the lyrics were translated into', () => {
  const row = { word: 'heart', meaning: 'сердце', song: 'S', artist: 'A', line: 'My heart', english: 'Моё сердце' };
  assert.ok(toCsv([row], 'Russian').startsWith('"Common Word","Translation","Song","Lyric","Lyric (Russian)"'));
  assert.ok(toCsv([row]).startsWith('"Common Word","Translation","Song","Lyric","Lyric (English)"'));
});
