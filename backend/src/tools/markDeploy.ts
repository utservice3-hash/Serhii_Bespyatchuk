/**
 * 🔌 ЗАЯВИТИ НАМІР ВИКАТУ — запускається НА СЕРВЕРІ безпосередньо ПЕРЕД `kill`.
 *
 * 🔴 ПРИВІД (23.08.2026). Наш метод деплою не міняє sha: збірка на місці +
 * `kill -TERM` + респавн конвеєром. Для `classifyBoot` це «процес пішов і
 * піднявся без нашої участі», тобто КОЖЕН викат приходив банером «АВАРІЯ».
 * Алерт, що бреше на кожному деплої, вимикають — а разом із ним і справжні.
 *
 * 🔴 НАМІР ЗАБИРАЄ РІВНО ОДИН СТАРТ. Це не «вікно тиші»: другий і подальші
 * старти в тому самому вікні знову класифікуються як `crash`, тож петля
 * рестартів, що почалась усередині викату, лишається видимою. Саме цю дірку
 * ми й закривали.
 *
 * Запуск:
 *   node dist/tools/markDeploy.js                      # 15 хв, без примітки
 *   node dist/tools/markDeploy.js --minutes=10 --note="викат 1a2b3c4"
 *
 * ⚠️ Ставити ПЕРЕД kill, а не після: після kill процес уже піднявся і намір
 * забирати нікому — він просто провисить до `expires_at` і згорить.
 */
import { pool } from "../db/pool.js";
import { DEPLOY_INTENT_MIN } from "../jobs/alertRules.js";

function arg(name: string): string | null {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  return p ? p.slice(name.length + 3) : null;
}

async function main(): Promise<void> {
  const rawMin = arg("minutes");
  const minutes = rawMin == null ? DEPLOY_INTENT_MIN : Number(rawMin);
  // Порожній/від'ємний строк зробив би намір мертвим ще до запису — і викат
  // усе одно прийшов би аварією, але вже «з наміром», тобто заплутано.
  if (!Number.isFinite(minutes) || minutes <= 0) {
    console.error(`🔴 --minutes має бути додатним числом, отримано «${rawMin}»`);
    process.exit(1);
  }
  const note = arg("note");
  const by = process.env.USER ?? process.env.LOGNAME ?? "unknown";

  const r = await pool.query<{ id: string; expires_at: Date }>(
    `INSERT INTO deploy_intent (expires_at, note, created_by)
     VALUES (now() + ($1 || ' minutes')::interval, $2, $3)
     RETURNING id, expires_at`,
    [String(minutes), note, by]);

  const row = r.rows[0];
  console.log(`✅ намір викату #${row.id} заявлено на ${minutes} хв `
    + `(до ${row.expires_at.toISOString()}), автор ${by}`
    + (note ? `, примітка: ${note}` : ""));
  console.log("   Забере РІВНО ОДИН наступний старт; другий і далі знову будуть 'crash'.");
  await pool.end();
}

main().catch((e) => { console.error("markDeploy failed:", e); process.exit(1); });
