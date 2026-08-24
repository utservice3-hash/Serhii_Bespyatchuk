import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { needsDb } from "../testMode.js";

/** Тести біжать із `dist`, а звіряти треба ДЖЕРЕЛО — приймач як у сусідніх гейтах. */
const srcOf = (rel: string) => fileURLToPath(new URL(rel, import.meta.url).href.replace("/dist/", "/src/"));
const FE = (rel: string) => srcOf(`../../../frontend/src/${rel}`);

const handler = async (path: string) => {
  const { dashboardRouter } = await import("../routes/dashboard.js");
  const layer = (dashboardRouter as unknown as { stack: { route?: { path: string; methods: Record<string, boolean>;
    stack: { handle: (req: unknown, res: unknown, next: (e?: unknown) => void) => void }[] } }[] })
    .stack.find((l) => l.route?.path === path && l.route.methods.get);
  assert.ok(layer?.route, `🔴 роут ${path} не знайдено`);
  return layer!.route!.stack[layer!.route!.stack.length - 1].handle;
};
type Auth = { role: string; roleKey: string; managerId: number | null; teamId: number | null; userId: number };
const call = (h: Awaited<ReturnType<typeof handler>>, auth: Auth) =>
  new Promise<any>((ok, bad) => {
    const res = { json(b: unknown) { ok(b); }, status() { return this; }, send(b: unknown) { ok(b); }, setHeader() {} };
    try { h({ auth, query: {}, params: {} }, res, (e?: unknown) => bad(e ?? new Error("next()"))); } catch (e) { bad(e); }
  });
const as = (roleKey: string, role = "company"): Auth =>
  ({ role, roleKey, managerId: null, teamId: null, userId: 0 });

/**
 * #159 — ПРАВО НА ДІЮ РАХУЄ СЕРВЕР ТИМИ САМИМИ ВИРАЗАМИ, ЩО ГЕЙТЯТЬ РОУТИ.
 *
 * Не «схожими» — тими самими. Фронт свого правила не має, тож якщо ці два
 * поля розійдуться з гейтами роутів, екран покаже кнопку, яка дасть 403 (або
 * сховає ту, що працює), і ніхто цього не побачить, поки не натисне.
 */
test("#159 canSetOwner/canMerge == предикати, що гейтять роути", needsDb(), async () => {
  const { isAdminScope, roleHasPerm, refreshRoles, rolesCacheSize } = await import("../auth/rbac.js");
  // 🔴 РОЛЬ-КЕШ ЗАВАНТАЖУЄМО ЯВНО — і ПЕРЕВІРЯЄМО, що завантажився.
  //
  // Без цього гейт зеленів на ДВОХ fail-closed відповідях: і роут, і предикат
  // повертали `false`, бо кеш порожній, і рівність «false == false» виглядала
  // як «сходиться». Це рівно та пастка, через яку golden-master колись дав
  // «403 / 403 → 0 розбіжностей». Спіймано першим же прогоном проти прода.
  await refreshRoles();
  assert.ok(rolesCacheSize() > 0,
    "🔴 роль-кеш порожній — усі предикати fail-closed, і гейт порівнював би дві відмови");
  const h = await handler("/receivables");
  for (const roleKey of ["admin", "kvp", "opdir", "ceo", "financier", "hr", "manager", "team_lead"]) {
    const auth = as(roleKey, roleKey === "manager" ? "manager" : roleKey === "team_lead" ? "team_lead" : "company");
    const body = await call(h, auth);
    assert.equal(body.canSetOwner, isAdminScope(auth as never),
      `🔴 «${roleKey}»: canSetOwner=${body.canSetOwner}, а isAdminScope=${isAdminScope(auth as never)}`);
    assert.equal(body.canMerge, roleHasPerm(roleKey, "merge_receivables"),
      `🔴 «${roleKey}»: canMerge=${body.canMerge}, а право = ${roleHasPerm(roleKey, "merge_receivables")}`);
  }
});

/**
 * #159b — ДЗЕРКАЛО, І ВОНО ФІКСУЄ ОЧІКУВАНУ ДИВИНУ.
 *
 * 🔴 ФІНАНСИСТ МАЄ `canSetOwner = true`, І ЦЕ НЕ ДІРА. Рішення власника
 * 31.07.2026 підняло фінансиста до рівня адміна (`admin_scope`), а
 * `isAdminScope` читає саме його; підтверджено власником окремо 24.08.2026.
 * Записано ГЕЙТОМ, а не коментарем, саме тому, що наступний, хто це побачить,
 * визнає дірою й «полагодить» — і мовчки скасує рішення власника.
 * Слід лишається: override без примітки не приймає ні роут, ні `CHECK` у БД.
 *
 * Склейки у фінансиста НЕМАЄ — `merge_receivables` він не має, і це теж тут.
 */
test("#159b ФІНАНСИСТ: зміна відповідального Є, склейки НЕМАЄ — очікувано", needsDb(), async () => {
  const { refreshRoles, rolesCacheSize } = await import("../auth/rbac.js");
  await refreshRoles();
  assert.ok(rolesCacheSize() > 0, "🔴 роль-кеш порожній — відповідь про право була б fail-closed, а не справжня");
  const h = await handler("/receivables");
  const fin = await call(h, as("financier"));
  assert.equal(fin.canSetOwner, true,
    "🔴 фінансист втратив зміну відповідального — це скасовує рішення власника 31.07.2026 про рівень адміна");
  assert.equal(fin.canMerge, false, "🔴 фінансистові дісталась склейка — цього рішення власник НЕ ухвалював");

  for (const roleKey of ["manager", "team_lead"]) {
    const b = await call(h, as(roleKey, roleKey));
    assert.equal(b.canSetOwner, false, `🔴 «${roleKey}» дістав зміну відповідального`);
    assert.equal(b.canMerge, false, `🔴 «${roleKey}» дістав склейку`);
  }
  // 🪞 І дзеркало до дзеркала: хтось права МАЄ, інакше «нікому не можна» теж було б зелене.
  const kvp = await call(h, as("kvp"));
  assert.ok(kvp.canSetOwner && kvp.canMerge, "🔴 у КВП немає ЖОДНОГО права — гейт вироджений");
});

/**
 * #159c — СЕО МАЄ `merge_clients`, тобто може ВІДКОТИТИ те, що зліпив.
 * Рішення власника 24.08.2026. Без цього права склейка для СЕО була б
 * односторонніми дверима: `/client-merge/revoke` гейтиться `merge_clients`
 * через `mergePairScope`, а тімлідом СЕО не є.
 */
test("#159c СЕО може і зліпити, і роз'єднати — двері не односторонні", needsDb(), async () => {
  const { refreshRoles, rolesCacheSize } = await import("../auth/rbac.js");
  await refreshRoles();
  assert.ok(rolesCacheSize() > 0, "🔴 роль-кеш порожній — відповідь про право була б fail-closed, а не справжня");
  const { roleHasPerm } = await import("../auth/rbac.js");
  assert.equal(roleHasPerm("ceo", "merge_receivables"), true, "🔴 у СЕО немає склейки");
  assert.equal(roleHasPerm("ceo", "merge_clients"), true,
    "🔴 СЕО може зліпити, але не може роз'єднати — односторонні двері, які власник закрив 24.08.2026");
  // 🪞 Дзеркало: право не роздали ВСІМ (інакше assert вище був би беззмістовний).
  assert.equal(roleHasPerm("manager", "merge_clients"), false, "🔴 `merge_clients` дістався менеджеру");
});

/** #160 — фронт не малює контрол без права: умова стоїть у джерелі. */
test("#160 кнопок немає БЕЗ ПРАВА — це умова у фронті, а не 403 після кліку", () => {
  const src = readFileSync(FE("pages/dashboard/sections/ReceivablesSection.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.match(src, /\{canSetOwner\s*&&/, "🔴 контрол відповідального малюється без перевірки canSetOwner");
  assert.match(src, /\{canMerge\s*&&/, "🔴 кнопка склейки малюється без перевірки canMerge");
  // Фронт НЕ має власного правила про ролі — інакше воно розійдеться з сервером.
  assert.doesNotMatch(src, /roleKey\s*===|role\s*===\s*["']admin["']/,
    "🔴 у секції зʼявилось власне правило про ролі — право віддає СЕРВЕР");
});

// ───────────────────── ЧИСТІ ПРАВИЛА ЕКРАНА ─────────────────────
// Імпортуються з фронтового модуля: правило одне, а не «схоже» по обидва боки.

/**
 * #161 — ПОРОЖНЯ ПРИМІТКА НЕ ДОХОДИТЬ ДО МЕРЕЖІ.
 *
 * Рубежів три: кнопка → 400 роуту → `CHECK` у БД. Цей гейт про ПЕРШИЙ: людина
 * мусить побачити зрозумілу вимогу, а не помилку з мережі. Умова та сама, що на
 * сервері (`btrim(note) <> ''`), тож пробіли теж не проходять.
 */
test("#161 примітка обовʼязкова ДО відправки, і пробіли не рахуються", () => {
  const src = readFileSync(FE("pages/dashboard/receivablesView.ts"), "utf8");
  assert.match(src, /noteIsValid\s*=\s*\(note: string\)/, "🔴 правила валідації примітки немає");
  // Пробіли — не примітка. Саме на них ловиться «начебто заповнено».
  assert.match(src, /note\.trim\(\)\.length\s*>\s*0/,
    "🔴 примітка перевіряється без trim — рядок із пробілів пройшов би фронт і впав на CHECK");

  const ed = readFileSync(FE("pages/dashboard/sections/OwnerEditor.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  // Кнопки запису мусять бути ЗАБЛОКОВАНІ без примітки — обидві, що пишуть override.
  const writes = [...ed.matchAll(/disabled=\{busy \|\| !noteOk[^}]*\}/g)];
  assert.ok(writes.length >= 2,
    `🔴 лише ${writes.length} кнопок записи заблоковані без примітки — має бути 2 («Призначити» і «Свідомо нікого»)`);
  // 🪞 Дзеркало: «Зняти призначення» примітки НЕ вимагає (це DELETE, у нього її немає),
  // інакше гейт зеленів би й від того, що ми заблокували геть усе.
  assert.match(ed, /clearReceivableOwner/, "🔴 дії «зняти призначення» немає взагалі");
});

/**
 * #162 — ТРИ СТАНИ ВІДПОВІДАЛЬНОГО, І ВОНИ РІЗНІ НА ЕКРАНІ.
 *
 * «Свідомо нікого» проти «ще не дивились» — різні відповіді на одне питання.
 * Ядро їх уже розрізняє (`override` із `managerId: null` дає source `override`,
 * а не `none` — `resolveOwner`), тож звести їх може лише екран. Той самий поділ
 * у ядрі стереже `#127`.
 */
test("#162 «свідомо нікого» ≠ «зняти призначення» ≠ авто — три дії і три підписи", () => {
  const view = readFileSync(FE("pages/dashboard/receivablesView.ts"), "utf8");
  for (const st of ['"auto"', '"manual"', '"manual-none"'])
    assert.ok(view.includes(st), `🔴 стану ${st} немає в OwnerState — три стани звелись до двох`);

  const ed = readFileSync(FE("pages/dashboard/sections/OwnerEditor.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  // Три РІЗНІ виклики: призначити (менеджер), свідомо нікого (null), зняти (DELETE).
  assert.match(ed, /managerId:\s*Number\(managerId\)/, "🔴 немає дії «призначити менеджера»");
  assert.match(ed, /managerId:\s*null/, "🔴 немає дії «свідомо нікого» (PUT з null)");
  assert.match(ed, /clearReceivableOwner\(/, "🔴 немає дії «зняти призначення» (DELETE)");

  const sec = readFileSync(FE("pages/dashboard/sections/ReceivablesSection.tsx"), "utf8");
  assert.match(sec, /manual-none/,
    "🔴 закритий стан не розрізняє «свідомо нікого» — на екрані воно зіллється з «ще не дивились»");
});

/**
 * #163 — ГОТІВКОВИЙ РЯДОК КОНТРОЛА НЕ ДІСТАЄ.
 * `PUT /receivables/owner` віддає 404 на `source='cash'` (рядок CRM перебудовує
 * щосинку, override відкотився б сам). Пропонувати дію, яка гарантовано впаде, —
 * це «кнопка, що не тримає», гірша за відсутню.
 */
test("#163 готівці пропонується пояснення, а не кнопка, що впаде 404", () => {
  const sec = readFileSync(FE("pages/dashboard/sections/ReceivablesSection.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  // 🔴 ДИВИМОСЬ САМЕ В БЛОК КОНТРОЛА, а не по всьому файлу.
  // Перша редакція шукала `ownerSource === "cash-invoice"` де завгодно — і була
  // БЕЗЗУБА: той самий рядок є в `OwnerCell` (значок 💵), тож гейт лишався
  // зеленим, коли гілку в контролі прибрали. Спіймано власним саботажем.
  const at = sec.indexOf("{canSetOwner &&");
  assert.ok(at > 0, "🔴 блоку контрола немає — ховати нема чого");
  const block = sec.slice(at, at + 900);
  assert.match(block, /ownerSource === "cash-invoice"/,
    "🔴 у блоці контрола немає гілки для готівки — кнопка пропонується там, де роут віддасть 404");
  assert.match(block, /змінюється в CRM, не тут/,
    "🔴 замість кнопки порожньо — людина не дізнається, чому дії немає");
  // Олівець мусить бути в ІНШІЙ гілці тієї ж умови, а не поруч із поясненням.
  assert.match(block, /✏️ змінити/, "🔴 самого контрола в блоці немає");

  // 🔗 Гейт стереже РЕАЛЬНУ межу роуту, тож звіряємо і її: якщо роут перестане
  // різати готівку, ховати контрол більше не треба, і гейт має розсипатись.
  const route = readFileSync(srcOf("../routes/dashboard.ts"), "utf8");
  assert.match(route, /source = 'sheet'[\s\S]{0,200}?Клієнта немає в безготівковій дебіторці/,
    "🔴 роут більше не ріже готівку — перевір, чи потрібне ще ховання контрола");
});

/** #164 — діалог склейки показує ОБИДВА боки, суми і НАПРЯМОК. */
test("#164 діалог склейки показує, що саме зіллється і в який бік", () => {
  const d = readFileSync(FE("pages/dashboard/sections/MergeDialog.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.match(d, /Зникне як окремий рядок/, "🔴 не сказано, яка сторона зникне");
  assert.match(d, /Лишиться канонічним/, "🔴 не сказано, яка сторона лишиться");
  assert.match(d, /Після обʼєднання/, "🔴 немає підсумку «що вийде» — підтверджують намір, а не результат");
  assert.match(d, /alias\.amount \+ canonical\.amount/, "🔴 підсумкова сума не рахується з обох боків");
  assert.match(d, /setAliasKey\(canonicalKey\)/, "🔴 напрямок не можна поміняти — а злиття не симетричне");
  // 🔴 Незворотність сказана ДО дії, а не після.
  assert.match(d, /не скасувати[\s\S]{0,120}Клієнти/,
    "🔴 діалог не каже, що звідси це не скасувати й де скасувати можна");
});

/** #165 — ключ сам із собою і порожня причина не доходять до мережі. */
test("#165 склейка сама з собою і без причини блокується ДО запиту", async () => {
  const src = readFileSync(FE("pages/dashboard/receivablesView.ts"), "utf8");
  assert.match(src, /a\.clientKey === b\.clientKey/,
    "🔴 злиття ключа самого з собою не ловиться — піде в мережу й повернеться 400 із CHECK");
  assert.match(src, /!reason\.trim\(\)/, "🔴 порожня причина не ловиться на фронті");
  const d = readFileSync(FE("pages/dashboard/sections/MergeDialog.tsx"), "utf8");
  assert.match(d, /disabled=\{busy \|\| problem != null\}/,
    "🔴 кнопка «Обʼєднати» активна попри знайдену проблему");
});

/**
 * #166 — ПІСЛЯ ДІЇ ЕКРАН ПЕРЕЧИТУЄ ДАНІ, А НЕ МАЛЮЄ СВОЄ.
 *
 * Сервер після обох записів робить `recomputeOwners`, тож правильний
 * відповідальний і його `ownerSource` відомі ЛИШЕ з наступної відповіді.
 * Оптимістичний апдейт тут — найтихіший спосіб розійтися з БД: екран показує
 * те, що ми ЗАГАДАЛИ, а не те, що записалось.
 */
test("#166 після зміни відповідального і склейки — перечитування, не оптимізм", () => {
  const sec = readFileSync(FE("pages/dashboard/sections/ReceivablesSection.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const onDone = [...sec.matchAll(/onDone=\{\(\)\s*=>\s*\{([^}]*)\}\}/g)].map((m) => m[1]);
  assert.ok(onDone.length >= 2, `🔴 знайдено ${onDone.length} обробників onDone — має бути 2 (редактор і діалог)`);
  for (const body of onDone)
    assert.ok(/onRefresh\?\.\(\)/.test(body),
      `🔴 обробник «${body.trim().slice(0, 60)}…» не перечитує дані — екран малюватиме своє`);
  // 🪞 Дзеркало: жоден із них не редагує локальний список руками.
  assert.doesNotMatch(sec, /setReceivablesData|managers\.map\(.*managerName:/,
    "🔴 екран править список локально — це і є оптимістичний апдейт");
});

/**
 * #167 — Σ І ФАКТИ ТРИМАЮТЬСЯ **ПІСЛЯ** СКЛЕЙКИ, НЕ ЛИШЕ ДО НЕЇ.
 *
 * Склейка перебудовує рядок `receivables` (агрегат по `receivable_invoices`
 * канонічного ключа), а з ТОГО САМОГО джерела Е1 рахує факти. Зламай
 * перебудову — і рядок розійдеться з рахунками, з яких він складений, тобто
 * плитки почнуть суперечити рядкам.
 *
 * 🔴 ГЕЙТ НЕ РОБИТЬ СКЛЕЙКИ — він перевіряє інваріант на клієнтах, які ВЖЕ
 * злиті: у реєстрі `client_key_alias` на проді 178 активних псевдонімів, тож
 * злиті рядки в даних є. Виконувати справжнє злиття проти бойової бази заради
 * тесту не можна, а транзакція з ROLLBACK тут не рятує: роут ходить у БД
 * ВЛАСНИМ зʼєднанням і незакомічених змін не побачить (урок `#59`).
 */
test("#167 рядок дебіторки == сумі своїх рахунків (інваріант, який тримає склейка)", needsDb(), async () => {
  const { pool } = await import("../db/pool.js");

  // 🔴 ЩО САМЕ ПЕРЕВІРЯЄМО. Склейка перебудовує рядок `receivables` як агрегат
  // по `receivable_invoices` канонічного ключа. З ТОГО САМОГО джерела Е1 рахує
  // факти, тож зламана перебудова розвела б плитки з рядками. Інваріант, який
  // це ловить, ширший за саму склейку: рядок ЗАВЖДИ дорівнює сумі своїх
  // рахунків — і після склейки теж.
  //
  // Гейт НЕ виконує злиття: проти бойової бази це запис, а транзакція з ROLLBACK
  // не рятує — роут ходить у БД ВЛАСНИМ зʼєднанням і незакомічених змін не
  // побачить (урок `#59`).
  const bad = await pool.query<{ client_key: string; agg: string; inv: string }>(
    `SELECT r.client_key, r.amount::text AS agg, x.s::text AS inv
       FROM receivables r
       JOIN (SELECT client_key, SUM(amount) AS s FROM receivable_invoices GROUP BY client_key) x
         ON x.client_key = r.client_key
      WHERE r.source = 'sheet' AND abs(r.amount - x.s) > 0.01`);
  assert.equal(bad.rowCount, 0,
    `🔴 у ${bad.rowCount} клієнтів рядок розійшовся з рахунками: `
    + bad.rows.slice(0, 3).map((b) => `${b.client_key}: рядок ${b.agg} vs рахунки ${b.inv}`).join(" · "));

  // 🪞 ДЗЕРКАЛО: перевіряти БУЛО ЩО. Інакше «0 розбіжностей» означало б «рядків
  // немає», а не «все сходиться» — порожній результат це ПРОВАЛ, не успіх.
  const n = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM receivables WHERE source = 'sheet'`);
  assert.ok(Number(n.rows[0].n) > 10,
    `🔴 у безготівковій дебіторці лише ${n.rows[0].n} рядків — вибірка завузька, щоб щось доводити`);

  // 🔗 І окремо — ЗЛИТІ, коли вони є. Сьогодні в реєстрі 178 псевдонімів, але
  // жоден злитий клієнт не має боргу, тож ця частина ЧЕСНО повідомляє «немає
  // кого перевіряти» замість того, щоб зеленіти на порожнечі.
  const mergedRows = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM (SELECT client_key FROM receivable_invoices
        GROUP BY client_key HAVING count(DISTINCT client_key_raw) > 1) z`);
  const mergedN = Number(mergedRows.rows[0].n);
  if (mergedN === 0) {
    console.log("ℹ️ #167: злитих клієнтів у поточній дебіторці немає — інваріант перевірено на решті рядків");
  } else {
    const badMerged = await pool.query(
      `SELECT 1 FROM receivables r
         JOIN (SELECT client_key, SUM(amount) AS s, count(DISTINCT client_key_raw) AS raws
                 FROM receivable_invoices GROUP BY client_key) x ON x.client_key = r.client_key
        WHERE r.source = 'sheet' AND x.raws > 1 AND abs(r.amount - x.s) > 0.01`);
    assert.equal(badMerged.rowCount, 0, `🔴 злитий клієнт розійшовся з рахунками (перевірено ${mergedN})`);
  }
});
