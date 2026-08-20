import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { needsDb } from "../testMode.js";

/**
 * #94 — РОЗКРИТТЯ ПОЯСНЮЄ ЧИСЛО, А НЕ СПЕРЕЧАЄТЬСЯ З НИМ (20.08.2026).
 *
 * 🔴 ПРИВІД, ЗАМІРЯНИЙ НА ПРОДІ. `dayItems` брав угоду за подією входу в БУДЬ-ЯКИЙ
 * статус грошової каси, а ядро анкерить кожну гілку окремо: успішні — по
 * `closed_at_kommo`, оплачені — по ОСТАННЬОМУ входу в етап 9. Угода, що встигла
 * побувати в обох, показувалась не в тому дні, у який її рахує каса.
 * Розійшлось **13 із 68 днів (19%)**: розкриття давало +20 угод і +96 840 ₴ понад
 * числа, які пояснювало. Доказ — угода `62551669` (події `08-05:142`,
 * `08-10:69716460`): каса рахує 10.08, розкриття показувало 05.08.
 *
 * Це той самий клас, що чипи «новий/постійний» 07.08.2026: число і його пояснення
 * рахувались різними виразами. Лікується однаково — ОДИН вираз на обох.
 */

const SRC = path.join(import.meta.dirname, "..", "..", "src", "core");

test("#94 СКЛАД КАСИ БЕРЕТЬСЯ З ЯДРА, а не з власного запиту по подіях", () => {
  const di = readFileSync(path.join(SRC, "dayItems.ts"), "utf8");
  assert.ok(/moneySourceSql\(/.test(di),
    "🔴 `dayItems` більше не кличе вираз каси з ядра — склад числа знову рахується власним запитом");
  for (const kind of ["success", "paidOnly", "received"])
    assert.ok(new RegExp(`byMoneyAnchor\\("${kind}"`).test(di),
      `🔴 вид «${kind}» не йде через анкер ядра`);
  // 🔴 Стара форма не має повернутись НАВІТЬ як допоміжна: два способи дістати ті
  // самі угоди — це два способи розійтися.
  assert.equal(/byStageEntry/.test(di.replace(/\/\*[\s\S]*?\*\//g, " ")), false,
    "🔴 у коді знову є `byStageEntry` — саме він анкерив за подією входу в будь-який статус каси");

  const mo = readFileSync(path.join(SRC, "money.ts"), "utf8");
  assert.ok(/export function moneySourceSql/.test(mo),
    "🔴 ядро більше не експортує вираз каси — спільним він бути не може");
  // Саме число НЕ мало змінитись: гілки лишились ті самі.
  assert.ok(/d\.closed_at_kommo AS anchor_at/.test(mo) && /MAX\(changed_at\) AS anchor_at/.test(mo),
    "🔴 анкери гілок каси змінились — це вже правка ЧИСЛА, а не його пояснення");
});

test("#94b СКЛАД == ЧИСЛУ по кожному дню місяця (жива БД)", needsDb(), async () => {
  const { dayItems } = await import("./dayItems.js");
  const money = await import("./money.js");
  const { pool } = await import("../db/pool.js");
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const from = `${ym}-01`, to = now.toISOString().slice(0, 10);

  // Менеджер із НАЙБІЛЬШОЮ кількістю переходів між етапами каси: саме на них
  // стара форма й розходилась, тож вибірка не випадкова.
  const cand = await pool.query<{ manager_id: number }>(
    `SELECT d.manager_id, COUNT(*) n
       FROM deals d
      WHERE d.pipeline_id = ANY($1) AND d.manager_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM deal_stage_events e
                     WHERE e.kommo_id = d.kommo_id AND e.status_id = 142)
        AND d.status_id = ANY($2)
      GROUP BY d.manager_id ORDER BY n DESC LIMIT 1`,
    [money.FC_PIPELINES, money.STAGE_PAID]);
  const managerId = cand.rows[0]?.manager_id;
  assert.ok(managerId, "🔴 у базі немає жодної угоди, що побувала в 142 і зараз в етапі 9 — "
    + "перевіряти нема на чому, а це саме той випадок, який ловить гейт");

  const byDay = await money.receivedByManagerBucket({ from, to, managerId }, "day");
  const days = byDay.filter((r) => r.managerId === managerId && r.deals > 0);
  assert.ok(days.length > 0, "🔴 у менеджера немає жодного дня з грошима — вибірка порожня");

  const bad: string[] = [];
  for (const d of days) {
    const items = await dayItems("received", managerId, d.bucket);
    if (items.total.count !== d.deals || Math.abs(items.total.sum - d.revenue) > 1)
      bad.push(`${d.bucket}: число ${d.deals}/${Math.round(d.revenue)} проти складу ${items.total.count}/${Math.round(items.total.sum)}`);
  }
  assert.deepEqual(bad, [],
    "🔴 РОЗКРИТТЯ СПЕРЕЧАЄТЬСЯ З ЧИСЛОМ. Людина клікає, щоб перевірити цифру, і бачить "
    + "іншу — це б'є саме в довіру до Звіту:\n  " + bad.join("\n  "));
});

test("#94c УГОДА, ЩО ПЕРЕЙШЛА МІЖ ЕТАПАМИ, ПОТРАПЛЯЄ РІВНО В ОДИН ДЕНЬ", needsDb(), async () => {
  const { dayItems } = await import("./dayItems.js");
  const money = await import("./money.js");
  const { pool } = await import("../db/pool.js");
  const KY = "AT TIME ZONE 'Europe/Kyiv'";

  // Угода зі СТАРИМ входом у 142 і ПІЗНІШИМ входом в етап 9 — рівно та форма,
  // на якій ламалась попередня редакція (`62551669`).
  const r = await pool.query<{ kommo_id: string; manager_id: number; d142: string; d9: string }>(
    `SELECT d.kommo_id, d.manager_id,
            to_char(MIN(e142.changed_at) ${KY}, 'YYYY-MM-DD') d142,
            to_char(MAX(e9.changed_at) ${KY}, 'YYYY-MM-DD') d9
       FROM deals d
       JOIN deal_stage_events e142 ON e142.kommo_id = d.kommo_id AND e142.status_id = 142
       JOIN deal_stage_events e9 ON e9.kommo_id = d.kommo_id AND e9.status_id = ANY($2)
      WHERE d.pipeline_id = ANY($1) AND d.status_id = ANY($2)
      GROUP BY d.kommo_id, d.manager_id
     HAVING to_char(MIN(e142.changed_at) ${KY}, 'YYYY-MM-DD') <> to_char(MAX(e9.changed_at) ${KY}, 'YYYY-MM-DD')
      LIMIT 1`,
    [money.FC_PIPELINES, money.STAGE_PAID]);
  const row = r.rows[0];
  assert.ok(row, "🔴 у базі немає угоди з різними датами входу в 142 і в етап 9 — "
    + "гейт нема на чому перевірити (а раніше таких було досить, щоб зіпсувати 19% днів)");

  const inDay = async (day: string) =>
    (await dayItems("received", row.manager_id, day)).items.some((x) => String(x.kommoId) === row.kommo_id);

  assert.equal(await inDay(row.d9), true,
    `🔴 угода ${row.kommo_id} не показана в дні свого анкера (${row.d9}) — розкриття втратило угоду, яку каса рахує`);
  assert.equal(await inDay(row.d142), false,
    `🔴 угода ${row.kommo_id} показана ще й у дні входу в 142 (${row.d142}) — саме це подвоєння `
    + "і давало +20 угод у розкритті");
});
