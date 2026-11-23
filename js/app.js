// The page itself: wires the buttons to the modules and draws the two lists.

import { CONFIG } from './config.js';
import { toCsv } from './csv.js';
import { loadDictionary } from './dictionary.js';
import { h, markedLine, setStatus, speakButton } from './dom.js';
import { EDITION, LANGUAGES, LEARNING } from './edition.js';
import * as flashcards from './flashcards.js';
import { fetchLyrics, searchSongs } from './lyrics.js';
import { catalogueLines, compileCatalogue, findPhrases, phraseKey, phraseText, tokens } from './phrases.js';
import * as speech from './speech.js';
import * as spotify from './spotify.js';
import { load, save } from './storage.js';
import { LANGUAGE_NAMES, cleanLines, detectLanguage, extractWords, wordsInLine } from './text.js';
import { TranslationQuotaError, cachedTranslation, translateLine } from './translate.js';
import * as wordList from './words.js';

// A song counts as being in the language learned (and is ticked
// automatically) when at least this share of its recognisable words are in
// it. Low enough to catch songs that switch between two languages.
const LEARNING_SHARE = 0.3;
const SWIPE_DELETE_PX = 90;

const $ = (id) => document.getElementById(id);
const el = {
  account: $('account'),
  native: $('native'), // only on pages that offer a choice of language
  songsStatus: $('songs-status'),
  tracks: $('tracks'),
  addWords: $('add-words'),
  songSearch: $('song-search'),
  songQuery: $('song-query'),
  wordCount: $('word-count'),
  sort: $('sort'),
  kind: $('kind'), // words / phrases; only on pages that offer phrases
  hide: $('hide'),
  flashcardsOpen: $('flashcards-open'),
  translateAll: $('translate-all'),
  downloadCsv: $('download-csv'),
  copyPhrases: $('copy-phrases'), // only on pages that offer phrases
  clearWords: $('clear-words'),
  wordsStatus: $('words-status'),
  lists: $('lists'), // only on pages that sort words by language function
  listHint: $('list-hint'),
  wordTable: $('word-table'),
  words: $('words'),
  wordsEmpty: $('words-empty'),
  removedNote: $('removed-note'),
  toast: $('toast'),
  lyrics: $('lyrics'), // the lyrics dialog, for picking phrases by hand
  lyricsSong: $('lyrics-song'),
  lyricLines: $('lyric-lines'),
  picker: $('phrase-picker'),
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
  // `native` is the language the meanings are shown in.
  // `list` is the language-function list being shown ('all', 'other' or a FUNCTIONS id).
  // `kind` is 'all', 'words' or 'phrases'.
  prefs: { sort: 'recent', hide: 0, list: 'all', kind: 'all', native: defaultNative(), ...load('prefs.v1', {}) },
  loadRun: 0, // bumped on every refresh so a slow, older load cannot overwrite a newer one
  translatingAll: false,
};

// The built-in phrases, ready for matching (French version only).
const CATALOGUE = EDITION.phrases ? compileCatalogue(EDITION.phrases, EDITION.rules) : null;

// Names of the word lists by language function (French version only), by id.
const LIST_NAMES = Object.fromEntries((EDITION.functions?.list ?? []).map((f) => [f.id, f.name]));

start();

async function start() {
  // Spotify only accepts http://127.0.0.1 for local testing, never "localhost".
  if (window.location.hostname === 'localhost') {
    window.location.replace(window.location.href.replace('//localhost', '//127.0.0.1'));
    return;
  }

  if (!EDITION.natives.includes(state.prefs.native)) state.prefs.native = defaultNative();
  if (!listIds().includes(state.prefs.list)) state.prefs.list = 'all';
  if (!CATALOGUE || !['all', 'words', 'phrases'].includes(state.prefs.kind)) state.prefs.kind = 'all';
  if (el.kind) el.kind.value = state.prefs.kind;
  el.sort.value = state.prefs.sort;
  el.hide.value = String(state.prefs.hide);
  renderNativePicker();
  bindEvents();
  flashcards.init({ deck: shownWords, native: () => state.prefs.native, onClose: renderWords });
  renderWords();
  renderTracks();
  sortSavedWords();

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
  el.kind?.addEventListener('change', () => updatePrefs({ kind: el.kind.value }));
  el.tracks.addEventListener('click', onTrackClick);
  if (el.lyrics) bindLyrics();
  el.translateAll.addEventListener('click', translateAllLines);
  el.downloadCsv.addEventListener('click', downloadCsv);
  el.copyPhrases?.addEventListener('click', copyPhrasesForCode);
  el.clearWords.addEventListener('click', clearWords);
  el.words.addEventListener('click', onWordClick);
  el.flashcardsOpen.addEventListener('click', flashcards.open);
  el.native?.addEventListener('change', () => changeNative(el.native.value));
  el.lists?.addEventListener('click', onListClick);
  document.addEventListener('click', onSpeakClick);
  enableSwipeToDelete(el.words);
}

// ---------------------------------------------------------------------------
// The reader's own language

// On a first visit, go by the browser's languages; otherwise the first on offer.
function defaultNative() {
  const preferred = (navigator.languages ?? []).map((tag) => tag.slice(0, 2).toLowerCase());
  return preferred.find((code) => EDITION.natives.includes(code)) ?? EDITION.natives[0];
}

function renderNativePicker() {
  if (!el.native) return;
  el.native.replaceChildren(
    ...EDITION.natives.map((code) => h('option', { value: code, lang: LANGUAGES[code].tag }, LANGUAGES[code].ownName)),
  );
  el.native.value = state.prefs.native;
}

// Show the saved words in another language. Their meanings come from that
// language's word list; lyric lines keep any translation already made in it.
async function changeNative(native) {
  let dictionary;
  try {
    dictionary = await loadDictionary(native);
  } catch (error) {
    el.native.value = state.prefs.native;
    setStatus(el.wordsStatus, error.message, 'error');
    return;
  }
  state.translatingAll = false; // a run in the old language stops at its next line
  wordList.changeLanguage(dictionary.get, (line) => cachedTranslation(line, native));
  setStatus(el.wordsStatus, '');
  updatePrefs({ native });
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
  // Tick songs in the language being learned, except ones whose words were
  // added on an earlier visit.
  track.selected = isLearnable(track) && !wordList.isSongDone(track);
}

function isLearnable(track) {
  return (track.language?.shares[EDITION.learn] ?? 0) >= LEARNING_SHARE;
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
    // Outside the label, so pressing it does not tick the song.
    CATALOGUE &&
      usable &&
      h('button', { class: 'button quiet lyrics-open', type: 'button', title: 'Read the lyrics and pick phrases' }, 'Lyrics'),
  );
}

function onTrackClick(event) {
  if (!event.target.closest('.lyrics-open')) return;
  const row = event.target.closest('.track');
  const track = row && state.tracks.find((t) => t.id === row.dataset.id);
  if (track) openLyrics(track);
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
    .filter((code) => code !== primary && shares[code] >= LEARNING_SHARE)
    .sort((a, b) => shares[b] - shares[a])[0];
  const text = [primary, second].filter(Boolean).map((code) => LANGUAGE_NAMES[code]).join(' + ');
  if (wordList.isSongDone(track)) return { kind: 'done', text: `${text} · added` };
  return { kind: isLearnable(track) ? 'match' : 'other', text };
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
    dictionary = await loadDictionary(state.prefs.native);
  } catch (error) {
    setStatus(el.wordsStatus, error.message, 'error');
    return;
  }

  const now = Date.now();
  let added = 0;
  let phrasesAdded = 0;
  for (const track of tracks) {
    if (CATALOGUE) {
      phrasesAdded += wordList.addWords(
        findPhrases(track.lyrics.text, CATALOGUE, EDITION.rules).map((hit) =>
          phraseItem(CATALOGUE.byKey.get(hit.key), track, hit.line, hit.start, hit.end, dictionary),
        ),
        now,
      );
    }
    const found = extractWords(track.lyrics.text, dictionary.has, EDITION.rules, tagger(dictionary));
    added += wordList.addWords(
      found.map((hit) => {
        const info = dictionary.get(hit.key);
        return {
          key: hit.key,
          word: info.spelling ?? hit.display,
          meaning: info.meaning,
          note: info.note,
          also: info.also,
          rank: info.rank,
          song: track.title,
          artist: track.artist,
          line: hit.line,
          start: hit.start,
          end: hit.end,
          english: cachedTranslation(hit.line, state.prefs.native) ?? '',
          ...(EDITION.functions && { functions: hit.tags }),
        };
      }),
      now,
    );
    track.selected = false;
    wordList.markSongDone(track);
  }

  const songs = `${tracks.length} ${tracks.length === 1 ? 'song' : 'songs'}`;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const what = [added && plural(added, 'new word', 'new words'), phrasesAdded && plural(phrasesAdded, 'phrase', 'phrases')]
    .filter(Boolean)
    .join(' and ');
  setStatus(
    el.wordsStatus,
    added || phrasesAdded
      ? `Added ${what} from ${songs}.`
      : `Nothing new in ${tracks.length === 1 ? 'that song' : 'those songs'} — every common word is already in your list or was removed by you.`,
  );
  renderTracks();
  renderWords();
  if (added || phrasesAdded) $('words-heading').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function updatePrefs(change) {
  Object.assign(state.prefs, change);
  save('prefs.v1', state.prefs);
  renderWords();
}

/**
 * The saved words in the chosen list, minus those hidden by "Hide basics" —
 * also what the flashcards practise.
 */
function shownWords() {
  return wordList.allWords().filter((word) => isShown(word) && inList(word, state.prefs.list));
}

/** Passes "Hide basics" and the words / phrases choice. */
function isShown(word) {
  if (state.prefs.kind === 'words' && word.kind === 'phrase') return false;
  if (state.prefs.kind === 'phrases' && word.kind !== 'phrase') return false;
  return word.rank > state.prefs.hide;
}

// ---------------------------------------------------------------------------
// Phrases (French version only): built-in expressions found in the songs, and
// stretches of a lyric the learner picks by hand.

/**
 * A phrase ready to save.
 * @param {{ phrase?: string, meaning?: string, literally?: string, lists?: string[] }|undefined} entry
 *   the built-in phrase, or undefined for one picked by hand
 */
function phraseItem(entry, track, line, start, end, dictionary, picked = null) {
  const text = entry?.phrase ?? phraseText(line, start, end);
  // As common as its rarest word, so "Hide basics" and "Most common first" place it sensibly.
  const ranks = wordsInLine(line.slice(start, end), dictionary.has, EDITION.rules).map((hit) => dictionary.get(hit.key).rank);
  return {
    key: phraseKey(text, EDITION.rules),
    kind: 'phrase',
    word: text,
    meaning: picked?.meaning || entry?.meaning || '',
    note: ['phrase', entry?.literally && `literally “${entry.literally}”`, picked && 'picked by you'].filter(Boolean).join(' · '),
    also: '',
    rank: ranks.length ? Math.max(...ranks) : 3000,
    song: track.title,
    artist: track.artist,
    line,
    start,
    end,
    english: cachedTranslation(line, state.prefs.native) ?? '',
    functions: picked?.functions ?? entry?.lists ?? [],
    ...(picked && { picked: true }),
  };
}

// The lyrics dialog. Tap the first and last word of a phrase to pick it.
const pick = { track: null, lines: [], line: -1, from: -1, to: -1, anchor: -1, lists: new Set(), entry: null };

function bindLyrics() {
  $('lyrics-close').addEventListener('click', () => el.lyrics.close());
  el.lyricLines.addEventListener('click', onLyricClick);
  el.picker.addEventListener('click', onPickerClick);
  el.picker.addEventListener('submit', savePickedPhrase);
  el.lyrics.addEventListener('close', () => {
    setStatus($('pick-status'), '');
    renderWords();
  });
}

const LYRICS_HELP = 'Tap the first and the last word of a phrase to pick it. Underlined phrases are in the built-in list and are saved with the song’s words.';
const LINE_HELP = 'The whole line is picked. Save it as it is, or tap the first and the last word of a shorter phrase.';

/**
 * @param {{ title: string, artist: string }} track
 * @param {string[]} lines  the lyrics to pick from
 * @param {boolean} [wholeLine]  start with the whole of the first line picked
 */
function openLyrics(track, lines = cleanLines(track.lyrics.text), wholeLine = false) {
  pick.track = track;
  pick.lines = lines;
  clearPick();
  el.lyricsSong.textContent = track.artist ? `${track.title} — ${track.artist}` : track.title;
  el.lyricLines.replaceChildren(...pick.lines.map(lyricLine));
  $('lyrics-help').textContent = wholeLine ? LINE_HELP : LYRICS_HELP;
  setStatus($('pick-status'), '');
  el.lyrics.showModal();
  el.lyricLines.scrollTop = 0;
  const words = tokens(lines[0] ?? '', EDITION.rules);
  if (wholeLine && words.length) {
    Object.assign(pick, { line: 0, from: 0, to: words.length - 1, anchor: -1 });
    suggestLists();
    renderPick();
  }
}

/** Save a saved word's lyric line, or part of it, as a phrase. */
function openSavedLine(key) {
  const word = wordList.allWords().find((w) => w.key === key);
  if (word) openLyrics({ title: word.song, artist: word.artist }, [word.line], true);
}

// One lyric line with every word as a button. Built-in phrases are underlined.
function lyricLine(line, index) {
  const words = tokens(line, EDITION.rules);
  const known = new Set();
  for (const hit of findPhrases(line, CATALOGUE, EDITION.rules)) {
    words.forEach((word, i) => word.start >= hit.start && word.end <= hit.end && known.add(i));
  }
  const parts = [];
  let position = 0;
  words.forEach((word, i) => {
    // "j'ai" is tapped as one word: an elision joins the word after it.
    if (word.start < position) return;
    let last = i;
    while (line[words[last].end - 1] === "'" || line[words[last].end - 1] === '’') {
      if (!words[last + 1] || words[last + 1].start !== words[last].end) break;
      last++;
    }
    if (word.start > position) parts.push(line.slice(position, word.start));
    parts.push(
      h(
        'button',
        { class: `lw${known.has(i) ? ' known' : ''}`, type: 'button', dataset: { from: i, to: last } },
        line.slice(word.start, words[last].end),
      ),
    );
    position = words[last].end;
  });
  if (position < line.length) parts.push(line.slice(position));
  return h('p', { class: 'lyric-line', lang: LEARNING.tag, dataset: { line: index } }, ...parts);
}

function onLyricClick(event) {
  const button = event.target.closest('.lw');
  if (!button) return;
  const line = Number(button.closest('.lyric-line').dataset.line);
  const from = Number(button.dataset.from);
  const to = Number(button.dataset.to);
  if (line !== pick.line || pick.anchor === -1) {
    Object.assign(pick, { line, from, to, anchor: from });
  } else if (pick.from === from && pick.to === to) {
    clearPick(); // tapping the only picked word again lets go of it
    return;
  } else {
    Object.assign(pick, { from: Math.min(pick.anchor, from), to: Math.max(pick.anchor, to) });
    pick.anchor = -1; // the next tap starts a new phrase
  }
  suggestLists();
  renderPick();
}

function clearPick() {
  Object.assign(pick, { line: -1, from: -1, to: -1, anchor: -1, entry: null });
  pick.lists = new Set();
  renderPick();
}

/** Where the picked phrase sits in its line. */
function pickedSpan() {
  const line = pick.lines[pick.line];
  const words = tokens(line, EDITION.rules);
  return { line, start: words[pick.from].start, end: words[pick.to].end };
}

// Start the list choices from what the phrase's words do, or from the
// built-in list when the phrase is one of its expressions.
async function suggestLists() {
  const { line, start, end } = pickedSpan();
  const key = phraseKey(line.slice(start, end), EDITION.rules);
  pick.entry = CATALOGUE.byKey.get(key) ?? null;
  if (pick.entry) {
    pick.lists = new Set(pick.entry.lists);
    return;
  }
  pick.lists = new Set();
  const dictionary = await loadDictionary(state.prefs.native).catch(() => null);
  if (!dictionary || pick.line === -1 || pickedSpan().start !== start) return;
  for (const hit of wordsInLine(line, dictionary.has, EDITION.rules)) {
    if (hit.start < start || hit.end > end) continue;
    const readings = dictionary.get(hit.key).readings;
    EDITION.functions.classify(hit.key, readings, line, hit.start, hit.end).forEach((id) => pick.lists.add(id));
  }
  renderPick();
}

function renderPick() {
  el.lyricLines.querySelectorAll('.lw').forEach((button) => {
    const line = Number(button.closest('.lyric-line').dataset.line);
    const picked = line === pick.line && Number(button.dataset.from) >= pick.from && Number(button.dataset.to) <= pick.to;
    button.classList.toggle('picked', picked);
    button.setAttribute('aria-pressed', String(picked));
  });
  el.picker.hidden = pick.line === -1;
  if (pick.line === -1) return;
  const { line, start, end } = pickedSpan();
  const text = phraseText(line, start, end);
  const key = phraseKey(text, EDITION.rules);
  const saved = wordList.hasWord(key);
  $('pick-text').textContent = text;
  $('pick-hint').textContent = pick.anchor !== -1 ? 'Tap another word in this line to make it a longer phrase.' : '';
  $('pick-lists').replaceChildren(
    ...EDITION.functions.list.map((f) =>
      h(
        'button',
        { class: `tag tag-${f.id} pick-list`, type: 'button', dataset: { list: f.id }, 'aria-pressed': String(pick.lists.has(f.id)) },
        f.name,
      ),
    ),
  );
  const meaning = $('pick-meaning');
  meaning.placeholder = pick.entry ? pick.entry.meaning : 'Meaning (optional: translated for you if left empty)';
  const save = $('pick-save');
  save.disabled = saved;
  save.textContent = saved ? 'In your list' : 'Save phrase';
}

function onPickerClick(event) {
  const chip = event.target.closest('.pick-list');
  if (chip) {
    const { list } = chip.dataset;
    if (pick.lists.has(list)) pick.lists.delete(list);
    else pick.lists.add(list);
    chip.setAttribute('aria-pressed', String(pick.lists.has(list)));
  } else if (event.target.closest('#pick-cancel')) {
    clearPick();
  }
}

async function savePickedPhrase(event) {
  event.preventDefault();
  if (pick.line === -1) return;
  const status = $('pick-status');
  let dictionary;
  try {
    dictionary = await loadDictionary(state.prefs.native);
  } catch (error) {
    setStatus(status, error.message, 'error');
    return;
  }
  const { line, start, end } = pickedSpan();
  const meaningInput = $('pick-meaning');
  const typed = meaningInput.value.trim();
  const functions = EDITION.functions.list.map((f) => f.id).filter((id) => pick.lists.has(id));
  const item = phraseItem(pick.entry ?? undefined, pick.track, line, start, end, dictionary, { meaning: typed, functions });
  wordList.unremove(item.key);
  wordList.addWords([item], Date.now());
  meaningInput.value = '';
  const where = functions.length ? ` to ${functions.map((id) => LIST_NAMES[id]).join(', ')}` : '';
  setStatus(status, `Saved “${item.word}”${where}.`);
  clearPick();
  if (!item.meaning) translateMeaning(item.key, status);
}

/** Fill in a picked phrase's meaning by translating it. */
async function translateMeaning(key, status = el.wordsStatus) {
  const item = wordList.allWords().find((w) => w.key === key);
  if (!item) return;
  const { native } = state.prefs;
  try {
    const meaning = await translateLine(item.word, native);
    if (native !== state.prefs.native) return;
    wordList.updateWord(key, { meaning });
  } catch (error) {
    setStatus(status, `Saved, but the meaning could not be translated: ${error.message}`, 'warn');
  }
  renderWords();
}

// ---------------------------------------------------------------------------
// Lists by language function (French version only): what a word does in a
// song — expresses a feeling, tells a story, describes, gives an order, or
// keeps the conversation going. A word can be in several lists.

function listIds() {
  return EDITION.functions ? ['all', ...EDITION.functions.list.map((f) => f.id), 'other'] : ['all'];
}

function inList(word, list) {
  if (list === 'all') return true;
  const functions = word.functions ?? [];
  return list === 'other' ? functions.length === 0 : functions.includes(list);
}

/** extractWords' tagger: what one use of a word does in its line. */
function tagger(dictionary) {
  if (!EDITION.functions) return undefined;
  return (hit, line) => EDITION.functions.classify(hit.key, dictionary.get(hit.key)?.readings ?? [], line, hit.start, hit.end);
}

// Words saved before the lists existed are sorted from the line they were saved with.
async function sortSavedWords() {
  if (!EDITION.functions || wordList.allWords().every((word) => Array.isArray(word.functions))) return;
  let dictionary;
  try {
    dictionary = await loadDictionary(state.prefs.native);
  } catch {
    return; // tried again on the next visit
  }
  const tag = tagger(dictionary);
  const sorted = wordList.sortUnsorted((word) => (dictionary.has(word.key) ? tag(word, word.line) : null));
  if (sorted) renderWords();
}

function onListClick(event) {
  const button = event.target.closest('[data-list]');
  if (button) updatePrefs({ list: button.dataset.list });
}

function renderLists() {
  if (!el.lists) return;
  const total = wordList.allWords().length;
  el.lists.hidden = total === 0;
  el.listHint.hidden = true;
  if (!total) return;
  const basics = wordList.allWords().filter(isShown);
  const name = (id) => ({ all: 'All', other: 'Other' })[id] ?? LIST_NAMES[id];
  el.lists.replaceChildren(
    ...listIds().map((id) =>
      h(
        'button',
        { class: 'list-tab', type: 'button', dataset: { list: id }, 'aria-pressed': String(id === state.prefs.list) },
        name(id),
        h('span', { class: 'list-count' }, String(basics.filter((word) => inList(word, id)).length)),
      ),
    ),
  );
  const hint =
    state.prefs.list === 'other'
      ? 'Words and phrases that are not in any of the five lists: mostly nouns and the small grammar words.'
      : EDITION.functions.list.find((f) => f.id === state.prefs.list)?.hint;
  el.listHint.hidden = !hint;
  el.listHint.textContent = hint ?? '';
}

/** The shown words in the chosen order — what the list and the CSV show. */
function visibleWords() {
  const words = shownWords();
  const alphabet = new Intl.Collator(EDITION.learn);
  const order = {
    recent: (a, b) => b.addedAt - a.addedAt,
    alpha: (a, b) => alphabet.compare(a.word, b.word),
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
  renderLists();
  const listName = LIST_NAMES[state.prefs.list] ?? (state.prefs.list === 'other' ? 'Other' : '');
  if (total && !words.length && state.prefs.list !== 'all') {
    el.wordsEmpty.textContent = `Nothing in the ${listName} list yet${state.prefs.hide || state.prefs.kind !== 'all' ? ' with these settings' : ''}.`;
  } else if (total && !words.length) {
    el.wordsEmpty.textContent = `All ${total} saved words are hidden by “Hide basics”.`;
  } else if (!total) {
    el.wordsEmpty.replaceChildren('No words yet. Tick some songs above and press ', h('strong', {}, 'Add words'), '.');
  }
  el.wordCount.textContent = total ? (words.length === total ? `${total}` : `${words.length} of ${total}`) : '';

  const untranslated = words.some((word) => !word.english);
  el.translateAll.disabled = !untranslated && !state.translatingAll;
  el.downloadCsv.disabled = words.length === 0;
  if (el.copyPhrases) el.copyPhrases.hidden = !newPickedPhrases().length;
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
  // Marking the language lets the browser pick the right font (Chinese above all).
  const own = LANGUAGES[state.prefs.native].tag;
  return h(
    'li',
    { class: word.kind === 'phrase' ? 'word phrase' : 'word', dataset: { key: word.key } },
    h('div', { class: 'word-fr' }, h('span', { lang: LEARNING.tag }, word.word), speakButton(word.word)),
    h(
      'div',
      { class: 'word-meaning' },
      word.meaning
        ? h('span', { class: 'meaning', lang: own }, word.meaning)
        : h('button', { class: 'link translate-meaning', type: 'button' }, 'Translate phrase'),
      word.note && h('span', { class: 'note' }, word.note),
      word.also && h('span', { class: 'note' }, 'also: ', h('span', { lang: own }, word.also)),
      word.functions?.length > 0 &&
        h(
          'span',
          { class: 'tags' },
          word.functions.map((id) =>
            h('button', { class: `tag tag-${id}`, type: 'button', title: `Show the ${LIST_NAMES[id]} list`, dataset: { list: id } }, LIST_NAMES[id]),
          ),
        ),
    ),
    h(
      'div',
      { class: 'word-context' },
      h('p', { class: 'line-fr' }, markedLine(word), speakButton(word.line)),
      word.english
        ? h('p', { class: 'line-en', lang: own }, word.english)
        : h('button', { class: 'link translate', type: 'button' }, 'Translate line'),
      h('p', { class: 'song' }, word.artist ? `${word.song} — ${word.artist}` : word.song),
      CATALOGUE &&
        word.kind !== 'phrase' &&
        h('button', { class: 'link save-phrase', type: 'button', title: 'Save this lyric, or part of it, as a phrase' }, 'Save lyric as phrase'),
    ),
    h('button', { class: 'remove', type: 'button', 'aria-label': `Remove ${word.word}`, title: 'Remove' }, '×'),
  );
}

function onWordClick(event) {
  const row = event.target.closest('.word');
  if (!row) return;
  const tag = event.target.closest('.tag');
  if (tag) {
    updatePrefs({ list: tag.dataset.list });
    $('words-heading').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else if (event.target.closest('.save-phrase')) {
    openSavedLine(row.dataset.key);
  } else if (event.target.closest('.translate-meaning')) {
    const button = event.target.closest('.translate-meaning');
    button.disabled = true;
    button.textContent = 'Translating…';
    translateMeaning(row.dataset.key);
  } else if (event.target.closest('.remove')) removeWord(row);
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
  if (outcome === 'no-voice' && !warnedNoVoice) {
    warnedNoVoice = true;
    const status = button.closest('dialog')?.querySelector('.status') ?? el.wordsStatus;
    setStatus(
      status,
      `This device has no ${LEARNING.name} voice installed, so words may be read with the wrong accent. You can add one in your system’s speech settings.`,
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
  const { native } = state.prefs;
  try {
    const translated = await translateLine(word.line, native);
    if (native !== state.prefs.native) return; // the language was changed while waiting
    wordList.setEnglish(word.line, translated);
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
  const { native } = state.prefs;
  let done = 0;
  let failure = null;
  for (const line of lines) {
    if (!state.translatingAll) break;
    el.translateAll.textContent = `Stop (${done} of ${lines.length})`;
    try {
      const translated = await translateLine(line, native);
      if (native !== state.prefs.native) break; // the language was changed while waiting
      wordList.setEnglish(line, translated);
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
  const blob = new Blob(['﻿', toCsv(words, LANGUAGES[state.prefs.native].name, EDITION.functions && LIST_NAMES)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: 'word-data.csv' });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// Phrases picked by hand that are not yet in the built-in list.
function newPickedPhrases() {
  if (!CATALOGUE) return [];
  return catalogueLines(wordList.allWords().filter((word) => word.kind === 'phrase' && word.picked), CATALOGUE);
}

// Copies the hand-picked phrases as lines to paste into phrases-fr.js, so they
// can be added to the built-in list for everyone. Downloads them as a file
// where the browser does not allow copying.
async function copyPhrasesForCode() {
  const lines = newPickedPhrases();
  if (!lines.length) return;
  const text = `${lines.join('\n')}\n`;
  const count = `${lines.length} ${lines.length === 1 ? 'phrase' : 'phrases'}`;
  try {
    await navigator.clipboard.writeText(text);
    setStatus(el.wordsStatus, `Copied ${count}. Paste them into js/phrases-fr.js under the right heading.`);
  } catch {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const link = h('a', { href: url, download: 'new-phrases.txt' });
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setStatus(el.wordsStatus, `Copying is blocked here, so ${count} were downloaded as new-phrases.txt instead.`);
  }
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
