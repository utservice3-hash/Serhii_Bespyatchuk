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
 */
import { pool } from "../db/pool.js";
import { buildVersion } from "../version.js";

import { classifyBoot, BOOT_FRESH_MIN, type BootKind } from "./alertRules.js";
export { classifyBoot, BOOT_FRESH_MIN, type BootKind };

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
    const kind = classifyBoot(prev?.sha, sha);
    const r = await pool.query<{ id: string; booted_at: Date }>(
      `INSERT INTO app_boot (sha, short_sha, prev_booted_at, prev_sha, kind)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, booted_at`,
      [sha, shortSha, prev?.booted_at ?? null, prev?.sha ?? null, kind]
    );
    const row = r.rows[0];
    const prevUptimeMin = prev
      ? Math.round((row.booted_at.getTime() - prev.booted_at.getTime()) / 60000)
      : null;
    const msg = kind === "crash"
      ? `🚨 app_boot: НЕСПОДІВАНИЙ РЕСТАРТ (sha ${shortSha} не змінився, попередній старт ${prevUptimeMin} хв тому)`
      : `app_boot: старт ${shortSha}, тип ${kind}`;
    if (kind === "crash") console.error(msg); else console.log(msg);
    return { id: Number(row.id), kind, bootedAt: row.booted_at, shortSha,
      prevBootedAt: prev?.booted_at ?? null, prevSha: prev?.sha ?? null, prevUptimeMin };
  } catch (e) {
    console.error("recordBoot failed (журнал стартів не ведеться):", e);
    return null;
  }
}
