/**
 * Відповіді YouScore → що зберігаємо й показуємо (shared/cpCheck.ts). Чисті функції — тести з прикладами відповідей у tests/youscoreParse.test.ts.
 * Поля — за специфікацією api.youscore.com.ua/swagger/v1/swagger.json (звірено 23.10):
 *   /v1/usr — юрособа: name {fullName, shortName}, legalForm, status, address, founders[], foundingCapital {sum}, signers[], beneficiariesGeneralInfo,
 *             registrationAfterLaw.entryDate / registrationBeforeLaw.date; ФОП — інша схема (специфікація посилається на зразки) → читаємо обережно.
 *   /v1/history — managerChanges[], foundersChanges[] {dateChanges, founders[]}, capitalChanges[].
 *   /v1/courtCaseGroup — results[] {caseNumber, sideType (2 — відповідач), autoCases[], considerationDocuments[], documents[]}.
 *   /v1/enforcement — results[] {enforcementState, status (Боржник / Стягувач)}.
 *   /v1/expressAnalysis — expressAnalysisIndex, features[] {featureName, caution (max / average / min / empty), value}.
 * «Відкрита» справа — YouScore стану не віддає, виводимо: є призначене засідання або немає рішення, що набрало сили.
 */
import { LOST_YEARS, claimSatisfied, isTransport, type CheckBase, type CheckSubject, type CourtCase, type ExpressFact, type Owner, type Ownership } from '../../shared/cpCheck.js';
import { dt } from '../../shared/cpFormat.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const s = (v: unknown) => (typeof v === 'string' ? v.trim() : v === null || v === undefined ? '' : String(v).trim());
const date = (v: unknown): string | null => { const t = s(v); if (!t) return null; const d = new Date(t); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };
const numOrNull = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const byDate = (a: { at: string | null }, b: { at: string | null }) => Date.parse(a.at || '') - Date.parse(b.at || '');

const FORMS: Array<[RegExp, string]> = [
  [/товариство з обмеженою відповідальністю/i, 'ТОВ'], [/товариство з додатковою відповідальністю/i, 'ТДВ'],
  [/приватне акціонерне товариство/i, 'ПрАТ'], [/публічне акціонерне товариство/i, 'ПАТ'], [/акціонерне товариство/i, 'АТ'],
  [/приватне підприємство/i, 'ПП'], [/фермерське господарство/i, 'ФГ'], [/державне підприємство/i, 'ДП'], [/комунальне підприємство/i, 'КП'],
  [/кооператив/i, 'Кооператив'], [/повне товариство/i, 'ПТ'], [/командитне товариство/i, 'КТ'], [/дочірнє підприємство/i, 'ДП'],
];
/** «ТОВ "ЛІСОСТЕП"» → «ТОВ «ЛІСОСТЕП»» — лапки як у дашборді. */
export const niceName = (n: string) => n.replace(/"([^"]*)"/g, '«$1»').replace(/\s+/g, ' ').trim();

export function isFopUsr(code: string, usr: any): boolean {
  return /^\d{10}$/.test(code) || /ФОП|фізична особа-підприємець/i.test(s(usr?.contractorType));
}
export function baseFromUsr(code: string, usr: any): CheckBase {
  const fop = isFopUsr(code, usr);
  const nm = usr?.name;
  const full = typeof nm === 'string' ? nm : s(nm?.fullName) || s(usr?.fullName) || s(usr?.legalPersonName);
  const shortN = typeof nm === 'object' && nm ? s(nm.shortName) : '';
  let name = niceName(shortN || full || code);
  if (fop && !/^ФОП\b/i.test(name)) name = 'ФОП ' + name;
  const form = s(usr?.legalForm);
  const kind = fop ? 'ФОП' : (FORMS.find(([re]) => re.test(form) || re.test(full))?.[1] || (form ? form.split(/\s+/).map(w => w[0]).join('').toUpperCase() : 'Юрособа'));
  const reg = date(usr?.registrationBeforeLaw?.date) || date(usr?.registrationAfterLaw?.entryDate) || date(usr?.registrationBeforeLaw?.entryDate)
    || date(usr?.registrationDate) || date(usr?.registration?.date) || date((usr?.registrationAuthorities || [])[0]?.registrationDate);
  const signers: any[] = Array.isArray(usr?.signers) ? usr.signers : [];
  const head = fop ? '' : s((signers.find(x => /керівник/i.test(s(x.role))) || {}).name) || s(usr?.superiorManagement);
  return { code, kind, name, reg, head, addr: s(usr?.address) || s(usr?.location), fop };
}

// ---------- суди ----------
const isDefendant = (g: any) => Number(g?.sideType) === 2
  || (Array.isArray(g?.autoCases) && g.autoCases.some((a: any) => /відповідач/i.test(s(a.caseSideType))))
  || (Array.isArray(g?.considerationDocuments) && g.considerationDocuments.some((a: any) => /відповідач/i.test(s(a.caseSideType))));
const FINAL_FORM = /рішення|постанова/i;
const CLOSING = /закрити провадження|залишити (позов|позовну заяву)[^.]{0,20}без розгляду|повернути позовну заяву/i;

/** Одна судова справа (група документів) → CourtCase. */
export function courtCase(g: any, now: Date): CourtCase {
  const auto: any[] = Array.isArray(g?.autoCases) ? g.autoCases : [];
  const hearings: any[] = Array.isArray(g?.considerationDocuments) ? g.considerationDocuments : [];
  const docs: any[] = (Array.isArray(g?.documents) ? g.documents : []).slice().sort((a: any, b: any) => Date.parse(b.decisionDate || '') - Date.parse(a.decisionDate || ''));
  const a0 = auto[0] || {}, h0 = hearings[0] || {}, d0 = docs[0] || {};
  const future = hearings.map(h => date(h.courtDate)).filter((d): d is string => !!d && Date.parse(d) >= now.getTime()).sort();
  const final = docs.find(d => d.lawDate && (FINAL_FORM.test(s(d.decisionForm)) || CLOSING.test(s(d.resolutionPart))));
  const filed = date(a0.registrationDate) || date(docs[docs.length - 1]?.decisionDate) || date(h0.courtDate);
  const recent = filed ? now.getTime() - Date.parse(filed) < 548 * 864e5 : false;   // ~18 міс.: старі справи без документів не тримаємо «відкритими»
  const open = future.length > 0 || (!final && recent);
  const lost = !open && !!final && FINAL_FORM.test(s(final.decisionForm)) && claimSatisfied(final.resolutionPart)
    && now.getTime() - Date.parse(final.lawDate) < LOST_YEARS * 365.25 * 864e5;
  return {
    no: s(g?.caseNumber) || s(a0.caseNumber) || '—',
    court: s(a0.courtName) || s(h0.courtName) || s(d0.courtName),
    date: filed,
    subj: s(a0.description) || s(h0.description) || s(d0.caseCategory),
    sum: numOrNull(a0.sum) ?? numOrNull(h0.sum),
    open,
    next: future[0] || null,
    lost,
    lawDate: final ? date(final.lawDate) : null,
    url: s(d0.urlToDocument) || null,
  };
}
const subjectText = (g: any) => [
  ...(g?.autoCases || []).map((a: any) => a.description),
  ...(g?.considerationDocuments || []).map((a: any) => a.description),
  ...(g?.documents || []).map((d: any) => d.caseCategory),
];
/** Справи за перевезення / експедирування, де контрагент — відповідач (відкриті або програні за 3 роки). Решта — лише кількість. */
export function parseCourts(data: { total: number; results: any[] } | null, now: Date): { cases: CourtCase[]; other: number } {
  if (!data) return { cases: [], other: 0 };
  const cases: CourtCase[] = [];
  for (const g of data.results) {
    if (!isDefendant(g) || !isTransport(...subjectText(g))) continue;
    const c = courtCase(g, now);
    if (c.open || c.lost) cases.push(c);
  }
  cases.sort((a, b) => Date.parse(b.date || '') - Date.parse(a.date || ''));
  return { cases, other: Math.max(0, Math.max(data.total, data.results.length) - cases.length) };
}

/** Відкриті виконавчі провадження, де контрагент — боржник. */
export function parseEnforcement(data: { total: number; results: any[] } | null): number {
  if (!data) return 0;
  return data.results.filter(x => /боржник/i.test(s(x.status)) && /відкрит/i.test(s(x.enforcementState))).length;
}

/** Експрес-аналіз → позначки «для інформації»: усі «потрібна увага» і кілька ключових «проблем не виявлено». */
const KEY_OK = /податков|банкрут|санкц|масов|ризиков|ліквідац|припинен/i;
export function parseExpress(ea: any): { facts: ExpressFact[]; index: string | null } {
  const feats: any[] = Array.isArray(ea?.features) ? ea.features : [];
  const short = (t: string) => (t.length > 70 ? t.slice(0, 67).trimEnd() + '…' : t);
  const bad = feats.filter(f => s(f.caution) === 'max').map(f => ({ name: s(f.featureName), value: short(s(f.value) || 'потрібна увага'), tone: 'bad' as const }));
  const warn = feats.filter(f => s(f.caution) === 'average').map(f => ({ name: s(f.featureName), value: short(s(f.value) || 'зверніть увагу'), tone: 'warn' as const }));
  const ok = feats.filter(f => s(f.caution) === 'min' && KEY_OK.test(s(f.featureName))).slice(0, 4)
    .map(f => ({ name: s(f.featureName), value: short(s(f.value) || 'не виявлено'), tone: 'ok' as const }));
  return { facts: [...bad, ...warn, ...ok].filter(f => f.name), index: s(ea?.expressAnalysisIndex) || null };
}

// ---------- власники ----------
const isPersonName = (code: string | null) => !code || !/^\d{8}$/.test(code);
/** Ключ власника для кешу «скільки компаній»: ЄДРПОУ юрособи або ПІБ (нижній регістр). */
export const ownerKey = (o: { name: string; code: string | null }) => (o.code && /^\d{8}$/.test(o.code) ? o.code : niceName(o.name).toLowerCase());
/** Засновник чи бенефіціар: у бенефіціара є тип / відсоток бенефіціарного володіння і немає внеску. */
const isBenEntry = (x: any) => !!(s(x.ownershipType) || numOrNull(x.interest) !== null || numOrNull(x.indirectInterest) !== null) && !(numOrNull(x.capital) || 0);

/** Скільки компаній у власника: ключ — ЄДРПОУ (юрособа) або ПІБ у нижньому регістрі (фізособа). */
export type OwnerCounts = Map<string, number | null>;
export const ownersToCount = (usr: any, max = 4): Array<{ key: string; name: string; code: string | null; kind: 'person' | 'company' }> => {
  const list: any[] = Array.isArray(usr?.founders) ? usr.founders.filter((x: any) => !isBenEntry(x)) : [];
  return list.slice(0, max).map(x => { const code = s(x.code) || null; return { key: ownerKey({ name: s(x.name), code }), name: s(x.name), code, kind: isPersonName(code) ? 'person' as const : 'company' as const }; });
};

function lastChange<T extends { at: string | null }>(list: T[]): [T | undefined, T | undefined] {
  const sorted = list.filter(x => x.at).sort(byDate);
  return [sorted[sorted.length - 2], sorted[sorted.length - 1]];
}
export function parseOwnership(usr: any, history: any, counts: OwnerCounts, reg: string | null): Ownership | null {
  if (!usr) return null;
  const all: any[] = Array.isArray(usr.founders) ? usr.founders : [];
  const capital = numOrNull(usr.foundingCapital?.sum);
  const bensRaw = all.filter(isBenEntry).map(x => s(x.name)).filter(Boolean);
  const owners: Owner[] = all.filter(x => !isBenEntry(x)).map(x => {
    const code = s(x.code) || null, name = niceName(s(x.name));
    const pct = numOrNull(x.ownershipPercent) ?? (capital && numOrNull(x.capital) !== null ? Math.round((numOrNull(x.capital)! / capital) * 10000) / 100 : null);
    const ben = bensRaw.some(b => b.toLowerCase() === s(x.name).toLowerCase());
    const c = counts.get(ownerKey({ name: s(x.name), code }));
    return { name, code: code && /^\d{8}$/.test(code) ? code : null, kind: isPersonName(code) ? 'person' : 'company', share: pct, ben, companies: c === undefined ? null : c };
  });
  const bens = bensRaw.filter(b => !owners.some(o => o.name.toLowerCase() === niceName(b).toLowerCase())).map(niceName);
  const bg = usr.beneficiariesGeneralInfo || {};
  const benNote = bg.isMissing ? `КБВ відсутній${s(bg.reason) ? ': ' + s(bg.reason) : ''}` : bg.excluded ? 'Відомості про КБВ виключено за вказівкою Мін\'юсту' : '';

  // директор: з ЄДР; «з якого часу» — дата призначення або остання зміна керівника в історії, інакше дата реєстрації
  const signers: any[] = Array.isArray(usr.signers) ? usr.signers : [];
  const dirS = signers.find(x => /керівник/i.test(s(x.role)));
  const mgr = (Array.isArray(history?.managerChanges) ? history.managerChanges : []).map((x: any) => ({ at: date(x.dateChanges), name: niceName(s(x.name)) }));
  const [mPrev, mLast] = lastChange<{ at: string | null; name: string }>(mgr);
  const dirName = dirS ? niceName(s(dirS.name)) : mLast?.name || '';
  const director = dirName ? { name: dirName, since: date(dirS?.appointDate) || (mLast && mLast.name.toLowerCase() === dirName.toLowerCase() && mPrev ? mLast.at : null) || reg } : null;
  const dirAt = mPrev && mLast && mPrev.name.toLowerCase() !== mLast.name.toLowerCase() ? mLast.at : null;
  const dirWhat = dirAt ? `${mPrev!.name} → ${mLast!.name}` : '';

  // власники: порівнюємо два останні знімки складу засновників
  const snaps = (Array.isArray(history?.foundersChanges) ? history.foundersChanges : []).map((x: any) => ({
    at: date(x.dateChanges),
    founders: (Array.isArray(x.founders) ? x.founders : []).filter((f: any) => !f.type || Number(f.type) === 1 || numOrNull(f.capital))
      .map((f: any) => ({ name: niceName(s(f.name)), capital: numOrNull(f.capital) })),
  }));
  const [fPrev, fLast] = lastChange<{ at: string | null; founders: Array<{ name: string; capital: number | null }> }>(snaps);
  let ownersAt: string | null = null, ownersWhat = '';
  if (fPrev && fLast) {
    const a = new Map(fPrev.founders.map(f => [f.name.toLowerCase(), f])), b = new Map(fLast.founders.map(f => [f.name.toLowerCase(), f]));
    const out = [...a.values()].filter(f => !b.has(f.name.toLowerCase())).map(f => `вийшов ${f.name}`);
    const inn = [...b.values()].filter(f => !a.has(f.name.toLowerCase())).map(f => {
      const o = owners.find(x => x.name.toLowerCase() === f.name.toLowerCase());
      return `увійшов ${f.name}${o && o.share !== null ? ` (${String(o.share).replace('.', ',')} %)` : ''}`;
    });
    const share = [...b.values()].filter(f => a.has(f.name.toLowerCase()) && a.get(f.name.toLowerCase())!.capital !== f.capital).map(f => `змінено частку ${f.name}`);
    const all3 = [...out, ...inn, ...share];
    if (all3.length) { ownersAt = fLast.at; ownersWhat = all3.join(', '); }
  }
  return { capital, owners, bens, benNote, director, ownersAt, ownersWhat, dirAt, dirWhat };
}

/**
 * Повторна (планова) перевірка — без «історії змін» (економія транзакції): зміни власників і директора бачимо, порівнюючи
 * з попередньою перевіркою. Незмінне — переносимо з попередньої (там дати зі «історії» першої, повної перевірки).
 */
export function mergeOwnership(prev: Ownership | null, cur: Ownership | null, prevAt: string, now: Date): Ownership | null {
  if (!cur || !prev) return cur;
  const k = (o: Owner) => ownerKey(o);
  const pct = (n: number) => String(n).replace('.', ',');
  const a = new Map(prev.owners.map(o => [k(o), o])), b = new Map(cur.owners.map(o => [k(o), o]));
  const changes = [
    ...[...a.values()].filter(o => !b.has(k(o))).map(o => `вийшов ${o.name}`),
    ...[...b.values()].filter(o => !a.has(k(o))).map(o => `увійшов ${o.name}${o.share !== null ? ` (${pct(o.share)} %)` : ''}`),
    ...[...b.values()].filter(o => { const p = a.get(k(o)); return !!p && p.share !== null && o.share !== null && Math.abs(p.share - o.share) >= 0.01; })
      .map(o => `змінено частку ${o.name}: ${pct(a.get(k(o))!.share!)} → ${pct(o.share!)} %`),
  ];
  const between = `між перевірками ${dt(prevAt)} і ${dt(now)}`;
  const pd = prev.director?.name || '', cd = cur.director?.name || '';
  const dirChanged = !!pd && !!cd && pd.toLowerCase() !== cd.toLowerCase();
  const curSince = cur.director?.since && Date.parse(cur.director.since) > Date.parse(prevAt) ? cur.director.since : null;
  const director = cur.director ? { name: cur.director.name, since: dirChanged ? curSince || now.toISOString() : prev.director?.since || cur.director.since } : null;
  return {
    ...cur,
    director,
    ownersAt: changes.length ? now.toISOString() : prev.ownersAt,
    ownersWhat: changes.length ? `${changes.join(', ')} (${between})` : prev.ownersWhat,
    dirAt: dirChanged ? director!.since : prev.dirAt,
    dirWhat: dirChanged ? `${pd} → ${cd}${curSince ? '' : ` (${between})`}` : prev.dirWhat,
  };
}

/** Повний результат перевірки. */
export function subjectFrom(code: string, p: { usr: any; history: any; courts: { total: number; results: any[] } | null; enforcement: { total: number; results: any[] } | null; express: any },
  counts: OwnerCounts, now: Date, archived: boolean): CheckSubject {
  const base = baseFromUsr(code, p.usr);
  const courts = base.fop ? { cases: [], other: 0 } : parseCourts(p.courts, now);
  const ex = parseExpress(p.express);
  return {
    ...base,
    state: s(p.usr?.status),
    own: base.fop ? null : parseOwnership(p.usr, p.history, counts, base.reg),
    yc: { cases: courts.cases, other: courts.other, enf: parseEnforcement(p.enforcement), express: ex.facts, index: ex.index, checkedAt: now.toISOString(), archived },
  };
}
