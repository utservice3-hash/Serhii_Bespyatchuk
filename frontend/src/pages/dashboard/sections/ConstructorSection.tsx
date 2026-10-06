/**
 * 📄 КОНСТРУКТОР ДОКУМЕНТІВ — екран за затвердженим макетом Сергія (`konstruktor-dokumentiv.html` v19,
 * еталони K-01…K-17 у `mockup/screens`). Розмітка й класи — макетні (CSS згенеровано з макета й ізольовано
 * під `.ctorx`, `constructor.css`); шрифти макета — лише тут (`mockFonts.css`, зі свого сервера).
 *
 * Логіка — з пакета (`client/ConstructorPage.tsx`) і вже перевірена на проді: способи вводу контрагента, рейс,
 * оплата, дзеркальна заявка, імпорт старої заявки, архів. Відмінності від макета — лише там, де макет жив
 * у браузері, а дашборд має сервер:
 *  - Word/PDF, пакет угоди, конвертер — через `api` з токеном (blob), бо вхід у нас заголовком, не кукою;
 *  - «Відкрити PDF» відкриває вкладку ДО очікування відповіді (після `await` браузер блокує вікно);
 *  - архів і довідник — у базі, а не в памʼяті браузера; PDF-файл реквізитів читає сервер (`pdftotext`);
 *    фото/скани — чесно «розпізнавання сканів поки немає» (OCR у дашборді немає);
 *  - «Пул заявок» і лічильник за день — вкладка для керівництва (рішення Сергія 30.09.2026).
 *
 * Інваріанти пакета (НЕ ламати): № заявки = ID угоди в Kommo, вручну, обовʼязковий; ФОП продає лише ФОПам, його
 * оплата — «СОФТ платіж»; дзеркальна заявка — ТІЛЬКИ за чекбоксом. IBAN перевізника з 02.10.2026
 * НЕОБОВʼЯЗКОВИЙ (рішення в чаті: перевізник однаково виставляє рахунок з IBAN) — лише сіра підказка.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  CTOR_EMPTY_FORM, ctorArchive, ctorByEdrpou, ctorCounterparties, ctorCreate, ctorDocument, ctorEntities, ctorFile, ctorMe,
  ctorParse, ctorParseOld, ctorPool, ctorPoolStats, ctorPreview, ctorRouteTemplates, ctorSaveCounterparty, ctorSaveRouteTemplate,
  ctorDeleteRouteTemplate, ctorPairZip, ctorConvertToPdf, ctorConvertFromPdf,
  type CtorArchiveRow, type CtorCounterparty, type CtorCounterpartyRow, type CtorEntityKey, type CtorEntityRow, type CtorForm,
  type CtorParty, type CtorRouteTemplate, type CtorStatDay, type CtorIssue, type CtorRegistryCard, type CtorEdrResult,
} from "../../../api";
import "./mockFonts.css";
import "./constructor.css";

/* ── Дані інтерфейсу з макета: колір і попередження юрособи (у БД їх немає — це вигляд, а не реквізити) ── */
const ENT_UI: Record<CtorEntityKey, { c: string; warn?: string; fallback: string }> = {
  uts: { c: "--e-uts", fallback: "ТОВ «Юнайтед Транспорт Сервіс»" },
  avm: { c: "--e-avm", fallback: "ТОВ «АвтоМув»" },
  fop: { c: "--e-fop", fallback: "ФОП Беспятчук С.С. · 2 група", warn: "Клієнти — лише ФОП; оплата — СОФТ платіж. Без печатки, лише підпис" },
};
/* Оформлення «Б» (v20): стартова щільність прев'ю за типом документа — та сама, з якої починає автопідгонка PDF
   (DENS_STEPS у docgen.ts пакета): клієнтська d1, перевізницька dc, основний dm. Підсумкову видно після «Сформувати». */
const DENS0: Record<string, string> = { once: "d1", carr: "dc", main: "dm" };
const DOCS: Array<{ k: string; t: string; p: CtorParty; off?: string; fopOff?: boolean }> = [
  { k: "once", t: "Разовий договір-заявка", p: "client" },
  { k: "main", t: "Основний договір", p: "client", fopOff: true },
  { k: "carr", t: "Разовий договір-заявка", p: "carrier" },
  { k: "mainc", t: "Основний договір", p: "carrier", off: "шаблону поки немає — за рішенням від 01.10 пропускаємо" },
];
const FIELDS: Array<[keyof CtorCounterparty, string]> = [
  ["name", "Назва"], ["edrpou", "ЄДРПОУ"], ["ipn", "ІПН / ПДВ"], ["addr", "Адреса"],
  ["iban", "IBAN"], ["bank", "Банк"], ["phone", "Телефон"], ["email", "Пошта"], ["dir", "Директор"],
];
/* Поля рейсу, порядок і позначка «обовʼязкове» — з `data/reference.ts` пакета (TRIP_FIELDS). */
const TRIP: Array<[string, string, 0 | 1]> = [
  ["route", "Маршрут", 1], ["cargo", "Вантаж, вага, пакування", 1], ["places", "Місця, габарити Д×Ш×В", 0],
  ["special", "Особливі умови", 0], ["shipper", "Вантажовідправник", 0], ["shipperC", "Контактна особа відправника, телефон", 0],
  ["loadAddr", "Адреса завантаження", 1], ["loadDate", "Дата, час навантаження", 1],
  ["consignee", "Вантажоодержувач", 0], ["consigneeC", "Контактна особа одержувача, телефон", 0],
  ["unloadAddr", "Адреси розвантаження — кожна точка через « · »", 1], ["unloadDate", "Дата, час доставки", 1],
  ["custAddr", "Адреса замитнення, контактна особа", 0], ["border", "Пункт переходу кордону", 0],
  ["decustAddr", "Адреса розмитнення, контактна особа", 0], ["reqs", "Вимоги до транспортного засобу", 0],
  ["truck", "Авто: марка, номери авто й причепа", 0], ["driver", "Водій: ПІБ, посвідчення, телефон", 0],
  ["otherResp", "Відповідальна особа другої сторони, телефон", 0], ["extra", "Додаткові умови", 0],
];
const INTL_KEYS = ["custAddr", "border", "decustAddr"];
const FULL = new Set(["route", "cargo", "special", "loadAddr", "unloadAddr", "custAddr", "decustAddr", "reqs", "truck", "driver", "otherResp", "extra"]);
/* Порядки й форми оплати — з `data/legalTexts.ts` пакета (PAY_ORDERS, PAY_ORDER_FOP, PAY_FORMS). */
const PAY_ORDERS = [
  "по отриманні документів", "до дати доставки вантажу",
  "80% після скан-копій документів, 20% після оригіналів (по 2 банк. дні)",
  "99% після скан-копій, решта після оригіналів", "відтермінування 14 календарних днів",
];
const PAY_ORDER_FOP = "оплата за реквізитами, наданими Експедитором";
const PAY_FORMS = ["б/г з ПДВ", "б/г без ПДВ", "готівка"];

type Way = "edr" | "book" | "text" | "file";
type FileChip = { name: string; st: string };

/** Відмова сервера: у blob-відповіді текст треба дочитати з Blob. */
async function errOf(e: unknown): Promise<string> {
  const d = (e as { response?: { data?: unknown; status?: number } }).response;
  if (d?.data instanceof Blob) {
    try { return (JSON.parse(await d.data.text()) as { error?: string }).error ?? `HTTP ${d.status}`; } catch { return `HTTP ${d.status}`; }
  }
  return (d?.data as { error?: string } | undefined)?.error ?? (e instanceof Error ? e.message : "не вдалося");
}
function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
/** Файл → base64 без префікса data:. */
function b64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(new Error("файл не прочитався"));
    r.readAsDataURL(file);
  });
}
const fmtDay = (s: string | null) => (s ? new Date(s).toLocaleDateString("uk-UA") : "—");
const fmtAt = (s: string) => new Date(s).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

/** `initial` — початковий стан форми (для звірки екрана з еталонами макета); у дашборді не передається. */
export function ConstructorSection({ initial }: { initial?: Partial<CtorForm> } = {}) {
  const [view, setView] = useState<"make" | "pool">("make");
  const [me, setMe] = useState<{ manager: { name: string; phone: string }; canSeeAll: boolean } | null>(null);
  const [entities, setEntities] = useState<CtorEntityRow[]>([]);
  const [form, setForm] = useState<CtorForm>(() => ({ ...CTOR_EMPTY_FORM, ...initial }));
  const [fragment, setFragment] = useState("");
  const [blocker, setBlocker] = useState<string | null>(null);
  /** ✅ Перевірка полів (затверджено 02.10.2026): список приходить із прев'ю, правила — лише на сервері. */
  const [issues, setIssues] = useState<CtorIssue[]>([]);
  const iss = (field: string) => issues.find((i) => i.field === field && i.level === "error") ?? issues.find((i) => i.field === field);
  const [assetsNote, setAssetsNote] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ t: string; bad?: boolean }>({ t: "" });
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<{ id: number; version: number; num: string; party: CtorParty } | null>(null);
  const [hasPair, setHasPair] = useState(false);
  const [mirrorCost, setMirrorCost] = useState("");
  const [pairMode, setPairMode] = useState(false);
  const [way, setWay] = useState<Way>("text");
  const [book, setBook] = useState<CtorCounterpartyRow[]>([]);
  const [bookQ, setBookQ] = useState("");
  const [bookPick, setBookPick] = useState<number | null>(null);
  const [edrq, setEdrq] = useState("");
  /** Звідки підставлено реквізити за ЄДРПОУ і чи є тривога реєстру (припинення, банкрутство). */
  const [edrNote, setEdrNote] = useState<{ t: string; warn?: string | null; bookIban?: { iban: string; bank: string } | null } | null>(null);
  const edrTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (edrTimer.current) clearTimeout(edrTimer.current); }, []);
  const [raw, setRaw] = useState("");
  const [files, setFiles] = useState<FileChip[]>([]);
  const [tpls, setTpls] = useState<CtorRouteTemplate[]>([]);
  const [archQ, setArchQ] = useState("");
  const [arch, setArch] = useState<CtorArchiveRow[] | null>(null);
  const [oldState, setOldState] = useState("");
  const [convState, setConvState] = useState("");
  const [pdfTarget, setPdfTarget] = useState<"docx" | "txt">("docx");
  const fileInput = useRef<HTMLInputElement>(null);
  const oldInput = useRef<HTMLInputElement>(null);
  const convInput = useRef<HTMLInputElement>(null);
  const pdfInput = useRef<HTMLInputElement>(null);

  const ok = (t: string) => setMsg({ t });
  const bad = async (e: unknown) => setMsg({ t: typeof e === "string" ? e : await errOf(e), bad: true });

  useEffect(() => {
    ctorMe().then(setMe).catch(() => {});
    ctorEntities().then(setEntities).catch(() => {});
    ctorRouteTemplates().then(setTpls).catch(() => {});
  }, []);
  useEffect(() => { if (way === "book") ctorCounterparties(bookQ).then(setBook).catch(() => {}); }, [bookQ, way]);
  const loadArch = useCallback(() => { ctorArchive(archQ).then(setArch).catch(() => setArch([])); }, [archQ]);
  useEffect(() => { const t = setTimeout(loadArch, 300); return () => clearTimeout(t); }, [loadArch]);

  const set = useCallback(<K extends keyof CtorForm>(k: K, v: CtorForm[K]) => setForm((f) => ({ ...f, [k]: v })), []);
  const setTrip = (k: string, v: string) => setForm((f) => ({ ...f, trip: { ...f.trip, [k]: v } }));
  const setCp = (k: keyof CtorCounterparty, v: string) => setForm((f) => ({ ...f, cp: { ...f.cp, [k]: v } }));
  const setPay = (k: keyof CtorForm["pay"], v: string) => setForm((f) => ({ ...f, pay: { ...f.pay, [k]: v } }));

  const entRow = (k: CtorEntityKey) => entities.find((e) => e.key === k);
  const E = entRow(form.ent);
  const fop = form.ent === "fop";
  const fopConflict = fop && form.party === "client" && !!form.cp.name && !/^ФОП/i.test(form.cp.name);
  const isMain = form.doc === "main";

  /* ── ФОП: форма оплати лише «СОФТ платіж», порядок — ФОП-овий (макет: syncPay) ── */
  useEffect(() => {
    setForm((f) => {
      if (f.ent === "fop") return f.pay.form === "СОФТ платіж" ? f : { ...f, pay: { ...f.pay, form: "СОФТ платіж", order: PAY_ORDER_FOP } };
      if (f.pay.form === "СОФТ платіж" || f.pay.order === PAY_ORDER_FOP)
        return { ...f, pay: { ...f.pay, form: f.pay.form === "СОФТ платіж" ? "б/г без ПДВ" : f.pay.form, order: f.pay.order === PAY_ORDER_FOP ? PAY_ORDERS[0] : f.pay.order } };
      return f;
    });
  }, [form.ent]);

  /* ── Прев'ю: серверний HTML документа в зменшеному аркуші (debounce 350 мс) ── */
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (view !== "make") return;
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try { const r = await ctorPreview(form); setFragment(r.fragment); setBlocker(r.blockers); setIssues(r.issues ?? []); setAssetsNote(r.assetsNote); }
      catch (e) { setBlocker(await errOf(e)); }
    }, 350);
    return () => clearTimeout(timer.current);
  }, [form, view]);

  /* Документ змінено після формування — бар «Сформовано» ховається (макет: render). */
  useEffect(() => {
    if (made && (made.num !== (isMain ? form.mainNo : form.dealNo) || made.party !== form.party)) setMade(null);
  }, [form.dealNo, form.mainNo, form.party]);

  /* ── Контрагент ── */
  const applyParsed = (cp: CtorCounterparty, onlyEmpty = false) =>
    setForm((f) => ({ ...f, cp: { ...f.cp, ...Object.fromEntries(Object.entries(cp).filter(([k, v]) => v && (!onlyEmpty || !f.cp[k as keyof CtorCounterparty]))) } }));
  /**
   * Вибрано ЦІЛОГО контрагента (1С, довідник, ЄДР) — реквізити ЗАМІНЮЮТЬСЯ, а не доповнюються. `applyParsed` пропускає
   * порожні значення, тож IBAN попередньої компанії лишався в полі нової, у якої рахунку немає (спіймано кліком
   * 06.10.2026: Фора → «Хелл Енерджі», підпис «у 1С рахунку немає», а в полі — рахунок Фори). Чужий IBAN у договорі.
   */
  const replaceCp = (cp: CtorCounterparty) => setForm((f) => ({ ...f, cp: { ...cp } }));

  const onParse = async () => {
    try { const r = await ctorParse(raw); applyParsed(r.out); ok(`Розпізнано ${Object.values(r.found).filter(Boolean).length} з 9 — перевірте поля з галочками.`); }
    catch (e) { await bad(e); }
  };
  const onFiles = async (list: FileList | File[]) => {
    const texts: string[] = [];
    const chips: FileChip[] = [];
    for (const f of Array.from(list)) {
      const ext = (f.name.split(".").pop() || "").toLowerCase();
      const chip: FileChip = { name: f.name, st: "⏳" };
      chips.push(chip);
      try {
        if (ext === "txt" || ext === "csv") { texts.push(await f.text()); chip.st = "✓ текст прочитано"; }
        else if (ext === "docx") { texts.push(await docxText(await f.arrayBuffer())); chip.st = "✓ текст прочитано"; }
        else if (ext === "pdf") {
          const blob = await ctorConvertFromPdf(f.name, await b64(f), "txt");
          texts.push(await blob.text()); chip.st = "✓ сервер прочитав текст PDF";
        } else chip.st = "✗ фото чи скан — розпізнавання сканів поки немає, впишіть вручну";
      } catch (e) { chip.st = "✗ " + (await errOf(e)); }
    }
    setFiles((prev) => [...prev, ...chips]);
    if (texts.length) {
      try { const r = await ctorParse(texts.join("\n")); applyParsed(r.out, true); ok("Реквізити з файлів підставлено — перевірте поля з галочками."); }
      catch (e) { await bad(e); }
    }
  };
  const onPickBook = (row: CtorCounterpartyRow) => {
    setBookPick(row.id);
    replaceCp({ name: row.name, edrpou: row.edrpou || "", ipn: row.ipn || "", addr: row.address || "", iban: row.iban || "",
      bank: row.bank || "", phone: row.phone || "", email: row.email || "", dir: row.director || "" });
    ok(`Підставлено з довідника: ${row.name}.`);
  };
  const onPickRegistry = (c: CtorRegistryCard, cached: boolean) => {
    setBookPick(null);
    replaceCp({ name: c.name, edrpou: c.edrpou, ipn: c.ipn, addr: c.addr, iban: "", bank: "", phone: c.phone, email: c.email, dir: c.dir });
    const at = c.actualDate ? new Date(c.actualDate).toLocaleDateString("uk-UA") : "—";
    setEdrNote({ t: `З ЄДР (YouControl), станом на ${at}${cached ? " · з кешу" : ""}. IBAN і банк у реєстрі немає — впишіть вручну.`, warn: c.warn });
    if (c.warn) void bad(`Увага: ${c.warn}. Перевірте, чи можна укладати договір.`);
    else ok(`Підставлено з ЄДР: ${c.name}.`);
  };
  /**
   * Реквізити з 1С (рахунок, банк, контакти) + директор/назва з ЄДР. Що з рахунком — кажемо словами: у 1С IBAN є
   * лише в ~4 з 10 клієнтів (замір 06.10.2026), і порожнє поле без підпису читалось би як «ще вантажиться».
   * `refill` — повтор, коли ЄДР оновлювався: підставляємо лише в ПОРОЖНІ поля, щоб не стерти вже виправлене руками.
   */
  const onPick1c = (r: Extract<CtorEdrResult, { source: "1c" }>, refill: boolean) => {
    const c = r.card;
    if (!refill) setBookPick(null);
    const cp = { name: c.name, edrpou: c.edrpou, ipn: c.ipn, addr: c.addr, iban: c.iban, bank: c.bank,
      phone: c.phone, email: c.email, dir: c.dir };
    if (refill) applyParsed(cp, true); else replaceCp(cp);
    const iban = c.ibanSource === "1c" ? "рахунок і банк — з 1С"
      : c.ibanSource === "book" ? "у 1С рахунку немає — IBAN з вашого довідника"
      : c.ibanInvalid1c ? `у 1С рахунок у неправильному форматі (${c.ibanInvalid1c}) — впишіть IBAN вручну`
      : "у 1С рахунку немає — впишіть IBAN вручну";
    const reg = r.registry === "ok" ? `директор і назва — з ЄДР${r.cached ? " (кеш)" : ""}`
      : r.registry === "updating" ? "директора з ЄДР ще немає: реєстр оновлює дані, повторюю за 20 с"
      : r.registry === "notFound" ? "у ЄДР коду немає — директора впишіть вручну"
      : r.registry === "unconfigured" ? "пошук у ЄДР не налаштовано — директора впишіть вручну"
      : `ЄДР зараз недоступний${r.registryWhy ? ` (${r.registryWhy})` : ""} — директора впишіть вручну`;
    setEdrNote({ t: `З 1С (бухгалтерія): ${iban}; ${reg}.`, warn: c.warn, bookIban: c.bookIban });
    if (c.warn) void bad(`Увага: ${c.warn}. Перевірте, чи можна укладати договір.`);
    else if (!refill) ok(`Підставлено з 1С: ${c.name}.`);
  };
  /** Підпис, коли 1С не змогли спитати: дані з довідника/ЄДР правдиві, але звірки з бухгалтерією не було. */
  const oneCTail = (r: { oneC?: "notFound" | "failed"; oneCWhy?: string | null }) =>
    r.oneC === "failed" ? ` ${r.oneCWhy ?? "1С недоступна"} — звірки з 1С не було.` : r.oneC === "notFound" ? " У 1С такого контрагента немає." : "";
  /** 202 — реєстр оновлює дані: повторюємо самі, до трьох разів із паузою 20 с (заміряно: ФОП ожив за ~20 с). */
  const onEdr = async (attempt = 0, refill = false) => {
    if (edrTimer.current) { clearTimeout(edrTimer.current); edrTimer.current = null; }
    setEdrNote(null);
    try {
      const r = await ctorByEdrpou(edrq);
      if ("updating" in r) {
        if (attempt >= 3) { await bad("Реєстр досі оновлює дані — спробуйте за кілька хвилин або впишіть реквізити вручну."); return; }
        ok(`${r.error} (спроба ${attempt + 1} з 3)`);
        edrTimer.current = setTimeout(() => void onEdr(attempt + 1), 20000);
        return;
      }
      if (r.source === "1c") {
        onPick1c(r, refill);
        if (r.registry === "updating" && attempt < 3) edrTimer.current = setTimeout(() => void onEdr(attempt + 1, true), 20000);
      } else if (r.source === "book") { onPickBook(r.row); setEdrNote({ t: `З вашого довідника контрагентів.${oneCTail(r)}` }); }
      else { onPickRegistry(r.card, r.cached); setEdrNote((n) => n && { ...n, t: n.t + oneCTail(r) }); }
    } catch (e) { await bad(e); }
  };

  /* ── Сформувати (макет: generate) ── */
  const onMake = async () => {
    if (blocker) { await bad(blocker); return; }
    setBusy(true);
    try {
      const r = await ctorCreate(form);
      setMade({ ...r, party: form.party });
      // v2: заявка мусить уміщатись у 3 сторінки; не влізла навіть у найщільнішому — текст попередження з пакета.
      setMsg(r.overflow
        ? { t: `Увага: заявка вийшла на ${r.pages} сторінки навіть у найщільнішому оформленні — скоротіть найдовші поля (адреси, вимоги, додаткові умови).`, bad: true }
        : { t: "" });
      if (form.cp.name) ctorSaveCounterparty(form.cp).catch(() => {});   // контрагент — у довідник для наступного разу
      loadArch();
      const others = await ctorArchive("", r.num).catch(() => []);
      setHasPair(others.some((x) => x.party !== form.party && x.doc_kind !== "main"));
      if (pairMode && form.doc !== "main") setTimeout(doMirror, 250);  // пакетний — тільки за чекбоксом
    } catch (e) { await bad(e); }
    finally { setBusy(false); }
  };

  /* ── Дзеркальна заявка: рейс і № зберігаються ── */
  const doMirror = () => {
    setForm((f) => {
      const toClient = f.party === "carrier";
      setMirrorCost(toClient ? f.pay.sum : "");
      return { ...f, party: toClient ? "client" : "carrier", doc: toClient ? "once" : "carr", cp: {}, pay: { ...f.pay, sum: "" }, trip: { ...f.trip, otherResp: "" } };
    });
    ok("Рейс і № угоди перенесено в заявку для другої сторони — додайте контрагента і його суму.");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  /* ── Файли документа ── */
  const download = async (id: number, num: string, kind: "docx" | "pdf") => {
    try { saveBlob(await ctorFile(id, kind), `${num || "document"}.${kind}`); } catch (e) { await bad(e); }
  };
  const openPdf = async (id: number) => {
    const w = window.open("", "_blank");                   // до await — інакше браузер заблокує вікно
    try {
      const blob = await ctorFile(id, "pdf", true);
      if (!w) { saveBlob(blob, `${id}.pdf`); return; }
      const url = URL.createObjectURL(blob);
      w.location.href = url;
      setTimeout(() => URL.revokeObjectURL(url), 120_000);
    } catch (e) { w?.close(); await bad(e); }
  };
  const printPdf = async (id: number) => {
    try {
      const url = URL.createObjectURL(await ctorFile(id, "pdf", true));
      const f = document.createElement("iframe");
      f.style.position = "fixed"; f.style.right = "0"; f.style.bottom = "0"; f.style.width = "0"; f.style.height = "0"; f.style.border = "0";
      f.src = url;
      f.onload = () => { try { f.contentWindow?.focus(); f.contentWindow?.print(); } catch { void openPdf(id); } };
      document.body.appendChild(f);
      setTimeout(() => { f.remove(); URL.revokeObjectURL(url); }, 120_000);
    } catch (e) { await bad(e); }
  };
  const savePair = async (id: number, num: string) => {
    try { saveBlob(await ctorPairZip(id), `${num}-paket.zip`); } catch (e) { await bad(e); }
  };

  /* ── Архів: «У форму», імпорт старої заявки ── */
  const onLoadArchived = async (id: number) => {
    try {
      const row = await ctorDocument(id) as {
        entity_key: CtorEntityKey; doc_kind: CtorForm["doc"]; party: CtorParty; intl: boolean; with_stamp: boolean; fop_account: number;
        contractor: CtorForm["cp"]; trip: Record<string, string>; pay: CtorForm["pay"]; deal_no: string; doc_date: string | null; main_date: string | null; main_until: string | null;
      };
      setForm({ ent: row.entity_key, doc: row.doc_kind, party: row.party, intl: row.intl, stamp: row.with_stamp, fopAcc: row.fop_account,
        cp: row.contractor, trip: row.trip, pay: row.pay, dealNo: row.doc_kind === "main" ? "" : row.deal_no,
        docDate: row.doc_date ? String(row.doc_date).slice(0, 10) : "", mainNo: row.doc_kind === "main" ? row.deal_no : "", mainDate: row.main_date || "", mainUntil: row.main_until || "" });
      setMade(null);
      ok("Заявку піднято у форму — внесіть правки і сформуйте нову версію з тим самим №.");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) { await bad(e); }
  };
  const onImportOld = async (f: File) => {
    setOldState("⏳ читаю…");
    try {
      const r = await ctorParseOld(/\.docx$/i.test(f.name) ? await docxText(await f.arrayBuffer()) : await f.text());
      setForm((prev) => ({ ...prev, party: r.party, doc: r.party === "carrier" ? "carr" : "once", ent: (r.ent as CtorEntityKey) || prev.ent,
        dealNo: r.dealNo || prev.dealNo, intl: !!r.intl,
        cp: { ...prev.cp, ...Object.fromEntries(Object.entries(r.cp).filter(([, v]) => v)) }, trip: { ...prev.trip, ...r.trip },
        pay: r.pay ? { ...prev.pay, ...r.pay } : prev.pay }));
      setMade(null);
      setOldState(`✓ заявку № ${r.dealNo || "—"} (${r.party === "carrier" ? "перевізник" : "клієнт"}) піднято у форму`);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) { setOldState("✗ " + (await errOf(e))); }
  };

  /* ── Шаблони маршрутів ── */
  const saveTpl = async () => {
    try {
      await ctorSaveRouteTemplate({ name: form.trip.route || "Без назви", intl: form.intl,
        fields: Object.fromEntries(["route", "cargo", "places", "special", "loadAddr", "unloadAddr", "reqs"].map((k) => [k, form.trip[k] || ""])) });
      setTpls(await ctorRouteTemplates());
      ok(`Маршрут «${form.trip.route || "Без назви"}» збережено в шаблони.`);
    } catch (e) { await bad(e); }
  };

  /* ── Конвертер ── */
  const convToPdf = async (f: File) => {
    setConvState(`⏳ ${f.name} → PDF…`);
    try { saveBlob(await ctorConvertToPdf(f.name, await b64(f)), f.name.replace(/\.[^.]+$/, "") + ".pdf"); setConvState(`✓ ${f.name} → PDF збережено`); }
    catch (e) { setConvState("✗ " + (await errOf(e))); }
  };
  const convFromPdf = async (f: File) => {
    setConvState(`⏳ ${f.name} → ${pdfTarget.toUpperCase()}…`);
    try { saveBlob(await ctorConvertFromPdf(f.name, await b64(f), pdfTarget), f.name.replace(/\.[^.]+$/, "") + "." + pdfTarget); setConvState(`✓ ${f.name} → ${pdfTarget.toUpperCase()} збережено`); }
    catch (e) { setConvState("✗ " + (await errOf(e))); }
  };

  const margin = useMemo(() => {
    const n = (s: string) => parseFloat(s.replace(/[^\d.,]/g, "").replace(",", ".")) || 0;
    return mirrorCost && form.pay.sum ? n(form.pay.sum) - n(mirrorCost) : null;
  }, [mirrorCost, form.pay.sum]);

  const got = FIELDS.filter(([k]) => form.cp[k]).length;
  const num = (isMain ? form.mainNo : form.dealNo) || (isMain ? "______" : "______ (ID угоди)");
  const docsHere = DOCS.filter((d) => d.p === form.party);
  const offOf = (d: (typeof DOCS)[number]) => d.off || (d.fopOff && fop ? "основний договір від ФОП — шаблону немає" : null);
  const rootStyle = { "--ent": `var(${ENT_UI[form.ent].c})` } as CSSProperties;
  const mgr = me?.manager;

  return (
    <div className="ctorx" style={rootStyle}>
      <div className="top">
        <h1>Конструктор документів</h1>
        <div className="grow" />
        <div className="asrole" title="Підставляється в кожну заявку автоматично. Змінюється в картці співробітника.">
          <label>Менеджер</label>
          <span style={{ fontSize: 12.5, fontWeight: 600, paddingRight: 4 }}>
            {mgr ? `${mgr.name || "—"}${mgr.phone ? " · " + mgr.phone : ""}` : "…"}
          </span>
          {mgr && !mgr.phone && <span style={{ fontSize: 11, color: "var(--warn)", fontWeight: 600 }}>телефону в картці немає</span>}
        </div>
      </div>

      {me?.canSeeAll && (
        <div className="viewtabs" role="group" aria-label="Розділ">
          <button aria-pressed={view === "make"} onClick={() => setView("make")}>Конструктор</button>
          <button aria-pressed={view === "pool"} onClick={() => setView("pool")}>Пул заявок</button>
        </div>
      )}

      {view === "pool" && me?.canSeeAll ? <PoolView onOpen={openPdf} onDownload={download} /> : (<>
        {/* ── Юрособа ── */}
        <div className="entities">
          {(["uts", "avm", "fop"] as CtorEntityKey[]).map((k) => {
            const e = entRow(k); const ui = ENT_UI[k];
            return (
              <button key={k} className="ent" style={{ "--ec": `var(${ui.c})` } as CSSProperties} aria-pressed={form.ent === k}
                onClick={() => setForm((f) => ({ ...f, ent: k, doc: k === "fop" && f.doc === "main" ? "once" : f.doc }))}>
                <span className="nm">{e?.name ?? ui.fallback}</span>
                <span className="vat">{e?.vat_label ?? ""}</span>
                <span className="sub">{e ? `ЄДРПОУ ${e.edrpou}` : ""}</span>
                {ui.warn && <span className="warn">⚠ {ui.warn}</span>}
              </button>
            );
          })}
        </div>

        {/* ── Сторона договору ── */}
        <div className="party">
          {([["client", "Договір із клієнтом", "ми організовуємо перевезення для Замовника",
              <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" /></>],
            ["carrier", "Договір із перевізником", "ми замовляємо перевезення й платимо за нього",
              <><path d="M1 3h15v13H1zM16 8h4l3 3v5h-7V8z" /><circle cx="5.5" cy="18.5" r="2.5" /><circle cx="18.5" cy="18.5" r="2.5" /></>]] as const).map(([k, n, d, ic]) => (
            <button key={k} className="pcard" aria-pressed={form.party === k}
              onClick={() => setForm((f) => ({ ...f, party: k, doc: k === "carrier" ? "carr" : (f.doc === "carr" ? "once" : f.doc) }))}>
              <span className="ic"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">{ic}</svg></span>
              <span><span className="nm">{n}</span><br /><span className="ds">{d}</span></span>
            </button>
          ))}
        </div>

        {/* ── Тип документа ── */}
        <div className="doctabs">
          {docsHere.map((d) => offOf(d)
            ? <button key={d.k} className="doctab" disabled title={offOf(d)!} style={{ opacity: .45, cursor: "not-allowed" }}>{d.t}<span className="p">скоро</span></button>
            : <button key={d.k} className="doctab" aria-pressed={form.doc === d.k} onClick={() => set("doc", d.k as CtorForm["doc"])}>
                {d.t}<span className="p">{d.p === "carrier" ? "перевізник" : "клієнт"}</span></button>)}
        </div>

        <div className="grid">
          <main className="card">
            {/* ── 1. Контрагент ── */}
            <div className="sec">
              <h3><span className="n">1</span>Контрагент</h3>
              <p className="hint">{form.party === "carrier"
                ? "Перевізник, якого ставимо другою стороною. Реквізити зазвичай приходять текстом у Viber — тому спосіб «Текстом» тут головний."
                : "Кого вписуємо другою стороною. Три способи — обирайте той, що швидший у конкретний момент."}</p>
              <div className="ways" role="group" aria-label="Спосіб вводу">
                {([["edr", "За ЄДРПОУ"], ["book", "Довідник"], ["text", "Текстом"], ["file", "Файлом"]] as Array<[Way, string]>).map(([k, l]) => (
                  <button key={k} aria-pressed={way === k} onClick={() => setWay(k)}>{l}</button>
                ))}
              </div>
              {way === "edr" && (
                <div className="way">
                  <div style={{ display: "flex", gap: 9, flexWrap: "wrap", alignItems: "center" }}>
                    <input type="text" value={edrq} onChange={(e) => setEdrq(e.target.value.replace(/\D/g, "").slice(0, 10))} placeholder="8 цифр коду ЄДРПОУ"
                      inputMode="numeric" onKeyDown={(e) => { if (e.key === "Enter") void onEdr(); }}
                      style={{ flex: "0 1 220px", fontFamily: "var(--mono)", letterSpacing: ".08em" }} />
                    <button className="btn pri sm" onClick={() => void onEdr()}>Підтягнути реквізити</button>
                    <span style={{ fontSize: 11.5, color: "var(--muted)" }}>Спершу — 1С (рахунок і контакти), директор — з ЄДР; якщо в 1С немає — ваш довідник, потім ЄДР через YouControl.</span>
                  </div>
                  {edrNote && <div style={{ fontSize: 12, marginTop: 7, color: edrNote.warn ? "var(--bad)" : "var(--muted)" }}>
                    {edrNote.warn && <b>⚠ {edrNote.warn}. </b>}{edrNote.t}
                    {edrNote.bookIban && <div style={{ marginTop: 5, color: "var(--text)" }}>
                      ⚠ У вашому довіднику інший IBAN: <span style={{ fontFamily: "var(--mono)" }}>{edrNote.bookIban.iban}</span>
                      {edrNote.bookIban.bank ? ` (${edrNote.bookIban.bank})` : ""}. Підставлено з 1С — саме на нього підуть платежі.{" "}
                      <button className="btn sm" onClick={() => { const b = edrNote.bookIban!; applyParsed({ iban: b.iban, bank: b.bank } as CtorCounterparty);
                        setEdrNote((n) => n && { ...n, bookIban: null, t: n.t + " IBAN замінено на довідниковий." }); }}>Взяти з довідника</button>
                    </div>}</div>}
                </div>
              )}
              {way === "book" && (
                <div className="way">
                  <input type="search" value={bookQ} onChange={(e) => setBookQ(e.target.value)} placeholder="Пошук за назвою або ЄДРПОУ…" />
                  <div className="book">
                    {book.length === 0 && <span style={{ fontSize: 12.5, color: "var(--muted)" }}>У довіднику нічого не знайдено. Контрагент потрапляє сюди сам після першого «Сформувати».</span>}
                    {book.map((b) => (
                      <button key={b.id} className="bookrow" aria-pressed={bookPick === b.id} onClick={() => onPickBook(b)}>
                        <span><span className="n">{b.name}</span><span className="m">{b.edrpou ? `ЄДРПОУ ${b.edrpou}` : "без коду"}{b.iban ? ` · ${b.iban.slice(0, 10)}…` : ""}</span></span>
                        <span className="last">останній договір<br />{fmtDay(b.last_doc_at)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {way === "text" && (
                <div className="way">
                  <textarea spellCheck={false} value={raw} onChange={(e) => setRaw(e.target.value)} placeholder="Вставте реквізити як є — з листа, Viber чи рахунку." />
                  <div style={{ display: "flex", gap: 9, marginTop: 9, flexWrap: "wrap", alignItems: "center" }}>
                    <button className="btn pri sm" disabled={!raw.trim()} onClick={() => void onParse()}>Розпізнати реквізити</button>
                    <button className="btn sm" onClick={() => setRaw("")}>Очистити</button>
                    <span style={{ fontSize: 11.5, color: "var(--muted)" }}>Вставте як є — з листа, Viber чи рахунку.</span>
                  </div>
                </div>
              )}
              {way === "file" && (
                <div className="way">
                  <div className="drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void onFiles(e.dataTransfer.files); }}>
                    <b>Перетягніть файли реквізитів сюди</b>
                    <span>Можна кілька одразу. TXT і DOCX читаються прямо тут; PDF читає сервер дашборда. Фото й скани поки не розпізнаються.</span>
                    <div className="fmt">{["DOCX", "TXT", "PDF", "JPG", "PNG"].map((x) => <span key={x} className="fchip">{x}</span>)}</div>
                    <button className="btn sm" type="button" style={{ marginTop: 12 }} onClick={() => fileInput.current?.click()}>＋ Обрати файли</button>
                    <input ref={fileInput} type="file" multiple hidden accept=".docx,.txt,.csv,.pdf,.jpg,.jpeg,.png"
                      onChange={(e) => { if (e.target.files) void onFiles(e.target.files); e.target.value = ""; }} />
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 9 }}>
                    {files.map((f, i) => (
                      <div key={i} style={{ display: "flex", gap: 9, alignItems: "center", border: "1px solid var(--line)", borderRadius: 9, padding: "7px 11px", fontSize: 12.5 }}>
                        <span className="ext">{(f.name.split(".").pop() || "").toUpperCase()}</span>
                        <span style={{ fontWeight: 600 }}>{f.name}</span>
                        <span style={{ marginLeft: "auto", color: "var(--muted)" }}>{f.st}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="fields">
                <div className="fhead"><span>Реквізити контрагента</span>
                  <span className="score" style={{ color: got === FIELDS.length ? "var(--ok)" : "var(--warn)" }}>{got} з {FIELDS.length} заповнено</span>
                  <button className="btn sm" style={{ marginLeft: 8, textTransform: "none", letterSpacing: 0 }} disabled={!form.cp.name}
                    onClick={() => void ctorSaveCounterparty(form.cp).then((r) => ok(`«${r.name}» збережено в довідник.`)).catch(bad)}>💾 У довідник</button>
                </div>
                {FIELDS.map(([k, l]) => {
                  const v = form.cp[k] || "";
                  // IBAN і банк перевізника — необовʼязкові з 02.10.2026 (перевізник вказує їх у рахунку): порожнє поле
                  // не «!» і не «впишіть вручну», а сіре «—» з поясненням — інакше виглядає як обовʼязкове.
                  const optional = form.party === "carrier" && (k === "iban" || k === "bank");
                  const is = iss(`cp.${k}`);
                  // перевірка поверх «заповнено/ні»: 🔴 — «✕», 🟡 — «⚠», пояснення під полем
                  const st = is ? (is.level === "error" ? "err" : "wrn") : v ? "ok" : optional ? "opt" : "no";
                  return (
                    <div key={k} className={`frow ${v || optional ? "" : "miss"} ${is ? "has-" + st : ""}`}>
                      <label htmlFor={`f-${k}`}>{l}</label>
                      <input id={`f-${k}`} value={v} placeholder={optional ? "необовʼязково — перевізник вкаже в рахунку" : "впишіть вручну"} onChange={(e) => setCp(k, e.target.value)} />
                      <span className={`st ${st}`} title={is?.msg ?? (!v && optional ? "Необовʼязкове поле" : undefined)}>{is ? (is.level === "error" ? "✕" : "⚠") : v ? "✓" : optional ? "—" : "!"}</span>
                      {is && <div className={`fmsg ${st}`}>{is.msg}</div>}
                    </div>
                  );
                })}
                {form.party === "carrier" && !form.cp.iban && (
                  <div className="ibannote soft">IBAN не вказано — у реквізитах перевізника рядка «п/р» не буде. Заявку можна сформувати.</div>
                )}
              </div>
              {fopConflict && (
                <div className="fopwarn"><b>Від ФОП Беспятчука клієнтом може бути лише інший ФОП.</b> Контрагент — {form.cp.name}. Оберіть ЮТС або АвтоМув,
                  інакше документ не сформується. Перевізник від ФОП може бути будь-який — там ми покупець.</div>
              )}
            </div>

            {/* ── 2. Рейс / Номер і дата основного ── */}
            {!isMain ? (
              <div className="sec">
                <h3><span className="n">2</span>Рейс
                  <button className="btn sm" type="button" style={{ marginLeft: "auto", fontWeight: 600 }} title="Запамʼятати маршрут, вантаж і адреси як шаблон" onClick={() => void saveTpl()}>💾 У шаблони</button>
                  <button className="btn sm" type="button" style={{ fontWeight: 600 }} onClick={() => setForm((f) => ({ ...f, trip: {}, intl: false }))}>Очистити все</button></h3>
                <div style={{ display: "flex", gap: 7, flexWrap: "wrap", margin: "0 0 12px 30px" }}>
                  {tpls.length ? tpls.map((t) => (
                    <span key={t.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, border: "1px dashed var(--line)", borderRadius: 999, padding: "4px 6px 4px 12px", fontSize: 12, background: "var(--surface-2)" }}>
                      <button style={{ fontWeight: 600 }} onClick={() => setForm((f) => ({ ...f, intl: t.intl, trip: { ...f.trip, ...t.fields } }))}>{t.name}{t.owner_id == null ? " · спільний" : ""}</button>
                      {t.owner_id != null && <button title="Прибрати шаблон" style={{ color: "var(--muted)", padding: "0 5px" }}
                        onClick={() => void ctorDeleteRouteTemplate(t.id).then(ctorRouteTemplates).then(setTpls)}>✕</button>}
                    </span>
                  )) : <span style={{ fontSize: 12, color: "var(--muted)" }}>Шаблонів ще немає — заповніть рейс і натисніть «У шаблони».</span>}
                </div>
                <p className="hint">Те, що потрапляє в таблицю заявки. Порожні поля залишаться прочерками — документ сформується, але покаже, чого бракує.</p>
                <div className="g2">
                  <label className="fld full" style={{ display: "flex", alignItems: "center", gap: 9, padding: "9px 12px", border: "1px dashed var(--line)", borderRadius: 10, cursor: "pointer", fontSize: 13 }}>
                    <input type="checkbox" checked={form.intl} onChange={(e) => set("intl", e.target.checked)} style={{ width: 16, height: 16, accentColor: "var(--ent)" }} />
                    Міжнародне перевезення <span style={{ color: "var(--muted)" }}>— додає замитнення, кордон і розмитнення</span></label>
                  {TRIP.filter(([k]) => form.intl || !INTL_KEYS.includes(k)).map(([k, l, req]) => (
                    <div key={k} className={`fld ${FULL.has(k) ? "full" : ""}`}>
                      <label htmlFor={`t-${k}`}>{k === "otherResp" ? (form.party === "carrier" ? "Відповідальна особа Перевізника, телефон" : "Відповідальна особа Замовника, телефон") : l}
                        {!req && <span style={{ color: "var(--muted)", fontWeight: 400 }}> · необов’язкове</span>}</label>
                      <input type="text" id={`t-${k}`} value={form.trip[k] || ""} onChange={(e) => setTrip(k, e.target.value)} />
                      <FieldMsg is={iss(`trip.${k}`)} />
                    </div>
                  ))}
                </div>
                <div className="payrow">
                  <div className="fld"><label htmlFor="paysum">Плата, сума <span style={{ color: "var(--bad)" }}>*</span></label><input type="text" id="paysum" value={form.pay.sum} onChange={(e) => setPay("sum", e.target.value)} />
                    <FieldMsg is={iss("pay.sum")} />
                    {margin !== null && <span style={{ display: "block", fontSize: 11.5, color: margin >= 0 ? "var(--ok)" : "var(--bad)", fontWeight: 600, marginTop: 3 }}>маржа {margin.toLocaleString("uk-UA")}</span>}</div>
                  <div className="fld"><label htmlFor="paycur">Валюта</label><select id="paycur" value={form.pay.cur} onChange={(e) => setPay("cur", e.target.value)}>
                    <option>грн</option><option>€ по курсу НБУ на день завантаження</option></select></div>
                  <div className="fld"><label htmlFor="payform">Форма</label><select id="payform" value={form.pay.form} disabled={fop} onChange={(e) => setPay("form", e.target.value)}>
                    {(fop ? ["СОФТ платіж"] : PAY_FORMS).map((o) => <option key={o}>{o}</option>)}</select></div>
                  <div className="fld"><label htmlFor="payorder">Порядок і строки оплати</label><select id="payorder" value={form.pay.order} onChange={(e) => setPay("order", e.target.value)}>
                    {(fop ? [PAY_ORDER_FOP, ...PAY_ORDERS] : PAY_ORDERS).concat(PAY_ORDERS.includes(form.pay.order) || form.pay.order === PAY_ORDER_FOP || !form.pay.order ? [] : [form.pay.order]).map((o) => <option key={o}>{o}</option>)}</select></div>
                </div>
                <div className="g2" style={{ marginTop: 10 }}>
                  <div className="fld full"><label>Відповідальна особа Експедитора <span style={{ color: "var(--ok)", fontWeight: 700 }}>· авто з профілю</span></label>
                    <input type="text" readOnly value={mgr ? `${mgr.name}${mgr.phone ? ", " + mgr.phone : ""}` : ""}
                      style={{ background: "color-mix(in srgb, var(--ok) 7%, var(--surface-2))", cursor: "default" }} /></div>
                </div>
              </div>
            ) : (
              <div className="sec">
                <h3><span className="n">2</span>Номер і дата договору</h3>
                <p className="hint">Номер основного договору менеджер вносить вручну — після погодження. Дата — з якого числа договір діє.</p>
                <div className="g2">
                  <div className="fld"><label htmlFor="mainNo">№ договору</label><input type="text" id="mainNo" value={form.mainNo} onChange={(e) => set("mainNo", e.target.value)} placeholder="напр. 62555699 або UTS-2026-15" /></div>
                  <div className="fld"><label htmlFor="mainDate">Дата договору (діє з)</label><input type="text" id="mainDate" value={form.mainDate} onChange={(e) => set("mainDate", e.target.value)} placeholder="напр. 01.10.2026" /></div>
                </div>
                {/* 📅 Строк дії (п. 8.1). Порожньо — 31 грудня року дати договору (рішення Романа 01.10.2026). */}
                <div className="g2" style={{ marginTop: 9 }}>
                  <div className="fld"><label htmlFor="mainUntil">Діє до</label><input type="text" id="mainUntil" value={form.mainUntil} onChange={(e) => set("mainUntil", e.target.value)}
                    placeholder={/\d{4}/.test(form.mainDate) ? `31.12.${/\d{4}/.exec(form.mainDate)![0]} — якщо не змінювати` : "напр. 31.12.2026"} /></div>
                </div>
              </div>
            )}

            {/* ── 3. Умови та санкції ── */}
            <div className="sec">
              <h3><span className="n">3</span>Умови та санкції</h3>
              <p className="hint">Підставляються з картки юрособи. Міняються тільки свідомо — і зміна видно в документі.</p>
              <div className="terms">
                {fop && E?.accounts && E.accounts.length > 1 && (
                  <div className="t"><b>Рахунок у документі</b><span>
                    <select value={form.fopAcc} onChange={(e) => set("fopAcc", +e.target.value)}
                      style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "4px 8px", background: "var(--surface)", fontSize: 12 }}>
                      {E.accounts.map((a, i) => <option key={i} value={i}>{a.bank}</option>)}
                    </select></span></div>
                )}
                {(E?.fines?.rows ?? []).map(([k, v]) => <div key={k} className="t"><b>{k}</b><span>{v}</span></div>)}
                <div className="t"><b>Нормативний простій</b><span style={{ maxWidth: "58%" }}>{E?.dwell_default ?? "—"}</span></div>
                {E?.fines?.note && <p className="note">{E.fines.note}</p>}
                <p className="note">Пеня за прострочення оплати — подвійна облікова ставка НБУ за кожен день. Однакова для всіх трьох юросіб.</p>
              </div>
            </div>

            {/* ── 4. Підпис і печатка ── */}
            <div className="sec">
              <h3><span className="n">4</span>Підпис і печатка</h3>
              <p className="hint">Наш бік підписується автоматично. Підпис контрагента — окремий крок після формування.</p>
              <div className="toggle">
                <button className="sw" aria-pressed={form.stamp} aria-label="Ставити підпис і печатку" onClick={() => set("stamp", !form.stamp)} />
                <span className="tx">{form.stamp
                  ? (fop ? <>Підпис ставиться автоматично<em>Підписант: {E?.director_short ?? "Беспятчук С.С."} · ФОП працює без печатки, і це законно</em></>
                         : <>Підпис і печатка ставляться автоматично<em>Підписант: {E?.director_short ?? ""} · зображення з картки юрособи</em></>)
                  : <>Документ формується без підпису<em>Знадобиться, якщо підписуєте від руки або через КЕП</em></>}</span>
              </div>
              {assetsNote && form.stamp && <p className="hint" style={{ color: "var(--bad)", marginTop: 8 }}>{assetsNote}</p>}
            </div>

            <div className="actbar">
              {!isMain && (<>
                <div className="fld" style={{ minWidth: 190 }}>
                  <label htmlFor="dealNo" style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--muted)", marginBottom: 3 }}>№ заявки = ID угоди в СРМ <span style={{ color: "var(--bad)" }}>*</span></label>
                  <input type="text" id="dealNo" value={form.dealNo} onChange={(e) => set("dealNo", e.target.value.trim())} placeholder="напр. 61575919" inputMode="numeric"
                    style={{ width: "100%", border: "1px solid var(--line)", borderRadius: 9, background: "var(--surface)", padding: "8px 11px", fontFamily: "var(--mono)", fontSize: 13 }} />
                  <FieldMsg is={iss("dealNo")} />
                </div>
                <div className="fld" style={{ minWidth: 150 }}>
                  <label htmlFor="docDate" style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--muted)", marginBottom: 3 }}>Дата договору</label>
                  <input type="date" id="docDate" value={form.docDate} onChange={(e) => set("docDate", e.target.value)}
                    style={{ width: "100%", border: "1px solid var(--line)", borderRadius: 9, background: "var(--surface)", padding: "7px 10px", fontSize: 13 }} />
                  <FieldMsg is={iss("docDate")} />
                </div>
              </>)}
              <button className="btn pri" style={{ alignSelf: "flex-end" }} disabled={busy || fopConflict} onClick={() => void onMake()}>{busy ? "Формую…" : "Сформувати документ"}</button>
              <IssueSummary issues={issues} />
              {!isMain && (
                <label style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, color: "var(--ink-2)", alignSelf: "flex-end", paddingBottom: 9, cursor: "pointer" }}>
                  <input type="checkbox" checked={pairMode} onChange={(e) => setPairMode(e.target.checked)} style={{ width: 15, height: 15, accentColor: "var(--ent)" }} />
                  після формування — одразу друга сторона угоди</label>
              )}
              {msg.t && <span className={`msg ${msg.bad ? "bad" : "ok"}`}>{msg.t}</span>}
            </div>
            {made && (
              <div className="actbar" style={{ borderTop: 0, background: "color-mix(in srgb, var(--ok) 8%, var(--surface-2))" }}>
                <span style={{ fontSize: 13, fontWeight: 700 }}>Сформовано № {made.num}{made.version > 1 ? ` · v${made.version}` : ""}</span>
                <button className="btn pri sm" onClick={() => void openPdf(made.id)}>👁 Відкрити PDF</button>
                <button className="btn pri sm" onClick={() => void download(made.id, made.num, "pdf")}>⬇ Зберегти PDF</button>
                <button className="btn pri sm" style={{ background: "var(--ink)", borderColor: "var(--ink)" }} onClick={() => void download(made.id, made.num, "docx")}>⬇ Зберегти Word</button>
                {hasPair && <button className="btn sm" onClick={() => void savePair(made.id, made.num)}>⬇ Пакет угоди: обидва PDF (zip)</button>}
                <button className="btn sm" title="Якщо вікно дозволяє друк" onClick={() => void printPdf(made.id)}>🖨 Друк</button>
                {!isMain && <button className="btn sm" onClick={doMirror}>{made.party === "carrier" ? "→ Таку ж для клієнта" : "→ Таку ж для перевізника"}</button>}
                <span style={{ fontSize: 11.5, color: "var(--muted)", marginLeft: "auto" }}>заявку збережено в архів нижче</span>
              </div>
            )}
          </main>

          {/* ── Прев'ю — той самий серверний шаблон, що PDF і Word ── */}
          <section className="card preview">
            <div className="pvhead">
              <span className="t">Попередній перегляд</span>
              <span style={{ fontSize: 11.5, color: "var(--muted)" }}>оновлюється на ходу</span>
              <span className="num">{num}</span>
            </div>
            {blocker && <div style={{ padding: "8px 14px", fontSize: 12, color: "var(--warn)", borderBottom: "1px solid var(--line-2)" }}>⚠ {blocker}</div>}
            <div className="pvbody"><div className="a4"><div className={`docfmt doc-b ent-${form.ent} dens-${DENS0[form.doc] ?? "d1"} docsm`} dangerouslySetInnerHTML={{ __html: fragment }} /></div></div>
          </section>
        </div>

        {/* ── Архів заявок ── */}
        <section className="card conv">
          <div className="in">
            <h3>Архів заявок</h3>
            <p>Кожне формування зберігається. Відкрийте заявку, виправте й сформуйте наново — номер лишається той самий, бо це та сама угода.
              Стару заявку, зроблену ще в СРМ, можна підняти з файлу — система розбере її в поля. Тут лише ваші документи.</p>
            <div style={{ display: "flex", gap: 9, marginBottom: 11, flexWrap: "wrap", alignItems: "center" }}>
              <input type="search" value={archQ} onChange={(e) => setArchQ(e.target.value)} placeholder="🔍 Пошук: №, контрагент, маршрут, вантаж, водій…"
                style={{ flex: "1 1 260px", width: "auto" }} />
              <button className="btn sm" onClick={() => oldInput.current?.click()}>⬆ Підняти стару заявку з файлу (.docx)</button>
              <input ref={oldInput} type="file" accept=".docx,.txt" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void onImportOld(f); e.target.value = ""; }} />
              <span style={{ fontSize: 12, color: "var(--muted)" }}>{oldState}</span>
            </div>
            <ArchList rows={arch} q={archQ} onOpen={openPdf} onLoad={onLoadArchived} />
          </div>
        </section>

        {/* ── Конвертація файлів ── */}
        <section className="card conv">
          <div className="in">
            <h3>Конвертація файлів</h3>
            <p>Окремий інструмент: перекинути готовий файл в інший формат, не виходячи з дашборду. Конвертує сервер дашборда; у базу нічого не зберігається.</p>
            <div className="convrow">
              {["DOCX", "TXT", "JPG", "PNG"].map((x) => <span key={x} className="fchip">{x}</span>)}
              <span className="arrow">→</span><span className="fchip">PDF</span>
              <button className="btn pri sm" style={{ marginLeft: "auto" }} onClick={() => convInput.current?.click()}>Обрати файл → PDF</button>
              <input ref={convInput} type="file" accept=".docx,.txt,.jpg,.jpeg,.png" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void convToPdf(f); e.target.value = ""; }} />
            </div>
            <div className="convrow" style={{ marginTop: 10 }}>
              <span className="fchip">PDF</span><span className="arrow">→</span><span className="fchip">DOCX</span><span className="fchip">TXT</span>
              <select value={pdfTarget} onChange={(e) => setPdfTarget(e.target.value as "docx" | "txt")}
                style={{ border: "1px solid var(--line)", borderRadius: 9, background: "var(--surface-2)", padding: "7px 10px", fontSize: 12.5 }}>
                <option value="docx">у Word (.docx)</option><option value="txt">у текст (.txt)</option>
              </select>
              <button className="btn pri sm" style={{ marginLeft: "auto" }} onClick={() => pdfInput.current?.click()}>Обрати PDF і конвертувати</button>
              <input ref={pdfInput} type="file" accept=".pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void convFromPdf(f); e.target.value = ""; }} />
              <span style={{ fontSize: 11.5, color: "var(--muted)", flexBasis: "100%" }}>Текст переноситься повністю, з абзацами. Складні таблиці переносяться текстом; скани без текстового шару поки не розпізнаються.</span>
            </div>
            <div className="convrow" style={{ marginTop: 6 }}><span style={{ fontSize: 12, color: "var(--muted)" }}>{convState}</span></div>
          </div>
        </section>
      </>)}
    </div>
  );
}

/* ── Рядки архіву — розмітка макета (renderArch): №, версія, контрагент, сторона · юрособа · маршрут, час ── */
function ArchList({ rows, q, onOpen, onLoad, withAuthor }: {
  rows: CtorArchiveRow[] | null; q: string; onOpen: (id: number) => void; onLoad?: (id: number) => void; withAuthor?: boolean;
}) {
  if (rows === null) return <span style={{ fontSize: 12.5, color: "var(--muted)" }}>завантаження…</span>;
  if (!rows.length) return <span style={{ fontSize: 12.5, color: "var(--muted)" }}>{q ? `Нічого не знайшлось за «${q}».` : "Поки порожньо — зʼявиться після першого «Сформувати»."}</span>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      {rows.map((r) => (
        <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid var(--line)", borderRadius: 10, padding: "9px 12px", flexWrap: "wrap" }}>
          <span className="ext">{r.deal_no || "—"}</span>
          {r.version > 1 && <span className="ext" title={`версія ${r.version}`}>v{r.version}</span>}
          <span style={{ fontSize: 12.5, fontWeight: 600 }}>{r.contractor_name || "без контрагента"}</span>
          <span style={{ fontSize: 12, color: "var(--muted)" }}>
            {r.doc_kind === "main" ? "основний" : r.party === "carrier" ? "перевізник" : "клієнт"} · {r.entity_key.toUpperCase()}{r.route ? ` · ${r.route}` : ""}{r.sum ? ` · ${r.sum}` : ""}
          </span>
          {withAuthor && <span style={{ fontSize: 12, fontWeight: 600 }}>{r.author ?? "—"}</span>}
          <span style={{ fontSize: 11.5, color: "var(--muted)", marginLeft: "auto" }}>{fmtAt(r.created_at)}</span>
          <button className="btn sm" title="Відкрити готовий документ" onClick={() => onOpen(r.id)}>📄 PDF</button>
          {onLoad && <button className="btn sm" title="Підняти заявку у форму для правок" onClick={() => onLoad(r.id)}>У форму</button>}
        </div>
      ))}
    </div>
  );
}

/* ── 🗂 Пул заявок + «чи користуються» (рішення Сергія 30.09.2026) ── */
function PoolView({ onOpen, onDownload }: { onOpen: (id: number) => void; onDownload: (id: number, num: string, kind: "docx" | "pdf") => void }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<CtorArchiveRow[] | null>(null);
  const [stats, setStats] = useState<CtorStatDay[] | null>(null);
  useEffect(() => { ctorPoolStats(30).then((r) => setStats(r.rows)).catch(() => setStats([])); }, []);
  useEffect(() => { const t = setTimeout(() => { ctorPool(q).then(setRows).catch(() => setRows([])); }, 300); return () => clearTimeout(t); }, [q]);
  const sum = (n: number) => (stats ?? []).slice(0, n).reduce((s, d) => s + d.docs, 0);
  const max = Math.max(1, ...(stats ?? []).map((d) => d.docs));
  void onDownload;
  return (
    <>
      <section className="card conv" style={{ marginTop: 0 }}>
        <div className="in">
          <h3>Чи користуються конструктором</h3>
          <p>По днях за Києвом, останні 30 днів. Документом рахується кожне «Сформувати», включно з новими версіями.</p>
          <div className="kpis">
            <div className="kpi"><div className="v">{stats?.[0]?.docs ?? "—"}</div><div className="l">сьогодні · менеджерів {stats?.[0]?.authors ?? 0}</div></div>
            <div className="kpi"><div className="v">{stats ? sum(7) : "—"}</div><div className="l">за 7 днів</div></div>
            <div className="kpi"><div className="v">{stats ? sum(30) : "—"}</div><div className="l">за 30 днів</div></div>
            <div className="kpi"><div className="v">{stats ? stats.filter((d) => d.docs === 0).length : "—"}</div><div className="l">днів без жодного</div></div>
          </div>
          <div className="bars" aria-label="Документів за день">
            {[...(stats ?? [])].reverse().map((d) => (
              <div key={d.day} className="b" title={`${d.day.split("-").reverse().join(".")}: ${d.docs} док. (разових ${d.once}, перевізнику ${d.carr}, основних ${d.main}), менеджерів ${d.authors}`}>
                <i className={d.docs ? "" : "z"} style={{ height: `${(d.docs / max) * 100}%` }} /><span>{d.day.slice(8)}</span>
              </div>
            ))}
          </div>
        </div>
      </section>
      <section className="card conv">
        <div className="in">
          <h3>Пул заявок</h3>
          <p>Усі документи всіх менеджерів, останні 200. Видно лише керівництву.</p>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="🔍 Пошук: №, контрагент, маршрут, вантаж, водій…" style={{ marginBottom: 11 }} />
          <ArchList rows={rows} q={q} onOpen={onOpen} withAuthor />
        </div>
      </section>
    </>
  );
}

/** Текст із .docx у браузері — без бібліотек (порт із макета Сергія, `client/api.ts`). */
async function docxText(buf: ArrayBuffer): Promise<string> {
  const u8 = new Uint8Array(buf); const dv = new DataView(buf);
  const dec = new TextDecoder(); let off = 0;
  while (off < u8.length - 4) {
    if (dv.getUint32(off, true) !== 0x04034b50) break;
    const method = dv.getUint16(off + 8, true);
    const csize = dv.getUint32(off + 18, true);
    const nlen = dv.getUint16(off + 26, true), xlen = dv.getUint16(off + 28, true);
    const name = dec.decode(u8.subarray(off + 30, off + 30 + nlen));
    const dstart = off + 30 + nlen + xlen;
    if (name === "word/document.xml") {
      let data: Uint8Array = u8.subarray(dstart, dstart + csize);
      if (method === 8) {
        const ds = new DecompressionStream("deflate-raw");
        const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
        data = new Uint8Array(await new Response(stream).arrayBuffer());
      }
      return dec.decode(data).replace(/<w:p[ >]/g, "\n<").replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    }
    off = dstart + csize;
  }
  throw new Error("У файлі немає тексту документа (word/document.xml) — це точно .docx?");
}

/** Пояснення під полем — текст із серверної перевірки (🔴 червоний, 🟡 жовтий). */
function FieldMsg({ is }: { is?: CtorIssue }) {
  if (!is) return null;
  return <div className={`fmsg ${is.level === "error" ? "err" : "wrn"}`}>{is.level === "error" ? "✕ " : "⚠ "}{is.msg}</div>;
}

/** Підсумок біля «Сформувати»: «2 помилки, 1 попередження» (затверджено 02.10.2026). */
function IssueSummary({ issues }: { issues: CtorIssue[] }) {
  const e = issues.filter((i) => i.level === "error").length, w = issues.length - e;
  if (!issues.length) return null;
  const pl = (n: number, one: string, few: string, many: string) => n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many;
  return (
    <span className="issum" title={issues.map((i) => (i.level === "error" ? "✕ " : "⚠ ") + i.msg).join("\n")}>
      {e > 0 && <b className="err">{e} {pl(e, "помилка", "помилки", "помилок")}</b>}
      {e > 0 && w > 0 && ", "}
      {w > 0 && <b className="wrn">{w} {pl(w, "попередження", "попередження", "попереджень")}</b>}
    </span>
  );
}
