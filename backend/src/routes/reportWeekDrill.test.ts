import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { needsDb, needsApi, API_BASE } from "../testMode.js";
import { fixedWeekBlocks, weekBlocksForRange, kyivMonthBounds } from "../core/dates.js";

/**
 * #93 / #93b / #93c / #98 — ДВА РІВНІ РОЗКРИТТЯ КАРТКИ (тижні → дні) + АВТО ПО ТИЖНЯХ.
 *
 * 🔴 ПРИВІД. Розкриття картки за місяць вивалювало 31 рядок днів одразу, і тиждень —
 * одиницю, якою людина реально планує, — доводилось складати очима. Рішення власника
 * 20.08.2026: у режимах «Місяць» і «Період» спершу тижні, і вже тиждень розкривається
 * в дні; у «День»/«Тиждень» рівень тижнів порожній за змістом і не показується.
 *
 * 🔴 ГОЛОВНИЙ РИЗИК ТУТ — НЕ ВЕРСТКА, А ДРУГЕ ДЖЕРЕЛО. Рівень тижнів легко було
 * взяти окремим ендпоінтом (`manager-weeks` уже існує) — і отримати два вирази того
 * самого числа, тобто рівно ту поломку, яку ми лікували в чипах «новий/постійний»
 * і в розкритті дня. Тому тиждень = Σ ТИХ САМИХ днів, які під ним розкриваються,
 * і гейти нижче стережуть саме це, а не наявність рядків на екрані.
 */

const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const ROUTE = path.join(ROOT, "backend", "src", "routes", "dashboard.ts");
const CARD_TSX = path.join(ROOT, "frontend", "src", "pages", "dashboard", "sections", "ReportPlanSection.tsx");
const TABLE_TSX = path.join(ROOT, "frontend", "src", "pages", "dashboard", "sections", "ReportTableSection.tsx");
const stripComments = (x: string) =>
  x.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

// ─────────── #93 · блоки покривають ПЕРІОД, а не місяць його початку ───────────

test("#93 ТИЖНЕВІ БЛОКИ ПОКРИВАЮТЬ УВЕСЬ ПЕРІОД, включно з переходом через місяць", () => {
  /**
   * 🔴 ЗАМІРЯНО ЧИТАННЯМ КОДУ, А НЕ ПРИПУЩЕНО. `kvp-report/manager-detail` будував
   * тижні як `fixedWeekBlocks(monthStart)` і фільтрував дні межами блоку. Отже в
   * режимі «Період» через межу місяця (15.07–20.08) серпневі дні не потрапляли В
   * ЖОДЕН блок — і зникали не лише з тижнів, а й із `monthTotals`, бо той рахується
   * як Σ тижнів. Підсумок розкриття мовчки показував менше, ніж рядок менеджера.
   */
  const cross = weekBlocksForRange("2026-07-15", "2026-08-20");
  assert.equal(cross[0].from, "2026-07-15", "🔴 перший блок не починається з початку періоду");
  assert.equal(cross[cross.length - 1].to, "2026-08-20", "🔴 останній блок не доходить до кінця періоду");
  // Жодної діри й жодного накладання: наступний блок починається наступною добою.
  for (let i = 1; i < cross.length; i++) {
    const prevNext = new Date(cross[i - 1].to + "T00:00:00Z");
    prevNext.setUTCDate(prevNext.getUTCDate() + 1);
    assert.equal(cross[i].from, prevNext.toISOString().slice(0, 10),
      `🔴 між блоками ${cross[i - 1].to} і ${cross[i].from} доба випала або порахувалась двічі`);
  }
  assert.ok(cross.some((b) => b.from.startsWith("2026-08")),
    "🔴 у блоках немає жодного серпневого — саме ці дні й зникали з підсумку");

  /**
   * 🔴 ДЗЕРКАЛО, БЕЗ ЯКОГО ЗМІНА БУЛА Б ПРАВКОЮ ЧИСЕЛ. Для ПОВНОГО місяця нова
   * функція мусить давати блоки БАЙТ-У-БАЙТ такі самі, як `fixedWeekBlocks`, — інакше
   * місячний вигляд (тобто дефолтний, який бачать усі) поїхав би разом із фіксом
   * періоду. Серпень 2026 починається в суботу — найгірший випадок.
   */
  for (const mo of ["2026-08-01", "2026-02-01", "2026-03-01", "2025-06-01"]) {
    const end = new Date(Date.UTC(Number(mo.slice(0, 4)), Number(mo.slice(5, 7)), 0)).toISOString().slice(0, 10);
    assert.deepEqual(weekBlocksForRange(mo, end), fixedWeekBlocks(mo),
      `🔴 для повного місяця ${mo.slice(0, 7)} блоки розійшлись — це вже зміна ЧИСЕЛ місячного вигляду`);
  }

  // Роут справді перейшов на них: інакше гейт доводив би лише, що функція існує.
  const body = readFileSync(ROUTE, "utf8").split('dashboardRouter.get("/kvp-report/manager-detail"')[1]
    ?.split("dashboardRouter.get(")[0] ?? "";
  assert.ok(body.length > 0, "🔴 роут /kvp-report/manager-detail зник");
  assert.ok(/weekBlocksForRange\(from, to\)/.test(stripComments(body)),
    "🔴 розкриття знову будує тижні по місяцю `from`, а не по запитаному періоду");
});

test("#93b ТИЖДЕНЬ — ЦЕ Σ ЙОГО ВЛАСНИХ ДНІВ, І ДРУГОГО ДЖЕРЕЛА В РОЗКРИТТІ НЕМАЄ", () => {
  const fe = stripComments(readFileSync(CARD_TSX, "utf8"));
  const drill = fe.split("function DayDrill(")[1]?.split("\nfunction ")[0] ?? "";
  assert.ok(drill.length > 0, "🔴 компонент DayDrill зник");

  // 🔴 Рівень тижнів НЕ має права піти по свій запит: `manager-weeks` рахує факт
  // ІНШИМ шляхом (money-бакети + sumDaysIntoBlocks), і два числа розійшлись би на
  // тих самих екранах, де одне пояснює друге.
  assert.equal(/fetchManagerWeeks/.test(drill), false,
    "🔴 розкриття картки потягло тижні окремим ендпоінтом — тиждень перестав бути Σ своїх днів");
  assert.ok(/d\.weeks/.test(drill) && /w\.total/.test(drill),
    "🔴 рівень тижнів більше не читає `weeks[].total` з тієї самої відповіді, що й дні");
  assert.ok(/w\.days\.map/.test(drill),
    "🔴 дні під тижнем беруться не з `w.days` — тобто вже не з того тижня, що показаний");

  // 🔴 ОДИН ОПИС КОМІРОК НА ОБИДВА РІВНІ. Дві копії розмітки означали б, що колонку
  // можна дописати в тиждень і забути в дні (або навпаки) — і рівні заперечували б
  // один одного тим самим екраном.
  assert.ok(/const cellDefs = /.test(drill), "🔴 спільний опис колонок `cellDefs` зник");
  assert.ok(/cellDefs\(w\.total\)/.test(drill),
    "🔴 рядок ТИЖНЯ малюється не зі спільного опису колонок — у нього зʼявилась власна розмітка");
  assert.ok(/cellDefs\(x\)/.test(drill),
    "🔴 рядок ДНЯ малюється не зі спільного опису колонок — рівні розійдуться першою ж новою колонкою");

  // Рівень тижнів — лише для Місяць/Період (рішення власника), і це не зашито
  // всередині компонента, а приходить згори як `weeksFirst`.
  assert.ok(/weeksFirst/.test(drill), "🔴 розкриття більше не розрізняє режими — тижні або завжди, або ніколи");
  assert.ok(/weeksFirst=\{mode === "month" \|\| mode === "range"\}/.test(fe),
    "🔴 рівень тижнів увімкнено не за режимом «Місяць»/«Період» — у режимі дня зʼявився б блок з одного дня");
});

// ─────────── #98 · авто по тижнях + чесна позначка обрізаного тижня ───────────

test("#98 ОБРІЗАНИЙ МІСЯЦЕМ ТИЖДЕНЬ НАЗВАНИЙ ОБРІЗАНИМ, а ціль без парасольки — «—», не 0", () => {
  const body = readFileSync(ROUTE, "utf8").split('dashboardRouter.get("/report-plan/manager-weeks"')[1]
    ?.split("dashboardRouter.get(")[0] ?? "";
  assert.ok(body.length > 0, "🔴 роут /report-plan/manager-weeks зник");
  const code = stripComments(body);
  assert.ok(/dispatchFact/.test(code) && /dispatchTarget/.test(code),
    "🔴 роут більше не віддає авто по тижнях");
  assert.ok(/clipped/.test(code), "🔴 роут не позначає обрізані межею місяця тижні");
  /**
   * 🔴 ЦІЛЬ ТИМ САМИМ НАКОПИЧУВАЧЕМ, ЩО В МІСЯЧНОМУ БЛОЦІ ПОКАЗНИКІВ. Власний
   * підрахунок таргета (наприклад, «місячна ціль ÷ тижні») став би ЧЕТВЕРТИМ
   * означенням тижневої цілі поруч із `effectiveWeekTargets` і знімками.
   */
  assert.ok(/accumulateKpiTargets\(/.test(code),
    "🔴 тижнева ціль авто рахується не `accumulateKpiTargets` — зʼявилось власне означення цілі");
  // 🔴 Парасольки має 17 із 31 менеджера. Нуль тут читався б як «ціль нульова»,
  // тобто «план виконано» — саме тому відсутність цілі це `null`.
  assert.ok(/dTarget && dTarget > 0 \? dTarget : null/.test(code),
    "🔴 відсутня тижнева ціль більше не `null` — нуль прочитається як виконана ціль");

  const fe = stripComments(readFileSync(TABLE_TSX, "utf8"));
  assert.ok(/>\s*обрізаний місяцем\s*</.test(fe),
    "🔴 зник ВИДИМИЙ підпис «обрізаний місяцем». Тижнева ЦІЛЬ на картці рахується по повному "
    + "календарному тижню, а факт тут — по обрізаному блоку: без підпису два правильні числа "
    + "читаються як розбіжність (підказки в title недостатньо — її не видно)");
  assert.ok(/w\.dispatchTarget \?\? "—"/.test(fe),
    "🔴 у колонці «Авто ф/ц» ціль без парасольки друкується не як «—»");
});

// ─────────── #93c · smoke ДАНИМИ: обидва рівні сходяться на живому API ───────────

test("#93c SMOKE: Σ тижнів == Σ днів == підсумку розкриття (живий API)", needsApi(), async () => {
  const { signToken } = await import("../auth/auth.js");
  const token = signToken({ userId: 0, role: "admin", roleKey: "admin", managerId: null, teamId: null });
  const H = { Authorization: `Bearer ${token}` };
  const now = new Date();
  const ym = kyivMonthBounds().ym;
  const from = `${ym}-01`, to = now.toISOString().slice(0, 10);

  const rp = await fetch(`${API_BASE}/api/dashboard/report-plan?from=${from}&to=${to}`, { headers: H });
  assert.equal(rp.status, 200, `🔴 /report-plan віддав ${rp.status}`);
  const mgrs = ((await rp.json()) as { managers: { managerId: number; name: string; fact: number }[] }).managers ?? [];
  const targets = [...mgrs].sort((a, b) => b.fact - a.fact).slice(0, 3);
  assert.ok(targets.length > 0, "🔴 у звіті нема жодного менеджера — розкривати нема кого");

  type Cell = { received: { deals: number; revenue: number }; dispatched: number; created: number };
  for (const mg of targets) {
    const r = await fetch(`${API_BASE}/api/dashboard/kvp-report/manager-detail?managerId=${mg.managerId}&from=${from}&to=${to}`, { headers: H });
    assert.equal(r.status, 200, `🔴 manager-detail для ${mg.name} віддав ${r.status}`);
    const d = await r.json() as {
      weeks: { idx: number; from: string; to: string; total: Cell; days: (Cell & { day: string })[] }[];
      monthTotals: Cell;
    };
    // 200 із порожнім тілом виглядав би так само зелено, як робоче розкриття.
    assert.ok(d.weeks?.length > 0, `🔴 у ${mg.name} розкриття повернуло нуль тижнів`);
    assert.ok(d.weeks.some((w) => w.days.length > 0), `🔴 у ${mg.name} жоден тиждень не містить днів — рівень «дні» порожній`);

    for (const w of d.weeks) {
      const sum = w.days.reduce((s, x) => s + x.received.revenue, 0);
      assert.ok(Math.abs(sum - w.total.received.revenue) < 1,
        `🔴 ${mg.name}, тиждень ${w.from}: рядок тижня каже ${Math.round(w.total.received.revenue)}, `
        + `а дні під ним дають ${Math.round(sum)} — рівень заперечує рівень`);
      for (const x of w.days)
        assert.ok(x.day >= w.from && x.day <= w.to,
          `🔴 ${mg.name}: день ${x.day} лежить під тижнем ${w.from}–${w.to}`);
    }
    const byWeeks = d.weeks.reduce((s, w) => s + w.total.received.revenue, 0);
    assert.ok(Math.abs(byWeeks - d.monthTotals.received.revenue) < 1,
      `🔴 ${mg.name}: Σ тижнів ${Math.round(byWeeks)} ≠ підсумку розкриття ${Math.round(d.monthTotals.received.revenue)}`);
    const days = d.weeks.flatMap((w) => w.days);
    assert.equal(new Set(days.map((x) => x.day)).size, days.length,
      `🔴 ${mg.name}: одна доба потрапила у два тижні — саме так і подвоюються числа`);
  }
});
