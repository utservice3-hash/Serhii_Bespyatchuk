/**
 * Прокладка vitest → наш раннер (`node:test`, один набір — правило проєкту). Тести пакета Сергія
 * (`roman-package-konfigurator/tests/*.test.ts`) перенесено ДОСЛІВНО: змінено лише рядки імпорту. Вони реєструють
 * випадки через `describe/it/expect` цієї прокладки, а наш гейт проганяє їх і називає кожен, що впав.
 * `toEqual` — як у vitest: рекурсивна рівність без урахування `undefined`-полів (порівнюємо JSON-форму).
 */
import assert from "node:assert/strict";

export interface Case { name: string; fn: () => void | Promise<void> }
const stack: string[] = [];
let sink: Case[] = [];

/** Випадки модуля реєструються при його імпорті (верхньорівневі `describe`), тож імпортуємо його тут, у мить збору. */
export async function collectFrom(load: () => Promise<unknown>): Promise<Case[]> {
  sink = []; await load(); const out = sink; sink = []; return out;
}
export function describe(name: string, fn: () => void): void { stack.push(name); try { fn(); } finally { stack.pop(); } }
function itFn(name: string, fn: () => void | Promise<void>): void { sink.push({ name: [...stack, name].join(" › "), fn }); }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
itFn.each = (table: any[][]) => (name: string, fn: (...args: any[]) => void | Promise<void>) => {
  for (const row of table) itFn(name.replace("%s", String(row[0])), () => fn(...row));
};
export const it = itFn;

const norm = (v: unknown) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function subset(a: any, e: any): boolean {
  if (e === null || typeof e !== "object") return Object.is(a, e);
  if (a === null || typeof a !== "object") return false;
  if (Array.isArray(e)) return Array.isArray(a) && a.length === e.length && e.every((x, i) => subset(a[i], x));
  return Object.keys(e).every((k) => subset(a[k], e[k]));
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function matchers(actual: any, negate: boolean) {
  const ok = (cond: boolean, msg: string) => { if (cond === negate) assert.fail((negate ? "НЕ очікувалось: " : "") + msg); };
  const show = (v: unknown) => JSON.stringify(v)?.slice(0, 300);
  return {
    toBe: (e: unknown) => ok(Object.is(actual, e), `${show(actual)} toBe ${show(e)}`),
    toEqual: (e: unknown) => { let eq = true; try { assert.deepStrictEqual(norm(actual), norm(e)); } catch { eq = false; } ok(eq, `${show(actual)} toEqual ${show(e)}`); },
    toBeNull: () => ok(actual === null, `${show(actual)} toBeNull`),
    toHaveLength: (n: number) => ok(actual?.length === n, `length ${actual?.length} toHaveLength ${n}`),
    toContain: (e: unknown) => ok(typeof actual === "string" ? actual.includes(String(e)) : Array.isArray(actual) && actual.includes(e), `${show(actual)} toContain ${show(e)}`),
    toMatch: (re: RegExp | string) => ok(typeof actual === "string" && (typeof re === "string" ? actual.includes(re) : re.test(actual)), `${show(actual)} toMatch ${String(re)}`),
    toBeGreaterThan: (n: number) => ok(actual > n, `${actual} > ${n}`),
    toBeGreaterThanOrEqual: (n: number) => ok(actual >= n, `${actual} >= ${n}`),
    toBeLessThanOrEqual: (n: number) => ok(actual <= n, `${actual} <= ${n}`),
    // [27.10 — тести «Виписки»] підмножина полів (рекурсивно, як у vitest), undefined, кидання з повідомленням
    toMatchObject: (e: unknown) => ok(subset(norm(actual), norm(e)), `${show(actual)} toMatchObject ${show(e)}`),
    toBeUndefined: () => ok(actual === undefined, `${show(actual)} toBeUndefined`),
    toThrow: (re?: RegExp | string) => {
      let thrown: unknown = null, did = false;
      try { (actual as () => unknown)(); } catch (x) { did = true; thrown = x; }
      const msg = String((thrown as Error)?.message ?? thrown);
      ok(did && (re === undefined || (typeof re === "string" ? msg.includes(re) : re.test(msg))), `throws ${String(re ?? "")} (кинуло: ${did ? msg : "нічого"})`);
    },
  };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function expect(actual: any) { return { ...matchers(actual, false), not: matchers(actual, true) }; }

/** Проганяє випадки; повертає назви тих, що впали, з першим рядком причини. */
export async function runCases(cases: Case[]): Promise<string[]> {
  const bad: string[] = [];
  for (const c of cases) {
    try { await c.fn(); } catch (e) { bad.push(`${c.name}: ${String((e as Error)?.message ?? e).split("\n")[0]}`); }
  }
  return bad;
}
