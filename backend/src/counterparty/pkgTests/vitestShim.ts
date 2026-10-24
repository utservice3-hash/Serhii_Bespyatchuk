/**
 * Мінімальний `describe` / `it` / `expect` (підмножина vitest, рівно та, якою писані тести пакета Сергія) поверх `node:assert`.
 * Навіщо: тести пакета переносяться в наш набір ДОСЛІВНО (`*.spec.ts` — ті самі твердження й тексти), а гейтом у маніфесті
 * стає один `test("#24xx …")` на файл пакета (`counterparty.test.ts`), який проганяє всі його `it` і падає з переліком
 * провалених — без вкладених підтестів, яких не бачить критерій приросту (`judgeDelta`).
 */
import assert from "node:assert/strict";

type Fn = () => unknown | Promise<unknown>;
const registry: Array<{ name: string; fn: Fn }> = [];
const prefix: string[] = [];

export function describe(name: string, fn: () => void): void { prefix.push(name); try { fn(); } finally { prefix.pop(); } }
function itImpl(name: string, fn: Fn): void { registry.push({ name: [...prefix, name].join(" › "), fn }); }
const fmt = (tpl: string, args: unknown[]) => { let i = 0; return tpl.replace(/%[sdifjo]/g, () => String(args[i++])); };
export const it = Object.assign(itImpl, {
  each: <T extends unknown[]>(rows: readonly T[]) => (name: string, fn: (...a: T) => unknown) => {
    for (const r of rows) itImpl(fmt(name, r), () => fn(...r));
  },
});

/** Забрати зареєстроване (імпорт модуля `*.spec.js` реєструє його `it`) і прогнати; повертає провалені. */
export async function runRegistered(): Promise<{ ran: number; failed: string[] }> {
  const list = registry.splice(0);
  const failed: string[] = [];
  for (const t of list) {
    try { await t.fn(); } catch (e) { failed.push(`${t.name}: ${(e as Error).message.split("\n")[0]}`); }
  }
  return { ran: list.length, failed };
}

function matchObject(actual: unknown, exp: unknown, path = "") {
  if (exp && typeof exp === "object" && !Array.isArray(exp)) {
    assert.ok(actual && typeof actual === "object", `${path || "значення"} не обʼєкт`);
    for (const [k, v] of Object.entries(exp)) matchObject((actual as Record<string, unknown>)[k], v, path ? `${path}.${k}` : k);
  } else assert.deepEqual(actual, exp, path);
}
function matchers(actual: unknown, not: boolean) {
  const ok = (cond: boolean, msg: string) => assert.ok(not ? !cond : cond, (not ? "НЕ " : "") + msg);
  const eq = (a: unknown, b: unknown) => { try { assert.deepStrictEqual(a, b); return true; } catch { return false; } };
  return {
    toBe: (e: unknown) => ok(Object.is(actual, e), `очікувалось ${JSON.stringify(e)}, є ${JSON.stringify(actual)}`),
    toEqual: (e: unknown) => ok(eq(JSON.parse(JSON.stringify(actual ?? null)), JSON.parse(JSON.stringify(e ?? null))) && (actual === undefined) === (e === undefined),
      `очікувалось ${JSON.stringify(e)}, є ${JSON.stringify(actual)}`),
    toBeNull: () => ok(actual === null, `очікувалось null, є ${JSON.stringify(actual)}`),
    toBeUndefined: () => ok(actual === undefined, `очікувалось undefined, є ${JSON.stringify(actual)}`),
    toBeCloseTo: (e: number, digits = 2) => ok(Math.abs((actual as number) - e) < 10 ** -digits / 2, `очікувалось ≈${e}, є ${String(actual)}`),
    toContain: (e: unknown) => ok(typeof actual === "string" ? actual.includes(String(e)) : Array.isArray(actual) && actual.includes(e), `${JSON.stringify(actual)} містить ${JSON.stringify(e)}`),
    toBeInstanceOf: (c: new (...a: never[]) => unknown) => ok(actual instanceof c, `екземпляр ${c.name}`),
    toMatchObject: (e: unknown) => { if (not) throw new Error("not.toMatchObject не підтримано"); matchObject(actual, e); },
    toThrow: (e?: string | RegExp) => {
      let threw = false, msg = "";
      try { (actual as () => unknown)(); } catch (x) { threw = true; msg = (x as Error).message; }
      ok(threw && (e === undefined || (typeof e === "string" ? msg.includes(e) : e.test(msg))), `кидає ${String(e ?? "")}, кинуло «${msg}»`);
    },
  };
}
export function expect(actual: unknown) {
  return Object.assign(matchers(actual, false), {
    not: matchers(actual, true),
    rejects: {
      async toThrow(e?: string | RegExp) {
        let msg: string | null = null;
        try { await (actual as Promise<unknown>); } catch (x) { msg = (x as Error).message; }
        assert.ok(msg !== null, "очікувалась помилка — проміс виконався");
        if (e !== undefined) assert.ok(typeof e === "string" ? msg!.includes(e) : e.test(msg!), `помилка «${msg}» ≠ ${String(e)}`);
      },
      async toBeInstanceOf(c: new (...a: never[]) => unknown) {
        let err: unknown = null, threw = false;
        try { await (actual as Promise<unknown>); } catch (x) { err = x; threw = true; }
        assert.ok(threw && err instanceof c, `очікувалась помилка ${c.name}`);
      },
    },
  });
}
