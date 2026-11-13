import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ACCESS_MATRIX } from "../auth/accessMatrix.js";
import { tabsForPath } from "../auth/routeTab.js";
import { phone9, parseLardiUsers, lardiVerdict, archiveSummary, LARDI_CHECK_LIST, LARDI_CHECK_DAYS, type ArchiveOffer } from "./lardiCheckRules.js";

/**
 * 🔎 «ПЕРЕВІРИТИ НОМЕР НА ЛАРДІ» (задача 8136). Гейти стережуть три речі, на яких тримається довіра до вердикту:
 * номер не шукається за уривком; «Ларді не відповів» не читається як «не знайдено»; вердикт не стверджує типу компанії,
 * якого Ларді не віддає.
 */
const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const src = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const offer = (o: Partial<ArchiveOffer>): ArchiveOffer => ({
  side: "cargo", offerId: "1", company: "ТОВ А", face: null, from: "Київ", to: "Львів", cargo: "цегла", mass: 20,
  total: 30000, currency: "грн.", negotiable: false, seenAt: "2026-11-10", ...o,
});

test("#3950 🪞 НОМЕР: будь-який запис дає ті самі 9 цифр; уривок і сміття — не номер", () => {
  for (const s of ["0671234567", "+380671234567", "380 (67) 123-45-67", "67 123 45 67", "8 067 123 45 67"]) {
    assert.equal(phone9(s), "671234567", `🔴 «${s}» не звівся до 9 цифр`);
  }
  assert.equal(phone9("67123456"), null, "🔴 8 цифр прийнято за номер — пошук за уривком покаже чужу компанію");
  assert.equal(phone9("12345678901234"), null, "🔴 14 цифр прийнято за номер");
  assert.equal(phone9(""), null); assert.equal(phone9(undefined), null); assert.equal(phone9("Ларді"), null);
});

test("#3951 🪞 ВЕРДИКТ — ВІД ТОГО, ЩО ВИДНО: вантажі й машини — не передавати; лише реєстрація — рішення лідгена; мовчання Ларді — не «не знайдено»", () => {
  const cargo = lardiVerdict({ users: 1, cargo: 3, lorry: 0, liveOk: true });
  assert.deepEqual([cargo.kind, cargo.pass], ["cargo", false], "🔴 компанію з вантажами на Ларді дозволено передавати");
  const both = lardiVerdict({ users: 1, cargo: 3, lorry: 2, liveOk: true });
  assert.deepEqual([both.kind, both.pass], ["cargo", false]); assert.match(both.title, /і вантажі, і машини/);
  const carrier = lardiVerdict({ users: 0, cargo: 0, lorry: 4, liveOk: true });
  assert.deepEqual([carrier.kind, carrier.pass], ["carrier", false], "🔴 перевізника дозволено передавати");
  const known = lardiVerdict({ users: 1, cargo: 0, lorry: 0, liveOk: true });
  assert.deepEqual([known.kind, known.pass], ["known", null], "🔴 реєстрація на Ларді без заявок дала готовий висновок");
  const none = lardiVerdict({ users: 0, cargo: 0, lorry: 0, liveOk: true });
  assert.deepEqual([none.kind, none.pass], ["none", true], "🔴 номер, якого немає ніде, не «можна передавати»");
  // Дзеркало: ті самі нулі, але Ларді НЕ відповів — висновку немає (порожній результат ≠ успіх).
  const silent = lardiVerdict({ users: 0, cargo: 0, lorry: 0, liveOk: false });
  assert.deepEqual([silent.kind, silent.pass], ["none", null], "🔴 мовчання Ларді прочитано як «не знайдено — передавати»");
  // Архів сильніший за мовчання: заявки є — вердикт є й без живої відповіді.
  assert.equal(lardiVerdict({ users: 0, cargo: 1, lorry: 0, liveOk: false }).pass, false);
  // Типу компанії Ларді не віддає — вердикт його не стверджує.
  for (const v of [cargo, both, carrier, known, none, silent]) {
    assert.doesNotMatch(v.title, /експедиц|вантажовідправник/i, `🔴 заголовок «${v.title}» стверджує тип компанії, якого в даних немає`);
  }
});

test("#3952 🪞 АРХІВ І ВІДПОВІДЬ ЛАРДІ: числа — по всіх заявках, список — останні; чужа форма відповіді — порожньо", () => {
  const many = Array.from({ length: LARDI_CHECK_LIST + 3 }, (_, i) =>
    offer({ offerId: String(i), seenAt: `2026-11-${String(i + 1).padStart(2, "0")}`, to: i % 2 ? "Львів" : "Одеса", total: i === 0 ? null : 1000 + i }));
  const s = archiveSummary([...many, offer({ side: "lorry", offerId: "L1", company: "ФОП Б" })]);
  assert.deepEqual([s.cargo, s.lorry, s.routes, s.withPrice], [LARDI_CHECK_LIST + 3, 1, 2, LARDI_CHECK_LIST + 2], "🔴 підсумок архіву порахований не по всіх заявках");
  assert.equal(s.last.length, LARDI_CHECK_LIST, "🔴 список не обмежений");
  assert.equal(s.last[0].seenAt, `2026-11-${String(LARDI_CHECK_LIST + 3).padStart(2, "0")}`, "🔴 у списку не найсвіжіші заявки");
  assert.ok(s.last.every((o) => o.side === "cargo"), "🔴 машини потрапили у список вантажів");
  assert.deepEqual(s.companies, ["ТОВ А", "ФОП Б"]);
  assert.deepEqual(archiveSummary([]), { cargo: 0, lorry: 0, routes: 0, withPrice: 0, companies: [], last: [], lastLorry: [] });

  const users = parseLardiUsers([
    { refId: 13343989534, name: " Яцків Орест, ФОП ", address: { town: { id: 179, name: "Львів" } }, rating: { positiveCommentCount: 8, negativeCommentCount: 0 }, createDate: 1404829569000 },
    { refId: 0, name: "без id" }, { refId: 5, name: "" }, null,
  ]);
  assert.deepEqual(users, [{ refId: 13343989534, name: "Яцків Орест, ФОП", town: "Львів", positive: 8, negative: 0, since: "2014-07-08" }]);
  assert.deepEqual(parseLardiUsers({ statusCode: 403, message: "пакет" }), [], "🔴 відмова Ларді розібрана як список користувачів");
});

test("#3953 ПРОВОДКА 8136: межа першим оператором і раніше за номер; матриця й вкладка як у /leadgen-stats; архів — за 9 цифрами у вікні; екран каже, що архів — не весь Ларді", () => {
  const r = src("backend/src/routes/dashboard.ts");
  const at = r.indexOf('dashboardRouter.get("/leadgen-lardi-check"');
  assert.ok(at > 0, "🔴 роуту /leadgen-lardi-check немає");
  const body = r.slice(at, r.indexOf("\n});", at));
  const deny = body.indexOf('viewer.kind === "deny"'), p9 = body.indexOf("phone9("), read = body.indexOf("lardiCheck(");
  assert.ok(deny > 0 && deny < p9 && p9 < read, "🔴 межа не перед перевіркою номера або читання — раніше за межу (403 мусить бути раніше за 400)");

  const row = (p: string) => ACCESS_MATRIX.filter((x) => x.method === "GET" && x.path === p);
  const base = row("/api/dashboard/leadgen-stats")[0], mine = row("/api/dashboard/leadgen-lardi-check");
  assert.equal(mine.length, 1, "🔴 рядка матриці немає або їх кілька");
  assert.ok(base.deny.includes("manager"), "еталон не той — порівнювати нема з чим");
  assert.deepEqual([[...mine[0].allow].sort(), [...mine[0].deny].sort()], [[...base.allow].sort(), [...base.deny].sort()], "🔴 доступ не як у /leadgen-stats");
  assert.deepEqual(tabsForPath("/api/dashboard/leadgen-lardi-check"), ["leadgen"], "🔴 роут без вкладкової межі");

  const core = src("backend/src/core/lardiCheck.ts");
  assert.match(core, /\$\{PHONE9\("p->>'n'"\)\} = \$1/, "🔴 архів звіряє номер не за спільними 9 цифрами");
  assert.match(core, /make_interval\(days => \$2\)/, "🔴 вікно архіву не параметром");
  assert.match(core, /\[p9, LARDI_CHECK_DAYS\]/, "🔴 вікно архіву — не константа правила");
  assert.match(core, /if \(res\.status !== 200\) return \{ ok: false/, "🔴 не-200 від Ларді не відрізняється від порожньої відповіді");
  assert.equal(LARDI_CHECK_DAYS, 30);

  const ui = src("frontend/src/pages/dashboard/sections/LeadgenLardiCheck.tsx");
  assert.match(ui, /а не весь Ларді/, "🔴 екран не каже, що архів — не весь Ларді");
  assert.match(ui, /Ларді зараз не відповів/, "🔴 екран мовчить, коли Ларді не відповів");
  assert.match(src("frontend/src/pages/dashboard/sections/LeadgenSection.tsx"), /\{!denied && <LeadgenLardiCheck \/>\}/, "🔴 блок не підключений до екрана");
});
