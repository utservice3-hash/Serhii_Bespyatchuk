/**
 * 🔤 Транслітерація українського алфавіту латиницею — постанова КМУ №55 від 27.01.2010 (офіційна; так пишуть імена
 * в паспортах і назви на дорожніх знаках). Для заявки нерезиденту (задача 5940): імена, адреси, міста не перекладаються,
 * а транслітеруються — «Київ» завжди «Kyiv», прізвище не стає словом. Без мережі й без бібліотек.
 *
 * Правила постанови: Є, Ї, Й, Ю, Я на початку слова — Ye, Yi, Y, Yu, Ya, в інших позиціях — ie, i, i, iu, ia;
 * «зг» — «zgh»; м'який знак і апостроф не передаються. Регістр зберігаємо: «КИЇВ» → «KYIV», «Київ» → «Kyiv».
 */
const BASE: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z', и: 'y', і: 'i', ї: 'i', й: 'i',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch',
  ш: 'sh', щ: 'shch', ь: '', ю: 'iu', я: 'ia',
};
/** На початку слова. */
const INITIAL: Record<string, string> = { є: 'ye', ї: 'yi', й: 'y', ю: 'yu', я: 'ya' };
const APOS = /['’ʼ`]/;
const isUaLetter = (c: string) => /[а-щьюяєіїґ]/i.test(c);

/** Регістр латинського відповідника за регістром кириличної літери й сусідньої (щоб «ЩЕРБУХИ» → «SHCHERBUKHY»). */
function applyCase(lat: string, src: string, next: string | undefined): string {
  if (!lat || src === src.toLowerCase()) return lat;
  const allCaps = next !== undefined && isUaLetter(next) && next === next.toUpperCase() && next !== next.toLowerCase();
  return allCaps ? lat.toUpperCase() : lat[0].toUpperCase() + lat.slice(1);
}

export function translit(text: string): string {
  let out = '';
  const ch = [...text];
  for (let i = 0; i < ch.length; i++) {
    const c = ch[i], lc = c.toLowerCase();
    if (APOS.test(c) && i > 0 && isUaLetter(ch[i - 1]) && i + 1 < ch.length && isUaLetter(ch[i + 1])) continue;   // апостроф у слові
    if (!(lc in BASE)) { out += c; continue; }
    const prev = ch[i - 1] ?? '';
    const atStart = !isUaLetter(prev) && !(APOS.test(prev) && isUaLetter(ch[i - 2] ?? ''));
    let lat = atStart && lc in INITIAL ? INITIAL[lc] : BASE[lc];
    if (lc === 'г' && prev.toLowerCase() === 'з') lat = 'gh';                                                      // «зг» → «zgh»
    let next = ch[i + 1];
    if (next && APOS.test(next)) next = ch[i + 2];
    out += applyCase(lat, c, next);
  }
  return out;
}

/** Організаційні форми на початку назви — як їх пишуть англійською (решта назви транслітерується). */
const ORG_EN: Array<[RegExp, string]> = [
  [/^(ТОВ|ТзОВ|ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ)(?=[\s«"'“„]|$)/i, 'LLC'],
  [/^(ПрАТ|ПРИВАТНЕ АКЦІОНЕРНЕ ТОВАРИСТВО)(?=[\s«"'“„]|$)/i, 'PrJSC'],
  [/^(ПАТ|ПУБЛІЧНЕ АКЦІОНЕРНЕ ТОВАРИСТВО)(?=[\s«"'“„]|$)/i, 'PJSC'],
  [/^(АТ|АКЦІОНЕРНЕ ТОВАРИСТВО)(?=[\s«"'“„]|$)/i, 'JSC'],
  [/^(ПП|ПРИВАТНЕ ПІДПРИЄМСТВО)(?=[\s«"'“„]|$)/i, 'PE'],
  [/^(ФОП|ФІЗИЧНА ОСОБА[\s–—-]ПІДПРИЄМЕЦЬ)(?=[\s«"'“„]|$)/i, 'Individual Entrepreneur'],
];
/** Назва компанії / рядок «компанія, контакт, телефон»: орг. форма — англійською, лапки «» → "", решта — транслітерацією. */
export function translitParty(text: string): string {
  let t = text.trim();
  for (const [re, en] of ORG_EN) if (re.test(t)) { t = t.replace(re, en); break; }
  return translit(t.replace(/[«»“„”]/g, '"'));
}

/** Чи є в тексті кирилиця (тоді є що перекладати). */
export const hasCyrillic = (t: string) => /[А-Яа-яІіЇїЄєҐґ]/.test(t);

/* ── Адреси (Роман 21.10.2026: «транслітерація + англійські скорочення») ──
   Назви — транслітерацією, службові слова — як пишуть англійською: «с. Яхни, Київська обл., вул. Шевченка, 5» →
   «Yakhny village, Kyiv region, Shevchenka str., 5». Області — їхніми англійськими назвами (Kyiv region, не Kyivska). */
const OBLAST_EN: Record<string, string> = {
  вінницька: 'Vinnytsia', волинська: 'Volyn', дніпропетровська: 'Dnipropetrovsk', донецька: 'Donetsk', житомирська: 'Zhytomyr',
  закарпатська: 'Zakarpattia', запорізька: 'Zaporizhzhia', 'івано-франківська': 'Ivano-Frankivsk', київська: 'Kyiv',
  кіровоградська: 'Kirovohrad', луганська: 'Luhansk', львівська: 'Lviv', миколаївська: 'Mykolaiv', одеська: 'Odesa',
  полтавська: 'Poltava', рівненська: 'Rivne', сумська: 'Sumy', тернопільська: 'Ternopil', харківська: 'Kharkiv',
  херсонська: 'Kherson', хмельницька: 'Khmelnytskyi', черкаська: 'Cherkasy', чернівецька: 'Chernivtsi', чернігівська: 'Chernihiv',
};
/** Префікс службового слова → [як писати англійською, де: перед назвою чи після]. */
const ADDR_WORDS: Array<[RegExp, string, 'pre' | 'post' | 'drop']> = [
  [/^(м\.|місто)\s*/i, '', 'drop'],
  [/^(с\.|село)\s*/i, 'village', 'post'],
  [/^(смт\.?|селище міського типу|сел\.|селище)\s*/i, 'settlement', 'post'],
  [/^(вул\.|вулиця)\s*/i, 'str.', 'post'],
  [/^(просп\.|проспект|пр-т)\s*/i, 'ave.', 'post'],
  [/^(пров\.|провулок)\s*/i, 'lane', 'post'],
  [/^(бульв\.|бульвар|б-р)\s*/i, 'blvd.', 'post'],
  [/^(пл\.|площа)\s*/i, 'sq.', 'post'],
  [/^(шосе)\s*/i, 'hwy', 'post'],
  [/^(буд\.|будинок)\s*/i, 'bldg.', 'pre'],
  [/^(оф\.|офіс)\s*/i, 'office', 'pre'],
  [/^(кв\.|квартира)\s*/i, 'apt.', 'pre'],
  [/^(корп\.|корпус)\s*/i, 'block', 'pre'],
];
function addrSegment(seg: string): string {
  const t = seg.trim();
  if (!t) return t;
  if (/^україна$/i.test(t)) return 'Ukraine';
  const obl = /^(.+?)\s+(обл\.?|область)$/i.exec(t) || /^(?:обл\.?|область)\s+(.+)$/i.exec(t);
  if (obl) { const adj = obl[1].toLowerCase(); return `${OBLAST_EN[adj] ?? translit(obl[1])} region`; }
  const dist = /^(.+?)\s+(р-н|район)$/i.exec(t);
  if (dist) return `${translit(dist[1])} district`;
  for (const [re, en, where] of ADDR_WORDS) {
    const m = re.exec(t);
    if (!m) continue;
    const rest = t.slice(m[0].length);
    if (where === 'drop') return translit(rest);
    if (where === 'pre') return `${en} ${translit(rest)}`;
    const num = /^(.+?)\s+(\d+[\p{L}\d/-]*)$/u.exec(rest);                       // «вул. Шевченка 5» → «Shevchenka str., 5»
    return num ? `${translit(num[1])} ${en}, ${translit(num[2])}` : `${translit(rest)} ${en}`;
  }
  return translit(t);
}
/** Адреса англійською: по частинах між комами (і точками розвантаження « · »). */
export function translitAddress(text: string): string {
  return text.split(/\s*·\s*/).map((pt) => pt.split(',').map(addrSegment).filter((x, i, a) => x || i < a.length - 1).join(', ')).join(' · ');
}
