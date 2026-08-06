import { test } from "node:test";
import assert from "node:assert/strict";
import { needsApi, API_BASE } from "../testMode.js";

/**
 * #60 — Σ РЯДКІВ РОЗКРИТТЯ == ЧИСЛО В КОМІРЦІ. Для КОЖНОГО типу, на живих даних.
 *
 * 🔴 ЦЕ НЕ «ТЕСТ НА ЕНДПОІНТ», А ПЕРЕВІРКА ОБІЦЯНКИ, ЯКУ ДАЄ ЕКРАН. Розкриття
 * існує рівно для того, щоб людина склала рядки очима й отримала число, з якого
 * їх розкрила. Щойно Σ розійдеться — фіча не «трохи неточна», вона бреше саме там,
 * де обіцяла доказ.
 *
 * ⚠️ ЧОМУ ПО ТРЬОХ МЕНЕДЖЕРАХ І ЛИШЕ З НЕНУЛЬОВИМ РУХОМ. `0 == 0` сходиться завжди
 * і не доводить нічого; саме так виглядав би зелений гейт над зламаним фільтром.
 * Тому шукаємо дні, де число НЕ нуль, і звіряємо там.
 *
 * 🧨 САБОТАЖ: зміни фільтр одного типу (напр. `dispatched_paid` почне віддавати ВСІ
 * авто) → гейт червоніє, НАЗИВАЮЧИ тип і день, а не «щось не зійшлось».
 */

/** Тип розкриття ↔ як дістати те саме число з рядка дня `manager-detail`. */
type DayCell = {
  created: number; dispatched: number; dispSum: number;
  dispPaid: { deals: number; sum: number }; dispAwait: { deals: number; sum: number };
  success: { deals: number; revenue: number }; paid: { deals: number; revenue: number };
  received: { deals: number; revenue: number }; talks: number; attempts: number;
  day: string;
};
const KINDS: { kind: string; label: string; count: (c: DayCell) => number; sum: ((c: DayCell) => number) | null }[] = [
  { kind: "created", label: "Створено", count: (c) => c.created, sum: null },
  { kind: "dispatched", label: "Авто відправлені", count: (c) => c.dispatched, sum: (c) => c.dispSum },
  { kind: "dispatched_paid", label: "З них оплачено", count: (c) => c.dispPaid.deals, sum: (c) => c.dispPaid.sum },
  { kind: "dispatched_awaiting", label: "З них чекає оплати", count: (c) => c.dispAwait.deals, sum: (c) => c.dispAwait.sum },
  { kind: "success", label: "Закрито ①", count: (c) => c.success.deals, sum: (c) => c.success.revenue },
  { kind: "paid", label: "Прийшло ⑨", count: (c) => c.paid.deals, sum: (c) => c.paid.revenue },
  { kind: "received", label: "Отримано ②", count: (c) => c.received.deals, sum: (c) => c.received.revenue },
  { kind: "avgcheck", label: "Сер.чек ②", count: (c) => c.received.deals, sum: (c) => c.received.revenue },
  { kind: "calls", label: "Дзвінки", count: (c) => c.talks + c.attempts, sum: null },
];

async function ctx() {
  const { signToken } = await import("../auth/auth.js");
  const token = signToken({ userId: 0, role: "admin", roleKey: "admin", managerId: null, teamId: null });
  const H = { Authorization: `Bearer ${token}` };
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const from = `${ym}-01`;
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  const rp = await fetch(`${API_BASE}/api/dashboard/report-plan?from=${from}&to=${to}`, { headers: H });
  const body = await rp.json() as { managers: { managerId: number; name: string }[] };
  return { H, from, to, mgrs: (body.managers ?? []).slice(0, 8) };
}

test("#60 Σ рядків розкриття == число в комірці, для кожного типу", needsApi(), async () => {
  const { H, from, to, mgrs } = await ctx();
  assert.ok(mgrs.length >= 3, "🔴 менш як три менеджери — перевіряти нема на кому");

  const problems: string[] = [];
  /** Скільки НЕНУЛЬОВИХ прикладів знайшлось на кожен тип — для дзеркала `#60b`. */
  const checked = new Map<string, number>(KINDS.map((k) => [k.kind, 0]));

  for (const m of mgrs) {
    const r = await fetch(
      `${API_BASE}/api/dashboard/kvp-report/manager-detail?managerId=${m.managerId}&from=${from}&to=${to}`,
      { headers: H });
    if (r.status !== 200) continue;
    const d = await r.json() as { weeks?: { days?: DayCell[] }[] };
    const days = (d.weeks ?? []).flatMap((w) => w.days ?? []);

    for (const k of KINDS) {
      // 🔴 Беремо ЛИШЕ дні з ненульовим числом: «0 == 0» зійшлося б і на зламаному фільтрі.
      const day = days.find((c) => k.count(c) > 0);
      if (!day) continue;
      if ((checked.get(k.kind) ?? 0) >= 3) continue; // трьох підтверджень на тип достатньо
      const q = `${API_BASE}/api/dashboard/report-plan/day-items`
        + `?managerId=${m.managerId}&date=${day.day}&kind=${k.kind}`;
      const dr = await fetch(q, { headers: H });
      if (dr.status !== 200) { problems.push(`${k.label} (${m.name} ${day.day}): HTTP ${dr.status}`); continue; }
      const got = await dr.json() as { items: { price: number }[]; total: { count: number; sum: number } };

      checked.set(k.kind, (checked.get(k.kind) ?? 0) + 1);
      const wantCount = k.count(day);
      if (got.total.count !== wantCount) {
        problems.push(`${k.label} (${m.name} ${day.day}): у комірці ${wantCount}, у розкритті ${got.total.count}`);
      }
      // Підсумок мусить дорівнювати САМИМ рядкам — інакше «доказ» рахується окремо від того, що показано.
      const rowsSum = got.items.reduce((s, x) => s + x.price, 0);
      if (k.sum && Math.abs(rowsSum - got.total.sum) > 1) {
        problems.push(`${k.label} (${m.name} ${day.day}): Σ рядків ${rowsSum} ≠ підсумок ${got.total.sum}`);
      }
      if (k.sum) {
        const wantSum = k.sum(day);
        if (Math.abs(got.total.sum - wantSum) > 1) {
          problems.push(`${k.label} (${m.name} ${day.day}): сума в комірці ${wantSum}, у розкритті ${got.total.sum}`);
        }
      }
    }
  }
  assert.deepEqual(problems, [],
    "🔴 РОЗКРИТТЯ РОЗІЙШЛОСЬ ІЗ ЧИСЛОМ, ЯКЕ ВОНО ПОЯСНЮЄ:\n  " + problems.join("\n  "));

  // ⚠️ Порожній результат = ПРОВАЛ: доводимо, що перевіряти БУЛО що.
  const never = KINDS.filter((k) => (checked.get(k.kind) ?? 0) === 0).map((k) => k.label);
  assert.deepEqual(never, [],
    `🔴 ТИПИ, ДЛЯ ЯКИХ НЕ ЗНАЙШЛОСЬ ЖОДНОГО НЕНУЛЬОВОГО ПРИКЛАДУ: ${never.join(", ")}. `
    + "Гейт про них нічого не довів — це не «зелено», це «не перевірено». "
    + "Або період порожній, або фільтр типу віддає нуль завжди.");
});

/**
 * #60b — ДЗЕРКАЛО: розкриття НЕ мовчить там, де числа немає, і не вигадує там, де є.
 *
 * Дві межі, кожна вже коштувала б довіри до екрана:
 *   (1) невідомий `kind` → 400, а не тихий порожній список (інакше друкарська
 *       помилка у фронті виглядала б як «того дня нічого не було»);
 *   (2) день БЕЗ руху → рівно нуль позицій, а не «щось схоже» з іншої дати.
 */
test("#60b невідомий тип падає, порожній день віддає рівно нуль", needsApi(), async () => {
  const { H, from, to, mgrs } = await ctx();
  const m = mgrs[0];
  assert.ok(m, "🔴 нема менеджера");

  const bad = await fetch(
    `${API_BASE}/api/dashboard/report-plan/day-items?managerId=${m.managerId}&date=${from}&kind=усе_підряд`,
    { headers: H });
  assert.equal(bad.status, 400,
    `🔴 невідомий kind віддав ${bad.status} замість 400 — помилка у фронті читалась би як «нічого не було»`);

  // Далека майбутня дата: руху там бути не може за побудовою.
  const future = `${to.slice(0, 4)}-12-31`;
  const empty = await fetch(
    `${API_BASE}/api/dashboard/report-plan/day-items?managerId=${m.managerId}&date=${future}&kind=received`,
    { headers: H });
  assert.equal(empty.status, 200, `🔴 порожній день віддав ${empty.status}`);
  const e = await empty.json() as { items: unknown[]; total: { count: number; sum: number } };
  assert.deepEqual({ n: e.items.length, c: e.total.count, s: e.total.sum }, { n: 0, c: 0, s: 0 },
    "🔴 на дні без руху розкриття віддало позиції — фільтр по даті не тримає");
});

/**
 * #60c — КОГОРТА ДНЯ РОЗБИВАЄТЬСЯ БЕЗ ЗАЛИШКУ: `оплачено + чекає == відправлено`,
 * і за кількістю, і за сумою.
 *
 * 🔴 Без цього коричнева смуга виглядала б робочою при будь-якому з двох зламаних
 * фільтрів: обидва підмножини можуть бути «схожими на правду» окремо. Рівність
 * саме РОЗБИТТЯ — те, що людина перевіряє очима, і те, що обіцяє підпис під
 * таблицею («оплачено плюс чекає завжди дорівнює сумі відправлених»).
 */
test("#60c когорта дня: оплачено + чекає == відправлено", needsApi(), async () => {
  const { H, from, to, mgrs } = await ctx();
  const problems: string[] = [];
  let checkedDays = 0;
  for (const m of mgrs) {
    const r = await fetch(
      `${API_BASE}/api/dashboard/kvp-report/manager-detail?managerId=${m.managerId}&from=${from}&to=${to}`,
      { headers: H });
    if (r.status !== 200) continue;
    const d = await r.json() as { weeks?: { days?: DayCell[] }[] };
    for (const c of (d.weeks ?? []).flatMap((w) => w.days ?? [])) {
      if (c.dispatched === 0) continue;
      checkedDays++;
      if (c.dispPaid.deals + c.dispAwait.deals !== c.dispatched) {
        problems.push(`${m.name} ${c.day}: ${c.dispPaid.deals}+${c.dispAwait.deals} ≠ ${c.dispatched} авто`);
      }
      if (Math.abs(c.dispPaid.sum + c.dispAwait.sum - c.dispSum) > 1) {
        problems.push(`${m.name} ${c.day}: ${c.dispPaid.sum}+${c.dispAwait.sum} ≠ ${c.dispSum} ₴`);
      }
    }
  }
  assert.ok(checkedDays > 0,
    "🔴 у жодного з перевірених менеджерів немає дня з відправленими авто — когорту нема на чому перевірити");
  assert.deepEqual(problems, [],
    "🔴 КОГОРТА ДНЯ НЕ РОЗБИВАЄТЬСЯ БЕЗ ЗАЛИШКУ:\n  " + problems.join("\n  "));
});
