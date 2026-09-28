import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { needsCourtCase, caseTitleFor, debtSnapshot, sniffBaMime, baStoredName, parseDateOrNull, CLAIM_STATUSES } from "./baRules.js";

/**
 * 🗂 БІЗНЕС-АСИСТЕНТ, прохід 1 (задача 4314, 28.09.2026) — гейти `#753`–`#755b`.
 * Номери — над `#752` (найвищий у `main` на момент початку); борг 17 — перед мержем перемірити.
 */

const SRC = (rel: string): string =>
  readFileSync(path.join(import.meta.dirname, "..", "..", "..", "backend", "src", rel), "utf8");

/**
 * #753 — ПЕРЕНОС У СУД ЛИШЕ ОДИН РАЗ. Справа створюється на переході в «Передано в суд» і лише
 * коли її ще немає; інші статуси справи не створюють.
 * 🧨 Червоніє, якщо прибрати умову «справи ще немає» (дубль на кожному збереженні) або
 * створювати справу на будь-якому статусі.
 */
test("#753 ПЕРЕНОС У СУД: справа — лише на «Передано в суд» і лише коли її ще немає", () => {
  assert.equal(needsCourtCase("court", false), true, "🔴 статус «Передано в суд» не створює справу");
  assert.equal(needsCourtCase("court", true), false, "🔴 повторне збереження «в суді» дублює справу");
  for (const s of CLAIM_STATUSES.filter((x) => x !== "court"))
    assert.equal(needsCourtCase(s, false), false, `🔴 статус «${s}» створив справу`);
  assert.equal(caseTitleFor("ТОВ «Дельта Логістик»"), "Стягнення боргу · Дельта Логістик");
  assert.equal(caseTitleFor("  ФОП Іваненко І.І. "), "Стягнення боргу · Іваненко І.І.");
  assert.equal(caseTitleFor("Альфа"), "Стягнення боргу · Альфа");
});

/**
 * #754 — ЗНІМОК БОРГУ БЕРЕ РІВНО СВОГО КЛІЄНТА. Сума — рядки цього ключа, дні — найбільші;
 * клієнта немає в дебіторці — `null`, а не нуль (нуль читався б як «борг погашено»).
 * 🧨 Червоніє, якщо підмішати чужі рядки, взяти перші дні замість найбільших або віддати 0.
 */
test("#754 ЗНІМОК БОРГУ: лише рядки свого ключа, дні — найбільші, немає клієнта — null", () => {
  const rows = [
    { clientKey: "c:1", clientName: "ТОВ «Альфа»", amount: 1000.1, overdueDays: 12 },
    { clientKey: "c:2", clientName: "Бета", amount: 999999, overdueDays: 300 },
    { clientKey: "c:1", clientName: "ТОВ «Альфа»", amount: 2000.2, overdueDays: 47 },
    { clientKey: "c:1", clientName: null, amount: 0.05, overdueDays: null },
  ];
  assert.deepEqual(debtSnapshot(rows, "c:1"), { company: "ТОВ «Альфа»", amount: 3000.35, overdueDays: 47 },
    "🔴 знімок узяв не рівно рядки свого клієнта");
  assert.equal(debtSnapshot(rows, "c:9"), null, "🔴 клієнт без дебіторки дав знімок");
  assert.deepEqual(debtSnapshot([{ clientKey: "c:3", clientName: " ", amount: 5, overdueDays: null }], "c:3"),
    { company: "c:3", amount: 5, overdueDays: null }, "🔴 без назви й днів — не чесний стан");
});

/**
 * #754b — ФАЙЛИ: тип за байтами, імʼя на диску — у КОРЕНІ теки документів (нічний бекап бере лише
 * корінь). Дати — сміття відхиляється, а не стає мовчазним `null`.
 * 🧨 Червоніє, якщо довіритись розширенню (голий zip як «позов»), покласти файл у підтеку
 * або пропустити невалідну дату.
 */
test("#754b ФАЙЛИ Й ДАТИ: тип за байтами, zip лише як .docx, імʼя в корені, сміття — не null", () => {
  const pdf = Buffer.from("%PDF-1.7\n...");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
  assert.equal(sniffBaMime(pdf, "позов.pdf"), "application/pdf");
  assert.equal(sniffBaMime(png, "скрин.png"), "image/png");
  assert.equal(sniffBaMime(pdf, "позов.docx"), "application/pdf", "🔴 тип узято з розширення, а не з байтів");
  assert.ok(sniffBaMime(zip, "Претензія.DOCX")?.includes("wordprocessingml"), "🔴 docx не прийнято");
  assert.equal(sniffBaMime(zip, "архів.zip"), null, "🔴 голий zip прийнято як документ");
  assert.equal(sniffBaMime(Buffer.from("MZ\x90\x00"), "позов.pdf"), null, "🔴 exe з імʼям .pdf прийнято");
  const stored = baStoredName("0b7c", "application/pdf");
  assert.equal(stored, "ba-0b7c.pdf");
  assert.ok(!/[\\/]/.test(stored), "🔴 файл лягає в підтеку — нічний бекап його не візьме");
  assert.equal(parseDateOrNull("2026-09-28"), "2026-09-28");
  assert.equal(parseDateOrNull(""), null);
  assert.equal(parseDateOrNull("28.09.2026"), undefined, "🔴 невалідна дата стала мовчазним null");
  assert.equal(parseDateOrNull("2026-13-45"), undefined);
});

/** Спільна фікстура: схема з нуля + один користувач-автор. */
async function scratchDb(t: { skip: (m: string) => void }) {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) { t.skip(skipReason(scratch)); return null; }
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
  await c.query(`INSERT INTO users (id, email, password_hash, role, is_active) VALUES (901, 'ba@test', 'x', 'admin', true)`);
  const n = async (sql: string, p: unknown[] = []) => Number((await c.query(sql, p)).rows[0].n);
  return { c, db: c as unknown as import("./baClaims.js").Db, n, dispose: async () => { await c.end(); scratch.dispose(); } };
}

/**
 * #753b — ЖИВИЙ SQL ПЕРЕНОСУ. Претензія з двома документами → «Передано в суд»: рівно одна справа,
 * обидва документи в ній (копії рядків із посиланням на оригінал), подія в обох картках.
 * Повторне збереження, вихід зі статусу й повернення — справа та сама. Ручна претензія одразу
 * «в суді» — теж справа. Ручна справа без претензії — можлива.
 * ⚠️ На ПРОД-сервері бінарів PostgreSQL немає → `skip` через `skipReason()` і запис у `ALLOWED_PROD_SKIPS`.
 * 🧨 Червоніє, якщо прибрати перенос документів, умову «справи ще немає» або `claim_id UNIQUE`.
 */
test("#753b ЖИВИЙ SQL: «Передано в суд» — одна справа з документами, повтор не дублює", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const ba = await import("./baClaims.js");
  const { db, n } = s;
  try {
    const id = await ba.createClaim(db, 901, { company: "ТОВ «Дельта Логістик»", debtAmount: "184 200,50", overdueDays: 64, sentOn: "2026-09-01" });
    for (const [docType, name] of [["claim", "Претензія.pdf"], ["receipt", "Квитанція.png"]] as const)
      await ba.insertFile(db, 901, "claim", id, { docType, name, storedName: `ba-${name}`, mime: "application/pdf", size: 10 });
    await assert.rejects(ba.insertFile(db, 901, "claim", id, { docType: "company_docs", name: "x", storedName: "ba-x", mime: "application/pdf", size: 1 }),
      /тип документа/, "🔴 претензія прийняла тип, якого в неї немає за ТЗ");

    assert.equal(await n("SELECT count(*) n FROM ba_court_cases"), 0);
    const r1 = await ba.updateClaim(db, 901, id, { status: "court" });
    assert.ok(r1.caseCreated, "🔴 «Передано в суд» не створив справу");
    const card = await ba.caseCard(db, r1.caseCreated!);
    assert.equal(card.title, "Стягнення боргу · Дельта Логістик");
    assert.equal(card.defendant, "ТОВ «Дельта Логістик»");
    assert.equal(card.claimId, id);
    assert.deepEqual(card.fileList.map((f) => f.name).sort(), ["Квитанція.png", "Претензія.pdf"], "🔴 документи претензії не перенесено");
    assert.ok(card.fileList.every((f) => f.fromClaim), "🔴 копія не знає, звідки прийшла");
    assert.equal(await n("SELECT count(*) n FROM ba_files WHERE owner_kind = 'claim'"), 2, "🔴 перенос забрав файли з претензії");
    assert.ok(card.events.some((e) => /Перенесено документів: 2/.test(e.what)), "🔴 у справі немає події переносу");
    assert.ok((await ba.claimCard(db, id)).events.some((e) => /Судовому реєстрі/.test(e.what)), "🔴 у претензії немає події переносу");

    const r2 = await ba.updateClaim(db, 901, id, { status: "court", result: "чекаємо засідання" });
    assert.equal(r2.caseCreated, null, "🔴 повторне збереження «в суді» створило другу справу");
    await ba.updateClaim(db, 901, id, { status: "noreply" });
    await ba.updateClaim(db, 901, id, { status: "court" });
    assert.equal(await n("SELECT count(*) n FROM ba_court_cases WHERE claim_id = $1", [id]), 1, "🔴 повернення в «суд» дублює справу");
    assert.equal((await ba.claimCard(db, id)).caseId, r1.caseCreated, "🔴 претензія не бачить своєї справи");

    const manual = await ba.createClaim(db, 901, { company: "Омега", status: "court" });
    assert.equal(await n("SELECT count(*) n FROM ba_court_cases WHERE claim_id = $1", [manual]), 1, "🔴 нова претензія «в суді» без справи");

    const own = await ba.createCase(db, 901, { title: "Позов до перевізника", status: "filed", filedOn: "2026-09-10" });
    assert.equal((await ba.caseCard(db, own)).claimId, null);
    await assert.rejects(ba.createCase(db, 901, { title: "x", filedOn: "10.09.2026" }), /Дата подання/, "🔴 невалідна дата справи прийнята");
    await assert.rejects(ba.updateClaim(db, 901, id, { status: "lost" }), /статус/, "🔴 невідомий статус прийнято");

    // архів → повернення: рядок той самий, повторна архівація — 409
    await ba.setCaseArchived(db, 901, own, true);
    await assert.rejects(ba.setCaseArchived(db, 901, own, true), (e: unknown) => (e as { status?: number }).status === 409);
    await ba.setCaseArchived(db, 901, own, false);
    assert.equal((await ba.caseCard(db, own)).archived, false);
  } finally { await s.dispose(); }
});

/**
 * #754c — ЖИВИЙ SQL КНОПКИ «ПРОБЛЕМНИЙ КЛІЄНТ». Сума — знімок з рядків ядра; повторний клік
 * повертає ту саму претензію; після «Оплачено» можна завести нову; архівну не повернути, поки
 * відкрита інша; клієнта без дебіторки — 404. `openClaimsByClient` — рівно відкриті.
 * 🧨 Червоніє, якщо прибрати перевірку наявної, частковий унікальний індекс або знімок суми.
 */
test("#754c ЖИВИЙ SQL: кнопка з дебіторки — знімок суми, одна відкрита на клієнта", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const ba = await import("./baClaims.js");
  const { db, n } = s;
  try {
    const rows = [
      { clientKey: "c:1", clientName: "ТОВ «Альфа»", amount: 1000, overdueDays: 12 },
      { clientKey: "c:1", clientName: "ТОВ «Альфа»", amount: 250.5, overdueDays: 40 },
      { clientKey: "c:2", clientName: "Бета", amount: 7, overdueDays: 3 },
    ];
    const a = await ba.claimFromReceivables(db, 901, "c:1", rows);
    assert.equal(a.created, true);
    const card = await ba.claimCard(db, a.id);
    assert.equal(card.debtAmount, 1250.5, "🔴 сума претензії ≠ сума рядків дебіторки клієнта");
    assert.equal(card.overdueDays, 40);
    assert.equal(card.source, "receivables");
    assert.equal(card.status, "problem");

    const again = await ba.claimFromReceivables(db, 901, "c:1", rows);
    assert.deepEqual(again, { id: a.id, created: false }, "🔴 другий клік створив другу претензію");
    await assert.rejects(ba.claimFromReceivables(db, 901, "c:9", rows), (e: unknown) => (e as { status?: number }).status === 404,
      "🔴 претензію створено для клієнта без дебіторки");
    // гонка: база сама не пускає другу відкриту
    await assert.rejects(s.c.query(`INSERT INTO ba_claims (company, client_key, status, source) VALUES ('x', 'c:1', 'sent', 'receivables')`),
      /uq_ba_claims_open_client/, "🔴 база пустила другу відкриту претензію на клієнта");

    assert.deepEqual(await ba.openClaimsByClient(db), [{ clientKey: "c:1", claimId: a.id }]);
    await ba.updateClaim(db, 901, a.id, { status: "paid" });
    assert.deepEqual(await ba.openClaimsByClient(db), [], "🔴 оплачена претензія лишилась «відкритою»");
    const b = await ba.claimFromReceivables(db, 901, "c:1", rows);
    assert.equal(b.created, true, "🔴 після оплати нова претензія не створюється");
    assert.notEqual(b.id, a.id);

    // архівна не повертається, поки відкрита інша; оплачену — повернути можна
    await ba.setClaimArchived(db, 901, b.id, true);
    const c3 = await ba.claimFromReceivables(db, 901, "c:1", rows);
    assert.equal(c3.created, true, "🔴 архівна претензія блокує нову");
    await assert.rejects(ba.setClaimArchived(db, 901, b.id, false), (e: unknown) => (e as { status?: number }).status === 409,
      "🔴 повернення з архіву дало дві відкриті претензії на клієнта");
    assert.equal(await n("SELECT count(*) n FROM ba_claims WHERE client_key = 'c:1'"), 3);
    assert.ok((await ba.claimCard(db, a.id)).events.some((e) => /1\s?250,5 ₴, 40 днів/.test(e.what)), "🔴 у історії немає знімка суми");
  } finally { await s.dispose(); }
});

/**
 * #755 — ХТО БАЧИТЬ І ХТО НАТИСКАЄ: сид, матриця й декларація — один список (рішення Романа
 * 24.09.2026). Розділ — «бізнес-асистент» + керівництво; кнопка — керівництво + фінансист,
 * бухгалтерія лише переглядає.
 * 🧨 Червоніє, якщо дописати роль лише в матрицю чи лише в сид, дати `create_claim` бухгалтерії,
 * тімліду чи менеджеру, або забрати роль із декларацій.
 */
test("#755 ДОСТУП БА: вкладка ba і право create_claim — у сиді, матриці й каталозі одним списком", () => {
  const sql = SRC("db/schema.sql");
  const row = /path: "\/api\/ba\/claims", cls: "GET",\s*\n\s*allow: \[([^\]]*)\]/.exec(SRC("auth/accessMatrix.ts"));
  assert.ok(row, "🔴 рядок матриці для /api/ba/claims не знайдено");
  const inMatrix = [...row[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
  const seed = /screen_access \|\| '\{"ba":true\}'::jsonb\s*\n\s*WHERE key IN \(([^)]*)\)/.exec(sql);
  assert.ok(seed, "🔴 сид вкладки `ba` для керівництва не знайдено");
  const inSeed = [...seed[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(inMatrix, inSeed, `🔴 матриця: ${inMatrix.join(",")} · сид: ${inSeed.join(",")}`);
  assert.deepEqual(inSeed, ["admin", "ceo", "hr", "kvp", "opdir"], "🔴 склад керівництва розійшовся з рішенням");

  assert.match(sql, /VALUES \('business_assistant', 'Бізнес-асистент', false, 'own', '\{"ba":true\}'::jsonb/, "🔴 роль «Бізнес-асистент» не сидиться з вкладкою ba");
  assert.match(SRC("db/roleDeclarations.ts"), /key: "business_assistant"/, "🔴 роль не оголошена (#15 почервоніє на прийманні)");

  const grant = /permissions \|\| '\{"create_claim": true\}'::jsonb\s*\n\s*WHERE key IN \(([^)]*)\)/.exec(sql);
  const strip = /permissions - 'create_claim'\s*\n\s*WHERE key NOT IN \(([^)]*)\)/.exec(sql);
  assert.ok(grant && strip, "🔴 видача або зняття create_claim не знайдені");
  const g = [...grant[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  const st = [...strip[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(g, ["admin", "ceo", "financier", "hr", "kvp", "opdir"], "🔴 кнопку отримав не той склад");
  assert.deepEqual(st, g, "🔴 видача й зняття права розійшлись");
  assert.match(SRC("auth/permGrant.ts"), /"create_claim"/, "🔴 право не в каталозі — адмін не зможе ним керувати");
});

/**
 * #755b — МЕЖА ПЕРШИМ ОПЕРАТОРОМ І ПРЕФІКСИ. На цьому стоїть безпека проб `deny-only` у матриці:
 * тімлід із пробою POST мусить отримати 403 ДО запису. Кожен обробник `baRouter` — `onlyBa(req)`
 * першим; POST з дебіторки — `requirePerm("create_claim")` до обробника; обидва префікси в ROUTE_TAB.
 * 🧨 Червоніє, якщо переставити `onlyBa` нижче чи прибрати, зняти `requirePerm` або префікс.
 */
test("#755b ДОСТУП БА: onlyBa — перший оператор кожного обробника, кнопка — за правом", () => {
  const src = SRC("routes/businessAssistant.ts");
  const inline = [...src.matchAll(/baRouter\.(get|post|patch|put|delete)\("([^"]+)", (?:async )?\(req, res\) => \{\s*try \{\s*([^\n;]+);/g)];
  const byFactory = [...src.matchAll(/baRouter\.(get|post)\("([^"]+)", (uploadHandler|downloadHandler)\("(claim|case)"\)\)/g)];
  const all = [...src.matchAll(/baRouter\.(get|post|patch|put|delete)\(/g)];
  assert.equal(inline.length + byFactory.length, all.length, `🔴 розпізнано ${inline.length + byFactory.length} із ${all.length} обробників`);
  assert.ok(all.length >= 15, `🔴 знайдено лише ${all.length} обробників — гейт нічого не перевіряє`);
  for (const [, m, p, first] of inline)
    assert.match(first.trim(), /^onlyBa\(req\)$/, `🔴 ${m.toUpperCase()} ${p}: першим стоїть «${first.trim()}»`);
  for (const fn of ["uploadHandler", "downloadHandler"]) {
    const body = new RegExp(`function ${fn}\\([^)]*\\) \\{\\s*return async \\(req: Request, res: Response\\) => \\{\\s*try \\{\\s*([^\\n;]+);`).exec(src);
    assert.ok(body, `🔴 ${fn} не знайдено`);
    assert.equal(body[1].trim(), "onlyBa(req)", `🔴 ${fn}: першим стоїть «${body[1].trim()}»`);
  }
  assert.match(SRC("routes/receivablesClaims.ts"), /receivablesClaimRouter\.post\("\/", requirePerm\("create_claim"\), async/, "🔴 створення з дебіторки без права");
  const rt = SRC("auth/routeTab.ts");
  assert.match(rt, /pre\("\/api\/ba"\), tabs: \["ba"\]/, "🔴 /api/ba не під вкладкою ba");
  assert.match(rt, /pre\("\/api\/receivables-claims"\), tabs: \["receivables"\]/, "🔴 кнопка дебіторки не під вкладкою receivables");
});

/**
 * #756 — ФРОНТ: пункт меню, рендер розділу й кнопка в дебіторці — за СЕРВЕРНИМ станом.
 * Кнопку бачить лише той, кому сервер сказав `canCreate` (право `create_claim`), а не вгадування
 * з ролі на клієнті; документ відкривається на місці (урок 4310: `window.open` після очікування
 * блокувальник гасить мовчки); розділ — статичним імпортом (гейт #225: один чанк).
 * 🧨 Червоніє, якщо показати кнопку без `canCreate`, прибрати її з колонки «Дії», повернути
 * `window.open` у розділ, або підвантажити розділ ліниво.
 */
test("#756 ФРОНТ БА: меню й рендер статично, кнопка лише за canCreate з сервера, перегляд на місці", () => {
  const FE = (rel: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", rel), "utf8");
  const codeOnly = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.match(FE("components/Layout.tsx"), /\{ key: "ba", label: "Бізнес-асистент"/, "🔴 пункту «Бізнес-асистент» немає в меню (і в тумблерах Налаштувань)");
  const dash = FE("pages/Dashboard.tsx");
  assert.match(dash, /^import \{ BusinessAssistantSection \} from "\.\/dashboard\/sections\/BusinessAssistantSection";$/m, "🔴 розділ імпортовано не статично");
  assert.match(dash, /section === "ba" && \(/, "🔴 розділ не рендериться на /ba");

  const btn = codeOnly(FE("pages/dashboard/sections/ProblemClientButton.tsx"));
  const gate = btn.indexOf("if (!state.canCreate) return null;");
  assert.ok(gate > 0, "🔴 кнопка не ховається без права create_claim");
  assert.ok(gate < btn.indexOf("⚠ проблемний"), "🔴 кнопка рендериться до перевірки права");
  assert.doesNotMatch(btn, /roleKey|auth\.role|"financier"|"admin"/, "🔴 право кнопки вгадується з ролі на клієнті, а не з відповіді сервера");
  assert.match(FE("pages/dashboard/sections/ReceivablesSection.tsx"), /<ProblemClientButton clientKey=\{c\.clientKey\}/, "🔴 кнопки немає в рядку дебіторки");

  assert.doesNotMatch(codeOnly(FE("pages/dashboard/sections/BusinessAssistantSection.tsx")), /window\.open\(/,
    "🔴 документ відкривається новою вкладкою після очікування — блокувальник гасить її мовчки");
});
