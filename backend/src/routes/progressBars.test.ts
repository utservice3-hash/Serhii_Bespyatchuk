import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { needsApi, API_BASE } from "../testMode.js";

/**
 * #65 — СМУГИ ПРОГРЕСУ: ЩО МОЖНА СКЛАДАТИ, А ЩО НІ.
 *
 * 🔴 ЦЕНТРАЛЬНЕ ЧИСЛО ЦІЄЇ ФІЧІ, ЗАМІРЯНЕ 07.08.2026: у Антипенка **35 088 ₴**
 * перенесеного з минулого місяця ОДНОЧАСНО мають планову дату оплати в серпні.
 * Тобто «перенесене» і «очікується цього місяця» — множини, що ПЕРЕТИНАЮТЬСЯ на
 * 69% (35 088 із 50 876). Намалювати їх сусідніми сегментами накопичувальної
 * смуги означало б показати ці гроші ДВІЧІ й завищити прогноз — число, яке
 * власник читає щодня.
 *
 * Тому: місячна смуга має РІВНО ДВА накопичувальні сегменти (отримано +
 * очікується цього місяця), а риска прогнозу дорівнює `projected`, який ядро
 * рахує як `fact + expectThisMonth`. Гейт тримає обидві межі.
 */
const FE = fileURLToPath(new URL(
  "../../../frontend/src/pages/dashboard/sections/ReportPlanSection.tsx", import.meta.url));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

test("#65 прогноз == факт + очікується цього місяця, без carryover", needsApi(), async () => {
  const { signToken } = await import("../auth/auth.js");
  const token = signToken({ userId: 0, role: "admin", roleKey: "admin", managerId: null, teamId: null });
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  const r = await fetch(`${API_BASE}/api/dashboard/report-plan?from=${ym}-01&to=${to}`,
    { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200, `🔴 /report-plan віддав ${r.status}`);
  const b = await r.json() as { managers: { name: string; fact: number; plan: number;
    expectThisMonth: number; projected: number; monthInProgress: boolean }[] };

  const live = b.managers.filter((m) => m.plan > 0 && m.monthInProgress);
  assert.ok(live.length >= 5,
    `🔴 лише ${live.length} менеджерів із планом у поточному місяці — смугу нема на чому перевірити`);

  const bad = live
    .filter((m) => Math.abs(m.projected - (m.fact + m.expectThisMonth)) > 1)
    .map((m) => `${m.name}: projected ${m.projected} ≠ ${m.fact} + ${m.expectThisMonth}`);
  assert.deepEqual(bad, [],
    "🔴 РИСКА ПРОГНОЗУ РОЗІЙШЛАСЬ ІЗ СЕГМЕНТАМИ. Смуга малює факт + очікування, а риска "
    + "стоїть на іншому числі — на екрані зʼявиться третя правда.");

  // ⚠️ Порожній результат = ПРОВАЛ: доводимо, що очікування взагалі є.
  assert.ok(live.some((m) => m.expectThisMonth > 0),
    "🔴 у жодного менеджера немає очікувань цього місяця — помаранчевий сегмент ніде не видно, "
    + "і гейт нічого не довів");
});

/**
 * #65b — ТИЖНЕВІ СМУЖКИ НЕ СКЛАДАЮТЬСЯ, А МІСЯЧНА НЕ МІСТИТЬ CARRYOVER.
 *
 * Читаємо ДЖЕРЕЛО фронта: обидві межі — властивість верстки, і жоден HTTP-гейт
 * їх не побачить.
 *
 * 🧨 Саботаж: скласти «отримано» й «відправлено» в одне число (прибрати `extraBar`
 * і додати cohort до факту) → перша перевірка червоніє. Додати третій сегмент із
 * carryover → друга червоніє.
 */
test("#65b смужки тижня окремі, у місячній смузі немає carryover", async () => {
  const src = strip(await readFile(FE, "utf8"));

  /**
   * 🔴 ПЕРЕВІРЯЄМО ВМИКАЧ, А НЕ НАЯВНІСТЬ СЛОВА. Перша редакція шукала просто
   * `extraBar` у тексті — і саботаж «вимкнути смужку через `false &&`» її НЕ
   * повалив: слово лишалось на місці. Тобто половина гейта була декоративною.
   * Тепер перевіряється і місце РЕНДЕРУ, і те, що виклик не заглушено.
   */
  assert.ok(/\{extraBar && \(/.test(src),
    "🔴 блок рендеру другої смужки зник із `TrajBlock` — «відправлено» ніде не малюється");
  assert.ok(/extraBar=\{m\.cohort && m\.cohort\.sum > 0/.test(src),
    "🔴 друга смужка тижня вимкнена або віддає не `cohort` — людина з перевиконаною "
    + "роботою знову читається як «нічого не зробив»");
  assert.ok(/label: "Відправлено", value: m\.cohort\.sum/.test(src),
    "🔴 друга смужка перестала брати `cohort.sum` — вона показує вже щось інше");
  // Головне: факт тижня НЕ склеєний із когортою.
  assert.ok(!/m\.week\.fact\s*\+\s*m\.cohort/.test(src) && !/m\.cohort\.sum\s*\+\s*m\.week\.fact/.test(src),
    "🔴 «отримано» і «відправлено» СКЛАДЕНІ в одне число. Це різні множини: заміряно "
    + "07.08 — у 13 із 25 менеджерів вони не збігаються, і так і має бути.");

  // Місячні сегменти: рівно два, і жоден не з carryover.
  const seg = src.slice(src.indexOf("segments={m.plan > 0"), src.indexOf("forecastPct={m.plan > 0"));
  assert.ok(seg.length > 50, "🔴 не знайшов сегменти місячної смуги — гейт перевіряє не те");
  assert.ok(!/carry/i.test(seg),
    "🔴 У МІСЯЧНУ СМУГУ ДОДАЛИ CARRYOVER. Заміряно 07.08: у Антипенка 35 088 ₴ із 50 876 ₴ "
    + "перенесеного ВЖЕ мають планову дату в серпні, тобто вже сидять у «очікується цього "
    + "місяця». Сусідній сегмент показав би ці гроші двічі й завищив прогноз.");
  assert.equal((seg.match(/from:/g) ?? []).length, 2,
    "🔴 сегментів має бути рівно два (отримано + очікується цього місяця)");
});
