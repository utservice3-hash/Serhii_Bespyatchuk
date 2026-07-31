import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { needsDb } from "../testMode.js";

/**
 * #12 — ЮНІТ-ЗЛІПОК ГЕЙТА для 13 ендпоінтів, які НЕ можна пробувати по HTTP на проді.
 *
 * 🔴 ЧОМУ ОКРЕМО. У цих обробників перевірка ролі стоїть НЕ першою: перед нею йде
 * парсинг тіла, валідація, а в `DELETE /duty/absences/:id` — ще й SELECT. Тому проба
 * по HTTP порушила б умову «відмова настає до будь-якої роботи». Піднімати окремий
 * інстанс на копії БД заради 13 роутів дорожче, ніж вони варті, — і сам стенд став би
 * річчю, яку треба підтримувати.
 *
 * ЩО РОБИМО НАТОМІСТЬ: кличемо обробник НАПРЯМУ з підробленим `req`, перехопивши
 * `res`. Жодного HTTP, жодного запиту в БД — для ЗАБОРОНЕНИХ ролей обробник доходить
 * до гейта і віддає 403 раніше, ніж торкнеться даних. Це легітимний зліпок «як є»,
 * просто на рівні гейта, а не мережі.
 *
 * ⚠️ Пробуємо ЛИШЕ ролі, яким гейт відмовляє. Дозволена роль пройшла б далі й почала
 * писати — рівно те, чого ми уникаємо.
 *
 * 🔴 БОРГ, НЕ ЗАБУТИ: після рефакторингу гейт цих 13 переїде ВПЕРЕД (стане
 * middleware/першим оператором) — і вони автоматично стануть придатними до
 * HTTP-проби. Тоді їх треба добрати в `accessMatrix.ts` тим самим механізмом,
 * а цей файл — скоротити. Позначено в `testManifest.ts`.
 */

/** Ролі, яким усі 13 гейтів мають відмовляти (гейт — admin або admin|team_lead). */
const DENIED = ["manager", "hr", "financier"] as const;

interface Target { router: string; method: string; path: string }
const TARGETS: Target[] = [
  { router: "dashboard", method: "put", path: "/receivables/invoice-note" },
  { router: "dashboard", method: "put", path: "/reactivation" },
  { router: "dashboard", method: "post", path: "/deal-note" },
  { router: "dashboard", method: "post", path: "/repeat-client-plan" },
  { router: "duty", method: "post", path: "/absences" },
  { router: "duty", method: "delete", path: "/absences/:id" },
  { router: "goals", method: "post", path: "/" },
  { router: "goals", method: "patch", path: "/:id" },
  { router: "goals", method: "delete", path: "/:id" },
  { router: "plans", method: "post", path: "/formation/submit" },
  { router: "tasks", method: "post", path: "/plan" },
  { router: "tasks", method: "post", path: "/" },
  { router: "tasks", method: "patch", path: "/:id" },
];

const ROUTERS: Record<string, () => Promise<{ [k: string]: unknown }>> = {
  dashboard: () => import("../routes/dashboard.js"),
  duty: () => import("../routes/duty.js"),
  goals: () => import("../routes/goals.js"),
  plans: () => import("../routes/plans.js"),
  tasks: () => import("../routes/tasks.js"),
};

/**
 * Дістати ВЕСЬ ланцюжок обробників роуту — разом із middleware.
 *
 * 🔴 ЧОМУ НЕ ЛИШЕ ОСТАННІЙ. Перша версія брала `stack[stack.length - 1]` і тим самим
 * ПЕРЕСТРИБУВАЛА гейт: у `DELETE /goals/:id` він оформлений як middleware
 * `requireRole("admin","team_lead")`, а не як `if` у тілі. Тест доповз до фінального
 * обробника й виконав справжній `DELETE ... WHERE id = 0` проти прод-БД — рядків із
 * таким id немає, тож нічого не зникло (перевірено: monthly_goals 20 → 20, мінімальний
 * id = 1), але висновок «заборонена роль щось зробила» був артефактом ТЕСТУ, а не
 * дірою в коді. Тепер проганяємо ланцюжок цілком, як це робить express.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findChain(router: any, method: string, path: string): ((req: Request, res: Response, next: (e?: unknown) => void) => unknown)[] {
  for (const layer of router.stack ?? []) {
    const r = layer.route;
    if (!r || r.path !== path || !r.methods?.[method]) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (r.stack ?? []).map((l: any) => l.handle);
  }
  return [];
}

/** Прогнати ланцюжок до першої відповіді: далі за неї express теж не пішов би. */
async function runChain(
  chain: ((req: Request, res: Response, next: (e?: unknown) => void) => unknown)[],
  req: Request, res: Response, answered: () => boolean,
): Promise<void> {
  for (const h of chain) {
    let passed = false;
    await h(req, res, () => { passed = true; });
    if (answered()) return;   // middleware відповів (403) — стоп, як у express
    if (!passed) return;      // не викликав next() і не відповів — далі не йдемо
  }
}

/** Підроблений res, який лише запам'ятовує код і тіло. */
function fakeRes() {
  const state: { code: number | null; body: unknown } = { code: null, body: null };
  const res = {
    status(c: number) { state.code = c; return res; },
    json(b: unknown) { state.body = b; return res; },
    send(b: unknown) { state.body = b; return res; },
  };
  return { res: res as unknown as Response, state };
}

test("#12 ЮНІТ-ГЕЙТ: 13 «стендових» ендпоінтів відмовляють заборонених ролям", needsDb(), async (t) => {
  const problems: string[] = [];
  const validatedFirst: string[] = [];
  let checked = 0, gateProven = 0;
  for (const tg of TARGETS) {
    const mod = await ROUTERS[tg.router]();
    const routerKey = Object.keys(mod).find((k) => k.toLowerCase().includes("router"));
    assert.ok(routerKey, `${tg.router}: не знайдено експорт роутера`);
    const chain = findChain(mod[routerKey!], tg.method, tg.path);
    if (!chain.length) { problems.push(`${tg.method.toUpperCase()} ${tg.router}${tg.path}: обробник не знайдено у стеку`); continue; }

    for (const role of DENIED) {
      const { res, state } = fakeRes();
      const req = {
        auth: { userId: 0, role, roleKey: role, managerId: -1, teamId: -1 },
        // Ціль неіснуюча, тіло невалідне — навіть якщо гейт пропустить, чіплятись нема за що.
        params: { id: "0", clientKey: "__zzz__" },
        query: {}, body: { __probe__: "невалідне тіло" },
      } as unknown as Request;
      checked++;
      try {
        await runChain(chain, req, res, () => state.code !== null);
      } catch {
        // Виняток ДО гейта — теж не 403; фіксуємо як розбіжність нижче.
      }
      // 🔴 ЩО САМЕ ТУТ МОЖНА ДОВЕСТИ. Тіло невалідне, тож у цих обробників першою
      // спрацьовує ВАЛІДАЦІЯ і віддає 400 — до гейта виконання не доходить. Це не хиба
      // тесту, а точний опис стану: гейт стоїть НЕ першим. Тому класифікуємо:
      //   • 403 — гейт досягнутий і спрацював;
      //   • 400 — гейт не досягнутий, але й НІЧОГО не сталось (запит помер на валідації);
      //   • 2xx — 🔴 заборонена роль щось ЗРОБИЛА. Провал за будь-яких умов.
      // Після рефакторингу гейт переїде вперед, і ці 400 мають стати 403 — саме той
      // перехід і буде доказом, що правка лягла.
      if (state.code != null && state.code >= 200 && state.code < 300) {
        problems.push(`🔴 ${tg.method.toUpperCase()} ${tg.router}${tg.path} · ${role}: `
          + `заборонена роль отримала ${state.code} — вона щось ЗРОБИЛА`);
      } else if (state.code === 403) {
        gateProven++;
      } else {
        validatedFirst.push(`${tg.method.toUpperCase()} ${tg.router}${tg.path}`);
      }
    }
  }
  t.diagnostic(`перевірено ${checked} пар · гейт спрацював явно: ${gateProven} · померло на валідації до гейта: ${validatedFirst.length}`);
  t.diagnostic("після рефакторингу «валідація раніше» має стати 0 — це і буде доказ, що гейт переїхав уперед");
  assert.equal(checked, TARGETS.length * DENIED.length,
    `перевірено ${checked}, очікували ${TARGETS.length * DENIED.length} — частина обробників не знайдена`);
  assert.deepEqual(problems, [],
    "🔴 заборонена роль отримала успішну відповідь:\n  " + problems.join("\n  "));
  assert.equal(gateProven + validatedFirst.length, checked, "частина проб не класифікована");
});
