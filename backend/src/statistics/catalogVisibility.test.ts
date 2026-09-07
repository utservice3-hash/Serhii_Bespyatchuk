import { test } from "node:test";
import assert from "node:assert/strict";
import { CATALOG, HIDDEN_DEPARTMENTS, visibleDepartments, getMetric } from "./catalog.js";

/**
 * #355 — РУЧНІ ВІДДІЛИ ЗНИКАЮТЬ З ЕКРАНА, АЛЕ НЕ З ДОВІДНИКА.
 *
 * Рішення власника 07.09.2026: «оці ручні вкладки всі поскривай — ціль, щоб у ручному
 * нічого не заповнювали». Заміряно: у `finance` і `hr` УСІ метрики `source: "manual"`.
 *
 * 🔴 ТРИ ТВЕРДЖЕННЯ, І СЕРЕДНЄ — НАЙВАЖЛИВІШЕ:
 * ① сховані відділи зникли з видачі;
 * ② автоматичні ЛИШИЛИСЬ (дзеркало — без нього гейт зеленів би на порожньому списку,
 *   тобто на екрані, який не показує нічого);
 * ③ `getMetric` для СХОВАНОГО відділу все ще віддає метрику — ховаємо подачу, а не зміст.
 *   Прибрати їх із довідника означало б зламати ручний запис і CSV-імпорт, тобто знищити
 *   історію заради того, щоб її не показувати.
 */
test("#355 сховані відділи не у видачі, автоматичні на місці, довідник цілий", () => {
  const shown = visibleDepartments().map((d) => d.key);
  for (const h of HIDDEN_DEPARTMENTS) {
    assert.ok(!shown.includes(h), `🔴 «${h}» усе ще у видачі — вкладка не сховалась`);
  }
  for (const keep of ["sales", "leadgen", "marketing"]) {
    assert.ok(shown.includes(keep),
      `🔴 «${keep}» зник разом із ручними — сховали більше, ніж просили`);
  }
  assert.ok(shown.length > 0,
    "🔴 видимих відділів НЕМАЄ ЗОВСІМ — екран порожній, і гейт на «сховано» був би зелений");

  // ③ довідник цілий: беремо будь-яку метрику схованого відділу й вимагаємо, щоб вона була
  const hiddenDept = CATALOG.find((d) => HIDDEN_DEPARTMENTS.includes(d.key));
  assert.ok(hiddenDept, "🔴 схований відділ зник із каталогу — це вже не приховування");
  const anyKey = hiddenDept!.metrics[0]?.key;
  assert.ok(anyKey && getMetric(hiddenDept!.key, anyKey),
    "🔴 метрика схованого відділу більше не знаходиться — зламається ручний запис і CSV-імпорт");
});
