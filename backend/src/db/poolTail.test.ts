import { test } from "node:test";
import assert from "node:assert/strict";
import { testPoolOptions } from "./poolTail.js";

/**
 * ⏱ #224–#224b — ХВІСТ ПУЛА ЗНІМАЄТЬСЯ В ТЕСТАХ І НЕ ЧІПАЄ ПРОД.
 *
 * Механізм і заміри — у коментарі до `testPoolOptions`. Тут стережеться МЕЖА:
 * файл спільний із бойовим рантаймом, тож дзеркало важливіше за пряму перевірку.
 */

test("#224 у тестовому режимі пул не тримає процес після простою", () => {
  assert.deepEqual(testPoolOptions({ TEST_SCOPE: "prod" } as NodeJS.ProcessEnv),
    { allowExitOnIdle: true });
  assert.deepEqual(testPoolOptions({ TEST_SCOPE: "dev" } as NodeJS.ProcessEnv),
    { allowExitOnIdle: true }, "🔴 ознака — НАЯВНІСТЬ TEST_SCOPE, а не конкретне значення");
});

test("#224b ДЗЕРКАЛО: ПРОД-РАНТАЙМ НЕ ЗАЧЕПЛЕНО", () => {
  // Бойовий процес не має TEST_SCOPE ніколи — отже опція не додається взагалі,
  // і `idleTimeoutMillis: 30_000` працює рівно як працював.
  assert.deepEqual(testPoolOptions({} as NodeJS.ProcessEnv), {},
    "🔴 прод отримав allowExitOnIdle — пул почав відпускати процес там, де цього не просили");
  assert.deepEqual(testPoolOptions({ NODE_ENV: "production" } as NodeJS.ProcessEnv), {});
  // 🧨 Саботаж-орієнтир: якби умову зняли (повертали опцію завжди), цей ассерт червонів би.
  assert.equal("allowExitOnIdle" in testPoolOptions({} as NodeJS.ProcessEnv), false);
});
