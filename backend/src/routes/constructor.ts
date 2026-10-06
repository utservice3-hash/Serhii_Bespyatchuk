/**
 * 📄 КОНСТРУКТОР ДОКУМЕНТІВ — /api/constructor/* (30.09.2026).
 *
 * Код Сергія (`roman-package/server/routes/constructor.ts`) перенесено з такими змінами — і лише ними:
 *  1. Вхід — наш `requireAuth` + вкладка `constructor` першим оператором (як у «Фінансах»);
 *     `req.user` пакета → `req.auth`.
 *  2. Межа «кожен тільки свої» (рішення Сергія 30.09.2026): список, картка, Word і PDF фільтрує
 *     ОДНА функція `canSeeConstructorDoc`. Пул усіх і лічильник за день — нові роути під правом
 *     `view_all_constructor_docs`.
 *  3. «Відповідальна особа Експедитора»: у пакеті — `users.name/phone`, яких у нас немає. Беремо
 *     з картки співробітника (`employees`: ПІБ і телефон), запасне ім'я — менеджер CRM або логін.
 *  4. PDF — браузер на кожен документ (`pdfRenderer.ts`); не налаштовано → 503 зі словами.
 *  5. Прев'ю віддає ПОВНУ сторінку (`fullPageHTML`, з CSS документа). Пакет віддавав фрагмент без
 *     стилів, і його iframe показував би документ «голим».
 *  6. Express 4 не ловить помилки async-обробників — кожен загорнуто в `h()`.
 *  7. «SELECT зірочка» пакета → явні переліки колонок (гейт #17e): нова колонка не поїде назовні сама,
 *     а назви файлів підпису/печатки юросіб у відповідь не йдуть узагалі.
 *  8. Пошук за ЄДРПОУ: свій довідник, далі ЄДР через YouScore (`constructor/youscore.ts`, кеш 30 днів).
 *  9. v2 пакета (оформлення «Б», 01.10.2026): формування підганяє PDF під 3 сторінки й пише `dens`/`pages`,
 *     Word бере ту саму щільність, PDF несе `X-Doc-Pages/Density/Overflow`, у пакеті угоди — та сама підгонка.
 */
import { Router, type Request, type Response } from "express";
import path from "path";
import { pool } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { roleHasTab, roleHasPerm } from "../auth/rbac.js";
import { parseRequisites, parseOldDoc } from "../constructor/services/requisitesParser.js";
import { buildDocx, blockers, currentNum, zipStore, type DocumentState, type EntityKey, type Density } from "../constructor/services/docgen.js";
import { splitParagraphs, textPageHtml, imagePageHtml, paragraphsDocx, toPdfKind, outName } from "../constructor/services/convert.js";
import { parseDocx, docxText, OfficeParseError } from "../core/officeParse.js";
import { extractText } from "../core/docText.js";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { fullPageHTML, printHTML } from "../constructor/services/printTemplate.js";
import { loadDocImages, docImageDataUris, AssetsMissing } from "../constructor/services/docAssets.js";
import { htmlToPdf, renderDocumentPdf, PdfUnavailable, type RenderedPdf } from "../constructor/services/pdfRenderer.js";
import { canSeeConstructorDoc, stateFromBody, fileBase, VIEW_ALL_PERM } from "../constructor/access.js";
import { DOCS_DIR } from "../jobs/backupDb.js";
import { MANAGER_CONTACT_SQL, POOL_STATS_SQL } from "../constructor/sql.js";
import { lookupRegistry } from "../constructor/youscore.js";
import { lookup1c, resolveRequisites } from "../constructor/onec.js";
import { validateForm, firstError, type Issue } from "../constructor/validate.js";

/** Підписи й печатки — лише на сервері, поза git (репозиторій публічний). Тека вже в нічному бекапі. */
export const CONSTRUCTOR_ASSETS_DIR = process.env.CONSTRUCTOR_ASSETS_DIR ?? path.join(DOCS_DIR, "constructor-assets");

export const constructorRouter = Router();
constructorRouter.use(requireAuth);

class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

/** Вкладка — перша межа (як `onlyFinance`). */
constructorRouter.use((req, res, next) => {
  if (!req.auth || !roleHasTab(req.auth.roleKey, "constructor")) {
    return res.status(403).json({ error: "Конструктор документів недоступний для вашої ролі" });
  }
  next();
});

const canSeeAll = (req: Request) => roleHasPerm(req.auth!.roleKey, VIEW_ALL_PERM);

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
const h = (fn: Handler) => async (req: Request, res: Response) => {
  try { await fn(req, res); }
  catch (e) {
    if (e instanceof HttpError) return void res.status(e.status).json({ error: e.message });
    if (e instanceof AssetsMissing) return void res.status(409).json({ error: e.message });
    if (e instanceof PdfUnavailable) return void res.status(503).json({ error: e.message });
    console.error("[constructor]", e);
    if (!res.headersSent) res.status(500).json({ error: "Помилка сервера" });
  }
};


async function managerOf(userId: number): Promise<{ name: string; phone: string }> {
  const r = await pool.query<{ name: string | null; phone: string }>(MANAGER_CONTACT_SQL, [userId]);
  return { name: r.rows[0]?.name ?? "", phone: r.rows[0]?.phone ?? "" };
}

async function stateOrFail(req: Request): Promise<DocumentState> {
  const s = stateFromBody(req.body, await managerOf(req.auth!.userId));
  if (typeof s === "string") throw new HttpError(400, s);
  return s;
}

const idOf = (req: Request): number => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, "Запису немає.");
  return id;
};

/* ── Юрособи ── */
constructorRouter.get("/entities", h(async (_req, res) => {
  const q = await pool.query(`SELECT key, code, name, full_name, edrpou, ipn, vat_label, tax_line, address, phone, email, director, director_short, accounts, fines, dwell_default FROM constructor_entities WHERE is_active ORDER BY key`);
  res.json(q.rows);
}));

/** Хто я для документа: фронт показує, що підставиться у «Відповідальну особу», і чи є пул. */
constructorRouter.get("/me", h(async (req, res) => {
  res.json({ manager: await managerOf(req.auth!.userId), canSeeAll: canSeeAll(req) });
}));

/* ── Парсери ── */
constructorRouter.post("/parse", h((req, res) => {
  res.json(parseRequisites(String(req.body?.text || "")));
}));
constructorRouter.post("/parse-old", h((req, res) => {
  // docx → текст конвертує фронт — сюди приходить уже текст
  res.json(parseOldDoc(String(req.body?.text || "")));
}));

/* ── Довідник контрагентів — спільний: усім на читання й додавання ── */
constructorRouter.get("/counterparties", h(async (req, res) => {
  const q = String(req.query.q || "").trim();
  const rows = q
    ? await pool.query(
        `SELECT c.id, c.edrpou, c.name, c.ipn, c.address, c.iban, c.bank, c.phone, c.email, c.director, c.is_fop, c.updated_at, (SELECT max(d.created_at) FROM constructor_documents d WHERE d.contractor->>'edrpou' = c.edrpou AND c.edrpou IS NOT NULL) AS last_doc_at FROM constructor_counterparties c
          WHERE c.name ILIKE '%'||$1||'%' OR c.edrpou = $1 OR c.iban ILIKE '%'||$1||'%'
          ORDER BY updated_at DESC LIMIT 30`, [q])
    : await pool.query(`SELECT c.id, c.edrpou, c.name, c.ipn, c.address, c.iban, c.bank, c.phone, c.email, c.director, c.is_fop, c.updated_at, (SELECT max(d.created_at) FROM constructor_documents d WHERE d.contractor->>'edrpou' = c.edrpou AND c.edrpou IS NOT NULL) AS last_doc_at FROM constructor_counterparties c ORDER BY c.updated_at DESC LIMIT 30`);
  res.json(rows.rows);
}));

constructorRouter.put("/counterparties", h(async (req, res) => {
  const c = req.body || {};
  if (!c.edrpou && !c.name) throw new HttpError(400, "Потрібні щонайменше назва або ЄДРПОУ.");
  if (!c.name) throw new HttpError(400, "Потрібна назва контрагента.");
  const q = await pool.query(
    `INSERT INTO constructor_counterparties (edrpou, name, ipn, address, iban, bank, phone, email, director, is_fop, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (edrpou) DO UPDATE SET
       name=EXCLUDED.name, ipn=EXCLUDED.ipn, address=EXCLUDED.address, iban=EXCLUDED.iban,
       bank=EXCLUDED.bank, phone=EXCLUDED.phone, email=EXCLUDED.email, director=EXCLUDED.director,
       is_fop=EXCLUDED.is_fop, updated_at=now(), updated_by=EXCLUDED.updated_by
     RETURNING id, edrpou, name, ipn, address, iban, bank, phone, email, director, is_fop, updated_at`,
    [c.edrpou || null, c.name, c.ipn || null, c.addr || null, c.iban || null, c.bank || null,
     c.phone || null, c.email || null, c.dir || null, /^ФОП/i.test(c.name || ""), req.auth!.userId]);
  res.json(q.rows[0]);
}));

/* ── Автопідстановка за ЄДРПОУ: 1С → (ЄДР для директора) → довідник; у 1С немає — довідник → ЄДР ── */
constructorRouter.get("/edrpou/:code", h(async (req, res) => {
  const code = req.params.code.replace(/\D/g, "");
  if (!/^\d{8}$|^\d{10}$/.test(code)) throw new HttpError(400, "ЄДРПОУ — 8 цифр (ІПН ФОП — 10).");
  // Порядок і зведення — `constructor/onec.resolveRequisites` (гейти ганяють рівно його). ЄДР — через YouScore
  // (кеш 30 днів: кожен запит — транзакція тарифу).
  const r = await resolveRequisites(code, {
    oneC: () => lookup1c(code),
    book: async () => (await pool.query(`SELECT id, edrpou, name, ipn, address, iban, bank, phone, email, director, is_fop, updated_at FROM constructor_counterparties WHERE edrpou = $1`, [code])).rows[0] ?? null,
    registry: async () => {
      const x = await lookupRegistry(pool, code, { userId: req.auth!.userId });
      if (x.kind === "failed") console.error("[constructor] ЄДР:", x.why);   // лише причина-статус, без ключа й адреси
      return x;
    },
  });
  if (r.kind === "error") throw new HttpError(r.status, r.message);
  res.status(r.status).json(r.body);
}));

/* ── Прев'ю без збереження ── */
constructorRouter.post("/preview", h(async (req, res) => {
  const s = await stateOrFail(req);
  const img = safeImages(s.ent, s.stamp);   // логотип є завжди; перемикач прибирає лише підпис і печатку (v2)
  const num = currentNum(s) || (s.doc === "main" ? "______" : "______ (ID угоди)"); // заглушка — як у макеті
  const issues = await checkFields(s);
  res.json({ html: fullPageHTML(s, num, img.uris), fragment: printHTML(s, num, img.uris),
    blockers: blockers(s) ?? firstError(issues), issues, assetsNote: img.note ?? null });
  // `html` — повна сторінка з CSS «Б» (iframe srcDoc, як у пакеті v2); `fragment` лишено для сумісності.
}));

/**
 * ✅ Перевірка полів (затверджено 02.10.2026, `constructor/validate.ts`): 🔴 блокують формування, 🟡 лише в прев'ю.
 * «Угода є в CRM» — по `deals.kommo_id`; базу не вдалося спитати — не перевіряли (null), а не «немає».
 */
async function checkFields(s: DocumentState): Promise<Issue[]> {
  const deal = (s.dealNo || "").trim();
  let dealKnown: boolean | null = null;
  if (s.doc !== "main" && /^\d{1,15}$/.test(deal)) {
    dealKnown = await pool.query<{ e: boolean }>("SELECT EXISTS (SELECT 1 FROM deals WHERE kommo_id = $1::bigint) AS e", [deal])
      .then((r) => r.rows[0].e).catch(() => null);
  }
  return validateForm(s, { dealKnown });
}

/** Прев'ю не падає, якщо картинок ще немає на сервері: показує документ без них і каже чому. */
function safeImages(ent: EntityKey, stampOn: boolean): { uris: { logo?: string; sig?: string; stamp?: string }; note?: string } {
  try { return { uris: docImageDataUris(CONSTRUCTOR_ASSETS_DIR, ent, stampOn) }; }
  catch (e) { if (e instanceof AssetsMissing) return { uris: {}, note: e.message }; throw e; }
}

/* ── Сформувати: перевірити гейти, записати версію в архів ── */
constructorRouter.post("/documents", h(async (req, res) => {
  const s = await stateOrFail(req);
  const block = blockers(s) ?? firstError(await checkFields(s));
  if (block) throw new HttpError(422, block);
  const num = currentNum(s);
  const q = await pool.query<{ id: string; version: number; created_at: string }>(
    `INSERT INTO constructor_documents
       (deal_no, doc_kind, party, entity_key, doc_date, main_no, main_date,
        contractor, trip, pay, intl, with_stamp, fop_account, created_by, main_until)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING id, version, created_at`,
    [num, s.doc, s.party, s.ent, s.docDate || null, s.mainNo || null, s.mainDate || null,
     JSON.stringify(s.cp), JSON.stringify(s.trip), JSON.stringify(s.pay),
     s.intl, s.stamp, s.fopAcc, req.auth!.userId, s.doc === "main" ? (s.mainUntil || null) : null]);
  const fit = await fitAndStore(Number(q.rows[0].id), s, num);
  res.json({ id: Number(q.rows[0].id), version: q.rows[0].version, num, createdAt: q.rows[0].created_at,
    pages: fit?.pages ?? null, dens: fit?.dens ?? null, overflow: !!fit?.overflow });
}));

/**
 * 📄 АВТОПІДГОНКА (v2 пакета, рішення 14–15.10): щільність, з якою документ влазить у 3 сторінки, пишеться в
 * запис — Word бере ту саму (однакові кеглі → ті самі сторінки). Збій рендера (немає браузера, картинок) не
 * валить формування: запис уже в архіві, PDF підбереться при першому завантаженні.
 */
async function fitAndStore(id: number, s: DocumentState, num: string): Promise<RenderedPdf | null> {
  try {
    const fit = await renderDocumentPdf(s, num, docImageDataUris(CONSTRUCTOR_ASSETS_DIR, s.ent, s.stamp));
    await pool.query("UPDATE constructor_documents SET dens = $1, pages = $2 WHERE id = $3", [fit.dens, fit.pages, id]);
    return fit;
  } catch (err) {
    console.error("[constructor] PDF-підгонка не вдалась:", (err as Error).message);
    return null;
  }
}

const DOC_COLS = "id, deal_no, doc_kind, party, entity_key, version, doc_date, main_no, main_date, main_until, contractor, trip, pay, intl, with_stamp, fop_account, created_by, created_at, dens, pages";

const ARCHIVE_COLS = `d.id, d.deal_no, d.doc_kind, d.party, d.entity_key, d.version, d.doc_date,
  d.contractor->>'name' AS contractor_name, d.trip->>'route' AS route,
  d.pay->>'sum' AS sum, d.created_by, d.created_at`;

/** Пошук за ключовими словами (GIN) + фільтр по угоді; `mineOnly` — межа «лише свої». */
function archiveWhere(req: Request, mineOnly: boolean): { where: string; params: unknown[] } {
  const q = String(req.query.q || "").trim();
  const deal = String(req.query.deal || "").trim();
  const params: unknown[] = []; const cond: string[] = [];
  if (mineOnly) { params.push(req.auth!.userId); cond.push(`d.created_by = $${params.length}`); }
  if (deal) { params.push(deal); cond.push(`d.deal_no = $${params.length}`); }
  if (q) {
    params.push(q);
    cond.push(`to_tsvector('simple',
      coalesce(d.contractor->>'name','') || ' ' || coalesce(d.trip->>'route','') || ' ' ||
      coalesce(d.trip->>'cargo','') || ' ' || coalesce(d.trip->>'driver','') || ' ' || d.deal_no)
      @@ plainto_tsquery('simple', $${params.length})`);
  }
  return { where: cond.length ? "WHERE " + cond.join(" AND ") : "", params };
}

/* ── Архів: ЛИШЕ СВОЇ документи — навіть у того, хто бачить пул (пул — окреме місце) ── */
constructorRouter.get("/documents", h(async (req, res) => {
  const { where, params } = archiveWhere(req, true);
  const rows = await pool.query(`SELECT ${ARCHIVE_COLS} FROM constructor_documents d ${where} ORDER BY d.created_at DESC LIMIT 50`, params);
  res.json(rows.rows);
}));

/** Один рядок архіву з межею: чужий → 404 (не 403 — id не підтверджує існування чужого запису). */
async function visibleRow(req: Request): Promise<Record<string, unknown>> {
  const q = await pool.query(`SELECT ${DOC_COLS} FROM constructor_documents WHERE id = $1`, [idOf(req)]);
  const row = q.rows[0];
  if (!row || !canSeeConstructorDoc(req.auth!.userId, Number(row.created_by), canSeeAll(req))) throw new HttpError(404, "Запису немає.");
  return row;
}

/* ── Один запис: повний знімок для «У форму» ── */
constructorRouter.get("/documents/:id", h(async (req, res) => {
  res.json(await visibleRow(req));
}));

/* ── Регенерація файлів із запису архіву (менеджер — автор документа, не той, хто завантажує) ── */
async function docStateOf(req: Request): Promise<{ s: DocumentState; num: string; dens: Density | null }> {
  return stateFromRow(await visibleRow(req));
}

/** Друга сторона пакета: той самий збирач стану, id — не з адреси, межу вже перевірив викликач. */
async function stateById(_req: Request, id: number): Promise<{ s: DocumentState; num: string; dens: Density | null }> {
  const q = await pool.query(`SELECT ${DOC_COLS} FROM constructor_documents WHERE id = $1`, [id]);
  if (!q.rows[0]) throw new HttpError(404, "Запису немає.");
  return stateFromRow(q.rows[0]);
}

async function stateFromRow(row: Record<string, unknown>): Promise<{ s: DocumentState; num: string; dens: Density | null }> {
  const s: DocumentState = {
    ent: row.entity_key as EntityKey, doc: row.doc_kind as DocumentState["doc"], party: row.party as DocumentState["party"],
    intl: !!row.intl, stamp: !!row.with_stamp, fopAcc: Number(row.fop_account) | 0,
    cp: row.contractor as DocumentState["cp"], trip: row.trip as DocumentState["trip"], pay: row.pay as DocumentState["pay"],
    dealNo: row.doc_kind === "main" ? "" : String(row.deal_no),
    docDate: row.doc_date ? isoDate(row.doc_date) : "",
    mainNo: row.doc_kind === "main" ? String(row.deal_no) : "", mainDate: String(row.main_date || ""),
    mainUntil: String(row.main_until || ""),
    manager: await managerOf(Number(row.created_by)),
  };
  return { s, num: String(row.deal_no), dens: (row.dens as Density) || null };
}

/** `date` із pg приходить як JS Date опівночі ЛОКАЛЬНОГО часу — беремо локальні складові, не UTC. */
function isoDate(v: unknown): string {
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  return String(v).slice(0, 10);
}

constructorRouter.get("/documents/:id/docx", h(async (req, res) => {
  const d = await docStateOf(req);
  // щільність — та сама, що в PDF цього запису; якщо PDF ще не рендерився — підбираємо зараз (v2)
  const dens = d.dens ?? (await fitAndStore(idOf(req), d.s, d.num))?.dens;
  const bytes = buildDocx(d.s, d.num, loadDocImages(CONSTRUCTOR_ASSETS_DIR, d.s.ent, d.s.stamp), dens);
  res.set({
    "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "Content-Disposition": `attachment; filename="${fileBase(d.num)}.docx"`,
  }).send(Buffer.from(bytes));
}));

constructorRouter.get("/documents/:id/pdf", h(async (req, res) => {
  const d = await docStateOf(req);
  const fit = await renderDocumentPdf(d.s, d.num, docImageDataUris(CONSTRUCTOR_ASSETS_DIR, d.s.ent, d.s.stamp));
  if (fit.dens !== d.dens) await pool.query("UPDATE constructor_documents SET dens = $1, pages = $2 WHERE id = $3", [fit.dens, fit.pages, idOf(req)]);
  const pdf = fit.pdf;
  const inline = req.query.view === "1";
  res.set({
    "Content-Type": "application/pdf",
    "X-Doc-Pages": String(fit.pages), "X-Doc-Density": fit.dens, "X-Doc-Overflow": fit.overflow ? "1" : "0",
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${fileBase(d.num)}.pdf"`,
  }).send(Buffer.from(pdf));
}));

/**
 * 📦 ПАКЕТ УГОДИ (макет K-11/K-12b): обидва PDF — клієнтська й перевізницька заявка з тим самим № угоди.
 * Друга сторона — найновіша версія, і лише та, яку цей користувач і так бачить (та сама межа
 * `canSeeConstructorDoc`): пакет не може стати обхідним шляхом до чужого документа.
 */
constructorRouter.get("/documents/:id/pair.zip", h(async (req, res) => {
  const row = await visibleRow(req);
  if (row.doc_kind === "main") throw new HttpError(404, "Для основного договору пакета угоди немає.");
  const q = await pool.query<{ id: string; created_by: number }>(
    `SELECT id, created_by FROM constructor_documents
      WHERE deal_no = $1 AND party <> $2 AND doc_kind <> 'main'
      ORDER BY version DESC, created_at DESC`, [row.deal_no, row.party]);
  const other = q.rows.find((r) => canSeeConstructorDoc(req.auth!.userId, Number(r.created_by), canSeeAll(req)));
  if (!other) throw new HttpError(404, "Другої сторони цієї угоди у вашому архіві ще немає — сформуйте дзеркальну заявку.");
  const files: Array<{ name: string; data: Uint8Array }> = [];
  for (const id of [Number(row.id), Number(other.id)]) {
    const d = await stateById(req, id);
    const pdf = (await renderDocumentPdf(d.s, d.num, docImageDataUris(CONSTRUCTOR_ASSETS_DIR, d.s.ent, d.s.stamp))).pdf;
    files.push({ name: `${fileBase(d.num)}-${d.s.party === "carrier" ? "perevizny" : "klient"}.pdf`, data: pdf });
  }
  res.set({ "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${fileBase(String(row.deal_no))}-paket.zip"` })
    .send(Buffer.from(zipStore(files)));
}));

/* ── 🔁 КОНВЕРТЕР (макет K-15): тільки перетворення формату, у базу нічого не пишеться ── */
const MAX_CONVERT_BYTES = 20 * 1024 * 1024;
function fileFromBody(req: Request): { name: string; buf: Buffer } {
  const name = String(req.body?.name || "").slice(0, 200);
  const data = String(req.body?.data || "");
  if (!name || !data) throw new HttpError(400, "Оберіть файл.");
  const buf = Buffer.from(data, "base64");
  if (!buf.length) throw new HttpError(400, "Файл порожній.");
  if (buf.length > MAX_CONVERT_BYTES) throw new HttpError(413, "Файл більший за 20 МБ — такий конвертувати тут не вийде.");
  return { name, buf };
}
const attach = (name: string) => `attachment; filename="${name.replace(/[^\w.-]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`;

constructorRouter.post("/convert/to-pdf", h(async (req, res) => {
  const { name, buf } = fileFromBody(req);
  const kind = toPdfKind(name);
  if (!kind) throw new HttpError(400, "У PDF тут перетворюються лише DOCX, TXT, JPG і PNG.");
  let html: string;
  if (kind === "docx") {
    try { html = textPageHtml(splitParagraphs(docxText(parseDocx(buf)))); }
    catch (e) { if (e instanceof OfficeParseError) throw new HttpError(400, "Файл Word пошкоджений або це не .docx."); throw e; }
  } else if (kind === "txt") html = textPageHtml(splitParagraphs(buf.toString("utf8")));
  else html = imagePageHtml(kind, buf.toString("base64"));
  const pdf = await htmlToPdf(html);
  res.set({ "Content-Type": "application/pdf", "Content-Disposition": attach(outName(name, "pdf")) }).send(Buffer.from(pdf));
}));

constructorRouter.post("/convert/from-pdf", h(async (req, res) => {
  const { name, buf } = fileFromBody(req);
  const target = req.body?.target === "txt" ? "txt" : "docx";
  if (!/\.pdf$/i.test(name) && buf.subarray(0, 4).toString("latin1") !== "%PDF") throw new HttpError(400, "Це не PDF.");
  const dir = await mkdtemp(path.join(tmpdir(), "ctor-conv-"));
  try {
    const file = path.join(dir, "in.pdf");
    await writeFile(file, buf);
    const r = await extractText("pdf", buf, file);
    if (r.status === "failed") throw new HttpError(503, `PDF не прочитався: ${r.reason ?? "невідома причина"}.`);
    const paras = splitParagraphs(r.text ?? "");
    if (!paras.length) throw new HttpError(422, "У цьому PDF немає текстового шару — схоже, це скан. Розпізнавання сканів (OCR) у дашборді поки немає.");
    if (target === "txt") {
      res.set({ "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": attach(outName(name, "txt")) })
        .send("\uFEFF" + paras.join("\n\n"));
    } else {
      res.set({ "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "Content-Disposition": attach(outName(name, "docx")) })
        .send(Buffer.from(paragraphsDocx(paras)));
    }
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => undefined); }
}));

/* ── 🗂 ПУЛ ЗАЯВОК (рішення Сергія 30.09.2026): усі документи з автором — лише за правом ── */
function onlyPool(req: Request): void {
  if (!canSeeAll(req)) throw new HttpError(403, "Пул заявок доступний лише керівництву");
}

constructorRouter.get("/pool", h(async (req, res) => {
  onlyPool(req);
  const { where, params } = archiveWhere(req, false);
  const rows = await pool.query(
    `SELECT ${ARCHIVE_COLS}, COALESCE(m.name, u.full_name, u.email) AS author
       FROM constructor_documents d
       LEFT JOIN users u ON u.id = d.created_by
       LEFT JOIN managers m ON m.id = u.manager_id
      ${where} ORDER BY d.created_at DESC LIMIT 200`, params);
  res.json(rows.rows);
}));


constructorRouter.get("/pool/stats", h(async (req, res) => {
  onlyPool(req);
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
  const rows = await pool.query(POOL_STATS_SQL, [days]);
  res.json({ days, rows: rows.rows });
}));

/* ── Шаблони маршрутів: свої + спільні ── */
constructorRouter.get("/route-templates", h(async (req, res) => {
  const q = await pool.query(
    `SELECT id, owner_id, name, fields, intl, created_at FROM constructor_route_templates
      WHERE owner_id IS NULL OR owner_id = $1 ORDER BY created_at DESC`, [req.auth!.userId]);
  res.json(q.rows);
}));
constructorRouter.post("/route-templates", h(async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.fields) throw new HttpError(400, "Потрібні name і fields.");
  const q = await pool.query(
    `INSERT INTO constructor_route_templates (owner_id, name, fields, intl)
     VALUES ($1,$2,$3,$4) RETURNING id, owner_id, name, fields, intl, created_at`,
    [b.shared ? null : req.auth!.userId, String(b.name).slice(0, 200), JSON.stringify(b.fields), !!b.intl]);
  res.json(q.rows[0]);
}));
constructorRouter.delete("/route-templates/:id", h(async (req, res) => {
  await pool.query(
    "DELETE FROM constructor_route_templates WHERE id = $1 AND (owner_id = $2 OR owner_id IS NULL)",
    [idOf(req), req.auth!.userId]);
  res.json({ ok: true });
}));
