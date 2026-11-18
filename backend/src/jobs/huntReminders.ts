import { pool } from "../db/pool.js";
import type { Db } from "../core/secrets.js";
import { dueReminders, markReminded, huntAllowed } from "../core/hunt.js";
import { emitAll } from "../payroll/notifyCenter.js";

/**
 * 🔔 Нагадування «Хантингу» (ТЗ п.8, п.10 «Потім») — кожні 5 хв: коментар із нагадуванням, якому настав час, стає
 * сповіщенням у дзвіночку авторові (канали — за правилом `hunt.remind` у «Налаштуваннях → Сповіщення»).
 * Людині, яку прибрали зі списку доступу, не шлемо: у сповіщенні імʼя й компанія кандидата.
 */
export async function huntReminders(): Promise<{ sent: number }> {
  const db = pool as unknown as Db;
  const due = await dueReminders(db);
  let sent = 0;
  for (const r of due) {
    if (await huntAllowed(db, r.user_id)) {
      const ids = await emitAll(pool, [{
        type: "hunt.remind", to: [String(r.user_id)], act: false,
        title: `Хантинг: нагадування — ${r.full_name}${r.company ? ` (${r.company})` : ""}`, text: r.text.slice(0, 500),
        go: { section: "hiring", query: `?tab=hunt&cand=${String(r.candidate_id)}` },
      }]);
      sent += ids.length;
    }
    await markReminded(db, [r.id]);
  }
  if (due.length) console.log(`huntReminders: нагадувань ${String(due.length)}, сповіщень ${String(sent)}`);
  return { sent };
}
