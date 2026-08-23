/**
 * 🔌 ЗАПИС СТАРТУ ПРОЦЕСУ — щоб «нас перезапустило» перестало бути невидимим.
 *
 * 🔴 ПРИВІД. Досі система не знала, що рестарт БУВ. `process.uptime()` живе в
 * памʼяті того самого процесу, тож після падіння він каже «я щойно стартував» і
 * нічого більше; `uncaughtException`/`unhandledRejection` лише пишуть у лог і
 * навмисно ТРИМАЮТЬ процес живим. Крах із респавном не лишав ЖОДНОГО сліду —
 * рівно той клас «порожнеча читається як норма», що дав нам «успіх за 0 мс».
 *
 * 🔴 КРАХ І ВИКАТ РОЗРІЗНЯЮТЬСЯ ЗА sha (рішення власника 21.08.2026). Рестарт із
 * НОВИМ sha — це плановий викат, який ми щойно зробили самі; кричати про нього
 * означало б слати фальшиву аварію на КОЖЕН деплой, а канал, що бреше кілька
 * разів на тиждень, глушать — і далі він мовчить уже назавжди. Тривога лише коли
 * sha ТОЙ САМИЙ: процес пішов і піднявся, а коду ніхто не міняв.
 *
 * 🔴 АЛЕ НАШ ВЛАСНИЙ МЕТОД ДЕПЛОЮ sha НЕ МІНЯЄ (23.08.2026). Ми збираємо на місці
 * й перезапускаємо процес, тож `prevSha === sha` — і за добу `app_boot` показав
 * `deploy 1, crash 17`, тобто кожен наш викат приходив користувачам як «АВАРІЯ».
 * Тому другий сигнал: заявлений НАМІР (`deploy_intent`), який ставиться ПЕРЕД
 * `kill` командою `node dist/tools/markDeploy.js`.
 *
 * 🔴 НАМІР ЗАБИРАЄ РІВНО ОДИН СТАРТ, а не мовчить усе вікно. «Вікно тиші» мало б
 * дірку саме там, де болить: петля рестартів, що почалась усередині викату, була
 * б невидима — а ми таку петлю щойно пережили (16 стартів за 16 хвилин). Тобто
 * лічильник, а не таймер.
 */
import { pool } from "../db/pool.js";
import { buildVersion } from "../version.js";

import {
  classifyBoot, BOOT_FRESH_MIN, DEPLOY_INTENT_MIN, summarizeRestarts, BOOT_LOOP_MIN,
  type BootKind, type ClaimedIntent, type RestartBurst,
} from "./alertRules.js";
export { classifyBoot, BOOT_FRESH_MIN, DEPLOY_INTENT_MIN, summarizeRestarts, BOOT_LOOP_MIN };
export type { BootKind, ClaimedIntent, RestartBurst };

/**
 * Забрати найсвіжіший НЕзабраний намір викату. `null` — забирати нема чого.
 *
 * 🔴 ЗАБИРАННЯ АТОМАРНЕ (`UPDATE … RETURNING`), а не «прочитати → вирішити →
 * позначити». Між читанням і позначенням поміщається другий процес, і обидва
 * вважали б себе плановим викатом — тобто рівно петля, яку ми й ловимо, стала б
 * невидимою. `SKIP LOCKED` тут не оптимізація: без нього другий старт ЧЕКАВ би
 * на блокуванні замість того, щоб чесно піти в `crash`.
 *
 * ⚠️ Стеля часу тут НЕ перевіряється навмисно: протермінований намір теж треба
 * забрати (він мертвий і має зникнути з черги), а рішення «мовчати чи ні» —
 * робота чистої `classifyBoot`, яку можна перевірити без БД.
 */
async function claimDeployIntent(): Promise<{ id: number; expiresAt: Date } | null> {
  try {
    const r = await pool.query<{ id: string; expires_at: Date }>(
      `UPDATE deploy_intent SET consumed_at = now()
        WHERE id = (SELECT id FROM deploy_intent WHERE consumed_at IS NULL
                     ORDER BY created_at DESC LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING id, expires_at`);
    const row = r.rows[0];
    return row ? { id: Number(row.id), expiresAt: row.expires_at } : null;
  } catch (e) {
    // 🔴 ГУЧНО, АЛЕ НЕ ФАТАЛЬНО. Немає таблиці (схема не накотилась) — журнал
    // стартів мусить вестись далі, просто без наміру: наші викати знову
    // прийдуть як `crash`. Це шумно і помітно — саме те, що треба; тихо
    // «мовчати про все» було б набагато гірше.
    console.error("claimDeployIntent failed (намір викату не читається):", e);
    return null;
  }
}

export interface BootRecord {
  id: number;
  kind: BootKind;
  bootedAt: Date;
  shortSha: string;
  prevBootedAt: Date | null;
  prevSha: string | null;
  /** Скільки процес прожив до цього старту, хв. `null`, якщо попереднього немає. */
  prevUptimeMin: number | null;
}

/**
 * Записати старт. Викликається РАЗ на процес, одразу після підйому.
 *
 * ⚠️ Ніколи не кидає: збій журналу стартів не має права завадити застосунку
 * піднятись. Але й не мовчить — пише в лог, бо «журнал не ведеться» це теж стан,
 * про який треба знати.
 */
export async function recordBoot(): Promise<BootRecord | null> {
  const { sha, shortSha } = buildVersion();
  try {
    const prev = (await pool.query<{ sha: string; booted_at: Date }>(
      `SELECT sha, booted_at FROM app_boot ORDER BY booted_at DESC LIMIT 1`
    )).rows[0] ?? null;
    const claimed = await claimDeployIntent();
    const kind = classifyBoot(prev?.sha, sha, claimed);
    const r = await pool.query<{ id: string; booted_at: Date }>(
      `INSERT INTO app_boot (sha, short_sha, prev_booted_at, prev_sha, kind)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, booted_at`,
      [sha, shortSha, prev?.booted_at ?? null, prev?.sha ?? null, kind]
    );
    const row = r.rows[0];
    const prevUptimeMin = prev
      ? Math.round((row.booted_at.getTime() - prev.booted_at.getTime()) / 60000)
      : null;
    if (claimed) {
      await pool.query(`UPDATE deploy_intent SET consumed_boot_id = $1 WHERE id = $2`,
        [row.id, claimed.id]).catch((e) => console.error("consumed_boot_id не записано:", e));
    }
    const msg = kind === "crash"
      ? `🚨 app_boot: НЕСПОДІВАНИЙ РЕСТАРТ (sha ${shortSha} не змінився, попередній старт ${prevUptimeMin} хв тому)`
      : kind === "deploy-intent"
        ? `app_boot: старт ${shortSha}, тип deploy-intent (намір #${claimed?.id} забрано)`
        : `app_boot: старт ${shortSha}, тип ${kind}`;
    if (kind === "crash") console.error(msg); else console.log(msg);
    return { id: Number(row.id), kind, bootedAt: row.booted_at, shortSha,
      prevBootedAt: prev?.booted_at ?? null, prevSha: prev?.sha ?? null, prevUptimeMin };
  } catch (e) {
    console.error("recordBoot failed (журнал стартів не ведеться):", e);
    return null;
  }
}
