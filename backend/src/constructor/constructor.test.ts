import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildDocx, expandOrgName, shortOrgName, mainUntilText, blockers, preambleSegs, type DocumentState } from "./services/docgen.js";
import { genitiveName, resolveDirector } from "./services/names.js";
import { ENTITIES } from "./data/entities.js";
import { loadDocImages, docImageDataUris, AssetsMissing } from "./services/docAssets.js";
import { printHTML, fullPageHTML } from "./services/printTemplate.js";
import { normPhone, findPhone, parseRequisites, parseOldDoc } from "./services/requisitesParser.js";
import { canSeeConstructorDoc, stateFromBody, contractMemo } from "./access.js";
import { NR_BODY } from "./data/nonresidentTexts.js";
import { buildTtn, buildCmr, ttnCells, cmrTargets, CMR_SLOTS, TTN_TEMPLATE, CMR_TEMPLATE, waybillBlocker, splitTruck } from "./services/waybills.js";
import { readZip } from "../core/officeParse.js";
import { NR_EN_KEYS, NR_CSS, nrClauses, nrAppRows } from "./services/nonresident.js";
import { validateForm, firstError } from "./validate.js";
import { parseStamps, placeOnPage, stampPdf, StampRefused, type Stamp } from "./services/pdfStamp.js";
import { createRequire } from "node:module";
import { translit, translitParty } from "./services/translit.js";
import { translateNr, GOOGLE_KEYS, TRANSLIT_KEYS } from "./services/nrTranslate.js";
import { deflateSync } from "node:zlib";
import { currentNum } from "./services/docgen.js";

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

type Ref = Record<string, { state: DocumentState & { num: string }; documentXml: string; footerXml: string; media: string[]; printHtml: string }>;
const ref = FIX("docgen-ref.json") as Ref;

/** Тимчасова тека з фальшивими PNG під іменами справжніх — байти не важливі, важлива присутність. */
function fakeAssets(): { dir: string; dispose: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "constructor-assets-"));
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082", "hex");
  for (const f of ["logo-uts.png", "logo-avm.png", "sig-bespyatchuk.png", "sig-kovtonyuk.png", "stamp-uts.png", "stamp-avtomuv.png"]) writeFileSync(path.join(dir, f), png);
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
 * #1120 — WORD ПОСИМВОЛЬНО ЯК У МАКЕТІ (порт `docgen.test.ts` Сергія): з v2 (01.10.2026, оформлення «Б») —
 * 6 конфігурацій (+ АвтоМув клієнт/перевізник) і колонтитул `footer1.xml`; ФОП без печатки й логотипа;
 * вимкнений перемикач прибирає підпис і печатку, логотип юрособи лишається (рішення 14–15.10).
 * Фікстура знеособлена й без картинок; що наш злитий код дає ТІ САМІ байти, що еталони пакета v2 на справжніх
 * реквізитах і картинках, доведено окремою звіркою 01.10.2026 (6/6 Word, колонтитул, media, HTML; CSS = макет).
 * 🧨 Червоніє на будь-якій зміні юртексту, таблиці умов, реквізитів чи розкладки підписів у `docgen.ts`.
 */
test("#1120 WORD ЯК У МАКЕТІ: document.xml посимвольно в 4 конфігураціях; ФОП без печатки; перемикач вимикає картинки", () => {
  const a = fakeAssets();
  try {
    assert.ok(Object.keys(ref).length >= 6, "🔴 фікстура порожня або без конфігурацій АвтоМув — перевірці нічого порівнювати");
    for (const [name, r] of Object.entries(ref)) {
      const zip = buildDocx(r.state, r.state.num, loadDocImages(a.dir, r.state.ent, r.state.stamp));
      assert.deepEqual([zip[0], zip[1]], [0x50, 0x4b], `🔴 «${name}»: не zip`);
      const files = unzipStored(zip);
      const xml = new TextDecoder().decode(files.get("word/document.xml")!);
      assert.equal(normXml(xml), normXml(r.documentXml), `🔴 «${name}»: Word розійшовся з затвердженим макетом`);
      assert.equal(new TextDecoder().decode(files.get("word/footer1.xml")!), r.footerXml, `🔴 «${name}»: колонтитул Word розійшовся з макетом`);
      assert.deepEqual([...files.keys()].filter((n) => n.startsWith("word/media/")).sort(), r.media, `🔴 «${name}»: інший набір картинок`);
    }
    const fop = loadDocImages(a.dir, "fop", true);
    assert.ok(fop.sig && !fop.stamp && !fop.logo, "🔴 у ФОП зʼявилась печатка чи логотип або зник підпис (рішення 29.09, 14.10)");
    assert.deepEqual(ref["carr-fop"].media, ["word/media/sig.png"]);
    const off = unzipStored(buildDocx({ ...ref["once-client-uts"].state, stamp: false }, "1", loadDocImages(a.dir, "uts", false)));
    assert.deepEqual([...off.keys()].filter((n) => n.startsWith("word/media/")), ["word/media/logo.png"], "🔴 вимкнений перемикач лишив підпис/печатку або прибрав логотип");
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
  assert.match(PRINT_CSS, /@page\{size:A4;margin:10mm 11mm 15mm 11mm\}/, "🔴 поля не як у пакеті v2 (низ 15 мм — під колонтитул)");
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
 * #1190 — СТРОК ДІЇ ОСНОВНОГО ДОГОВОРУ (п. 8.1, рішення Романа 01.10.2026). У шаблоні було зашито «діє до
 * 31 грудня 2024 року». Тепер: введене «Діє до» (ДД.ММ.РРРР) потрапляє і у Word, і в PDF; порожнє —
 * 31 грудня року дати договору; кривий формат чи дата без року — документ не формується, а не виходить
 * із вигаданим строком.
 * 🧨 Червоніє, якщо повернути зашитий рік, забути підстановку в одному з двох виходів або пропустити кривий формат.
 */
test("#1190 СТРОК ДОГОВОРУ: «Діє до» у Word і PDF; порожнє — 31 грудня року договору; кривий формат — не формується", () => {
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
 * #1190b — «ДІЄ ДО» ЗБЕРІГАЄТЬСЯ З ДОКУМЕНТОМ: колонка в схемі, запис у POST /documents, повернення в стан
 * при відкритті з архіву, форма приймає поле. Без цього версія 2 того самого договору мовчки повернулась би
 * до «31 грудня року договору».
 * 🧨 Червоніє, якщо прибрати колонку, не записати поле або не підняти його назад у стан.
 */
test("#1190b «ДІЄ ДО» ЗБЕРІГАЄТЬСЯ: колонка, запис, відновлення з архіву, форма", () => {
  assert.match(SRC("db/schema.sql"), /ALTER TABLE constructor_documents ADD COLUMN IF NOT EXISTS main_until text;/, "🔴 немає колонки main_until");
  const route = SRC("routes/constructor.ts");
  const ins = route.slice(route.indexOf("INSERT INTO constructor_documents"), route.indexOf("RETURNING id, version"));
  assert.ok(/\bmain_until\)/.test(ins), "🔴 POST /documents не пише main_until");
  // з 14.10.2026 «діє до» пишуть обидва договори — основний і з нерезидентом (`isContract`, services/nonresident.ts)
  assert.match(route, /isContract\(s\) \? \(s\.mainUntil \|\| null\) : null\]\);/, "🔴 у main_until іде не s.mainUntil");
  assert.match(route, /const DOC_COLS = "[^"]*\bmain_until\b/, "🔴 відкриття з архіву не читає main_until");
  assert.match(route, /mainUntil: String\(row\.main_until \|\| ""\)/, "🔴 стан з архіву без mainUntil");
  assert.equal((stateFromBody({ ent: "uts", doc: "main", mainUntil: " 31.12.2027 " }, { name: "", phone: "" }) as DocumentState).mainUntil, "31.12.2027",
    "🔴 форма не передає «Діє до» в стан");
});

/**
 * #1186 — ОФОРМЛЕННЯ «Б» (пакет v2, рішення 14–15.10): логотип своєї юрособи (ЮТС, АвтоМув; ФОП — без), рамка
 * «Адреса для надсилання оригіналів» лише в документах ЮТС, колонтитул Word з полями PAGE/NUMPAGES, клас щільності
 * в повній сторінці; Word бере ту саму щільність, що PDF.
 * 🧨 Червоніє, якщо рамку дати АвтоМув/ФОП, загубити логотип або Word перестане слухатись щільності.
 */
test("#1186 ОФОРМЛЕННЯ «Б»: логотип юрособи, рамка адреси лише ЮТС, колонтитул X з Y, щільність Word = PDF", () => {
  const a = fakeAssets();
  try {
    const has = (k: string) => ref[k].documentXml.includes("Адреса для надсилання оригіналів документів");
    assert.deepEqual(["once-client-uts", "carr-uts", "main-uts"].map(has), [true, true, true], "🔴 у документі ЮТС немає рамки адреси для оригіналів");
    assert.deepEqual(["once-client-avm", "carr-avm", "carr-fop"].map(has), [false, false, false], "🔴 рамку ЮТС (отримувач ТОВ «ЮТС») дано АвтоМув чи ФОП");
    assert.ok(ref["once-client-avm"].media.includes("word/media/logo.png") && !ref["carr-fop"].media.includes("word/media/logo.png"), "🔴 логотип: АвтоМув без свого або ФОП із чужим");
    const f = ref["carr-uts"].footerXml;
    assert.ok(f.includes("Заявка-договір № 61575919") && f.includes('w:instr=" PAGE "') && f.includes('w:instr=" NUMPAGES "'), "🔴 колонтитул Word без № чи номерів сторінок");
    const r = ref["carr-uts"]; const img = loadDocImages(a.dir, "uts", true);
    const xml = (dens?: "dc" | "d95") => new TextDecoder().decode(unzipStored(buildDocx(r.state, r.state.num, img, dens)).get("word/document.xml")!);
    assert.equal(xml(), xml("dc"), "🔴 без щільності перевізницька має стартувати з dc");
    assert.notEqual(xml("d95"), xml("dc"), "🔴 щільність не міняє Word — Word і PDF розійдуться в кількості сторінок");
    assert.ok(fullPageHTML(r.state, r.state.num, {}, "d95").includes('<div class="docfmt doc-b ent-uts dens-d95">'), "🔴 повна сторінка без класів «Б»");
    assert.ok(fullPageHTML(ref["once-client-uts"].state, "1", {}).includes('<div class="docfmt doc-b ent-uts dens-d1">'), "🔴 клієнтська має стартувати з d1");
  } finally { a.dispose(); }
});

/**
 * #1187 — АВТОПІДГОНКА ПІД 3 СТОРІНКИ без браузера (порт `pdfRenderer.test.ts` пакета): влізла одразу — один рендер;
 * 4-та сторінка — крок щільніше; не влізла навіть у d95 — `overflow`; основний договір — dm без підгонки.
 * Рендер підмінено «PDF» із заданою кількістю сторінок.
 * 🧨 Червоніє, якщо прибрати крок щільніше або вважати 8 сторінок договору «переповненням».
 */
test("#1187 АВТОПІДГОНКА: d1→dc→d95 до 3 сторінок, інакше overflow; договір — dm без підгонки", async () => {
  const { renderDocumentPdf, countPdfPages } = await import("./services/pdfRenderer.js");
  const fake = (n: number) => new TextEncoder().encode("%PDF " + "<< /Type /Pages >> " + "<< /Type /Page >> ".repeat(n));
  assert.equal(countPdfPages(fake(3)), 3, "🔴 лічильник сторінок рахує /Pages або губить сторінки");
  const run = async (state: DocumentState, pagesByDens: Record<string, number>) => {
    const seen: string[] = [];
    const out = await renderDocumentPdf(state, "1", {}, async (html) => {
      const dens = /class="docfmt doc-b ent-\w+ dens-(d1|dc|d95|dm)"/.exec(html)![1]; seen.push(dens); return fake(pagesByDens[dens]);
    });
    return { seen, out };
  };
  const once = ref["once-client-uts"].state, carr = ref["carr-uts"].state, main = ref["main-uts"].state;
  let r = await run(once, { d1: 3 });
  assert.deepEqual([r.seen, r.out.dens, r.out.overflow], [["d1"], "d1", false]);
  r = await run(once, { d1: 4, dc: 4, d95: 3 });
  assert.deepEqual([r.seen, r.out.dens, r.out.pages, r.out.overflow], [["d1", "dc", "d95"], "d95", 3, false], "🔴 немає кроку щільніше");
  r = await run(carr, { dc: 5, d95: 4 });
  assert.deepEqual([r.seen, r.out.overflow, r.out.pages], [["dc", "d95"], true, 4], "🔴 непомічене переповнення — менеджер не отримає попередження");
  r = await run(main, { dm: 8 });
  assert.deepEqual([r.seen, r.out.overflow], [["dm"], false], "🔴 основний договір підганяється або 8 сторінок вважаються переповненням");
});

/**
 * #1188 — CSS ДОКУМЕНТА ЦІЛИЙ (порт перевірки пакета): дужки збалансовані, правило шапки `.dband` ціле (у v1 обрізалось —
 * PDF друкувався без стилів шапки), є рамка адреси, ховання спейсера в друці і захист від різаних рядків/печаток.
 * Що DOC_CSS ДОСЛІВНО = CSS макета v20, доведено звіркою 01.10.2026 (макет у репозиторій не кладемо).
 */
test("#1188 CSS ДОКУМЕНТА: дужки збалансовані, шапка ціла, рамка адреси, друк без порожньої сторінки", async () => {
  const { DOC_CSS } = await import("./data/docCss.js");
  assert.equal((DOC_CSS.match(/{/g) || []).length, (DOC_CSS.match(/}/g) || []).length, "🔴 дужки CSS не збалансовані — частина правил мовчки зникне");
  assert.match(DOC_CSS, /\.docfmt \.dband\{[^}]*margin:0 0 10pt\}/, "🔴 правило шапки обрізане (помилка v1)");
  assert.ok(DOC_CSS.includes(".doc-b .orig-mini{"), "🔴 немає стилю рамки адреси для оригіналів");
  assert.ok(DOC_CSS.includes("@media print{.docfmt .sigend{display:none}}"), "🔴 спейсер у друці не схований — порожня остання сторінка");
  assert.ok(DOC_CSS.includes("break-inside:avoid"), "🔴 зник захист від розрізаних печаток і рядків таблиці");
  for (const d of ["d1", "dc", "d95", "dm"]) assert.ok(DOC_CSS.includes(`.dens-${d}`), `🔴 немає щільності ${d}`);
});

/**
 * #1189 — СПРАВЖНІЙ ДРУК (порт `pdf-autofit.integration.ts` пакета): тим самим Chrome, що на сервері, з автопідгонкою —
 * кожна заявка (6 конфігурацій) рівно на 3 сторінках, основний договір — 8; колонтитул «сторінка X з Y» надруковано.
 * Біжить там, де є браузер (`CONSTRUCTOR_CHROME_PATH`): на проді — у прийманні `test:prod`; без браузера — скіп.
 * 🧨 Червоніє, якщо повернути щільність до v1 (заявка перевізнику — 5 сторінок) або зламати колонтитул.
 */
test("#1189 ДРУК PDF: заявки рівно 3 сторінки, договір 8, колонтитул «сторінка X з Y»", async (t) => {
  if (!process.env.CONSTRUCTOR_CHROME_PATH) { t.skip("немає браузера для PDF (CONSTRUCTOR_CHROME_PATH) — на проді гейт біжить у test:prod"); return; }
  const { renderDocumentPdf } = await import("./services/pdfRenderer.js");
  const a = fakeAssets();
  try {
    const pages: Record<string, number> = {}; let footerSeen = false; let footerChecked = false;
    for (const [name, r] of Object.entries(ref)) {
      const fit = await renderDocumentPdf(r.state, r.state.num, docImageDataUris(a.dir, r.state.ent, r.state.stamp));
      pages[name] = fit.pages;
      if (name === "carr-uts") {
        try {
          const txt = execFileSync("pdftotext", ["-", "-"], { input: Buffer.from(fit.pdf) }).toString("utf8");
          footerChecked = true; footerSeen = /Заявка-договір № 61575919/.test(txt) && /сторінка 3 з 3/.test(txt);
        } catch { /* pdftotext немає — колонтитул перевіряє #1186 (Word) і очі приймання */ }
      }
    }
    for (const [name, n] of Object.entries(pages)) {
      if (name === "main-uts") assert.equal(n, 8, `🔴 основний договір: ${n} стор. замість 8 (усі: ${JSON.stringify(pages)})`);
      else assert.equal(n, 3, `🔴 «${name}»: ${n} стор. замість рівно 3 (усі: ${JSON.stringify(pages)})`);
    }
    if (footerChecked) assert.ok(footerSeen, "🔴 у PDF немає колонтитула «Заявка-договір № … · сторінка X з Y»");
  } finally { a.dispose(); }
});

/**
 * #1195 — IBAN ПЕРЕВІЗНИКА НЕОБОВʼЯЗКОВИЙ (02.10.2026, рішення в чаті команди: Юля «можна», перевізник однаково
 * виставляє рахунок з IBAN). Заявка перевізнику без IBAN формується; у його картці реквізитів немає рядка «п/р»,
 * а в картці експедитора — є. Дзеркало: інші гейти (№ угоди) не зняті разом із цим.
 * 🧨 Червоніє, якщо повернути перевірку «Немає IBAN перевізника».
 */
test("#1195 IBAN ПЕРЕВІЗНИКА НЕОБОВʼЯЗКОВИЙ: заявка формується, у картці перевізника немає «п/р», № угоди — досі обовʼязковий", () => {
  const base = ref["carr-uts"].state;
  const noIban = { ...base, cp: { ...base.cp, iban: "" } };
  assert.equal(blockers(noIban), null, "🔴 заявку перевізнику без IBAN знову заблоковано");
  const html = printHTML(noIban, noIban.num, {});
  const theirs = html.slice(html.indexOf("<h4>ПЕРЕВІЗНИК</h4>"), html.indexOf("<h4>ЕКСПЕДИТОР</h4>"));
  const ours = html.slice(html.indexOf("<h4>ЕКСПЕДИТОР</h4>"));
  assert.ok(theirs.length > 20 && ours.length > 20, "🔴 карток реквізитів не знайдено — перевіряти нічого");
  assert.ok(!/п\/р/.test(theirs), "🔴 у картці перевізника лишився порожній рядок «п/р»");
  assert.ok(/п\/р UA/.test(ours), "🔴 зник рахунок експедитора — правка зачепила не ту сторону");
  assert.ok(/п\/р/.test(printHTML(base, base.num, {}).split("<h4>ЕКСПЕДИТОР</h4>")[0]), "🔴 з IBAN рядок «п/р» перевізника має бути");
  assert.match(blockers({ ...noIban, dealNo: "" }) ?? "", /№ заявки/, "🔴 разом з IBAN зник гейт № угоди");
});

/**
 * #1196 — ЕКРАН НЕ ВИДАЄ IBAN ПЕРЕВІЗНИКА ЗА ОБОВʼЯЗКОВИЙ (02.10.2026, скрін Романа: «досі наче обовʼязковий»):
 * для заявки перевізнику порожні IBAN і Банк — сіре «—» і «необовʼязково», а не оранжеве «!» і «впишіть вручну»;
 * старої заборони «без IBAN не сформувати» на екрані немає. Дзеркало: інші порожні поля й далі позначені «!».
 */
test("#1196 ЕКРАН: IBAN і банк перевізника позначено необовʼязковими, решта порожніх полів — «!»", () => {
  const src = readFileSync(path.join(REPO, "frontend", "src", "pages", "dashboard", "sections", "ConstructorSection.tsx"), "utf8");
  assert.match(src, /const optional = form\.party === "carrier" && \(k === "iban" \|\| k === "bank"\);/, "🔴 IBAN/банк перевізника знову виглядають обовʼязковими");
  assert.match(src, /optional \? "opt" : "no"/, "🔴 порожнє необовʼязкове поле отримує оранжеве «!»");
  assert.match(src, /optional \? "—" : "!"/, "🔴 зникла позначка «!» для решти порожніх полів");
  assert.doesNotMatch(src, /Без IBAN перевізника заявку не сформувати/, "🔴 на екрані знову заборона без IBAN");
});

/**
 * #1640 — ПОРОЖНІ НЕОБОВʼЯЗКОВІ РЯДКИ НЕ ДРУКУЮТЬСЯ (задача 5460, рішення Сергія 12.10.2026: і у внутрішній, і в
 * міжнародній заявці — «у заявці не критично»). Обовʼязкові лишаються навіть порожніми — з «—». Word і HTML однаково.
 * 🧨 Червоніє, якщо повернути «—» для порожніх необовʼязкових або сховати порожній обовʼязковий рядок.
 */
test("#1640 ТАБЛИЦЯ УМОВ: порожні необовʼязкові рядки прибрано (внутр. і міжнар.), обовʼязкові лишаються з «—»", () => {
  const a = fakeAssets();
  try {
    for (const [name, intl] of [["once-client-uts", false], ["carr-uts", false], ["once-client-avm", true], ["carr-avm", true]] as const) {
      const base = ref[name].state;
      const s = { ...base, intl, trip: { ...base.trip, places: "", special: "", shipperC: "", consigneeC: "", reqs: "", truck: "", driver: "", otherResp: "", extra: "", custAddr: "", border: "", decustAddr: "", loadDate: "" } };
      const html = printHTML(s, s.num, {});
      const xml = new TextDecoder().decode(unzipStored(buildDocx(s, s.num, loadDocImages(a.dir, s.ent, s.stamp))).get("word/document.xml")!);
      for (const label of ["Дані водія", "Додаткові умови", "Пункт переходу кордону", "Транспортний засіб: марка"]) {
        assert.ok(!html.includes(label), `🔴 «${name}»: порожній необовʼязковий рядок «${label}» надруковано в PDF`);
        assert.ok(!xml.includes(label), `🔴 «${name}»: порожній необовʼязковий рядок «${label}» надруковано у Word`);
      }
      assert.match(html, /Дата, час навантаження<\/td><td class="v2">—</, `🔴 «${name}»: порожній ОБОВʼЯЗКОВИЙ рядок зник`);
      assert.ok(html.includes("Маршрут перевезення") && html.includes("Нормативний простій"), `🔴 «${name}»: зникли обовʼязкові рядки`);
    }
    const filled = printHTML(ref["once-client-uts"].state, "1", {});
    assert.ok(filled.includes("Дані водія"), "🔴 заповнений необовʼязковий рядок зник разом із порожніми");
  } finally { a.dispose(); }
});

/**
 * #1641 — ВАЛЮТА «на день розвантаження», «ІНШЕ…» В ОПЛАТІ, ПРОСТІЙ АВТОМУВ 24 ГОД (задачі 5452, 5453, fb105; 12.10.2026).
 * Власний текст оплати друкується дослівно; простій АвтоМув — 24 год і в коді, і в сиді юросіб (схема).
 */
test("#1641 ОПЛАТА: € на день розвантаження і власний текст друкуються дослівно; простій АвтоМув — 24 год", () => {
  const base = ref["once-client-avm"].state;
  const s = { ...base, pay: { ...base.pay, sum: "1 200", cur: "€ по курсу НБУ на день розвантаження", order: "50% передоплата, 50% після розвантаження" } };
  const html = printHTML(s, s.num, {});
  assert.ok(html.includes("1 200 € по курсу НБУ на день розвантаження"), "🔴 нова валюта не друкується в ціні");
  assert.ok(html.includes("50% передоплата, 50% після розвантаження"), "🔴 власний текст оплати не надруковано");
  assert.match(html, /Нормативний простій<\/td><td class="v2">24 години/, "🔴 простій АвтоМув не 24 год");
  assert.match(SRC("db/schema.sql"), /\('avm', 'AVM'[^\n]*'24 години на завантаження\/розвантаження \(внутрішні\)/, "🔴 у сиді юросіб простій АвтоМув лишився 4 год");
  const ui = readFileSync(path.join(REPO, "frontend", "src", "pages", "dashboard", "sections", "ConstructorSection.tsx"), "utf8");
  assert.ok(ui.includes("<option>€ по курсу НБУ на день розвантаження</option>"), "🔴 на екрані немає варіанта валюти «на день розвантаження»");
  assert.match(ui, /<option value=\{OTHER\}>Інше…<\/option>/, "🔴 на екрані немає «Інше…» в порядку оплати");
});

/**
 * #1642 — МІЖНАРОДНІ ЛИШЕ ВІД АВТОМУВ (задача 5462, рішення Сергія 12.10.2026: «тільки автомув»): галочка ставить
 * АвтоМув, інші юрособи недоступні, а сервер не дасть сформувати міжнародну від ЮТС чи ФОП навіть в обхід екрана.
 */
test("#1642 МІЖНАРОДНІ — ЛИШЕ АВТОМУВ: галочка ставить АвтоМув, інші юрособи вимкнено, сервер блокує ЮТС/ФОП", async () => {
  const { validateForm } = await import("./validate.js");
  const s = ref["once-client-uts"].state;
  for (const ent of ["uts", "fop"] as const) {
    const xs = validateForm({ ...s, ent, intl: true }, { today: "2026-10-12" });
    assert.ok(xs.some((i) => i.field === "ent" && i.level === "error"), `🔴 міжнародну від ${ent} не заблоковано`);
  }
  assert.ok(!validateForm({ ...s, ent: "avm", intl: true }, { today: "2026-10-12" }).some((i) => i.field === "ent"), "🔴 міжнародну від АвтоМув заблоковано");
  assert.ok(!validateForm({ ...s, ent: "uts", intl: false }, { today: "2026-10-12" }).some((i) => i.field === "ent"), "🔴 внутрішню від ЮТС заблоковано");
  const ui = readFileSync(path.join(REPO, "frontend", "src", "pages", "dashboard", "sections", "ConstructorSection.tsx"), "utf8");
  assert.match(ui, /intl: on, ent: on \? "avm" : f\.ent/, "🔴 галочка «Міжнародне» не ставить АвтоМув");
  assert.match(ui, /disabled=\{form\.intl && k !== "avm"\}/, "🔴 при міжнародному можна обрати ЮТС чи ФОП");
});

/* ══════════════ 🖋 «В ОСОБІ ДИРЕКТОРА …» У РОДОВОМУ, «ЯКИЙ/ЯКА ДІЄ» ЗА РОДОМ (задача 5461, 13.10.2026) ══════════════ */

const withCp = (cp: DocumentState["cp"], ent: DocumentState["ent"] = "uts"): DocumentState =>
  ({ ...ref["once-client-uts"].state, ent, cp: { name: "ТОВ «Альфа»", ...cp } });
const preamble = (s: DocumentState) => preambleSegs(s).map((x) => x.t).join("");

/**
 * #1680 — ВІДМІНЮВАННЯ ПО ОБИДВА БОКИ МЕЖІ РОДУ (правило 11): чоловічі й жіночі прізвища тих типів, що ламаються
 * по-різному (-ук, -енко, -ець, -ий/-а, -ар, подвійне), і обидва — у тій самій функції. 🧨 Прибрати відмінювання
 * (повернути вхід) — червоніє на кожному рядку; переплутати рід — на кожній парі.
 */
test("#1680 ПІБ У РОДОВОМУ: чоловічі й жіночі прізвища різних типів відмінюються правильно", async () => {
  for (const [nom, gen] of [
    ["Беспятчук Сергій Степанович", "Беспятчука Сергія Степановича"],
    ["Ковтонюк Тетяна Миколаївна", "Ковтонюк Тетяни Миколаївни"],
    ["Шевченко Тарас Григорович", "Шевченка Тараса Григоровича"],
    ["Кравець Микола Олексійович", "Кравця Миколи Олексійовича"],
    ["Довгий Ігор Петрович", "Довгого Ігоря Петровича"],
    ["Біла Інна Сергіївна", "Білої Інни Сергіївни"],
    ["Бондар Наталія Іванівна", "Бондар Наталії Іванівни"],
    ["Косач-Квітка Лариса Петрівна", "Косач-Квітки Лариси Петрівни"],
  ]) assert.equal((await genitiveName(nom)).gen, gen, `🔴 «${nom}» у родовому`);
  // наші директори в довіднику юросіб — те саме, що дає бібліотека (статичне значення не розійдеться мовчки)
  for (const k of ["uts", "avm", "fop"] as const) {
    const e = ENTITIES[k];
    const r = await genitiveName(e.dir);
    assert.equal(e.dirGen, r.gen, `🔴 ${k}: dirGen у довіднику ≠ відмінюванню`);
    assert.equal(e.dirFem, r.fem, `🔴 ${k}: dirFem у довіднику ≠ роду`);
  }
});

/**
 * #1681 — «ЯКИЙ/ЯКА ДІЄ» ЗА РОДОМ ДЛЯ ОБОХ СТОРІН І ДЛЯ ФОП. Було: «в особі директора Ковтонюк Тетяна Миколаївна,
 * який діє» в КОЖНОМУ документі від АвтоМув. 🧨 Поставити «який» усім — червоніє на АвтоМув і на жінці-контрагенті;
 * «яка» усім — на ЮТС і на чоловіку.
 */
test("#1681 ПРЕАМБУЛА: «в особі директора <родовий>, який/яка діє» за родом — наша сторона, контрагент, ФОП", async () => {
  const fem = withCp({ dir: "Бондар Наталія Іванівна" }, "avm");
  await resolveDirector(fem);
  const p1 = preamble(fem);
  assert.ok(p1.includes("в особі директора Бондар Наталії Іванівни, яка діє на підставі Статуту"), "🔴 контрагент-жінка: " + p1);
  assert.ok(p1.includes("в особі директора Ковтонюк Тетяни Миколаївни, яка діє на підставі Статуту"), "🔴 АвтоМув: " + p1);
  const male = withCp({ dir: "Кравець Микола Олексійович" }, "uts");
  await resolveDirector(male);
  const p2 = preamble(male);
  assert.ok(p2.includes("в особі директора Кравця Миколи Олексійовича, який діє"), "🔴 контрагент-чоловік: " + p2);
  assert.ok(p2.includes("в особі директора Беспятчука Сергія Степановича, який діє"), "🔴 ЮТС: " + p2);
  const fop = withCp({ name: "ФОП Коваль Ольга Вікторівна" }, "uts");
  await resolveDirector(fop);
  assert.ok(preamble(fop).includes("Коваль Ольга Вікторівна, далі — Замовник, яка діє на підставі виписки"), "🔴 ФОП-жінка: " + preamble(fop));
  // Word бере ту саму преамбулу, PDF — теж: перевіряємо, що дійшло до обох
  const html = printHTML(fem, "1", {});
  assert.ok(html.includes("Бондар Наталії Іванівни"), "🔴 PDF без родового відмінка");
});

/**
 * #1682 — ІНІЦІАЛИ: рід невідомий → 🟡 і чоловічий до вибору; вибрано Ж → жіночий відмінок. 🧨 Ігнорувати вибраний
 * рід — червоніє на «Іванової»; мовчки вгадувати без 🟡 — на попередженні.
 */
test("#1682 ІНІЦІАЛИ: без роду — 🟡 і «Іванова І. І.», з вибраним Ж — «Іванової І. І., яка діє»", async () => {
  const guess = withCp({ dir: "Іванова І. І." });
  const r1 = await resolveDirector(guess);
  assert.equal(r1.how, "guess");
  assert.ok(r1.issues.some((i) => i.field === "cp.dir" && i.level === "warn" && /рід/.test(i.msg)), "🔴 немає 🟡 «оберіть рід»");
  const chosen = withCp({ dir: "Іванова І. І.", dirGender: "f" });
  const r2 = await resolveDirector(chosen);
  assert.equal(r2.how, "chosen");
  assert.equal(r2.issues.length, 0, "🔴 рід вибрано, а 🟡 лишилось");
  assert.ok(preamble(chosen).includes("в особі директора Іванової І. І., яка діє"), "🔴 вибраний рід проігноровано: " + preamble(chosen));
});

/**
 * #1683 — РУЧНА ПРАВКА ПОНАД АВТОМАТИЧНУ, А `dirGen` З КЛІЄНТА НЕ ДОВІРЯЄТЬСЯ. 🧨 Ігнорувати `dirGenHand` — червоніє;
 * взяти `dirGen` з тіла запиту як є — червоніє на «підробці».
 */
test("#1683 РУЧНИЙ РОДОВИЙ перекриває автоматичний; `dirGen` із клієнта перераховується", async () => {
  const hand = withCp({ dir: "Огли Рустам Огли", dirGenHand: "Огли Рустама Огли-огли" });
  await resolveDirector(hand);
  assert.ok(preamble(hand).includes("в особі директора Огли Рустама Огли-огли,"), "🔴 ручну правку проігноровано");
  const forged = withCp({ dir: "Бондар Наталія Іванівна", dirGen: "підробка", dirFem: "" });
  await resolveDirector(forged);
  assert.equal(forged.cp.dirGen, "Бондар Наталії Іванівни", "🔴 `dirGen` із клієнта пройшов у документ");
  assert.equal(forged.cp.dirFem, "1");
});

/**
 * #1684 — ПІБ, ВПИСАНЕ ВЖЕ В РОДОВОМУ («Ковтонюк Тетяни Миколаївни» з тексту старого договору), не відмінюється вдруге
 * і дає 🟡. Заміряно 13.10.2026: таких 9 із 237 записів. 🧨 Прибрати перевірку — вийде «…Миколаївниї», червоніє.
 * І старий архівний запис БЕЗ `dirGen` рендериться так, як його видали — у називному (правило «архів не переписується»).
 */
test("#1684 ПІБ У РОДОВОМУ НА ВХОДІ — без подвійного відмінювання й з 🟡; архівний запис без `dirGen` — як був", async () => {
  const s = withCp({ dir: "Ковтонюк Тетяни Миколаївни" });
  const r = await resolveDirector(s);
  assert.equal(s.cp.dirGen, "Ковтонюк Тетяни Миколаївни", "🔴 відмінено вдруге: " + s.cp.dirGen);
  assert.equal(s.cp.dirFem, "1");
  assert.ok(r.issues.some((i) => /родовому/.test(i.msg)), "🔴 немає 🟡 «впишіть у називному»");
  const old = withCp({ dir: "Бондар Наталія Іванівна" });   // resolveDirector НЕ кликали — як запис з архіву
  assert.ok(preamble(old).includes("в особі директора Бондар Наталія Іванівна,"), "🔴 архівний запис переписано: " + preamble(old));
});

/* ══════════════ 🌍 ДОГОВІР І ЗАЯВКА ДЛЯ НЕРЕЗИДЕНТА (задачі 5144 / 5284 / 5463, 14.10.2026) ══════════════ */

const NR_MGR = { name: "Андрусенко Богдана", phone: "+380 99 000 00 00" };
const NR_CP = { name: "Test Trading SRL", lawUa: "Республіки Молдова", lawEn: "the Republic of Moldova", dir: "Ion Popescu",
  addr: "1 Test str., Chisinau", regNo: "100000", bankText: "Bank: Test Bank\nSWIFT: TESTMD2X", email: "office@test.md" };
const nrState = (over: Record<string, unknown> = {}) => stateFromBody({ ent: "avm", doc: "nrmain", cp: NR_CP, trip: {}, pay: {}, docDate: "2026-10-14", ...over }, NR_MGR) as DocumentState;
const txt = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
const docxTxt = (s: DocumentState) => new TextDecoder().decode(unzipStored(buildDocx(s, currentNum(s), {})).get("word/document.xml")!)
  .replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

/**
 * #1730 — ТЕКСТ ДОГОВОРУ ПЕРЕНЕСЕНО ЦІЛИМ (Word-шаблон АвтоМув): 8 розділів по порядку, у КОЖНОМУ пункті номер в
 * українській колонці = номер в англійській (так ловиться загублений/зсунутий пункт — шаблон сам конвертований з PDF:
 * «5.4.» і «2.2.» були загублені), даних справжнього клієнта не лишилось, кожна мітка рівно один раз.
 * 🧨 Прибрати пункт з однієї колонки, повернути «Five Grains»/«31.12.2026» чи загубити мітку — червоніє.
 */
test("#1730 ДОГОВІР З НЕРЕЗИДЕНТОМ: 8 розділів, номери пунктів UA = EN, без даних клієнта зі шаблону, мітки по разу", () => {
  const num = /^\d+(\.\d+)*\.\s/;
  const secs = NR_BODY.filter((b) => b.h && /^\d+\.\s/.test(b.ua[0])).map((b) => b.ua[0].split(".")[0]);
  assert.deepEqual(secs, ["1", "2", "3", "4", "5", "6", "7", "8"], "🔴 розділи не 1–8 по порядку");
  assert.ok(NR_BODY.length >= 110, `🔴 пунктів ${NR_BODY.length} — текст обрізано`);
  for (const b of NR_BODY) {
    const u = num.exec(b.ua[0])?.[0].trim(), e = num.exec(b.en[0])?.[0].trim();
    assert.ok(u && u === e, `🔴 номери колонок розійшлися: «${b.ua[0].slice(0, 40)}» ↔ «${b.en[0].slice(0, 40)}»`);
  }
  const all = JSON.stringify(NR_BODY);
  for (const bad of ["Five Grains", "BURSKYI", "VITALITE", "31.12.2026", "EUR/23", "  "]) assert.ok(!all.includes(bad), `🔴 у тексті лишилось «${bad}»`);
  for (const [m, n] of [["@LIMIT@", 2], ["@UNTIL@", 2], ["@EMAIL_OUR@", 2], ["@EMAIL_CP@", 2]] as const)
    assert.equal(all.split(m).length - 1, n, `🔴 мітка ${m} не ${n} рази (UA + EN)`);
});

/**
 * #1731 — ЗМІННЕ ПІДСТАВЛЯЄТЬСЯ В ОБИДВІ КОЛОНКИ, У PDF І WORD (Nana 14.10): назва, директор, країна, номер, дата
 * («14» жовтня 2026 / October 14, 2026), «діє до» (п. 6.1: за замовчуванням 31.12 року договору, введене — як є),
 * ліміт (п. 4.7), e-mail сторін (п. 8.5). Мітки не протікають у документ. 🧨 Забути підставити — червоніє.
 */
test("#1731 ДОГОВІР З НЕРЕЗИДЕНТОМ: клієнт, номер, дати, «діє до», ліміт і e-mail — в UA і EN, у PDF і Word", () => {
  const s = nrState({ trip: { limit: "5000" } });
  assert.equal(currentNum(s), "EUR/14/10/2026", "🔴 номер за замовчуванням не EUR/ДД/ММ/РРРР з дати");
  for (const [name, t] of [["PDF", txt(printHTML(s, currentNum(s), {}))], ["Word", docxTxt(s)]] as const) {
    for (const need of ["Test Trading SRL, зареєстроване та діє відповідно до законодавства Республіки Молдова", "в особі директора Ion Popescu",
      "laws of the Republic of Moldova", "№ EUR/14/10/2026 від «14» жовтня 2026 року", "Agreement No. EUR/14/10/2026 dated October 14, 2026",
      "і діє до 31.12.2026 року", "in force until 31.12.2026 and", "не може перевищувати 5000 EUR", "exceed EUR 5000.",
      `Експедитор — ${ENTITIES.avm.email}; Замовник — office@test.md`, "SWIFT: TESTMD2X"])
      assert.ok(t.includes(need), `🔴 ${name}: немає «${need}»`);
    assert.ok(!/@[A-Z_]+@/.test(t), `🔴 ${name}: мітка протекла в документ`);
  }
  const until = nrState({ mainUntil: "30.06.2027" });
  assert.ok(txt(printHTML(until, currentNum(until), {})).includes("і діє до 30.06.2027 року"), "🔴 введене «діє до» проігноровано");
  assert.match(blockers(nrState({ mainUntil: "31.02.2027" })) ?? "", /Діє до/, "🔴 неіснуюча дата «діє до» пройшла");
});

/**
 * #1732 — П. 5.6 ПРОСТІЙ: тент (ізотерм) 150 € замість 120 (Роман 14.10.2026), рефрижератор 150 €, обидві мови.
 * 🧨 Повернути 120 — червоніє.
 */
test("#1732 ПРОСТІЙ 5.6: тент (ізотерм) 150 €, рефрижератор 150 €, 120 € немає — UA і EN", () => {
  const c = nrClauses(nrState()).find((b) => b.ua[0].startsWith("5.6."))!;
  assert.ok(c, "🔴 пункту 5.6 немає");
  assert.match(c.ua.join(" "), /150 EUR за кожну почату добу простою транспортного засобу типу тент \(ізотерм\) та 150 EUR/, "🔴 UA: тент не 150");
  assert.match(c.en.join(" "), /EUR 150 for each commenced day of idle time of a tilt \(isothermal\) vehicle and EUR 150/, "🔴 EN: тент не 150");
  assert.ok(!/\b120\b/.test(c.ua.join(" ") + c.en.join(" ")), "🔴 у п. 5.6 лишилось 120");
});

/**
 * #1733 — ЛИШЕ АВТОМУВ і ДЗЕРКАЛО (DoD п.3): від ЮТС/ФОП — відмова словами; від АвтоМув — формується. Вид
 * документа приймається сервером, ставить «міжнародне», і база його дозволяє (CHECK у schema.sql).
 * 🧨 Дозволити ЮТС — червоніє; заборонити всім — теж.
 */
test("#1733 НЕРЕЗИДЕНТ ЛИШЕ ВІД АВТОМУВ: ЮТС і ФОП — відмова, АвтоМув — формується; вид дозволено в базі", () => {
  for (const ent of ["uts", "fop"]) assert.match(blockers({ ...nrState(), ent: ent as DocumentState["ent"] }) ?? "", /лише від ТОВ «АвтоМув»/, `🔴 ${ent}: пропустило`);
  assert.equal(blockers(nrState()), null, "🔴 АвтоМув: договір не формується (дзеркало)");
  assert.equal(nrState().intl, true, "🔴 договір з нерезидентом не позначено міжнародним");
  assert.equal(typeof stateFromBody({ ent: "avm", doc: "nrapp" }, NR_MGR), "object", "🔴 сервер не приймає вид «заявка нерезиденту»");
  assert.match(SRC("db/schema.sql"), /CHECK \(doc_kind IN \('once','main','carr','nrmain','nrapp'[^)]*\)\)/, "🔴 база не дозволяє нові види документа");
});

/**
 * #1734 — ЗАЯВКА: спершу українська частина, потім англійська; у шапках № і дата договору; англійські значення —
 * з полів менеджера, порожнє → те саме, що українською; лишилась кирилиця — 🟡; без договору — не формується.
 * 🧨 Ігнорувати англійське поле або не підставити договір — червоніє.
 */
test("#1734 ЗАЯВКА НЕРЕЗИДЕНТУ: UA потім EN, № і дата договору в обох, англійське з полів, кирилиця — 🟡", () => {
  const s = nrState({ doc: "nrapp", dealNo: "62741049", mainNo: "EUR/21/09/2026", mainDate: "2026-09-21",
    trip: { route: "Яхни — Колін", routeEn: "Yakhny – Kolin", loadDate: "06.10.2026", extra: "оплата до розвантаження" }, pay: { sum: "2000", cur: "EUR" } });
  assert.equal(blockers(s), null);
  const t = txt(printHTML(s, currentNum(s), {}));
  const ua = t.indexOf("ЗАЯВКА № 62741049"), en = t.indexOf("APPLICATION No. 62741049");
  assert.ok(ua >= 0 && en > ua, "🔴 немає частин або англійська раніше за українську");
  assert.ok(t.includes("Додаток до Договору № EUR/21/09/2026 від «21» вересня 2026 р."), "🔴 UA: договір не підставлено");
  assert.ok(t.includes("Appendix to Contract No. EUR/21/09/2026 dated 21 September 2026"), "🔴 EN: договір не підставлено");
  const rows = nrAppRows(s);
  assert.equal(rows.ua.length, 18); assert.equal(rows.en.length, 18);
  assert.deepEqual(rows.en.find(([k]) => k === "Transportation route"), ["Transportation route", "Yakhny – Kolin"], "🔴 англійське поле проігноровано");
  assert.deepEqual(rows.en.find(([k]) => k === "Loading date"), ["Loading date", "06.10.2026"], "🔴 порожнє англійське не взяло значення з UA");
  const iss = validateForm(s);
  assert.ok(iss.some((i) => i.field === "trip.extraEn" && i.level === "warn"), "🔴 кирилиця в англійській частині без 🟡");
  assert.ok(iss.some((i) => i.field === "trip.mgrEn" && i.level === "warn"), "🔴 ім'я менеджера кирилицею в англійській частині без 🟡");
  assert.ok(!iss.some((i) => i.field === "trip.routeEn"), "🔴 🟡 на заповненому англійському полі");
  assert.match(blockers({ ...s, mainNo: "" }) ?? "", /договір, до якого заявка/, "🔴 заявка без договору формується");
  assert.ok(docxTxt(s).includes("APPLICATION No. 62741049"), "🔴 Word без англійської частини");
});

/**
 * #1735 — НАЯВНІ ДОКУМЕНТИ НЕ ЗАЧЕПЛЕНО: стилі двох колонок — лише в документах нерезидента (CSS макета `docCss.ts`
 * звіряється посимвольно, #1121), а англійські поля форми = ті, що читає сервер (інакше вписане менеджером не дійде).
 * 🧨 Підключити NR_CSS усім або розвести ключі фронту й сервера — червоніє.
 */
test("#1735 НЕРЕЗИДЕНТ ОКРЕМО: стилі колонок лише в його документах; англійські поля форми = серверним", () => {
  const once = ref["once-client-uts"].state;
  assert.ok(!fullPageHTML(once, once.num, {}).includes("table.bi"), "🔴 стилі нерезидента протекли в разовий договір");
  assert.ok(fullPageHTML(nrState(), "1", {}).includes(NR_CSS.trim().split("\n")[0]), "🔴 договір з нерезидентом без стилів колонок");
  const front = readFileSync(path.join(REPO, "frontend", "src", "pages", "dashboard", "sections", "ConstructorSection.tsx"), "utf8");
  const block = /const NR_EN: Array<\[string, string\]> = \[([\s\S]*?)\];/.exec(front)?.[1] ?? "";
  const keys = [...block.matchAll(/\["(\w+En)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(keys, [...NR_EN_KEYS].sort(), "🔴 англійські поля форми ≠ серверним NR_EN_KEYS");
  assert.match(front, /k: "nrmain", t: "Договір з нерезидентом", p: "client", nr: true/, "🔴 немає вкладки «Договір з нерезидентом»");
  assert.match(front, /k: "nrapp", t: "Заявка нерезиденту", p: "client", nr: true/, "🔴 немає вкладки «Заявка нерезиденту»");
});

/* ══════════════ 🚚 ТТН (1-ТН) І CMR ІЗ ЗАЯВКИ ПЕРЕВІЗНИКУ (задача 5464, 14.10.2026) ══════════════ */

const WB_STATE = (): DocumentState => {
  const s = structuredClone(ref["carr-uts"].state) as DocumentState;
  s.trip = { ...s.trip, shipper: "ТОВ «Відправник»", shipperC: "Олександр, 095 000 00 00", consignee: "ТОВ «Одержувач»", consigneeC: "Юрій, 050 000 00 00",
    loadDate: "06.10.2026, 08:00", truck: "Renault Master АА 0000 АА / АА 0000 ХР", driver: "Шевчук Іван, посв. КВІ 000000, 096 000 00 00", cargo: "цифрова техніка, 1300 кг" };
  return s;
};
const unz = (u8: Uint8Array, name: string) => readZip(Buffer.from(u8)).get(name)!().toString("utf8");
/** значення клітинки xlsx за адресою (inline-рядок) */
const xCell = (sheet: string, ref: string) => {
  const m = new RegExp(`<c r="${ref}"[^>]*?(?:/>|>([\\s\\S]*?)</c>)`).exec(sheet);
  return m?.[1] ? (m[1].match(/<t[^>]*>([^<]*)<\/t>/)?.[1] ?? "") : "";
};

/**
 * #1750 — ТТН: значення лягли у СВОЇ клітинки офіційного бланка 1-ТН; «Автомобільний перевізник» — перевізник ІЗ ЗАЯВКИ
 * (рішення Романа 14.10), а не ЮТС; дата — день / місяць словом / рік; авто й причіп розділено. Бланк лишився цілим
 * (121 обʼєднання, ті самі клітинки-підписи). 🧨 Зсунути клітинку чи поставити ЮТС — червоніє.
 */
test("#1750 ТТН (1-ТН): перевізник із заявки, дата, авто/причіп, відправник, одержувач, вантаж — у своїх клітинках; бланк цілий", () => {
  const s = WB_STATE();
  const sheet = unz(buildTtn(s), "xl/worksheets/sheet1.xml");
  const want: Record<string, string> = { D15: `${s.cp.name}, ЄДРПОУ ${s.cp.edrpou}`, K7: "06", N7: "жовтня", Q7: "26", C11: "Renault Master АА 0000 АА", L11: "АА 0000 ХР",
    D17: "ТОВ «Відправник», Олександр, 095 000 00 00", D19: "ТОВ «Одержувач», Юрій, 050 000 00 00", U23: "Шевчук Іван", B35: "цифрова техніка, 1300 кг", X11: "автоперевезення" };
  for (const [r, v] of Object.entries(want)) assert.equal(xCell(sheet, r).replace(/&amp;/g, "&").replace(/&quot;/g, '"'), v, `🔴 ТТН ${r}`);
  assert.ok(!xCell(sheet, "D15").includes("ЮНАЙТЕД"), "🔴 перевізником у ТТН стоїть ЮТС");
  const blank = readZip(readFileSync(TTN_TEMPLATE)).get("xl/worksheets/sheet1.xml")!().toString("utf8");
  assert.equal((sheet.match(/<mergeCell /g) || []).length, (blank.match(/<mergeCell /g) || []).length, "🔴 обʼєднання клітинок бланка зіпсовано");
  assert.equal((sheet.match(/<c r="/g) || []).length, (blank.match(/<c r="/g) || []).length, "🔴 кількість клітинок змінилась — бланк зламано");
  assert.deepEqual(splitTruck("Volvo AA1 \\ AA2"), ["Volvo AA1", "AA2"]);
  assert.deepEqual(splitTruck("Volvo AA1"), ["Volvo AA1", ""], "🔴 без роздільника причіп вигадано");
});

/**
 * #1751 — CMR: кожна графа знайдена за ПІДПИСОМ у бланку (а не за жорстким номером), значення лягли під свій підпис:
 * 1 — відправник, 2 — одержувач, 16 — перевізник із заявки (кожен реквізит окремим рядком), 4 — дата DD/MM/YYYY,
 * 5 — № заявки. 🧨 Зсунути зсув графи або злити рядки в один — червоніє.
 */
test("#1751 CMR: відправник у 1, одержувач у 2, перевізник із заявки в 16 (рядками), дата й № заявки — за підписами граф", () => {
  const s = WB_STATE();
  const xml = unz(buildCmr(s), "word/document.xml");
  const cells = [...xml.matchAll(/<w:tc>(?:(?!<w:tc>)[\s\S])*?<\/w:tc>/g)].map((m) => m[0]);
  const t = (i: number) => (cells[i].match(/<w:t[^>]*>[^<]*<\/w:t>/g) || []).map((x) => x.replace(/<[^>]+>/g, "")).join("|");
  const blank = readZip(readFileSync(CMR_TEMPLATE)).get("word/document.xml")!().toString("utf8");
  const tg = cmrTargets(blank);
  const at = (label: string, off: number) => tg[CMR_SLOTS.findIndex((x) => x.label === label && x.off === off)];
  assert.equal(t(at("Отправитель (наименование", 2)), "ТОВ «Відправник»", "🔴 графа 1");
  assert.equal(t(at("Получатель (наименование", 3)), "ТОВ «Одержувач»", "🔴 графа 2");
  const carrier = t(at("Перевозчик (наименование", 2));
  assert.ok(carrier.startsWith(`${s.cp.name}|${s.cp.addr}|ЄДРПОУ ${s.cp.edrpou}`), "🔴 графа 16 — не перевізник із заявки або рядки злиплись: " + carrier);
  assert.match(cells[at("Перевозчик (наименование", 2)], /<w:r>(?:(?!<\/w:r>)[\s\S])*<w:br\/>/, "🔴 перенос поза <w:r> — Word злiпить рядки");
  assert.equal(t(at("Место и дата погрузки", 10)), "06/10/2026", "🔴 графа 4: дата");
  assert.equal(t(at("Прилагаемые документы", 2)), `Заявка № ${s.dealNo}`, "🔴 графа 5");
  for (const i of tg.filter((_, k) => !CMR_SLOTS[k].append)) assert.equal(cellText(blank, i), "", `🔴 у бланку клітинка значення #${i} не порожня — зсув графи`);
});
/** текст n-ї найглибшої клітинки бланка */
function cellText(xml: string, i: number): string {
  const c = [...xml.matchAll(/<w:tc>(?:(?!<w:tc>)[\s\S])*?<\/w:tc>/g)][i]?.[0] ?? "";
  return (c.match(/<w:t[^>]*>[^<]*<\/w:t>/g) || []).map((x) => x.replace(/<[^>]+>/g, "")).join("").trim();
}

/**
 * #1752 — ЛИШЕ ІЗ ЗАЯВКИ ПЕРЕВІЗНИКУ і ДЗЕРКАЛО: з клієнтської заявки й договорів — відмова словами, із заявки перевізнику —
 * формується; роути за тією ж межею доступу, що PDF заявки (`docStateOf`), і в матриці. 🧨 Дозволити з клієнтської — червоніє.
 */
test("#1752 ТТН/CMR: лише із заявки перевізнику (дзеркало), роути за межею «свої» й у матриці доступу", () => {
  assert.equal(waybillBlocker({ doc: "carr" }), null, "🔴 із заявки перевізнику не формується");
  for (const doc of ["once", "main", "nrmain", "nrapp"] as const) assert.match(waybillBlocker({ doc }) ?? "", /заявки перевізнику/, `🔴 ${doc}: пропустило`);
  const route = SRC("routes/constructor.ts");
  assert.match(route, /const waybill = \(kind: "ttn" \| "cmr"\) => h\(async \(req, res\) => \{\s*const d = await docStateOf\(req\);\s*const no = waybillBlocker\(d\.s\);/, "🔴 роут ТТН/CMR не за межею docStateOf або без перевірки виду");
  const m = SRC("auth/accessMatrix.ts");
  for (const k of ["ttn", "cmr"]) assert.ok(m.includes(`path: "/api/constructor/documents/:id/${k}"`), `🔴 /${k} немає в матриці`);
});

/**
 * #1753 — БЛАНКИ В РЕПОЗИТОРІЇ ПОРОЖНІ й БЕЗ ЧУЖИХ МЕТАДАНИХ (репозиторій публічний): у ТТН був чужий e-mail автора.
 * Збірка кладе їх у dist (інакше на проді «ENOENT»). 🧨 Повернути e-mail або прибрати копіювання — червоніє.
 */
test("#1753 БЛАНКИ ТТН/CMR: порожні, автор «UTS», копіюються збіркою в dist", () => {
  for (const f of [TTN_TEMPLATE, CMR_TEMPLATE]) {
    const core = readZip(readFileSync(f)).get("docProps/core.xml")?.().toString("utf8") ?? "";
    assert.ok(!/@[\w.-]+\.\w{2,}/.test(core), `🔴 ${path.basename(f)}: у метаданих e-mail`);
  }
  const ttn = readZip(readFileSync(TTN_TEMPLATE)).get("xl/worksheets/sheet1.xml")!().toString("utf8");
  assert.ok(!ttn.includes("inlineStr"), "🔴 бланк ТТН уже заповнений");
  assert.match(readFileSync(path.join(REPO, "backend", "package.json"), "utf8"), /src\/constructor\/data\/waybill/, "🔴 збірка не копіює бланки в dist");
  assert.ok(ttnCells(WB_STATE()).D15, "🔴 ттн без перевізника");
});

/* ══════════════ 📎 ЗАЯВКА-ДОДАТОК ДО РІЧНОГО ДОГОВОРУ (задача 5777, Шаврова Лілія, 19.10.2026) ══════════════ */

const AN_CP = { name: "ТОВ «Тест Агро»", edrpou: "12345678", addr: "м. Київ, вул. Тестова, 1", iban: "UA000000000000000000000000000",
  bank: "АТ «Тест Банк»", phone: "+380 44 000 00 00", email: "test@agro.test", dir: "Петренко Іван Іванович" };
const anState = (over: Record<string, unknown> = {}) => stateFromBody({ ent: "uts", doc: "annex", cp: AN_CP, dealNo: "62741747",
  mainNo: "62702131", mainDate: "21.09.2026", docDate: "2026-10-19",
  trip: { route: "Київ — Львів", cargo: "Зерно, 20 т", loadAddr: "Київ, склад 1", unloadAddr: "Львів, склад 2" },
  pay: { sum: "30000", cur: "грн", form: "б/г без ПДВ", order: "" }, ...over }, NR_MGR) as DocumentState;

/**
 * #1800 — ЗАЯВКА ДО РІЧНОГО ДОГОВОРУ (зразок Лілії «АвтоМув_З_Заявка…_5.pdf»): над заголовком «Додаток до Договору № … від …»,
 * «ЗАЯВКА № <ID угоди>», таблиця рейсу, реквізити ОБОХ сторін і підписи — і БЕЗ преамбули та юртексту разової заявки.
 * Для всіх трьох юросіб, у PDF і Word. 🧨 Повернути преамбулу чи юртекст або загубити шапку договору — червоніє.
 */
test("#1800 ЗАЯВКА ДО РІЧНОГО ДОГОВОРУ: «Додаток до Договору № … від …», рейс, реквізити обох сторін — без преамбули й юртексту", () => {
  const once = ref["once-client-uts"].state;
  const legalMark = txt(printHTML(once, once.num, {})).slice(0, 4000).match(/уклали цей Договір про наступне/)?.[0];
  assert.ok(legalMark, "🔴 у разовій заявці немає преамбули — нема з чим порівнювати");
  for (const ent of ["uts", "avm", "fop"] as const) {
    const s = anState({ ent, cp: ent === "fop" ? { ...AN_CP, name: "ФОП Тестовий Тест Тестович", edrpou: "1234567890" } : AN_CP });
    assert.equal(blockers(s), null, `🔴 ${ent}: заявка-додаток не формується`);
    for (const [name, t] of [["PDF", txt(printHTML(s, currentNum(s), {}))], ["Word", docxTxt(s)]] as const) {
      const head = t.indexOf("Додаток до Договору № 62702131 від 21.09.2026"), title = t.indexOf("ЗАЯВКА № 62741747");
      assert.ok(head >= 0 && title > head, `🔴 ${ent}/${name}: немає «Додаток до Договору № … від …» над «ЗАЯВКА № …»`);
      for (const need of ["на організацію перевезення вантажу", "Київ — Львів", "РЕКВІЗИТИ СТОРІН", "ЗАМОВНИК", "ЕКСПЕДИТОР", ENTITIES[ent].edrpou])
        assert.ok(t.includes(need), `🔴 ${ent}/${name}: немає «${need}»`);
      for (const bad of ["уклали цей Договір про наступне", "РАЗОВИЙ ДОГОВІР", "2. Основні умови перевезення"])
        assert.ok(!t.includes(bad), `🔴 ${ent}/${name}: у заявці-додатку «${bad}» — юртекст протік`);
    }
  }
  assert.equal(currentNum(anState()), "62741747", "🔴 № документа — не ID угоди");
  assert.ok(fullPageHTML(anState(), "62741747", {}).length > 0);
});

/**
 * #1801 — БЕЗ № І ДАТИ ДОГОВОРУ НЕ ФОРМУЄТЬСЯ (і дзеркало: з ними — формується); без ID угоди — теж ні.
 * «Порядок і строки оплати»: порожній не друкується (він у річному договорі), заповнений — друкується.
 * 🧨 Прибрати перевірку № чи завжди друкувати порожній рядок оплати — червоніє.
 */
test("#1801 ЗАЯВКА ДО ДОГОВОРУ: без № / дати договору чи ID угоди — відмова; порожній порядок оплати не друкується", () => {
  assert.equal(blockers(anState()), null, "🔴 повна заявка-додаток не формується (дзеркало)");
  assert.match(blockers(anState({ mainNo: "" })) ?? "", /№ річного договору/, "🔴 без № договору формується");
  assert.match(blockers(anState({ mainDate: "" })) ?? "", /дату річного договору/, "🔴 без дати договору формується");
  assert.match(blockers(anState({ dealNo: "" })) ?? "", /№ заявки/, "🔴 без ID угоди формується");
  const empty = txt(printHTML(anState(), "1", {}));
  assert.ok(!empty.includes("Порядок і строки оплати"), "🔴 порожній «Порядок і строки оплати» надруковано");
  const filled = anState({ pay: { sum: "30000", cur: "грн", form: "б/г без ПДВ", order: "по отриманні документів" } });
  assert.ok(txt(printHTML(filled, "1", {})).includes("Порядок і строки оплати по отриманні документів"), "🔴 заповнений порядок оплати не надруковано");
  const once = anState({ doc: "once" });
  assert.ok(txt(printHTML(once, "1", {})).includes("Порядок і строки оплати"), "🔴 разова заявка втратила рядок оплати — правило протекло за межі додатка");
});

/**
 * #1802 — № І ДАТА ДОГОВОРУ ЗА КЛІЄНТОМ: пишуться лише з основного договору й заявки-додатка, лише з номером і кодом
 * клієнта (8 / 10 цифр); база має колонки, довідник їх віддає, а звичайне збереження контрагента їх НЕ затирає.
 * 🧨 Писати з разової заявки, без коду, або затирати номер при збереженні реквізитів — червоніє.
 */
test("#1802 № ДОГОВОРУ ЗА КЛІЄНТОМ: пише основний і додаток (з кодом), не разова; збереження реквізитів номер не затирає", () => {
  assert.deepEqual(contractMemo(anState()), { code: "12345678", no: "62702131", date: "21.09.2026" }, "🔴 додаток не записує № за клієнтом");
  const main = anState({ doc: "main", mainNo: "UTS-2026-15", mainDate: "01.10.2026" });
  assert.deepEqual(contractMemo(main), { code: "12345678", no: "UTS-2026-15", date: "01.10.2026" }, "🔴 основний договір не записує № за клієнтом");
  assert.equal(contractMemo(anState({ doc: "once" })), null, "🔴 разова заявка переписала № річного договору");
  assert.equal(contractMemo(anState({ cp: { ...AN_CP, edrpou: "" } })), null, "🔴 записано без коду клієнта");
  assert.equal(contractMemo(anState({ mainNo: "" })), null, "🔴 записано порожній №");
  const schema = SRC("db/schema.sql"), route = SRC("routes/constructor.ts");
  assert.match(schema, /ALTER TABLE constructor_counterparties\s+ADD COLUMN IF NOT EXISTS contract_no\s+text,\s+ADD COLUMN IF NOT EXISTS contract_date text;/, "🔴 у базі немає колонок № / дати договору");
  assert.equal((route.match(/c\.contract_no, c\.contract_date/g) || []).length, 2, "🔴 довідник не віддає № договору (пошук або список)");
  const put = /constructorRouter\.put\("\/counterparties"[\s\S]*?\}\)\);/.exec(route)?.[0] ?? "";
  assert.ok(put.includes("ON CONFLICT (edrpou) DO UPDATE SET") && !/DO UPDATE SET[\s\S]*contract_(no|date)\s*=/.test(put), "🔴 збереження реквізитів затирає № договору");
  assert.ok(/await rememberContract\(s, req\.auth!\.userId\)/.test(route), "🔴 формування не записує № за клієнтом");
});

/**
 * #1803 — ФОРМА: вкладка «Заявка до річного договору» є, сервер приймає вид, база його дозволяє, а № підставляється
 * з довідника за ЄДРПОУ. 🧨 Прибрати вкладку, вид із CHECK чи підстановку — червоніє.
 */
test("#1803 ФОРМА ЗАЯВКИ ДО ДОГОВОРУ: вкладка, вид у базі й на сервері, № підставляється з картки клієнта", () => {
  const front = readFileSync(path.join(REPO, "frontend", "src", "pages", "dashboard", "sections", "ConstructorSection.tsx"), "utf8");
  assert.match(front, /k: "annex", t: "Заявка до річного договору", p: "client"/, "🔴 немає вкладки");
  assert.match(front, /mainNo: no, mainDate: date/, "🔴 № не підставляється з картки клієнта");
  assert.equal(typeof stateFromBody({ ent: "uts", doc: "annex" }, NR_MGR), "object", "🔴 сервер не приймає вид «annex»");
  assert.equal((stateFromBody({ ent: "uts", doc: "annex" }, NR_MGR) as DocumentState).party, "client", "🔴 додаток не клієнтський");
  assert.match(SRC("db/schema.sql"), /CHECK \(doc_kind IN \('once','main','carr','nrmain','nrapp','annex'\)\)/, "🔴 база не дозволяє вид «annex»");
});

/* ══════════════ 💵 ВІД ТОВ ЮТС — БЕЗ ГОТІВКИ (задача 5887, жорсткий варіант, Роман 20.10.2026) ══════════════ */

/**
 * #1810 — ЮТС + «готівка» → 🔴 на полі форми оплати, і формування зупиняється (і клієнту, і перевізнику).
 * Дзеркало: АвтоМув із готівкою і ЮТС безготівкою — без цієї помилки. 🧨 Прибрати перевірку чи заборонити всім — червоніє.
 */
test("#1810 ЮТС БЕЗ ГОТІВКИ: заявка клієнту й перевізнику від ЮТС з готівкою не формується; АвтоМув і безготівка — так", () => {
  const cash = { sum: "30000", cur: "грн", form: "готівка", order: "по отриманні документів" };
  const cp = { ...AN_CP, iban: "UA493052990000026000000000001" };   // справжній контрольний розряд — інших 🔴 у стані немає
  assert.equal(firstError(validateForm(anState({ doc: "once", ent: "uts", cp, pay: { ...cash, form: "б/г з ПДВ" } }))), null, "🔴 фікстура має інші помилки — перевірка нічого не доведе");
  for (const doc of ["once", "carr", "annex"] as const) {
    const s = anState({ doc, ent: "uts", cp, pay: cash });
    const e = validateForm(s).find((i) => i.field === "pay.form");
    assert.ok(e && e.level === "error", `🔴 ${doc}: ЮТС + готівка без 🔴`);
    assert.match(firstError(validateForm(s)) ?? "", /готівкою заборонена/, `🔴 ${doc}: формування не зупинено`);
  }
  assert.ok(!validateForm(anState({ doc: "once", ent: "avm", pay: cash })).some((i) => i.field === "pay.form"), "🔴 АвтоМув із готівкою заборонено (дзеркало)");
  assert.ok(!validateForm(anState({ doc: "once", ent: "uts", pay: { ...cash, form: "б/г з ПДВ" } })).some((i) => i.field === "pay.form"), "🔴 ЮТС безготівкою заборонено (дзеркало)");
});

/**
 * #1810b — ФОРМА: для ЮТС «готівки» в списку форм оплати немає; прийшла зі старої заявки — видно як заборонену,
 * під полем — причина. 🧨 Повернути готівку в список ЮТС чи прибрати повідомлення під полем — червоніє.
 */
test("#1810b ФОРМА: у ЮТС немає «готівки» в списку оплати, стара — позначена забороненою з причиною", () => {
  const front = readFileSync(path.join(REPO, "frontend", "src", "pages", "dashboard", "sections", "ConstructorSection.tsx"), "utf8");
  assert.match(front, /form\.ent === "uts" \? PAY_FORMS\.filter\(\(o\) => o !== CASH\)/, "🔴 ЮТС пропонує готівку");
  assert.match(front, /<option value=\{CASH\} disabled>готівка — заборонено для ЮТС<\/option>/, "🔴 стара готівка не позначена");
  assert.match(front, /<FieldMsg is=\{iss\("pay\.form"\)\} \/>/, "🔴 під полем форми оплати немає причини");
});

/* ══════════════ 🔏 ПЕЧАТКА НА PDF (задача 5779, просив Сергій; Роман 20.10.2026) ══════════════ */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PL = createRequire(import.meta.url)("./vendor/pdf-lib.min.cjs") as any;
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b: Buffer) => { let c = 0xFFFFFFFF; for (const x of b) c = crcT[(c ^ x) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
/** PNG w×h: ліва половина червона, права синя — так видно і місце, і напрям повороту. */
function halfPng(w: number, h: number): Uint8Array {
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(x < w / 2 ? [255, 0, 0] : [0, 0, 255], y * (1 + w * 3) + 1 + x * 3);
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}
const PNGS = { uts: halfPng(20, 20), avm: halfPng(20, 20) };
/** Тестовий PDF: сторінки 600×800 пт з текстом HELLO-PAGE-n; `rot` — /Rotate кожної сторінки. */
async function testPdf(n: number, rot = 0): Promise<Uint8Array> {
  const d = await PL.PDFDocument.create(); const f = await d.embedFont(PL.StandardFonts.Helvetica);
  for (let i = 1; i <= n; i++) { const p = d.addPage([600, 800]); p.drawText(`HELLO-PAGE-${i}`, { x: 50, y: 700, size: 20, font: f }); if (rot) p.setRotation(PL.degrees(rot)); }
  return d.save();
}
const hasPoppler = (() => { try { execFileSync("pdftoppm", ["-v"], { stdio: "ignore" }); execFileSync("pdftotext", ["-v"], { stdio: "ignore" }); return true; } catch { return false; } })();
/** Сторінка → центри червоних і синіх пікселів (72 dpi: 1 px = 1 пт видимої сторінки). */
function colourCentres(pdf: Uint8Array, page: number) {
  const dir = mkdtempSync(path.join(tmpdir(), "stamp-")), f = path.join(dir, "o.pdf");
  try {
    writeFileSync(f, pdf);
    const ppm = execFileSync("pdftoppm", ["-f", String(page), "-l", String(page), "-r", "72", "-singlefile", f], { maxBuffer: 64 * 1024 * 1024 });
    const m = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(ppm.toString("latin1", 0, 40))!;
    const W = +m[1], H = +m[2], off = m[0].length;
    const acc = { red: [0, 0, 0], blue: [0, 0, 0] };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = off + (y * W + x) * 3, r = ppm[i], g = ppm[i + 1], b = ppm[i + 2];
      const k = r > 180 && g < 80 && b < 80 ? "red" : b > 180 && r < 80 && g < 80 ? "blue" : null;
      if (k) { acc[k][0] += x; acc[k][1] += y; acc[k][2]++; }
    }
    const c = (a: number[]) => (a[2] ? { x: a[0] / a[2], y: a[1] / a[2], n: a[2] } : null);
    return { W, H, red: c(acc.red), blue: c(acc.blue) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const near = (p: { x: number; y: number } | null, x: number, y: number, what: string) =>
  assert.ok(p && Math.abs(p.x - x) <= 3 && Math.abs(p.y - y) <= 3, `🔴 ${what}: очікували ≈(${x}, ${y}), а ${p ? `(${p.x.toFixed(1)}, ${p.y.toFixed(1)})` : "нічого немає"}`);
const st = (o: Partial<Stamp>): Stamp => ({ ent: "avm", page: 1, x: 0.5, y: 0.25, size: 0.2, rot: 0, ...o });

/**
 * #1820 — ПЕЧАТКА ЛЯГАЄ ТУДИ, КУДИ ПОСТАВИЛИ, І ЛИШЕ НА ТУ СТОРІНКУ (зовнішня звірка: сторінку розтеризує poppler,
 * центр печатки міряємо по пікселях). Текст документа лишається текстом на всіх сторінках, сторінок стільки ж.
 * 🧨 Поставити на всі сторінки, переплутати верх і низ чи «розплющити» документ у картинку — червоніє.
 */
test("#1820 ПЕЧАТКА НА PDF: на вибраній сторінці в точці з прев'ю, інші сторінки чисті, текст лишається текстом", { skip: hasPoppler ? false : "немає poppler (pdftoppm/pdftotext)" }, async () => {
  const src = await testPdf(3);
  const out = await stampPdf(src, [st({ page: 2 })], PNGS);
  assert.equal(out.pages, 3, "🔴 змінилась кількість сторінок");
  const p2 = colourCentres(out.pdf, 2);
  assert.equal(p2.W, 600, "🔴 розмір сторінки змінився");
  // видима коробка печатки: ліворуч 300, згори 200, 120×120 → червона половина ≈(330, 260), синя ≈(390, 260)
  near(p2.red, 330, 260, "червона (ліва) половина печатки"); near(p2.blue, 390, 260, "синя (права) половина печатки");
  for (const pg of [1, 3]) assert.equal(colourCentres(out.pdf, pg).red, null, `🔴 печатка протекла на сторінку ${pg}`);
  const dir = mkdtempSync(path.join(tmpdir(), "stamp-")), f = path.join(dir, "o.pdf");
  try { writeFileSync(f, out.pdf); const t = execFileSync("pdftotext", [f, "-"]).toString(); for (const n of [1, 2, 3]) assert.ok(t.includes(`HELLO-PAGE-${n}`), `🔴 текст сторінки ${n} зник`); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

/**
 * #1820b — ПОВОРОТ: за годинниковою й довкола центру (печатку 90° повернуто — червона половина стає ЗГОРИ, центр той
 * самий); сторінка з /Rotate 90 — координати беруться з ВИДИМОЇ сторінки, як у прев'ю. По обидва боки: 0° і 90°,
 * звичайна й повернута сторінка. 🧨 Повернути проти годинникової, довкола кута чи ігнорувати /Rotate — червоніє.
 */
test("#1820b ПЕЧАТКА НА PDF: поворот за годинниковою довкола центру; повернута сторінка — у видимих координатах", { skip: hasPoppler ? false : "немає poppler (pdftoppm/pdftotext)" }, async () => {
  const r90 = colourCentres((await stampPdf(await testPdf(1), [st({ rot: 90 })], PNGS)).pdf, 1);
  near(r90.red, 360, 230, "печатка 90°: червона половина мала стати згори"); near(r90.blue, 360, 290, "печатка 90°: синя — знизу");
  const r45 = colourCentres((await stampPdf(await testPdf(1), [st({ rot: -90 })], PNGS)).pdf, 1);
  near(r45.red, 360, 290, "печатка −90°: червона половина мала стати знизу");
  // сторінка /Rotate 90: видима 800×600; печатка x .5, y .25, size .2 → коробка 400..560 × 150..310
  const rp = colourCentres((await stampPdf(await testPdf(1, 90), [st({})], PNGS)).pdf, 1);
  assert.equal(rp.W, 800, "🔴 сторінка /Rotate 90 мала бути видимою 800×600");
  near(rp.red, 440, 230, "повернута сторінка: червона половина"); near(rp.blue, 520, 230, "повернута сторінка: синя половина");
  for (const R of [180, 270]) {
    const q = colourCentres((await stampPdf(await testPdf(1, R), [st({})], PNGS)).pdf, 1);
    const [Wd, Hd] = R === 270 ? [800, 600] : [600, 800], w = 0.2 * Wd;
    near(q.red, 0.5 * Wd + w / 4, 0.25 * Hd + w / 2, `сторінка /Rotate ${R}: червона половина`);
  }
  assert.equal(placeOnPage({ W: 600, H: 800, ox: 0, oy: 0, R: 0 }, st({ rot: 30 }), 1).rotate, -30, "🔴 кут у PDF — не за годинниковою");
});

/**
 * #1821 — ВІДМОВИ СЛОВАМИ: без печаток, ФОП, розмір чи місце поза сторінкою, сторінки немає, не PDF, PDF із паролем (422).
 * Дзеркало: правильна печатка проходить. 🧨 Прибрати будь-яку перевірку — червоніє.
 */
test("#1821 ПЕЧАТКА НА PDF: відмови словами — ФОП, поза сторінкою, немає сторінки, не PDF, захищений паролем", async () => {
  assert.match(String(parseStamps([])), /хоча б одну/);
  assert.match(String(parseStamps([st({ ent: "fop" as Stamp["ent"] })])), /лише в ЮТС і АвтоМув/);
  assert.match(String(parseStamps([st({ size: 0.9 })])), /розмір/);
  assert.match(String(parseStamps([st({ x: 0.95 })])), /за межі сторінки/);
  assert.match(String(parseStamps(Array.from({ length: 31 }, () => st({})))), /Забагато/);
  assert.deepEqual(parseStamps([{ ...st({}), extra: 1 }]), [st({})], "🔴 правильну печатку відхилено (дзеркало)");
  const refused = async (p: Promise<unknown>, re: RegExp, status: number) => {
    const e = await p.then(() => null, (x: unknown) => x);
    assert.ok(e instanceof StampRefused && re.test(e.message) && e.status === status, `🔴 очікували відмову ${status} «${re}», а ${e instanceof Error ? e.message : "прийнято"}`);
  };
  await refused(stampPdf(await testPdf(2), [st({ page: 3 })], PNGS), /сторінки 3 немає/, 400);
  await refused(stampPdf(new TextEncoder().encode("%PDF-1.4 not really"), [st({})], PNGS), /не читається/, 400);
  const enc = await PL.PDFDocument.create(); enc.addPage();
  enc.context.trailerInfo.Encrypt = enc.context.register(enc.context.obj({ Filter: "Standard" }));
  await refused(stampPdf(await enc.save(), [st({})], PNGS), /паролем/, 422);
});

/**
 * #1822 — МЕЖІ Й СЛІД: кожне накладання пише журнал (хто, файл, sha256, печатки) у ТОМУ Ж обробнику; обидва роути в
 * матриці доступу; журнал закритий від AI після створення; бібліотека копіюється збіркою; вкладка — для всіх, а не лише
 * для пулу. 🧨 Прибрати запис у журнал, рядок матриці, REVOKE чи сховати вкладку за «пулом» — червоніє.
 */
test("#1822 ПЕЧАТКА НА PDF: журнал у тому ж обробнику, роути в матриці, журнал закритий від AI, вкладка — усім", () => {
  const route = SRC("routes/constructor.ts");
  const h = /constructorRouter\.post\("\/stamp"[\s\S]*?\n\}\)\);/.exec(route)?.[0] ?? "";
  const ins = h.search(/await pool\.query\(\s*`INSERT INTO constructor_stamp_log \(created_by, file_name, file_sha256, pages, stamps\)/);
  assert.ok(ins > 0 && h.indexOf("stampPdf(") < ins, "🔴 накладання не пише журнал (або пише ДО накладання)");
  const mx = SRC("auth/accessMatrix.ts");
  for (const r of ['"POST", path: "/api/constructor/stamp"', '"GET", path: "/api/constructor/stamp-image/:ent"']) assert.ok(mx.includes(r), `🔴 немає в матриці: ${r}`);
  const sch = SRC("db/schema.sql");
  const created = sch.indexOf("CREATE TABLE IF NOT EXISTS constructor_stamp_log"), revoked = sch.search(/REVOKE ALL ON [^;]*constructor_stamp_log[^;]*FROM ai_readonly/);
  assert.ok(created > 0 && revoked > created, "🔴 журнал не закритий від AI (або REVOKE раніше за CREATE)");
  assert.ok(SRC("ai/metricTools.ts").includes('"constructor_stamp_log"'), "🔴 журналу немає у FORBIDDEN_TABLES");
  assert.ok(readFileSync(path.join(import.meta.dirname, "vendor", "pdf-lib.min.cjs")).length > 400_000, "🔴 збірка не скопіювала pdf-lib у dist");
  const front = readFileSync(path.join(REPO, "frontend", "src", "pages", "dashboard", "sections", "ConstructorSection.tsx"), "utf8");
  assert.match(front, /\n\s+<button aria-pressed=\{view === "stamp"\} onClick=\{\(\) => setView\("stamp"\)\}>🔏 Печатка на PDF<\/button>/, "🔴 немає вкладки «Печатка на PDF»");
  assert.ok(!/\{me\?\.canSeeAll && <button aria-pressed=\{view === "stamp"\}/.test(front), "🔴 вкладку сховано за правом пулу — а робити можуть усі");
});

/* ══════════════ 🌍 ПЕРЕКЛАД АНГЛІЙСЬКОЇ ЧАСТИНИ ЗАЯВКИ НЕРЕЗИДЕНТУ (задача 5940, Роман 21.10.2026) ══════════════ */

/**
 * #1870 — ТРАНСЛІТЕРАЦІЯ КМУ №55: офіційні приклади з таблиці постанови (на початку слова / в середині, «зг», апостроф,
 * м'який знак) і регістр. 🧨 Прибрати правило початку слова, «zgh» чи апостроф — червоніє.
 */
test("#1870 ТРАНСЛІТЕРАЦІЯ КМУ №55: офіційні приклади постанови — початок/середина слова, «зг», апостроф, регістр", () => {
  const ex: Array<[string, string]> = [
    ["Алушта", "Alushta"], ["Згорани", "Zghorany"], ["Розгон", "Rozghon"], ["Галич", "Halych"], ["Ґорґани", "Gorgany"],
    ["Єнакієве", "Yenakiieve"], ["Гаєвич", "Haievych"], ["Короп'є", "Koropie"], ["Їжакевич", "Yizhakevych"], ["Кадиївка", "Kadyivka"],
    ["Йосипівка", "Yosypivka"], ["Стрий", "Stryi"], ["Олексій", "Oleksii"], ["Юрій", "Yurii"], ["Корюківка", "Koriukivka"],
    ["Яготин", "Yahotyn"], ["Костянтин", "Kostiantyn"], ["Знам'янка", "Znamianka"], ["Феодосія", "Feodosiia"], ["Щербухи", "Shcherbukhy"],
    ["Гоща", "Hoshcha"], ["Харків", "Kharkiv"], ["Біла Церква", "Bila Tserkva"], ["Чернігів", "Chernihiv"], ["Київ", "Kyiv"],
    ["Розумовський", "Rozumovskyi"], ["Жашків", "Zhashkiv"],
  ];
  for (const [ua, en] of ex) assert.equal(translit(ua), en, `🔴 ${ua} → ${translit(ua)}, а за постановою ${en}`);
  assert.equal(translit("КИЇВ – ЛЬВІВ, 20 т"), "KYIV – LVIV, 20 т".replace("т", "t"), "🔴 регістр або розділові знаки зіпсовано");
  assert.equal(translitParty("ТОВ «Тест Агро», Олександр, +380 95 000 00 00"), 'LLC "Test Ahro", Oleksandr, +380 95 000 00 00', "🔴 орг. форма / лапки / телефон");
  assert.equal(translit("Mercedes Actros АА 1234 ВВ"), "Mercedes Actros AA 1234 VV", "🔴 латиниця або цифри зіпсовано");
});

const trState = (trip: Record<string, string>) => nrState({ doc: "nrapp", dealNo: "62741049", mainNo: "EUR/21/09/2026", mainDate: "2026-09-21", trip });

/**
 * #1871 — ЛИШЕ ПОРОЖНІ ПОЛЯ, І КОЖНЕ СВОЇМ СПОСОБОМ: адреси й міста — транслітерацією, вантаж/вимоги/умови — Google;
 * вписане руками й латиниця не чіпаються; без ключа транслітерація однаково працює, а Google-поля лишаються з поясненням.
 * 🧨 Перезаписати ручне поле, віддати адресу в Google чи впасти без ключа — червоніє.
 */
test("#1871 ПЕРЕКЛАД: лише порожні поля; адреси — транслітерація, вантаж і умови — Google; без ключа — пояснення", async () => {
  const calls: string[][] = [];
  const stub = async (t: string[]) => { calls.push(t); return t.map((x) => `EN(${x})`); };
  const s = trState({ route: "Яхни – Колін", cargo: "Зерно в мішках, 20 т", loadAddr: "с. Яхни, Київська обл.", extra: "оплата до вивантаження",
    reqs: "тент", truck: "DAF АА 1111 ВВ", routeEn: "Yakhny (Kyiv region) – Kolin", loadDate: "06.10.2026" });
  const r = await translateNr(s, stub);
  assert.equal(r.fields.routeEn, undefined, "🔴 перезаписано вписане руками");
  assert.equal(r.fields.loadAddrEn, "s. Yakhny, Kyivska obl.", "🔴 адресу не транслітеровано");
  assert.equal(r.how.loadAddrEn, "translit");
  assert.equal(r.fields.cargoEn, "EN(Зерно в мішках, 20 т)", "🔴 вантаж не пішов у Google");
  assert.equal(r.how.extraEn, "google");
  assert.equal(r.fields.truckEn, "EN(DAF АА 1111 ВВ)", "🔴 авто (є кирилиця) не перекладено");
  assert.equal(r.fields.loadDateEn, undefined, "🔴 дата без кирилиці пішла в переклад");
  assert.equal(calls.length, 1, "🔴 Google кликано не одним запитом");
  assert.ok(!calls[0].some((t) => /Яхни/.test(t)), "🔴 адреса пішла в Google");
  const noKey = await translateNr(s, null);
  assert.equal(noKey.fields.loadAddrEn, "s. Yakhny, Kyivska obl.", "🔴 без ключа транслітерація не працює");
  assert.equal(noKey.fields.cargoEn, undefined);
  assert.match(noKey.note ?? "", /не налаштовано/, "🔴 без ключа немає пояснення");
  const down = await translateNr(s, async () => { throw new Error("Google 503"); });
  assert.match(down.note ?? "", /не відповів \(Google 503\)/, "🔴 збій Google без пояснення");
  for (const k of GOOGLE_KEYS) assert.ok(!TRANSLIT_KEYS.has(k), `🔴 поле ${k} в обох списках`);
});

/**
 * #1872 — GOOGLE ЛИШЕ ЧЕРЕЗ IPv4 (ключ обмежено IP сервера, а через IPv6 Google відповідає 403 — замір 21.10), ключ не
 * потрапляє в текст помилки; роут — у матриці, з лімітом частоти, лише для заявки нерезиденту.
 * 🧨 Прибрати `family: 4`, ліміт чи рядок матриці — червоніє.
 */
test("#1872 ПЕРЕКЛАД: Google лише через IPv4, ключ не в помилках; роут у матриці, з лімітом і лише для заявки нерезиденту", () => {
  const svc = SRC("constructor/services/nrTranslate.ts");
  assert.match(svc, /method: 'POST', family: 4,/, "🔴 запит до Google не примушено до IPv4");
  assert.match(svc, /replaceAll\(key, '\*\*\*'\)/, "🔴 ключ може потрапити в текст помилки");
  const route = SRC("routes/constructor.ts");
  const h = /constructorRouter\.post\("\/translate"[\s\S]*?\n\}\)\);/.exec(route)?.[0] ?? "";
  assert.ok(/s\.doc !== "nrapp"/.test(h) && /translateRateOk\(req\.auth!\.userId\)/.test(h), "🔴 роут без межі виду документа чи ліміту");
  assert.ok(SRC("auth/accessMatrix.ts").includes('"POST", path: "/api/constructor/translate"'), "🔴 роуту немає в матриці доступу");
});
