import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { needsApi, API_BASE } from "../testMode.js";

/**
 * #56 — КОНТРАКТ ІЗ ЗАДАЧНИКОМ. Вимога власника 06.08.2026: логіка автоматизацій
 * не змінюється жодною правкою Звіту, і обіцянки недостатньо — потрібен замок.
 *
 * 🔴 ЗАМИКАЄМО КОНТРАКТ, А НЕ ТЕКСТ КОДУ. Перевіряються дві речі, і жодної з них
 * НЕ вистачає окремо:
 *   (1) **API** — кожен KPI приходить із планом і фактом, ручна ціль перекриває
 *       динамічну;
 *   (2) **ДЖЕРЕЛО ФРОНТА** — кожне з шести полів реально ВИВОДИТЬСЯ на екран.
 *
 * ⚠️ ЧОМУ ОБИДВІ. Ми вже бачили, що API-гейт не бачить дубля у верстці (`#55`).
 * Тут та сама пастка з іншого боку: **поле може лишитись в API і зникнути з
 * екрана** — API тоді зелений, а людина не бачить нічого. Тому джерело фронта
 * перевіряється нарівні з відповіддю.
 *
 * 🧾 ЧЕСНА МЕЖА, НАЗВАНА ВГОЛОС: справжня перевірка «дійшло до пікселя» вимагає
 * браузера, а на прод-сервері його НЕМАЄ (перевірено 06.08.2026: ані chromium,
 * ані playwright). Тому «доходить до екрана» тут = «поле передається в компонент,
 * що рендериться». Залишковий розрив: якщо блок цілком приберуть із розмітки, але
 * рядки `Kpi lbl="…"` лишать у мертвому коді — гейт цього не побачить. Прикрито
 * частково `#55` (він вимагає, щоб блоки лишались на місці).
 */
const FE = fileURLToPath(new URL(
  "../../../frontend/src/pages/dashboard/sections/ReportPlanSection.tsx", import.meta.url));

/** Шість полів блоків Задачника — рівно ті, що на екрані (макет `zvit-1`). */
const WEEK_FIELDS = ["реклама", "лідоген", "авто", "чек", "конв", "гроші тижня"] as const;
const KPI_KEYS = ["ads", "leadgen", "dispatch", "avgCheck", "conversion"] as const;

test("#56 усі шість полів Задачника виводяться на екран", async () => {
  const src = await readFile(FE, "utf8");
  assert.ok(src.includes("Тиждень · задача з Задачника"),
    "🔴 блок «Тиждень · задача з Задачника» зник з екрана");
  assert.ok(src.includes("Місяць · показники"),
    "🔴 блок «Місяць · показники» зник з екрана");

  for (const f of WEEK_FIELDS) {
    assert.ok(src.includes(`Kpi lbl="${f}"`),
      `🔴 поле «${f}» більше не виводиться — Задачник втратив показник на екрані Звіту`);
  }
  // Місячний блок мусить нести ті самі п'ять KPI (без «грошей тижня» — вони тижневі).
  for (const f of WEEK_FIELDS.filter((x) => x !== "гроші тижня")) {
    const n = src.split(`Kpi lbl="${f}"`).length - 1;
    assert.ok(n >= 2,
      `🔴 «${f}» виводиться ${n} раз(и), а має двічі — у тижневому І місячному блоках`);
  }
});

/**
 * #56b — ЗНАЧЕННЯ ДОХОДЯТЬ, І РУЧНА ЦІЛЬ ПЕРЕКРИВАЄ ДИНАМІЧНУ.
 *
 * Знімається набір по ТРЬОХ реальних менеджерах: план і факт кожного KPI + ручна
 * ціль тижня. Падає, якщо хоч одне поле зникло або змінило зміст.
 *
 * 🧨 САБОТАЖ №2 (`manual ?? dynamic` → `dynamic`) ловиться саме тут: у менеджерів
 * із ручною ціллю `target` мусить дорівнювати `manual`, а не `dynamic`. Заміряно
 * на проді 06.08: таких **17 із 31**, і в них числа РІЗНІ (Андрусенко 135 000
 * проти 32 143, Ворошилова 50 000 проти 11 905) — тобто підміна одразу видима.
 */
test("#56b значення Задачника доходять; ручна ціль перекриває динамічну", needsApi(), async () => {
  const { signToken } = await import("../auth/auth.js");
  const token = signToken({ userId: 0, role: "admin", roleKey: "admin", managerId: null, teamId: null });
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);

  const r = await fetch(`${API_BASE}/api/dashboard/report-plan?from=${ym}-01&to=${to}`,
    { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200, `🔴 /report-plan віддав ${r.status}`);
  type Kpi = { fact: number | null; target: number };
  const b = await r.json() as {
    managers: { managerId: number; name: string; kpi: Record<string, Kpi>;
      week: { target: number; manual: number | null; dynamic: number; isManual: boolean } }[];
  };
  assert.ok(b.managers.length >= 3, "🔴 менш як три менеджери — контракт нема на кому перевіряти");

  // ── ПОЛЯ: у КОЖНОГО менеджера мусять бути всі п'ять KPI з числовим планом.
  const broken: string[] = [];
  for (const m of b.managers) {
    for (const k of KPI_KEYS) {
      const kpi = m.kpi?.[k];
      if (!kpi || typeof kpi.target !== "number" || !("fact" in kpi)) {
        broken.push(`${m.name}: kpi.${k} = ${JSON.stringify(kpi)}`);
      }
    }
    if (typeof m.week?.target !== "number" || typeof m.week?.dynamic !== "number"
      || typeof m.week?.isManual !== "boolean") {
      broken.push(`${m.name}: week = ${JSON.stringify(m.week)}`);
    }
  }
  assert.deepEqual(broken, [], "🔴 у Задачнику зникло поле або змінився його зміст");

  // ── ⚠️ Порожній результат = ПРОВАЛ: доводимо, що плани взагалі є, інакше
  // «усі поля числові» зійшлося б на суцільних нулях.
  const withPlan = b.managers.filter((m) => KPI_KEYS.some((k) => m.kpi[k].target > 0));
  assert.ok(withPlan.length >= 3,
    `🔴 лише ${withPlan.length} менеджерів мають хоч один ненульовий план Задачника — перевірка вироджена`);

  // ── РУЧНА ЦІЛЬ ПЕРЕКРИВАЄ. Беремо лише тих, у кого manual І dynamic РІЗНІ:
  // там, де вони збіглись, підміну `manual ?? dynamic → dynamic` не видно.
  const manual = b.managers.filter((m) => m.week.isManual && m.week.manual != null
    && m.week.manual !== m.week.dynamic);
  assert.ok(manual.length >= 3,
    `🔴 лише ${manual.length} менеджерів мають ручну ціль, ВІДМІННУ від динамічної — `
    + "саботаж `manual ?? dynamic → dynamic` на такій вибірці був би невидимий");
  const overridden = manual
    .filter((m) => m.week.target !== m.week.manual)
    .map((m) => `${m.name}: target ${m.week.target} ≠ manual ${m.week.manual} (dynamic ${m.week.dynamic})`);
  assert.deepEqual(overridden, [],
    "🔴 РУЧНА ЦІЛЬ ПЕРЕСТАЛА ПЕРЕКРИВАТИ ДИНАМІЧНУ — тімлід виставив число в Задачнику, "
    + "а Звіт показує пораховане");
});

/**
 * #56c — ЗВІТ НЕ ПИШЕ В ЗАДАЧНИК. Напрямок односторонній: Звіт ЧИТАЄ `tasks`
 * і не має права їх змінювати. Перевірено 06.08.2026: у тілі `/report-plan`
 * нуль `INSERT/UPDATE/DELETE`. Гейт замикає це, щоб «маленька зручність» на
 * кшталт «підправити таргет прямо зі Звіту» не зʼявилась непоміченою.
 */
test("#56c /report-plan не змінює задач", async () => {
  const be = fileURLToPath(new URL("../routes/dashboard.ts", import.meta.url).href.replace("/dist/", "/src/"));
  const src = await readFile(be, "utf8").catch(async () =>
    readFile(fileURLToPath(new URL("../../src/routes/dashboard.ts", import.meta.url)), "utf8"));
  const i = src.indexOf('dashboardRouter.get("/report-plan"');
  assert.ok(i > 0, "🔴 роут /report-plan не знайдено — гейт перевіряє не те, що думає");
  const rest = src.slice(i);
  const end = rest.indexOf("dashboardRouter.", 40);
  const body = end > 0 ? rest.slice(0, end) : rest;
  assert.ok(body.length > 2000, "🔴 тіло роута підозріло коротке — межу знайдено неправильно");

  const writes = [...body.matchAll(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+tasks\b/gi)].map((x) => x[0]);
  assert.deepEqual(writes, [],
    "🔴 Звіт почав ПИСАТИ в `tasks` — Задачник зовнішня система, напрямок лише на читання");
});
