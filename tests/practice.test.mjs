// Flashcards and pronunciation. Run with: npm test

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildQueue, cardFace, checkAnswer, gapSegments, tally } from '../js/deck.js';
import { voiceScore } from '../js/speech.js';
import { AGAIN, EASY, GOOD, HARD, dayNumber, intervalDays, retrievability, review } from '../js/srs.js';

const DAY = 20_000; // any day number

test('stability is the gap after which recall is 90%', () => {
  assert.ok(Math.abs(retrievability(10, 10) - 0.9) < 1e-9);
  assert.equal(retrievability(0, 10), 1);
  assert.ok(retrievability(30, 10) < retrievability(10, 10));
  assert.equal(intervalDays(10.4), 10);
  assert.equal(intervalDays(0.2), 1);
  assert.equal(intervalDays(5000), 365);
});

test('a new card is scheduled further out the easier it was', () => {
  const [again, hard, good, easy] = [AGAIN, HARD, GOOD, EASY].map((rating) => review(undefined, rating, DAY));
  assert.deepEqual(
    [hard.due, good.due, easy.due].map((due) => due - DAY),
    [1, 2, 8],
  );
  assert.ok(again.d > hard.d && hard.d > good.d && good.d > easy.d);
  assert.equal(good.reps, 1);
  assert.equal(good.learning, undefined);
});

test('Again keeps the card in today’s session', () => {
  const missed = review(undefined, AGAIN, DAY);
  assert.equal(missed.due, DAY);
  assert.equal(missed.learning, true);
  // Getting it right later the same day releases it until tomorrow.
  const recovered = review(missed, GOOD, DAY);
  assert.equal(recovered.learning, undefined);
  assert.equal(recovered.due, DAY + 1);
  assert.ok(recovered.s >= missed.s);
});

test('intervals grow with each correct review and shrink after forgetting', () => {
  let card = review(undefined, GOOD, DAY);
  const gaps = [];
  let day = DAY;
  for (let i = 0; i < 3; i++) {
    day = card.due;
    card = review(card, GOOD, day);
    gaps.push(card.due - day);
  }
  for (let i = 1; i < gaps.length; i++) assert.ok(gaps[i] > gaps[i - 1], `gaps ${gaps}`);
  assert.ok(gaps.at(-1) > 30, `gaps ${gaps}`);

  const forgotten = review(card, AGAIN, card.due);
  assert.ok(forgotten.s < card.s / 4);
  assert.ok(forgotten.d > card.d);
  assert.equal(forgotten.learning, true);
});

test('on a review, Hard < Good < Easy', () => {
  const card = review(undefined, GOOD, DAY);
  const [hard, good, easy] = [HARD, GOOD, EASY].map((rating) => review(card, rating, card.due));
  assert.ok(hard.s < good.s && good.s < easy.s);
  assert.ok(hard.s >= card.s, 'a correct answer never weakens the memory');
});

test('a late correct review earns a longer gap than one on time', () => {
  const card = review(undefined, GOOD, DAY);
  assert.ok(review(card, GOOD, card.due + 10).s > review(card, GOOD, card.due).s);
});

test('difficulty stays between 1 and 10', () => {
  let card = review(undefined, AGAIN, DAY);
  for (let day = DAY + 1; day < DAY + 40; day++) card = review(card, AGAIN, day);
  assert.ok(card.d <= 10 && card.s > 0);
  for (let day = DAY + 40; day < DAY + 80; day++) card = review(card, EASY, day);
  assert.ok(card.d >= 1);
});

test('dayNumber changes at 4 am local time, not at midnight', () => {
  const at = (day, hour, minute = 0) => dayNumber(new Date(2026, 10, day, hour, minute).getTime());
  assert.equal(at(15, 23, 30), at(15, 12));
  assert.equal(at(16, 3, 59), at(15, 12));
  assert.equal(at(16, 4, 1), at(15, 12) + 1);
});

const word = (key, rank, extra = {}) => ({ key, word: key, rank, line: `la ${key} ici`, start: 3, end: 3 + key.length, ...extra });

test('buildQueue takes everything due and only the allowed number of new words', () => {
  const words = [word('rare', 900), word('due', 50), word('later', 60), word('common', 5), word('middle', 300)];
  const cards = { due: { due: DAY - 2, reps: 2 }, later: { due: DAY + 3, reps: 2 } };
  const queue = buildQueue(words, cards, DAY, 2, () => 0.5).map((w) => w.key);
  assert.deepEqual(queue, ['common', 'due', 'middle']); // most common new words first; "rare" waits
  assert.deepEqual(buildQueue(words, cards, DAY, 0).map((w) => w.key), ['due']);
});

test('buildQueue spreads new words between the reviews', () => {
  const words = [...Array.from({ length: 6 }, (_, i) => word(`old${i}`, i)), word('new1', 1), word('new2', 2)];
  const cards = Object.fromEntries(words.slice(0, 6).map((w) => [w.key, { due: DAY, reps: 1 }]));
  const queue = buildQueue(words, cards, DAY, 5).map((w) => w.key);
  assert.equal(queue.length, 8);
  assert.deepEqual([queue.indexOf('new1'), queue.indexOf('new2')], [0, 4]);
});

test('tally counts new, missed and due words', () => {
  const words = [word('a', 1), word('b', 2), word('c', 3), word('d', 4)];
  const cards = { b: { due: DAY, learning: true }, c: { due: DAY - 1 }, d: { due: DAY + 5 } };
  assert.deepEqual(tally(words, cards, DAY), { fresh: 1, again: 1, due: 1 });
});

test('mix shows the word first, then alternates with the lyric gap', () => {
  const w = word('vient', 200);
  assert.equal(cardFace(w, undefined, 'mix'), 'word');
  assert.equal(cardFace(w, { reps: 1, learning: true }, 'mix'), 'word');
  assert.equal(cardFace(w, { reps: 1 }, 'mix'), 'gap');
  assert.equal(cardFace(w, { reps: 2 }, 'mix'), 'word');
  assert.equal(cardFace(w, undefined, 'gap'), 'gap');
  assert.equal(cardFace(w, { reps: 1 }, 'word'), 'word');
});

test('no gap card when the lyric shows an elision or nothing but the word', () => {
  const elided = { key: 'je', word: 'je', rank: 3, line: "J'ai le cœur lourd", start: 0, end: 2 };
  assert.equal(cardFace(elided, { reps: 1 }, 'gap'), 'word');
  const alone = { key: 'oui', word: 'oui', rank: 90, line: 'Oui', start: 0, end: 3 };
  assert.equal(cardFace(alone, { reps: 1 }, 'gap'), 'word');
  const ligature = { key: 'coeur', word: 'cœur', rank: 400, line: 'Mon cœur', start: 4, end: 8 };
  assert.equal(cardFace(ligature, { reps: 1 }, 'gap'), 'gap');
});

test('gapSegments blanks every use of the word in the line', () => {
  const papa = { key: 'papa', word: 'papa', line: 'Papa, où est ton papa ?', start: 0, end: 4 };
  assert.deepEqual(gapSegments(papa), [
    { text: 'Papa', gap: true },
    { text: ', où est ton ', gap: false },
    { text: 'papa', gap: true },
    { text: ' ?', gap: false },
  ]);
  const moi = { key: 'moi', word: 'moi', line: 'Dis-moi', start: 4, end: 7 };
  assert.deepEqual(gapSegments(moi), [
    { text: 'Dis-', gap: false },
    { text: 'moi', gap: true },
  ]);
});

test('checkAnswer forgives case and spacing, and flags missing accents', () => {
  assert.equal(checkAnswer('  Été ', 'été'), 'right');
  assert.equal(checkAnswer('coeur', 'cœur'), 'right');
  assert.equal(checkAnswer('ete', 'été'), 'accents');
  assert.equal(checkAnswer('etait', 'été'), 'wrong');
  assert.equal(checkAnswer('aujourd’hui', "aujourd'hui"), 'right');
});

test('voiceScore prefers a good voice from France and rejects other languages', () => {
  const score = (name, lang) => voiceScore({ name, lang });
  assert.equal(score('Samantha', 'en-US'), -Infinity);
  assert.ok(score('Audrey (Premium)', 'fr-FR') > score('Google français', 'fr-FR'));
  assert.ok(score('Google français', 'fr-FR') > score('Thomas', 'fr-FR'));
  assert.ok(score('Thomas', 'fr-FR') > score('Amélie (Enhanced)', 'fr-CA'));
  assert.ok(score('Amélie', 'fr-CA') > score('Grandpa (French (France))', 'fr-FR'));
  assert.ok(score('French', 'fr_FR') > score('French', 'fr_CA')); // Android spells it with "_"
});
