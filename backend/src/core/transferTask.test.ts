import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transferTaskVerdict, transferTaskRow, transferTaskRequired, TRANSFER_TASK_PREFIX } from "./transferTask.js";

const SRC = (rel: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "src", rel), "utf8");
const TODAY = "2026-10-08";

/**
 * #1499 — ЗАДАЧА ПРИ ПЕРЕДАЧІ КЛІЄНТА: правила по обидва боки кожної межі (Роман 08.10.2026, «так, як пропонуєш»).
 *  · «передача» без задачі — відмова; «виправлення» без задачі — можна;
 *  · порожній текст, без дедлайну, неіснуюча дата, дедлайн учора — відмова; сьогодні — можна;
 *  · пріоритет за замовчуванням «звичайний», «додатково» — за потреби;
 *  · у задачі не губиться ні повний текст, ні «додатково», ні причина передачі.
 * 🧨 Червоніє, якщо пропустити «передачу» без задачі, порожній текст чи дедлайн у минулому.
 */
test("#1499 задача при передачі: обовʼязкова при «передачі», за бажанням при «виправленні»; текст і дедлайн — обовʼязкові", () => {
  assert.equal(transferTaskRequired("transfer"), true);
  assert.equal(transferTaskRequired("fix"), false);
  assert.equal(transferTaskVerdict(null, "transfer", TODAY).ok, false, "🔴 передачу пропущено без задачі");
  assert.deepEqual(transferTaskVerdict(undefined, "fix", TODAY), { ok: true, task: null }, "🔴 виправлення вимагає задачу");
  const bad = (raw: unknown) => transferTaskVerdict(raw, "transfer", TODAY).ok;
  assert.equal(bad({ text: "   ", deadline: TODAY }), false, "🔴 порожній текст пройшов");
  assert.equal(bad({ text: "Подзвонити", deadline: "" }), false, "🔴 без дедлайну пройшло");
  assert.equal(bad({ text: "Подзвонити", deadline: "2026-10-07" }), false, "🔴 дедлайн у минулому пройшов");
  assert.equal(bad({ text: "Подзвонити", deadline: "2026-02-30" }), false, "🔴 неіснуюча дата пройшла — впала б уже в БД");
  assert.equal(bad({ text: "Подзвонити", deadline: TODAY, priority: "urgent" }), false, "🔴 невідомий пріоритет пройшов");
  const ok = transferTaskVerdict({ text: " Подзвонити Ірині \n і надіслати КП ", deadline: TODAY }, "transfer", TODAY);
  assert.ok(ok.ok && ok.task, "🔴 нормальна задача відхилена");
  if (!ok.ok || !ok.task) return;
  assert.deepEqual([ok.task.priority, ok.task.details], ["medium", null], "🔴 дефолти пріоритету чи «додатково» не ті");
  const row = transferTaskRow({ task: { ...ok.task, details: "ціна 28 грн/км" }, clientName: "ТОВ Агро", reason: "перерозподіл", kind: "transfer" });
  assert.equal(row.title, `${TRANSFER_TASK_PREFIX} ТОВ Агро: Подзвонити Ірині`, "🔴 назва задачі — не префікс + клієнт + перший рядок");
  for (const part of ["і надіслати КП", "Додатково: ціна 28 грн/км", "Причина передачі: перерозподіл"]) {
    assert.ok(row.comments.includes(part), `🔴 у задачі загубилось: «${part}»`);
  }
  const long = transferTaskRow({ task: { text: "а".repeat(500), deadline: TODAY, priority: "high", details: null }, clientName: "К", reason: "р", kind: "fix" });
  assert.ok(long.title.length < 170 && long.title.endsWith("…"), "🔴 довгий текст не скорочено в назві");
  assert.ok(long.comments.startsWith("а".repeat(500)), "🔴 повний текст загубився");
});

let ctxP: Promise<{ c: import("pg").Client } | { unavailable: string }> | null = null;
let dispose: (() => Promise<void>) | null = null;
after(async () => { if (dispose) await dispose(); });
async function ctx(t: { skip: (m: string) => void }) {
  ctxP ??= (async () => {
    const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
    const s = provisionScratch();
    if ("unavailable" in s) return { unavailable: skipReason(s) };
    const { default: pg } = await import("pg");
    const c = new pg.Client({ connectionString: s.url });
    await c.connect();
    await c.query(SRC("db/schema.sql"));
    await c.query("INSERT INTO teams(id,name) VALUES (9901,'РПК-Тест')");
    await c.query("INSERT INTO managers(id,name,team_id) VALUES (99011,'Старий Менеджер',9901),(99012,'Новий Менеджер',9901)");
    await c.query("INSERT INTO users(id,email,password_hash,role,team_id) VALUES (99001,'lead@t','x','team_lead',9901)");
    await c.query(`INSERT INTO deals(kommo_id,name,pipeline_id,status_id,created_at_kommo,client_key,client_name)
      VALUES (990001,'D1',8921932,142,'2026-09-01 10:00:00+03','агролайн','ТОВ «Агро-Лайн»')`);
    dispose = async () => { await c.end().catch(() => {}); s.dispose(); };
    return { c };
  })();
  const r = await ctxP;
  if ("unavailable" in r) { t.skip(r.unavailable); return null; }
  return r.c;
}

/**
 * #1499b — ЖИВА СХЕМА: передача й задача — ОДНА ТРАНЗАКЦІЯ.
 *  · передача з задачею → закріплення + 1 рядок історії + 1 задача (виконавець — новий менеджер, автор і «Приймає» —
 *    тімлід, привʼязка до клієнта, відділ — команда менеджера, назва з префіксом і назвою клієнта);
 *  · задача, що не лягає в БД (неіснуюча дата в обхід перевірки), → НІЧОГО не записано: ні закріплення, ні історії;
 *  · виправлення без задачі → передача є, задачі немає.
 * 🧨 Червоніє, якщо розірвати транзакцію (передача пройде без задачі) чи переплутати автора/виконавця.
 */
test("#1499b ЖИВА СХЕМА: передача клієнта й задача новому менеджеру — разом або нічого", async (t) => {
  const c = await ctx(t); if (!c) return;
  const { applyClientTransfer } = await import("./clientTransfer.js");
  const counts = async () => (await c.query<{ o: number; h: number; t: number }>(`SELECT
      (SELECT count(*)::int FROM loyalty_overrides WHERE client_key='агролайн' AND pinned_manager_id IS NOT NULL) AS o,
      (SELECT count(*)::int FROM client_manager_history WHERE client_key='агролайн') AS h,
      (SELECT count(*)::int FROM tasks WHERE client_key='агролайн') AS t`)).rows[0];

  await assert.rejects(applyClientTransfer(c, { clientKey: "агролайн", toManagerId: 99012, reason: "перерозподіл", kind: "transfer",
    effectiveFrom: "2026-11-01", userId: 99001, task: { text: "Подзвонити", deadline: "2026-02-30", priority: "medium", details: null } }),
  "🔴 задача з неіснуючою датою записалась");
  assert.deepEqual(await counts(), { o: 0, h: 0, t: 0 }, "🔴 впала задача — а передача лишилась: транзакцію розірвано");

  const r = await applyClientTransfer(c, { clientKey: "агролайн", toManagerId: 99012, reason: "перерозподіл", kind: "transfer",
    effectiveFrom: "2026-11-01", userId: 99001, task: { text: "Подзвонити Ірині\nі надіслати КП", deadline: "2026-10-10", priority: "high", details: "ціна 28 грн/км" } });
  assert.ok(r.taskId, "🔴 задача не створилась");
  assert.deepEqual(await counts(), { o: 1, h: 1, t: 1 }, "🔴 передача з задачею записала не по одному рядку");
  const task = (await c.query<{ title: string; assignee_id: number; created_by: number; reviewer_id: number; department: string; priority: string; deadline: string; status: string; comments: string }>(
    `SELECT title, assignee_id, created_by, reviewer_id, department, priority, to_char(deadline,'YYYY-MM-DD') AS deadline, status, comments FROM tasks WHERE id = $1`, [r.taskId])).rows[0];
  assert.deepEqual([task.assignee_id, task.created_by, task.reviewer_id], [99012, 99001, 99001], "🔴 виконавець / автор / «Приймає» переплутано");
  assert.deepEqual([task.department, task.priority, task.deadline, task.status], ["РПК-Тест", "high", "2026-10-10", "not_started"]);
  assert.equal(task.title, `${TRANSFER_TASK_PREFIX} ТОВ «Агро-Лайн»: Подзвонити Ірині`, "🔴 назва задачі без клієнта чи префікса");
  assert.ok(task.comments.includes("Причина передачі: перерозподіл") && task.comments.includes("ціна 28 грн/км"), "🔴 причина чи «додатково» загубились");

  const f = await applyClientTransfer(c, { clientKey: "агролайн", toManagerId: 99011, reason: "помилка синку", kind: "fix",
    effectiveFrom: "2026-10-01", userId: 99001, task: null });
  assert.equal(f.taskId, null);
  assert.equal(f.from, 99012, "🔴 «від кого» в історії не той");
  assert.deepEqual(await counts(), { o: 1, h: 2, t: 1 }, "🔴 виправлення без задачі створило задачу або не записало історію");
});

const FE = (rel: string): string => fileURLToPath(new URL(`../../../frontend/src/${rel}`, import.meta.url));
interface KnownT { status: string; closeReason: string | null }
interface ClientNotifyMod {
  CLIENT_TASK_PREFIX: string; SIGNAL_CLOCK_SKEW_MS: number;
  isClientTaskAlert: (t: { id: number; title: string; status: string; assigneeId?: number | null; createdAt?: string | null },
    known: ReadonlyMap<number, KnownT> | null, me: number | null | undefined, mountedAtMs: number) => boolean;
  clientTaskAlertText: (titles: string[]) => string | null;
}
async function loadFe<T>(rel: string): Promise<T> {
  const ts = (await import("typescript")).default;
  const js = ts.transpileModule(readFileSync(FE(rel), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return await import(`data:text/javascript,${encodeURIComponent(js)}`) as T;
}

/**
 * #1499c — МЕНЕДЖЕР БАЧИТЬ НОВУ ЗАДАЧУ ПО КЛІЄНТУ ОДРАЗУ. Звичайна нова задача приходить мовчки; задача при передачі —
 * сповіщенням. Префікс фронту == бекенду (інакше сповіщення замовкне тихо), і правило по обидва боки:
 * нова моя — так; уже відома, чужа, закрита, без префікса, адміну без менеджера — ні; до першого опитування — лише свіжі.
 * 🧨 Червоніє, якщо розвести префікси або дзвонити на кожному опитуванні.
 */
test("#1499c сповіщення про нову задачу по переданому клієнту: префікс фронту == бекенду, лише нова й своя", async () => {
  const N = await loadFe<ClientNotifyMod>("pages/dashboard/signalTaskNotify.ts");
  assert.equal(N.CLIENT_TASK_PREFIX, TRANSFER_TASK_PREFIX, "🔴 префікс фронту розійшовся з бекендом — сповіщення замовкне тихо");
  const MOUNT = Date.parse("2026-10-08T10:00:00Z");
  const t = (id: number, over: Partial<{ title: string; status: string; assigneeId: number | null; createdAt: string }> = {}) =>
    ({ id, title: `${TRANSFER_TASK_PREFIX} ТОВ Агро: Подзвонити`, status: "not_started", assigneeId: 7, createdAt: "2026-10-08T09:00:00Z", ...over });
  const known = new Map<number, KnownT>([[1, { status: "not_started", closeReason: null }]]);
  assert.equal(N.isClientTaskAlert(t(9), known, 7, MOUNT), true, "🔴 нова задача по клієнту прийшла мовчки");
  assert.equal(N.isClientTaskAlert(t(1), known, 7, MOUNT), false, "🔴 відома задача дзвонить на кожному опитуванні");
  assert.equal(N.isClientTaskAlert(t(9), known, 8, MOUNT), false, "🔴 дзвонить чужому менеджеру");
  assert.equal(N.isClientTaskAlert(t(9), known, null, MOUNT), false, "🔴 дзвонить акаунту без менеджера");
  assert.equal(N.isClientTaskAlert(t(9, { status: "done" }), known, 7, MOUNT), false, "🔴 дзвонить закрита задача");
  assert.equal(N.isClientTaskAlert(t(9, { title: "Звичайна задача" }), known, 7, MOUNT), false, "🔴 дзвонить будь-яка нова задача");
  assert.equal(N.isClientTaskAlert(t(9, { createdAt: "2026-10-08T10:05:00Z" }), null, 7, MOUNT), true, "🔴 свіжа задача до першого опитування — мовчки");
  assert.equal(N.isClientTaskAlert(t(9, { createdAt: "2026-10-08T07:00:00Z" }), null, 7, MOUNT), false, "🔴 кожне відкриття сторінки дзвонить старими задачами");
  assert.equal(N.clientTaskAlertText([`${TRANSFER_TASK_PREFIX} ТОВ Агро: Подзвонити`]), "ТОВ Агро: Подзвонити — задача в Задачнику.");
  assert.match(N.clientTaskAlertText(["a", "b"]) ?? "", /^2 нові задачі/);
  const dash = readFileSync(FE("pages/Dashboard.tsx"), "utf8");
  assert.match(dash, /fresh\.filter\(\(t\) => isClientTaskAlert\(t, known, auth\?\.managerId, mountedAt\.current\)\)/, "🔴 Dashboard не кличе правило сповіщення");
  assert.ok(dash.indexOf("isClientTaskAlert(t, known") < dash.indexOf("signalKnown.current = new Map(fresh"), "🔴 базову лінію оновлено ДО перевірки — нова задача вже «відома» і мовчить");
});

/**
 * #1499d — ФОРМА ПЕРЕДАЧІ: при «передачі» блок задачі завжди, при «виправленні» — галочкою; текст уже заповнений готовим
 * (Роман 08.10: «дефолтний текст, якщо тімлід не хоче міняти»), дедлайн — наступний робочий день; кнопка неактивна без тексту
 * чи дедлайну; задача їде в тому самому запиті, що й передача.
 * 🧨 Червоніє, якщо прибрати обовʼязковість на «передачі», зняти блокування кнопки чи готовий текст.
 */
test("#1499d форма передачі: задача з готовим текстом, обовʼязкова при «передачі», кнопка без тексту чи дедлайну неактивна", () => {
  const f = readFileSync(FE("pages/dashboard/sections/ClientAdminPanels.tsx"), "utf8");
  assert.match(f, /const taskOn = kind === "transfer" \|\| taskWanted;/, "🔴 при «передачі» блок задачі не обовʼязковий");
  assert.match(f, /useState\(\(\) => defaultTransferTaskText\(clientName\)\)/, "🔴 текст задачі не заповнений готовим");
  assert.match(f, /useState\(\(\) => nextWorkingDay\(\)\)/, "🔴 дедлайн за замовчуванням не наступний робочий день");
  assert.match(f, /const taskMissing = taskOn && \(!taskText\.trim\(\) \|\| !taskDeadline\);/, "🔴 немає перевірки тексту й дедлайну");
  assert.match(f, /disabled=\{busy \|\| !clientKey \|\| !managerId \|\| !reason\.trim\(\) \|\| taskMissing\}/, "🔴 кнопка активна без задачі");
  assert.match(f, /\.\.\.\(taskOn \? \{ task: \{ text: taskText\.trim\(\), deadline: taskDeadline, priority: taskPriority, details: taskDetails\.trim\(\) \} \} : \{\}\)/,
    "🔴 задача не їде в тому самому запиті, що й передача");
  const def = f.match(/`Звʼязатися з клієнтом \$\{clientName\}: ([^`]+)`/);
  assert.ok(def && /узгодити наступний крок/.test(f), "🔴 готовий текст не дія з результатом");
});
