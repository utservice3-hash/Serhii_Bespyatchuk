/**
 * 🔔 ПРАВИЛА ПОДАЧІ ТРИВОГ — БЕЗ ЖОДНОГО ІМПОРТУ (крім `import type`, який
 * стирається при компіляції).
 *
 * ⚠️ ЧОМУ ОКРЕМИЙ ФАЙЛ. `alertPush.ts` тягне `db/pool.js` → `config.js`, який
 * кидає на відсутньому `DATABASE_URL`/`JWT_SECRET` ще НА ІМПОРТІ — тобто раніше,
 * ніж встигне спрацювати `skip`. Гейт на форматування впав би не через помилку в
 * форматуванні, а тому, що не зміг завантажитись. Це вже четвертий випадок тієї
 * самої пастки в проєкті (`monitoredJobs.ts` виділяли рівно з цієї причини), тож
 * дані й правила відокремлені від зʼєднання одразу.
 */
import type { Alert } from "../health/alerts.js";

/** Повтор чинної тривоги — не частіше ніж раз на стільки хвилин. */
export const REPEAT_AFTER_MIN = 360;

/**
 * 🔴 `build:stale` ПОВТОРЮЄТЬСЯ ЧАСТІШЕ — і це не «важливіше», а ІНША ФОРМА
 * інциденту. Вікно між збіркою й рестартом коротке (рестарт прода — зовнішня
 * залежність, чужий час відповіді), тож нагадування раз на 6 год прийшло б уже
 * після того, як усе минуло, — тобто марно. Наполегливість дає інтервал, а не
 * підвищений рівень тривоги.
 */
const REPEAT_OVERRIDE: { match: RegExp; min: number }[] = [
  { match: /^build:stale$/, min: 30 },
];

export function repeatAfterMin(id: string): number {
  return REPEAT_OVERRIDE.find((r) => r.match.test(id))?.min ?? REPEAT_AFTER_MIN;
}

/**
 * ТОЧКОВІ ПОДІЇ — ті, що НЕ «тривають», а сталися. Для них відбій не шлеться:
 * «✅ несподіваний рестарт відновився» — беззмістовна фраза, а канал, у якому
 * трапляються беззмістовні фрази, читають гірше.
 */
export function isPointEvent(id: string): boolean {
  return id.startsWith("app:restart:");
}

/** Людське «скільки тривало» — без бібліотек і без «0 хв» для миттєвих подій. */
export function humanDuration(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60000));
  if (min < 60) return `${min} хв`;
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 24) return m ? `${h} год ${m} хв` : `${h} год`;
  const d = Math.floor(h / 24);
  return `${d} дн ${h % 24} год`;
}

const ICON = (s: string) => (s === "critical" ? "🔴" : "🟡");

/**
 * Текст тривоги. `action` обовʼязковий і мусить ДОЇХАТИ В ТЕКСТ — тривогу без
 * «що робити» читають один раз, далі ігнорують. Тримає `#112`.
 */
export function formatAlert(a: Alert, repeat: { since: Date; count: number } | null): string {
  const head = repeat
    ? `${ICON(a.severity)} <b>ВСЕ ЩЕ: ${a.title}</b>\nТриває ${humanDuration(Date.now() - repeat.since.getTime())}`
      + ` (нагадування #${repeat.count}).`
    : `${ICON(a.severity)} <b>${a.title}</b>`;
  return `${head}\n${a.detail}\n\n▶️ <b>Що робити:</b> ${a.action}`;
}

export function formatResolved(title: string, since: Date): string {
  return `✅ <b>Відновилось:</b> ${title}\nІнцидент тривав ${humanDuration(Date.now() - since.getTime())}.`;
}

export type BootKind = "first" | "deploy" | "crash";

/**
 * 🔴 КРАХ І ВИКАТ РОЗРІЗНЯЮТЬСЯ ЗА sha (рішення власника 21.08.2026). Рестарт із
 * НОВИМ sha — плановий викат, який ми щойно зробили самі; кричати про нього
 * означало б слати фальшиву аварію на КОЖЕН деплой, а алерт, що регулярно бреше,
 * вимикають — і разом із ним вимикають справжні.
 */
export function classifyBoot(prevSha: string | null | undefined, sha: string): BootKind {
  if (!prevSha) return "first";
  return prevSha === sha ? "crash" : "deploy";
}

/** Скільки хвилин вважаємо старт «свіжим» — рівно стільки тривога й видима. */
export const BOOT_FRESH_MIN = 60;
