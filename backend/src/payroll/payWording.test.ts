import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 💸 Задача 10723: «виплачено» → «схвалено» у кабінеті працівника (Дар'я 25.11.2026, «роби» Романа 25.11). Статус `paid`
 * ставить фінансист кнопкою «Виплатити» / «Позначити виплаченим»; сам переказ іде через банк поза дашбордом, тож час у
 * кабінеті — це момент кнопки, а не зарахування на карту. Працівники читали «виплачено 16:39» як «гроші вже на карті».
 * Працівнику — «схвалено» + рядок про банк; фінансисту лишається «виплачено» (для нього це правда). Гейти `#10970`–`#10972`.
 */
const SRC = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "src", p), "utf8");
const FRONT = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", p), "utf8");
/** Джерело без коментарів: слово в коментарі працівник не бачить. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/\s.*$/gm, "");

type Note = { title: string; text: string };
async function notes(wording: string | undefined): Promise<{ adv: Note; }> {
  const { createPayroll } = await import("./engine/zarplata-engine.mjs");
  const { createNotifier } = await import("./engine/notify.mjs");
  const base = { dept: "sales", startDate: "2024-01-01", birthday: null, official: [], leave: null, clientRates: [], adjustments: [] };
  const state = {
    now: "2026-11-25T18:00", liveMonth: "2026-11", closedMonth: "2026-10",
    settings: { birthday: { v2From: null } },
    employees: [{ ...base, id: "M", name: "Менеджер", role: "manager", title: "Менеджер", team: "t1", terms: [{ from: "2000-01", level: "profi" }] }],
    departments: { sales: { name: "Продажі", sales: true } }, teams: { t1: { name: "Т1" } },
    plans: {}, deals: { M: { "2026-11": [{ id: "d1", date: "2026-11-10", client: "К", margin: 100000, pay: "paid" }] } }, kpi: {}, records: {},
    advances: { "2026-11": { M: { id: 1, amount: 5000, cash: 0, cards: [{ no: "1-9967", cardId: 1, who: "Менеджер", bank: "Монобанк", amount: 5000 }],
      requestedAt: "2026-11-25T16:00", paidAt: "2026-11-25T16:39", status: "paid" } } },
    responsibles: { ba: { id: "", name: "БА" }, acc: { id: "", name: "Бух" }, hr: { id: "", name: "HR" }, od: { id: "", name: "ОД" }, finance: [] },
    ...(wording === undefined ? {} : { payWording: wording }),
  };
  const zp = createPayroll(state as never);
  const nt = createNotifier(zp, state);
  return { adv: nt.build.advancePaid("M", "2026-11")[0] as Note };
}

/**
 * #10970 — СПОВІЩЕННЯ ПРАЦІВНИКУ: «Аванс 5 000 ₴ схвалено» і рядок «строк залежить від банку»; пара: без `payWording` — як у пакеті.
 * 🧨 Червоніє, якщо повернути «виплачено» в заголовок або прибрати рядок про банк; і якщо зламати сумісність із пакетом.
 */
test("#10970 СПОВІЩЕННЯ: «Аванс … схвалено» + рядок про банк; без payWording — «виплачено», як у пакеті", async () => {
  const on = (await notes("approved")).adv, off = (await notes(undefined)).adv;
  assert.match(on.title, /^Аванс 5\D000\s₴ схвалено$/, `🔴 заголовок працівнику — «схвалено»: ${on.title}`);
  assert.match(on.text, /Гроші надійдуть після переказу, строк залежить від банку\./, "🔴 має бути рядок, що зарахування залежить від банку");
  assert.match(on.text, /9967/, "🔴 карта лишилась у тексті");
  assert.match(off.title, /виплачено$/, "🔴 без payWording — текст пакета (золоті звірки макета)");
  assert.doesNotMatch(off.text, /залежить від банку/, "🔴 без payWording — текст пакета");
});

/**
 * #10971 — СТАН УМИКАЄ НОВІ ТЕКСТИ: `state.ts` віддає рушію `payWording: "approved"`.
 * 🧨 Червоніє, якщо прибрати поле зі стану (сповіщення мовчки повернуться до «виплачено»).
 */
test("#10971 СТАН: state.ts віддає payWording «approved» — без нього сповіщення знову «виплачено»", () => {
  assert.match(SRC("payroll/state.ts"), /ttnAt, payWording: "approved",/, "🔴 payWording має їхати в стан рушія");
});

/**
 * #10972 — КАБІНЕТ ПРАЦІВНИКА БЕЗ «ВИПЛАЧЕНО», ФІНАНСИСТ — З НИМ. Пара: у фінансиста статус «виплачено» лишився.
 * 🧨 Червоніє, якщо повернути «виплачено» в будь-який текст кабінету, забути `employee` у пігулці статусу, або замінити слово
 * й у фінансиста.
 */
test("#10972 КАБІНЕТ: працівник бачить «схвалено», а не «виплачено»; фінансист — «виплачено», як був", () => {
  for (const f of ["Advance.tsx", "Payouts.tsx", "Overview.tsx", "CloseCard.tsx", "format.ts"]) {
    assert.doesNotMatch(code(FRONT(`payroll/cabinet/${f}`)), /виплачено/i, `🔴 cabinet/${f}: у тексті працівника не має бути «виплачено»`);
  }
  assert.match(FRONT("payroll/cabinet/Advance.tsx"), /схвалено \{dt\(req\.paidAt\)\}<\/b> — \{payHow\(req\)\}\. Гроші надійдуть після переказу, строк залежить від банку\./,
    "🔴 блок «Аванс»: «схвалено» + рядок про банк");
  for (const f of ["Payouts.tsx", "CloseCard.tsx"]) {
    const s = FRONT(`payroll/cabinet/${f}`);
    assert.equal((s.match(/<StatusPill /g) ?? []).length, (s.match(/<StatusPill [^>]*\bemployee\b/g) ?? []).length, `🔴 cabinet/${f}: кожна пігулка статусу — з employee`);
  }
  assert.match(FRONT("payroll/ui.tsx"), /employee && status === "paid" \? \["Схвалено до виплати"/, "🔴 пігулка працівника: «Схвалено до виплати»");
  assert.match(FRONT("payroll/ui.tsx"), /paid: \["Виплачено", "ok"\]/, "🔴 пара: у фінансиста статус ЗП «Виплачено»");
  assert.match(FRONT("payroll/finance/fmt.ts"), /paid: \["виплачено", "ok"\]/, "🔴 пара: у фінансиста статус авансу «виплачено»");
});
