// The flashcards screen: one card at a time, answered from memory and then
// rated Again / Hard / Good / Easy.
//
// What makes it effective, and where each part lives:
//  - Answering before seeing the answer (retrieval practice) — the two-sided card.
//  - Each word returns just before it would be forgotten (spaced repetition) — srs.js.
//  - A few new words a day, mixed in with the reviews — deck.js.
//  - Familiar words are also asked the hard way round: the lyric with the word
//    missing, to be recalled (and optionally typed) from its meaning — deck.js.
//  - Hearing the word and the lyric — speech.js.
//
// Progress is kept in this browser, like the word list.

import { buildQueue, cardFace, checkAnswer, gapSegments, tally } from './deck.js';
import { h, markedLine, setStatus, speakButton } from './dom.js';
import * as speech from './speech.js';
import { AGAIN, EASY, GOOD, HARD, dayNumber, review } from './srs.js';
import { load, save } from './storage.js';
import { translateLine } from './translate.js';
import { setEnglish } from './words.js';

const CARDS = 'cards.v1';
const PREFS = 'flashcards.v1';
// A missed card comes back after this many others — long enough that it has
// to be recalled rather than repeated.
const REQUEUE_AFTER = 3;
const RATINGS = [
  [AGAIN, 'Again'],
  [HARD, 'Hard'],
  [GOOD, 'Good'],
  [EASY, 'Easy'],
];

/** @type {Record<string, import('./srs.js').Card>} */
let cards = load(CARDS, {});
if (typeof cards !== 'object' || cards === null || Array.isArray(cards)) cards = {};

// `day`, `introduced` and `bonus` track today's allowance of new words.
const prefs = { newPerDay: 10, style: 'mix', speak: true, day: 0, introduced: 0, bonus: 0, ...load(PREFS, {}) };

const $ = (id) => document.getElementById(id);
let el;
let deck = () => []; // the words to practise, supplied by the page
let session = { queue: [], word: null, face: 'word', revealed: false, result: null, typed: '', answered: 0 };

/**
 * @param {{ deck: () => import('./words.js').SavedWord[], onClose: () => void }} options
 */
export function init(options) {
  deck = options.deck;
  el = {
    dialog: $('flashcards'),
    counts: $('flash-counts'),
    status: $('flash-status'),
    body: $('flash-body'),
    newPerDay: $('flash-new'),
    style: $('flash-style'),
    speak: $('flash-speak'),
    voiceRow: $('flash-voice-row'),
    voice: $('flash-voice'),
  };

  el.newPerDay.value = String(prefs.newPerDay);
  el.style.value = prefs.style;
  el.speak.checked = prefs.speak;
  el.speak.closest('label').hidden = !speech.supported;

  $('flash-close').addEventListener('click', () => el.dialog.close());
  el.dialog.addEventListener('close', () => {
    speech.stop();
    options.onClose();
  });
  el.dialog.addEventListener('keydown', onKey);
  el.newPerDay.addEventListener('change', () => {
    updatePrefs({ newPerDay: Number(el.newPerDay.value) });
    startSession();
  });
  el.style.addEventListener('change', () => {
    updatePrefs({ style: el.style.value });
    startSession();
  });
  el.speak.addEventListener('change', () => updatePrefs({ speak: el.speak.checked }));
  el.voice.addEventListener('change', () => {
    speech.chooseVoice(el.voice.value);
    speech.speak('Bonjour'); // a sample, so the choice can be heard
  });
  speech.onVoicesChanged(renderVoices);
  renderVoices();
}

export function open() {
  session.answered = 0;
  el.dialog.showModal();
  startSession();
}

/** Cards waiting right now: reviews that are due plus today's remaining new words. */
export function waitingCount() {
  const today = dayNumber();
  const { fresh, again, due } = tally(deck(), cards, today);
  return again + due + Math.min(fresh, newAllowance(today));
}

/** Forget all practice history (used when the word list is cleared). */
export function reset() {
  cards = {};
  save(CARDS, cards);
  updatePrefs({ introduced: 0, bonus: 0 });
}

function updatePrefs(change) {
  Object.assign(prefs, change);
  save(PREFS, prefs);
}

function newAllowance(today) {
  if (prefs.day !== today) Object.assign(prefs, { day: today, introduced: 0, bonus: 0 });
  return Math.max(0, prefs.newPerDay + prefs.bonus - prefs.introduced);
}

// ---------------------------------------------------------------------------
// Session

function startSession() {
  const today = dayNumber();
  session.queue = buildQueue(deck(), cards, today, newAllowance(today));
  advance();
}

function advance() {
  speech.stop();
  setStatus(el.status, '');
  const word = session.queue.shift() ?? null;
  Object.assign(session, {
    word,
    face: word ? cardFace(word, cards[word.key], prefs.style) : 'word',
    revealed: false,
    result: null,
    typed: '',
  });
  render();
  // Hearing the word is part of the question; on a gap card it would be the answer.
  if (word && prefs.speak && session.face === 'word') pressSpeak('.flash-word .speak');
}

function reveal() {
  const typed = el.body.querySelector('.flash-input')?.value.trim() ?? '';
  session.typed = typed;
  session.result = typed ? checkAnswer(typed, session.word.word) : null;
  session.revealed = true;
  render();
  if (prefs.speak && session.face === 'gap') pressSpeak('.flash-line .speak');
}

function rate(rating) {
  const { word } = session;
  const today = dayNumber();
  const before = cards[word.key];
  if (!before) {
    newAllowance(today); // starts a new day's count if the date has changed
    updatePrefs({ introduced: prefs.introduced + 1 });
  }
  cards[word.key] = review(before, rating, today);
  save(CARDS, cards);
  session.answered++;
  if (rating === AGAIN) session.queue.splice(Math.min(REQUEUE_AFTER, session.queue.length), 0, word);
  advance();
}

function learnMore() {
  updatePrefs({ bonus: prefs.bonus + prefs.newPerDay });
  startSession();
}

function onKey(event) {
  if (!session.word || !session.revealed || event.target.closest('input, select')) return;
  const rating = Number(event.key);
  if (rating >= AGAIN && rating <= EASY) {
    event.preventDefault();
    rate(rating);
  }
}

// Auto-play goes through the card's own speaker button, so it behaves exactly
// like the user pressing it.
function pressSpeak(selector) {
  el.body.querySelector(selector)?.click();
}

// ---------------------------------------------------------------------------
// Drawing

function render() {
  const { word, revealed, face } = session;
  renderCounts();
  if (!word) {
    el.body.replaceChildren(doneScreen());
    return;
  }
  el.body.replaceChildren(revealed ? cardBack(word) : face === 'gap' ? gapFront(word) : wordFront(word));

  // Keep the keyboard on the next sensible control: Space or Enter then shows
  // the answer or accepts the suggested rating.
  const suggested = session.result === 'wrong' ? AGAIN : GOOD;
  const typing = !window.matchMedia('(pointer: coarse)').matches && el.body.querySelector('.flash-input');
  const target = revealed ? el.body.querySelector(`.rate[data-rating="${suggested}"]`) : typing || el.body.querySelector('.flash-show');
  // …unless the user is in the middle of changing an option.
  if (!$('flash-options').contains(document.activeElement)) target?.focus();
}

function renderCounts() {
  const waiting = session.word ? [session.word, ...session.queue] : [];
  const { fresh, again, due } = tally(waiting, cards, dayNumber());
  el.counts.textContent = waiting.length ? `New ${fresh} · Again ${again} · Review ${due}` : '';
}

function wordFront(word) {
  return h(
    'div',
    { class: 'flash-card' },
    h('p', { class: 'flash-prompt' }, 'What does it mean?'),
    h('p', { class: 'flash-word' }, h('span', { lang: 'fr' }, word.word), speakButton(word.word)),
    h('button', { class: 'button primary flash-show', type: 'button', onclick: reveal }, 'Show answer'),
  );
}

function gapFront(word) {
  const input = h('input', {
    class: 'flash-input',
    type: 'text',
    lang: 'fr',
    autocomplete: 'off',
    autocapitalize: 'off',
    placeholder: 'Type it, or just think it',
    'aria-label': 'The missing word',
  });
  input.spellcheck = false;
  return h(
    'form',
    {
      class: 'flash-card',
      onsubmit: (event) => {
        event.preventDefault();
        reveal();
      },
    },
    h('p', { class: 'flash-prompt' }, 'Which word is missing?'),
    h(
      'p',
      { class: 'flash-line', lang: 'fr' },
      gapSegments(word).map((part) => (part.gap ? h('span', { class: 'gap' }, ' ') : part.text)),
    ),
    h('p', { class: 'flash-meaning' }, word.meaning),
    word.note && h('p', { class: 'note' }, word.note),
    h('p', { class: 'song' }, songLabel(word)),
    input,
    h('button', { class: 'button primary flash-show', type: 'submit' }, 'Show answer'),
  );
}

function cardBack(word) {
  const today = dayNumber();
  const verdicts = {
    right: 'Correct',
    accents: `Almost — check the accents. You typed “${session.typed}”.`,
    wrong: `Not quite. You typed “${session.typed}”.`,
  };
  return h(
    'div',
    { class: 'flash-card' },
    session.result && h('p', { class: `flash-result ${session.result}` }, verdicts[session.result]),
    h('p', { class: 'flash-word' }, h('span', { lang: 'fr' }, word.word), speakButton(word.word)),
    h('p', { class: 'flash-meaning' }, word.meaning),
    word.note && h('p', { class: 'note' }, word.note),
    word.also && h('p', { class: 'note' }, `also: ${word.also}`),
    h('p', { class: 'flash-line' }, markedLine(word), speakButton(word.line)),
    word.english
      ? h('p', { class: 'line-en' }, word.english)
      : h('button', { class: 'link translate', type: 'button', onclick: translate }, 'Translate line'),
    h('p', { class: 'song' }, songLabel(word)),
    h(
      'div',
      { class: 'ratings' },
      RATINGS.map(([rating, label]) =>
        h(
          'button',
          { class: 'button rate', type: 'button', dataset: { rating }, onclick: () => rate(rating) },
          label,
          h('small', {}, rating === AGAIN ? 'soon' : gapLabel(review(cards[word.key], rating, today).due - today)),
        ),
      ),
    ),
  );
}

function doneScreen() {
  const words = deck();
  if (!words.length) {
    return h(
      'div',
      { class: 'flash-card' },
      h('p', { class: 'flash-meaning' }, 'No words to practise yet.'),
      h('p', { class: 'note' }, 'Add words from a song first, or show more words with “Hide basics”.'),
    );
  }
  const today = dayNumber();
  const { fresh } = tally(words, cards, today);
  const upcoming = words.map((word) => cards[word.key]?.due).filter((due) => due > today);
  const next = Math.min(...upcoming);
  const nextCount = upcoming.filter((due) => due === next).length;
  const more = Math.min(fresh, prefs.newPerDay);
  const { answered } = session;
  return h(
    'div',
    { class: 'flash-card' },
    h('p', { class: 'flash-meaning' }, answered ? 'Done for now.' : 'Nothing is due right now.'),
    answered > 0 && h('p', { class: 'note' }, `${answered} ${answered === 1 ? 'answer' : 'answers'} this session.`),
    upcoming.length > 0 &&
      h('p', { class: 'note' }, `Next review: ${nextCount} ${nextCount === 1 ? 'card' : 'cards'} ${whenLabel(next - today)}.`),
    fresh > 0 && h('p', { class: 'note' }, `${fresh} new ${fresh === 1 ? 'word is' : 'words are'} waiting for another day.`),
    fresh > 0 &&
      h('button', { class: 'button flash-show', type: 'button', onclick: learnMore }, `Learn ${more} more now`),
  );
}

async function translate(event) {
  const button = event.currentTarget;
  const { word } = session;
  button.disabled = true;
  button.textContent = 'Translating…';
  try {
    setEnglish(word.line, await translateLine(word.line));
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Translate line';
    setStatus(el.status, error.message, 'error');
    return;
  }
  if (session.word === word && session.revealed) button.replaceWith(h('p', { class: 'line-en' }, word.english));
}

function renderVoices() {
  const voices = speech.frenchVoices();
  el.voiceRow.hidden = voices.length < 2;
  el.voice.replaceChildren(
    ...voices.map((voice) => h('option', { value: voice.voiceURI }, `${voice.name} (${voice.lang.replace('_', '-')})`)),
  );
  const current = speech.currentVoice();
  if (current) el.voice.value = current.voiceURI;
}

const songLabel = (word) => (word.artist ? `${word.song} — ${word.artist}` : word.song);

function gapLabel(days) {
  if (days < 31) return `${days} ${days === 1 ? 'day' : 'days'}`;
  if (days < 365) return `${Math.round(days / 30.4)} mo`;
  return '1 year';
}

const whenLabel = (days) => (days === 1 ? 'tomorrow' : `in ${gapLabel(days)}`);
