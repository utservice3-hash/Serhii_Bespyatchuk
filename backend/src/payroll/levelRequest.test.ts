import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 🎚 «Старт → Профі» лише через керівництво (задача 10723, варіант В1; Роман 25.11 «на Профі не можна перейти без керівництва»,
 * 27.11 «роби»: погоджують Сергій, рекрутер і адміни). Кнопка в кабінеті подає ЗАЯВКУ, рівень у «Зарплаті» не міняється;
 * погодження — «Перевести на «Профі»» у картці «Найму», далі фінансист підтверджує в «Змінах з «Найму»». Гейти `#11340`–`#11343`.
 */
const SRC = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "src", p), "utf8");
const FRONT = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", p), "utf8");
const fnBody = (src: string, head: string) => { const a = src.indexOf(head); assert.ok(a >= 0, `🔴 немає ${head}`); const b = src.indexOf("\nexport ", a + head.length); return src.slice(a, b < 0 ? undefined : b); };

/**
 * #11340 — КНОПКА МЕНЕДЖЕРА = ЗАЯВКА: `chooseProfi` пише заявку і НЕ пише рівень (`setLevel` / `payroll_terms` / офер).
 * 🪞 Пара: «Змінити рівень» фінансиста у «Змінах з «Найму»» і далі пише рівень. 🧨 Червоніє, якщо кнопка знову міняє рівень сама.
 */
test("#11340 КНОПКА «ПРОФІ» В КАБІНЕТІ — ЗАЯВКА: рівень не пишеться; підтвердження фінансиста з «Найму» — пише", () => {
  const svc = SRC("payroll/service.ts"), choose = fnBody(svc, "export async function chooseProfi(");
  assert.match(choose, /INSERT INTO payroll_level_requests \(user_id, level, from_month\)/, "🔴 кнопка має подавати заявку");
  assert.doesNotMatch(choose, /setLevel\(|payroll_terms|payroll_offer_docs/, "🔴 заявка не міняє рівень і не створює офер — це рішення керівництва");
  assert.match(choose, /e\.nt\.build\.levelRequested\(id\)/, "🔴 про заявку мають дізнатись ті, хто погоджує");
  assert.match(svc, /INSERT INTO payroll_offer_docs \(user_id, offer_title, level, valid_from, why\) VALUES \(\$1,\$2,\$3,\$4::date,'рішення керівництва'\)/, "🔴 пара: підтвердження рівня з «Найму» і далі створює офер");
});

/**
 * #11341 — СПОВІЩЕННЯ: заявка йде всім, хто погоджує (і нікому іншому), веде в картку «Найму» і закривається рішенням;
 * відмова йде менеджеру з коментарем. 🧨 Червоніє, якщо адресати не ті або сповіщення не закривається.
 */
test("#11341 СПОВІЩЕННЯ ЗАЯВКИ: тим, хто погоджує, → картка «Найму»; закривається рішенням; відмова — менеджеру", async () => {
  const { createPayroll } = await import("./engine/zarplata-engine.mjs");
  const { createNotifier } = await import("./engine/notify.mjs");
  const base = { dept: "sales", startDate: "2024-01-01", birthday: null, official: [], leave: null, clientRates: [], adjustments: [] };
  const mk = (q: Record<string, unknown>) => {
    const state = {
      now: "2026-11-27T16:00", liveMonth: "2026-11", closedMonth: "2026-10", settings: { birthday: { v2From: null } },
      employees: [{ ...base, id: "M", name: "Менеджер", role: "manager", title: "Менеджер", team: "t1", terms: [{ from: "2000-01", level: "start" }] }],
      departments: { sales: { name: "Продажі", sales: true } }, teams: { t1: { name: "Т1" } }, plans: {}, deals: {}, kpi: {}, records: {}, advances: {}, clearances: {},
      responsibles: { ba: { id: "", name: "БА" }, acc: { id: "", name: "Бух" }, hr: { id: "7", name: "HR" }, od: { id: "3", name: "ОД" }, finance: ["8"] },
      levelRequests: { M: { id: 5, level: "profi", from: "2026-12", requestedAt: "2026-11-27T15:00", employeeId: 42, ...q } }, levelApprovers: ["1", "3", "7"],
    };
    return createNotifier(createPayroll(state as never), state);
  };
  const open = mk({ decidedAt: null, decision: null, note: null });
  const [n] = open.build.levelRequested("M") as Array<{ to: string[]; go: { section: string; query: string }; done: unknown; act: boolean }>;
  assert.deepEqual(n.to.slice().sort(), ["1", "3", "7"], "🔴 заявку отримують ОД, рекрутер і адміни — і ніхто інший");
  assert.deepEqual(n.go, { section: "hiring", query: "?tab=emp&employee=42" }, "🔴 посилання — у картку людини в «Наймі»");
  assert.equal(open.notificationDoneAt(n), null, "🔴 відкрита заявка — сповіщення висить");
  const done = mk({ decidedAt: "2026-11-27T15:30", decision: "rejected", note: "рано" });
  assert.equal(done.notificationDoneAt(n), "2026-11-27T15:30", "🔴 рішення закриває сповіщення");
  const [r] = done.build.levelRejected("M") as Array<{ to: string[]; text: string }>;
  assert.deepEqual(r.to, ["M"], "🔴 про відмову дізнається менеджер");
  assert.match(r.text, /рано/, "🔴 з коментарем того, хто відхилив");
});

/**
 * #11342 — ХТО ПОГОДЖУЄ І ДЕ ЗАКРИВАЄТЬСЯ: право `payroll_level_approve` — рівно адмін, ОД, HR; переведення в «Наймі» закриває
 * відкриту заявку як погоджену; відкрита заявка одна; таблиця закрита від AI. 🧨 Червоніє, якщо дати право іншим, забути
 * закрити заявку в «Наймі» або зняти унікальність.
 */
test("#11342 ПОГОДЖЕННЯ: право — адмін, ОД, HR; «Перевести на «Профі»» у «Наймі» закриває заявку; одна відкрита; не для AI", () => {
  const sql = SRC("db/schema.sql");
  assert.match(sql, /'\{"payroll_level_approve":true\}'::jsonb WHERE key IN \('admin', 'opdir', 'hr'\);\nUPDATE roles SET permissions = permissions - 'payroll_level_approve' WHERE key NOT IN \('admin', 'opdir', 'hr'\);/, "🔴 право погодження — лише адмін, ОД, HR");
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS payroll_level_requests_open ON payroll_level_requests \(user_id\) WHERE decided_at IS NULL;/, "🔴 відкрита заявка на людину — одна");
  assert.match(sql, /REVOKE ALL ON payroll_responsibles, payroll_level_requests FROM ai_readonly;/, "🔴 таблиця має бути закрита від AI-запитів");
  assert.match(SRC("ai/metricTools.ts"), /"payroll_level_requests"/, "🔴 дзеркало FORBIDDEN_TABLES");
  assert.match(fnBody(SRC("core/employeeLevel.ts"), "export async function promoteToPro("), /UPDATE payroll_level_requests SET decided_at = now\(\), decided_by = \$2, decision = 'approved'/, "🔴 переведення в «Наймі» закриває заявку");
  assert.match(SRC("routes/payroll.ts"), /post\("\/level-requests\/:userId\/reject", h\(\["payroll_level_approve"\],/, "🔴 відхилити — лише з правом погодження");
});

/**
 * #11343 — ЕКРАНИ: у кабінеті кнопка «Подати заявку», після подачі — «чекає рішення керівництва»; у картці «Найму» — заявка і
 * «Відхилити заявку». 🧨 Червоніє, якщо повернути «Так, з 1 …» (перехід без керівництва) або прибрати заявку з картки.
 */
test("#11343 ЕКРАНИ: кабінет — «Подати заявку» і «чекає рішення»; картка «Найму» — заявка й «Відхилити заявку»", () => {
  const terms = FRONT("payroll/cabinet/Terms.tsx"), hire = FRONT("pages/dashboard/sections/HiringEmployees.tsx");
  assert.match(terms, />Подати заявку<\/button>/, "🔴 кнопка в кабінеті — заявка");
  assert.doesNotMatch(terms, />Так, з 1 \{monthGen\(nx\)\}</, "🔴 перехід без керівництва повернувся");
  assert.match(terms, /Чекає рішення керівництва/, "🔴 після подачі менеджер бачить, що заявка чекає");
  assert.match(hire, /row\.level_request && row\.level === "start" &&/, "🔴 картка «Найму» показує заявку");
  assert.match(hire, />Відхилити заявку<\/button>/, "🔴 відхилити можна з картки");
});
