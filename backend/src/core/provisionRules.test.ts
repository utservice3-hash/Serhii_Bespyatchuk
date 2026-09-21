import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { syncOwnsActive, isActiveAssignSql } from "./provisionRules.js";

/**
 * #599 — СИНК KOMMO НЕ ВИМИКАЄ ШТАБ: акаунт із ручною не-продажною роллю зберігає активність,
 * хоч би що казала CRM; 🪞 продажні ролі, кандидат і відсутність ручної ролі — під синком, як
 * і було (звільнений у CRM менеджер мусить втратити вхід). Червоніє, якщо зняти виняток
 * (адміна знову вимкне) або розширити його на будь-який override (прийняті наймом перестануть
 * вимикатись).
 */
test("#599 provisionUsers: активність штабу з ручною роллю синк не чіпає; продажні ролі й кандидат — під синком", () => {
  for (const r of ["admin", "ceo", "opdir", "kvp", "financier", "hr", "____________", "custom_role"])
    assert.equal(syncOwnsActive(r), false, `${r}: доступ видав адмін, синк не вимикає`);
  for (const r of [null, undefined, "", "  ", "manager", "team_lead", "candidate"])
    assert.equal(syncOwnsActive(r), true, `🪞 ${JSON.stringify(r)}: активність веде CRM`);
  const sql = isActiveAssignSql("$4");
  assert.match(sql, /^is_active = CASE WHEN role_override IS NULL OR btrim\(role_override\) = '' OR role_override IN \('manager', 'team_lead', 'candidate'\) THEN \$4 ELSE is_active END$/);
});

/**
 * #599b — ПРОВОДКА: `provisionUsers` справді пише активність через правило, а «голого»
 * `is_active = $4` у його UPDATE більше немає. Читає джерело. Червоніє на поверненні старого рядка.
 */
test("#599b provisionUsers пише is_active ЧЕРЕЗ правило, голого присвоєння з CRM немає", () => {
  const src = readFileSync(path.join(import.meta.dirname, "..", "..", "src", "db", "userProvisioning.ts"), "utf8");
  assert.match(src, /\$\{isActiveAssignSql\("\$4"\)\} WHERE id = \$5/);
  assert.doesNotMatch(src, /manager_id = \$3, is_active = \$4/);
});

/**
 * #599c — ФОРМА ВХОДУ НАЗИВАЄ ПРИЧИНУ ВІДМОВИ 403 текстом сервера, а 401 лишає загальним (не
 * підказує, чи існує email). Читає джерело. Червоніє, якщо знову затерти 403 фразою про пароль.
 */
test("#599c форма входу: 403 показує причину сервера, 401 — загальна фраза", () => {
  const src = readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", "pages", "Login.tsx"), "utf8");
  assert.match(src, /r\?\.status === 403 && r\.data\?\.error \? r\.data\.error : "Невірний email або пароль"/);
});
