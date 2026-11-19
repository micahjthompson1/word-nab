// Sorting French words by what they do in a song — their language function.
//
//   expressive — feelings          j'aime, je regrette, tu me manques
//   narrate    — telling a story   past tenses, d'abord, puis, ensuite, enfin
//   describe   — painting a scene  adjectives (and their agreement: beau, belle)
//   directive  — telling someone   imperatives: viens, reste, regarde
//   phatic     — keeping in touch  salut, allez, ah bon
//
// A word can do several jobs ("seul" is a feeling and a description), and some
// only do a job in context: "viens" is an order in "Viens avec moi" but not in
// "Tu viens ?", and "allez" is a greeting-like push in "Allez, on y va" but a
// plain verb in "Vous allez partir". So each use of a word is judged with its
// lyric line. Pure functions with no browser APIs.

export const FUNCTIONS = [
  {
    id: 'expressive',
    name: 'Expressive',
    hint: 'Feelings — j’aime, je regrette, tu me manques. Chanson and pop are full of them.',
  },
  {
    id: 'narrate',
    name: 'Narrate',
    hint: 'Telling a story — past tenses (passé composé, imparfait) and time words for putting events in order: d’abord, puis, ensuite, enfin.',
  },
  {
    id: 'describe',
    name: 'Describe',
    hint: 'Painting a picture — adjectives. Watch how they agree: beau, belle, beaux.',
  },
  {
    id: 'directive',
    name: 'Directive',
    hint: 'Commands and invitations — imperatives: viens, reste, regarde, dis-moi.',
  },
  {
    id: 'phatic',
    name: 'Phatic',
    hint: 'Greetings and interjections that keep a conversation going — salut, allez, ah bon.',
  },
];

const words = (list) => new Set(list.trim().split(/\s+/));

// Dictionary forms (lemmas) whose meaning is a feeling.
const FEELINGS = words(`
  aimer adorer détester haïr regretter manquer pleurer souffrir rêver espérer craindre
  embrasser oublier mourir sourire rire désespérer consoler blesser briser trembler
  amour cœur âme peur joie tristesse larme douleur peine chagrin bonheur malheur envie
  espoir désir passion colère honte solitude tendresse baiser souvenir rêve cri regret
  haine jalousie plaisir ennui caresse sanglot blessure
  triste heureux malheureux seul fou jaloux fier désolé content amoureux tendre doux
  fidèle perdu
  hélas ô
`);

// Words that put events in order or in time.
const TIME_WORDS = words(`
  d'abord puis ensuite enfin alors hier avant après soudain longtemps autrefois jadis
  lorsque quand depuis finalement aujourd'hui demain déjà pendant bientôt
`);

// Adjectives that work more like "the", "some" or "other" than like a description.
const NOT_DESCRIPTIVE = words('autre tel quel certain même nul quelque ok quoi');

// Greetings, thanks, yes/no and interjections — phatic wherever they occur.
const PHATIC = words(`
  salut bonjour bonsoir merci coucou adieu bienvenue oui non ouais ok okay hein eh hé oh
  ah bah ben euh heu allô bravo pardon voilà ciao
`);

// Phatic only when they stand apart from the sentence: "Allez, viens",
// "Bon !", "Tiens, te voilà", "Ah bon ?", "Écoute, …".
const PHATIC_APART = words('allez bon tiens dis écoute écoutez voyons enfin alors bien attends regarde');

// Phatic only after these words: "au revoir", "s'il te plaît", "d'accord".
const PHATIC_AFTER = { revoir: ['au'], plaît: ['te', 'vous'], accord: ['de', "d'"] };

const OBJECTS = words("ne n' me m' te t' se s' le la les l' lui leur y en nous vous");
// Words that can start a clause without stopping what follows from being an
// order or a greeting: "Et viens", "Oh reste", "Allez, danse".
const OPENERS = words('et mais ou alors puis oh ah eh hé allez bon tiens ô oui non ouais hey');
const AUXILIARIES = words(`
  ai as a avons avez ont suis es est sommes êtes sont
  avais avait avions aviez avaient étais était étions étiez étaient
`);
// Pronouns that can follow an imperative with a hyphen ("dis-moi", "allons-y").
const AFTER_IMPERATIVE = words('moi toi le la les lui leur y en nous vous');

const TOKEN = /\p{L}+'?/gu;
const fold = (text) => text.toLowerCase().replace(/[’‘ʼ]/g, "'");

/** The words between the start of the clause and `start`, in order. */
function clauseBefore(line, start) {
  const before = fold(line.slice(0, start));
  const clause = before.slice(Math.max(...[...'.,;:!?…—–«»"()'].map((mark) => before.lastIndexOf(mark))) + 1);
  return clause.match(TOKEN) ?? [];
}

/** Does the clause before the word hold nothing but openers, "ne" and object pronouns? */
function startsClause(before, word) {
  let i = before.length;
  while (i > 0 && OBJECTS.has(before[i - 1])) {
    const pronoun = before[i - 1];
    // "nous allons", "vous venez": a subject, not an object.
    if ((pronoun === 'nous' && word.endsWith('ons')) || (pronoun === 'vous' && word.endsWith('ez'))) return false;
    i--;
  }
  while (i > 0 && OPENERS.has(before[i - 1])) i--;
  return i === 0;
}

// Stands on its own: after the start of a clause (or another interjection)
// and before a pause or the end of the line.
function standsApart(line, start, end, before) {
  const after = line.slice(end).trimStart();
  const pauseAfter = after === '' || /^[,!?.…;:—–)»"]/.test(after) || PHATIC.has(fold(after).match(TOKEN)?.[0]);
  return pauseAfter && before.every((word) => OPENERS.has(word) || PHATIC.has(word));
}

// Present-tense forms that can be an imperative: 2nd person singular
// ("viens", "regarde", "va"), 1st plural ("allons") and 2nd plural ("venez").
// Not 3rd person ("vient", "regardent"), nor "-es" of -er verbs ("regardes").
const NO_IMPERATIVE = words('être avoir pouvoir vouloir devoir falloir valoir pleuvoir');
const IMPERATIVE_OF_BE = words('sois soyons soyez aie ayons ayez');

function looksImperative(word, reading) {
  if (IMPERATIVE_OF_BE.has(word)) return true;
  if (reading.pos !== 'verb' || NO_IMPERATIVE.has(reading.lemma)) return false;
  if (reading.form === 'imperative') return true;
  if (reading.form !== 'present') return false;
  if (word.endsWith('ons') || word.endsWith('ez')) return true;
  if (/(ent|t|x|ai|as)$/.test(word)) return false;
  if (word.endsWith('a')) return word === 'va';
  if (word.endsWith('es') && reading.lemma.endsWith('er')) return false;
  return true;
}

function isDirective(word, readings, line, start, end, before) {
  const verb = readings.find((reading) => reading.pos === 'verb') ?? { pos: '' };
  if (!looksImperative(word, verb)) return false;
  // "Dis-moi", "regarde-moi", "allons-y" — but not "allons-nous ?" or "va-t-il".
  const hyphen = fold(line.slice(end)).match(/^-(\p{L}+)/u)?.[1];
  if (hyphen) {
    if (!AFTER_IMPERATIVE.has(hyphen)) return false;
    return !((hyphen === 'nous' && word.endsWith('ons')) || (hyphen === 'vous' && word.endsWith('ez')));
  }
  if (/^\s*-?\s*(tu|je|il|elle|on)\b/u.test(fold(line.slice(end)))) return false;
  return startsClause(before, word);
}

/**
 * The jobs one use of a word does in its lyric line.
 * @param {string} key  the word's dictionary key
 * @param {{ lemma: string, pos: string, form: string|null }[]} readings
 *   its readings from the word list, likeliest first
 * @param {string} line
 * @param {number} start  where the word sits in `line`
 * @param {number} end
 * @returns {string[]}  ids from FUNCTIONS, in that order
 */
export function classify(key, readings, line, start, end) {
  const [main] = readings;
  if (!main) return [];
  const word = fold(line.slice(start, end));
  const before = clauseBefore(line, start);
  const lemmas = readings.map((reading) => reading.lemma.toLowerCase());
  const found = new Set();

  if (lemmas.some((lemma) => FEELINGS.has(lemma)) || FEELINGS.has(key)) found.add('expressive');

  if (TIME_WORDS.has(key)) found.add('narrate');
  if (main.pos === 'verb') {
    if (['imperfect', 'simple past', 'past participle'].includes(main.form)) found.add('narrate');
    // "il m'a dit", "je suis parti": a past participle after avoir or être.
    else if (main.form !== 'infinitive' && AUXILIARIES.has(before.findLast((w) => !['pas', 'jamais', 'plus', 'rien', 'tout', 'bien', 'déjà'].includes(w)) ?? '')) {
      found.add('narrate');
    }
  }

  if (isDirective(word, readings, line, start, end, before)) found.add('directive');

  const apart = PHATIC_APART.has(key) && standsApart(line, start, end, before);
  const phatic =
    PHATIC.has(key) ||
    (main.pos === 'interj' && !FEELINGS.has(key)) ||
    apart ||
    (key === 'quoi' && /,\s*$/.test(line.slice(0, start)) && standsApart(line, start, end, [])) ||
    (PHATIC_AFTER[key]?.includes(before.at(-1)) ?? false);
  if (phatic) found.add('phatic');

  // "Ah bon !" is a reaction, not a description.
  const adjective = main.pos === 'adj' || (main.pos === 'noun' && readings[1]?.pos === 'adj');
  if (adjective && !apart && !NOT_DESCRIPTIVE.has(main.lemma)) found.add('describe');

  return FUNCTIONS.map((f) => f.id).filter((id) => found.has(id));
}

export const frenchFunctions = { list: FUNCTIONS, classify };
