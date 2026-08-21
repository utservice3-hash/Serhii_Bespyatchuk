/**
 * 📮 ПОШТАР ТРИВОГ — під'єднує ГУДОК до наявного двигуна сигналізації.
 *
 * 🔴 ЩО ТУТ ЛІКУЄТЬСЯ. `health/alerts.ts` — повноцінний двигун: 8 перевірок,
 * правило «"не знаю" ≠ "добре"», стабільні `id`. І він був підключений РІВНО до
 * одного споживача — банера в дашборді. Тобто про поломку система казала лише
 * тому, хто САМ відкриє екран. Аварія 10.08.2026 тривала 14 год 52 хв саме так:
 * вартові справно кликали `sendAdminAlert`, а канал був не налаштований, і про
 * обидва простої власник дізнався, подивившись на екран.
 *
 * 🔴 ДЕТЕКТОРІВ НЕ ДОДАЄМО — ДОДАЄМО ВИХІД. Поштар кличе ТОЙ САМИЙ
 * `collectAlerts()`, що живить банер. Один вираз, два виходи: екран і телеграм
 * не можуть розійтися в тому, що вважати поломкою. Той самий прийом, що
 * `stuckSignals` і `createdKlassCase` — правило живе в одному місці, копій немає.
 *
 * 🔴 ДЕДУП — У БД, А НЕ В ПАМʼЯТІ. Наявні вартові дедуплять `Set`-ом, який
 * порожніє на рестарті. Половина наших тривог — ПРО падіння й рестарти, тобто
 * пам'ятний дедуп зникає рівно в аварії: канал отримує повторно всі чинні
 * тривоги, людина його глушить, і далі він мовчить назавжди. Тримає `#114`.
 */
import type { Alert } from "../health/alerts.js";
import { sendAdminAlert } from "../bot/notify.js";
import {
  REPEAT_AFTER_MIN, repeatAfterMin, isPointEvent, humanDuration, formatAlert, formatResolved,
} from "./alertRules.js";
// Ре-експорт, щоб споживачам не треба було знати про поділ «правила / зʼєднання».
export { REPEAT_AFTER_MIN, repeatAfterMin, isPointEvent, humanDuration, formatAlert, formatResolved };

export interface PushResult { sent: number; repeated: number; resolved: number; open: number }

/**
 * 🔌 ШОВ ДЛЯ ГЕЙТІВ. Прод кличе `alertPush()` без аргументів і отримує справжні
 * `collectAlerts` / `sendAdminAlert` / `pool`.
 *
 * 🔴 Шов зроблено ЯВНИМ, а не через підміну модуля: ESM-простір імен заморожений,
 * і monkey-patch тут просто не працює (на цьому вже витрачено прохід у `#77`).
 * Головне — `query` теж інжектується: інакше гейти дедупу довелось би писати на
 * ПЕРЕПИСАНОМУ вручну SQL, а це доказ ні про що (урок `#21c`). Так тести ганяють
 * ТОЙ САМИЙ текст запитів проти справжньої схеми.
 */
export interface PushDeps {
  collect: () => Promise<{ alerts: Alert[]; checksRan: number; checksDeclared: number }>;
  send: (text: string) => Promise<void>;
  query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
}

/**
 * Один тік поштаря.
 *
 * ⚠️ Кидає лише те, що справді робить роботу неможливою (недоступна БД) — тоді
 * `runJob` запише помилку, і мовчання поштаря стане видимим через `#115`.
 */
export async function alertPush(deps?: Partial<PushDeps>): Promise<PushResult> {
  // 🔴 ДЕФОЛТИ — ЛІНИВІ, І ЦЕ НЕ СТИЛЬ. `db/pool.js` і `health/alerts.js` тягнуть
  // `config.js`, який кидає на відсутньому DATABASE_URL/JWT_SECRET ще НА ІМПОРТІ.
  // Статичний імпорт зробив би шов марним: гейт, що підставляє власні залежності і
  // до БД узагалі не ходить, все одно падав би на завантаженні модуля. Саме так він
  // і впав на першому прогоні — перевірено, не припущено.
  const collect = deps?.collect ?? (async () => (await import("../health/alerts.js")).collectAlerts());
  const send = deps?.send ?? sendAdminAlert;
  const query: PushDeps["query"] = deps?.query ?? (async <T>(sql: string, params?: unknown[]) => {
    const { pool } = await import("../db/pool.js");
    return await pool.query(sql, params) as unknown as { rows: T[] };
  });

  const state = await collect();
  const now = state.alerts;
  const byId = new Map(now.map((a) => [a.id, a]));

  const rows = (await query<{ id: string; title: string; first_seen_at: Date;
    last_sent_at: Date | null; sent_count: number; resolved_at: Date | null }>(
    `SELECT id, title, first_seen_at, last_sent_at, sent_count, resolved_at FROM alert_state`)).rows;
  const known = new Map(rows.map((r) => [r.id, r]));

  const res: PushResult = { sent: 0, repeated: 0, resolved: 0, open: now.length };

  for (const a of now) {
    const k = known.get(a.id);
    // Нова тривога АБО повторне відкриття закритого інциденту — новий епізод:
    // лічильники обнуляються, інакше «нагадування #7» стосувалося б минулої події.
    const isNewEpisode = !k || k.resolved_at != null;
    if (isNewEpisode) {
      await query(
        `INSERT INTO alert_state (id, severity, title, first_seen_at, last_seen_at, last_sent_at, sent_count,
                                  resolved_at, resolved_notified)
         VALUES ($1, $2, $3, now(), now(), now(), 1, NULL, false)
         ON CONFLICT (id) DO UPDATE SET severity = EXCLUDED.severity, title = EXCLUDED.title,
           first_seen_at = now(), last_seen_at = now(), last_sent_at = now(), sent_count = 1,
           resolved_at = NULL, resolved_notified = false`,
        [a.id, a.severity, a.title.slice(0, 300)]);
      await send(formatAlert(a, null));
      res.sent++;
      continue;
    }
    const dueMin = repeatAfterMin(a.id);
    const sentAgoMin = k.last_sent_at ? (Date.now() - k.last_sent_at.getTime()) / 60000 : Infinity;
    if (sentAgoMin >= dueMin) {
      await query(
        `UPDATE alert_state SET last_seen_at = now(), last_sent_at = now(),
                                sent_count = sent_count + 1, severity = $2, title = $3 WHERE id = $1`,
        [a.id, a.severity, a.title.slice(0, 300)]);
      await send(formatAlert(a, { since: k.first_seen_at, count: k.sent_count + 1 }));
      res.repeated++;
    } else {
      // 🔴 ТИХИЙ ТІК — ОСНОВНИЙ РЕЖИМ. Саме він відрізняє сигналізацію від спаму:
      // інцидент триває, ми про це знаємо, але людину не смикаємо. Тримає `#112b`.
      await query(`UPDATE alert_state SET last_seen_at = now() WHERE id = $1`, [a.id]);
    }
  }

  // ── ВІДБІЙ. Без нього людина не знає, чи тривога ще чинна, і за два тижні
  // перестає відкривати канал — тобто мовчазний «відновилось» коштує так само
  // дорого, як мовчазна поломка.
  for (const k of rows) {
    if (byId.has(k.id) || k.resolved_at != null) continue;
    await query(
      `UPDATE alert_state SET resolved_at = now(), resolved_notified = $2 WHERE id = $1`,
      [k.id, !isPointEvent(k.id)]);
    if (isPointEvent(k.id)) continue;
    await send(formatResolved(k.title, k.first_seen_at));
    res.resolved++;
  }

  if (res.sent || res.repeated || res.resolved) {
    console.log(`alertPush: нових ${res.sent}, повторів ${res.repeated}, відбоїв ${res.resolved}`
      + `, чинних ${res.open} (перевірок ${state.checksRan}/${state.checksDeclared}).`);
  }
  return res;
}
