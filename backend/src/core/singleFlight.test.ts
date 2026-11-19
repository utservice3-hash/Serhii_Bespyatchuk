import { test } from "node:test";
import assert from "node:assert/strict";
import { singleFlight } from "./singleFlight.js";

/** #9965 — спільний запит для одночасних однакових викликів: ділить, але НЕ запамʼятовує. */
const gate = <T>() => { let open!: (v: T) => void, fail!: (e: unknown) => void;
  const p = new Promise<T>((res, rej) => { open = res; fail = rej; }); return { p, open, fail }; };

test("#9965 СПІЛЬНИЙ ЗАПИТ: одночасні однакові виклики — один запит; після завершення — новий", async () => {
  const flying = new Map<string, Promise<number[]>>(); let calls = 0;
  const g1 = gate<number[]>();
  const a = singleFlight(flying, "k", () => { calls++; return g1.p; });
  const b = singleFlight(flying, "k", () => { calls++; return g1.p; });
  const other = singleFlight(flying, "інший ключ", () => { calls++; return Promise.resolve([9]); });
  assert.equal(calls, 2, "🔴 два одночасні виклики з одним ключем пішли в базу двічі — спільного запиту немає");
  g1.open([1, 2]);
  assert.deepEqual(await a, [1, 2]); assert.deepEqual(await b, [1, 2]); assert.deepEqual(await other, [9]);
  assert.equal(flying.size, 0, "🔴 після завершення у мапі лишився запис — це вже кеш без стелі, а не спільний запит");
  // 🪞 Дзеркало: результат НЕ запамʼятовується. Наступний виклик мусить піти в базу знову.
  const c = await singleFlight(flying, "k", () => { calls++; return Promise.resolve([3]); });
  assert.deepEqual(c, [3], "🔴 після завершення повернуто старий результат — застарілі дані");
  assert.equal(calls, 3);
});

test("#9965b СПІЛЬНИЙ ЗАПИТ: помилка дістається всім, хто чекав, і сліду не лишає", async () => {
  const flying = new Map<string, Promise<number>>(); const g = gate<number>(); let calls = 0;
  const a = singleFlight(flying, "k", () => { calls++; return g.p; });
  const b = singleFlight(flying, "k", () => { calls++; return g.p; });
  g.fail(new Error("база впала"));
  await assert.rejects(a, /база впала/); await assert.rejects(b, /база впала/);
  assert.equal(flying.size, 0, "🔴 невдалий запит лишився в мапі — наступні виклики отримували б ту саму помилку");
  assert.equal(await singleFlight(flying, "k", () => { calls++; return Promise.resolve(7); }), 7);
  assert.equal(calls, 2);
});
