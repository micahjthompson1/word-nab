// The saved word list. It lives in the browser's localStorage, so it is still
// there on the next visit without an account or a database.

import { load, save } from './storage.js';

const WORDS = 'words.v1';
const REMOVED = 'removed.v1';
const SONGS = 'songs.v1';
const MAX_SONGS = 1000;

/**
 * @typedef {object} SavedWord
 * @property {string} key      dictionary key; one entry per key
 * @property {string} word     the word as shown
 * @property {string} meaning  meaning in the reader's language
 * @property {string} note     grammar hint ("verb · from être · present")
 * @property {string} also     second reading, or ''
 * @property {number} rank     1 = most common word of the language
 * @property {string} song
 * @property {string} artist
 * @property {string} line     the lyric line the word was found in
 * @property {number} start    where the word sits in `line`
 * @property {number} end
 * @property {string} english  translation of `line` into the reader's language, or '' if not
 *   translated yet (named after the first version, which only translated into English)
 * @property {number} addedAt
 */

/** @type {SavedWord[]} */
let words = [];
// Words the user removed. They are not offered again when another song uses
// them — removing "je" once should be enough.
let removed = new Set();

// Songs whose words were already added, so the next visit only ticks new ones.
let songsDone = [];

{
  const storedSongs = load(SONGS, []);
  if (Array.isArray(storedSongs)) songsDone = storedSongs;
  const stored = load(WORDS, []);
  if (Array.isArray(stored)) words = stored.filter((w) => w && typeof w.key === 'string');
  const storedRemoved = load(REMOVED, []);
  if (Array.isArray(storedRemoved)) removed = new Set(storedRemoved);
}

function persist() {
  save(WORDS, words);
  save(REMOVED, [...removed]);
}

export function allWords() {
  return words;
}

export function removedCount() {
  return removed.size;
}

/**
 * Add words that are not already saved and were not removed earlier.
 * @param {Omit<SavedWord, 'addedAt'>[]} candidates
 * @param {number} addedAt  one timestamp per "Add words" press, so a batch sorts together
 * @returns {number} how many were added
 */
export function addWords(candidates, addedAt) {
  const have = new Set(words.map((w) => w.key));
  let added = 0;
  for (const candidate of candidates) {
    if (have.has(candidate.key) || removed.has(candidate.key)) continue;
    have.add(candidate.key);
    words.push({ ...candidate, addedAt });
    added++;
  }
  if (added) persist();
  return added;
}

/**
 * @returns {{ word: SavedWord, index: number }|null} what was removed, for undo
 */
export function removeWord(key) {
  const index = words.findIndex((w) => w.key === key);
  if (index === -1) return null;
  const [word] = words.splice(index, 1);
  removed.add(key);
  persist();
  return { word, index };
}

export function restoreWord({ word, index }) {
  if (words.some((w) => w.key === word.key)) return;
  words.splice(Math.min(index, words.length), 0, word);
  removed.delete(word.key);
  persist();
}

export function clearWords() {
  words = [];
  songsDone = [];
  save(SONGS, songsDone);
  persist();
}

const songKey = (track) => `${track.artist}|${track.title}`.toLowerCase();

/** Has this song already been through "Add words"? */
export function isSongDone(track) {
  return songsDone.includes(songKey(track));
}

export function markSongDone(track) {
  if (isSongDone(track)) return;
  songsDone.push(songKey(track));
  if (songsDone.length > MAX_SONGS) songsDone = songsDone.slice(-MAX_SONGS);
  save(SONGS, songsDone);
}

/** Let previously removed words be offered again. */
export function forgetRemoved() {
  removed = new Set();
  persist();
}

/**
 * Show every saved word in another language: look its meaning up again and
 * swap the lyric translations for the ones known in that language.
 * @param {(key: string) => { meaning: string, note: string, also: string }|null} lookup
 * @param {(line: string) => string|undefined} translationOf
 */
export function changeLanguage(lookup, translationOf) {
  for (const word of words) {
    const info = lookup(word.key);
    if (info) Object.assign(word, { meaning: info.meaning, note: info.note, also: info.also });
    word.english = translationOf(word.line) ?? '';
  }
  persist();
}

/** Record the translation of a lyric line on every word that uses it. */
export function setEnglish(line, english) {
  let changed = false;
  for (const word of words) {
    if (word.line === line && word.english !== english) {
      word.english = english;
      changed = true;
    }
  }
  if (changed) persist();
}
