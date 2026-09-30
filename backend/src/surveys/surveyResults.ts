/**
 * Агрегації результатів — порт математики затвердженого макета (v2).
 * Чисті функції над масивами відповідей; БД не торкаються (роут читає рядки й передає сюди).
 * Еталони чисел зняті з макета: tests/surveyResults.test.ts.
 *
 * Анонімність тут НЕ вирішується — це відповідальність роуту: для анонімних опитувань
 * відповіді приходять без user_id, а розрізи по групах роут віддає лише від 3 відповідей.
 */
import type { QType } from './surveyParser.js';

export interface Question { id: string | number; text: string; type: QType; options: string[]; rows: string[]; min: number; max: number; required: boolean; hint?: string; image?: string | null }
export type AnswerValue = string | number | string[] | Record<string, number>;
export interface ResponseRow { id?: string | number; userId: string | null; role?: string; team?: string; at: string; answers: Record<string, AnswerValue> }

export const avgOf = (nums: number[]) => nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
export const round1 = (x: number) => Math.round(x * 10) / 10;

/** eNPS: прихильники 9–10, нейтральні 7–8, критики 0–6; індекс = %прихильників − %критиків (ціле). */
export function enpsOf(nums: number[]) {
  const n = nums.length; if (!n) return { score: null as number | null, p: 0, n0: 0, d: 0, n };
  const p = nums.filter(v => v >= 9).length, d = nums.filter(v => v <= 6).length;
  return { score: Math.round(100 * (p - d) / n), p, n0: n - p - d, d, n };
}

const valuesOf = (q: Question, rs: ResponseRow[]) =>
  rs.map(r => r.answers[String(q.id)]).filter(v => v !== undefined && v !== '' && v !== null) as AnswerValue[];

export type QuestionResult =
  | { type: 'choice'; n: number; bars: Array<{ label: string; count: number; pct: number }> }
  | { type: 'scale'; n: number; avg: number | null; bins: Array<{ value: number; count: number }> }
  | { type: 'enps'; n: number; avg: number | null; score: number | null; p: number; n0: number; d: number; bins: Array<{ value: number; count: number }> }
  | { type: 'matrix'; n: number; rows: Array<{ label: string; avg: number | null; n: number }> }
  | { type: 'rank'; n: number; order: Array<{ label: string; avgPos: number | null; n: number }> }
  | { type: 'text'; n: number; items: Array<{ text: string; userId: string | null; at: string }> };

/** Один блок результатів по питанню — ті самі числа, що показує макет (pct округлено як у макеті). */
export function aggregateQuestion(q: Question, rs: ResponseRow[]): QuestionResult {
  const vals = valuesOf(q, rs);
  if (q.type === 'single' || q.type === 'multi') {
    const base = vals.length || 1;
    return { type: 'choice', n: vals.length, bars: q.options.map(o => {
      const count = vals.filter(v => Array.isArray(v) ? v.includes(o) : v === o).length;
      return { label: o, count, pct: Math.round(100 * count / base) };
    }) };
  }
  if (q.type === 'scale' || q.type === 'enps') {
    const nums = vals.map(Number).filter(v => !isNaN(v));
    const bins: Array<{ value: number; count: number }> = [];
    for (let v = q.min; v <= q.max; v++) bins.push({ value: v, count: nums.filter(x => x === v).length });
    const avg = avgOf(nums);
    if (q.type === 'enps') { const e = enpsOf(nums); return { type: 'enps', n: nums.length, avg, score: e.score, p: e.p, n0: e.n0, d: e.d, bins }; }
    return { type: 'scale', n: nums.length, avg, bins };
  }
  if (q.type === 'matrix') {
    return { type: 'matrix', n: vals.length, rows: q.rows.map(r => {
      const nums = vals.map(v => (v && typeof v === 'object' && !Array.isArray(v)) ? (v as Record<string, number>)[r] : undefined).filter((x): x is number => typeof x === 'number');
      return { label: r, avg: avgOf(nums), n: nums.length };
    }) };
  }
  if (q.type === 'rank') {
    const order = q.options.map(o => {
      const ps = vals.filter(Array.isArray).map(v => (v as string[]).indexOf(o) + 1).filter(k => k > 0);
      return { label: o, avgPos: avgOf(ps), n: ps.length };
    }).sort((a, b) => (a.avgPos ?? 99) - (b.avgPos ?? 99));
    return { type: 'rank', n: vals.length, order };
  }
  return { type: 'text', n: vals.length, items: rs.filter(r => r.answers[String(q.id)]).map(r => ({ text: String(r.answers[String(q.id)]), userId: r.userId, at: r.at })) };
}

/** Одне число на питання для тренду між випусками (null — де числа немає сенсу: multi/text/rank). */
export function questionMetric(q: Question, rs: ResponseRow[]): { v: number; lbl: string; kind: 'avg' | 'enps' | 'pct' } | null {
  const vals = valuesOf(q, rs);
  if (!vals.length) return null;
  if (q.type === 'scale') return { v: avgOf(vals.map(Number))!, lbl: 'середнє', kind: 'avg' };
  if (q.type === 'enps') return { v: enpsOf(vals.map(Number)).score!, lbl: 'eNPS', kind: 'enps' };
  if (q.type === 'matrix') { const all = vals.flatMap(v => q.rows.map(r => (v as Record<string, number>)[r]).filter(x => typeof x === 'number')); const a = avgOf(all); return a === null ? null : { v: a, lbl: 'середнє по рядках', kind: 'avg' }; }
  if (q.type === 'single' && q.options.length) { const top = q.options[0]; return { v: 100 * vals.filter(v => v === top).length / vals.length, lbl: '«' + top + '»', kind: 'pct' }; }
  return null;
}
export const fmtMetric = (m: { v: number; kind: 'avg' | 'enps' | 'pct' }) =>
  m.kind === 'avg' ? m.v.toFixed(1) : m.kind === 'enps' ? (m.v > 0 ? '+' : '') + m.v : Math.round(m.v) + '%';

export interface IssueData { issue: number; status: string; closedAt?: string | null; assignedCount: number; respondedCount: number; questions: Question[]; responses: ResponseRow[] }

/** Динаміка по випусках: участь + метрика на питання з дельтою проти попереднього випуску. */
export function trend(current: Question[], issues: IssueData[]) {
  const cols = issues.slice().sort((a, b) => a.issue - b.issue);
  const participation = cols.map(c => ({ issue: c.issue, pct: Math.round(100 * c.respondedCount / (c.assignedCount || 1)), responded: c.respondedCount, assigned: c.assignedCount }));
  const rows = current.map((q, i) => {
    const cells = cols.map(c => {
      const q2 = c.questions.find(z => String(z.id) === String(q.id)) || c.questions.find(z => z.text === q.text) || c.questions[i];
      return q2 ? questionMetric(q2, c.responses) : null;
    });
    if (cells.every(c => !c)) return null;
    const lbl = cells.find(Boolean)!.lbl;
    return { questionId: q.id, text: q.text, lbl, cells: cells.map((c, k) => {
      if (!c) return null;
      const prev = k > 0 && cells[k - 1] ? cells[k - 1]!.v : null;
      const delta = prev === null ? null : c.v - prev;
      return { v: c.v, out: fmtMetric(c), delta: delta !== null && Math.abs(delta) >= 0.05 ? delta : null, deltaOut: delta !== null && Math.abs(delta) >= 0.05 ? fmtMetric({ v: Math.abs(delta), kind: c.kind }) : null };
    }) };
  }).filter(Boolean);
  return { participation, rows };
}

/** Підсумок адміну при закритті — той самий рядок, що в дзвіночку макета. */
export function closeSummary(title: string, questions: Question[], rs: ResponseRow[], assignedCount: number, respondedCount: number): string {
  const bits: string[] = [];
  questions.forEach(q => {
    const vals = valuesOf(q, rs);
    if (!vals.length) return;
    if (q.type === 'scale') bits.push(`середня ${(vals.map(Number).reduce((a, b) => a + b, 0) / vals.length).toFixed(1)} з ${q.max}`);
    if (q.type === 'enps') { const e = enpsOf(vals.map(Number)); bits.push(`eNPS ${e.score! > 0 ? '+' : ''}${e.score}`); }
  });
  const n = assignedCount || 1;
  return `Закрито «${title}»: відповіли ${respondedCount}/${n} (${Math.round(100 * respondedCount / n)}%)${bits.length ? ' · ' + bits.join(' · ') : ''}`;
}

/** CSV для Excel (роздільник «;», лапки, матриця «рядок: значення», ранжування «1. …»). Додайте BOM ﻿ перед віддачею. */
export function csvFor(anon: boolean, questions: Question[], rs: ResponseRow[], userName: (id: string | null) => string, roleLabel: (r?: string) => string, fmtTime: (iso: string) => string): string {
  const cell = (v: unknown) => '"' + String(Array.isArray(v) ? v.join('; ') : (v && typeof v === 'object') ? Object.entries(v as Record<string, number>).map(([k, x]) => k + ': ' + x).join('; ') : (v ?? '')).replace(/"/g, '""') + '"';
  const head = ['Респондент', 'Роль', 'Час', ...questions.map((q, i) => `${i + 1}. ${q.text}`)].map(cell).join(';');
  const rows = rs.map(r => [anon ? 'анонімно' : userName(r.userId), roleLabel(r.role), fmtTime(r.at),
    ...questions.map(q => { const v = r.answers[String(q.id)]; return q.type === 'rank' && Array.isArray(v) ? v.map((x, i) => (i + 1) + '. ' + x).join('; ') : v; })].map(cell).join(';'));
  return [head, ...rows].join('\r\n');
}
