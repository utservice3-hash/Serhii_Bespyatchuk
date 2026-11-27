import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 🧾 Обхідний лист оформлює HR (рішення Сергія з TOP Weekly 26.11.2026, задачі 11191/11193; Роман 27.11 «давай робити»):
 *  - окреме право `payroll_leave` — HR і ОД, без доступу до сум; фінансист більше не оформлює;
 *  - список людей для оформлення — без сум: ПІБ, посада, дата звільнення з «Найму»;
 *  - кнопки пунктів «Підписано» / «Підписано, боргів немає» (бухгалтерія);
 *  - «Бізнес-асистент» поіменно — Дарʼя Протас (Роман 27.11): ролі БА на проді немає ні в кого, пп. 2, 6, 7 не підписував ніхто.
 * Гейти `#11310`–`#11313`.
 */
const SRC = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "src", p), "utf8");
const FRONT = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", p), "utf8");

test("#11310 оформити звільнення і список людей для нього — лише за правом payroll_leave, не payroll_edit", () => {
  const r = SRC("routes/payroll.ts");
  assert.match(r, /payrollRouter\.post\("\/employees\/:userId\/leave", h\(\["payroll_leave"\],/, "🔴 оформлення звільнення стереже не payroll_leave");
  assert.match(r, /payrollRouter\.get\("\/leave-candidates", h\(\["payroll_leave"\],/, "🔴 список для оформлення стереже не payroll_leave");
  assert.match(r, /"payroll_leave"(?!_)/, "🔴 payroll_leave не оголошене серед прав «Зарплати»");
  assert.ok(SRC("auth/permGrant.ts").includes('"payroll_leave",'), "🔴 payroll_leave немає в каталозі прав — роль не зможе його отримати");
  const tab = FRONT("payroll/system/ClearancesTab.tsx");
  assert.ok(!/perms\.has\("payroll_edit"\)/.test(tab), "🔴 кнопка «Оформити звільнення» досі за правом фінансиста");
  assert.match(tab, /perms\.has\("payroll_leave"\) && <div><button className="zp-btn" onClick=\{\(\) => setLeave\(true\)\}>Оформити звільнення</, "🔴 кнопки для HR немає");
});

test("#11311 🪞 список для оформлення без сум: лише ПІБ, посада, дата з «Найму»; модалка бере його, а не «Працівників»", () => {
  const s = SRC("payroll/service.ts");
  const fn = s.slice(s.indexOf("export async function leaveCandidates"), s.indexOf("export async function createLeave"));
  assert.ok(fn.length > 50, "🔴 функції leaveCandidates немає — перевіряти нема чого");
  const keys = [...fn.matchAll(/\(\{ (userId:[\s\S]*?) \}\)\)/g)].map((m) => m[1]);
  assert.equal(keys.length, 1, "🔴 у leaveCandidates не один літерал рядка — гейт міряє не те");
  assert.deepEqual([...keys[0].matchAll(/(\w+):/g)].map((m) => m[1]), ["userId", "name", "title", "naimDismissedAt"],
    "🔴 у відповідь для HR потрапило поле понад ПІБ/посаду/дату — HR сум не бачить");
  const tab = FRONT("payroll/system/ClearancesTab.tsx");
  const modal = tab.slice(tab.indexOf("function LeaveModal"));
  assert.match(modal, /payrollApi\.leaveCandidates\(\)/, "🔴 модалка оформлення не бере список без сум");
  assert.ok(!/payrollApi\.employees\(\)/.test(modal), "🔴 модалка бере «Працівників» з умовами й сумами — HR отримає 403");
});

test("#11312 кнопки пунктів: «Підписано», бухгалтерія — «Підписано, боргів немає», п. 9 — «Погодити розрахунок»", () => {
  const tab = FRONT("payroll/system/ClearancesTab.tsx");
  const fn = tab.slice(tab.indexOf("const signLabel"), tab.indexOf("export default function ClearancesTab"));
  assert.match(fn, /it\.final \? "Погодити розрахунок" : it\.key === "reconcile" \? "Підписано, боргів немає" : "Підписано"/, "🔴 підписи кнопок не за рішенням Сергія");
  assert.match(tab, /\{signLabel\(it\)\}/, "🔴 кнопка пункту не бере signLabel");
  assert.ok(!/: "Підписати"\}/.test(tab), "🔴 на кнопці досі «Підписати»");
  assert.ok(SRC("payroll/engine/zarplata-engine.mjs").includes("{ k: 'reconcile', role: 'acc'"), "🔴 пункт звірки більше не бухгалтерії — підпис «боргів немає» не на тому пункті");
});

test("#11313 МІГРАЦІЯ ДВІЧІ: payroll_leave — HR і ОД; фінансист — ні, але payroll_edit у нього лишається", async (t) => {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  try {
    await c.connect();
    const schema = SRC("db/schema.sql");
    await c.query(schema);
    // 🧾 сід «Бізнес-асистента» за прізвищем: на першому прогоні людей ще немає; Дарʼя зʼявилась — другий прогін ставить її
    await c.query(`INSERT INTO users (id, email, password_hash, role, full_name, is_active) VALUES
      (901, 'dp@t', 'x', 'admin', 'Протас Дарʼя Олегівна', true), (902, 'x@t', 'x', 'manager', 'Протасова-ні', false)`);
    await c.query(schema);
    const roles = (await c.query<{ key: string; permissions: Record<string, unknown> }>("SELECT key, permissions FROM roles")).rows;
    const has = (k: string, p: string) => roles.find((r) => r.key === k)?.permissions?.[p] === true;
    assert.ok(roles.some((r) => r.key === "hr") && roles.some((r) => r.key === "financier"), "🔴 у scratch-базі немає ролей — перевіряти нема чого");
    assert.ok(has("hr", "payroll_leave") && has("opdir", "payroll_leave"), "🔴 HR або ОД без права оформлювати звільнення");
    assert.ok(!has("financier", "payroll_leave"), "🔴 фінансист і далі оформлює звільнення");
    assert.ok(has("financier", "payroll_edit"), "🔴 фінансист утратив payroll_edit — зняли більше, ніж вирішено");
    assert.deepEqual(roles.filter((r) => r.permissions?.payroll_leave === true).map((r) => r.key).sort(), ["hr", "opdir"], "🔴 payroll_leave розтеклось на інші ролі");
    const ba = (await c.query("SELECT user_id FROM payroll_responsibles WHERE role_key = 'ba'")).rows;
    assert.deepEqual(ba, [{ user_id: 901 }], "🔴 «Бізнес-асистент» не Дарʼя Протас (неактивну людину брати не можна)");

    // поіменний відповідальний сильніший за пошук за роллю; без рядка — як було
    process.env.DATABASE_URL = scratch.url;
    process.env.JWT_SECRET ??= "test";
    process.env.KOMMO_BASE_URL ??= "https://x.invalid";
    process.env.KOMMO_API_TOKEN ??= "test";
    process.env.PAYROLL_OD_USER_ID = "901";
    const { loadResponsibles } = await import("./state.js");
    await c.query(`INSERT INTO users (id, email, password_hash, role, role_override, full_name, is_active) VALUES (903, 'ba@t', 'x', 'manager', 'business_assistant', 'Роль БА', true)`);
    assert.equal((await loadResponsibles(c as never)).ba.id, "901", "🔴 пп. 2, 6, 7 підписує не Дарʼя, хоч вона названа поіменно");
    await c.query("DELETE FROM payroll_responsibles");
    assert.equal((await loadResponsibles(c as never)).ba.id, "903", "🔴 без поіменного рядка відповідальний не за роллю — зламано старе правило");
  } finally {
    await c.end().catch(() => {});
    scratch.dispose();
  }
});
