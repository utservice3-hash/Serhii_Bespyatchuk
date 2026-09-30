import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * 🔔 «ЧИ ВИДНО, ЩО ДІЯ СПРАЦЮВАЛА» (30.09.2026, прохід «А + Г»).
 *
 * Аудит фронту 30.09: ~40 кнопок при помилці сервера мовчали (обробник без `catch`), а в 8 місцях
 * екран стверджував успіх, якого не було. Правила живуть у `frontend/src/actionFeedback.ts` без
 * імпортів — тут вони ВИКОНУЮТЬСЯ (транспіляцією), а не читаються очима.
 */
const FE = (p: string) => fileURLToPath(new URL(`../../../frontend/src/${p}`, import.meta.url));

async function loadRules() {
  const ts = (await import("typescript")).default;
  const js = ts.transpileModule(readFileSync(FE("actionFeedback.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return await import(`data:text/javascript,${encodeURIComponent(js)}`);
}

/** Помилка так, як її віддає axios: прапорець, метод запиту, відповідь сервера. */
const axiosErr = (method: string, status?: number, error?: string) => ({
  isAxiosError: true,
  config: { method },
  ...(status == null ? {} : { response: { status, data: error == null ? {} : { error } } }),
});

test("#1101 СТРАХОВКА: невдалий ЗАПИС показує причину сервера; читання, 401, скасоване й не-серверне — мовчать", async () => {
  const { mutationFailureText } = await loadRules();

  // ① Запис, що впав, — повідомлення з причиною, яку назвав сервер.
  for (const m of ["post", "PUT", "patch", "delete"]) {
    const r = mutationFailureText(axiosErr(m, 403, "Немає доступу"));
    assert.ok(r, `${m} 403 мусить дати повідомлення`);
    assert.match(r.text, /«Немає доступу»/, "причина сервера мусить бути в тексті");
    assert.match(r.text, /403/);
  }
  // Без тексту від сервера — однаково повідомлення, з кодом; без відповіді — «немає звʼязку».
  assert.match(mutationFailureText(axiosErr("post", 500))!.text, /500/);
  assert.match(mutationFailureText(axiosErr("post"))!.text, /звʼязку/);

  // ② Дзеркало: чого страховка НЕ показує. Інакше фонові оновлення списків засипали б екран червоним.
  assert.equal(mutationFailureText(axiosErr("get", 500, "впало")), null, "читання (GET) — фонове, мовчить");
  assert.equal(mutationFailureText(axiosErr("post", 401, "Unauthorized")), null, "401 веде на вхід сам");
  assert.equal(mutationFailureText({ ...axiosErr("post"), code: "ERR_CANCELED" }), null, "скасований запит");
  assert.equal(mutationFailureText(new Error("boom")), null, "не-серверна помилка");
  assert.equal(mutationFailureText(undefined), null);
});

test("#1101b СТРАХОВКА ПІДКЛЮЧЕНА: застосунок у <ToastProvider>, і той слухає непіймані помилки через mutationFailureText", () => {
  const main = readFileSync(FE("main.tsx"), "utf8");
  const open = main.indexOf("<ToastProvider>"), app = main.indexOf("<App />"), close = main.indexOf("</ToastProvider>");
  assert.ok(open >= 0 && close >= 0, "main.tsx мусить обгортати застосунок у <ToastProvider>");
  assert.ok(open < app && app < close, "<App /> мусить стояти ВСЕРЕДИНІ <ToastProvider>");

  const toasts = readFileSync(FE("components/Toasts.tsx"), "utf8");
  const at = toasts.indexOf('addEventListener("unhandledrejection"');
  assert.ok(at >= 0, "ToastProvider мусить слухати unhandledrejection — інакше страховки немає");
  // Слухач мусить іти через правило, а не показувати все підряд: знаходимо сам обробник за іменем.
  const handler = toasts.match(/const (\w+) = \(ev: PromiseRejectionEvent\) => \{([\s\S]*?)\n {4}\};/);
  assert.ok(handler, "обробник unhandledrejection не знайдено — перевірка стала б порожньою");
  assert.match(handler![2], /\bmutationFailureText\(ev\.reason\)/, "обробник мусить питати mutationFailureText");
  assert.ok(toasts.includes(`addEventListener("unhandledrejection", ${handler![1]})`), "підписано саме цей обробник");
});

test("#1102 commitOptimistic: при помилці значення ПОВЕРТАЄТЬСЯ і причина передається; при успіху лишається нове", async () => {
  const { commitOptimistic } = await loadRules();
  const run = async (save: () => Promise<unknown>) => {
    let value = "старе"; let error: unknown = null;
    const ok = await commitOptimistic({
      apply: () => { value = "нове"; }, save, revert: () => { value = "старе"; }, onError: (e: unknown) => { error = e; },
    });
    return { ok, value, error };
  };
  const bad = await run(() => Promise.reject(new Error("403")));
  assert.equal(bad.ok, false);
  assert.equal(bad.value, "старе", "незбережене значення не мусить лишатись на екрані");
  assert.equal((bad.error as Error)?.message, "403", "причина мусить дійти до повідомлення");

  const good = await run(() => Promise.resolve());
  assert.equal(good.ok, true);
  assert.equal(good.value, "нове");
  assert.equal(good.error, null);
});

test("#1103 «ВІДХИЛИТИ» ЗВЕРНЕННЯ: «Скасувати» не відхиляє; порожній «OK» — без коментаря; текст — з коментарем", async () => {
  const { rejectNote } = await loadRules();
  assert.deepEqual(rejectNote(null), { reject: false }, "«Скасувати» у вікні коментаря — нічого не робимо");
  assert.deepEqual(rejectNote(""), { reject: true, note: undefined });
  assert.deepEqual(rejectNote("   "), { reject: true, note: undefined });
  assert.deepEqual(rejectNote(" дубль #85 "), { reject: true, note: "дубль #85" });
});

test("#1102b ↩ ТРИ МІСЦЯ «НА ЛЬОТУ» ЙДУТЬ ЧЕРЕЗ commitOptimistic, А НЕ .catch(() => {}): рахунок дебіторки, статус задачі у Звіті, план КВП", () => {
  const sites: [string, string][] = [
    ["pages/dashboard/sections/ReceivablesSection.tsx", "saveReceivableInvoiceNote("],
    ["pages/dashboard/sections/ReportSection.tsx", "updateTask(id, { status })"],
    ["pages/dashboard/sections/KvpReportSection.tsx", "saveKvpPlan(monthSel, { [k]: val })"],
  ];
  for (const [file, call] of sites) {
    const src = readFileSync(FE(file), "utf8");
    const at = src.indexOf(call);
    assert.ok(at >= 0, `🔴 ${file}: виклик «${call}» не знайдено — перевірка стала б порожньою`);
    assert.equal(src.indexOf(call, at + 1), -1, `${file}: «${call}» більше одного — уточни межу`);
    // Межа ЗМІСТОВА: виклик мусить стояти в `save: () => …` усередині commitOptimistic, а не голим.
    const open = src.lastIndexOf("commitOptimistic({", at);
    const close = src.indexOf("});", at);
    assert.ok(open >= 0 && close > at, `🔴 ${file}: «${call}» не всередині commitOptimistic({ … })`);
    assert.match(src.slice(open, at + call.length), /save: \(\) => [^\n]*$/, `🔴 ${file}: «${call}» не є save-кроком`);
    assert.ok(!src.slice(at, close + 3).includes(".catch(() => {})"), `🔴 ${file}: помилку «${call}» знову ковтають`);
  }
});

test("#1104 «ГРАФІК» НАЙМУ: «перенесено» й «позначку знято» — лише коли сервер зберіг; save повертає результат", () => {
  const src = readFileSync(FE("pages/dashboard/sections/HiringSchedule.tsx"), "utf8");
  const save = src.slice(src.indexOf("const save = async"), src.indexOf("const nextTime ="));
  assert.ok(save.length > 0, "тіло save не знайдено — перевірка стала б порожньою");
  assert.match(save, /return true;\s*\n\s*\} catch \(e\) \{[^\n]*return false; \}/, "🔴 save мусить казати «вдалось / ні»");
  for (const [name, from, to] of [["move", "const move = async", "const remove = async"], ["clearMark", "const clearMark = async", "const undoStatus = async"]] as const) {
    const body = src.slice(src.indexOf(from), src.indexOf(to));
    assert.ok(body.length > 0, `тіло ${name} не знайдено`);
    const guard = body.search(/if \(!\(await save\(r, /);
    const firstToast = body.indexOf("toast(");
    assert.ok(guard >= 0, `🔴 ${name}: немає перевірки результату save — успіх покажеться поверх помилки`);
    assert.ok(firstToast < 0 || guard < firstToast, `🔴 ${name}: повідомлення про успіх стоїть ДО перевірки save`);
  }
});

test("#1105 «ДОКУМЕНТИ»: помилки йдуть червоним (failToast / error: true), а не зеленим, як успіх", () => {
  const src = readFileSync(FE("pages/dashboard/sections/DocumentsSection.tsx"), "utf8");
  assert.ok(src.includes("useToast()"), "🔴 «Документи» не на спільному повідомленні");
  assert.ok(!/var\(--ok-bg\)[^\n]*role="status"|role="status"[^\n]*var\(--ok-bg\)/.test(src), "🔴 повернулось власне зелене повідомлення");
  // Будь-яке повідомлення з причиною від сервера (`errOf(`) мусить бути помилкою.
  const lines = src.split("\n");
  const green = lines.map((l, i) => [i + 1, l] as const)
    .filter(([, l]) => /\b(setToast|onToast)\(errOf\(/.test(l) && !/error: true/.test(l));
  assert.deepEqual(green.map(([n]) => n), [], `🔴 помилка зеленим у рядках: ${green.map(([n]) => n).join(", ")}`);
  assert.ok((src.match(/\bfailToast\(e, /g) ?? []).length >= 15, "🔴 помилки перестали йти через failToast — перевір, куди вони поділись");
});

test("#1106 ВІКНА РЕАКТИВАЦІЇ («＋ Задача», «＋ Контакт», «Закрити»): відмову сервера видно ВСЕРЕДИНІ вікна", () => {
  const bits = readFileSync(FE("pages/dashboard/sections/ReactivationBits.tsx"), "utf8");
  const modal = bits.slice(bits.indexOf("export function Modal("), bits.indexOf("export function CreateTaskDialog("));
  assert.match(modal, /\{error && \(\s*<div role="alert"/, "🔴 Modal не показує помилку");
  for (const t of ["＋ Задача реактивації", "Закрити задачу", "📱 Контакт"])
    assert.match(bits, new RegExp(`<Modal title=\\{\`${t}[^\`]*\`\\} error=\\{error\\}>`), `🔴 вікно «${t}» не передає error у Modal`);
  const plans = readFileSync(FE("pages/dashboard/sections/ClientPlansSection.tsx"), "utf8");
  for (const d of ["<CreateTaskDialog", "<ContactDialog", "<CloseTaskDialog"]) {
    const at = plans.indexOf(d);
    assert.ok(at >= 0, `${d} не знайдено`);
    assert.ok(plans.slice(at, plans.indexOf("\n", at)).includes("error={actErr}"), `🔴 ${d} не отримує actErr — помилка знову піде під вікно`);
  }
});
