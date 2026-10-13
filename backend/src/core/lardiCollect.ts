/**
 * 📥 ЗБІР АРХІВУ ЦІН LARDI — логіка проходу й вирок (13.10.2026, після 3,5 тижня мовчання).
 *
 * 📐 Чому окремо від джоби. З 17.09 по 12.10 `collectLardi` щопроходу писав УСПІХ із нулем нових цін: пакет
 * «Розширений доступ до API» не було оплачено, Lardi на кожен пошук відповідав 403, а цикл ковтав будь-що, крім 200
 * (`if (r.code !== 200) continue` + `catch {}`). Заміряно 12.10: 110 маршрутів, 220 запитів, усі 403, «успіх» за 141 с.
 * Клас «зелена джоба ≠ дані йдуть» (jobs-sync.md). Модуль без пулу й конфігу — гейти ганяють його без бази й без Lardi.
 *
 * Правила вироку:
 *  · відмова в доступі (401 / 402 / 403) — це про ОБЛІКОВИЙ ЗАПИС, а не про маршрут: наступні 219 запитів дадуть те
 *    саме. Тож зупиняємось на першій і падаємо з текстом самого Lardi («Метод доступний лише при підключенні пакета…»);
 *  · жодної відповіді 200 за весь прохід (Lardi лежить, 5xx, таймаути) — теж падіння: «нуль» тут не вимір, а аварія;
 *  · хоч одна 200 — успіх, навіть якщо частина маршрутів не відповіла (поодинокий збій — не тривога);
 *  · маршрутів немає — успіх: збирати нічого, і це правда, а не збій.
 * Падіння джоби підхоплює сигналізація (`collectLardi` під наглядом, `monitoredJobs.ts`) → тривога в Telegram.
 */

export const DENIED_CODES: readonly number[] = [401, 402, 403];
export const LARDI_KINDS = ["cargo", "lorry"] as const;
export type LardiKind = (typeof LARDI_KINDS)[number];

export interface LardiAnswer { code: number; content: unknown[] | null; detail: string }

export interface CollectTally {
  routes: number;
  requests: number;
  ok: number;
  newRows: number;
  /** Перша відмова в доступі — на ній прохід зупиняється. */
  denied: { code: number; detail: string } | null;
  failed: number;
  lastFail: string | null;
}

/** Текст відмови від Lardi: поле `message` з JSON-відповіді, інакше — початок сирого тексту. */
export function lardiMessage(detail: string): string {
  try {
    const j = JSON.parse(detail) as { message?: unknown };
    if (typeof j.message === "string" && j.message.trim()) return j.message.trim();
  } catch { /* не JSON — віддаємо як є */ }
  return detail.trim().slice(0, 200) || "без тексту";
}

/** Чисте рішення: чи був прохід успішним, і якщо ні — чому, людськими словами. */
export function collectVerdict(t: CollectTally): { ok: true } | { ok: false; error: string } {
  if (t.denied) return { ok: false, error: `Lardi ${String(t.denied.code)}: ${lardiMessage(t.denied.detail)}` };
  if (t.routes > 0 && t.requests > 0 && t.ok === 0) {
    return { ok: false, error: `Lardi не відповів жодного разу: ${String(t.failed)} з ${String(t.requests)} запитів невдалі`
      + (t.lastFail ? ` (остання помилка: ${t.lastFail})` : "") };
  }
  return { ok: true };
}

export interface CollectDeps<R> {
  listRoutes: () => Promise<R[]>;
  search: (kind: LardiKind, route: R) => Promise<LardiAnswer>;
  /** Записати пропозиції; повертає кількість НОВИХ рядків. Збій бази — не ковтається: це наша аварія, не Lardi. */
  record: (kind: LardiKind, route: R, content: unknown[]) => Promise<number>;
  sleep: (ms: number) => Promise<void>;
}

/** Один прохід. Кидає з вироком, якщо Lardi відмовив або не відповів жодного разу. */
export async function runLardiCollect<R>(deps: CollectDeps<R>): Promise<CollectTally> {
  const routes = await deps.listRoutes();
  const t: CollectTally = { routes: routes.length, requests: 0, ok: 0, newRows: 0, denied: null, failed: 0, lastFail: null };
  outer: for (const rt of routes) {
    for (const kind of LARDI_KINDS) {
      t.requests++;
      let r: LardiAnswer;
      try {
        r = await deps.search(kind, rt);
      } catch (e) {
        t.failed++;
        t.lastFail = e instanceof Error ? e.message : String(e);
        continue;
      }
      if (r.code === 200 && r.content) {
        t.ok++;
        t.newRows += await deps.record(kind, rt, r.content);
        continue;
      }
      if (DENIED_CODES.includes(r.code)) { t.denied = { code: r.code, detail: r.detail }; break outer; }
      t.failed++;
      t.lastFail = `${String(r.code)} ${lardiMessage(r.detail)}`;
    }
    await deps.sleep(1000); // бережемо Lardi від частих запитів
  }
  const v = collectVerdict(t);
  if (!v.ok) throw new Error(v.error);
  return t;
}
