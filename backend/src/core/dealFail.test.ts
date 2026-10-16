import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canFailDeal, isClosedStatus, failPayload, revertFailPayload, failNoteText, reasonsFromField, FAIL_REASON_FIELD, LOST_STATUS } from "./dealFail.js";

const SRC = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url).href.replace("/dist/", "/src/")), "utf8");

/**
 * #1766 — «ПРОВАЛИТИ УГОДУ» З КАРТКИ РОЗМОВИ (ТЗ «Звіт КВП - ядро» 12.10.2026, розділ 5; рішення Романа 16.10.2026:
 * менеджер, тімлід, КВП, адмін; усі причини з Kommo). Червоніє, якщо: право отримає HR чи фінансист; закриту угоду
 * (успіх / відмова) можна «провалити» повторно; запис піде не в статус 143 своєї ж воронки або без причини; «Повернути»
 * не поверне на той самий етап чи не зніме причину; список причин змішає порядок або пропустить сміття.
 */
test("#1766 ПРОВАЛИТИ УГОДУ: ролі, лише відкриті угоди, 143 + причина своєї воронки, «Повернути» на той самий етап, причини з Kommo", () => {
  for (const r of ["admin", "kvp", "team_lead", "manager"]) assert.equal(canFailDeal(r), true, `🔴 ${r} не може провалити угоду`);
  for (const r of ["hr", "financier", "ceo", null, undefined, ""]) assert.equal(canFailDeal(r), false, `🔴 ${String(r)} може провалити угоду`);
  assert.equal(isClosedStatus(142), true, "🔴 успішну угоду можна «провалити»");
  assert.equal(isClosedStatus(143), true, "🔴 уже провалену угоду можна провалити вдруге");
  assert.equal(isClosedStatus(69716312), false, "🔴 відкриту угоду вважаємо закритою");
  assert.deepEqual(failPayload(5, 777, 6340787), [{ id: 5, pipeline_id: 777, status_id: LOST_STATUS,
    custom_fields_values: [{ field_id: FAIL_REASON_FIELD, values: [{ enum_id: 6340787 }] }] }], "🔴 провалення — не 143 своєї воронки з причиною");
  assert.deepEqual(revertFailPayload(5, 777, 1234), [{ id: 5, pipeline_id: 777, status_id: 1234,
    custom_fields_values: [{ field_id: FAIL_REASON_FIELD, values: null }] }], "🔴 «Повернути» не на той самий етап або не знімає причину");
  assert.match(failNoteText("Іван", "Дорого", "  обрав іншого  "), /Іван\. Причина: Дорого\. Коментар: обрав іншого/, "🔴 примітка в угоді не каже, хто й чому");
  assert.deepEqual(reasonsFromField({ enums: [{ id: 3, value: "Б", sort: 2 }, { id: 1, value: " А ", sort: 1 }, { id: 9, value: "  ", sort: 3 }, { id: "x", value: "В", sort: 0 }] }),
    [{ id: 1, value: "А" }, { id: 3, value: "Б" }], "🔴 список причин не в порядку CRM або з порожніми");
  assert.deepEqual(reasonsFromField(null), []);
});

/**
 * #1766b — ПРОВОДКА «ПРОВАЛИТИ / ПОВЕРНУТИ». Право — ПЕРШИМ оператором; скоуп — картки (`missedScopeFor`); угода — з розмови;
 * перед записом — СВІЖИЙ стан з Kommo (закриту не чіпаємо); причина — лише з поля Kommo; журнал пишеться; «Повернути» —
 * лише коли угода досі 143. Роути в матриці доступу; причини приходять із карткою. Кнопка — у картці.
 */
test("#1766b ПРОВОДКА: право першим, скоуп картки, свіжий стан Kommo, журнал, «Повернути» лише зі 143; матриця й кнопка", () => {
  const r = SRC("../routes/dashboard.ts");
  const body = (path: string) => { const i = r.indexOf(`dashboardRouter.post("${path}"`); assert.ok(i > 0, `🔴 немає роуту ${path}`); return r.slice(i, r.indexOf("\n});", i)); };
  const fail = body("/ai-calls/:uniqueid/fail-deal"), rev = body("/ai-calls/fail-deal/:id/revert");
  for (const [n, b] of [["fail", fail], ["revert", rev]] as const) {
    assert.match(b, /^dashboardRouter\.post\("[^"]+", async \(req, res\) => \{\s*const auth = req\.auth!;\s*if \(!canFailDeal\(auth\.roleKey\)\)/, `🔴 ${n}: право — не першим оператором`);
    assert.match(b, /aiCallCard\(pool, [^,]+, false, missedScopeFor\(auth, \{\}\)\)/, `🔴 ${n}: скоуп не картки — чужа розмова пройде`);
  }
  assert.match(fail, /if \(!card\.row\.kommoIds\.includes\(kommoId\)\)/, "🔴 можна провалити угоду, що не належить розмові");
  assert.match(fail, /\(await failReasons\(\)\)\.find\(\(x\) => x\.id === reasonId\)/, "🔴 причина не з поля Kommo");
  const iGet = fail.indexOf("kommoGet<"), iClosed = fail.indexOf("if (isClosedStatus(lead.status_id))"), iWrite = fail.indexOf('kommoWrite("/api/v4/leads", failPayload(');
  assert.ok(iGet > 0 && iGet < iClosed && iClosed < iWrite, "🔴 запис у Kommo без свіжої перевірки, що угода відкрита");
  assert.match(fail, /INSERT INTO deal_fail_log/, "🔴 провалення не пишеться в журнал — «Повернути» не буде звідки");
  assert.match(rev, /if \(lead\.status_id !== LOST_STATUS\)/, "🔴 «Повернути» перезапише угоду, яку вже змінили руками");
  assert.match(r, /failReasons: canFailDeal\(auth\.roleKey\) && card\.row\.kommoIds\.length \? await failReasons\(\)\.catch\(\(\) => \[\]\) : \[\],/, "🔴 картка не несе причини або падає, коли Kommo не відповів");
  const m = SRC("../auth/accessMatrix.ts");
  for (const p of ["/api/dashboard/ai-calls/:uniqueid/fail-deal", "/api/dashboard/ai-calls/fail-deal/:id/revert"]) {
    assert.ok(m.includes(`path: "${p}"`), `🔴 ${p} немає в матриці доступу`);
  }
  const fe = SRC("../../../frontend/src/pages/dashboard/sections/AiCallDrawer.tsx");
  assert.match(fe, /<FailDealBlock c=\{c\} uniqueid=\{uniqueid\}/, "🔴 кнопки немає в картці розмови");
  assert.match(fe, /if \(!c\.canFailDeal \|\| c\.dealUrls\.length === 0\) return null;/, "🔴 кнопку видно тим, кому сервер не дозволив");
});
