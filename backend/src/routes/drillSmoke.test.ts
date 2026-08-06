import { test } from "node:test";
import assert from "node:assert/strict";
import { needsApi, API_BASE } from "../testMode.js";

/**
 * #57 — SMOKE ГОЛОВНОЇ ВЗАЄМОДІЇ: РОЗГОРТКА РЯДКА МЕНЕДЖЕРА ПО ДНЯХ.
 *
 * 🔴 ПРИВІД — РЕГРЕС НА ПРОДІ 06.08.2026. Клік по рядку перестав розгортати
 * деталь: обробник спрацьовував, запит ішов, а `/kvp-report/manager-detail`
 * віддавав **500**. Причина — псевдонім `day` без `AS` у двох нових запитах
 * (`day` — ключове слово Postgres). **202 тести цього не побачили, бо жоден із
 * них не викликає цей роут.**
 *
 * Це ТРЕТІЙ поспіль випадок, коли зелені гейти пропустили те, що видно за
 * секунду: CSS-хеш (сторінка без стилів), сума чипів (31 проти 37), тепер клік.
 * Спільне в усіх трьох — перевірялося те, що ЛЕГКО перевірити, а не те, чим
 * людина користується.
 *
 * Тому гейт б'є саме туди, куди веде клік, і вимагає не 200, а ДАНИХ: 200 із
 * порожнім тілом виглядав би так само зелено, як і робочий екран.
 */
test("#57 розгортка по днях відповідає і несе дані", needsApi(), async () => {
  const { signToken } = await import("../auth/auth.js");
  const token = signToken({ userId: 0, role: "admin", roleKey: "admin", managerId: null, teamId: null });
  const H = { Authorization: `Bearer ${token}` };
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const from = `${ym}-01`;
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);

  // Беремо менеджера з РЕАЛЬНОГО звіту — саме на нього й клікне людина.
  const rp = await fetch(`${API_BASE}/api/dashboard/report-plan?from=${from}&to=${to}`, { headers: H });
  assert.equal(rp.status, 200, `🔴 /report-plan віддав ${rp.status}`);
  const body = await rp.json() as { managers: { managerId: number; name: string }[] };
  const mgrs = (body.managers ?? []).slice(0, 3);
  assert.ok(mgrs.length > 0, "🔴 у звіті нема жодного менеджера — клікати нема на кого");

  for (const m of mgrs) {
    const r = await fetch(
      `${API_BASE}/api/dashboard/kvp-report/manager-detail?managerId=${m.managerId}&from=${from}&to=${to}`,
      { headers: H });
    assert.equal(r.status, 200,
      `🔴 РОЗГОРТКА МЕРТВА для «${m.name}»: /kvp-report/manager-detail віддав ${r.status}. `
      + "Саме так виглядав регрес 06.08 — стрілка на місці, поведінки немає");

    const d = await r.json() as {
      weeks?: { days?: { day: string; received?: { revenue: number }; talks?: number; invoiced?: { deals: number } }[] }[];
      monthTotals?: Record<string, unknown>;
    };
    // 🔴 200 МАЛО. Порожнє тіло дало б такий самий зелений, а екран лишився б порожнім.
    assert.ok(Array.isArray(d.weeks) && d.weeks.length > 0,
      `🔴 «${m.name}»: відповідь без тижнів — розгортка відкриється порожньою`);
    const days = d.weeks.flatMap((w) => w.days ?? []);
    assert.ok(days.length > 0,
      `🔴 «${m.name}»: у тижнях нема жодного дня — деталь по днях порожня`);
    assert.ok(d.monthTotals && typeof d.monthTotals === "object",
      `🔴 «${m.name}»: нема monthTotals`);

    // Поля, ДОДАНІ цим проходом, — саме вони й падали. Перевіряємо, що вони є,
    // інакше наступна така правка знову проїде непоміченою.
    const sample = days[0];
    for (const f of ["talks", "attempts"] as const) {
      assert.ok(typeof sample[f as "talks"] === "number",
        `🔴 «${m.name}»: у дні нема поля «${f}» — розрізи дзвінків не доїхали`);
    }
    assert.ok(sample.invoiced && typeof sample.invoiced.deals === "number",
      `🔴 «${m.name}»: у дні нема «invoiced» — виставлені рахунки того дня не доїхали`);
  }
});

/**
 * #57b — ДЗЕРКАЛО: у ЯКОГОСЬ із перевірених менеджерів деталь має бути НЕПОРОЖНЬОЮ
 * по суті, а не лише за структурою. Інакше `#57` зеленів би на місяці, де взагалі
 * нічого не відбувалось, і не відрізнив би «порожньо» від «зламано».
 */
test("#57b у розгортці є хоч один день із рухом", needsApi(), async () => {
  const { signToken } = await import("../auth/auth.js");
  const token = signToken({ userId: 0, role: "admin", roleKey: "admin", managerId: null, teamId: null });
  const H = { Authorization: `Bearer ${token}` };
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const from = `${ym}-01`;
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);

  const rp = await fetch(`${API_BASE}/api/dashboard/report-plan?from=${from}&to=${to}`, { headers: H });
  const body = await rp.json() as { managers: { managerId: number; name: string }[] };
  let moved = 0;
  for (const m of (body.managers ?? []).slice(0, 5)) {
    const r = await fetch(
      `${API_BASE}/api/dashboard/kvp-report/manager-detail?managerId=${m.managerId}&from=${from}&to=${to}`,
      { headers: H });
    if (r.status !== 200) continue;
    const d = await r.json() as { weeks?: { days?: { created?: number; talks?: number; received?: { deals: number } }[] }[] };
    const days = (d.weeks ?? []).flatMap((w) => w.days ?? []);
    if (days.some((x) => (x.created ?? 0) > 0 || (x.talks ?? 0) > 0 || (x.received?.deals ?? 0) > 0)) moved++;
  }
  assert.ok(moved > 0,
    "🔴 у ПʼЯТЬОХ менеджерів жоден день не має ані створених угод, ані розмов, ані оплат — "
    + "або місяць порожній, або деталь віддає нулі; #57 на таких даних нічого не доводить");
});
