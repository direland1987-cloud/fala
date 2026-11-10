// Adds the Phase 1 phrase bank to data/notebook.json as Planned phrases.
//
// Why: lessons now take new material from the notebook's Planned list, in
// order, one phrase at a time and only when recall is secure. Before this
// the list held two phrases, which left the tutor to improvise. The bank
// follows the six topics of the Phase 1 curriculum. Every entry can be
// edited or deleted in the Phrasebook; nothing here is marked as learned.
//
//   node scripts/add-phrase-bank.mjs          # dry run
//   node scripts/add-phrase-bank.mjs --write  # update data/notebook.json
//
// Safe to run twice: phrases whose id already exists are left alone.
import fs from 'node:fs';

const SOURCE = 'Phase 1 phrase bank, added 10 November 2026. Edit or remove freely.';
const BANK = [
  ['sim', 'Sim', 'Yes', 'Clarifying', 'Nasal ending, like “seeng” without the g.'],
  ['nao', 'Não', 'No', 'Clarifying', 'Nasal, close to “nowng”.'],
  [
    'boa-tarde',
    'Boa tarde',
    'Good afternoon',
    'Greetings',
    'TAR-jee: the final “de” sounds like “jee”.',
  ],
  ['de-nada', 'De nada', 'You’re welcome', 'Polite basics', 'jee NAH-da.'],
  ['prazer', 'Prazer', 'Nice to meet you', 'Introductions', 'pra-ZEHR, stress on the end.'],
  ['desculpa', 'Desculpa', 'Sorry', 'Polite basics', 'jees-KOOL-pa.'],
  [
    'nao-entendi',
    'Não entendi',
    'I didn’t understand',
    'Clarifying',
    'en-ten-JEE, stress on the end.',
  ],
  [
    'pode-repetir',
    'Pode repetir?',
    'Can you repeat that?',
    'Clarifying',
    'PAW-jee heh-peh-CHEER. The r at the start of “repetir” sounds like an h.',
  ],
  ['mais-devagar', 'Mais devagar, por favor', 'More slowly, please', 'Clarifying', 'jee-va-GAR.'],
  [
    'qual-seu-nome',
    'Qual é o seu nome?',
    'What’s your name?',
    'Introductions',
    'kwow EH oo SEH-oo NOH-mee.',
  ],
  [
    'de-onde-voce-e',
    'De onde você é?',
    'Where are you from?',
    'About me',
    'jee OHN-jee voh-SEH eh.',
  ],
  [
    'sou-da-australia',
    'Eu sou da Austrália',
    'I’m from Australia',
    'About me',
    'ow-STRAH-lee-a. Change the country if this is not right for you.',
  ],
  ['onde-voce-mora', 'Onde você mora?', 'Where do you live?', 'About me', 'MAW-ra.'],
  [
    'moro-na-australia',
    'Eu moro na Austrália',
    'I live in Australia',
    'About me',
    'MAW-roo. Change the place if this is not right for you.',
  ],
  [
    'quero-um-cafe',
    'Eu quero um café',
    'I want a coffee',
    'Wants and likes',
    'KEH-roo oong ka-FEH.',
  ],
  ['gosto-de-cafe', 'Eu gosto de café', 'I like coffee', 'Wants and likes', 'GAWS-too jee ka-FEH.'],
  ['nao-gosto', 'Eu não gosto', 'I don’t like it', 'Wants and likes', 'nowng GAWS-too.'],
  [
    'preciso-de-ajuda',
    'Eu preciso de ajuda',
    'I need help',
    'Wants and likes',
    'preh-SEE-zoo jee a-ZHOO-da.',
  ],
  [
    'voce-fala-ingles',
    'Você fala inglês?',
    'Do you speak English?',
    'Clarifying',
    'FAH-la een-GLEHS.',
  ],
  [
    'falo-um-pouco',
    'Eu falo um pouco de português',
    'I speak a little Portuguese',
    'About me',
    'POH-koo jee por-too-GEHS.',
  ],
  ['estou-feliz', 'Estou feliz', 'I’m happy', 'Social responses', 'feh-LEES.'],
  [
    'estou-com-fome',
    'Estou com fome',
    'I’m hungry',
    'Social responses',
    'kohng FOH-mee. Literally “I am with hunger”.',
  ],
  ['mais-ou-menos', 'Mais ou menos', 'So-so', 'Social responses', 'mah-eez oh MEH-noos.'],
  ['ate-logo', 'Até logo', 'See you later', 'Greetings', 'a-TEH LAW-goo.'],
  ['com-licenca', 'Com licença', 'Excuse me', 'Polite basics', 'kohng lee-SEN-sa.'],
  ['nao-sei', 'Eu não sei', 'I don’t know', 'Clarifying', 'nowng SAY.'],
];

const file = 'data/notebook.json';
const notebook = JSON.parse(fs.readFileSync(file, 'utf8'));
const have = new Set(notebook.phrases.map((p) => p.id));
const added = [];
for (const [id, pt, en, category, cue] of BANK) {
  if (have.has(id)) continue;
  notebook.phrases.push({
    id,
    pt,
    en,
    category,
    level: 'Planned',
    first: '',
    note: '',
    cue,
    source: SOURCE,
  });
  added.push(pt);
}
console.log(`${added.length} phrases to add: ${added.join(' · ') || 'none'}`);
console.log(
  `Planned after this: ${notebook.phrases.filter((p) => p.level === 'Planned').length} · taught: ${notebook.phrases.filter((p) => p.level !== 'Planned').length}`,
);
if (process.argv.includes('--write') && added.length) {
  notebook.updatedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(notebook, null, 2) + '\n');
  console.log('Wrote ' + file);
} else if (!process.argv.includes('--write')) console.log('Dry run. Add --write to save.');
