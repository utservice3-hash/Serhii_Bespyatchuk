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
