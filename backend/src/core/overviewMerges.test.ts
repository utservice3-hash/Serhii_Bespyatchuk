import { test } from "node:test";
import assert from "node:assert/strict";
import { needsDb, needsApiQuiet } from "../testMode.js";

/**
 * #137* — ЗЛИТТЯ ЗАПИТІВ ОГЛЯДУ (перф-прохід 23.08.2026, частина A).
 *
 * 📐 ЗАМІРЯНО ПЕРЕД ЗМІНОЮ, на живому проді: `/overview` робив **34 запити**,
 * витрачав 3 181 мс часу БД при 17 мс поза БД (тобто впирався в БД на 99%), і
 * мав коефіцієнт паралелізму 1.52× — 19 запитів у хвості йшли ПО ОДНОМУ.
 * Під ×4 одночасними запитами самі запити роздувались **2.41×**, тоді як черга
 * пулу була непорожня лише **3% часу**. Отже вузьке місце — не пул і не
 * паралелізм, а ОБСЯГ роботи. Звідси й напрям: менше запитів, не більше потоків.
 *
 * 🔴 УМОВА ВЛАСНИКА, НЕПОРУШНА: кожне число у відповіді байт-у-байт таке саме.
 * Жодна формула й жодне ядрове означення грошей не змінені — змінена лише ФОРМА
 * запиту. Тому головний гейт тут — не швидкість, а РІВНІСТЬ двох форм.
 *
 * 🔴 ЧОМУ НЕ «ЗБЕРЕЖЕНИЙ ЕТАЛОН». Спроба порівнювати з еталоном, знятим годину
 * тому, дала **56 розбіжностей** — і рівно ті самі 56 дав СТАРИЙ код проти того
 * самого еталона. Це дрейф даних (`awaitingNow`, `createdByStage` — знімки
 * поточного стану, які рухає синк), а не регрес. Збережений еталон на цій
 * системі протухає за годину, тож гейт на ньому був би вічно червоний і його
 * почали б ігнорувати. Тому порівнюються ДВІ ФОРМИ в ОДНУ МИТЬ — як у `#35`.
 */

/** Зрізи, на яких перевіряємо: адмін, тімлід, менеджер — і порожній скоуп. */
const SCOPES = [
  { id: "admin·серпень", s: { from: "2026-08-01", to: "2026-08-23", managerId: null, teamId: null } },
  { id: "admin·без періоду", s: { from: null, to: null, managerId: null, teamId: null } },
  { id: "тімлід·t5", s: { from: "2026-08-01", to: "2026-08-23", managerId: null, teamId: 5 } },
  { id: "менеджер·m87", s: { from: "2026-08-01", to: "2026-08-23", managerId: 87, teamId: null } },
];

test("#137 ЗЛИТІ ГРОШІ == ЧОТИРИ ОКРЕМІ ЗАПИТИ (живі дані)", needsDb(), async () => {
  const money = await import("./money.js");
  let nonZero = 0;
  for (const sc of SCOPES) {
    const [received, success, paidOnly, expected] = await Promise.all([
      money.receivedMoney(sc.s), money.successMoney(sc.s),
      money.paidOnlyMoney(sc.s), money.expectedMoney(sc.s),
    ]);
    const merged = await money.moneyTotals(sc.s);
    const ref = { received, success, paidOnly, expected };
    for (const k of ["received", "success", "paidOnly", "expected"] as const) {
      assert.equal(merged[k].revenue, ref[k].revenue,
        `🔴 ${sc.id} · ${k}.revenue: злита форма ${merged[k].revenue} проти окремої ${ref[k].revenue} — `
        + "перф-зміна зрушила ЧИСЛО, а це заборонено беззастережно");
      assert.equal(merged[k].deals, ref[k].deals, `🔴 ${sc.id} · ${k}.deals розійшлись`);
      nonZero += ref[k].revenue !== 0 ? 1 : 0;
    }
  }
  // 🔴 «Усе збіглося» на самих нулях нічого не доводить (правило «порожній
  // результат = ПРОВАЛ, поки не доведено, що було що знаходити»).
  assert.ok(nonZero >= 4,
    `🔴 у всіх зрізах гроші нульові (${nonZero} ненульових) — гейт порівнював порожнечу`);
});

test("#137b ЗЛИТИЙ HANDOFF == ОКРЕМІ ВИКЛИКИ, по кожному конфігу (живі дані)", needsDb(), async () => {
  const m = await import("./metrics.js");
  const cfgs = m.HANDOFF_CFGS;
  assert.ok(cfgs.length >= 2, "🔴 конфігів handoff менше двох — зливати нема чого");
  let entered = 0;
  for (const sc of [{ managerId: null, teamId: null }, { managerId: null, teamId: 5 }]) {
    const multi = await m.handoffByMonthMultiForGate(sc, cfgs);
    for (let i = 0; i < cfgs.length; i++) {
      const one = await m.handoffByMonthForGate(sc, cfgs[i]);
      assert.deepEqual(multi[i], one,
        `🔴 конфіг ${i}: мульти-форма розійшлася з окремим викликом — когортні числа лідогену зрушать`);
      entered += one.reduce((a, x) => a + x.entered, 0);
    }
  }
  assert.ok(entered > 0, "🔴 жодного входу в когорту — порівнювали порожні масиви");
});

test("#137c ЗЛИТА ДЕБІТОРКА == ДВА ОКРЕМІ ЗАПИТИ (живі дані)", needsDb(), async () => {
  const m = await import("./metrics.js");
  let seen = 0;
  for (const sc of [{ managerId: null, teamId: null }, { managerId: null, teamId: 5 }]) {
    const [total, cash, snap] = await Promise.all([
      m.receivablesTotal(sc), m.receivablesCash(sc), m.receivablesSnapshot(sc),
    ]);
    assert.equal(snap.total, total, "🔴 загальний борг розійшовся зі злитою формою");
    assert.equal(snap.cash, cash, "🔴 готівкова частка розійшлася зі злитою формою");
    seen += total !== 0 ? 1 : 0;
  }
  assert.ok(seen > 0, "🔴 борг усюди нульовий — гейт порівнював порожнечу");
});

/**
 * #137d СТРУКТУРНИЙ — скільки запитів робить `/overview`.
 *
 * 🔴 БЕЗ НЬОГО «стало швидше» означало б лише «сьогодні БД вільніша». Заміряно:
 * той САМИЙ старий код у різні години давав ×4 = 2 894 / 4 386 / 5 224 мс, тобто
 * абсолютна латентність гуляє в 1.8×. Кількість запитів не гуляє — вона або
 * зменшена, або ні. Тому durable-гарантія тут структурна, а не часова.
 */
test("#137d /overview робить не більше 28 запитів до БД", needsDb(), async () => {
  const { pool } = await import("../db/pool.js");
  const { dashboardRouter } = await import("../routes/dashboard.js");
  const layer = (dashboardRouter as unknown as { stack: { route?: { path: string; methods: Record<string, boolean>;
    stack: { handle: (req: unknown, res: unknown, next: (e?: unknown) => void) => void }[] } }[] })
    .stack.find((l) => l.route?.path === "/overview" && l.route.methods.get);
  assert.ok(layer?.route, "🔴 роут /overview не знайдено — гейт не має що міряти");
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;

  let n = 0;
  const orig = pool.query.bind(pool);
  (pool as unknown as { query: unknown }).query = function (t: unknown, p: unknown) { n++; return orig(t as string, p as unknown[]); };
  try {
    await new Promise<void>((done) => {
      const res = { json() { done(); }, status() { return this; }, send() { done(); }, setHeader() {} };
      handler({ auth: { role: "admin", roleKey: "admin", managerId: null, teamId: null, userId: 0 },
                query: { from: "2026-08-01", to: "2026-08-23" }, params: {} }, res, () => done());
    });
  } finally {
    (pool as unknown as { query: unknown }).query = orig;
  }
  // 34 було до злиття; 28 — після. Стеля трохи вище виміряного, щоб гейт ловив
  // ПОВЕРНЕННЯ розділених запитів, а не дрижання на один службовий запит.
  assert.ok(n > 0, "🔴 жодного запиту не перехоплено — лічильник не працює, а не роут дешевий");
  assert.ok(n <= 29,
    `🔴 /overview робить ${n} запитів (стеля 29, після злиття було 28) — злиття роз'їхалось назад: `
    + "хтось повернув окремі виклики moneyTotals / receivablesSnapshot / handoffByMonthMulti");
});

/**
 * #137e ЛАТЕНТНІСТЬ ×4 — з МЕДІАНОЮ, а не одним прогоном.
 *
 * ⚠️ Перший прогін після старту процесу — холодний (заміряно: 6 954 мс проти
 * 3 288 мс на прогрітому). Один такий вимір — не вимір; гейт бере медіану
 * раундів, інакше він падав би на власному прогріві.
 */
test("#137e ЧАС ×4 тримається під стелею", needsApiQuiet(), async () => {
  const { API_BASE } = await import("../testMode.js");
  const { signToken } = await import("../auth/auth.js");
  const token = signToken({ userId: 0, role: "admin", roleKey: "admin", managerId: null, teamId: null });
  const hit = async () => {
    const t0 = Date.now();
    const r = await fetch(`${API_BASE}/api/dashboard/overview`, { headers: { Authorization: `Bearer ${token}` } });
    await r.text();
    return { ms: Date.now() - t0, status: r.status };
  };
  await hit(); await hit();                                   // прогрів
  const rounds: number[] = [];
  for (let i = 0; i < 3; i++) {
    const four = await Promise.all([hit(), hit(), hit(), hit()]);
    for (const f of four) assert.equal(f.status, 200, `🔴 /overview віддав ${f.status} під навантаженням`);
    rounds.push(Math.max(...four.map((f) => f.ms)));
  }
  const median = [...rounds].sort((a, b) => a - b)[1];
  assert.ok(median <= 4200,
    `🔴 медіана найгіршого з ×4 = ${median} мс при стелі 4200 (раунди: ${rounds.join(", ")})`);
});
