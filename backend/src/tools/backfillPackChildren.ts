/**
 * ПЕРЕНЕСЕННЯ СТАРИХ ПАЧОК РЕАКТИВАЦІЇ У РЯДКИ-ДІТИ.
 *
 * 📐 Заміряно 05.09.2026 (прод, read-only): пачок `reactivation` з чеклістом — **37**,
 * елементів усередині — **347**, унікальних клієнтів — **249**, `client_key` заповнений
 * у **нуля**. Живих пачок (не `done`) — 26 із 288 елементами.
 *
 * 🔴 СТАН КОЖНОГО КЛІЄНТА ЗБЕРІГАЄТЬСЯ, А НЕ СПЛОЩУЄТЬСЯ. У чеклісті є прапорець `done`
 * на кожному елементі — саме він стає статусом дитини. Взяти статус батька на всіх
 * означало б переписати минуле: наполовину пройдена пачка виглядала б незайманою.
 *
 * ⚠️ ЦЕ ЗАПИС У БОЙОВУ ТАБЛИЦЮ ЗАДАЧ, І КОДОМ ВІН НЕ ВІДКОЧУЄТЬСЯ. Тому:
 *   · без `--apply` рахує й показує, нічого не пишучи;
 *   · ідемпотентний — пачку, в якої вже є діти, пропускає (тому повтор безпечний);
 *   · чекліст НЕ стирає: він лишається як слід того, з чого зроблено перенесення.
 *
 * Запуск: `node dist/tools/backfillPackChildren.js [--apply]`
 */
import { pool } from "../db/pool.js";
import { PACK_CHILD_SQL, PACK_DEPARTMENT } from "../core/reactivationPack.js";
import { normalizeClientName } from "../utils/clientName.js";

type Item = { clientKey?: string; clientName?: string; done?: boolean;
              orders?: number; revenue?: number; lastPaid?: string | null;
              category?: string; paymentType?: string | null };

export async function backfillPackChildren(apply: boolean): Promise<{
  packs: number; children: number; skippedNoKey: number; alreadyDone: number;
}> {
  const packs = (await pool.query<{ id: number; assignee_id: number | null; created_by: number | null;
                                    status: string; checklist: unknown }>(
    `SELECT t.id, t.assignee_id, t.created_by, t.status, t.checklist_json AS checklist
       FROM tasks t
      WHERE t.task_type = 'reactivation' AND jsonb_typeof(t.checklist_json) = 'array'
        AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = t.id)
      ORDER BY t.id`)).rows;

  let children = 0, skippedNoKey = 0, alreadyDone = 0;
  for (const p of packs) {
    const items = Array.isArray(p.checklist) ? (p.checklist as Item[]) : [];
    for (const it of items) {
      const raw = (it?.clientKey ?? "").trim();
      if (!raw) { skippedNoKey++; continue; }
      const key = normalizeClientName(raw) ?? raw;
      const status = it.done ? "done" : p.status === "done" ? "done" : "not_started";
      if (status === "done") alreadyDone++;
      children++;
      if (!apply) continue;
      await pool.query(
        PACK_CHILD_SQL,
        [it.clientName || key, p.assignee_id, p.created_by, PACK_DEPARTMENT, key, p.id,
         JSON.stringify({ orders: it.orders ?? null, revenue: it.revenue ?? null,
                          lastPaid: it.lastPaid ?? null, category: it.category ?? null,
                          paymentType: it.paymentType ?? null }), status]);
    }
  }
  return { packs: packs.length, children, skippedNoKey, alreadyDone };
}

if (process.argv[1]?.endsWith("backfillPackChildren.js")) {
  const apply = process.argv.includes("--apply");
  backfillPackChildren(apply)
    .then((r) => {
      console.log(`${apply ? "✍️  ЗАПИСАНО" : "👀 ПРОБНИЙ ПРОГІН (нічого не записано)"}`);
      console.log(`   пачок до перенесення: ${r.packs}`);
      console.log(`   рядків-дітей:         ${r.children}  (з них уже виконаних: ${r.alreadyDone})`);
      console.log(`   елементів БЕЗ ключа:  ${r.skippedNoKey}  ← ці не переносяться, вони й у чеклісті нічиї`);
      if (!apply) console.log("\n   щоб записати: додати --apply");
      return pool.end();
    })
    .catch((e) => { console.error(e); process.exit(1); });
}
