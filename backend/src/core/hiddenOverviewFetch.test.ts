import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * #9961 — ЗАПИТИ «ОГЛЯДУ» ЙДУТЬ ЛИШЕ НА «ОГЛЯДІ».
 *
 * Заміряно на проді 16.11.2026: при відкритті «Звіту» контейнер слав шість запитів прихованого
 * «Огляду», серед них два `/overview` по 5,1 с, і повторював їх щопʼять хвилин у кожній вкладці.
 * Їхніх даних ніхто не бачив, а Neon вони займали поруч із `/report-plan`.
 *
 * Межа ефекту змістова: від `useEffect(` до масиву залежностей, а не «N рядків після».
 */
const SRC = path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", "pages", "Dashboard.tsx");

function overviewEffect(): { body: string; deps: string } {
  const src = readFileSync(SRC, "utf8");
  const call = src.indexOf("fetchOverview(params)");
  assert.ok(call > 0, "🔴 у контейнері немає виклику fetchOverview(params) — гейту нема що стерегти");
  const start = src.lastIndexOf("useEffect(() => {", call);
  const depsAt = src.indexOf("}, [", call);
  const depsEnd = src.indexOf("]);", depsAt);
  assert.ok(start > 0 && depsAt > call && depsEnd > depsAt, "🔴 не знайшов меж ефекту «Огляду»");
  return { body: src.slice(start, depsAt), deps: src.slice(depsAt + 4, depsEnd) };
}

test("#9961 ЗАПИТИ «ОГЛЯДУ» НЕ ЙДУТЬ З ІНШИХ ЕКРАНІВ — і йдуть з «Огляду»", () => {
  const { body, deps } = overviewEffect();
  const guard = body.indexOf('if (section !== "overview") return;');
  assert.ok(guard > 0, "🔴 ефект «Огляду» не перевіряє секцію: шість запитів знову йдуть з кожного екрана");
  for (const fn of ["fetchConversion(", "fetchOverview(", "fetchFunnel(", "fetchTimeseries(", "setLoading(true)"])
    assert.ok(body.indexOf(fn) > guard,
      `🔴 ${fn} стоїть ДО перевірки секції — цей запит іде з кожного екрана`);
  assert.ok(deps.split(",").map((x) => x.trim()).includes("section"),
    "🔴 секції немає в залежностях ефекту: при переході на «Огляд» дані не завантажаться");
  // 🪞 Дзеркало: запити не зникли разом із перевіркою — «Огляд» мусить їх слати.
  const src = readFileSync(SRC, "utf8");
  assert.ok(/section === "overview" && \(\s*<OverviewSection/.test(src),
    "🔴 «Огляд» більше не малюється контейнером — гейт стереже ефект без екрана");
  assert.equal((body.match(/fetchOverview\(/g) ?? []).length, 2,
    "🔴 в ефекті не два fetchOverview (період і попередній період) — склад запитів «Огляду» змінився");
});
