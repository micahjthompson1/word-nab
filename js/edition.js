// Which version of the app a page is.
//
// There are two, sharing all of the code:
//   fr — the original: French songs, meanings in English   (index.html)
//   en — for English learners: English songs, meanings in the learner's own
//        language                                          (english/index.html)
// A page picks its version with <html data-edition="…">. With nothing set
// (and under `node --test`) it is the French one.

import { english } from './lang-en.js';
import { frenchFunctions } from './functions-fr.js';
import { french } from './lang-fr.js';

/**
 * @typedef {object} Edition
 * @property {string} id
 * @property {string} learn     language of the songs and of the words collected
 * @property {object} rules     that language's spelling rules (lang-*.js)
 * @property {string[]} natives languages the meanings can be shown in; the first is the default
 * @property {string} storagePrefix  keeps each version's saved words apart in the browser
 * @property {(native: string) => string} wordList  the word-list file, relative to the site root
 * @property {{ list: { id: string, name: string, hint: string }[], classify: Function }|null} functions
 *   sorts words into lists by what they do in a song (expressive, narrate, …); null where not offered
 */

/** @type {Record<string, Edition>} */
const EDITIONS = {
  fr: {
    id: 'fr',
    learn: 'fr',
    rules: french,
    natives: ['en'],
    storagePrefix: 'wordnab.',
    wordList: () => 'data/words.fr.json',
    functions: frenchFunctions,
  },
  en: {
    id: 'en',
    learn: 'en',
    rules: english,
    natives: ['es', 'zh', 'ru'],
    storagePrefix: 'wordnab.en.',
    wordList: (native) => `data/words.en-${native}.json`,
    functions: null,
  },
};

export const EDITION = EDITIONS[globalThis.document?.documentElement.dataset.edition] ?? EDITIONS.fr;

/**
 * name    — the language in English, for the interface
 * ownName — as its speakers write it, for the language picker
 * tag     — for HTML lang attributes, so the browser picks the right font
 * speech  — the accent to prefer when reading aloud
 * memory  — the code the MyMemory translation service uses
 */
export const LANGUAGES = {
  en: { name: 'English', ownName: 'English', tag: 'en', speech: 'en-US', memory: 'en' },
  fr: { name: 'French', ownName: 'Français', tag: 'fr', speech: 'fr-FR', memory: 'fr' },
  es: { name: 'Spanish', ownName: 'Español', tag: 'es', speech: 'es-ES', memory: 'es' },
  zh: { name: 'Chinese', ownName: '中文', tag: 'zh-Hans', speech: 'zh-CN', memory: 'zh-CN' },
  ru: { name: 'Russian', ownName: 'Русский', tag: 'ru', speech: 'ru-RU', memory: 'ru' },
};

/** The language being learned on this page. */
export const LEARNING = LANGUAGES[EDITION.learn];
