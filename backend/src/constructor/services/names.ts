/**
 * 🖋 «В ОСОБІ ДИРЕКТОРА …» — ПІБ У РОДОВОМУ ВІДМІНКУ І «ЯКИЙ/ЯКА ДІЄ» ЗА РОДОМ (задача 5461, 13.10.2026).
 *
 * Як у генераторах документів (1С/BAS, сервіси договорів): ПІБ зберігається в НАЗИВНОМУ, рід — за по батькові,
 * родовий будується автоматично, людина може його виправити руками. Рід не визначився (ініціали, нетипове
 * по батькові) — 🟡 і перемикач Ч/Ж у формі; до вибору — чоловічий.
 *
 * Відмінює бібліотека shevchenko.js (MIT, `vendor/shevchenko.min.cjs` — самодостатній UMD-бандл 0,7 МБ; npm-пакет
 * тягне TensorFlow на 293 МБ, тому НЕ залежність). Заміряно 13.10.2026 на 81 унікальному ПІБ директорів з архіву,
 * довідника й кешу ЄДР: рід визначився у 69 (85%), з 12 решти 9 — ініціали.
 *
 * 🔴 Рахується ОДИН раз — на вході прев'ю/формування — і пишеться в `cp.dirGen`/`cp.dirFem`, які їдуть в архів
 * разом зі станом. Тому збірка PDF/Word лишається синхронною, а документ з архіву перегенеровується з ТИМ текстом,
 * з яким його видали (старі записи без `dirGen` — як і були, у називному).
 */
import { createRequire } from 'node:module';
import type { DocumentState } from './docgen.js';
import type { Issue } from '../validate.js';

type Gender = 'masculine' | 'feminine';
interface Anthroponym { familyName?: string; givenName?: string; patronymicName?: string }
interface Shevchenko {
  detectGender(a: Anthroponym): Promise<Gender | null>;
  inGenitive(a: Anthroponym & { gender: Gender }): Promise<Anthroponym>;
}
let lib: Shevchenko | null = null;
const shev = (): Shevchenko => (lib ??= createRequire(import.meta.url)('../vendor/shevchenko.min.cjs') as Shevchenko);

/** «Іванов І.І.», «Іванов І. І.», «Іванов І.» — прізвище й ініціали. */
const INITIALS = /^(\S+)\s+((?:[А-ЯІЇЄҐA-Z]\.\s*){1,2})$/u;
/** По батькові вже в родовому: «…овича», «…івни». Відмінювати вдруге не можна («Тетяниї»). */
const GENITIVE_PATRONYMIC = /(ича|івни|ївни)$/u;

export interface DirName {
  /** ПІБ у родовому для «в особі директора …»; порожній вхід → порожньо. */
  gen: string;
  /** рід відомий (з по батькові або вибраний людиною) */
  fem: boolean;
  /** як визначено: `auto` — бібліотекою, `chosen` — перемикачем, `guess` — не визначено, взято чоловічий */
  how: 'auto' | 'chosen' | 'guess';
  /** вхід уже в родовому — повернуто як є */
  genitiveInput: boolean;
}

/** Рід за ПІБ: по батькові → бібліотека; ініціали й нетипове → null. */
export async function genderOf(full: string): Promise<Gender | null> {
  const t = full.trim().replace(/\s+/g, ' ');
  if (!t || INITIALS.test(t)) return null;
  const last = t.split(' ').at(-1)!;
  if (GENITIVE_PATRONYMIC.test(last)) return /ича$/u.test(last) ? 'masculine' : 'feminine';
  const [familyName, givenName, patronymicName] = t.split(' ');
  return shev().detectGender({ familyName, givenName, patronymicName }).catch(() => null);
}

/**
 * ПІБ (називний) → родовий. `chosen` — рід із перемикача форми ('m'/'f'), має пріоритет над визначеним.
 * Збій бібліотеки (дивні символи) не валить документ: повертається вхід як є.
 */
export async function genitiveName(full: string, chosen?: string): Promise<DirName> {
  const t = (full || '').trim().replace(/\s+/g, ' ');
  if (!t) return { gen: '', fem: false, how: 'guess', genitiveInput: false };
  const pick: Gender | null = chosen === 'f' ? 'feminine' : chosen === 'm' ? 'masculine' : null;
  const words = t.split(' ');
  if (!INITIALS.test(t) && GENITIVE_PATRONYMIC.test(words.at(-1)!)) {
    const g = pick ?? (await genderOf(t));
    return { gen: t, fem: g === 'feminine', how: pick ? 'chosen' : 'auto', genitiveInput: true };
  }
  const detected = pick ? null : await genderOf(t);
  const gender: Gender = pick ?? detected ?? 'masculine';
  const how: DirName['how'] = pick ? 'chosen' : detected ? 'auto' : 'guess';
  try {
    const ini = INITIALS.exec(t);
    if (ini) {
      const r = await shev().inGenitive({ familyName: ini[1], gender });
      return { gen: `${r.familyName ?? ini[1]} ${ini[2].trim()}`, fem: gender === 'feminine', how, genitiveInput: false };
    }
    const [familyName, givenName, patronymicName] = words;
    const r = await shev().inGenitive({ familyName, givenName, patronymicName, gender });
    const out = [r.familyName, r.givenName, r.patronymicName].filter(Boolean).join(' ');
    // більше трьох слів (подвійне імʼя тощо) — хвіст лишаємо як є, а не губимо
    return { gen: [out, ...words.slice(3)].join(' '), fem: gender === 'feminine', how, genitiveInput: false };
  } catch {
    return { gen: t, fem: gender === 'feminine', how, genitiveInput: false };
  }
}

/** ФОП у назві → ПІБ без «ФОП»; для ФОП «в особі» немає, але «який/яка діє» узгоджується з людиною. */
const fopPerson = (name: string) => name.trim().replace(/^ФОП\s+/iu, '').replace(/^ФІЗИЧНА\s+ОСОБА[\s-]*ПІДПРИЄМЕЦЬ\s+/iu, '');

/**
 * Вхід прев'ю/формування: дописує у `s.cp` готові `dirGen` (родовий; ручна правка `dirGenHand` — понад усе)
 * і `dirFem` ('1' — жіночий), і повертає 🟡 для форми. Значення `dirGen`/`dirFem`, що прийшли з клієнта,
 * НЕ довіряються — завжди перераховуються.
 */
export interface DirectorInfo { issues: Issue[]; how: DirName['how'] | null }
export async function resolveDirector(s: DocumentState): Promise<DirectorInfo> {
  const cp = s.cp;
  const out: Issue[] = [];
  const isFop = /^(ФОП|ФІЗИЧНА\s+ОСОБА)/iu.test((cp.name || '').trim());
  const person = (cp.dir || '').trim() || (isFop ? fopPerson(cp.name || '') : '');
  delete cp.dirGen; delete cp.dirFem;
  if (!person.trim()) return { issues: out, how: null };
  const r = await genitiveName(person, cp.dirGender);
  const hand = (cp.dirGenHand || '').trim();
  if (!isFop) cp.dirGen = hand || r.gen;
  if (r.fem) cp.dirFem = '1';
  const field = 'cp.dir';
  if (r.genitiveInput && !hand) out.push({ field, level: 'warn', msg: 'ПІБ директора схоже вже в родовому відмінку («…овича», «…івни») — впишіть у називному: «Іваненко Марія Петрівна».' });
  else if (r.how === 'guess') out.push({ field, level: 'warn', msg: 'Не вдалося визначити рід за ПІБ — оберіть Ч або Ж під полем, щоб у договорі було «який/яка діє» і правильний відмінок.' });
  return { issues: out, how: r.how };
}
