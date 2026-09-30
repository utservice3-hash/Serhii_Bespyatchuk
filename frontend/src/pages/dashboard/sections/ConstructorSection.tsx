/**
 * 📄 КОНСТРУКТОР ДОКУМЕНТІВ (30.09.2026) — екран із пакета Сергія (`client/ConstructorPage.tsx`).
 *
 * Логіка — його, майже рядок у рядок: способи вводу контрагента, рейс, оплата, дзеркальна заявка, імпорт
 * старої заявки, архів. Розкладка — у порядку секцій затвердженого макета (`mockup/konstruktor-dokumentiv.html`),
 * стилі — спільні класи дашборда (`hiring.css`), тож темна тема працює сама. Звіряли порядок, не пікселі
 * (рішення Романа 30.09.2026).
 *
 * Що змінено проти пакета — і чому:
 *  - Word/PDF — через `api` з токеном (blob), а не `<a href>`: вхід у нас заголовком, голе посилання дало б 401.
 *  - «Відкрити PDF» відкриває вкладку ДО очікування відповіді: після `await` браузер уже не вважає це кліком
 *    людини і блокує вікно (так «не клікався» скрин у картці клієнта, задача 4310).
 *  - «Відповідальна особа Експедитора» — показуємо, що підставить сервер (картка співробітника), бо руками
 *    це поле не вводиться (рішення 29.09 у README пакета).
 *  - Вкладка «Пул заявок» і лічильник за день — нові (рішення Сергія 30.09.2026), лише з правом.
 *
 * Поведінкові інваріанти пакета (НЕ ламати): № заявки = ID угоди в Kommo, вручну, обовʼязковий; ФОП продає лише
 * ФОПам, його оплата — «СОФТ платіж»; дзеркальна заявка — ТІЛЬКИ за чекбоксом; перевізницька без IBAN не формується.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CTOR_EMPTY_FORM, ctorArchive, ctorByEdrpou, ctorCounterparties, ctorCreate, ctorDocument, ctorEntities, ctorFile, ctorMe,
  ctorParse, ctorParseOld, ctorPool, ctorPoolStats, ctorPreview, ctorRouteTemplates, ctorSaveCounterparty, ctorSaveRouteTemplate,
  ctorDeleteRouteTemplate,
  type CtorArchiveRow, type CtorCounterparty, type CtorCounterpartyRow, type CtorEntityKey, type CtorEntityRow, type CtorForm,
  type CtorParty, type CtorRouteTemplate, type CtorStatDay,
} from "../../../api";
import "./hiring.css";
import "./constructor.css";

/* Поля рейсу — порядок і підписи як у макеті (renderTrip). */
const TRIP_FIELDS: Array<[string, string]> = [
  ["route", "Маршрут"], ["cargo", "Вантаж, вага, пакування"], ["places", "Місця, габарити Д×Ш×В"],
  ["special", "Особливі умови"], ["shipper", "Вантажовідправник"], ["shipperC", "Контактна особа відправника, телефон"],
  ["loadAddr", "Адреса завантаження"], ["loadDate", "Дата, час навантаження"],
  ["consignee", "Вантажоодержувач"], ["consigneeC", "Контактна особа одержувача, телефон"],
  ["unloadAddr", "Адреси розвантаження"], ["unloadDate", "Дата, час доставки"],
  ["reqs", "Вимоги до транспортного засобу"], ["truck", "Транспортний засіб, номери"],
  ["driver", "Дані водія"], ["otherResp", "Відповідальна особа другої сторони, телефон"],
  ["extra", "Додаткові умови"],
];
const INTL_FIELDS: Array<[string, string]> = [
  ["custAddr", "Адреса замитнення, контактна особа"],
  ["border", "Пункт переходу кордону"],
  ["decustAddr", "Адреса розмитнення, контактна особа"],
];
const CP_FIELDS: Array<[keyof CtorCounterparty, string]> = [
  ["name", "Назва"], ["edrpou", "ЄДРПОУ"], ["ipn", "ІПН"], ["addr", "Адреса"], ["iban", "IBAN"],
  ["bank", "Банк"], ["phone", "Телефон"], ["email", "Email"], ["dir", "Директор (ПІБ)"],
];
const ENT_FALLBACK: Record<CtorEntityKey, string> = { uts: "ТОВ «Юнайтед Транспорт Сервіс»", avm: "ТОВ «АвтоМув»", fop: "ФОП Беспятчук С.С." };
const KIND_LABEL: Record<string, string> = { once: "Разовий договір-заявка", carr: "Заявка перевізнику", main: "Основний договір" };

type Way = "edrpou" | "book" | "text" | "file";
type Tab = "make" | "archive" | "pool";

/** Відмова сервера: для blob-відповіді текст треба дочитати з Blob. */
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

const fmtDate = (s: string) => new Date(s).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

export function ConstructorSection() {
  const [tab, setTab] = useState<Tab>("make");
  const [me, setMe] = useState<{ manager: { name: string; phone: string }; canSeeAll: boolean } | null>(null);
  const [entities, setEntities] = useState<CtorEntityRow[]>([]);
  const [form, setForm] = useState<CtorForm>(CTOR_EMPTY_FORM);
  const [previewHtml, setPreviewHtml] = useState("");
  const [blockersMsg, setBlockersMsg] = useState<string | null>(null);
  const [assetsNote, setAssetsNote] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<{ id: number; version: number; num: string } | null>(null);
  const [mirrorCost, setMirrorCost] = useState("");       // ціна перевізника для маржі
  const [pairMode, setPairMode] = useState(false);        // пакетний режим — тільки чекбоксом
  const [way, setWay] = useState<Way>("text");
  const [book, setBook] = useState<CtorCounterpartyRow[]>([]);
  const [bookQ, setBookQ] = useState("");
  const [edrpou, setEdrpou] = useState("");
  const [rawText, setRawText] = useState("");
  const [tpls, setTpls] = useState<CtorRouteTemplate[]>([]);
  const [drag, setDrag] = useState(false);

  const ok = (t: string) => { setMsg(t); setErr(""); };
  const fail = async (e: unknown) => { setErr(await errOf(e)); setMsg(""); };

  useEffect(() => {
    ctorMe().then(setMe).catch(fail);
    ctorEntities().then(setEntities).catch(() => {});
    ctorRouteTemplates().then(setTpls).catch(() => {});
  }, []);
  useEffect(() => { if (way === "book") ctorCounterparties(bookQ).then(setBook).catch(() => {}); }, [bookQ, way]);

  const set = useCallback(<K extends keyof CtorForm>(k: K, v: CtorForm[K]) => setForm((f) => ({ ...f, [k]: v })), []);
  const setTrip = (k: string, v: string) => setForm((f) => ({ ...f, trip: { ...f.trip, [k]: v } }));
  const setCp = (k: keyof CtorCounterparty, v: string) => setForm((f) => ({ ...f, cp: { ...f.cp, [k]: v } }));
  const setPay = (k: keyof CtorForm["pay"], v: string) => setForm((f) => ({ ...f, pay: { ...f.pay, [k]: v } }));

  /* ── ФОП-правила (макет: fopConflict + renderTerms) ── */
  const fopConflict = form.ent === "fop" && form.party === "client" && !!form.cp.name && !/^ФОП/i.test(form.cp.name);
  const payForms = form.ent === "fop" ? ["СОФТ платіж"] : ["б/г з ПДВ", "б/г без ПДВ", "готівка", "комбінована"];
  const entity = entities.find((e) => e.key === form.ent);

  /* ── Прев'ю: серверний HTML документа у iframe (debounce 400 мс) ── */
  const previewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (tab !== "make") return;
    clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(async () => {
      try {
        const r = await ctorPreview(form);
        setPreviewHtml(r.html); setBlockersMsg(r.blockers); setAssetsNote(r.assetsNote);
      } catch (e) { setBlockersMsg(await errOf(e)); }
    }, 400);
    return () => clearTimeout(previewTimer.current);
  }, [form, tab]);

  /* ── Способи вводу контрагента ── */
  const applyParsed = (cp: CtorCounterparty) =>
    setForm((f) => ({ ...f, cp: { ...f.cp, ...Object.fromEntries(Object.entries(cp).filter(([, v]) => v)) } }));

  const onParseText = async () => {
    try {
      const r = await ctorParse(rawText);
      applyParsed(r.out);
      ok(`Розпізнано ${Object.values(r.found).filter(Boolean).length} з 9 полів — перевірте їх нижче.`);
    } catch (e) { await fail(e); }
  };

  const onFiles = async (files: FileList | File[]) => {           // кілька файлів, drag&drop (04.10)
    const texts: string[] = [];
    const skipped: string[] = [];
    for (const f of Array.from(files)) {
      const ext = (f.name.split(".").pop() || "").toLowerCase();
      try {
        if (ext === "txt" || ext === "csv") texts.push(await f.text());
        else if (ext === "docx") texts.push(await docxText(await f.arrayBuffer()));
        else skipped.push(f.name);
      } catch { skipped.push(f.name); }
    }
    try {
      if (texts.length) {
        const r = await ctorParse(texts.join("\n"));
        applyParsed(r.out);
      }
      const note = skipped.length ? ` Не прочитано: ${skipped.join(", ")} — розпізнаються лише .docx, .txt, .csv.` : "";
      if (texts.length) ok(`Реквізити з ${texts.length} файл(ів) підставлено.${note}`); else setErr(`Жодного файла не прочитано.${note}`);
    } catch (e) { await fail(e); }
  };

  const onPickBook = (row: CtorCounterpartyRow) => {
    applyParsed({
      name: row.name, edrpou: row.edrpou || "", ipn: row.ipn || "", addr: row.address || "",
      iban: row.iban || "", bank: row.bank || "", phone: row.phone || "", email: row.email || "", dir: row.director || "",
    });
    ok(`Підставлено з довідника: ${row.name}.`);
  };

  const onEdrpou = async () => {
    try { onPickBook((await ctorByEdrpou(edrpou)).row); } catch (e) { await fail(e); }
  };

  const onSaveBook = async () => {
    try { const r = await ctorSaveCounterparty(form.cp); ok(`«${r.name}» збережено в довідник — наступного разу знайдете за назвою чи кодом.`); }
    catch (e) { await fail(e); }
  };

  /* ── Імпорт старої заявки назад у форму (05.10) ── */
  const onImportOld = async (f: File) => {
    try {
      const text = /\.docx$/i.test(f.name) ? await docxText(await f.arrayBuffer()) : await f.text();
      const r = await ctorParseOld(text);
      setForm((prev) => ({
        ...prev,
        party: r.party,
        doc: r.party === "carrier" ? "carr" : "once",
        ent: (r.ent as CtorEntityKey) || prev.ent,
        dealNo: r.dealNo || prev.dealNo,
        intl: !!r.intl,
        cp: { ...prev.cp, ...Object.fromEntries(Object.entries(r.cp).filter(([, v]) => v)) },
        trip: { ...prev.trip, ...r.trip },
        pay: r.pay ? { ...prev.pay, ...r.pay } : prev.pay,
      }));
      setMade(null); setTab("make");
      ok(`Імпортовано заявку № ${r.dealNo || "—"} (${r.party === "carrier" ? "перевізник" : "клієнт"}). Перевірте поля й сформуйте.`);
    } catch (e) { await fail(e); }
  };

  /* ── Дзеркальна заявка: рейс і № зберігаються ── */
  const doMirror = () => {
    const toClient = form.party === "carrier";
    setMirrorCost(toClient ? form.pay.sum : "");
    setForm({
      ...form,
      party: toClient ? "client" : "carrier",
      doc: toClient ? "once" : "carr",
      cp: {},
      pay: { ...form.pay, sum: "" },
      trip: { ...form.trip, otherResp: "" },
    });
    setMade(null);
    ok(toClient
      ? "Рейс перенесено в заявку для клієнта. Додайте клієнта, його відповідальну особу й вашу ціну."
      : "Рейс перенесено в заявку для перевізника. Додайте перевізника і його плату.");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  /* ── Сформувати ── */
  const onMake = async () => {
    setBusy(true);
    try {
      const r = await ctorCreate(form);
      setMade(r);
      ok(`Сформовано № ${r.num} (версія v${r.version}). Документ у вашому архіві.`);
      if (pairMode) doMirror();                            // пакетний — тільки за чекбоксом
    } catch (e) { await fail(e); }
    finally { setBusy(false); }
  };

  /* ── Файли: Word/PDF через api з токеном ── */
  const download = async (id: number, num: string, kind: "docx" | "pdf") => {
    try { saveBlob(await ctorFile(id, kind), `${num || "document"}.${kind}`); } catch (e) { await fail(e); }
  };
  const openPdf = async (id: number) => {
    const w = window.open("", "_blank");                   // до await — інакше браузер заблокує вікно
    try {
      const blob = await ctorFile(id, "pdf", true);
      if (!w) { saveBlob(blob, `${id}.pdf`); return; }       // вікно заблоковано — хоча б зберегти, не йти зі сторінки
      const url = URL.createObjectURL(blob);
      w.location.href = url;
      setTimeout(() => URL.revokeObjectURL(url), 120_000);
    } catch (e) { w?.close(); await fail(e); }
  };

  /* ── «У форму» з архіву ── */
  const onLoadArchived = async (id: number) => {
    try {
      const row = await ctorDocument(id) as {
        entity_key: CtorEntityKey; doc_kind: CtorForm["doc"]; party: CtorParty; intl: boolean;
        with_stamp: boolean; fop_account: number; contractor: CtorForm["cp"];
        trip: Record<string, string>; pay: CtorForm["pay"]; deal_no: string;
        doc_date: string | null; main_date: string | null;
      };
      setForm({
        ent: row.entity_key, doc: row.doc_kind, party: row.party, intl: row.intl,
        stamp: row.with_stamp, fopAcc: row.fop_account, cp: row.contractor, trip: row.trip, pay: row.pay,
        dealNo: row.doc_kind === "main" ? "" : row.deal_no,
        docDate: row.doc_date ? String(row.doc_date).slice(0, 10) : "",
        mainNo: row.doc_kind === "main" ? row.deal_no : "", mainDate: row.main_date || "",
      });
      setMade(null); setTab("make");
      ok("Запис завантажено у форму — внесіть правки і сформуйте нову версію.");
    } catch (e) { await fail(e); }
  };

  /* ── Шаблони маршрутів ── */
  const applyTpl = (t: CtorRouteTemplate) => setForm((f) => ({ ...f, intl: t.intl, trip: { ...f.trip, ...t.fields } }));
  const saveTpl = async () => {
    try {
      await ctorSaveRouteTemplate({
        name: form.trip.route || "Без назви", intl: form.intl,
        fields: Object.fromEntries(["route", "cargo", "places", "special", "loadAddr", "unloadAddr", "reqs"].map((k) => [k, form.trip[k] || ""])),
      });
      setTpls(await ctorRouteTemplates());
      ok(`Маршрут «${form.trip.route || "Без назви"}» збережено в шаблони.`);
    } catch (e) { await fail(e); }
  };

  const margin = useMemo(() => {                          // маржа в дзеркальному режимі
    const num = (s: string) => parseFloat(s.replace(/[^\d.,]/g, "").replace(",", ".")) || 0;
    return mirrorCost && form.pay.sum ? num(form.pay.sum) - num(mirrorCost) : null;
  }, [mirrorCost, form.pay.sum]);

  return (
    <div className="ctor">
      <div className="page-header" style={{ marginBottom: 8 }}>
        <div>
          <h1 className="page-title">Конструктор документів</h1>
          <div className="hr-muted" style={{ fontSize: 13, marginTop: 4 }}>
            Договір-заявка з клієнтом, заявка перевізнику й основний договір — за шаблонами юросіб, з авто-підписом і печаткою.
          </div>
        </div>
      </div>

      <div className="hr-tabs">
        <button className={tab === "make" ? "on" : ""} onClick={() => setTab("make")}>Сформувати</button>
        <button className={tab === "archive" ? "on" : ""} onClick={() => setTab("archive")}>Мій архів</button>
        {me?.canSeeAll && <button className={tab === "pool" ? "on" : ""} onClick={() => setTab("pool")}>Пул заявок</button>}
      </div>

      {(msg || err) && <div className={`hr-note ${err ? "ctor-err" : "ctor-ok"}`} role={err ? "alert" : "status"}>{err || msg}</div>}

      {tab === "archive" && <ArchiveTab onLoad={onLoadArchived} onOpen={openPdf} onDownload={download} onImport={onImportOld} />}
      {tab === "pool" && me?.canSeeAll && <PoolTab onOpen={openPdf} onDownload={download} />}

      {tab === "make" && (
        <div className="ctor-grid">
          <div className="ctor-form">
            {/* ── Юрособа, сторона, вид документа ── */}
            <div className="hr-card">
              <div className="hr-sect" style={{ borderTop: 0 }}>
                <h4>Від кого</h4>
                <div className="hr-pills">
                  {(["uts", "avm", "fop"] as CtorEntityKey[]).map((k) => {
                    const e = entities.find((x) => x.key === k);
                    return (
                      <button key={k} className={form.ent === k ? "on" : ""}
                        onClick={() => setForm((f) => ({ ...f, ent: k, doc: k === "fop" && f.doc === "main" ? "once" : f.doc }))}>
                        {e?.name ?? ENT_FALLBACK[k]}{e ? <span className="hr-muted ctor-vat"> · {e.vat_label}</span> : null}
                      </button>
                    );
                  })}
                </div>
                <h4 style={{ marginTop: 12 }}>Документ</h4>
                <div className="hr-pills">
                  <button className={form.doc === "once" ? "on" : ""} onClick={() => setForm((f) => ({ ...f, party: "client", doc: "once" }))}>Разовий договір-заявка з клієнтом</button>
                  <button className={form.doc === "carr" ? "on" : ""} onClick={() => setForm((f) => ({ ...f, party: "carrier", doc: "carr" }))}>Заявка перевізнику</button>
                  <button className={form.doc === "main" ? "on" : ""} disabled={form.ent === "fop"}
                    title={form.ent === "fop" ? "Основного договору від ФОП немає — шаблону немає" : ""}
                    onClick={() => setForm((f) => ({ ...f, party: "client", doc: "main" }))}>Основний договір з клієнтом</button>
                </div>
              </div>
            </div>

            {/* ── 1. Контрагент (макет: .ways) ── */}
            <div className="hr-card">
              <div className="hd"><h3><span className="ctor-n">1</span>{form.party === "carrier" ? "Перевізник" : "Клієнт"}</h3>
                <div className="hr-seg">
                  {([["edrpou", "За ЄДРПОУ"], ["book", "Довідник"], ["text", "Текстом"], ["file", "Файлом"]] as Array<[Way, string]>).map(([k, l]) => (
                    <button key={k} className={way === k ? "on" : ""} onClick={() => setWay(k)}>{l}</button>
                  ))}
                </div>
              </div>
              <div className="hr-sect" style={{ borderTop: 0 }}>
                {way === "edrpou" && (
                  <div className="ctor-row">
                    <input className="hr-inp" value={edrpou} onChange={(e) => setEdrpou(e.target.value)} placeholder="ЄДРПОУ (8 цифр) або ІПН ФОП (10)"
                      onKeyDown={(e) => { if (e.key === "Enter") void onEdrpou(); }} />
                    <button className="hr-btn" onClick={() => void onEdrpou()}>Підставити з довідника</button>
                    <span className="hr-muted">Живий держреєстр — окремим рішенням; поки шукаємо в нашому довіднику.</span>
                  </div>
                )}
                {way === "book" && (
                  <>
                    <input className="hr-inp ctor-wide" value={bookQ} onChange={(e) => setBookQ(e.target.value)} placeholder="Пошук у довіднику: назва, ЄДРПОУ або IBAN…" />
                    <div className="ctor-book">
                      {book.length === 0 && <div className="hr-muted">У довіднику нічого не знайдено. Контрагент потрапляє сюди кнопкою «💾 У довідник».</div>}
                      {book.map((r) => (
                        <button key={r.id} className="ctor-bookrow" onClick={() => onPickBook(r)}>
                          <b>{r.name}</b> <span className="hr-muted">{r.edrpou || "без коду"}{r.iban ? ` · ${r.iban}` : ""}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
                {way === "text" && (
                  <>
                    <textarea className="hr-inp ctor-wide" rows={5} value={rawText} onChange={(e) => setRawText(e.target.value)}
                      placeholder="Вставте реквізити текстом — з Viber, пошти, рахунку…" />
                    <div className="ctor-row" style={{ marginTop: 8 }}>
                      <button className="hr-btn p" disabled={!rawText.trim()} onClick={() => void onParseText()}>Розпізнати реквізити</button>
                      <button className="hr-btn" onClick={() => setRawText("")}>Очистити</button>
                    </div>
                  </>
                )}
                {way === "file" && (
                  <label className={`ctor-drop${drag ? " on" : ""}`}
                    onDrop={(e) => { e.preventDefault(); setDrag(false); void onFiles(e.dataTransfer.files); }}
                    onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}>
                    <b>＋ Обрати файли</b> або перетягнути сюди
                    <span className="hr-muted">.docx, .txt, .csv — можна кілька</span>
                    <input type="file" multiple accept=".docx,.txt,.csv" hidden onChange={(e) => { if (e.target.files) void onFiles(e.target.files); e.target.value = ""; }} />
                  </label>
                )}

                <div className="ctor-fields" style={{ marginTop: 12 }}>
                  {CP_FIELDS.map(([k, label]) => (
                    <label key={k} className={k === "name" || k === "addr" ? "ctor-f wide" : "ctor-f"}>
                      <span>{label}{k === "iban" && form.doc === "carr" ? " *" : ""}</span>
                      <input className="hr-inp" value={form.cp[k] || ""} onChange={(e) => setCp(k, e.target.value)} />
                    </label>
                  ))}
                </div>
                <div className="ctor-row" style={{ marginTop: 8 }}>
                  <button className="hr-btn xs" disabled={!form.cp.name} onClick={() => void onSaveBook()}>💾 У довідник</button>
                  <button className="hr-btn xs" onClick={() => set("cp", {})}>Очистити реквізити</button>
                </div>
                {fopConflict && <div className="hr-note ctor-err" role="alert" style={{ marginTop: 8 }}>
                  Від ФОП Беспятчука клієнтом може бути лише інший ФОП — для цього контрагента оберіть ЮТС або АвтоМув.</div>}
              </div>
            </div>

            {/* ── 2. Рейс (разові) / Номер і дата основного ── */}
            {form.doc !== "main" ? (
              <div className="hr-card">
                <div className="hd"><h3><span className="ctor-n">2</span>Рейс</h3>
                  <div className="ctor-row">
                    <select className="hr-inp" value="" onChange={(e) => { const t = tpls.find((x) => x.id === +e.target.value); if (t) applyTpl(t); }}>
                      <option value="">Шаблон маршруту…</option>
                      {tpls.map((t) => <option key={t.id} value={t.id}>{t.name}{t.owner_id == null ? " · спільний" : ""}</option>)}
                    </select>
                    <button className="hr-btn xs" onClick={() => void saveTpl()}>💾 У шаблони</button>
                    <button className="hr-btn xs" onClick={() => setForm((f) => ({ ...f, trip: {}, intl: false }))}>Очистити все</button>
                  </div>
                </div>
                <div className="hr-sect" style={{ borderTop: 0 }}>
                  <label className="ctor-check"><input type="checkbox" checked={form.intl} onChange={(e) => set("intl", e.target.checked)} /> Міжнародне перевезення</label>
                  <div className="ctor-fields">
                    {TRIP_FIELDS.map(([k, label]) => (
                      <label key={k} className={k === "route" || k === "cargo" || k === "extra" ? "ctor-f wide" : "ctor-f"}>
                        <span>{label}</span>
                        <input className="hr-inp" value={form.trip[k] || ""} onChange={(e) => setTrip(k, e.target.value)} />
                      </label>
                    ))}
                    {form.intl && INTL_FIELDS.map(([k, label]) => (
                      <label key={k} className="ctor-f wide"><span>{label}</span>
                        <input className="hr-inp" value={form.trip[k] || ""} onChange={(e) => setTrip(k, e.target.value)} /></label>
                    ))}
                  </div>
                  {tpls.length > 0 && (
                    <div className="hr-muted" style={{ marginTop: 8 }}>
                      Свої шаблони можна прибрати: {tpls.filter((t) => t.owner_id != null).map((t) => (
                        <button key={t.id} className="fin-link" onClick={() => void ctorDeleteRouteTemplate(t.id).then(ctorRouteTemplates).then(setTpls)}>✕ {t.name}</button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="hr-card">
                <div className="hd"><h3><span className="ctor-n">2</span>Номер і дата договору</h3></div>
                <div className="hr-sect ctor-fields" style={{ borderTop: 0 }}>
                  <label className="ctor-f"><span>№ договору *</span><input className="hr-inp" value={form.mainNo} onChange={(e) => set("mainNo", e.target.value)} /></label>
                  <label className="ctor-f"><span>Дата договору (діє з) *</span><input className="hr-inp" value={form.mainDate} onChange={(e) => set("mainDate", e.target.value)} placeholder="30.09.2026" /></label>
                </div>
              </div>
            )}

            {/* ── Оплата (ФОП: тільки СОФТ платіж + вибір рахунку) ── */}
            <div className="hr-card">
              <div className="hd"><h3>Оплата</h3>{margin !== null && <span className={`hr-pill ${margin >= 0 ? "ok" : "dg"}`}>Маржа: {margin.toLocaleString("uk-UA")}</span>}</div>
              <div className="hr-sect ctor-fields" style={{ borderTop: 0 }}>
                <label className="ctor-f"><span>Плата, сума</span><input className="hr-inp" value={form.pay.sum} onChange={(e) => setPay("sum", e.target.value)} /></label>
                <label className="ctor-f"><span>Валюта</span>
                  <select className="hr-inp" value={form.pay.cur} onChange={(e) => setPay("cur", e.target.value)}>
                    <option>грн</option><option>€ по курсу НБУ на день завантаження</option>
                  </select></label>
                <label className="ctor-f"><span>Форма</span>
                  <select className="hr-inp" value={form.ent === "fop" ? "СОФТ платіж" : form.pay.form} onChange={(e) => setPay("form", e.target.value)}>
                    {payForms.map((p) => <option key={p}>{p}</option>)}
                  </select></label>
                <label className="ctor-f wide"><span>Порядок і строки оплати</span><input className="hr-inp" value={form.pay.order} onChange={(e) => setPay("order", e.target.value)} /></label>
                {form.ent === "fop" && (
                  <label className="ctor-f"><span>Рахунок ФОП</span>
                    <select className="hr-inp" value={form.fopAcc} onChange={(e) => set("fopAcc", +e.target.value)}>
                      {(entity?.accounts?.length ? entity.accounts : [{ bank: "Приват", iban: "" }, { bank: "Універсал Банк", iban: "" }]).map((a, i) => (
                        <option key={i} value={i}>{a.bank}{i === 0 ? " (за замовчуванням)" : ""}</option>
                      ))}
                    </select></label>
                )}
                <div className="ctor-f wide"><span>Відповідальна особа Експедитора · авто з профілю</span>
                  <div className="ctor-ro">{me ? `${me.manager.name || "—"}${me.manager.phone ? ", " + me.manager.phone : ""}` : "…"}
                    {me && !me.manager.phone && <span className="hr-pill wn" style={{ marginLeft: 8 }}>у вашій картці співробітника немає телефону</span>}
                  </div></div>
              </div>
            </div>

            {/* ── 3. Умови та санкції (з реквізитів юрособи) ── */}
            {entity?.fines?.rows?.length ? (
              <div className="hr-card">
                <div className="hd"><h3><span className="ctor-n">3</span>Умови та санкції · {entity.name}</h3></div>
                <div className="hr-sect" style={{ borderTop: 0 }}>
                  <table className="ctor-mini"><tbody>
                    {entity.fines.rows.map(([k, v]) => <tr key={k}><td>{k}</td><td><b>{v}</b></td></tr>)}
                    <tr><td>Нормативний простій</td><td>{entity.dwell_default}</td></tr>
                  </tbody></table>
                  {entity.fines.note && <div className="hr-muted" style={{ marginTop: 6 }}>{entity.fines.note}</div>}
                </div>
              </div>
            ) : null}

            {/* ── 4. Підпис і печатка, № заявки, Сформувати ── */}
            <div className="hr-card">
              <div className="hd"><h3><span className="ctor-n">4</span>Підпис і печатка</h3></div>
              <div className="hr-sect" style={{ borderTop: 0 }}>
                {form.doc !== "main" && (
                  <div className="ctor-fields">
                    <label className="ctor-f"><span>№ заявки = ID угоди в СРМ *</span>
                      <input className="hr-inp" value={form.dealNo} onChange={(e) => set("dealNo", e.target.value)} inputMode="numeric" /></label>
                    <label className="ctor-f"><span>Дата договору</span>
                      <input className="hr-inp" type="date" value={form.docDate} onChange={(e) => set("docDate", e.target.value)} /></label>
                  </div>
                )}
                <label className="ctor-check"><input type="checkbox" checked={form.stamp} onChange={(e) => set("stamp", e.target.checked)} />
                  Авто-підпис і печатка {form.ent === "fop" ? "(у ФОП печатки немає — лише підпис)" : ""}</label>
                <label className="ctor-check"><input type="checkbox" checked={pairMode} onChange={(e) => setPairMode(e.target.checked)} />
                  Після формування одразу перейти до другої сторони угоди</label>
                {assetsNote && form.stamp && <div className="hr-note ctor-err" style={{ marginTop: 8 }}>{assetsNote}</div>}
                {blockersMsg && <div className="hr-note ctor-warn" style={{ marginTop: 8 }} role="alert">{blockersMsg}</div>}
                <div className="ctor-row" style={{ marginTop: 12 }}>
                  <button className="hr-btn p" onClick={() => void onMake()} disabled={busy || !!blockersMsg}>{busy ? "Формую…" : "Сформувати документ"}</button>
                  {made && <>
                    <button className="hr-btn" onClick={() => void openPdf(made.id)}>👁 Відкрити PDF</button>
                    <button className="hr-btn" onClick={() => void download(made.id, made.num, "pdf")}>⬇ Зберегти PDF</button>
                    <button className="hr-btn" onClick={() => void download(made.id, made.num, "docx")}>⬇ Зберегти Word</button>
                    <button className="hr-btn" onClick={doMirror}>{form.party === "carrier" ? "→ Таку ж для клієнта" : "→ Таку ж для перевізника"}</button>
                  </>}
                </div>
              </div>
            </div>
          </div>

          {/* ── Прев'ю (серверний HTML — той самий шаблон, що PDF і Word) ── */}
          <div className="ctor-preview">
            <div className="hr-muted" style={{ marginBottom: 6 }}>Попередній перегляд · {KIND_LABEL[form.doc]}</div>
            <iframe title="Прев'ю документа" sandbox="" srcDoc={previewHtml} />
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Мій архів: пошук, версії, «У форму», PDF/Word, імпорт старої заявки ── */
function ArchiveTab({ onLoad, onOpen, onDownload, onImport }: {
  onLoad: (id: number) => void; onOpen: (id: number) => void;
  onDownload: (id: number, num: string, kind: "docx" | "pdf") => void; onImport: (f: File) => void;
}) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<CtorArchiveRow[] | null>(null);
  useEffect(() => {
    const t = setTimeout(() => { ctorArchive(q).then(setRows).catch(() => setRows([])); }, 300);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="hr-card">
      <div className="hd"><h3>Архів заявок</h3>
        <label className="hr-btn xs" style={{ cursor: "pointer" }}>⬆ Підняти стару заявку з файлу (.docx)
          <input type="file" accept=".docx,.txt" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onImport(f); e.target.value = ""; }} /></label>
      </div>
      <div className="hr-sect" style={{ borderTop: 0 }}>
        <input className="hr-inp ctor-wide" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Пошук: контрагент, маршрут, вантаж, водій, № угоди…" />
        <DocTable rows={rows} onLoad={onLoad} onOpen={onOpen} onDownload={onDownload}
          empty="У вашому архіві ще немає документів — сформуйте перший на вкладці «Сформувати»." />
      </div>
    </div>
  );
}

function DocTable({ rows, onLoad, onOpen, onDownload, withAuthor, empty }: {
  rows: CtorArchiveRow[] | null; onLoad?: (id: number) => void; onOpen: (id: number) => void;
  onDownload: (id: number, num: string, kind: "docx" | "pdf") => void; withAuthor?: boolean; empty: string;
}) {
  if (rows === null) return <div className="loading-text" style={{ marginTop: 10 }}>завантаження…</div>;
  if (rows.length === 0) return <div className="hr-muted" style={{ marginTop: 10 }}>{empty}</div>;
  return (
    <div className="hr-tw" style={{ marginTop: 10 }}>
      <table className="hr-table"><thead><tr>
        <th>№ угоди</th><th>Документ</th>{withAuthor && <th>Менеджер</th>}<th>Контрагент</th><th>Маршрут</th><th className="num">Сума</th><th>Створено</th><th></th>
      </tr></thead><tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td className="num"><b>{r.deal_no}</b> <span className="hr-muted">v{r.version}</span></td>
            <td>{KIND_LABEL[r.doc_kind]} <span className="hr-muted">· {r.entity_key.toUpperCase()}</span></td>
            {withAuthor && <td>{r.author ?? "—"}</td>}
            <td>{r.contractor_name || <span className="hr-muted">контрагента не вказано</span>}</td>
            <td>{r.route || <span className="hr-muted">—</span>}</td>
            <td className="num">{r.sum || "—"}</td>
            <td className="num">{fmtDate(r.created_at)}</td>
            <td><div className="acts ctor-row">
              <button className="hr-btn xs" onClick={() => onOpen(r.id)}>📄 PDF</button>
              <button className="hr-btn xs" onClick={() => onDownload(r.id, r.deal_no, "docx")}>Word</button>
              {onLoad && <button className="hr-btn xs" onClick={() => onLoad(r.id)}>У форму</button>}
            </div></td>
          </tr>
        ))}
      </tbody></table>
    </div>
  );
}

/* ── 🗂 Пул заявок + лічильник «чи користуються» (рішення Сергія 30.09.2026) ── */
function PoolTab({ onOpen, onDownload }: { onOpen: (id: number) => void; onDownload: (id: number, num: string, kind: "docx" | "pdf") => void }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<CtorArchiveRow[] | null>(null);
  const [stats, setStats] = useState<CtorStatDay[] | null>(null);
  useEffect(() => { ctorPoolStats(30).then((r) => setStats(r.rows)).catch(() => setStats([])); }, []);
  useEffect(() => {
    const t = setTimeout(() => { ctorPool(q).then(setRows).catch(() => setRows([])); }, 300);
    return () => clearTimeout(t);
  }, [q]);
  const sum = (n: number) => (stats ?? []).slice(0, n).reduce((s, d) => s + d.docs, 0);
  const today = stats?.[0];
  const max = Math.max(1, ...(stats ?? []).map((d) => d.docs));
  const days = [...(stats ?? [])].reverse();
  return (
    <>
      <div className="hr-card">
        <div className="hd"><h3>Чи користуються конструктором</h3><span className="hr-muted">по днях за Києвом · останні 30 днів</span></div>
        <div className="hr-tiles">
          <div className="hr-tile"><div className="lb">Сьогодні</div><div className="vl">{today?.docs ?? "—"}</div><div className="sb">{today ? `менеджерів: ${today.authors}` : ""}</div></div>
          <div className="hr-tile"><div className="lb">За 7 днів</div><div className="vl">{stats ? sum(7) : "—"}</div><div className="sb">документів</div></div>
          <div className="hr-tile"><div className="lb">За 30 днів</div><div className="vl">{stats ? sum(30) : "—"}</div><div className="sb">документів</div></div>
          <div className="hr-tile"><div className="lb">Днів без жодного</div><div className="vl">{stats ? stats.filter((d) => d.docs === 0).length : "—"}</div><div className="sb">із 30</div></div>
        </div>
        <div className="hr-sect">
          <div className="ctor-bars" aria-label="Документів за день">
            {days.map((d) => (
              <div key={d.day} className="ctor-bar" title={`${d.day.split("-").reverse().join(".")}: ${d.docs} док. (разових ${d.once}, перевізнику ${d.carr}, основних ${d.main}), менеджерів ${d.authors}`}>
                <i style={{ height: `${(d.docs / max) * 100}%` }} className={d.docs === 0 ? "zero" : ""} />
                <span>{d.day.slice(8)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="hr-card">
        <div className="hd"><h3>Пул заявок</h3><span className="hr-muted">усі документи всіх менеджерів · останні 200</span></div>
        <div className="hr-sect" style={{ borderTop: 0 }}>
          <input className="hr-inp ctor-wide" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Пошук: контрагент, маршрут, вантаж, водій, № угоди…" />
          <DocTable rows={rows} onOpen={onOpen} onDownload={onDownload} withAuthor empty="Документів ще не сформовано жодного." />
        </div>
      </div>
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
