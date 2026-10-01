import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildDocx, expandOrgName, shortOrgName, mainUntilText, blockers, type DocumentState } from "./services/docgen.js";
import { loadDocImages, docImageDataUris, AssetsMissing } from "./services/docAssets.js";
import { printHTML, fullPageHTML } from "./services/printTemplate.js";
import { normPhone, findPhone, parseRequisites, parseOldDoc } from "./services/requisitesParser.js";
import { canSeeConstructorDoc, stateFromBody } from "./access.js";

/**
 * 📄 КОНСТРУКТОР ДОКУМЕНТІВ (30.09.2026) — пакет Сергія `roman-package`.
 *
 * #1120–#1122 — ПОРТ його трьох vitest-файлів (docgen / printTemplate / requisitesParser) на `node:test`.
 * Твердження ті самі: генератор видає ПОСИМВОЛЬНО той самий Word і HTML, що затверджений макет, і парсер
 * поводиться як еталон. Змінено одне — ФІКСТУРИ, і це свідомо:
 *  - з них вирізано base64 сканів підписів і печаток (репозиторій ПУБЛІЧНИЙ); Word від байтів картинок
 *    не залежить (розміри — з `DEFAULT_IMG_DIM`), а в HTML data-URI нормалізується з обох боків;
 *  - справжні реквізити третіх осіб (ФОП, його код, IBAN, телефони, держномер) замінено УЗГОДЖЕНО у вході й
 *    в еталоні, зі збереженням формату. Зелений прогін на знеособлених фікстурах і доводить, що заміна
 *    не зламала еквівалентності.
 * Картинки для тесту — фальшиві PNG у тимчасовій теці: справжні живуть лише на сервері.
 */

const FIX = (f: string) => JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "..", "src", "constructor", "fixtures", f), "utf8"));
const SRC = (rel: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "src", rel), "utf8");
const REPO = path.join(import.meta.dirname, "..", "..", "..");

type Ref = Record<string, { state: DocumentState & { num: string }; documentXml: string; media: string[]; printHtml: string }>;
const ref = FIX("docgen-ref.json") as Ref;

/** Тимчасова тека з фальшивими PNG під іменами справжніх — байти не важливі, важлива присутність. */
function fakeAssets(): { dir: string; dispose: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "constructor-assets-"));
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082", "hex");
  for (const f of ["sig-bespyatchuk.png", "sig-kovtonyuk.png", "stamp-uts.png", "stamp-avtomuv.png"]) writeFileSync(path.join(dir, f), png);
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/* Мінімальний читач нашого stored-zip — лише для тесту (з пакета Сергія). */
function unzipStored(u8: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = 0;
  while (p + 4 <= u8.length && dv.getUint32(p, true) === 0x04034b50) {
    const size = dv.getUint32(p + 18, true);
    const nameLen = dv.getUint16(p + 26, true);
    const extraLen = dv.getUint16(p + 28, true);
    const name = new TextDecoder().decode(u8.subarray(p + 30, p + 30 + nameLen));
    const dataStart = p + 30 + nameLen + extraLen;
    out.set(name, u8.subarray(dataStart, dataStart + size));
    p = dataStart + size;
  }
  return out;
}
/** docPr id/name — довільні лічильники, не зміст. */
const normXml = (xml: string) => xml.replace(/ id="\d+" name="img\d+"/g, ' id="#" name="img#"');
/** data-URI картинок — байти не порівнюємо (у фікстурі їх вирізано), лише місце й наявність. */
const normHtml = (h: string) => h.replace(/data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]*/g, "data:IMG");

/**
 * #1120 — WORD ПОСИМВОЛЬНО ЯК У МАКЕТІ (порт `docgen.test.ts` Сергія): 4 конфігурації, ФОП без печатки,
 * вимкнений перемикач — без картинок.
 * 🧨 Червоніє на будь-якій зміні юртексту, таблиці умов, реквізитів чи розкладки підписів у `docgen.ts`.
 */
test("#1120 WORD ЯК У МАКЕТІ: document.xml посимвольно в 4 конфігураціях; ФОП без печатки; перемикач вимикає картинки", () => {
  const a = fakeAssets();
  try {
    assert.ok(Object.keys(ref).length >= 4, "🔴 фікстура порожня — перевірці нічого порівнювати");
    for (const [name, r] of Object.entries(ref)) {
      const zip = buildDocx(r.state, r.state.num, loadDocImages(a.dir, r.state.ent, r.state.stamp));
      assert.deepEqual([zip[0], zip[1]], [0x50, 0x4b], `🔴 «${name}»: не zip`);
      const files = unzipStored(zip);
      const xml = new TextDecoder().decode(files.get("word/document.xml")!);
      assert.equal(normXml(xml), normXml(r.documentXml), `🔴 «${name}»: Word розійшовся з затвердженим макетом`);
      assert.deepEqual([...files.keys()].filter((n) => n.startsWith("word/media/")).sort(), r.media, `🔴 «${name}»: інший набір картинок`);
    }
    const fop = loadDocImages(a.dir, "fop", true);
    assert.ok(fop.sig && !fop.stamp, "🔴 у ФОП зʼявилась печатка або зник підпис (рішення 29.09)");
    assert.deepEqual(ref["carr-fop"].media, ["word/media/sig.png"]);
    const off = unzipStored(buildDocx({ ...ref["once-client-uts"].state, stamp: false }, "1", loadDocImages(a.dir, "uts", false)));
    assert.deepEqual([...off.keys()].filter((n) => n.startsWith("word/media/")), [], "🔴 вимкнений перемикач лишив підпис/печатку");
  } finally { a.dispose(); }
});

test("#1120b НАЗВИ: зверху повна форма, внизу скорочена; власна назва й «ТОВстун» не чіпаються", () => {
  assert.equal(expandOrgName("ТОВ «Тест Агро-Трейд»"), "ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ «Тест Агро-Трейд»");
  assert.equal(expandOrgName("ТзОВ «Іскра»"), "ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ «Іскра»");
  assert.equal(expandOrgName("ФОП Тестенко Остап Петрович"), "ФІЗИЧНА ОСОБА-ПІДПРИЄМЕЦЬ Тестенко Остап Петрович");
  assert.equal(expandOrgName("ТОВ «КФ «ТЕСТОВІ ЛАСОЩІ»"), "ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ «КФ «ТЕСТОВІ ЛАСОЩІ»");
  assert.equal(shortOrgName("ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ «Тест»"), "ТОВ «Тест»");
  assert.equal(shortOrgName("ФІЗИЧНА ОСОБА-ПІДПРИЄМЕЦЬ Іванов Іван"), "ФОП Іванов Іван");
  assert.equal(expandOrgName("Нестандартна Назва Без Форми"), "Нестандартна Назва Без Форми");
  assert.equal(shortOrgName("ТОВ «Вже Коротка»"), "ТОВ «Вже Коротка»");
  assert.equal(expandOrgName("ТОВстун і партнери"), "ТОВстун і партнери", "🔴 «ТОВ» розгорнуто всередині слова");
});

/**
 * #1121 — HTML (PDF і прев'ю) ПОСИМВОЛЬНО ЯК У МАКЕТІ (порт `printTemplate.test.ts`). PDF друкується з
 * цього HTML, тож збіг тут = той самий текст у PDF, що у Word.
 * 🧨 Червоніє на зміні `printTemplate.ts` або CSS документа поза макетом.
 */
test("#1121 PDF/ПРЕВʼЮ ЯК У МАКЕТІ: printHTML посимвольно; повна сторінка несе CSS і захист від різаної печатки", () => {
  const a = fakeAssets();
  try {
    for (const [name, r] of Object.entries(ref)) {
      const got = printHTML(r.state, r.state.num, docImageDataUris(a.dir, r.state.ent, r.state.stamp));
      assert.equal(normHtml(got), normHtml(r.printHtml), `🔴 «${name}»: HTML розійшовся з макетом`);
    }
    const r = ref["once-client-uts"];
    const html = fullPageHTML(r.state, r.state.num, docImageDataUris(a.dir, "uts", true));
    assert.match(html, /<!doctype html>/);
    assert.ok(html.includes(".docfmt{font-family:'Times New Roman'"), "🔴 повна сторінка без CSS документа — прев'ю було б «голим»");
    assert.ok(html.includes("break-inside:avoid"), "🔴 зник захист від печатки, розрізаної межею сторінки");
  } finally { a.dispose(); }
});

/**
 * #1122 — ПАРСЕР РЕКВІЗИТІВ ЯК ЕТАЛОН (порт `requisitesParser.test.ts`): 4 кейси, телефон не з хвоста ІПН,
 * імпорт старої заявки не хапає НАШИХ реквізитів і ставить ПІБ ФОП у називний відмінок.
 */
test("#1122 ПАРСЕР: 4 кейси як у макеті; телефон не з хвоста ІПН; стара заявка — без наших реквізитів", () => {
  const p = FIX("parser-ref.json") as {
    cases: Record<string, { in: string; out: Record<string, string> }>;
    oldText: string;
    oldParsed: { dealNo: string; party: string; ent: string; cp: Record<string, string>; trip: Record<string, string>; pay?: unknown; intl?: boolean };
  };
  assert.equal(normPhone("0671234567"), "+380671234567");
  assert.equal(normPhone("380671234567"), "+380671234567");
  assert.equal(normPhone("+380 (67) 357-14-68"), "+380673571468");
  assert.equal(normPhone("400000519063"), "", "🔴 12 цифр ІПН прийнято за телефон");
  assert.equal(normPhone("12345"), "");
  assert.equal(findPhone("ІПН 3012345678\nТелефон: 067 123 45 67"), "+380671234567");
  assert.equal(findPhone("ідентифікаційний номер 400000519063 і потім 0500000004"), "+380500000004", "🔴 телефон вихоплено з хвоста ІПН");
  assert.ok(Object.keys(p.cases).length >= 4, "🔴 кейсів немає — перевірці нічого порівнювати");
  for (const [name, c] of Object.entries(p.cases)) assert.deepEqual(parseRequisites(c.in).out, c.out, `🔴 кейс «${name}» розійшовся з еталоном`);
  assert.equal(Object.values(parseRequisites(p.cases.zbarazh.in).found).filter(Boolean).length, 9, "🔴 повний комплект розпізнано не весь");

  const r = parseOldDoc(p.oldText);
  assert.deepEqual([r.dealNo, r.party, r.ent], [p.oldParsed.dealNo, p.oldParsed.party, p.oldParsed.ent]);
  assert.deepEqual(r.cp, p.oldParsed.cp);
  assert.doesNotMatch(r.cp.dir ?? "", /Ковтонюк/, "🔴 контрагентом стала НАША директорка");
  assert.equal(r.cp.dir, "Тестенко Остап Петрович", "🔴 ПІБ ФОП у родовому відмінку («Остапа Петровича»)");
  assert.deepEqual(r.trip, p.oldParsed.trip);
  assert.deepEqual(r.pay, p.oldParsed.pay);
  assert.equal(!!r.intl, !!p.oldParsed.intl);
});

/**
 * #1123 — «КОЖЕН ТІЛЬКИ СВОЇ» (рішення Сергія 30.09.2026). Функція — по обидва боки межі; роут — кожне
 * місце, що дістає документ за id, іде через `visibleRow`, а список — з фільтром автора.
 * 🧨 Червоніє, якщо Word/PDF/картка читають `constructor_documents` в обхід межі або список втратить автора.
 */
test("#1123 ЛИШЕ СВОЇ: автор бачить свій, чужий — ні, право пулу — усі; Word/PDF/картка — через одну межу", () => {
  assert.equal(canSeeConstructorDoc(7, 7, false), true, "🔴 автор не бачить власного документа");
  assert.equal(canSeeConstructorDoc(7, 8, false), false, "🔴 менеджер бачить чужий документ");
  assert.equal(canSeeConstructorDoc(7, 8, true), true, "🔴 право пулу не відкриває чужих");
  assert.equal(canSeeConstructorDoc(0, 0, false), false, "🔴 порожній автор збігся з порожнім глядачем");
  assert.equal(canSeeConstructorDoc(Number.NaN, Number.NaN, false), false);

  const src = SRC("routes/constructor.ts");
  const byId = [...src.matchAll(/FROM constructor_documents[^`]*WHERE (?:d\.)?id = \$1/g)];
  assert.equal(byId.length, 2, "🔴 документ за id читається в новому місці — межу можна обійти");
  // Друге читання — друга сторона пакета угоди: `stateById` кличеться лише там і лише для рядка, що пройшов межу.
  assert.equal([...src.matchAll(/stateById\(req, /g)].length, 1, "🔴 stateById кличеться поза пакетом угоди");
  assert.match(src, /const other = q\.rows\.find\(\(r\) => canSeeConstructorDoc\([\s\S]{0,700}for \(const id of \[Number\(row\.id\), Number\(other\.id\)\]\)[\s\S]{0,80}stateById\(req, id\)/,
    "🔴 пакет угоди бере другу сторону без межі «лише свої»");
  assert.match(src, /async function visibleRow[\s\S]{0,400}canSeeConstructorDoc\(/, "🔴 читання за id без межі «лише свої»");
  for (const route of ["/documents/:id\"", "/documents/:id/docx", "/documents/:id/pdf"]) {
    const at = src.indexOf(`constructorRouter.get("${route.replace(/"$/, "")}"`);
    assert.ok(at > 0, `🔴 роут ${route} зник`);
    assert.match(src.slice(at, at + 300), /visibleRow\(req\)|docStateOf\(req\)/, `🔴 ${route} читає документ в обхід межі`);
  }
  assert.match(src, /async function docStateOf\(req: Request\)[\s\S]{0,120}await visibleRow\(req\)/, "🔴 Word/PDF генеруються без межі");
  assert.match(src, /constructorRouter\.get\("\/documents", h\(async \(req, res\) => \{\s*const \{ where, params \} = archiveWhere\(req, true\)/,
    "🔴 архів показує не лише свої документи");
  for (const r of ["/pool\"", "/pool/stats\""]) {
    const at = src.indexOf(`constructorRouter.get("${r}`);
    assert.match(src.slice(at, at + 120), /h\(async \(req, res\) => \{\s*onlyPool\(req\);/, `🔴 ${r} не перевіряє право першим оператором`);
  }
  assert.match(src, /roleHasTab\(req\.auth\.roleKey, "constructor"\)/, "🔴 зникла межа вкладки");
});

/**
 * #1123b — ЖИВИЙ SQL: схема з нуля двічі; тригер версій 1→2 на ту саму пару; без № угоди — відмова;
 * «Відповідальна особа» — ПІБ і телефон із картки співробітника; лічильник має й дні з нулем; права —
 * вкладка всім продажним ролям і фінансисту, пул — лише admin/СЕО/ОД, і після ДРУГОГО прогону теж.
 */
test("#1123b ЖИВИЙ SQL: версії 1→2, без № — відмова, особа з картки, лічильник із нулями, пул лише керівництву", async (t) => {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) { t.skip(skipReason(scratch)); return; }
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    const schema = readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8");
    await c.query(schema);
    await c.query(schema); // другий прогін: ідемпотентність і синк фінансиста
    await c.query(`INSERT INTO users (id, email, password_hash, role, is_active) VALUES (901, 'a@test', 'x', 'manager', true), (902, 'b@test', 'x', 'manager', true)`);
    await c.query(`INSERT INTO employees (full_name, import_key, user_id, phone) VALUES ('Тестова Марина Олегівна', 'k901', 901, '+380 67 000 00 01')`);
    const ins = `INSERT INTO constructor_documents (deal_no, doc_kind, party, entity_key, contractor, created_by)
                 VALUES ($1, 'once', 'client', 'uts', '{}', $2) RETURNING version`;
    assert.equal((await c.query(ins, ["62000001", 901])).rows[0].version, 1);
    assert.equal((await c.query(ins, ["62000001", 902])).rows[0].version, 2, "🔴 друга версія тієї ж угоди не стала v2");
    assert.equal((await c.query(ins, ["62000002", 901])).rows[0].version, 1, "🔴 версія рахується не по угоді");
    await assert.rejects(c.query(ins, [null, 901]), "🔴 документ без № угоди записався");

    const { MANAGER_CONTACT_SQL, POOL_STATS_SQL } = await import("./sql.js");
    assert.deepEqual((await c.query(MANAGER_CONTACT_SQL, [901])).rows[0], { name: "Тестова Марина Олегівна", phone: "+380 67 000 00 01" },
      "🔴 «Відповідальна особа» не з картки співробітника");
    assert.deepEqual((await c.query(MANAGER_CONTACT_SQL, [902])).rows[0], { name: "b@test", phone: "" }, "🔴 без картки — не запасне ім'я");
    const st = (await c.query(POOL_STATS_SQL, [7])).rows;
    assert.equal(st.length, 7, "🔴 лічильник пропустив дні без документів");
    assert.equal(st.reduce((s: number, x: { docs: number }) => s + x.docs, 0), 3, "🔴 лічильник загубив документи");
    assert.ok(st.some((x: { docs: number }) => x.docs === 0), "🔴 день без документів не показано нулем");

    const roles = (await c.query(`SELECT key, (screen_access->>'constructor')::bool AS tab, permissions ? 'view_all_constructor_docs' AS pool FROM roles`)).rows as { key: string; tab: boolean | null; pool: boolean }[];
    const of = (k: string) => roles.find((r) => r.key === k);
    for (const k of ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"]) assert.equal(of(k)?.tab, true, `🔴 ${k} без вкладки конструктора`);
    assert.notEqual(of("hr")?.tab, true, "🔴 HR дістав вкладку конструктора");
    assert.deepEqual(roles.filter((r) => r.pool).map((r) => r.key).sort(), ["admin", "ceo", "opdir"],
      "🔴 пул розтікся за межі керівництва (після другого прогону — синк фінансиста)");
    const revoked = (await c.query(`SELECT count(*)::int AS n FROM information_schema.role_table_grants WHERE grantee = 'ai_readonly' AND table_name LIKE 'constructor_%'`)).rows[0].n;
    assert.equal(revoked, 0, "🔴 таблиці конструктора доступні AI-запитам");
  } finally { await c.end(); scratch.dispose(); }
});

/**
 * #1124 — ПІДПИСИ Й ПЕЧАТКИ НЕ В GIT (рішення Сергія 30.09.2026: «зберігати лише на сервері»; репозиторій
 * публічний). Тека — у `.gitignore`, у відстежуваних файлах немає ні PNG конструктора, ні base64-картинок у
 * фікстурах; тека за замовчуванням — під нічним бекапом документів.
 * 🧨 Червоніє, якщо покласти скан у репозиторій або повернути в фікстуру data-URI з байтами.
 */
test("#1124 ПІДПИСИ НЕ В GIT: тека в .gitignore, жодного PNG і base64-скану в репозиторії; тека — під бекапом", () => {
  const ignored = execFileSync("git", ["check-ignore", "backend/documents/constructor-assets/stamp-uts.png"], { cwd: REPO, encoding: "utf8" }).trim();
  assert.equal(ignored, "backend/documents/constructor-assets/stamp-uts.png", "🔴 тека підписів не ігнорується git");
  const tracked = execFileSync("git", ["ls-files"], { cwd: REPO, encoding: "utf8" }).split("\n");
  const bad = tracked.filter((f) => /constructor/i.test(f) && /\.(png|jpe?g)$/i.test(f));
  assert.deepEqual(bad, [], "🔴 скан підпису/печатки потрапив у git");
  for (const f of ["docgen-ref.json", "parser-ref.json"]) {
    const s = readFileSync(path.join(REPO, "backend", "src", "constructor", "fixtures", f), "utf8");
    assert.doesNotMatch(s, /base64,[A-Za-z0-9+/=]{40,}/, `🔴 у фікстурі ${f} лежить картинка`);
  }
  assert.match(SRC("routes/constructor.ts"), /CONSTRUCTOR_ASSETS_DIR \?\? path\.join\(DOCS_DIR, "constructor-assets"\)/, "🔴 тека підписів поза нічним бекапом");
  assert.throws(() => loadDocImages(path.join(tmpdir(), "немає-такої-теки"), "uts", true), AssetsMissing, "🔴 відсутній скан дає 500 замість зрозумілої відмови");
});

/**
 * #1125 — ВХІДНИЙ СТАН: невідома юрособа — відмова словами (у пакеті — 500); сторона виводиться з виду
 * документа; менеджер — із сесії, НЕ з тіла запиту (рішення 29.09 у README пакета).
 */
test("#1125 СТАН ФОРМИ: невідома юрособа — 400 словами; сторона з виду документа; менеджер лише із сесії", () => {
  const me = { name: "Із сесії", phone: "+380" };
  assert.equal(typeof stateFromBody({ state: { ent: "xyz", doc: "once" } }, me), "string", "🔴 невідома юрособа пройшла");
  assert.equal(typeof stateFromBody({ state: { ent: "uts", doc: "bad" } }, me), "string");
  const s = stateFromBody({ state: { ent: "avm", doc: "carr", party: "client", manager: { name: "Підробка", phone: "0" }, dealNo: " 62 " } }, me);
  assert.ok(typeof s !== "string");
  assert.equal(s.party, "carrier", "🔴 заявка перевізнику з клієнтською стороною");
  assert.deepEqual(s.manager, me, "🔴 «Відповідальну особу» взято з тіла запиту");
  assert.equal(s.dealNo, "62");
  const once = stateFromBody({ state: { ent: "uts", doc: "once", party: "carrier", docDate: "30.09.2026" } }, me);
  assert.ok(typeof once !== "string" && once.party === "client" && once.docDate === "", "🔴 разовий із перевізником або дата не в ISO");
});

/**
 * #1126 — ФРОНТ: вкладка в меню, статичний імпорт (гейт #225 — один чанк), Word/PDF — через `api` з
 * токеном (голе посилання `<a href="/api/constructor/...">` дало б 401: вхід у нас — заголовком, не кукою).
 */
test("#1126 ФРОНТ КОНСТРУКТОРА: пункт меню, статичний імпорт, файли — через api з токеном", () => {
  const FE = (rel: string) => readFileSync(path.join(REPO, "frontend", "src", rel), "utf8");
  assert.match(FE("components/Layout.tsx"), /\{ key: "constructor", label: "Конструктор документів"/, "🔴 немає пункту меню");
  const dash = FE("pages/Dashboard.tsx");
  assert.match(dash, /import \{ ConstructorSection \} from "\.\/dashboard\/sections\/ConstructorSection";/, "🔴 імпорт не статичний");
  assert.match(dash, /section === "constructor" && <ConstructorSection \/>/);
  const sec = FE("pages/dashboard/sections/ConstructorSection.tsx");
  assert.doesNotMatch(sec, /href=\{?["'`]?\/api\/constructor/, "🔴 файл через голе посилання — 401 без токена");
  assert.doesNotMatch(sec, /React\.lazy|import\(/, "🔴 динамічний імпорт — другий чанк (#225)");
  assert.match(FE("api.ts"), /\/constructor\/documents\/\$\{id\}\/\$\{kind\}`, \{ responseType: "blob"/, "🔴 Word/PDF не через api з токеном");
});

/**
 * #1127 — СТОРІНКА ДЛЯ ДРУКУ PDF: стиль друку стоїть ПІСЛЯ CSS документа (інакше рівна специфічність програє),
 * спейсер `.sigend` схований `display:none`, поля — як у макеті, фони друкуються. Заміряно 30.09.2026 тим
 * самим chrome-headless-shell 154, що на сервері: без цього клієнтська разова — 4 сторінки, четверта біла;
 * з цим — 3, як у приймальній перевірці пакета Сергія (README §10 п.4).
 * 🧨 Червоніє, якщо вставити стиль друку перед CSS документа або повернути `height:0`.
 */
test("#1127 PDF-ДРУК: стиль друку після CSS документа, спейсер схований, поля й фони макета", async () => {
  const { printable, PRINT_CSS } = await import("./services/pdfRenderer.js");
  const r = ref["once-client-uts"];
  const page = printable(fullPageHTML(r.state, r.state.num, {}));
  const at = page.indexOf(PRINT_CSS);
  assert.ok(at > 0, "🔴 стиль друку не вставлено");
  assert.ok(at > page.indexOf(".docfmt .sigend{height:26pt}"), "🔴 стиль друку стоїть ДО CSS документа — і програє йому");
  assert.ok(at < page.indexOf("</head>"), "🔴 стиль друку поза <head>");
  assert.match(PRINT_CSS, /\.docfmt \.sigend\{display:none\}/, "🔴 спейсер не схований — порожня остання сторінка");
  assert.match(PRINT_CSS, /@page\{size:A4;margin:10mm 11mm 12mm 11mm\}/, "🔴 поля не як у макеті");
  assert.match(PRINT_CSS, /print-color-adjust:exact/, "🔴 фони (смуга, клітинки умов) не друкуються");
});

/**
 * #1128 — КОНВЕРТЕР (макет K-15): абзаци зберігаються, Word — коректний zip із `word/document.xml` і текстом,
 * лише DOCX/TXT/JPG/PNG ідуть у PDF, пошкоджена картинка — відмова, а не порожній PDF.
 * 🧨 Червоніє, якщо склеїти абзаци, загубити текст у Word або пропустити невідомий формат.
 */
test("#1128 КОНВЕРТЕР: абзаци цілі, Word із текстом, лише 4 формати в PDF, пошкоджена картинка — відмова", async () => {
  const cv = await import("./services/convert.js");
  assert.deepEqual(cv.splitParagraphs("Перший рядок\nдругий рядок\n\n\nДругий абзац\r\n\r\nТретій\f"), ["Перший рядок\nдругий рядок", "Другий абзац", "Третій"],
    "🔴 абзаци склеєно або загублено перенос усередині абзацу");
  const docx = cv.paragraphsDocx(["Договір № 1 <&>", "Рядок 1\nРядок 2"]);
  const files = unzipStored(docx);
  assert.ok(files.has("[Content_Types].xml") && files.has("_rels/.rels") && files.has("word/document.xml"), "🔴 у Word бракує обовʼязкових частин");
  const xml = new TextDecoder().decode(files.get("word/document.xml")!);
  assert.match(xml, /Договір № 1 &lt;&amp;&gt;/, "🔴 текст у Word не екрановано або загублено");
  assert.match(xml, /Рядок 1<\/w:t><\/w:r><w:r>[\s\S]*?<w:br\/>[\s\S]*?Рядок 2/, "🔴 перенос рядка всередині абзацу загублено");
  assert.deepEqual(["a.docx", "b.TXT", "c.jpeg", "d.png", "e.pdf", "f.xlsx", "g"].map(cv.toPdfKind),
    ["docx", "txt", "image/jpeg", "image/png", null, null, null], "🔴 у PDF пропускається не той формат");
  assert.throws(() => cv.imagePageHtml("image/png", "не base64 <script>"), /пошкоджена/, "🔴 пошкоджена картинка пройшла в сторінку");
  assert.match(cv.textPageHtml(["<b>x</b>"]), /&lt;b&gt;x&lt;\/b&gt;/, "🔴 текст файла потрапляє в HTML без екранування");
  assert.equal(cv.outName("Заявка №5 (копія).pdf", "docx"), "Заявка _5 _копія_.docx");
});

/**
 * #1129 — МАКЕТ ІЗОЛЬОВАНИЙ І БЕЗ GOOGLE (рішення Романа 30.09.2026: шрифти макета — лише в цих розділах, зі свого
 * сервера). Кожне правило `constructor.css` — під `.ctorx`; `mockFonts.css` посилається лише на файли в репозиторії.
 * 🧨 Червоніє, якщо правило макета вилізе на весь дашборд (`.btn{…}` без префікса перефарбував би кнопки всюди)
 * або шрифт піде з fonts.googleapis.com.
 */
test("#1129 МАКЕТ ІЗОЛЬОВАНИЙ: усі селектори під .ctorx, шрифти — з репозиторію, не з Google", () => {
  const css = readFileSync(path.join(REPO, "frontend", "src", "pages", "dashboard", "sections", "constructor.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const sels: string[] = [];
  const walk = (text: string) => {
    let i = 0;
    while (i < text.length) {
      const j = text.indexOf("{", i); if (j < 0) break;
      const sel = text.slice(i, j).trim(); let d = 0, k = j;
      for (; k < text.length; k++) { if (text[k] === "{") d++; else if (text[k] === "}" && --d === 0) break; }
      if (sel.startsWith("@media")) walk(text.slice(j + 1, k)); else sels.push(sel);
      i = k + 1;
    }
  };
  walk(css);
  assert.ok(sels.length > 100, "🔴 CSS макета порожній — перевірці нічого перевіряти");
  const leak = sels.flatMap((s) => s.split(",").map((x) => x.trim())).filter((x) => !/^(:root\[data-theme="dark"\] )?\.ctorx\b/.test(x));
  assert.deepEqual(leak, [], "🔴 правило макета діє поза розділом конструктора");
  const fonts = readFileSync(path.join(REPO, "frontend", "src", "pages", "dashboard", "sections", "mockFonts.css"), "utf8");
  assert.doesNotMatch(fonts, /googleapis|gstatic|https?:/, "🔴 шрифт вантажиться з інтернету, а не з нашого сервера");
  const urls = [...fonts.matchAll(/url\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(urls.length >= 6, "🔴 шрифтів макета немає");
  for (const u of urls) readFileSync(path.join(REPO, "frontend", "src", "pages", "dashboard", "sections", u)); // файл існує — інакше кине
});

/**
 * #1172 — СТРОК ДІЇ ОСНОВНОГО ДОГОВОРУ (п. 8.1, рішення Романа 01.10.2026). У шаблоні було зашито «діє до
 * 31 грудня 2024 року». Тепер: введене «Діє до» (ДД.ММ.РРРР) потрапляє і у Word, і в PDF; порожнє —
 * 31 грудня року дати договору; кривий формат чи дата без року — документ не формується, а не виходить
 * із вигаданим строком.
 * 🧨 Червоніє, якщо повернути зашитий рік, забути підстановку в одному з двох виходів або пропустити кривий формат.
 */
test("#1172 СТРОК ДОГОВОРУ: «Діє до» у Word і PDF; порожнє — 31 грудня року договору; кривий формат — не формується", () => {
  const base = ref["main-uts"].state;
  const st = (p: Partial<DocumentState>) => ({ ...base, ...p }) as DocumentState;
  // Обидва боки межі: введене значення і порожнє.
  assert.equal(mainUntilText(st({ mainUntil: "31.12.2027" })), "31 грудня 2027");
  assert.equal(mainUntilText(st({ mainUntil: "05.03.2028" })), "5 березня 2028");
  assert.equal(mainUntilText(st({ mainUntil: "", mainDate: "01.10.2026" })), "31 грудня 2026", "🔴 порожнє — не 31 грудня року договору");
  assert.equal(mainUntilText(st({ mainUntil: "", mainDate: "15.01.2027" })), "31 грудня 2027");
  // Кривий формат і рік, якого нема звідки взяти, — строк невідомий, документ блокується словами.
  for (const bad of ["31.02.2027", "2027-12-31", "до кінця року"]) {
    assert.equal(mainUntilText(st({ mainUntil: bad })), null, `🔴 «${bad}» прийнято за дату`);
    assert.match(blockers(st({ mainUntil: bad })) ?? "", /ДД\.ММ\.РРРР/, `🔴 «${bad}»: документ формується з кривим строком`);
  }
  assert.ok(blockers(st({ mainUntil: "", mainDate: "з понеділка" })), "🔴 строк без року не заблоковано");
  assert.equal(blockers(st({ mainUntil: "31.12.2027" })), null, "🔴 правильний строк заблоковано");

  // У ДВОХ виходах — та сама дата, і зашитого року більше немає.
  const a = fakeAssets();
  try {
    const s = st({ mainUntil: "31.12.2027" });
    const xml = new TextDecoder().decode(unzipStored(buildDocx(s, s.mainNo, loadDocImages(a.dir, s.ent, s.stamp))).get("word/document.xml")!);
    const html = printHTML(s, s.mainNo, docImageDataUris(a.dir, s.ent, s.stamp));
    for (const [name, out] of [["Word", xml], ["PDF", html]] as const) {
      assert.ok(out.includes("діє до 31 грудня 2027 року"), `🔴 ${name}: введений строк не потрапив у п. 8.1`);
      assert.ok(!out.includes("@UNTIL@") && !out.includes("2024 року"), `🔴 ${name}: лишилась мітка або зашитий рік`);
    }
  } finally { a.dispose(); }
  assert.ok(!SRC("constructor/data/legalTexts.ts").includes("31 грудня 2024"), "🔴 у шаблоні знову зашитий строк");
});

/**
 * #1172b — «ДІЄ ДО» ЗБЕРІГАЄТЬСЯ З ДОКУМЕНТОМ: колонка в схемі, запис у POST /documents, повернення в стан
 * при відкритті з архіву, форма приймає поле. Без цього версія 2 того самого договору мовчки повернулась би
 * до «31 грудня року договору».
 * 🧨 Червоніє, якщо прибрати колонку, не записати поле або не підняти його назад у стан.
 */
test("#1172b «ДІЄ ДО» ЗБЕРІГАЄТЬСЯ: колонка, запис, відновлення з архіву, форма", () => {
  assert.match(SRC("db/schema.sql"), /ALTER TABLE constructor_documents ADD COLUMN IF NOT EXISTS main_until text;/, "🔴 немає колонки main_until");
  const route = SRC("routes/constructor.ts");
  const ins = route.slice(route.indexOf("INSERT INTO constructor_documents"), route.indexOf("RETURNING id, version"));
  assert.ok(/\bmain_until\)/.test(ins), "🔴 POST /documents не пише main_until");
  assert.match(route, /s\.doc === "main" \? \(s\.mainUntil \|\| null\) : null\]\);/, "🔴 у main_until іде не s.mainUntil");
  assert.match(route, /const DOC_COLS = "[^"]*\bmain_until\b/, "🔴 відкриття з архіву не читає main_until");
  assert.match(route, /mainUntil: String\(row\.main_until \|\| ""\)/, "🔴 стан з архіву без mainUntil");
  assert.equal((stateFromBody({ ent: "uts", doc: "main", mainUntil: " 31.12.2027 " }, { name: "", phone: "" }) as DocumentState).mainUntil, "31.12.2027",
    "🔴 форма не передає «Діє до» в стан");
});
