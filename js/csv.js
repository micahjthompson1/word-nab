// CSV export of the word list.
//
// The first two columns keep the headers of the original export
// ("Common Word", "Translation"), so anything set up to import that file still
// lines up. The song and lyric follow as extra columns.

const HEADERS = ['Common Word', 'Translation', 'Song', 'Lyric', 'Lyric (English)'];

/**
 * @param {import('./words.js').SavedWord[]} words
 * @returns {string}
 */
export function toCsv(words) {
  const rows = words.map((w) => [
    w.word,
    w.meaning,
    w.artist ? `${w.song} - ${w.artist}` : w.song,
    w.line,
    w.english,
  ]);
  return [HEADERS, ...rows].map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

function cell(value) {
  let text = String(value ?? '');
  // Lyrics come from public sites. A cell starting with one of these would be
  // run as a formula by Excel or Google Sheets, so make it plain text.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
