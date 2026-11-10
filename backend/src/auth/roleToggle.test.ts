import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const FE = path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", "pages", "dashboard");

/** Правило фронту виконується, а не читається очима (той самий прийом, що `loadGran` у Статистиках). */
async function loadRoleAccess() {
  const ts = (await import("typescript")).default;
  const js = ts.transpileModule(readFileSync(path.join(FE, "roleAccess.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return await import(`data:text/javascript,${encodeURIComponent(js)}`);
}

/**
 * #7611 — ТУМБЛЕР РОЛІ НЕ БЕРЕ ПРОТОТИП (10.11.2026). `screen_access["constructor"]` без ключа віддавав
 * `Object.prototype.constructor` — екран показував «Конструктор документів» увімкненим там, де його немає (роль ОД
 * лишилась без Конструктора непомітно), а клік писав `false`. Фікстура по обидва боки: ключа немає / `true` / `false`.
 * 🧨 Червоніє, якщо `isGranted` знову читає індексом або екран ролей обходить її.
 */
test("#7611 РОЛІ: тумблер «увімкнено» лише для власного ключа з true — «constructor» без ключа вимкнений, клік вмикає", async () => {
  const { isGranted, toggled } = await loadRoleAccess();
  assert.equal(isGranted({}, "constructor"), false, "🔴 відсутній «constructor» показано увімкненим (прототип)");
  assert.equal(isGranted({}, "toString"), false, "🔴 ключ із прототипу показано увімкненим");
  assert.equal(isGranted({ constructor: true }, "constructor"), true, "🔴 увімкнений Конструктор показано вимкненим");
  assert.equal(isGranted({ constructor: false }, "constructor"), false);
  assert.equal(isGranted({ bank: true }, "bank"), true, "🔴 звичайна вкладка перестала читатись");
  assert.deepEqual(toggled({ bank: true }, "constructor"), { bank: true, constructor: true }, "🔴 клік по відсутньому Конструктору не ввімкнув його");
  assert.deepEqual(toggled({ constructor: true }, "constructor"), { constructor: false });

  const src = readFileSync(path.join(FE, "sections", "SettingsSection.tsx"), "utf8");
  assert.match(src, /<Toggle on=\{isGranted\(draft\.screen_access, t\.key\)\}/, "🔴 тумблер вкладки ролі читає мапу в обхід isGranted");
  assert.match(src, /<Toggle on=\{isGranted\(draft\.permissions, p\.key\)\}/, "🔴 тумблер права ролі читає мапу в обхід isGranted");
  assert.doesNotMatch(src, /draft\.(screen_access|permissions)\[/, "🔴 на екрані ролей знову читання мапи індексом");
});
