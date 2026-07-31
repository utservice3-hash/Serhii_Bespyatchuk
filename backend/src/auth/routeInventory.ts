/**
 * 🔒 РЕЄСТР УСІХ РОУТІВ — джерело правди для воріт доступу.
 *
 * 🔴 НАВІЩО. Зліпок `accessMatrix.ts` покривав 65 роутів зі 173. «Матриця зелена»
 * означало «зелена там, куди ми подивились» — і саме в непокритій частині сидів
 * інцидент з HR: три оглядові ендпоінти без tab-гейта відкрились company-ролі.
 *
 * Перелік будується З РОУТЕРІВ У РАНТАЙМІ (обхід `router.stack`), а не регуляркою по
 * тексту. Регулярка вже підводила: статичний розбір показав `kvp-report` відкритим,
 * хоча насправді там 403. Роутер знає правду про свої шляхи за побудовою.
 */
import type { Router } from "express";

export interface RouteInfo {
  method: string;
  /** Повний шлях від кореня API, напр. `/api/dashboard/overview`. */
  path: string;
  /** Скільки обробників у ланцюгу — >1 означає middleware перед хендлером. */
  handlers: number;
}

/** Обійти стек одного роутера й віддати його шляхи з префіксом монтування. */
export function routesOf(router: Router, mount: string): RouteInfo[] {
  const out: RouteInfo[] = [];
  for (const layer of (router as unknown as { stack: unknown[] }).stack ?? []) {
    const r = (layer as { route?: { path: string; methods: Record<string, boolean>; stack: unknown[] } }).route;
    if (!r) continue;
    for (const [m, on] of Object.entries(r.methods)) {
      if (!on || m === "_all") continue;
      const p = r.path === "/" ? "" : r.path;
      out.push({ method: m.toUpperCase(), path: `${mount}${p}`, handlers: r.stack.length });
    }
  }
  return out;
}

/** Мапа монтування — дзеркало `app.use(...)` в `index.ts`. */
export const MOUNTS: { mount: string; module: string; export: string }[] = [
  { mount: "/api/auth", module: "../routes/auth.js", export: "authRouter" },
  { mount: "/api/dashboard", module: "../routes/dashboard.js", export: "dashboardRouter" },
  { mount: "/api/plans", module: "../routes/plans.js", export: "plansRouter" },
  { mount: "/api/teams", module: "../routes/teams.js", export: "teamsRouter" },
  { mount: "/api/tasks", module: "../routes/tasks.js", export: "tasksRouter" },
  { mount: "/api/goals", module: "../routes/goals.js", export: "goalsRouter" },
  { mount: "/api/settings", module: "../routes/settings.js", export: "settingsRouter" },
  { mount: "/api/messages", module: "../routes/messages.js", export: "messagesRouter" },
  { mount: "/api/news", module: "../routes/news.js", export: "newsRouter" },
  { mount: "/api/uploads", module: "../routes/uploads.js", export: "uploadsRouter" },
  { mount: "/api/feedback", module: "../routes/feedback.js", export: "feedbackRouter" },
  { mount: "/api/ai-work", module: "../routes/aiWork.js", export: "aiWorkRouter" },
  { mount: "/api/reports", module: "../routes/reports.js", export: "reportsRouter" },
  { mount: "/api/rates", module: "../routes/rates.js", export: "ratesRouter" },
  { mount: "/api/documents", module: "../routes/documents.js", export: "documentsRouter" },
  { mount: "/api/one-on-ones", module: "../routes/oneOnOnes.js", export: "oneOnOnesRouter" },
  { mount: "/api/duty", module: "../routes/duty.js", export: "dutyRouter" },
  { mount: "/api/training", module: "../routes/training.js", export: "trainingRouter" },
  { mount: "/api/statistics", module: "../routes/statistics.js", export: "statisticsRouter" },
  { mount: "/api/statistics", module: "../routes/statisticsSeries.js", export: "statsSeriesRouter" },
  { mount: "/api/bank", module: "../routes/bank.js", export: "bankRouter" },
  { mount: "/api/tracker", module: "../routes/tracker.js", export: "trackerRouter" },
];

/** Усі роути застосунку. Динамічний import — щоб реєстр не тягнув БД на самому імпорті. */
export async function allRoutes(): Promise<RouteInfo[]> {
  const out: RouteInfo[] = [];
  for (const m of MOUNTS) {
    const mod = (await import(m.module)) as Record<string, Router>;
    const r = mod[m.export];
    if (!r) throw new Error(`У ${m.module} немає експорту ${m.export} — реєстр монтування розійшовся з кодом`);
    out.push(...routesOf(r, m.mount));
  }
  return out.sort((a, b) => (a.path + a.method).localeCompare(b.path + b.method));
}
