import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ✅ #9229–#9229c — «ПОГОДЖУЮ» ДЛЯ ТІМЛІДА В «ПЕРШИЙ ДОТИК» (задача 9229, 18.11.2026).
 *
 * Андрій на РНК 12.11: менеджери пояснюють, чому не назвали ціну, а погодити він не може — кнопки немає. Заміряно на
 * проді 18.11 (команда Безпамʼятного, 04–18.11, 63 розмови в розборі): кнопка БУЛА — у черзі й картці, — але не в
 * списку розмов, де тімлід дивиться; 21 розмова з коментарем менеджера чекала погодження. Ще 15 коментарів у поле
 * «Коментар менеджера» вписав сам тімлід — за правилом 7351 їх погодити не можна, а на місці кнопки стояло «Чекає
 * коментаря менеджера», хоча коментар видно вище.
 *
 * Правило стану кнопки — чиста функція фронту `approveState` (`aiCallsView.ts`); гейт її ТРАНСПІЛЮЄ Й ВИКОНУЄ (прийом
 * `clientLeadNav9225`). `#9229c` звіряє джерело: функція нічого не варта, якщо котресь із трьох місць тримає власну умову.
 */

const FE = (rel: string): string => fileURLToPath(new URL(`../../../frontend/src/pages/dashboard/${rel}`, import.meta.url));
const SRC = (rel: string): string => readFileSync(path.join(import.meta.dirname, "..", "..", "src", rel), "utf8");

type Note = { byName: string | null } | null;
type Row = { needsReview: boolean; managerCommented: boolean; explainNote?: Note; priceNote?: Note };
type State = { kind: "can" } | { kind: "wait" } | { kind: "notManager"; author: string };
interface ViewMod {
  approveState: (r: Row, canReview: boolean) => State | null;
  approveWaitText: (s: State) => string | null;
  APPROVE_LABEL_UA: string;
  WAIT_MANAGER_COMMENT_UA: string;
}

async function loadView(): Promise<ViewMod> {
  const ts = (await import("typescript")).default;
  const tr = (rel: string) => ts.transpileModule(readFileSync(FE(rel), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const period = `data:text/javascript,${encodeURIComponent(tr("periodRules.ts"))}`;
  const view = tr("aiCallsView.ts").split('from "./periodRules"').join(`from "${period}"`);
  return await import(`data:text/javascript,${encodeURIComponent(view)}`) as ViewMod;
}

const MGR: Note = { byName: "Бердишев Максим" };
const TL: Note = { byName: "bao@uts.ua" };

test("#9229 СТАН «ПОГОДЖУЮ»: коментар менеджера → кнопка; вписав інший → названо хто; без коментаря → чекає", async () => {
  const V = await loadView();
  assert.equal(V.APPROVE_LABEL_UA, "Погоджую");
  // ① Менеджер написав сам (будь-який із двох видів коментаря) — кнопка.
  assert.deepEqual(V.approveState({ needsReview: true, managerCommented: true, explainNote: MGR, priceNote: null }, true), { kind: "can" });
  assert.deepEqual(V.approveState({ needsReview: true, managerCommented: true, explainNote: null, priceNote: MGR }, true), { kind: "can" },
    "🔴 коментар менеджера в «Чому не озвучено ціну» не дає кнопки");
  // ② Коментар є, але не з акаунта менеджера розмови — кнопки НЕМАЄ (правило 7351), а підпис називає автора.
  const tl = V.approveState({ needsReview: true, managerCommented: false, explainNote: TL, priceNote: TL }, true);
  assert.deepEqual(tl, { kind: "notManager", author: "bao@uts.ua" }, "🔴 коментар тімліда дає кнопку або не називає автора");
  assert.deepEqual(V.approveState({ needsReview: true, managerCommented: false, explainNote: null, priceNote: TL }, true),
    { kind: "notManager", author: "bao@uts.ua" }, "🔴 коментар лише в «Чому не озвучено ціну» від тімліда не впізнано");
  const tlText = V.approveWaitText(tl!);
  assert.ok(tlText && tlText.includes("bao@uts.ua") && tlText !== V.WAIT_MANAGER_COMMENT_UA, "🔴 підпис не каже, хто вписав коментар");
  // Невідомий автор не показується порожнім (правило фронту «невідоме читається як невідоме»).
  assert.deepEqual(V.approveState({ needsReview: true, managerCommented: false, explainNote: { byName: null }, priceNote: null }, true),
    { kind: "notManager", author: "невідомий акаунт" });
  // ③ Коментаря немає — старий підпис «Чекає коментаря менеджера».
  const wait = V.approveState({ needsReview: true, managerCommented: false, explainNote: null, priceNote: null }, true);
  assert.deepEqual(wait, { kind: "wait" });
  assert.equal(V.approveWaitText(wait!), V.WAIT_MANAGER_COMMENT_UA);
  assert.equal(V.approveWaitText({ kind: "can" }), null, "🔴 на місці кнопки ще й підпис очікування");
});

test("#9229b ДЗЕРКАЛО: без права розбору чи поза чергою — ні кнопки, ні підпису; з правом і коментарем менеджера — кнопка", async () => {
  const V = await loadView();
  const ok: Row = { needsReview: true, managerCommented: true, explainNote: MGR, priceNote: null };
  assert.equal(V.approveState(ok, false), null, "🔴 «Погоджую» бачить роль без права розбору (менеджер)");
  assert.equal(V.approveState({ ...ok, needsReview: false }, true), null, "🔴 «Погоджую» на розмові, що вже не в черзі");
  assert.equal(V.approveState({ ...ok, managerCommented: false, explainNote: TL }, false), null);
  // Дзеркало: правило не «ріже всім» — з правом і коментарем менеджера кнопка є.
  assert.deepEqual(V.approveState(ok, true), { kind: "can" }, "🔴 кнопки немає навіть з правом і коментарем менеджера");
});

test("#9229c ОДНЕ ПРАВИЛО НА ТРИ МІСЦЯ: список, черга й картка — через approveState; сервер відмовляє без коментаря менеджера", () => {
  // Сервер — остання межа: кнопка лише підказка, обійти правило повз неї не можна.
  const dash = SRC("routes/dashboard.ts");
  assert.match(dash, /if \(kind === "review" && text\.trim\(\) && !canCloseReview\(card\.row\)\) \{ res\.status\(409\)\.json\(\{ error: REVIEW_NEEDS_COMMENT_UA \}\); return; \}\s*const who =/,
    "🔴 сервер ставить «Розібрано» без коментаря менеджера (або перевірка після запису)");
  assert.match(dash, /explainNote: r\.explainNote, managerCommented: r\.managerCommented,/, "🔴 список не віддає фронту, чи писав менеджер");

  const sec = readFileSync(FE("sections/AiCallsSection.tsx"), "utf8");
  const dr = readFileSync(FE("sections/AiCallDrawer.tsx"), "utf8");
  const qx = readFileSync(FE("sections/FirstTouchQueue.tsx"), "utf8");
  // Список: стан — з approveState і з правом сервера, кнопка — лише в стані «can», клітинка — у колонці «Розбір».
  assert.match(sec, /const ap = approveState\(r, d\.canReview\);/, "🔴 список рахує стан кнопки власною умовою");
  assert.match(sec, /\{ap\?\.kind === "can" && <div[^>]*><ApproveButton uniqueid=\{r\.uniqueid\} onDone=\{\(\) => setReload\(/, "🔴 «Погоджую» в списку не за станом «can» або не перечитує екран");
  assert.match(sec, /: r\.needsReview \? reviewTodoCell\(r\)/, "🔴 клітинка «Розбір» не кличе правило");
  // Картка й черга: та сама функція; кнопка — лише в «can», інакше — чесний підпис.
  assert.match(dr, /const ap = approveState\(\{ \.\.\.c\.row, needsReview: c\.needsReview \}, c\.canReview\);/, "🔴 картка рахує стан власною умовою");
  assert.match(dr, /\{ap\.kind === "can"\s*\? <button[^>]*onClick=\{\(\) => void go\(\)\}[\s\S]{0,200}: <span[^>]*>\{approveWaitText\(ap\)\}<\/span>\}/, "🔴 кнопка в картці не за станом");
  assert.match(qx, /const ap = cur \? approveState\(cur, true\) : null;/, "🔴 черга рахує стан власною умовою");
  assert.match(qx, /\{ap\?\.kind === "can"\s*\? <button[^>]*onClick=\{\(\) => void review\(\)\}[\s\S]{0,200}: ap && <span[^>]*>\{approveWaitText\(ap\)\}<\/span>\}/, "🔴 кнопка в черзі не за станом");
  // Жодне з трьох місць не тримає старої власної умови на `managerCommented`.
  for (const [name, src] of [["список", sec], ["картка", dr], ["черга", qx]] as const) {
    assert.ok(!/managerCommented\s*\?\s*<button/.test(src), `🔴 ${name}: кнопка знову за власною умовою managerCommented`);
  }
  // Кнопка в списку пише те саме, що черга й картка, і не відкриває картку рядка.
  assert.match(dr, /export function ApproveButton[\s\S]{0,400}e\.stopPropagation\(\);[\s\S]{0,120}putAiCallNote\(uniqueid, "review", reviewNoteText\(true\)\)/,
    "🔴 «Погоджую» в списку пише інше або відкриває картку");
});
