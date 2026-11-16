// Shared page-building helpers.
//
// Song titles, lyrics and translations all come from outside services, so
// nothing in this app builds HTML from strings — every node is created with
// h(), which only ever sets text.

import { LEARNING } from './edition.js';
import * as speech from './speech.js';

/** Create an element. Strings become text nodes, never HTML. */
export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === false || value === null || value === undefined) continue;
    if (name === 'class') node.className = value;
    else if (name === 'dataset') Object.assign(node.dataset, value);
    else if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
    else if (name in node) node[name] = value;
    else node.setAttribute(name, value);
  }
  node.append(...children.flat().filter((child) => child !== false && child !== null && child !== undefined && child !== ''));
  return node;
}

export function setStatus(node, message, kind = '') {
  node.textContent = message;
  node.className = `status ${kind}`.trim();
}

/** A saved word's lyric line with the word itself highlighted. */
export function markedLine(word) {
  const { line, start, end } = word;
  return h('span', { lang: LEARNING.tag }, line.slice(0, start), h('mark', {}, line.slice(start, end)), line.slice(end));
}

/**
 * A speaker button that reads a word or lyric line aloud. The click itself is handled
 * once for the whole page (see app.js), so the button only carries the text.
 * @returns {HTMLButtonElement|null} null when the browser cannot speak
 */
export function speakButton(text) {
  if (!speech.supported) return null;
  return h('button', {
    class: 'speak',
    type: 'button',
    title: 'Listen',
    'aria-label': `Listen to “${text}”`,
    dataset: { speak: text },
  });
}
