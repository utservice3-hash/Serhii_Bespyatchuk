import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 🎂 Задача 10723: нове правило днів народження (ТЗ Тетяни 23.11.2026, затвердив Сергій 24.11, Роман 24.11 «з сьогодні» → з листопада).
 * Іменинникові — 100 ₴ × повні місяці стажу, не більше 12 (від року — 1 200), + від компанії 400 / тім-ліду 600. З кожного
 * працюючого — один рядок «Фонд днів народження» −100 ₴ щомісяця, скільки б не було іменинників (Тетяна 24.11: «з усіх, незважаючи
 * ні на що» — іменинник, новачок і той, хто звільняється в цьому місяці, теж). Місяці до `v2From` — правило пакета (збір колег).
 * Гейти `#10880`–`#10883`. Рушій — чистий модуль, імпорт лінивий, як велить правило зони testing.
 */
const SRC = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "src", p), "utf8");
const FRONT = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", p), "utf8");

type Line = { kind: string; amount: number; who?: string; date?: string; gift?: Record<string, unknown> };
type Zp = { birthdayLines: (id: string, mk: string) => Line[]; birthdayGift: (id: string, mk: string) => Record<string, any> | null; calc: (id: string, mk: string) => Record<string, any> };

/**
 * Листопад 2026 — поточний. Іменинники листопада: Аня (рівно 12 повних місяців), Борис (9 місяців), Ціна — тім-лід зі стажем 6 років.
 * Дан — новачок з 16.11 (ДН у січні: 1 місяць стажу), Єва звільняється 10.11, Фая звільнилась у жовтні. У грудні іменинників немає.
 */
const emp = (id: string, o: Record<string, unknown>) => ({ id, name: `Людина ${id}`, role: "staff", title: "Посада", dept: "ops", team: null,
  startDate: "2024-01-01", birthday: null, terms: [{ from: "2024-01", rate: 20000 }], official: [], leave: null, clientRates: [], ...o });
async function zp(v2From: string | null): Promise<Zp> {
  const { createPayroll } = await import("./engine/zarplata-engine.mjs");
  return createPayroll({
    now: "2026-11-25T10:00", liveMonth: "2026-11", closedMonth: "2026-10",
    settings: { birthday: { v2From } },
    employees: [
      emp("1", { name: "Аня", startDate: "2025-11-10", birthday: "11-20" }),
      emp("2", { name: "Борис", startDate: "2026-01-15", birthday: "11-05" }),
      emp("3", { name: "Ціна", role: "lead", leadsTeam: "t1", dept: "sales", startDate: "2020-01-01", birthday: "11-11", terms: [{ from: "2020-01", rate: 30000 }] }),
      emp("4", { name: "Дан", startDate: "2026-11-16", birthday: "01-03" }),
      emp("5", { name: "Єва", leave: { date: "2026-11-10", type: "own" } }),
      emp("6", { name: "Фая", leave: { date: "2026-10-05", type: "own" } }),
    ],
    departments: { ops: { name: "Операційний", sales: false }, sales: { name: "Продажі", sales: true } }, teams: { t1: { name: "Команда" } },
    plans: {}, deals: {}, kpi: {},
    responsibles: { ba: { id: "", name: "БА" }, acc: { id: "", name: "Бух" }, hr: { id: "", name: "HR" }, od: { id: "3", name: "ОД" }, finance: [] },
  } as never) as never as Zp;
}

/**
 * #10880 — ПОДАРУНОК ІМЕНИННИКУ ЗА СТАЖЕМ, по обидва боки межі «рік» і по обидва боки `v2From`: 9 повних місяців → 9 × 100 + 400;
 * рівно 12 → 1 200 + 400; 6 років → теж 1 200 (не більше 12) + 600 тім-ліду; новачок із 1 місяцем → 100 + 400. До `v2From` —
 * як у пакеті: від року — збір колег (100 × працюючі колеги) + 400.
 * 🧨 Червоніє, якщо не обмежити стаж 12 місяцями (тім-лід отримає 7 600), забути компанію/тім-ліда або повернути збір колег.
 */
test("#10880 ДН ЗА СТАЖЕМ: 9 міс → 1 300, 12 міс → 1 600, тім-лід 6 років → 1 800, новачок 1 міс → 500; до v2From — збір колег", async () => {
  const z = await zp("2026-11");
  const amt = (id: string, mk: string) => z.birthdayGift(id, mk)?.amount ?? null;
  assert.equal(amt("2", "2026-11"), 9 * 100 + 400, "🔴 Борис, 9 повних місяців: 100 × 9 + 400");
  assert.equal(amt("1", "2026-11"), 1200 + 400, "🔴 Аня, рівно рік: 1 200 + 400");
  assert.equal(amt("3", "2026-11"), 1200 + 600, "🔴 тім-лід зі стажем 6 років: не більше 1 200 + 600 від компанії");
  assert.equal(amt("4", "2027-01"), 100 + 400, "🔴 новачок з 1 повним місяцем: 100 + 400");
  assert.equal(z.birthdayGift("1", "2026-11")?.v2, true, "🔴 подарунок не позначено новим правилом");
  // 🪞 до v2From — правило пакета: Аня від року збирає з 4 працюючих колег (Борис, Ціна, Дан, Єва), Фаї вже немає
  const old = await zp("2026-12");
  assert.equal(old.birthdayGift("1", "2026-11")?.amount, 4 * 100 + 400, "🔴 до v2From подарунок від року має бути збором колег, як раніше");
  assert.equal(old.birthdayGift("2", "2026-11")?.amount, 9 * 100 + 400, "до року — однаково в обох правилах");
});

/**
 * #10881 — ФОНД: РІВНО ОДИН РЯДОК −100 НА МІСЯЦЬ КОЖНОМУ ПРАЦЮЮЧОМУ, при 3 іменинниках (листопад), 0 (грудень) і 1 (січень);
 * іменинник, новачок і той, хто звільняється в цьому місяці, — теж; хто звільнився раніше — без рядків. До `v2From` — фонду немає,
 * а є збір на кожного іменинника.
 * 🧨 Червоніє, якщо рядок фонду залежатиме від кількості іменинників, когось пропустить або лишиться старий збір колег.
 */
test("#10881 ФОНД ДН: один рядок −100 щомісяця кожному працюючому при 0, 1 і 3 іменинниках; до v2From — збір колег", async () => {
  const z = await zp("2026-11");
  const fund = (id: string, mk: string) => z.birthdayLines(id, mk).filter((l) => l.kind === "fund").map((l) => l.amount);
  const give = (id: string, mk: string) => z.birthdayLines(id, mk).filter((l) => l.kind === "give").length;
  for (const mk of ["2026-11", "2026-12", "2027-01"]) {
    for (const id of ["1", "2", "3", "5"].filter((x) => !(x === "5" && mk > "2026-11")))
      assert.deepEqual(fund(id, mk), [-100], `🔴 ${mk}: у людини ${id} має бути рівно один рядок фонду −100`);
    assert.equal(give("2", mk), 0, `🔴 ${mk}: за новим правилом збору на колег немає`);
  }
  assert.deepEqual(fund("4", "2026-11"), [-100], "🔴 новачок з 16.11 теж платить у фонд у перший місяць");
  assert.deepEqual(fund("5", "2026-11"), [-100], "🔴 людина, що звільняється в листопаді, теж платить у листопаді");
  assert.deepEqual(z.birthdayLines("5", "2026-12"), [], "🔴 після місяця звільнення рядків немає");
  assert.deepEqual(z.birthdayLines("6", "2026-11"), [], "🔴 звільнена в жовтні не платить у листопаді");
  assert.deepEqual(z.birthdayLines("1", "2026-11").map((l) => [l.kind, l.amount]), [["gift", 1600], ["fund", -100]], "🔴 іменинниця: подарунок і свій рядок фонду");
  // 🪞 до v2From: фонду немає, Борис дає по 100 на двох іменинників від року (Аня, Ціна)
  const old = await zp("2026-12");
  assert.equal(old.birthdayLines("2", "2026-11").filter((l) => l.kind === "fund").length, 0, "🔴 до v2From фонду не має бути");
  assert.deepEqual(old.birthdayLines("2", "2026-11").filter((l) => l.kind === "give").map((l) => l.amount), [-100, -100], "🔴 до v2From — збір на кожного іменинника від року");
});

/**
 * #10882 — РОЗРАХУНОК: рядок ДН у «зараз» = подарунок − фонд. Іменинниця Аня: +1 600 − 100; не іменинник у грудні: −100.
 * 🧨 Червоніє, якщо фонд не дійде до суми нарахування (рядок буде, а гроші ні).
 */
test("#10882 ДН У РОЗРАХУНКУ: «зараз» несе подарунок мінус фонд (+1 500 іменинниці), не іменинник — рівно −100", async () => {
  const z = await zp("2026-11");
  assert.equal(z.calc("1", "2026-11").now.birthday, 1600 - 100, "🔴 у розрахунок іменинниці має йти подарунок мінус свій внесок у фонд");
  assert.equal(z.calc("5", "2026-11").now.birthday, -100, "🔴 у розрахунок не іменинника має йти рівно −100");
});

/**
 * #10883 — ПРАВИЛО ВВІМКНЕНО З ЛИСТОПАДА 2026 і ЛЮДИ ЙОГО БАЧАТЬ: `state.ts` ставить `v2From = 2026-11` поверх версії з БД, екран
 * налаштувань отримує те саме; кабінет, лист і «Перевірка» показують «Фонд днів народження», правила — новий текст.
 * Парне твердження до #10874: старий текст правила лишається лише для місяців до v2From, а не зникає разом із правилом.
 * 🧨 Червоніє, якщо дата зміниться мовчки, налаштування перекриє правило або рядок фонду пропаде з будь-якого екрана.
 */
test("#10883 ДН З ЛИСТОПАДА: v2From = 2026-11 у розрахунку й налаштуваннях; фонд видно в кабінеті, листі й «Перевірці»", () => {
  const st = SRC("payroll/state.ts"), svc = SRC("payroll/service.ts");
  assert.match(st, /export const BIRTHDAY_V2_FROM = "2026-11";/, "🔴 нове правило ДН має діяти з листопада 2026");
  assert.match(st, /settings\.birthday = \{ \.\.\.\(settings\.birthday as object \?\? \{\}\), v2From: BIRTHDAY_V2_FROM \};/, "🔴 версія налаштувань з БД перекриває правило ДН");
  assert.match(svc, /merged\.birthday = \{ \.\.\.\(merged\.birthday as object\), v2From: BIRTHDAY_V2_FROM \};/, "🔴 екран налаштувань не знає про нове правило");
  assert.match(FRONT("payroll/cabinet/CloseCard.tsx"), /k: "Фонд днів народження"/, "🔴 у розрахунковому листі немає рядка фонду");
  assert.match(FRONT("payroll/cabinet/Overview.tsx"), /k: "Фонд днів народження"/, "🔴 у «З чого складається» немає рядка фонду");
  assert.match(FRONT("payroll/finance/VerifyTab.tsx"), /b\.kind === "fund" \? "Фонд днів народження"/, "🔴 у «Перевірці» фонд показано як «ДН колеги»");
  const terms = FRONT("payroll/cabinet/Terms.tsx");
  assert.match(terms, /bdayV2\(S, me\.live\?\.month\)\s*\? \["Дні народження", `щомісяця з кожного/, "🔴 правила в кабінеті не описують нове правило");
  assert.match(terms, /: \["Дні народження", `з кожного — \$\{nf\(S\.birthday\.each\)\} ₴ на колегу/, "🔴 старий текст правила зник для місяців до v2From");
});
