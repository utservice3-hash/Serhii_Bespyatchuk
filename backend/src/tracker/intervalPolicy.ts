/**
 * 🔒 ПРАВИЛА ПРИЙОМУ ІНТЕРВАЛУ — чиста логіка, БЕЗ жодного імпорту.
 *
 * Винесено з `routes/tracker.ts` з тієї самої причини, що й `auth/routeTab.ts`:
 * роут тягне `db/pool.js` → `config.js`, який кидає без `DATABASE_URL` ще НА ІМПОРТІ.
 * Поки правила жили в роуті, перевірити їх можна було лише проти живої БД — тобто
 * в прод-режимі, тобто майже ніколи. А скіп, який ніколи не виконується, ми вже
 * проходили на #8.
 *
 * 🔴 ГОЛОВНЕ ПРАВИЛО ЦЬОГО МОДУЛЯ: відкидання НЕ МОВЧИТЬ. Кожна відмова має причину,
 * і причина доїжджає до агента. Раніше `cleanInterval` повертав `null` на будь-яку
 * біду, а відповідь містила самий `accepted` — тож агент не міг відрізнити «сервер
 * прийняв 3 з 5» від «я надіслав 3». Найдорожче це вилізло б рівно тоді, коли ми
 * попросили склеювати інтервали: склеєні понад межу зникали б, і ніхто б не помітив.
 */

/** Конфіг, за яким приймаємо. Форма дублює `AppSettings.tracker` (тут без імпорту). */
export interface IntervalPolicy {
  maxIntervalSec: number;
  maxClockSkewSec: number;
  sendTitles: boolean;
}

export interface CleanInterval {
  startedAt: Date;
  endedAt: Date;
  state: "active" | "idle";
  app: string | null;
  /** ХОСТ активної вкладки — не URL і не шлях. */
  source: string | null;
  windowTitle: string | null;
  inputEvents: number | null;
}

/** Чому інтервал не прийнято. Ці ж ключі їдуть у відповідь `/heartbeat`. */
export interface RejectCounts {
  /** Довший за `maxIntervalSec` — імовірно склеєно понад оголошену межу. */
  tooLong: number;
  /** Структурно битий: немає дат, `ended <= started`, невідомий `state`. */
  badShape: number;
  /** Перетинається з попереднім у тому ж батчі. */
  overlapping: number;
  /** Годинник клієнта розійшовся із серверним понад `maxClockSkewSec`. */
  clockSkew: number;
}
export const emptyRejects = (): RejectCounts => ({ tooLong: 0, badShape: 0, overlapping: 0, clockSkew: 0 });

export type CleanResult = { ok: CleanInterval } | { bad: keyof RejectCounts };

/**
 * З будь-якого рядка лишає ЛИШЕ хост:
 *   `https://kommo.com/leads/detail/12345?x=1` → `kommo.com`
 *
 * 🔴 Умова власника: архіву того, які сторінки люди відкривають, ми не створюємо.
 * Відрізати шлях має АГЕНТ до відправки — що не поїхало мережею, те не витече з
 * логів. Тут другий рубіж: старий або чужий клієнт не має обходити політику.
 */
export function hostOnly(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  try {
    const h = new URL(v.includes("://") ? v : `https://${v}`).hostname.replace(/^www\./, "");
    return h.slice(0, 120) || null;
  } catch {
    // Не URL (напр. назва застосунку) — беремо перший сегмент до слеша, щоб шлях
    // не проліз навіть із кривого рядка.
    return v.split("/")[0].slice(0, 120) || null;
  }
}

/** Валідує ОДИН інтервал і КАЖЕ, чому відхилив. `nowMs` — серверний час. */
export function cleanInterval(it: unknown, cfg: IntervalPolicy, nowMs: number): CleanResult {
  if (!it || typeof it !== "object") return { bad: "badShape" };
  const o = it as Record<string, unknown>;
  const s = typeof o.startedAt === "string" ? Date.parse(o.startedAt) : NaN;
  const e = typeof o.endedAt === "string" ? Date.parse(o.endedAt) : NaN;
  if (!Number.isFinite(s) || !Number.isFinite(e)) return { bad: "badShape" };
  if (e <= s) return { bad: "badShape" };
  if (o.state !== "active" && o.state !== "idle") return { bad: "badShape" };
  if (e - s > cfg.maxIntervalSec * 1000) return { bad: "tooLong" };
  // 🕰 ГОДИННИК КЛІЄНТА. Мітки приходять із машини користувача, і досі їх ніхто не
  // звіряв із реальністю: ноутбук зі збитим годинником поклав би роботу в чужу добу,
  // а «Час у роботі» показав би нічні зміни, яких не було. Дивимось на ОБИДВА кінці —
  // майбутнє ловиться так само, як минуле.
  const skew = cfg.maxClockSkewSec * 1000;
  if (Math.abs(s - nowMs) > skew || Math.abs(e - nowMs) > skew) return { bad: "clockSkew" };
  return {
    ok: {
      startedAt: new Date(s),
      endedAt: new Date(e),
      state: o.state,
      app: typeof o.app === "string" ? o.app.slice(0, 200) : null,
      source: typeof o.source === "string" ? hostOnly(o.source) : null,
      // Заголовок беремо, ЛИШЕ якщо його свідомо ввімкнули. Не зберігаємо навіть те,
      // що прийшло само: старий агент не має обходити політику приватності.
      windowTitle: cfg.sendTitles && typeof o.windowTitle === "string" ? o.windowTitle.slice(0, 300) : null,
      inputEvents: Number.isInteger(o.inputEvents) ? (o.inputEvents as number) : null,
    },
  };
}

/**
 * Розбирає ВЕСЬ батч: чистить, сортує, знімає перетини — і рахує КОЖНУ відмову.
 * Повертає рівно те, що піде в БД, плюс облік, який поїде агенту.
 */
export function acceptBatch(raw: unknown[], cfg: IntervalPolicy, nowMs: number): {
  toInsert: CleanInterval[]; rejected: RejectCounts;
} {
  const rejected = emptyRejects();
  const cand: CleanInterval[] = [];
  for (const it of raw) {
    const r = cleanInterval(it, cfg, nowMs);
    if ("bad" in r) rejected[r.bad]++;
    else cand.push(r.ok);
  }
  cand.sort((a, b) => +a.startedAt - +b.startedAt);
  const toInsert: CleanInterval[] = [];
  let lastEnd = -Infinity;
  for (const c of cand) {
    if (+c.startedAt < lastEnd) { rejected.overlapping++; continue; }
    toInsert.push(c);
    lastEnd = +c.endedAt;
  }
  return { toInsert, rejected };
}
