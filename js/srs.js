// Spaced repetition: decides when each flashcard should come back.
//
// This is FSRS-6 (Free Spaced Repetition Scheduler) with its published default
// parameters, from the open FSRS family built into Anki. It models two things
// per card:
//   stability  — how many days until the chance of recalling it falls to 90%
//   difficulty — 1 (easy) to 10 (hard)
// and shows the card again when recall is about to drop to 90%, which is when
// a review strengthens the memory most for the least time spent.
//
// Formulas and parameters:
// https://github.com/open-spaced-repetition/awesome-fsrs/wiki/The-Algorithm
//
// Pure functions with no browser APIs, so they also run under `node --test`.

export const AGAIN = 1;
export const HARD = 2;
export const GOOD = 3;
export const EASY = 4;

// prettier-ignore
const W = [
  0.212, 1.2931, 2.3065, 8.2956,          // first stability for Again, Hard, Good, Easy
  6.4133, 0.8334, 3.0194, 0.001,          // difficulty
  1.8722, 0.1666, 0.796,                  // stability after a correct answer
  1.4835, 0.0614, 0.2629, 1.6483,         // stability after forgetting
  0.6014, 1.8729,                         // Hard penalty, Easy bonus
  0.5425, 0.0912, 0.0658,                 // another answer on the same day
  0.1542,                                 // shape of the forgetting curve
];

const DECAY = W[20];
const FACTOR = 0.9 ** (-1 / DECAY) - 1;
const MIN_STABILITY = 0.001;
// The default parameters are an average over many learners. Capping the gap
// at a year keeps a word from vanishing if they are too generous for you.
const MAX_INTERVAL_DAYS = 365;

const DAY_MS = 86_400_000;
const DAY_STARTS_AT_HOUR = 4; // a late-night session still counts as "today"

const clamp = (value, low, high) => Math.min(Math.max(value, low), high);
const round = (value) => Math.round(value * 10_000) / 10_000;

/**
 * @typedef {object} Card
 * @property {number} s     stability, in days
 * @property {number} d     difficulty, 1–10
 * @property {number} due   day number on which to show it next
 * @property {number} last  day number of the latest answer
 * @property {number} reps  how many times it has been answered
 * @property {boolean} [learning]  the latest answer was Again: ask again this session
 */

/** Days since a fixed point, in local time. Two moments on the same study day give the same number. */
export function dayNumber(ms = Date.now()) {
  const localMs = ms - new Date(ms).getTimezoneOffset() * 60_000;
  return Math.floor((localMs - DAY_STARTS_AT_HOUR * 3_600_000) / DAY_MS);
}

/** Chance (0–1) of recalling a card `days` after its last review. */
export function retrievability(days, stability) {
  return (1 + (FACTOR * days) / stability) ** -DECAY;
}

/** Whole days to wait so that recall is at 90% — which is what stability means. */
export function intervalDays(stability) {
  return clamp(Math.round(stability), 1, MAX_INTERVAL_DAYS);
}

const initialDifficulty = (rating) => W[4] - Math.exp(W[5] * (rating - 1)) + 1;

function nextDifficulty(difficulty, rating) {
  // Moves less the closer it already is to 10, and drifts slightly back
  // towards the starting value so a card cannot get stuck as "hard" forever.
  const moved = difficulty - (W[6] * (rating - 3) * (10 - difficulty)) / 9;
  return clamp(W[7] * initialDifficulty(EASY) + (1 - W[7]) * moved, 1, 10);
}

function afterRecall(stability, difficulty, recall, rating) {
  const adjust = rating === HARD ? W[15] : rating === EASY ? W[16] : 1;
  const growth =
    Math.exp(W[8]) * (11 - difficulty) * stability ** -W[9] * (Math.exp(W[10] * (1 - recall)) - 1) * adjust;
  return stability * (1 + growth);
}

function afterForgetting(stability, difficulty, recall) {
  const relearned =
    W[11] * difficulty ** -W[12] * ((stability + 1) ** W[13] - 1) * Math.exp(W[14] * (1 - recall));
  return Math.min(stability, relearned);
}

function afterSameDay(stability, rating) {
  const growth = Math.exp(W[17] * (rating - 3 + W[18])) * stability ** -W[19];
  // A correct answer never makes the memory weaker.
  return stability * (rating === AGAIN ? growth : Math.max(growth, 1));
}

/**
 * The card's state after an answer.
 * @param {Card|undefined} card  undefined for a word never practised
 * @param {number} rating        AGAIN, HARD, GOOD or EASY
 * @param {number} today         dayNumber()
 * @returns {Card}
 */
export function review(card, rating, today) {
  let stability;
  let difficulty;
  if (!card) {
    stability = W[rating - 1];
    difficulty = clamp(initialDifficulty(rating), 1, 10);
  } else {
    const elapsed = Math.max(0, today - card.last);
    if (elapsed === 0) {
      stability = afterSameDay(card.s, rating);
    } else {
      const recall = retrievability(elapsed, card.s);
      stability =
        rating === AGAIN ? afterForgetting(card.s, card.d, recall) : afterRecall(card.s, card.d, recall, rating);
    }
    difficulty = nextDifficulty(card.d, rating);
  }
  stability = Math.max(stability, MIN_STABILITY);

  const next = { s: round(stability), d: round(difficulty), due: today, last: today, reps: (card?.reps ?? 0) + 1 };
  if (rating === AGAIN) next.learning = true;
  else next.due = today + intervalDays(stability);
  return next;
}
