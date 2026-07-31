import { test } from "node:test";
import assert from "node:assert/strict";
import { needsDb } from "../testMode.js";
import { ROLE_DECLARATIONS, ACCEPTED_DIVERGENCES } from "./roleDeclarations.js";

/**
 * #15 — ДЕКЛАРАЦІЯ ↔ ФАКТ. Ловить клас «міграція пройшла, зміна не застосувалась».
 * Передісторія й межі точності — у `roleDeclarations.ts`.
 */

const load = async () => (await import("./pool.js")).pool;

interface Row { key: string; built_in: boolean; data_scope: string; name: string }

async function rolesFromDb(): Promise<Map<string, Row>> {
  const pool = await load();
  const r = await pool.query<Row>("SELECT key, built_in, data_scope, name FROM roles");
  return new Map(r.rows.map((x) => [x.key, x]));
}

test("#15 ДЕКЛАРАЦІЯ: усі оголошені ролі існують у БД", needsDb(), async () => {
  const db = await rolesFromDb();
  assert.ok(db.size > 0, "у roles жодного рядка — тест нічого не доводить");
  const missing = ROLE_DECLARATIONS.filter((d) => !db.has(d.key)).map((d) => d.key);
  assert.deepEqual(missing, [], `🔴 ролі оголошені в схемі, але їх немає в БД: ${missing.join(", ")}`);
  const extra = [...db.keys()].filter((k) => !ROLE_DECLARATIONS.some((d) => d.key === k));
  assert.deepEqual(extra, [],
    `ролі є в БД, але не оголошені: ${extra.join(", ")} — додай у ROLE_DECLARATIONS `
    + "(склад ролей має мінятись свідомо)");
});

test("#15b 🔴 ВБУДОВАНІ ролі: БД точно == схема (панель їх не редагує)", needsDb(), async () => {
  const db = await rolesFromDb();
  const problems: string[] = [];
  for (const d of ROLE_DECLARATIONS.filter((x) => x.builtIn)) {
    const row = db.get(d.key)!;
    // Панель відмовляє редагувати вбудовані (`if (def.builtIn) return 403`), тож
    // розбіжність тут не може бути «правкою адміна» — це НЕЗАСТОСОВАНА міграція.
    if (row.data_scope !== d.dataScope) {
      problems.push(`${d.key}.data_scope: у схемі «${d.dataScope}», у БД «${row.data_scope}»`);
    }
    if (row.name !== d.name) {
      problems.push(`${d.key}.name: у схемі «${d.name}», у БД «${row.name}»`);
    }
  }
  assert.deepEqual(problems, [],
    "🔴 ВБУДОВАНА роль у БД розійшлася зі схемою — це НЕ правка адміна (панель їх не пускає), "
    + "а міграція, яка не застосувалась:\n  " + problems.join("\n  "));
});

test("#15c built_in НЕ редагує ніхто — строго для всіх ролей", needsDb(), async () => {
  const db = await rolesFromDb();
  const problems: string[] = [];
  for (const d of ROLE_DECLARATIONS) {
    const row = db.get(d.key)!;
    if (row.built_in !== d.builtIn) {
      problems.push(`${d.key}.built_in: у схемі ${d.builtIn}, у БД ${row.built_in}`);
    }
  }
  assert.deepEqual(problems, [],
    "🔴 built_in розійшовся зі схемою. Це поле не пише ЖОДЕН роут — отже, зміна "
    + "могла прийти лише з міграції, і вона застосувалась не так, як написано:\n  "
    + problems.join("\n  "));
});

test("#15d КАСТОМНІ ролі: кожна розбіжність зі схемою — або баг, або ЗАПИСАНА", needsDb(), async () => {
  const db = await rolesFromDb();
  const unregistered: string[] = [];
  for (const d of ROLE_DECLARATIONS.filter((x) => !x.builtIn)) {
    const row = db.get(d.key)!;
    const checks: [("dataScope" | "name"), string, string][] = [
      ["dataScope", d.dataScope, row.data_scope],
      ["name", d.name, row.name],
    ];
    for (const [field, declared, actual] of checks) {
      if (declared === actual) continue;
      const ok = ACCEPTED_DIVERGENCES.some(
        (a) => a.key === d.key && a.field === field && a.actual === actual);
      if (!ok) {
        unregistered.push(`${d.key}.${field}: у схемі «${declared}», у БД «${actual}»`);
      }
    }
  }
  assert.deepEqual(unregistered, [],
    "🔴 РОЗБІЖНІСТЬ СХЕМА↔БД, не записана в реєстрі. Два чесні виходи:\n"
    + "   (1) міграція не доїхала → лагодити міграцію (саме так було з hr.data_scope);\n"
    + "   (2) адмін змінив свідомо → додати рядок у ACCEPTED_DIVERGENCES з причиною.\n"
    + "   Знайдено:\n  " + unregistered.join("\n  "));
});

test("#15e ДЗЕРКАЛО: реєстр не містить мертвих записів", needsDb(), async () => {
  // Без цієї пари реєстр перетворився б на смітник: рядок, доданий заради «зелено»,
  // жив би вічно й глушив би СПРАВЖНЮ розбіжність, що випадково збіглася значенням.
  const db = await rolesFromDb();
  const dead: string[] = [];
  for (const a of ACCEPTED_DIVERGENCES) {
    const row = db.get(a.key);
    const decl = ROLE_DECLARATIONS.find((d) => d.key === a.key);
    if (!row || !decl) { dead.push(`${a.key}: такої ролі вже немає`); continue; }
    const actual = a.field === "dataScope" ? row.data_scope : row.name;
    const declared = a.field === "dataScope" ? decl.dataScope : decl.name;
    if (actual === declared) dead.push(`${a.key}.${a.field}: розбіжності більше немає`);
    else if (actual !== a.actual) dead.push(`${a.key}.${a.field}: у БД тепер «${actual}», а не «${a.actual}»`);
    assert.ok(a.why.trim().length > 0, `${a.key}.${a.field}: запис у реєстрі без причини`);
  }
  assert.deepEqual(dead, [],
    "у реєстрі прийнятих розбіжностей є мертві записи — прибери їх:\n  " + dead.join("\n  "));
});
