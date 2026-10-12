import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 🪟 ПРОХІД B СТАНДАРТУ СПОВІЩЕНЬ — СВІЙ ДІАЛОГ ЗАМІСТЬ `window.confirm/prompt` (09.10.2026, Роман: «всі сповіщення в
 * 1 системі і за 1 правилами»). 41 confirm + 25 prompt у 25 файлах переведено на `useDialogs()`.
 */
const FE_ROOT = fileURLToPath(new URL("../../frontend/src/", import.meta.url));
const FE = (rel: string) => path.join(FE_ROOT, rel);
const stripComments = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1 ");
function frontFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string) => { for (const n of readdirSync(d)) { const f = path.join(d, n); if (statSync(f).isDirectory()) walk(f); else if (/\.(tsx?|jsx?)$/.test(n) && !/\.test\./.test(n)) out.push(f); } };
  walk(FE_ROOT);
  return out;
}

/**
 * #1510 — У ФРОНТІ НЕМАЄ `confirm()`/`prompt()` БРАУЗЕРА. Перелік — УВЕСЬ `frontend/src` (критерій від предмета: новий файл
 * з `window.confirm` не пройде повз).
 * 🧨 Червоніє, якщо будь-де повернеться `confirm(` / `prompt(` / `window.confirm(` / `window.prompt(`.
 */
test("#1510 у фронті немає confirm()/prompt() браузера — питання йдуть через діалог дашборда", () => {
  const files = frontFiles();
  assert.ok(files.length > 50, `🔴 у frontend/src лише ${files.length} файлів — перевіряти нема чого`);
  const hits: string[] = [];
  for (const f of files) {
    const code = stripComments(readFileSync(f, "utf8"));
    if (/(^|[^A-Za-z_.$])(window\.)?(confirm|prompt)\(/.test(code)) hits.push(path.relative(FE_ROOT, f));
  }
  assert.deepEqual(hits, [], `🔴 вікно браузера повернулось: ${hits.join(", ")} — використовуйте useDialogs()`);
});

/**
 * #1510b — КОЖЕН ВИКЛИК ДІАЛОГУ СТОЇТЬ З `await`, І ОБГОРТКИ НАД НИМ — ТЕЖ. Діалог повертає обіцянку, а вона завжди
 * «правдива»: `if (!dlg.confirm(…))` без `await` пропустить «Видалити?» БЕЗ питання, і `tsc` цього не бачить (спіймано
 * на `leaveGuard` в OneOnOne при переведенні: `if (!leaveGuard()) return` `tsc` не позначив).
 * 🧨 Червоніє, якщо прибрати `await` перед `dlg.confirm/prompt/choose/form` або перед обгорткою, що їх повертає.
 */
test("#1510b кожен виклик діалогу — з await, і обгортки над ним теж", () => {
  const bad: string[] = [];
  let calls = 0;
  for (const f of frontFiles()) {
    if (/components\/Dialogs\.tsx$/.test(f)) continue;
    const code = stripComments(readFileSync(f, "utf8"));
    const rel = path.relative(FE_ROOT, f);
    for (const m of code.matchAll(/dlg\.(confirm|prompt|choose|form)\(/g)) {
      calls++;
      const before = code.slice(Math.max(0, (m.index ?? 0) - 7), m.index);
      if (!/await \(?$/.test(before) && !/await $/.test(before)) bad.push(`${rel}: ${code.slice(m.index, (m.index ?? 0) + 40)}`);
    }
    // обгортки: const X = async (...) => ... dlg.… — їхній результат теж лише з await
    for (const w of code.matchAll(/const (\w+) = async [^\n]*?=>[^\n]*?dlg\.(confirm|prompt|choose|form)\(/g)) {
      const name = w[1];
      for (const u of code.matchAll(new RegExp(`(if \\(!?|&& !?|\\|\\| !?|return !?)${name}\\(`, "g"))) bad.push(`${rel}: обгортка ${name} без await — «${u[0]}»`);
    }
  }
  assert.ok(calls >= 60, `🔴 знайдено лише ${calls} викликів діалогу — переведення зламалось або гейт не бачить файлів`);
  assert.deepEqual(bad, [], `🔴 діалог без await — дія пройде БЕЗ питання:\n${bad.join("\n")}`);
});

interface RulesMod {
  firstInvalid: (fields: { key: string; label: string; required?: boolean; options?: { value: string; label: string }[] }[], values: Record<string, string>) => string | null;
  submittedValues: (fields: { key: string; label: string }[], values: Record<string, string>) => Record<string, string>;
  keyAction: (key: string, o: { inMultiline: boolean; invalid: boolean }) => "cancel" | "submit" | null;
  confirmLabel: (text: string) => { label: string; danger: boolean };
}
async function loadRules(): Promise<RulesMod> {
  const ts = (await import("typescript")).default;
  const js = ts.transpileModule(readFileSync(FE("components/dialogRules.ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return await import(`data:text/javascript,${encodeURIComponent(js)}`) as RulesMod;
}

/**
 * #1510c — ПРАВИЛА ДІАЛОГУ, по обидва боки кожної межі: Esc скасовує; Enter підтверджує, але не з порожнім обовʼязковим
 * полем і не в багаторядковому; пробіли обрізаються; вибір — лише зі списку; кнопка — назва дії, небезпечна — червона.
 * 🧨 Червоніє, якщо обовʼязкове поле пропустить порожнє або Enter видалятиме з порожньою причиною.
 */
test("#1510c правила діалогу: Esc/Enter, обовʼязкове поле, вибір лише зі списку, назва дії на кнопці", async () => {
  const R = await loadRules();
  assert.equal(R.keyAction("Escape", { inMultiline: false, invalid: false }), "cancel");
  assert.equal(R.keyAction("Enter", { inMultiline: false, invalid: false }), "submit");
  assert.equal(R.keyAction("Enter", { inMultiline: false, invalid: true }), null, "🔴 Enter підтвердив порожнє обовʼязкове поле");
  assert.equal(R.keyAction("Enter", { inMultiline: true, invalid: false }), null, "🔴 Enter у багаторядковому полі закрив діалог замість нового рядка");
  const req = [{ key: "r", label: "Причина", required: true }];
  assert.equal(R.firstInvalid(req, { r: "   " }), "r", "🔴 пробіли пройшли як обовʼязкова причина");
  assert.equal(R.firstInvalid(req, { r: " так " }), null);
  assert.deepEqual(R.submittedValues(req, { r: "  так  " }), { r: "так" }, "🔴 крайні пробіли не обрізано");
  const opt = [{ key: "s", label: "Обсяг", required: true, options: [{ value: "own", label: "Свої" }, { value: "team", label: "Команда" }] }];
  assert.equal(R.firstInvalid(opt, { s: "" }), "s", "🔴 обовʼязковий вибір пропущено");
  assert.equal(R.firstInvalid(opt, { s: "company" }), "s", "🔴 значення поза списком пройшло");
  assert.equal(R.firstInvalid(opt, { s: "team" }), null);
  assert.deepEqual(R.confirmLabel("Видалити «Звіт.pdf»?"), { label: "Видалити", danger: true }, "🔴 небезпечна дія не червона або без назви");
  assert.deepEqual(R.confirmLabel("Прибрати папку «Акти»?"), { label: "Прибрати", danger: true });
  assert.deepEqual(R.confirmLabel("Зберегти зміни?"), { label: "Зберегти", danger: false });
  assert.deepEqual(R.confirmLabel("Є незбережені зміни. Вийти без збереження?"), { label: "Так", danger: false });
});

/**
 * #1510d — ДІАЛОГ ДОСТУПНИЙ УСЮДИ Й ЧИТАЄТЬСЯ ЯК ДІАЛОГ: провайдер у `main.tsx` (без нього кожен виклик впаде), розмітка
 * `role="dialog"` + `aria-modal`, у небезпечному підтвердженні фокус на «Скасувати».
 * 🧨 Червоніє, якщо прибрати провайдер, `aria-modal` чи безпечний фокус.
 */
test("#1510d діалог: провайдер у main.tsx, role=dialog + aria-modal, у небезпечному — фокус на «Скасувати»", () => {
  const main = readFileSync(FE("main.tsx"), "utf8");
  assert.match(main, /<DialogProvider>\s*<App \/>\s*<\/DialogProvider>/, "🔴 провайдера діалогів немає навколо застосунку");
  const d = stripComments(readFileSync(FE("components/Dialogs.tsx"), "utf8"));
  assert.match(d, /role="dialog" aria-modal="true"/, "🔴 діалог не оголошено як модальний");
  assert.match(d, /\(req\.danger \? cancelRef\.current : okRef\.current\)\?\.focus\(\)/, "🔴 у небезпечному підтвердженні фокус не на «Скасувати»");
});
