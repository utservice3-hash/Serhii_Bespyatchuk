/**
 * Розумна вставка: довільний текст із питаннями → структура опитування.
 * Порт 1:1 із затвердженого макета opytuvannya.html (v2); поведінка зафіксована
 * тестами на 8 текстах (tests/surveyParser.test.ts, еталони зняті з макета).
 *
 * Що розуміє: «1.» «1)» «Питання 1:» «Q1.»; варіанти «а)» «A.» «-» «•» «○» «☐» «1)»;
 * позначки в дужках «(можна кілька)» «(так/ні)» «(необов'язково)» «(матриця)»
 * «(за пріоритетом)»; «від 1 до 10»/«1-5» — шкала; «порекоменду… 0–10» — eNPS;
 * шкала + підрядки — матриця; markdown із Claude (`**`, `###`) чиститься.
 *
 * Правило чисел: якщо в тексті є і «1.», і «1)» — крапка = питання, дужка = варіант;
 * один стиль — «біг» коротких нумерованих рядків одразу після рядка з «?»/«:» = варіанти.
 *
 * ⚠ У кириличних регекспах \b не працює (JS вважає кирилицю не-словом) — тому лукахеди.
 */

export type QType = 'single' | 'multi' | 'scale' | 'enps' | 'matrix' | 'rank' | 'text';

export interface ParsedQuestion {
  text: string;
  type: QType;
  options: string[];   // single/multi/rank
  rows: string[];      // matrix
  image: string;       // url (у макеті — dataURL); парсер лишає ''
  required: boolean;
  hint: string;
  min: number;
  max: number;
  unsure: string;      // підказка «варто перевірити» для UI, '' якщо впевнено
}

export interface ParsedSurvey { title: string; desc: string; questions: ParsedQuestion[] }

const RX = {
  qWord:  /^\s*(?:питання|question|q)\s*(\d{1,3})?\s*[:.)\-–—]?\s*(.*)$/i,
  qHead:  /^(?:питання|question|q)(?=\s*\d|\s*[:.)\-–—])/i,
  numDot: /^\s*(\d{1,3})\.\s+(.+)$/,
  numPar: /^\s*(\d{1,3})\)\s+(.+)$/,
  optLet: /^\s*([а-яіїєґa-z])\s?[.)]\s+(.+)$/i,
  optBul: /^\s*(\[\s?[xX✓✔]?\s?\]|☐|☑|✓|✔|[-–—•·*○●◦▪□■])\s+(.+)$/,
  inlineLet: /\s(?=[а-яіїєґa-z]\)\s)/i,
  multi:  /\((?:можна\s+|оберіть\s+|виберіть\s+)?(?:кілька|декілька|multiple|several|усі,? що підходять)[^)]*\)/i,
  yesno:  /\(?\s*так\s*\/\s*ні\s*\)?|\(так або ні\)/i,
  scale1: /(?:від|from)\s*(\d{1,2})\s*(?:до|to)\s*(\d{1,3})/i,
  scale2: /(\d{1,2})\s*[-–—]\s*(\d{1,3})/,
  scaleW: /оцін|шкал|бал|наскільки|rate/i,
  optional: /\(\s*не\s?обов[’'ʼ]?язков[а-я]*\s*\)/i,
  textMark: /\((?:текстом|відкрит[а-я]+|вільн[а-я]+ відповідь|коментар)\)/i,
  titleP: /^\s*(?:опитування|назва|тема|survey|title)\s*[:—–-]\s*(.+)$/i,
  rank:   /\((?:розставте|впорядкуйте|ранжуйте|ранжування|за пріоритетом|по пріоритету|rank)[^)]*\)|^(?:розставте|впорядкуйте|ранжуйте)(?=\s)/i,
  matrixM:/\(матриця\)/i,
  enps:   /порекоменду|recommend/i,
};

type Tok = { k: 'blank' | 'opt' | 'num' | 'q' | 'plain' | 'used'; t: string; p?: '.' | ')'; n?: number; cb?: boolean };

const isCheckboxMarker = (m: string) => /\[|☐|☑|✓|✔/.test(m);

function classifyLines(lines: string[]): Tok[] {
  return lines.map(t => {
    const s = t.trim();
    if (!s) return { k: 'blank', t: '' };
    let m: RegExpMatchArray | null;
    if ((m = s.match(RX.optBul))) return { k: 'opt', t: m[2].trim(), cb: isCheckboxMarker(m[1]) };
    if ((m = s.match(RX.optLet))) return { k: 'opt', t: m[2].trim(), cb: false };
    if ((m = s.match(RX.numDot))) return { k: 'num', p: '.', n: +m[1], t: m[2].trim() };
    if ((m = s.match(RX.numPar))) return { k: 'num', p: ')', n: +m[1], t: m[2].trim() };
    if ((m = s.match(RX.qWord)) && RX.qHead.test(s)) return { k: 'q', t: (m[2] || '').trim() };
    return { k: 'plain', t: s };
  });
}

/** «біг» нумерованих рядків одного стилю: чи це варіанти відповіді? */
function markNumberedOptions(tok: Tok[]): Tok[] {
  const styles: Record<string, number> = { '.': 0, ')': 0 };
  tok.forEach(x => { if (x.k === 'num' && x.p) styles[x.p]++; });
  const both = styles['.'] > 0 && styles[')'] > 0;
  for (let i = 0; i < tok.length; i++) {
    if (tok[i].k !== 'num') continue;
    const p = tok[i].p;
    if (both) { if (p === ')') tok[i].k = 'opt'; continue; }
    let j = i; while (j < tok.length && tok[j].k === 'num' && tok[j].p === p) j++;
    const run = tok.slice(i, j);
    let k = i - 1; while (k >= 0 && tok[k].k === 'blank') k--;
    const prev = k >= 0 ? tok[k] : null;
    const prevAsks = !!prev && (prev.k === 'plain' || prev.k === 'q') && /[?:]$/.test(prev.t);
    const looksOpts = run.length >= 2 && run[0].n === 1 && prevAsks &&
                      run.every(x => !/\?$/.test(x.t) && x.t.length <= 80);
    if (looksOpts) run.forEach(x => { x.k = 'opt'; x.cb = false; });
    i = j - 1;
  }
  return tok;
}

interface WorkQ extends ParsedQuestion { cbAny: boolean }
const newQ = (text: string): WorkQ => ({ text: text.trim(), type: 'single', options: [], rows: [], image: '', required: true, hint: '', min: 1, max: 10, unsure: '', cbAny: false });

function finalizeQ(q: WorkQ): ParsedQuestion {
  let t = q.text;
  const hasOpts = q.options.length > 0;
  const isRank = RX.rank.test(t) && hasOpts;
  if (RX.multi.test(t) || q.cbAny) { q.type = 'multi'; t = t.replace(RX.multi, ''); }
  const sm = t.match(RX.scale1) || ((RX.scaleW.test(t) && !hasOpts) ? t.match(RX.scale2) : null);
  const numericOpts = hasOpts && q.options.length >= 3 && q.options.every((o, i) => String(o).trim() === String(i + 1) || String(o).trim() === String(i));
  if (isRank) {
    q.type = 'rank'; t = t.replace(RX.rank, m => /^\(/.test(m) ? '' : m);
  } else if ((sm && hasOpts && !numericOpts) || (RX.matrixM.test(t) && hasOpts)) {
    q.type = 'matrix'; q.rows = q.options.slice(); q.options = [];
    if (sm) { q.min = +sm[1]; q.max = +sm[2]; } else { q.min = 1; q.max = 5; }
    if (q.max <= q.min || q.max - q.min > 20) { q.min = 1; q.max = 5; }
    t = t.replace(RX.matrixM, '');
  } else if (sm || numericOpts) {
    if (sm) { q.min = +sm[1]; q.max = +sm[2]; } else { q.min = +q.options[0]; q.max = +q.options[q.options.length - 1]; }
    if (q.max <= q.min || q.max - q.min > 20) { q.min = 1; q.max = 10; }
    q.options = [];
    q.type = (RX.enps.test(t) && q.min === 0 && q.max === 10) ? 'enps' : 'scale';
  } else if (RX.enps.test(t) && !hasOpts) {
    q.type = 'enps'; q.min = 0; q.max = 10;
  } else if (RX.yesno.test(t) && !hasOpts) {
    q.type = 'single'; q.options = ['Так', 'Ні']; t = t.replace(RX.yesno, '');
  } else if (hasOpts && q.type !== 'multi') {
    q.type = 'single';
  } else if (!hasOpts) {
    q.type = 'text'; t = t.replace(RX.textMark, '');
  }
  if (RX.optional.test(t)) { q.required = false; t = t.replace(RX.optional, ''); }
  t = t.replace(/\s*\*\s*$/, '').replace(/\s{2,}/g, ' ').replace(/\s+([?:])$/, '$1').trim();
  q.text = t;
  if (q.type === 'single' && q.options.length === 1) q.unsure = 'Лише один варіант — додайте ще або змініть тип на «текст».';
  if (q.type === 'text' && !/[?:]$/.test(t) && t.length < 25) q.unsure = 'Варіантів не знайдено — буде відкрита відповідь. Якщо потрібні варіанти, додайте їх.';
  if (q.type === 'rank' && q.options.length < 2) q.unsure = 'Для ранжування потрібно щонайменше два варіанти.';
  const { cbAny: _drop, ...out } = q; void _drop;
  return out;
}

export function parseSurveyText(raw: string): ParsedSurvey {
  const lines = String(raw || '').replace(/\r/g, '').replace(/ /g, ' ')
    .replace(/\*\*|__|`/g, '').replace(/^\s*#{1,6}\s*/gm, '')
    .split('\n');
  const tok = markNumberedOptions(classifyLines(lines));
  const head: string[] = []; const qs: WorkQ[] = []; let cur: WorkQ | null = null;
  const nextNonBlank = (i: number) => { let j = i + 1; while (j < tok.length && tok[j].k === 'blank') j++; return tok[j] || null; };
  for (let i = 0; i < tok.length; i++) {
    const x = tok[i];
    if (x.k === 'blank') continue;
    if (x.k === 'opt') {
      if (!cur) { if (head.length) { cur = newQ(head.pop()!); qs.push(cur); } else continue; }
      const parts = x.t.split(RX.inlineLet).map(s => s.replace(/^[а-яіїєґa-z]\)\s*/i, '').trim()).filter(Boolean);
      parts.forEach(p => cur!.options.push(p));
      if (x.cb) cur.cbAny = true;
      continue;
    }
    if (x.k === 'num' || x.k === 'q') {
      let text = x.t;
      if (x.k === 'q' && !text) { const nx = nextNonBlank(i); if (nx && nx.k === 'plain') { text = nx.t; nx.k = 'used'; } }
      const inl = text.split(RX.inlineLet);
      cur = newQ(inl[0]); qs.push(cur);
      inl.slice(1).forEach(p => cur!.options.push(p.replace(/^[а-яіїєґa-z]\)\s*/i, '').trim()));
      continue;
    }
    if (x.k === 'used') continue;
    if (!cur) { head.push(x.t); continue; }
    const nx = nextNonBlank(i);
    const startsQ = /\?$/.test(x.t) || (!!nx && nx.k === 'opt' && cur.options.length > 0);
    if (startsQ) { cur = newQ(x.t); qs.push(cur); }
    else { cur.hint = (cur.hint ? cur.hint + ' ' : '') + x.t; }
  }
  const questions = qs.map(finalizeQ);
  let title = '', desc = '';
  if (head.length) {
    const m = head[0].match(RX.titleP);
    title = m ? m[1].trim() : head[0].trim();
    desc = head.slice(1).join(' ').trim();
    if (!m && head.length === 1 && /\?$/.test(title) && !questions.length) { questions.push(finalizeQ(newQ(title))); title = ''; }
  }
  return { title, desc, questions };
}

/** Стандартний текст eNPS-питання (кнопка «+ eNPS одним кліком»). */
export const ENPS_TEXT = 'Наскільки ймовірно, що ви порекомендуєте UTS як місце роботи друзям чи знайомим?';
