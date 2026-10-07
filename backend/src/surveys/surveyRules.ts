/**
 * 📋 Правила опитувань — чисті функції з роуту пакета Сергія (`validate`, `hasValue`), винесені, щоб гейти ганяли
 * РІВНО їх, без бази. Тексти відмов — із макета (`validateC`), показуються людині як є.
 */
import type { Question } from './surveyResults.js';
import type { Audience } from './surveyStore.js';

/** Анонімність: розріз показується лише від 3 відповідей (README пакета §7). */
export const MIN_SLICE = 3;

/** Картинка до питання: у пакеті — «файл у вашому сховищі»; у нас dataURL JPEG/PNG, стиснутий фронтом до 900px. */
export const MAX_IMAGE_CHARS = 700_000;
export function cleanImage(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  if (!/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(v)) return null;
  return v.length <= MAX_IMAGE_CHARS ? v : null;
}

/** Імʼя людини для списків «хто відповів / хто ні» й CSV — і для звільнених (їх немає в `PEOPLE_SQL`). */
export const NAME_SQL = `
  SELECT u.id, COALESCE(m.name, e.full_name, u.full_name, u.email) AS name
    FROM users u
    LEFT JOIN managers m ON m.id = u.manager_id
    LEFT JOIN LATERAL (SELECT full_name FROM employees e WHERE e.user_id = u.id ORDER BY e.id DESC LIMIT 1) e ON true`;

export function hasValue(q: Question, v: unknown): boolean {
  if (v === undefined || v === null || v === '') return false;
  if (q.type === 'multi') return Array.isArray(v) && v.length > 0;
  if (q.type === 'matrix') return !!v && typeof v === 'object' && !Array.isArray(v) && q.rows.every((r) => typeof (v as Record<string, unknown>)[r] === 'number');
  if (q.type === 'rank') return Array.isArray(v) && v.length === q.options.length;
  if (q.type === 'scale' || q.type === 'enps') return typeof v === 'number' && v >= q.min && v <= q.max;
  return true;
}

/** Ті самі гейти, що в макеті (validateC). */
export function validateSurvey(b: { title?: string; questions?: Question[]; audience?: Audience; due?: string | Date | null; anon?: boolean }, forLaunch = false, now = new Date()): string | null {
  if (!b.title?.trim()) return 'Вкажіть назву опитування.';
  if (!forLaunch) return null;
  const qs = b.questions || [];
  if (!qs.length) return 'Додайте хоча б одне питання.';
  for (const [i, q] of qs.entries()) {
    if (!q.text?.trim()) return `Питання ${i + 1} без тексту.`;
    if ((q.type === 'single' || q.type === 'multi' || q.type === 'rank') && (q.options || []).filter((o) => o.trim()).length < 2) return `Питання ${i + 1}: потрібно щонайменше два варіанти.`;
    if (q.type === 'matrix' && (q.rows || []).filter((o) => o.trim()).length < 2) return `Питання ${i + 1}: матриці потрібно щонайменше два рядки.`;
    if ((q.type === 'scale' || q.type === 'matrix') && !(q.max > q.min)) return `Питання ${i + 1}: шкала має бути від меншого до більшого.`;
  }
  if (!b.audience || (b.audience.kind === 'custom' && !(b.audience.ids || []).length)) return 'Оберіть, кому надіслати.';
  if (b.audience.kind === 'team' && !b.audience.team) return 'Оберіть команду.';
  if (!b.due) return 'Вкажіть дедлайн.';
  if (new Date(b.due) < now) return 'Дедлайн уже минув — оберіть майбутню дату.';
  return null;
}
