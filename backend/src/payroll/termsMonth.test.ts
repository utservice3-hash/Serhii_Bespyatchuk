import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 💸 «Умови» в «Зарплаті»: з якого місяця діє зміна — словами, і однакове збереження не пишеться вдруге (звернення №120,
 * Тетяна 12.11.2026: «додала оф зп, натиснула зберегти — без змін»; насправді пʼять разів записалось «з грудня», а
 * дивилась вона листопад). Замовчування «з наступного» не змінюється (Роман 16.11.2026). Гейти `#3995`–`#3995b`.
 */
const SRC = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "src", p), "utf8");
const FRONT = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", p), "utf8");

async function lazy() {
  // ліниво: service → db/pool, а пул кидає на імпорті без DATABASE_URL (правило зони testing)
  process.env.DATABASE_URL ??= "postgres://unused/none";
  for (const k of ["JWT_SECRET", "KOMMO_BASE_URL", "KOMMO_API_TOKEN"]) process.env[k] ??= "test";
  return await import("./service.js");
}

/**
 * #3995 — ТОЙ САМИЙ ЗАПИС З ТОГО САМОГО МІСЯЦЯ НЕ ПИШЕТЬСЯ ВДРУГЕ, по обидва боки: та сама офіційна ЗП (сума й «вираховувати»)
 * — «те саме», інша сума чи інший спосіб — ні, запису ще не було — ні; умови — так само за рівнем, ставкою, % і «без %»
 * (числа з бази приходять рядками). У сервісі обидві вставки стоять ПІСЛЯ перевірки, а відповідь каже місяць і скільки записано.
 * 🧨 Червоніє, якщо повтор знову запишеться (пʼять однакових рядків), зміна суми загубиться або відповідь не назве місяця.
 */
test("#3995 УМОВИ ЗАРПЛАТИ: однакова офіційна ЗП / умови з того самого місяця не пишуться вдруге, інші — пишуться; відповідь — місяць і кількість", async () => {
  const { sameOfficial, sameTerms } = await lazy();
  assert.equal(sameOfficial({ amount: "7084.00", deduct: false }, 7084, false), true, "🔴 та сама офіційна ЗП записалась би вдруге");
  assert.equal(sameOfficial({ amount: 7084, deduct: false }, 7000, false), false, "🔴 нова сума загубилась");
  assert.equal(sameOfficial({ amount: 7084, deduct: false }, 7084, true), false, "🔴 зміна «вираховувати» загубилась");
  assert.equal(sameOfficial(undefined, 7084, false), false, "🔴 перший запис не пишеться");
  const was = { level: "start", rate: null, pct: null, pct_clear: false };
  assert.equal(sameTerms(was, { level: "start", rate: null, pct: null, pctClear: false }), true, "🔴 ті самі умови записались би вдруге");
  assert.equal(sameTerms(was, { level: "profi", rate: null, pct: null, pctClear: false }), false, "🔴 новий рівень загубився");
  assert.equal(sameTerms({ level: null, rate: "15000" as unknown as number, pct: null, pct_clear: false }, { level: null, rate: 15000, pct: null, pctClear: false }), true, "🔴 ставка з бази рядком — не та сама");
  assert.equal(sameTerms({ level: null, rate: null, pct: 5, pct_clear: false }, { level: null, rate: null, pct: null, pctClear: true }), false, "🔴 «без відсотка» загубилось");
  assert.equal(sameTerms(undefined, { level: "start", rate: null, pct: null, pctClear: false }), false, "🔴 перший запис умов не пишеться");
  const svc = SRC("payroll/service.ts");
  assert.match(svc, /if \(!sameTerms\(prevT, \{ level: lvl, rate, pct, pctClear: pctIn === null \}\)\) \{\s*saved\+\+;\s*await c\.query\(`INSERT INTO payroll_terms/, "🔴 умови пишуться без перевірки повтору");
  assert.match(svc, /if \(!sameOfficial\(prevO, amount, !!o\.deduct\)\) \{\s*saved\+\+;\s*await c\.query\(`INSERT INTO payroll_official/, "🔴 офіційна ЗП пишеться без перевірки повтору");
  assert.match(svc, /return \{ ok: true, from: fromOut, saved \};/, "🔴 відповідь не каже, з якого місяця й скільки записано");
});

/**
 * #3995b — ЕКРАН КАЖЕ МІСЯЦЬ, через спільні сповіщення дашборда: під офіційною ЗП — «діятиме з місяця …» за перемикачем
 * унизу; після збереження — «Умови збережено» з місяцем (і «у відомості <поточний> їх не буде», коли вибрано наступний);
 * нічого не записано — інформаційне «Змін немає», вікно не закривається. Замовчування перемикача — «з наступного», як було.
 * 🧨 Червоніє, якщо місяць зникне з підказки чи повідомлення, «змін немає» стане тихим або замовчування зміниться.
 */
test("#3995b ЕКРАН «УМОВИ»: місяць під офіційною ЗП і в повідомленні, «Змін немає» — інформаційне, замовчування — «з наступного»", () => {
  const fe = FRONT("payroll/system/PeopleSettings.tsx");
  assert.match(fe, /import \{ useToast \} from "\.\.\/\.\.\/components\/Toasts";/, "🔴 не спільні сповіщення дашборда");
  assert.match(fe, /const \[from, setFrom\] = useState<"cur" \| "next">\("next"\);/, "🔴 замовчування місяця змінено без рішення");
  assert.match(fe, /const effMonth = from === "next" \? nextMonth\(live\) : live;/, "🔴 місяць підказки не за перемикачем");
  assert.match(fe, /<Field label="Офіційна ЗП, ₴ щомісяця" hint=\{`0 або порожньо — немає · діятиме з місяця «\$\{monthTitle\(effMonth\)\}»`\}>/, "🔴 під офіційною ЗП не видно місяця");
  assert.match(fe, /if \(r\.saved === 0\) \{ toast\(`Це вже записано з місяця «\$\{monthTitle\(mk\)\}»\.`, \{ head: "Змін немає", tone: "info" \}\); return; \}/, "🔴 «змін немає» — не інформаційне сповіщення або вікно закривається");
  assert.match(fe, /у відомості «\$\{monthTitle\(live\)\}» їх не буде/, "🔴 не сказано, що в поточній відомості зміни не буде");
  assert.match(fe, /toast\(\[when, offer\]\.filter\(Boolean\)\.join\(" "\) \|\| p\.name, \{ head: "Умови збережено" \}\)/, "🔴 повідомлення про збереження без місяця");
});
