// The page itself: wires the buttons to the modules and draws the two lists.

import { CONFIG } from './config.js';
import { toCsv } from './csv.js';
import { loadDictionary } from './dictionary.js';
import { h, markedLine, setStatus, speakButton } from './dom.js';
import * as flashcards from './flashcards.js';
import { fetchLyrics, searchSongs } from './lyrics.js';
import * as speech from './speech.js';
import * as spotify from './spotify.js';
import { load, save } from './storage.js';
import { LANGUAGE_NAMES, detectLanguage, extractWords } from './text.js';
import { TranslationQuotaError, cachedTranslation, translateLine } from './translate.js';
import * as wordList from './words.js';

// A song counts as French (and is ticked automatically) when at least this
// share of its recognisable words are French. Low enough to catch songs that
// switch between French and English.
const FRENCH_SHARE = 0.3;
const SWIPE_DELETE_PX = 90;

const $ = (id) => document.getElementById(id);
const el = {
  account: $('account'),
  songsStatus: $('songs-status'),
  tracks: $('tracks'),
  addWords: $('add-words'),
  songSearch: $('song-search'),
  songQuery: $('song-query'),
  wordCount: $('word-count'),
  sort: $('sort'),
  hide: $('hide'),
  flashcardsOpen: $('flashcards-open'),
  translateAll: $('translate-all'),
  downloadCsv: $('download-csv'),
  clearWords: $('clear-words'),
  wordsStatus: $('words-status'),
  wordTable: $('word-table'),
  words: $('words'),
  wordsEmpty: $('words-empty'),
  removedNote: $('removed-note'),
  toast: $('toast'),
};

/**
 * @typedef {object} Track
 * @property {string} id
 * @property {string} title
 * @property {string} artist
 * @property {string} [album]
 * @property {number} [durationMs]
 * @property {string} [image]
 * @property {boolean} [manual]   added through the search box, not Spotify
 * @property {{ status: string, text: string }|null} lyrics   null while loading
 * @property {{ primary: string|null, shares: Record<string, number> }|null} language
 * @property {boolean} selected
 */

const state = {
  /** @type {Track[]} */
  tracks: [],
  prefs: { sort: 'recent', hide: 0, ...load('prefs.v1', {}) },
  loadRun: 0, // bumped on every refresh so a slow, older load cannot overwrite a newer one
  translatingAll: false,
};

start();

async function start() {
  // Spotify only accepts http://127.0.0.1 for local testing, never "localhost".
  if (window.location.hostname === 'localhost') {
    window.location.replace(window.location.href.replace('//localhost', '//127.0.0.1'));
    return;
  }

  el.sort.value = state.prefs.sort;
  el.hide.value = String(state.prefs.hide);
  bindEvents();
  flashcards.init({ deck: shownWords, onClose: renderWords });
  renderWords();
  renderTracks();

  try {
    await spotify.completeLogin();
  } catch (error) {
    setStatus(el.songsStatus, error.message, 'error');
  }
  renderAccount();
  if (spotify.isConnected()) loadRecentTracks();
}

function bindEvents() {
  el.addWords.addEventListener('click', addSelectedWords);
  el.songSearch.addEventListener('submit', onSongSearch);
  el.tracks.addEventListener('change', onTrackToggle);

  el.sort.addEventListener('change', () => updatePrefs({ sort: el.sort.value }));
  el.hide.addEventListener('change', () => updatePrefs({ hide: Number(el.hide.value) }));
  el.translateAll.addEventListener('click', translateAllLines);
  el.downloadCsv.addEventListener('click', downloadCsv);
  el.clearWords.addEventListener('click', clearWords);
  el.words.addEventListener('click', onWordClick);
  el.flashcardsOpen.addEventListener('click', flashcards.open);
  document.addEventListener('click', onSpeakClick);
  enableSwipeToDelete(el.words);
}

// ---------------------------------------------------------------------------
// Spotify account

function renderAccount() {
  if (spotify.isConnected()) {
    el.account.replaceChildren(
      h('button', { class: 'button', type: 'button', onclick: loadRecentTracks }, 'Refresh songs'),
      h('button', { class: 'button quiet', type: 'button', onclick: disconnect }, 'Disconnect'),
    );
  } else {
    el.account.replaceChildren(
      h('button', { class: 'button spotify', type: 'button', onclick: connect }, 'Connect Spotify'),
    );
  }
}

async function connect() {
  try {
    await spotify.beginLogin();
  } catch (error) {
    setStatus(el.songsStatus, error.message, 'error');
  }
}

function disconnect() {
  spotify.disconnect();
  state.loadRun++;
  state.tracks = state.tracks.filter((track) => track.manual);
  renderAccount();
  renderTracks();
}

// ---------------------------------------------------------------------------
// Songs

async function loadRecentTracks() {
  const run = ++state.loadRun;
  setStatus(el.songsStatus, 'Loading your recent songs…');
  let recent;
  try {
    recent = await spotify.fetchRecentTracks();
  } catch (error) {
    if (run !== state.loadRun) return;
    if (error instanceof spotify.SpotifyAuthError) renderAccount();
    setStatus(el.songsStatus, error.message, 'error');
    renderTracks();
    return;
  }
  if (run !== state.loadRun) return;

  const manual = state.tracks.filter((track) => track.manual);
  state.tracks = [...manual, ...recent.map((track) => ({ ...track, lyrics: null, language: null, selected: false }))];
  setStatus(el.songsStatus, recent.length ? '' : 'Spotify has no recently played songs for this account yet.');
  renderTracks();
  await loadLyrics(run);
}

// Look up lyrics for every track that has none yet, a few at a time.
async function loadLyrics(run) {
  const queue = state.tracks.filter((track) => !track.lyrics);
  const worker = async () => {
    for (let track = queue.shift(); track; track = queue.shift()) {
      const lyrics = await fetchLyrics(track);
      if (run !== state.loadRun) return;
      applyLyrics(track, lyrics);
      updateTrackRow(track);
      updateAddButton();
    }
  };
  await Promise.all(Array.from({ length: CONFIG.lyricsConcurrency }, worker));
}

function applyLyrics(track, lyrics) {
  track.lyrics = lyrics;
  track.language = lyrics.status === 'found' ? detectLanguage(lyrics.text) : null;
  // Tick French songs, except ones whose words were added on an earlier visit.
  track.selected = hasFrench(track) && !wordList.isSongDone(track);
}

function hasFrench(track) {
  return (track.language?.shares.fr ?? 0) >= FRENCH_SHARE;
}

async function onSongSearch(event) {
  event.preventDefault();
  const query = el.songQuery.value.trim();
  if (!query) return;
  setStatus(el.songsStatus, `Looking for “${query}”…`);
  let songs;
  try {
    songs = await searchSongs(query);
  } catch {
    setStatus(el.songsStatus, 'The lyrics service could not be reached. Try again in a moment.', 'error');
    return;
  }
  const known = new Set(state.tracks.map((track) => track.id));
  const fresh = songs.filter((song) => !known.has(song.id));
  if (!songs.length) {
    setStatus(el.songsStatus, `No lyrics found for “${query}”. Try the title and the artist together.`, 'error');
    return;
  }
  const found = fresh.map((song, index) => {
    const track = { ...song, manual: true, lyrics: null, language: null, selected: false };
    applyLyrics(track, song.lyrics);
    // Only the best match is ticked; the rest are there in case it is the wrong one.
    track.selected &&= index === 0;
    return track;
  });
  state.tracks.unshift(...found);
  el.songQuery.value = '';
  setStatus(el.songsStatus, '');
  renderTracks();
}

function onTrackToggle(event) {
  const row = event.target.closest('.track');
  const track = row && state.tracks.find((t) => t.id === row.dataset.id);
  if (!track) return;
  track.selected = event.target.checked;
  updateAddButton();
}

function renderTracks() {
  if (!state.tracks.length && !spotify.isConnected() && !el.songsStatus.textContent) {
    setStatus(el.songsStatus, 'Connect Spotify to list the songs you played recently, or find a song by name below.');
  }
  el.tracks.replaceChildren(...state.tracks.map(trackRow));
  updateAddButton();
}

function updateTrackRow(track) {
  const old = el.tracks.querySelector(`[data-id="${CSS.escape(track.id)}"]`);
  if (old) old.replaceWith(trackRow(track));
}

function trackRow(track) {
  const usable = track.lyrics?.status === 'found';
  const badge = trackBadge(track);
  return h(
    'li',
    { class: 'track', dataset: { id: track.id } },
    h(
      'label',
      {},
      h('input', { type: 'checkbox', checked: usable && track.selected, disabled: !usable }),
      track.image
        ? h('img', { class: 'cover', src: track.image, alt: '', width: 40, height: 40, loading: 'lazy' })
        : h('span', { class: 'cover placeholder', 'aria-hidden': 'true' }, '♪'),
      h(
        'span',
        { class: 'track-text' },
        h('span', { class: 'track-title' }, track.title),
        h('span', { class: 'track-artist' }, track.artist),
      ),
      h('span', { class: `badge ${badge.kind}` }, badge.text),
    ),
  );
}

function trackBadge(track) {
  if (!track.lyrics) return { kind: 'pending', text: 'Finding lyrics…' };
  switch (track.lyrics.status) {
    case 'instrumental':
      return { kind: 'none', text: 'Instrumental' };
    case 'missing':
      return { kind: 'none', text: 'No lyrics found' };
    case 'unavailable':
      return { kind: 'none', text: 'Lyrics service unreachable' };
  }
  const { primary, shares } = track.language;
  if (!primary) return { kind: 'other', text: 'Lyrics found' };
  // Name a second language when it makes up a real part of the song.
  const second = Object.keys(shares)
    .filter((code) => code !== primary && shares[code] >= FRENCH_SHARE)
    .sort((a, b) => shares[b] - shares[a])[0];
  const text = [primary, second].filter(Boolean).map((code) => LANGUAGE_NAMES[code]).join(' + ');
  if (wordList.isSongDone(track)) return { kind: 'done', text: `${text} · added` };
  return { kind: hasFrench(track) ? 'french' : 'other', text };
}

function selectedTracks() {
  return state.tracks.filter((track) => track.selected && track.lyrics?.status === 'found');
}

function updateAddButton() {
  const count = selectedTracks().length;
  el.addWords.disabled = count === 0;
  el.addWords.textContent = count ? `Add words from ${count} ${count === 1 ? 'song' : 'songs'}` : 'Add words';
}

// ---------------------------------------------------------------------------
// Words

async function addSelectedWords() {
  const tracks = selectedTracks();
  if (!tracks.length) return;
  let dictionary;
  try {
    dictionary = await loadDictionary();
  } catch (error) {
    setStatus(el.wordsStatus, error.message, 'error');
    return;
  }

  const now = Date.now();
  let added = 0;
  for (const track of tracks) {
    const found = extractWords(track.lyrics.text, dictionary.has);
    added += wordList.addWords(
      found.map((hit) => {
        const info = dictionary.get(hit.key);
        return {
          key: hit.key,
          word: hit.display,
          meaning: info.meaning,
          note: info.note,
          also: info.also,
          rank: info.rank,
          song: track.title,
          artist: track.artist,
          line: hit.line,
          start: hit.start,
          end: hit.end,
          english: cachedTranslation(hit.line) ?? '',
        };
      }),
      now,
    );
    track.selected = false;
    wordList.markSongDone(track);
  }

  const songs = `${tracks.length} ${tracks.length === 1 ? 'song' : 'songs'}`;
  setStatus(
    el.wordsStatus,
    added
      ? `Added ${added} new ${added === 1 ? 'word' : 'words'} from ${songs}.`
      : `Nothing new in ${tracks.length === 1 ? 'that song' : 'those songs'} — every common word is already in your list or was removed by you.`,
  );
  renderTracks();
  renderWords();
  if (added) $('words-heading').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function updatePrefs(change) {
  Object.assign(state.prefs, change);
  save('prefs.v1', state.prefs);
  renderWords();
}

/** The saved words minus those hidden by "Hide basics" — also what the flashcards practise. */
function shownWords() {
  return wordList.allWords().filter((word) => word.rank > state.prefs.hide);
}

/** The shown words in the chosen order — what the list and the CSV show. */
function visibleWords() {
  const words = shownWords();
  const french = new Intl.Collator('fr');
  const order = {
    recent: (a, b) => b.addedAt - a.addedAt,
    alpha: (a, b) => french.compare(a.word, b.word),
    common: (a, b) => a.rank - b.rank,
    rare: (a, b) => b.rank - a.rank,
  }[state.prefs.sort];
  // Array.prototype.sort is stable, so "newest first" keeps each song's words
  // in the order they are sung.
  return words.sort(order);
}

function renderWords() {
  const total = wordList.allWords().length;
  const words = visibleWords();
  el.words.replaceChildren(...words.map(wordRow));
  el.wordTable.hidden = words.length === 0;
  el.wordsEmpty.hidden = words.length > 0;
  if (total && !words.length) {
    el.wordsEmpty.textContent = `All ${total} saved words are hidden by “Hide basics”.`;
  } else if (!total) {
    el.wordsEmpty.replaceChildren('No words yet. Tick some songs above and press ', h('strong', {}, 'Add words'), '.');
  }
  el.wordCount.textContent = total ? (words.length === total ? `${total}` : `${words.length} of ${total}`) : '';

  const untranslated = words.some((word) => !word.english);
  el.translateAll.disabled = !untranslated && !state.translatingAll;
  el.downloadCsv.disabled = words.length === 0;
  const waiting = flashcards.waitingCount();
  el.flashcardsOpen.disabled = words.length === 0;
  el.flashcardsOpen.textContent = waiting ? `Flashcards (${waiting})` : 'Flashcards';
  el.clearWords.disabled = total === 0;

  const removed = wordList.removedCount();
  el.removedNote.hidden = removed === 0;
  if (removed) {
    el.removedNote.replaceChildren(
      `${removed} removed ${removed === 1 ? 'word is' : 'words are'} skipped when you add songs. `,
      h('button', { class: 'link', type: 'button', onclick: forgetRemoved }, 'Offer them again'),
    );
  }
}

function wordRow(word) {
  return h(
    'li',
    { class: 'word', dataset: { key: word.key } },
    h('div', { class: 'word-fr' }, h('span', { lang: 'fr' }, word.word), speakButton(word.word)),
    h(
      'div',
      { class: 'word-meaning' },
      h('span', { class: 'meaning' }, word.meaning),
      word.note && h('span', { class: 'note' }, word.note),
      word.also && h('span', { class: 'note' }, `also: ${word.also}`),
    ),
    h(
      'div',
      { class: 'word-context' },
      h('p', { class: 'line-fr' }, markedLine(word), speakButton(word.line)),
      word.english
        ? h('p', { class: 'line-en' }, word.english)
        : h('button', { class: 'link translate', type: 'button' }, 'Translate line'),
      h('p', { class: 'song' }, word.artist ? `${word.song} — ${word.artist}` : word.song),
    ),
    h('button', { class: 'remove', type: 'button', 'aria-label': `Remove ${word.word}`, title: 'Remove' }, '×'),
  );
}

function onWordClick(event) {
  const row = event.target.closest('.word');
  if (!row) return;
  if (event.target.closest('.remove')) removeWord(row);
  else if (event.target.closest('.translate')) translateRow(row, event.target.closest('.translate'));
}

// Every speaker button on the page, in the list or on a flashcard, lands here.
let warnedNoVoice = false;
function onSpeakClick(event) {
  const button = event.target.closest('.speak');
  if (!button) return;
  if (button.classList.contains('speaking')) {
    speech.stop();
    return;
  }
  button.classList.add('speaking');
  const outcome = speech.speak(button.dataset.speak, () => button.classList.remove('speaking'));
  if (outcome === 'no-french-voice' && !warnedNoVoice) {
    warnedNoVoice = true;
    const status = button.closest('dialog')?.querySelector('.status') ?? el.wordsStatus;
    setStatus(
      status,
      'This device has no French voice installed, so words may be read with the wrong accent. You can add one in your system’s speech settings.',
      'warn',
    );
  }
}

function removeWord(row) {
  const undo = wordList.removeWord(row.dataset.key);
  if (!undo) return;
  row.classList.add('leaving');
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    renderWords();
  };
  row.addEventListener('transitionend', finish, { once: true });
  setTimeout(finish, 350); // in case the transition never fires (reduced motion)
  showToast(`Removed “${undo.word.word}”.`, 'Undo', () => {
    wordList.restoreWord(undo);
    renderWords();
  });
}

function forgetRemoved() {
  wordList.forgetRemoved();
  renderWords();
}

function clearWords() {
  const total = wordList.allWords().length;
  if (!window.confirm(`Clear all ${total} saved words and their flashcard progress? This cannot be undone.`)) return;
  wordList.clearWords();
  flashcards.reset();
  setStatus(el.wordsStatus, '');
  renderTracks(); // songs are no longer marked "added"
  renderWords();
}

async function translateRow(row, button) {
  const word = wordList.allWords().find((w) => w.key === row.dataset.key);
  if (!word) return;
  button.disabled = true;
  button.textContent = 'Translating…';
  try {
    wordList.setEnglish(word.line, await translateLine(word.line));
    setStatus(el.wordsStatus, '');
    renderWords();
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Translate line';
    setStatus(el.wordsStatus, error.message, 'error');
  }
}

// Translate every visible line that has no translation yet, one at a time.
// Pressing the button again stops it.
async function translateAllLines() {
  if (state.translatingAll) {
    state.translatingAll = false;
    return;
  }
  const lines = [...new Set(visibleWords().filter((word) => !word.english).map((word) => word.line))];
  if (!lines.length) return;
  state.translatingAll = true;
  let done = 0;
  let failure = null;
  for (const line of lines) {
    if (!state.translatingAll) break;
    el.translateAll.textContent = `Stop (${done} of ${lines.length})`;
    try {
      wordList.setEnglish(line, await translateLine(line));
      done++;
    } catch (error) {
      failure = error;
      break;
    }
    // Refresh now and then so progress is visible without redrawing per line.
    if (done % 10 === 0) renderWords();
  }
  state.translatingAll = false;
  el.translateAll.textContent = 'Translate all lines';
  renderWords();
  if (failure) {
    const prefix = done ? `Translated ${done} of ${lines.length} lines. ` : '';
    setStatus(el.wordsStatus, prefix + failure.message, failure instanceof TranslationQuotaError ? 'warn' : 'error');
  } else {
    const outOf = done < lines.length ? ` of ${lines.length}` : '';
    setStatus(el.wordsStatus, `Translated ${done}${outOf} ${lines.length === 1 ? 'line' : 'lines'}.`);
  }
}

function downloadCsv() {
  const words = visibleWords();
  if (!words.length) return;
  // The BOM makes Excel read the accents correctly.
  const blob = new Blob(['﻿', toCsv(words)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: 'word-data.csv' });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// Swipe a row left to remove it (touch screens). Desktop uses the × button.
function enableSwipeToDelete(list) {
  let swipe = null;

  list.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'touch') return;
    const row = event.target.closest('.word');
    if (row) swipe = { row, x: event.clientX, y: event.clientY, dx: 0, active: false };
  });

  list.addEventListener('pointermove', (event) => {
    if (!swipe) return;
    const dx = event.clientX - swipe.x;
    const dy = event.clientY - swipe.y;
    if (!swipe.active) {
      if (Math.abs(dx) < 12 || Math.abs(dx) < Math.abs(dy)) return;
      swipe.active = true;
      swipe.row.classList.add('swiping');
    }
    swipe.dx = Math.min(0, dx);
    swipe.row.style.transform = `translateX(${swipe.dx}px)`;
    swipe.row.classList.toggle('will-delete', swipe.dx < -SWIPE_DELETE_PX);
  });

  const end = (event) => {
    if (!swipe) return;
    const { row, dx, active } = swipe;
    swipe = null;
    if (!active) return;
    row.classList.remove('swiping', 'will-delete');
    row.style.transform = '';
    // "pointercancel" means the browser took the gesture over (to scroll):
    // snap back, never delete.
    if (event.type === 'pointerup' && dx < -SWIPE_DELETE_PX) removeWord(row);
  };
  list.addEventListener('pointerup', end);
  list.addEventListener('pointercancel', end);
}

// ---------------------------------------------------------------------------
// Small helpers

let toastTimer;
function showToast(message, actionLabel, action) {
  clearTimeout(toastTimer);
  const hide = () => {
    el.toast.hidden = true;
  };
  el.toast.replaceChildren(
    h('span', {}, message),
    h(
      'button',
      {
        class: 'link',
        type: 'button',
        onclick: () => {
          hide();
          action();
        },
      },
      actionLabel,
    ),
  );
  el.toast.hidden = false;
  toastTimer = setTimeout(hide, 6000);
}
