# wordNab

Pick up common words of a new language from the songs you play on Spotify.

wordNab lists your recently played songs, finds their lyrics, and pulls out the
common words. For each word it shows the meaning, the lyric line it was sung
in, and (on request) that line translated. You can hear each word and each
lyric line spoken, and practise the words with flashcards. Your word list is
saved in the browser and can be downloaded as a CSV.

## Two versions

| | For | Songs | Meanings in | Page |
| --- | --- | --- | --- | --- |
| **wordNab** | English speakers learning French | French | English | [`index.html`](index.html) |
| **wordNab English** | Multilingual learners of English | English | Spanish, Chinese (Mandarin, simplified) or Russian — the learner chooses | [`english/index.html`](english/index.html) |

They are two pages of the same site and share all of the code. Each keeps its
own word list, flashcard progress and Spotify sign-in, so using one never
changes the other. The differences between them are in
[`js/edition.js`](js/edition.js).

On the English page, **My language** (top right) sets the language of the
meanings and of the lyric translations. It can be changed at any time: the
saved words stay, and their meanings switch to the new language.

## How it works

The app is a static site: HTML, CSS and JavaScript files and one data file.
There is no server, database, queue or API key, so it costs nothing to host.

| Job | Old version (Flask on Render) | Now |
| --- | --- | --- |
| Hosting | Paid web service running Gunicorn | Any free static host |
| Spotify sign-in | Implicit grant (switched off by Spotify in Nov 2025) | Authorization Code with PKCE, in the browser |
| Lyrics | lyrics.ovh through a `/proxy` route | LRCLIB directly from the browser, lyrics.ovh as fallback |
| Common-word lookup | MySQL table, one query per song | `data/words.fr.json` (65 KB gzipped), loaded once |
| Language detection | Google Cloud Translation API | Counted locally from the lyrics |
| Line translation | Google Cloud Translation + Celery worker + Redis | On-device browser translator, or the free MyMemory API |
| Saved words | CSV download only | Kept in the browser, plus CSV download |
| Pronunciation | — | The browser's built-in voice |
| Flashcards | — | Spaced repetition in the browser |

## Run it on your computer

Needs [Node.js](https://nodejs.org) 22.13 or newer. Nothing to install.

```bash
node tools/serve.mjs
```

Then open <http://127.0.0.1:8000/> for the French version or
<http://127.0.0.1:8000/english/> for the English one. Use `127.0.0.1`, not
`localhost`: Spotify only accepts that form for local testing.

Run the tests with `npm test`.

## Spotify setup

Spotify sends people back to the app after sign-in, and only to addresses you
have registered.

1. Open the [Spotify developer dashboard](https://developer.spotify.com/dashboard) and select the app.
2. Under **Redirect URIs**, add the address of each page you use, with the trailing slash:
   - `http://127.0.0.1:8000/` and `http://127.0.0.1:8000/english/` for local testing
   - your live addresses, for example `https://micahjthompson1.github.io/word-nab/`
     and `https://micahjthompson1.github.io/word-nab/english/`
3. Save.

Both pages use the same Spotify app and client ID; each just needs its own
redirect address.

The client ID lives in [`js/config.js`](js/config.js). It is a public
identifier, not a secret; this sign-in flow has no client secret.

Two Spotify rules to know about (both from 2026):

- While the app is in **development mode**, the account that owns it needs
  Spotify Premium, and only accounts listed under **User Management** can sign in.
- If sign-in is not possible, the **find any song** box works without Spotify.

## Put it online for free

**GitHub Pages**

1. Merge this branch into `main` and push.
2. In the repository on GitHub: **Settings → Pages → Deploy from a branch → `main` / root**.
3. Add `https://<your-username>.github.io/word-nab/` and
   `https://<your-username>.github.io/word-nab/english/` to the Spotify redirect URIs.

**Render static site** (keeps the `wordnab.onrender.com` address)

1. Delete the old web service first so the name is free.
2. **New → Static Site**, pick this repository, leave the build command empty and set the publish directory to `.`.
3. Name it `wordnab`. The redirect URI `https://wordnab.onrender.com/` is the one the old app used;
   the English page is then at `https://wordnab.onrender.com/english/`.

## Things to switch off

The old version needed these; the new one uses none of them:

- Render web service and Celery background worker
- Redis instance
- MySQL database (`DB_CONNECTION_STRING`)
- Google Cloud Translation API and its service-account key

## The word lists

### French

`data/words.fr.json` holds 3,164 French word forms that occur at least 20
times per million words in films and books — the same cutoff as the old
`common_words_fr_freq20` table. Each has an English meaning, its dictionary
form and, for verbs, the tense.

It is generated by [`tools/build-dictionary.mjs`](tools/build-dictionary.mjs)
and committed, so you only need to rebuild it to change the cutoff:

```bash
node tools/build-dictionary.mjs --min-freq 10
```

The first run downloads the two source datasets (about 50 MB) into
`tools/.cache/`. Meanings for the commonest grammar words are hand-written in
[`tools/overrides.mjs`](tools/overrides.mjs); add to that file if a meaning
looks wrong.

### English

`data/words.en-es.json`, `words.en-zh.json` and `words.en-ru.json` hold the same
4,242 English word forms — those used at least 10 times per million words in
film subtitles — with meanings in Spanish, Chinese and Russian. Each form
points at its dictionary word (*went* → *go*, *children* → *child*) and says
which form it is. Only the list for the chosen language is downloaded (about
100 KB).

Lyrics are full of contractions and clipped spellings, so the app opens them
up before looking words up: *don't* → *do* + *not*, *I'm* → *I* + *am*,
*lovin'* → *loving*, *'cause* → *because* ([`js/lang-en.js`](js/lang-en.js)).

The lists are generated by
[`tools/build-dictionary-en.mjs`](tools/build-dictionary-en.mjs) and committed:

```bash
node tools/build-dictionary-en.mjs --min-freq 20
```

The first run downloads its sources (about 110 MB) into `tools/.cache/`. Add
`--review` to print the words worth checking by hand.

Meanings come from Wiktionary (Spanish, Russian) and ECDICT (Chinese), picked
automatically. The commonest words — the small grammar words, and words with
many senses such as *get* and *run* — are written by hand in
[`tools/overrides-en.mjs`](tools/overrides-en.mjs): about 670 entries, which
cover nearly 1,000 of the 4,242 forms. That is the file to edit when a meaning
looks wrong; then rebuild.

To add another language for the meanings, give the builder a source for it,
list it under `natives` in [`js/edition.js`](js/edition.js), and add a column to
the overrides.

## Pronunciation

The speaker button next to a word or a lyric line reads it aloud with the
browser's built-in speech synthesis. That keeps it free: there are no audio
files to host and no text-to-speech service to pay for, and with a voice
installed on the device it works offline.

The app picks the best voice it finds for the language being learned (French,
or American English); you can choose another under
**Flashcards → Options and help → Voice**.

## Flashcards

**Flashcards** opens a practice session on the words in your list (minus any
hidden by "Hide basics"). It combines the methods with the best evidence
behind them:

- **Recall before you look.** Each card asks a question and waits. Trying to
  remember, even when you fail, fixes a word far better than re-reading it.
- **Spaced repetition.** After each card you say how it went — Again, Hard,
  Good or Easy — and the word is scheduled to return just before you are
  likely to forget it: in a day or two at first, then weeks, then months. The
  scheduler is [FSRS-6](https://github.com/open-spaced-repetition/awesome-fsrs/wiki/The-Algorithm),
  from the open FSRS family built into Anki, with its default settings and a
  90% recall target. It is in [`js/srs.js`](js/srs.js).
- **A few new words a day** (5, 10 or 20), commonest first, mixed in with the
  reviews. A word you miss comes back a few cards later in the same session.
- **Both directions, in context.** A word is first shown on its own for you to
  recall the meaning. Once you know it, it also appears as a gap in its lyric
  line, to be recalled (and typed, if you like) from its meaning.
  Producing a word is harder than recognising it and makes the memory stronger.
- **Sound.** The word is read aloud when its card appears, and the lyric
  line when a gap card is answered.

Progress is saved in the browser with the word list. "Clear list" resets it.

## Limits

- **Meanings are for the dictionary form.** *yeux* is listed under *œil*,
  *suis* under *être*. A word with two readings shows the likelier one first.
- **English meanings beyond the commonest words are picked automatically** and
  have not all been read by a person. Expect the occasional odd choice — a
  rare synonym, or the wrong sense of a word with several. The interface and
  the grammar notes ("verb · from go · past") are in English in both versions.
- **Line translation** uses the browser's built-in translator where there is
  one (Chrome on a computer). Elsewhere it uses MyMemory, which allows roughly
  5,000 characters a day per visitor — a few hundred lyric lines.
- **Your word list and flashcard progress stay in one browser.** Clearing site
  data deletes them, and they do not sync between devices. Download the CSV to
  keep a copy of the words.
- **Voices depend on the device.** Phones, Macs, Chrome and Edge usually come
  with French and English voices. Where one is missing (for example a French
  voice in Firefox on a Windows PC set up in English) the app says so; add the
  voice in the system's speech settings. A word read on its own can also be ambiguous — *est* is "is" or
  "east" — so the lyric line is the better guide to how it sounds in use.
- **Lyrics are crowd-sourced.** Some songs are missing, and some transcriptions
  have typos.

## Credits

- Lyrics: [LRCLIB](https://lrclib.net) and [lyrics.ovh](https://lyrics.ovh)
- Line translation fallback: [MyMemory](https://mymemory.translated.net)
- French word list: frequencies from [Lexique 3.83](https://www.lexique.org)
  (CC BY-SA 4.0); meanings from [WikDict](https://www.wikdict.com), from
  Wiktionary (CC BY-SA 3.0)
- English word lists:
  - frequencies from [FrequencyWords](https://github.com/hermitdave/FrequencyWords),
    counted from OpenSubtitles 2018 (CC BY-SA 4.0)
  - word forms from the AGID inflection list in
    [SCOWL](https://github.com/en-wl/wordlist) (© Kevin Atkinson, free to use
    and distribute)
  - Spanish and Russian meanings from [WikDict](https://www.wikdict.com), from
    Wiktionary (CC BY-SA 3.0)
  - Chinese meanings from [ECDICT](https://github.com/skywind3000/ECDICT) (MIT)

The code is MIT licensed (see `LICENSE`). The files in `data/` are derived
from the datasets above and are shared under CC BY-SA 4.0.
