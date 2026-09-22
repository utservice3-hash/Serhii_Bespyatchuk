/**
 * 🏆 НОМІНАЦІЇ ТИЖНЯ — гейти правил і джерела чисел (21.09.2026).
 * Прогін роутів і незмінність знімка проти бази з нуля — `routes/nominations.test.ts` (#604).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { needsApi, API_BASE } from "../testMode.js";
import {
  rankNominees, applyReview, fingerprint, canReview, validateReview, weekOf, lastWeek, isFreezeDue, kyivDate, deptWinners,
  NOMINATIONS, type Ranked,
} from "./nominationRules.js";

/**
 * Тиждень для ЖИВОЇ звірки (#600, #658): лише чернетка. Зафіксований тиждень тримає числа вівторка 08:00,
 * а Звіт і розкриття рахують CRM зараз — порівнювати їх означало б червоніти без дефекту з вт по нд
 * (ревʼю 22.09.2026). Тож: минулий тиждень, поки він чернетка (пн — вт 08:00), інакше поточний.
 */
async function draftWeekForLiveCheck(H: { headers: Record<string, string> }): Promise<{ from: string; to: string; body: unknown }> {
  for (const w of [lastWeek(new Date()), weekOf(kyivDate(new Date()))]) {
    const r = await fetch(`${API_BASE}/api/nominations/week?weekFrom=${w.from}`, H);
    assert.equal(r.status, 200, `🔴 /nominations/week віддав ${r.status}`);
    const body = await r.json() as { state: string };
    if (body.state === "draft") return { ...w, body };
  }
  throw new Error("🔴 і минулий, і поточний тиждень зафіксовані — так не буває: поточний ще триває");
}

const SRC = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url).href.replace("/dist/", "/src/"));

/* ─────────────────────────── #600 джерело чисел ─────────────────────────── */

/**
 * #600 — ЧИСЛА НОМІНАЦІЙ == ЗВІТ за той самий тиждень (зовнішня звірка через HTTP).
 * «Результат» кожної команди мусить дорівнювати найбільшому «Факту» `/report-plan` серед її
 * менеджерів, «авто» — найбільшій колонці «Авто», і переможці — саме ті люди. Червоніє, якщо
 * номінацію перевести на інше джерело (① замість «Факту», свій SQL, інший ростер).
 */
test("#600 результат і авто номінацій == «Факт» і «Авто» Звіту за той самий тиждень", needsApi(), async () => {
  const { signToken } = await import("../auth/auth.js");
  const token = signToken({ userId: 0, role: "admin", roleKey: "admin", managerId: null, teamId: null });
  const H = { headers: { Authorization: `Bearer ${token}` } };
  const { from, to, body } = await draftWeekForLiveCheck(H);
  const rr = await fetch(`${API_BASE}/api/dashboard/report-plan?from=${from}&to=${to}`, H);
  assert.equal(rr.status, 200, `🔴 /report-plan віддав ${rr.status}`);
  type Cell = { nomination: string; crm: Ranked };
  const nom = body as { teams: { teamId: number; members: { id: number }[]; cells: Cell[] }[] };
  const rep = await rr.json() as { managers: { managerId: number; fact: number; kpi: { dispatch: { fact: number } } }[] };
  const byId = new Map(rep.managers.map((m) => [m.managerId, m]));
  assert.ok(nom.teams.length >= 2, "🔴 у заліку менше двох команд — звіряти нічого");
  const off: string[] = [];
  let compared = 0;
  for (const t of nom.teams) {
    for (const m of t.members) if (!byId.has(m.id)) off.push(`менеджер ${m.id} у заліку, але не в ростері Звіту`);
    for (const [key, pick] of [["revenue", (id: number) => byId.get(id)?.fact ?? 0], ["cars", (id: number) => byId.get(id)?.kpi.dispatch.fact ?? 0]] as const) {
      const cell = t.cells.find((c) => c.nomination === key)!;
      const vals = t.members.map((m) => ({ id: m.id, v: pick(m.id) })).filter((x) => x.v > 0);
      if (vals.length === 0) { if (cell.crm.state !== "empty") off.push(`${t.teamId}/${key}: Звіт порожній, номінація — ні`); continue; }
      const best = Math.max(...vals.map((x) => x.v));
      const winners = vals.filter((x) => x.v === best).map((x) => x.id).sort((a, b) => a - b);
      compared++;
      if (cell.crm.state !== "ok") { off.push(`${t.teamId}/${key}: номінація порожня, Звіт дає ${best}`); continue; }
      if (Math.round(cell.crm.value) !== best) off.push(`${t.teamId}/${key}: ${cell.crm.value} ≠ Звіт ${best}`);
      // «Факт» Звіту округлений до гривні: нічия там може бути, де в копійках її немає — тоді
      // переможці номінації ⊆ переможців Звіту, а не рівні.
      if (!cell.crm.winners.every((w) => winners.includes(w))) off.push(`${t.teamId}/${key}: переможці ${cell.crm.winners} ≠ Звіт ${winners}`);
    }
  }
  assert.ok(compared > 0, "🔴 жодна номінація не мала з чим звірятись — перевірка вироджена");
  assert.deepEqual(off, [], "🔴 номінації розійшлись зі Звітом за той самий тиждень");
});

/**
 * #601 — У `core/nominations.ts` НЕМАЄ SQL ПО УГОДАХ І ГРОШАХ. Числа — лише з ядра. Читає вміст
 * шаблонних рядків (там живе SQL) і червоніє на `deals`, `price`, `deal_stage_events`.
 */
test("#601 номінації не мають власного SQL по угодах і грошах — лише ядро", () => {
  const src = readFileSync(SRC("core/nominations.ts"), "utf8");
  const sql = [...src.matchAll(/`([^`]*)`/g)].map((m) => m[1]).filter((s) => /\b(SELECT|INSERT|FROM)\b/.test(s));
  assert.ok(sql.length >= 3, "🔴 не знайдено SQL-рядків у файлі — гейт втратив предмет (ростер, знімок)");
  const bad = sql.filter((s) => /\bdeals\b|\bprice\b|deal_stage_events/.test(s));
  assert.deepEqual(bad, [], "🔴 у номінаціях зʼявився свій SQL по угодах/грошах — брати ЛИШЕ з core/money.ts і core/metrics.ts");
  for (const fn of ["money.receivedDealStatsByMgr", "metrics.dispatchedByManager"]) {
    assert.ok(src.includes(fn), `🔴 номінації більше не кличуть ${fn} — звідки тоді число?`);
  }
});

/* ─────────────────────────── #602 переможець ─────────────────────────── */

test("#602 переможець: нічия — усі; нулі й сторно — не перемога; порожньо — чесний стан", () => {
  // Нічия — УСІ (рішення 21.09.2026), навіть у копійках, що різняться лише шумом float.
  assert.deepEqual(rankNominees([{ managerId: 5, value: 0.1 + 0.2 }, { managerId: 3, value: 0.3 }, { managerId: 9, value: 0.2 }]),
    { state: "ok", value: 0.3, winners: [3, 5] });
  // 🪞 Дзеркало нічиєї: різні значення — один переможець.
  assert.deepEqual(rankNominees([{ managerId: 1, value: 7 }, { managerId: 2, value: 6 }]), { state: "ok", value: 7, winners: [1] });
  // Нуль — «не набрав»: усі нулі = порожньо, а не «переможець із нулем».
  assert.deepEqual(rankNominees([{ managerId: 1, value: 0 }, { managerId: 2, value: null }]), { state: "empty" });
  // Від'ємна маржа (сторно) не перемагає, навіть коли вона єдина…
  assert.deepEqual(rankNominees([{ managerId: 1, value: -5320 }]), { state: "empty" });
  // …а поруч із позитивним програє йому.
  assert.deepEqual(rankNominees([{ managerId: 1, value: -5320 }, { managerId: 2, value: 1 }]), { state: "ok", value: 1, winners: [2] });
  assert.deepEqual(rankNominees([]), { state: "empty" });
});

test("#602b рішення тімліда: підтвердження тримається, доки CRM той самий; виправлення — завжди з причиною", () => {
  const crm: Ranked = { state: "ok", value: 18, winners: [7] };
  const confirm = { action: "confirm" as const, crmFingerprint: fingerprint(crm), overrideManagerIds: null, overrideValue: null, reason: null };
  assert.equal(applyReview(crm, confirm).status, "confirmed");
  assert.equal(applyReview(crm, null).status, "unconfirmed", "🔴 без рішення рядок мусить бути «не підтверджено»");
  // CRM змінився після підтвердження → знову не підтверджено, і видно чому.
  const moved = applyReview({ state: "ok", value: 19, winners: [7] }, confirm);
  assert.equal(moved.status, "unconfirmed");
  assert.equal(moved.stale, true, "🔴 протухле підтвердження мусить бути позначене");
  const ov = { action: "override" as const, crmFingerprint: fingerprint(crm), overrideManagerIds: [9], overrideValue: 37, reason: "завантажили в неділю" };
  const f = applyReview(crm, ov);
  assert.equal(f.status, "overridden");
  assert.deepEqual([f.winners, f.value], [[9], 37]);
  assert.equal(applyReview({ state: "empty" }, null).status, "empty", "🔴 порожня номінація не стає «0» і не отримує переможця");
});

test("#602c переможець відділу — найкращий серед переможців команд, нічия між командами — усі", () => {
  const rows = [
    { teamId: 13, dept: "rnk" as const, winners: [1], value: 24580 },
    { teamId: 15, dept: "rnk" as const, winners: [2, 3], value: 24580 },
    { teamId: 5, dept: "rpk" as const, winners: [4], value: 99999 },
  ];
  assert.deepEqual(deptWinners(rows, "rnk"), { state: "ok", value: 24580, winners: [1, 2, 3], teams: [13, 15] });
  assert.deepEqual(deptWinners(rows, "rpk"), { state: "ok", value: 99999, winners: [4], teams: [5] });
  assert.deepEqual(deptWinners([{ teamId: 5, dept: "rpk", winners: [], value: null }], "rpk"), { state: "empty" });
});

/* ─────────────────────────── #603 тиждень за Києвом ─────────────────────────── */

test("#603 тиждень Пн–Нд і фіксація вівторок 08:00 — за Києвом, обидва боки межі", () => {
  // Нд 20.09 23:30 Києва = 20:30 UTC — ще цей тиждень; Пн 21.09 00:30 Києва = Нд 21:30 UTC — уже наступний.
  assert.deepEqual(weekOf(kyivDate(new Date("2026-09-20T20:30:00Z"))), { from: "2026-09-14", to: "2026-09-20" });
  assert.deepEqual(weekOf(kyivDate(new Date("2026-09-20T21:30:00Z"))), { from: "2026-09-21", to: "2026-09-27" });
  assert.deepEqual(lastWeek(new Date("2026-09-22T06:00:00Z")), { from: "2026-09-14", to: "2026-09-20" });
  // Фіксація: вт 22.09 07:59 Києва — ще ні, 08:00 — так; понеділок — ні, середа — так.
  assert.equal(isFreezeDue("2026-09-14", new Date("2026-09-22T04:59:00Z")), false);
  assert.equal(isFreezeDue("2026-09-14", new Date("2026-09-22T05:00:00Z")), true);
  assert.equal(isFreezeDue("2026-09-14", new Date("2026-09-21T09:00:00Z")), false);
  assert.equal(isFreezeDue("2026-09-14", new Date("2026-09-23T01:00:00Z")), true);
  // Зимовий час (UTC+2): Нд 25.10 після переходу — межа та сама, за Києвом.
  assert.deepEqual(weekOf(kyivDate(new Date("2026-10-25T21:59:00Z"))), { from: "2026-10-19", to: "2026-10-25" });
  assert.deepEqual(weekOf(kyivDate(new Date("2026-10-25T22:00:00Z"))), { from: "2026-10-26", to: "2026-11-01" });
});

/* ─────────────────────────── #605 права й тіло запиту ─────────────────────────── */

test("#605 хто може підтвердити: тімлід — свою команду і не про себе; керівництво — усе", () => {
  const lead = { role: "team_lead", teamId: 13, managerId: 103 };
  assert.equal(canReview(lead, { teamId: 13, crmWinners: [101] }).ok, true, "🔴 тімлід не може підтвердити свою команду");
  assert.equal(canReview(lead, { teamId: 15, crmWinners: [201] }).ok, false, "🔴 тімлід підтверджує чужу команду");
  assert.equal(canReview(lead, { teamId: 13, crmWinners: [103] }).ok, false, "🔴 тімлід підтверджує рядок про себе");
  assert.equal(canReview(lead, { teamId: 13, crmWinners: [101], overrideManagerIds: [103] }).ok, false, "🔴 тімлід виправляє переможця на себе");
  // 🪞 Дзеркало: керівництво може і про тімліда, і будь-яку команду.
  assert.equal(canReview({ role: "admin", teamId: null, managerId: null }, { teamId: 13, crmWinners: [103] }).ok, true);
  assert.equal(canReview({ role: "manager", teamId: 13, managerId: 101 }, { teamId: 13, crmWinners: [201] }).ok, false);
});

test("#605b виправлення без причини, переможця або числа — відмова; підтвердження — без них", () => {
  const base = { weekFrom: "2026-09-14", teamId: 13, nomination: "cars" };
  assert.equal(validateReview({ ...base, action: "confirm" }).ok, true);
  assert.equal(validateReview({ ...base, action: "override", overrideManagerIds: [101], overrideValue: 37 }).ok, false, "🔴 виправлення без причини пройшло");
  assert.equal(validateReview({ ...base, action: "override", overrideManagerIds: [101], overrideValue: 37, reason: "  " }).ok, false, "🔴 причина з пробілів пройшла");
  assert.equal(validateReview({ ...base, action: "override", overrideManagerIds: [], overrideValue: 37, reason: "бо так" }).ok, false);
  assert.equal(validateReview({ ...base, action: "override", overrideManagerIds: [101], overrideValue: 0, reason: "бо так" }).ok, false);
  assert.equal(validateReview({ ...base, weekFrom: "2026-09-15", action: "confirm" }).ok, false, "🔴 тиждень не з понеділка");
  assert.equal(validateReview({ ...base, nomination: "другое", action: "confirm" }).ok, false);
  // 🪞 Дзеркало: повне виправлення проходить.
  const ok = validateReview({ ...base, action: "override", overrideManagerIds: [101, 101], overrideValue: "37", reason: " завантажили в неділю " });
  assert.ok(ok.ok);
  if (ok.ok) assert.deepEqual([ok.value.overrideManagerIds, ok.value.overrideValue, ok.value.reason], [[101], 37, "завантажили в неділю"]);
});

/* ─────────────────────────── #606 знімок тримає обидва числа ─────────────────────────── */

test("#606 рядок знімка тримає фінальне число І число CRM поруч; порожня номінація — рядок без переможця", async () => {
  const { snapshotRows } = await import("./nominationRules.js");
  const view = {
    weekFrom: "2026-09-14", weekTo: "2026-09-20", state: "draft" as const, frozenAt: null, ruleVersion: "x", freezeDueAt: "", freezeInstant: "", leadgen: null, rnkConv: null,
    depts: [], names: { 101: "Андрусенко", 102: "Цалко" },
    teams: [{ teamId: 13, teamName: "РНК", dept: "rnk" as const, members: [], noCostDeals: 2, leads: [], cells: [
      { nomination: "cars" as const, crm: { state: "ok" as const, value: 31, winners: [101] }, deal: null, ranking: null, review: null,
        final: { status: "overridden" as const, winners: [102], value: 37, reason: "неділя", stale: false } },
      { nomination: "intl" as const, crm: { state: "empty" as const }, deal: null, ranking: null, review: null,
        final: { status: "empty" as const, winners: [] as [], value: null, reason: null, stale: false } },
    ] }],
  };
  const rows = snapshotRows(view);
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].managerId, rows[0].value, rows[0].crmValue, rows[0].crmManagerIds, rows[0].reason], [102, 37, 31, [101], "неділя"],
    "🔴 виправлене число витіснило число CRM зі знімка — розбіжність більше не видно");
  assert.deepEqual([rows[1].managerId, rows[1].value, rows[1].status], [null, null, "empty"]);
  assert.equal(NOMINATIONS.length, 5);
});

/* ─────────────────────────── прохід 2: презентація ─────────────────────────── */

test("#607 ручний слайд: без заголовка й з чужим типом — відмова; довгий текст обрізається до слайда", async () => {
  const { validateManualSlide } = await import("./nominationRules.js");
  // «Довільний» шаблон — прямий спадкоємець старого формату (title/person/body без `fields`).
  const base = { weekFrom: "2026-09-14", kind: "custom" };
  assert.equal(validateManualSlide({ ...base, title: "   " }).ok, false, "🔴 слайд без заголовка пройшов");
  assert.equal(validateManualSlide({ ...base, kind: "meme", title: "x" }).ok, false, "🔴 невідомий тип пройшов");
  assert.equal(validateManualSlide({ ...base, weekFrom: "2026-09-16", title: "x" }).ok, false, "🔴 тиждень не з понеділка");
  // 🪞 Дзеркало: нормальний слайд проходить, порожні необовʼязкові поля відпадають, текст — у межах слайда.
  const ok = validateManualSlide({ ...base, title: " Вітаємо в команді! ", person: "  ", body: "а".repeat(900), position: "2" });
  assert.ok(ok.ok);
  if (ok.ok) assert.deepEqual([ok.value.title, ok.value.person, ok.value.fields.body?.length, ok.value.position], ["Вітаємо в команді!", null, 600, 2]);
});

/**
 * #609 — ПРЕЗЕНТАЦІЯ НЕ РАХУЄ СВОЇХ ЧИСЕЛ. «План виконали» — колонка `pct` Звіту за період з 1-го,
 * «Підсумки» — `glance` Звіту за місяць, рейтинг — знімок/чернетка номінацій. Червоніє, якщо слайди
 * почнуть брати гроші з іншого ендпоінта або виводити відсоток виконання самостійно.
 */
test("#609 слайди беруть числа лише зі Звіту й номінацій — без власного розрахунку виконання", () => {
  const src = readFileSync(fileURLToPath(new URL("../../../frontend/src/pages/dashboard/sections/NominationsPresentation.tsx", import.meta.url).href.replace("/backend/dist/", "/backend/src/").replace("/backend/src/../../../", "/")), "utf8");
  assert.match(src, /fetchReportPlan\(\{ from: mStart, to: today \}\)/, "🔴 «План виконали» більше не з колонки Звіту за період з 1-го");
  assert.match(src, /m\.pct < 100/, "🔴 поріг «виконав план» більше не читає `pct` Звіту");
  assert.match(src, /month\.glance/, "🔴 «Підсумки» більше не з верху Звіту");
  assert.doesNotMatch(src, /m\.fact\s*\/\s*m\.plan/, "🔴 слайд сам рахує виконання менеджера — має брати `pct` Звіту");
  assert.doesNotMatch(src, /\/api\/dashboard\/(?!report-plan)|api\.get\(/, "🔴 презентація ходить у сторонній ендпоінт");
});

/**
 * #613 — ШАБЛОНИ РУЧНИХ СЛАЙДІВ: для КОЖНОГО шаблону порожнє обовʼязкове поле — відмова, а
 * заповнені лише обовʼязкові — слайд. Червоніє, якщо шаблон перестане вимагати своє або почне
 * вимагати зайве; і якщо реєстр втратить хоч один із шести Дашиних шаблонів.
 */
test("#613 шаблони слайдів: кожен вимагає рівно свої обовʼязкові поля, і їх шість — як у Даші", async () => {
  const { SLIDE_TEMPLATES, validateManualSlide } = await import("./nominationRules.js");
  assert.deepEqual(SLIDE_TEMPLATES.map((t) => t.key), ["newcomer", "birthday", "news", "contest", "webinar", "custom"]);
  for (const t of SLIDE_TEMPLATES) {
    const req = t.fields.filter((f) => f.required);
    assert.ok(req.length > 0, `🔴 шаблон «${t.label}» не має жодного обовʼязкового поля — слайд вийде порожнім`);
    const full = Object.fromEntries(req.map((f) => [f.key, "x"]));
    const ok = validateManualSlide({ weekFrom: "2026-09-14", kind: t.key, fields: full });
    assert.ok(ok.ok, `🔴 «${t.label}» з усіма обовʼязковими полями не пройшов: ${ok.ok ? "" : ok.error}`);
    for (const f of req) {
      const miss = validateManualSlide({ weekFrom: "2026-09-14", kind: t.key, fields: { ...full, [f.key]: "  " } });
      assert.equal(miss.ok, false, `🔴 «${t.label}» пройшов без поля «${f.label}»`);
    }
    // Зайвий ключ не потрапляє в збережене.
    const extra = validateManualSlide({ weekFrom: "2026-09-14", kind: t.key, fields: { ...full, hack: "x" } });
    assert.ok(extra.ok && !("hack" in extra.value.fields), `🔴 «${t.label}» зберіг чужий ключ`);
  }
});

/**
 * #643 — ФОТО НА ВІТАЛЬНИХ СЛАЙДАХ: «Новий працівник» і «День народження» мають поле людини з реєстру
 * (`type: "employee"`), необовʼязкове; id зберігається як є, а не-id — відмова, щоб у `fields` не
 * потрапило те, за чим фото не знайти. Решта шаблонів такого поля не має (там нема кого показувати).
 */
test("#643 шаблони: вітальні слайди мають поле фото з реєстру, і воно приймає лише id", async () => {
  const { SLIDE_TEMPLATES, validateManualSlide } = await import("./nominationRules.js");
  const withPhoto = SLIDE_TEMPLATES.filter((t) => t.fields.some((f) => f.type === "employee")).map((t) => t.key);
  assert.deepEqual(withPhoto, ["newcomer", "birthday"], "🔴 поле фото не на тих шаблонах");
  const base = { newcomer: { headline: "Вітаємо", person: "Тест Марія" }, birthday: { person: "Тест Івана", date: "27.08" } } as const;
  for (const k of ["newcomer", "birthday"] as const) {
    const ok = validateManualSlide({ weekFrom: "2026-09-14", kind: k, fields: { ...base[k], employeeId: "42" } });
    assert.ok(ok.ok && ok.value.fields.employeeId === "42", `🔴 «${k}»: id людини загубився`);
    const none = validateManualSlide({ weekFrom: "2026-09-14", kind: k, fields: base[k] });
    assert.ok(none.ok && !("employeeId" in none.value.fields), `🔴 «${k}»: без людини слайд не зберігся`);
    for (const bad of ["abc", "0", "-3", "4.5", "1 OR 1=1"]) {
      assert.equal(validateManualSlide({ weekFrom: "2026-09-14", kind: k, fields: { ...base[k], employeeId: bad } }).ok, false, `🔴 «${k}»: прийнято «${bad}» як людину`);
    }
  }
});

/**
 * #614 — У ПРЕЗЕНТАЦІЇ Є ВЕРСТКА ДЛЯ КОЖНОГО ШАБЛОНУ, І НЕМАЄ ДЛЯ НЕІСНУЮЧИХ. Читає джерело
 * `NominationsPresentation.tsx`: кожен ключ реєстру має свою гілку `case "<ключ>"`, а кожна гілка —
 * ключ у реєстрі. «Додав шаблон і забув верстку» (слайд вийшов би порожнім) червоніє тут.
 */
test("#614 кожен шаблон слайда має верстку в презентації, і навпаки", async () => {
  const { SLIDE_TEMPLATES } = await import("./nominationRules.js");
  const src = readFileSync(fileURLToPath(new URL("../../../frontend/src/pages/dashboard/sections/NominationsPresentation.tsx", import.meta.url).href.replace("/backend/dist/", "/backend/src/").replace("/backend/src/../../../", "/")), "utf8");
  const block = src.slice(src.indexOf("function templateSlide("));
  assert.ok(block.length > 100, "🔴 у презентації немає функції templateSlide — гейт втратив предмет");
  const cases = [...block.matchAll(/case "([a-z]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(cases, SLIDE_TEMPLATES.map((t) => t.key).sort(), "🔴 набір верстки слайдів ≠ набір шаблонів");
});

/* ─────────────────────────── зручна вкладка (22.09.2026) ─────────────────────────── */

/**
 * #652 — РЕЙТИНГ КОМАНДИ: усі учасники; ті, хто набрав, — за спаданням, нічия за id; нуль, сторно й «немає»
 * — у кінці, але не зникають. Перше місце рейтингу == переможці `rankNominees` (одне означення, не два).
 * 🧨 Червоніє, якщо сортувати за зростанням, викинути нулі або розвести рейтинг із переможцем.
 */
test("#652 рейтинг команди: усі учасники, найкращі зверху, перше місце == переможці", async () => {
  const { teamRanking } = await import("./nominationRules.js");
  const cands = [
    { managerId: 7, value: 5 }, { managerId: 3, value: 9.004 }, { managerId: 5, value: 9 }, { managerId: 9, value: 0 },
    { managerId: 2, value: -300 }, { managerId: 4, value: null }, { managerId: 8, value: 1 },
  ];
  const r = teamRanking(cands);
  assert.equal(r.length, cands.length, "🔴 рейтинг загубив учасника");
  assert.deepEqual(r.map((x) => x.managerId), [3, 5, 7, 8, 9, 2, 4], "🔴 порядок рейтингу не той (нічия за id, ненабрані в кінці)");
  const win = rankNominees(cands);
  assert.ok(win.state === "ok");
  const top = r.filter((x) => x.value != null && Math.round(x.value * 100) / 100 === win.value).map((x) => x.managerId).sort((a, b) => a - b);
  assert.deepEqual(top, win.winners, "🔴 перше місце рейтингу ≠ переможці номінації");
  assert.deepEqual(teamRanking([{ managerId: 1, value: null }, { managerId: 2, value: 0 }]).map((x) => x.managerId), [2, 1], "🔴 ненабрані зникли або перемішались");
  // Другий бік нічиєї: більше «сире» значення — у більшого id; після округлення до копійки це нічия → за id.
  assert.deepEqual(teamRanking([{ managerId: 5, value: 9.004 }, { managerId: 3, value: 9 }]).map((x) => x.managerId), [3, 5], "🔴 нічия розвʼязана шумом float, а не за id");
});

/**
 * #653 — РЕЙТИНГ ЇДЕ У ЗНІМОК, А СТАРИЙ ЗНІМОК ЧЕСНО КАЖЕ «НЕ ЗБЕРІГАВСЯ». Рядок знімка несе `extra.ranking`
 * рівно з клітинки; розбір знімка без рейтингу дає `null`, а не порожній масив і не поточний CRM.
 */
test("#653 знімок несе рейтинг; тиждень без рейтингу — null, а не підставлений CRM", async () => {
  const { snapshotRows, rankingFromExtra } = await import("./nominationRules.js");
  const ranking = [{ managerId: 101, value: 31 }, { managerId: 102, value: null }];
  const view = {
    weekFrom: "2026-09-21", weekTo: "2026-09-27", state: "draft" as const, frozenAt: null, ruleVersion: "x", freezeDueAt: "", freezeInstant: "", leadgen: null, rnkConv: null,
    depts: [], names: { 101: "А", 102: "Б" },
    teams: [{ teamId: 13, teamName: "РНК", dept: "rnk" as const, members: [], noCostDeals: 0, leads: [], cells: [
      { nomination: "cars" as const, crm: { state: "ok" as const, value: 31, winners: [101] }, deal: null, ranking, review: null,
        final: { status: "unconfirmed" as const, winners: [101], value: 31, reason: null, stale: false } },
    ] }],
  };
  const rows = snapshotRows(view);
  assert.deepEqual((rows[0].extra as { ranking: unknown }).ranking, ranking, "🔴 рейтинг не потрапив у знімок");
  assert.deepEqual(rankingFromExtra(rows[0].extra), ranking);
  assert.equal(rankingFromExtra({ stale: false }), null, "🔴 знімок без рейтингу видав щось замість «не зберігався»");
  assert.equal(rankingFromExtra(null), null);
});

/**
 * #654 — «СКАСУВАТИ» І «ПОГОДИТИСЬ З РЕШТОЮ». Скасування повертає рядок у «чекає» з пропозицією CRM (після
 * погодження й після своїх даних); на порожньому рядку лишає «порожньо». Тіло: `retract` без полів приймається,
 * невідома дія — ні; масове — лише непорожній перелік відомих номінацій.
 * 🧨 Червоніє, якщо `retract` трактувати як `confirm` або якщо «свої дані» переживуть скасування.
 */
test("#654 скасування повертає рядок у «чекає»; масове погодження приймає лише відомі номінації", async () => {
  const { validateBulkConfirm } = await import("./nominationRules.js");
  const crm: Ranked = { state: "ok", value: 31, winners: [101] };
  const fp = fingerprint(crm);
  const retract = { action: "retract" as const, crmFingerprint: fp, overrideManagerIds: null, overrideValue: null, reason: null };
  assert.equal(applyReview(crm, { action: "confirm", crmFingerprint: fp, overrideManagerIds: null, overrideValue: null, reason: null }).status, "confirmed");
  const back = applyReview(crm, retract);
  assert.deepEqual([back.status, back.winners, back.value], ["unconfirmed", [101], 31], "🔴 «Скасувати» не повернуло пропозицію системи");
  assert.equal(applyReview({ state: "empty" }, retract).status, "empty");
  const v = validateReview({ weekFrom: "2026-09-14", teamId: 13, nomination: "cars", action: "retract" });
  assert.ok(v.ok && v.value.action === "retract" && v.value.overrideManagerIds === null);
  assert.equal(validateReview({ weekFrom: "2026-09-14", teamId: 13, nomination: "cars", action: "undo" }).ok, false, "🔴 невідома дія пройшла");
  const b = validateBulkConfirm({ weekFrom: "2026-09-14", teamId: 13, nominations: ["cars", "intl", "cars"] });
  assert.ok(b.ok && b.value.nominations.join() === "cars,intl", "🔴 масове погодження не прибрало дубль");
  assert.equal(validateBulkConfirm({ weekFrom: "2026-09-14", teamId: 13, nominations: [] }).ok, false, "🔴 порожній перелік пройшов");
  assert.equal(validateBulkConfirm({ weekFrom: "2026-09-14", teamId: 13, nominations: ["cars", "hack"] }).ok, false, "🔴 невідома номінація пройшла");
  assert.equal(validateBulkConfirm({ weekFrom: "2026-09-15", teamId: 13, nominations: ["cars"] }).ok, false, "🔴 тиждень не з понеділка пройшов");
});

/**
 * #655 — МИТЬ ФІКСАЦІЇ ЯК UTC по обидва боки переходу на зимовий час: вт 20.10.2026 08:00 Києва = 05:00Z
 * (літній, +03), вт 27.10.2026 08:00 = 06:00Z (зимовий, +02). І ця мить та сама, що в `isFreezeDue`:
 * у неї — «пора», на мілісекунду раніше — ні. 🧨 «Завжди +3» червоніє на 27.10.
 */
test("#655 мить фіксації: вт 08:00 за Києвом влітку й узимку, та сама, що в isFreezeDue", async () => {
  const { freezeInstant } = await import("./nominationRules.js");
  assert.equal(freezeInstant("2026-10-12"), "2026-10-20T05:00:00.000Z", "🔴 літній час: вт 08:00 Києва ≠ 05:00Z");
  assert.equal(freezeInstant("2026-10-19"), "2026-10-27T06:00:00.000Z", "🔴 зимовий час: вт 08:00 Києва ≠ 06:00Z");
  for (const w of ["2026-09-14", "2026-10-19", "2027-03-22", "2027-03-29"]) {
    const at = Date.parse(freezeInstant(w));
    assert.equal(isFreezeDue(w, new Date(at)), true, `🔴 ${w}: у мить фіксації isFreezeDue каже «ще ні»`);
    assert.equal(isFreezeDue(w, new Date(at - 1)), false, `🔴 ${w}: за мілісекунду до фіксації isFreezeDue каже «пора»`);
  }
});

/**
 * #656 — «РАХУЄМО / НЕ РАХУЄМО» Є В КОЖНОЇ НОМІНАЦІЇ І ЗБІГАЄТЬСЯ З ЧИННИМ ПРАВИЛОМ. Саме розбіжність «авто =
 * завантажені» проти «авто = угоди в оплаті» дала «21 Цалко» замість 5 (22.09.2026) — тож для «авто» тексти
 * мусять це називати. 🧨 Червоніє, якщо поле спорожніє або текст «авто» перестане згадувати завантаження/оплату.
 */
test("#656 у кожної номінації є «рахуємо / не рахуємо», і для авто вони про завантаження проти оплати", () => {
  for (const n of NOMINATIONS) {
    assert.ok(n.rule.trim().length > 10, `🔴 «${n.label}»: порожнє «рахуємо»`);
    assert.ok(n.notCounted.trim().length > 5, `🔴 «${n.label}»: порожнє «не рахуємо»`);
  }
  const cars = NOMINATIONS.find((n) => n.key === "cars")!;
  assert.match(cars.rule, /завантаж/, "🔴 «авто» більше не каже, що рахуємо за датою завантаження");
  assert.match(cars.notCounted, /оплат/, "🔴 «авто» більше не каже, що угоди в оплаті не рахуються");
  assert.match(NOMINATIONS.find((n) => n.key === "marginPct")!.notCounted, /Расход/, "🔴 «% маржі» не каже про угоди без «Расходу 1»");
});

/**
 * #658 — «ПОКАЗАТИ УГОДИ» ДАЄ РІВНО ЧИСЛО НОМІНАЦІЇ (жива звірка на ЧЕРНЕТЦІ — див. `draftWeekForLiveCheck`).
 * Для переможця кожної команди: розкриття «Факту» (`/report-plan/day-items`, kind=received) — Σ == «результат» і
 * max == «зазор»; розкриття «Авто» (kind=dispatched) — кількість == «авто». Ті самі види, що в `DRILL_KIND` екрана
 * (його збіг з цими — #650 читає мапу). 🧨 Червоніє, якщо номінацію або розкриття перевести на інше джерело.
 */
test("#658 розкриття угод дає рівно число номінації — результат, зазор, авто", needsApi(), async () => {
  const { signToken } = await import("../auth/auth.js");
  const token = signToken({ userId: 0, role: "admin", roleKey: "admin", managerId: null, teamId: null });
  const H = { headers: { Authorization: `Bearer ${token}` } };
  const { from, to, body } = await draftWeekForLiveCheck(H);
  const nom = body as { teams: { teamId: number; cells: { nomination: string; crm: Ranked }[] }[] };
  const off: string[] = [];
  let compared = 0;
  const items = async (managerId: number, kind: string) => {
    const r = await fetch(`${API_BASE}/api/dashboard/report-plan/day-items?managerId=${managerId}&date=${from}&to=${to}&kind=${kind}`, H);
    assert.equal(r.status, 200, `🔴 day-items ${kind} для ${managerId} віддав ${r.status}`);
    return await r.json() as { items: { price: number }[]; total: { count: number; sum: number } };
  };
  for (const t of nom.teams) {
    for (const key of ["revenue", "maxDeal", "cars"]) {
      const c = t.cells.find((x) => x.nomination === key)!;
      if (c.crm.state !== "ok") continue;
      const w = c.crm.winners[0];
      const got = await items(w, key === "cars" ? "dispatched" : "received");
      const val = key === "revenue" ? got.total.sum : key === "maxDeal" ? Math.max(0, ...got.items.map((i) => i.price)) : got.total.count;
      compared++;
      if (Math.abs(val - c.crm.value) >= 1) off.push(`${t.teamId}/${key}/${w}: розкриття ${val} ≠ номінація ${c.crm.value}`);
    }
  }
  assert.ok(compared > 0, "🔴 жодної номінації з переможцем — звіряти нічого, перевірка вироджена");
  assert.deepEqual(off, [], "🔴 «Показати угоди» не дає числа номінації");
});

/* ─────────────────────────── лідогенератори й конверсія РНК (22.09.2026, слайди 4–5 Даші) ─────────────────────────── */

/**
 * #660 — РЕЙТИНГ ЛІДОГЕНЕРАТОРІВ: чотири номінації Даші; «прорахунки» — з CRM, решта позначені «система не рахує»
 * (звʼязку угоди з лідогенератором у CRM немає — число вносить тімлід або керівництво). Ключі приймає тіло рішення;
 * знімок фіксує лідогенераторів із dept 'lg'; команда рішень — та сама, що в NON_COMMERCIAL_TEAM_IDS.
 * 🧨 Червоніє, якщо «прорахунки» стануть «без CRM» (або навпаки зазор почне вдавати число CRM), або лідогенератори
 * випадуть зі знімка.
 */
test("#660 лідогенератори: прорахунки з CRM, решта — дані тімліда; у знімку dept 'lg'", async () => {
  for (const k of ["DATABASE_URL", "JWT_SECRET", "KOMMO_BASE_URL", "KOMMO_API_TOKEN"]) process.env[k] ??= "test";
  const { LEADGEN_NOMINATIONS, isNominationKey, snapshotRows } = await import("./nominationRules.js");
  assert.deepEqual(LEADGEN_NOMINATIONS.map((n) => [n.key, !!n.noCrm]),
    [["lgMaxDeal", true], ["lgCars", true], ["lgQuotes", false], ["lgIntl", true]], "🔴 набір номінацій лідогенераторів або ознака «з CRM» не ті");
  assert.match(LEADGEN_NOMINATIONS.find((n) => n.key === "lgQuotes")!.rule, /Кваліфіковано/, "🔴 «прорахунки» більше не про «Кваліфіковано» Продзвону");
  assert.ok(isNominationKey("lgQuotes") && isNominationKey("maxDeal") && !isNominationKey("lgHack"));
  assert.ok(validateReview({ weekFrom: "2026-09-14", teamId: 11, nomination: "lgMaxDeal", action: "override", overrideManagerIds: [301], overrideValue: 15000, reason: "з таблиці лідгену" }).ok);
  const lg = { teamId: 11, teamName: "Лідогенерація", dept: "lg" as const, members: [{ id: 301, name: "Л" }], noCostDeals: 0, leads: [], cells: [
    { nomination: "lgQuotes" as const, crm: { state: "ok" as const, value: 36, winners: [301] }, deal: null, ranking: [{ managerId: 301, value: 36 }], review: null,
      final: { status: "unconfirmed" as const, winners: [301], value: 36, reason: null, stale: false } },
  ] };
  const view = { weekFrom: "2026-09-14", weekTo: "2026-09-20", state: "draft" as const, frozenAt: null, ruleVersion: "x", freezeDueAt: "", freezeInstant: "",
    depts: [], names: { 301: "Л" }, teams: [], leadgen: lg, rnkConv: null };
  const rows = snapshotRows(view);
  assert.deepEqual(rows.map((r) => [r.dept, r.teamId, r.nomination, r.value]), [["lg", 11, "lgQuotes", 36]], "🔴 лідогенератори не потрапили в знімок");
  const { LEADGEN_TEAM_ID } = await import("./nominations.js");
  const { NON_COMMERCIAL_TEAM_IDS } = await import("./metrics.js");
  assert.ok((NON_COMMERCIAL_TEAM_IDS as readonly number[]).includes(LEADGEN_TEAM_ID), "🔴 команда рішень лідогенераторів — не некомерційна команда лідогену");
});

/**
 * #661 — ТАБЛИЦЯ КОНВЕРСІЇ РНК: система + правки. Остання правка перемагає, «reset» повертає число CRM; відсоток до
 * сотих (4/24 = 16,67); без явного вибору на слайд ідуть 4 найкращі, з явним — рівно обрані; коментар — останній.
 * Тіло: успіх не більший за ліди; «set» без «на слайд» — відмова. 🧨 Червоніє, якщо reset не поверне CRM,
 * округлення стане до цілого, або типовий вибір не 4 найкращі.
 */
test("#661 конверсія РНК: правка перемагає, reset повертає CRM, на слайд — 4 найкращі або обрані", async () => {
  const { buildRnkConv, validateConvEdit } = await import("./nominationRules.js");
  const sys = [
    { managerId: 1, name: "А", teamId: 13, taken: 20, won: 2 }, { managerId: 2, name: "Б", teamId: 13, taken: 10, won: 3 },
    { managerId: 3, name: "В", teamId: 15, taken: 9, won: 3 }, { managerId: 4, name: "Г", teamId: 15, taken: 30, won: 3 },
    { managerId: 5, name: "Ґ", teamId: 15, taken: 0, won: 0 }, { managerId: 6, name: "Д", teamId: 13, taken: 12, won: 5 },
  ];
  const at = "2026-09-21T10:00:00.000Z";
  const base = buildRnkConv(sys, []);
  assert.deepEqual(base.rows.filter((r) => r.onSlide).map((r) => r.managerId), [6, 3, 2, 4], "🔴 типовий вибір — не 4 найкращі за % (при рівності — більше лідів)");
  const e = (x: Partial<{ managerId: number | null; action: "set" | "reset" | "comment"; taken: number | null; won: number | null; onSlide: boolean | null; comment: string | null }>) =>
    ({ managerId: null, action: "set" as const, taken: null, won: null, onSlide: null, comment: null, by: "Даша", at, ...x });
  const own = buildRnkConv(sys, [e({ managerId: 1, taken: 24, won: 4, onSlide: true }), e({ action: "comment", comment: "реклама зросла" })]);
  const r1 = own.rows.find((r) => r.managerId === 1)!;
  assert.deepEqual([r1.taken, r1.won, r1.pct, r1.crm, r1.own?.by], [24, 4, 16.67, { taken: 20, won: 2 }, "Даша"], "🔴 правка не перемогла або % не до сотих");
  assert.deepEqual(own.rows.filter((r) => r.onSlide).map((r) => r.managerId), [1], "🔴 при явному виборі на слайді не рівно обрані");
  assert.equal(own.comment?.text, "реклама зросла");
  const back = buildRnkConv(sys, [e({ managerId: 1, taken: 24, won: 4, onSlide: true }), e({ managerId: 1, action: "reset" })]);
  const b1 = back.rows.find((r) => r.managerId === 1)!;
  assert.deepEqual([b1.taken, b1.won, b1.own], [20, 2, null], "🔴 «Як у CRM» не повернуло число системи");
  assert.equal(validateConvEdit({ weekFrom: "2026-09-14", action: "set", managerId: 1, taken: 3, won: 4, onSlide: true }).ok, false, "🔴 успіх більший за ліди пройшов");
  assert.equal(validateConvEdit({ weekFrom: "2026-09-14", action: "set", managerId: 1, taken: 5, won: 4 }).ok, false, "🔴 правка без «на слайд» пройшла");
  assert.ok(validateConvEdit({ weekFrom: "2026-09-14", action: "set", managerId: 1, taken: 24, won: 4, onSlide: false }).ok);
  assert.ok(validateConvEdit({ weekFrom: "2026-09-14", action: "comment", comment: "  " }).ok);
  assert.equal(validateConvEdit({ weekFrom: "2026-09-15", action: "reset", managerId: 1 }).ok, false, "🔴 тиждень не з понеділка пройшов");
});
