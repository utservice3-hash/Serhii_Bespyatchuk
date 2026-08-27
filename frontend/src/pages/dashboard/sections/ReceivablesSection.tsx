import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { AuthPayload } from "../../../auth";
import {
  saveReceivableInvoiceNote, fetchReceivableInvoices, triggerReceivablesSync,
  fetchManagerOptions, type ManagerOption,
  type ReceivableInvoice, type ReceivableManager, type ReceivableClient, type ReceivableTotals, type Team,
} from "../../../api";
import { WriteoffDialog } from "./WriteoffDialog";
import { WriteoffButton } from "./WriteoffButton";
import { RowBoundary } from "./RowBoundary";
import { ReceivablesArchive } from "./ReceivablesArchive";
import { NoteHistoryDialog } from "./NoteHistoryDialog";
import { Hint, Tip, TipLayer } from "../../../components/Hint";
import { ReceivablesTiles } from "./ReceivablesTiles";
import { ReceivablesFilters } from "./ReceivablesFilters";
import { OwnerEditor } from "./OwnerEditor";
import { LimitEditor } from "./LimitEditor";
import { LimitRequestDialog } from "./LimitRequestDialog";
import { MergeDialog } from "./MergeDialog";
import {
  carrierCell, EMPTY_FILTERS, ENTITY_LABEL, ENTITY_REASON_LABEL,
  isAncientDebt, isOverdue, foldEntity, foldCarrier, activeNote, NOTE_EMPTY_PLACEHOLDER,
  formatDateSafe, parseDateSafe, agreementLine, AGREEMENT_EMPTY_LABEL,
  sortClients, nextSort, sortMark, ariaSort, DEFAULT_SORT, type SortState,
  limitHint, limitLabel, limitState, originBadges, ownerState, passesFilters,
  amountLimitHint, amountLimitLabel, amountLimitState, isOverAmount,
  marginHint, marginPctText,
  earnedCells, earnedCellHint, earnedCellText, earnedShownTotal,
  nPlural,
  type Filters, type MergeSide,
} from "../receivablesView";
import { formatAmount, formatAmountFull } from "../format";
import { teamOptions } from "../teamColors";
import { CommentField } from "../../../components/CommentField";
import { AgreementEditor } from "./AgreementEditor";

/**
 * 👤 ВІДПОВІДАЛЬНИЙ + ЧОМУ САМЕ ВІН.
 *
 * 🔴 «Немає відповідального» мусить читатись як ВІДПОВІДЬ, а не як порожня
 * клітинка. Випадків два, і вони різні: мажоритар звільнений і команди в нього
 * немає — проти «в рахунках узагалі немає менеджера». Без підпису обидва
 * виглядали б однаково порожньо, і людина пішла б шукати поломку там, де її
 * немає. Той самий урок, що «невідоме має читатись як невідоме».
 *
 * Джерело підпису — СЕРВЕР (`ownerSource`), а не здогад фронта по порожньому
 * імені: інакше екран мав би власну думку про правило, і вона б розійшлась.
 */
function OwnerCell({ c }: { c: ReceivableClient & { managerName: string } }) {
  if (c.ownerSource === "none") {
    // 🔴 ФОРМУЛЮВАННЯ НЕЙТРАЛЬНЕ ЗА РОДОМ І ВІДМІНКОМ, і це не косметика.
    // Перша редакція казала «${імʼя} — звільнений, команди немає» і на живому
    // екрані дала «Гаркушина Юлія Олексіївна — звільненОГО»: узгодити рід із ПІБ
    // у коді неможливо. Імʼя після двокрапки лишається в називному, і підпис
    // читається однаково правильно для будь-кого. Спіймав СКРІНШОТ, не тест.
    const why = c.majorityName
      ? `мажоритар не в активних: ${c.majorityName} · команди немає`
      : "немає менеджера в рахунках";
    return (
      <span>
        <span style={{ color: "var(--warn)", fontWeight: 600 }}>без відповідального</span>
        <span style={{ display: "block", fontSize: "var(--fs-xs)", color: "var(--text-muted)" }}>{why}</span>
      </span>
    );
  }
  // 🔴 ГІЛКА ДЛЯ ГОТІВКИ ОБОВʼЯЗКОВА, А НЕ «про всяк випадок». Без неї
  // `cash-invoice` провалився б у останній `else` і отримав підпис «найбільша
  // сума боргу по клієнту» — неправду: готівковий менеджер береться з УГОД CRM,
  // жодного мажоритара по рахунках для нього не рахували. Правильне число під
  // неправильним поясненням — це той самий клас, що ми тут і лікуємо.
  // 🔴 «СВІДОМО НІКОГО» — ОКРЕМИЙ ВИГЛЯД, а не «📌 Без відповідального».
  // Ядро вже розрізняє ці стани (`override` із `managerId: null` дає source
  // `override`, а не `none` — див. `resolveOwner`), тож екран зобовʼязаний
  // показати різницю: «нікого, бо так вирішили» і «нікого, бо ще не дивились» —
  // різні відповіді, і плутати їх означає стерти рішення людини.
  if (ownerState(c) === "manual-none") {
    return (
      <span title="Адмін свідомо зняв відповідального; авто-правило вимкнене">
        <span style={{ fontWeight: 600 }}>📌 нікого — свідомо</span>
        <span style={{ display: "block", fontSize: "var(--fs-xs)", color: "var(--text-muted)" }}>
          рішення адміна, авто-правило вимкнене
        </span>
      </span>
    );
  }
  const mark =
    c.ownerSource === "override" ? { icon: "📌", hint: "призначено вручну" }
    : c.ownerSource === "cash-invoice" ? { icon: "💵", hint: "готівковий клієнт · менеджер з угод CRM" }
    : c.ownerSource === "auto-teamlead"
      ? { icon: "👥", hint: c.majorityName
          ? `тімлід команди · мажоритар не в активних: ${c.majorityName}`
          : "тімлід команди" }
      : { icon: "", hint: "найбільша сума боргу по клієнту" };
  return (
    <span title={mark.hint}>
      {mark.icon && <span style={{ marginRight: 4 }}>{mark.icon}</span>}
      {c.managerName}
      {c.ownerSource !== "auto-majority" && (
        <span style={{ display: "block", fontSize: "var(--fs-xs)", color: "var(--text-muted)" }}>{mark.hint}</span>
      )}
    </span>
  );
}


const inputStyle: React.CSSProperties = {
  font: "inherit", fontSize: "var(--fs-sm)", padding: "3px 6px", borderRadius: 6,
  border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)",
};

/**
 * Дебіторська заборгованість: KPI-зведення → єдина таблиця боржників (клік по
 * клієнту → неоплачені рахунки з дедлайном і коментарем до КОЖНОГО рахунку) →
 * підсумок по менеджерах. Прострочений дедлайн → авто-задача менеджеру
 * «отримати оплату» (щоденний джоб).
 */
export function ReceivablesSection({
  auth,
  teams,
  receivablesTeamId,
  setReceivablesTeamId,
  receivablesSyncedAt,
  receivablesLoading,
  receivablesData,
  receivablesTotals,
  canSetOwner,
  canMerge,
  canSetLimit,
  canRequestLimit,
  canWriteOff,
  canEditReceivables,
  patchReceivableNote,
  onRefresh,
}: {
  auth: AuthPayload | null;
  teams: Team[];
  receivablesTeamId: number | "";
  setReceivablesTeamId: Dispatch<SetStateAction<number | "">>;
  receivablesSyncedAt: string | null;
  receivablesLoading: boolean;
  receivablesData: ReceivableManager[];
  receivablesTotals: ReceivableTotals | null;
  /** Право віддає СЕРВЕР (`isAdminScope`) — фронт свого правила не має. */
  canSetOwner: boolean;
  canSetLimit: boolean;
  /** 🧾 Чи малювати кнопку запиту ліміту. Право віддає СЕРВЕР і ним же гейтить роут. */
  canRequestLimit: boolean;
  /**
   * 🗑 Право віддає СЕРВЕР (`write_off_debt` = СЕО · опердир). Кнопки в решти
   * НЕМАЄ — це не «є, але дає 403»: екран своєї думки про доступ не має.
   */
  canWriteOff: boolean;
  /** Право віддає СЕРВЕР (`merge_receivables`). Фінансиста тут немає. */
  canMerge: boolean;
  canEditReceivables: boolean;
  patchReceivableNote: (clientKey: string, patch: { comment?: string; dueDate?: string | null }) => void;
  onRefresh?: () => void;
}) {
  const [syncing, setSyncing] = useState(false);
  const refreshFromSheet = async () => {
    setSyncing(true);
    try { await triggerReceivablesSync(); onRefresh?.(); }
    finally { setSyncing(false); }
  };

  // Розгортання рахунків клієнта (лінива підгрузка) + локальні правки нотаток рахунків.
  const [openKey, setOpenKey] = useState<string | null>(null);
  // 🗑 Що зараз списуємо. `invoiceNo: null` — клієнта цілком. Один стан на обидва
  // рівні: два незалежні стани розійшлися б, і поповер зміг би відкритись двічі.
  const [writeoffFor, setWriteoffFor] = useState<{ clientKey: string; invoiceNo: string | null } | null>(null);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  // 🗄 Вкладка. Архів — окремий екран, а не фільтр: списаний борг зникає з
  // активного списку ПОВНІСТЮ, тож змішувати їх в одній таблиці означало б
  // повернути те, що власник щойно скасував.
  const [tab, setTab] = useState<"active" | "archive">("active");
  // 🗓 Один якір часу на весь рендер: інакше рядки, порахувані на різних
  // мілісекундах, могли б розійтись на самій межі понеділка.
  const now = new Date();
  /** Олівець правки — один стиль на всі клітинки, щоб вони не роз'їхались. */
  const [invCache, setInvCache] = useState<Record<string, ReceivableInvoice[] | "loading">>({});
  /** Вік боргу по клієнту — з СЕРВЕРА, поруч із рахунками. Див. `receivablesAge`. */
  const [invAge, setInvAge] = useState<Record<string, number | null>>({});
  const loadInvoices = (clientKey: string) => {
    fetchReceivableInvoices(clientKey)
      .then((r) => {
        setInvCache((c) => ({ ...c, [clientKey]: r.invoices }));
        setInvAge((a) => ({ ...a, [clientKey]: r.oldestAliveDays }));
      })
      .catch(() => setInvCache((c) => ({ ...c, [clientKey]: [] })));
  };
  const toggleClient = (clientKey: string) => {
    setOpenKey((cur) => (cur === clientKey ? null : clientKey));
    if (invCache[clientKey] === undefined) {
      setInvCache((c) => ({ ...c, [clientKey]: "loading" }));
      loadInvoices(clientKey);
    }
  };
  const patchInvoice = (clientKey: string, invoiceNo: string, patch: { dueDate?: string | null; comment?: string | null }) => {
    // Оптимістично оновлюємо кеш, зберігаємо на бекенді, потім тихо перечитуємо.
    setInvCache((c) => {
      const list = c[clientKey];
      if (!Array.isArray(list)) return c;
      return {
        ...c,
        [clientKey]: list.map((x) => ((x.invoiceNo ?? "") === invoiceNo ? { ...x, ...("dueDate" in patch ? { dueDate: patch.dueDate ?? null } : {}), ...("comment" in patch ? { comment: patch.comment ?? null } : {}) } : x)),
      };
    });
    const cur = invCache[clientKey];
    const row = Array.isArray(cur) ? cur.find((x) => (x.invoiceNo ?? "") === invoiceNo) : undefined;
    saveReceivableInvoiceNote({
      clientKey, invoiceNo,
      dueDate: "dueDate" in patch ? patch.dueDate ?? null : row?.dueDate ?? null,
      comment: "comment" in patch ? patch.comment ?? null : row?.comment ?? null,
    }).catch(() => {});
  };

  const today = new Date().toISOString().slice(0, 10);
  /**
   * 🧾 РАХУНКИ — РЯДКИ ТІЄЇ САМОЇ ТАБЛИЦІ, А НЕ ВКЛАДЕНА (рішення власника 26.08.2026).
   *
   * 🔴 ЧОМУ ЦЕ НЕ КОСМЕТИКА. Вкладена таблиця має ВЛАСНІ колонки, і збігалися
   * вони з батьківськими лише «на око» — рівно тому на проді заробіток стояв
   * ПЕРЕД сумою, і числа читались навхрест; власник це й помітив. Коли рахунок —
   * рядок тієї самої таблиці, колонка стоїть під своєю колонкою ЗА ПОБУДОВОЮ,
   * а не за уважністю того, хто верстав.
   *
   * Відповідність згори донизу: сума боргу → сума рахунку · заробили → заробили
   * на угоді · перевізник → стан і сума по цьому рахунку · юрособа → юрособа
   * рахунку · днів → вік цього рахунку · ліміт → дедлайн оплати · домовленість →
   * коментар до рахунка · відповідальний → хто створив рахунок.
   */
  const renderInvoices = (clientKey: string, clientName: string, cols: number) => {
    if (openKey !== clientKey) return null;
    const inv = invCache[clientKey];
    const cell: React.CSSProperties = { background: "var(--surface-2, rgba(127,127,127,0.05))", fontSize: "var(--fs-sm)", verticalAlign: "middle" };
    const wide = (text: string) => (
      <tr><td colSpan={cols} style={{ ...cell, color: "var(--text-muted)", paddingLeft: 28 }}>{text}</td></tr>
    );
    if (inv === "loading" || inv === undefined) return wide("Завантаження рахунків…");
    if (inv.length === 0) return wide("Деталізації рахунків немає.");

    // 💰 Клітинки колонки «Заробили на угоді» — ОДИН прохід у ПОРЯДКУ ВІДОБРАЖЕННЯ.
    // Порядок значущий: «перший рахунок угоди» на екрані й у розрахунку мусить
    // бути тим самим рядком, інакше число зʼїде на сусідній.
    const eCells = earnedCells(inv);
    const eTotal = earnedShownTotal(eCells);
    const debt = inv.reduce((a, x) => a + (x.writtenOff ? 0 : x.amount), 0);
    /* 🕰 ВІК — ІЗ СЕРВЕРА, ОДНИМ ВИРАЗОМ ІЗ РЯДКОМ КЛІЄНТА. Свій підрахунок тут
       давав ДРУГИЙ ГОЛОС: на УКРЕНЕРГО-АЛЬЯНСІ рядок казав «1128 дн.», а ця
       шапка — «найстаріший 22 дн.», обидва на одному екрані. */
    const oldest = invAge[clientKey] ?? null;
    const entities = [...new Set(inv.map((x) => x.entityName).filter((n): n is string => !!n))];

    return (
      <>
        {/* Шапка групи. Підсумок «заробили» складено з НАМАЛЬОВАНИХ клітинок
            (`earnedShownTotal`), тож розійтись із колонкою він не може. */}
        <tr>
          <td colSpan={cols} style={{ ...cell, paddingTop: 12, borderBottom: "none", color: "var(--text-muted)" }}>
            <b style={{ color: "var(--text)", fontSize: "var(--fs-13)" }}>Рахунки клієнта</b>
            <span style={{ marginLeft: 10 }}>
              {inv.length} шт · {formatAmount(debt)}
              {oldest != null && ` · найстаріший ${oldest} дн.`}
            </span>
            <Hint title="Ті самі колонки, дрібнішим зерном"
              body="Кожна колонка стоїть під тією самою колонкою рядка клієнта: сума під сумою, заробіток під заробітком. Дедлайн оплати по рахунку створює менеджеру задачу, якщо мине без оплати — на відміну від домовленості з клієнтом загалом." />
            {entities.length > 1 && (
              /* 🔗 Склейка інакше читається як зникнення другої компанії:
                 на екрані один рядок, а юросіб дві. */
              <span style={{ display: "block", fontSize: "var(--fs-xs)", marginTop: 2 }}>
                🔗 Обʼєднаний клієнт — усередині {entities.length} юрособи: <b style={{ color: "var(--text)" }}>{entities.join(" · ")}</b>
              </span>
            )}
          </td>
        </tr>

        {inv.map((x, i) => {
          const no = x.invoiceNo ?? "";
          const cc = carrierCell(x.carrierPaid, x.carrierReason, x.carrierPayAmount);
          const ec = eCells[i] ?? { kind: "unknown" as const, why: "one_c" as const };
          const eTxt = earnedCellText(ec);
          const overdue = x.dueDate != null && x.dueDate < today;
          const iDate = parseDateSafe(x.invoiceDate);
          const age = iDate ? Math.floor((Date.now() - iDate.getTime()) / 86400000) : null;
          return (
            <tr key={`${clientKey}-inv-${i}`} className="recv-inv">
              <td style={cell} />
              {/* Клієнт → рахунок */}
              <td style={{ ...cell, paddingLeft: 28 }}>
                {/* 🔗 ЛІНК НА УГОДУ — ЛИШЕ ТАМ, ДЕ УГОДА Є (#198b). Мертвий
                    значок у сорока рядках поспіль обіцяє перехід, якого не буде.
                    `serviceUrl` є і в 1С-рахунків, тож умова — `dealFound`, а не
                    наявність URL.
                    🔴 І ДВА «НЕМА» — РІЗНІ РЕЧІ, підписані окремо: «угоди немає»
                    (рахунок виставлено повз CRM, так і задумано) проти «лінк
                    битий» (угода МАЛА Б бути — одруківка в 1С або видалили в
                    Kommo). Звести їх в одне означало б послати двох різних
                    людей робити дві різні дії за однією порожньою клітинкою. */}
                <span style={{ fontWeight: 600, display: "block" }}>
                  {no || "—"}
                  {x.serviceUrl && x.dealFound && (
                    <a href={x.serviceUrl} target="_blank" rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      title={`Відкрити угоду ${x.dealId} в CRM`}
                      style={{ marginLeft: 6, fontSize: "var(--fs-xs)", textDecoration: "none" }}>🔗</a>
                  )}
                  {x.dealId == null && (
                    <Tip title="Угоди немає" style={{ marginLeft: 6, fontWeight: 400, fontSize: "var(--fs-xs)", color: "var(--text-muted)" }}
                      body="Рахунок виставлено напряму в 1С, повз CRM — угоди не існує за задумом, це не втрачений лінк.">угоди немає</Tip>
                  )}
                  {x.dealId != null && !x.dealFound && (
                    <Tip title="Лінк битий" style={{ marginLeft: 6, fontWeight: 400, fontSize: "var(--fs-xs)", color: "var(--warn)" }}
                      body="№ угоди в рахунку є, а самої угоди в базі немає: одруківка в 1С або угоду видалили в Kommo. Це ІНШИЙ діагноз, ніж «угоди немає».">лінк битий</Tip>
                  )}
                </span>
                <span style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)" }}>
                  {formatDateSafe(x.invoiceDate)}
                </span>
              </td>
              {/* 👤 Менеджер САМОГО РАХУНКУ — інформація, а не критерій видимості
                  (рішення власника 27.08.2026). Скоуп тепер по КЛІЄНТУ: відкрив
                  клієнта — бачиш усі його рахунки, хто б їх не виставив.
                  🔴 «БЕЗ МЕНЕДЖЕРА» СЛОВАМИ, А НЕ «—». Заміряно: 15 живих
                  рахунків не мають менеджера взагалі (виставлені напряму в 1С,
                  повз CRM), з них 11 — у ПВК АРСЕНАЛ на 1 560 000 ₴. Прочерк
                  читається як «не завантажилось»; тут же відповідь відома, і вона
                  саме така. Підставляти сюди відповідального за КЛІЄНТА
                  заборонено: колонка каже, хто виставив, і чуже імʼя було б
                  технічно правдивим підписом не до тієї величини. */}
              <td style={{ ...cell, color: "var(--text-muted)" }}>
                {x.managerName ?? <i>без менеджера</i>}
              </td>
              {/* Юрособа → НАША юрособа цього рахунку (та сама, що в плитці) */}
              <td style={cell} title="Наша юрособа, від якої виставлено цей рахунок">
                {x.ourEntity && x.ourEntity !== "unknown"
                  ? ENTITY_LABEL[x.ourEntity]
                  : <Tip body={x.ourEntityReason ? ENTITY_REASON_LABEL[x.ourEntityReason] : "юрособа невідома"}
                         title="Юрособа невідома" style={{ color: "var(--text-muted)" }}>невідомо</Tip>}
              </td>
              {/* Перевізник → стан і сума по ЦЬОМУ рахунку */}
              <td style={cell}>
                <Tip title={cc.text} body={(cc.why ?? "") + (cc.amountText ? ` · ${cc.amountText}` : "")}>
                  <span style={{ color: cc.tone === "paid" ? "var(--ok, #166534)" : cc.tone === "unpaid" ? "var(--warn)" : "var(--text-muted)" }}>
                    {cc.text}
                  </span>
                  {cc.amountText && <span style={{ color: "var(--text-muted)" }}> · {cc.amountText}</span>}
                </Tip>
              </td>
              {/* Сума боргу → сума рахунку */}
              <td className="recv-num" style={{ ...cell, textAlign: "right", fontWeight: 600, whiteSpace: "nowrap" }}
                  title={formatAmountFull(x.amount)}>{formatAmount(x.amount)}</td>
              {/* Заробили → заробили на цій угоді */}
              <td className="recv-num" style={{ ...cell, textAlign: "right", whiteSpace: "nowrap",
                           fontWeight: ec.kind === "value" ? 600 : 400,
                           color: ec.kind === "value" ? undefined : "var(--text-muted)" }}>
                {eTxt == null
                  ? formatAmount(ec.kind === "value" ? ec.earned : 0)
                  : <Tip body={earnedCellHint(ec)}>{eTxt}</Tip>}
              </td>
              {/* Днів → вік цього рахунку */}
              <td className="recv-num" style={{ ...cell, textAlign: "center", ...(age != null && age > 30 ? { color: "#dc2626", fontWeight: 600 } : {}) }}>
                {age ?? "—"}
              </td>
              {/* Ліміт → дедлайн оплати ПО РАХУНКУ */}
              <td style={{ ...cell, textAlign: "center" }}>
                <input type="date" value={x.dueDate ?? ""} disabled={!canEditReceivables}
                  aria-label={`Дедлайн оплати рахунка ${no}`}
                  onChange={(e) => patchInvoice(clientKey, no, { dueDate: e.target.value || null })}
                  style={{ ...inputStyle, ...(overdue ? { borderColor: "#dc2626" } : {}) }} />
              </td>
              {/* 💰 Ліміт суми → у рахунка аналога НЕМАЄ: ліміт задається
                  ПОКЛІЄНТНО, а не по рахунку. Клітинка порожня свідомо —
                  підставити сюди клієнтський ліміт означало б повторити одне
                  число в сорока рядках, ніби воно про кожен рахунок окремо. */}
              <td style={cell} aria-hidden="true" />
              {/* Домовленість → коментар до рахунка */}
              <td style={{ ...cell, minWidth: 180 }}>
                <CommentField value={x.comment} editable={canEditReceivables}
                  onSave={(next) => patchInvoice(clientKey, no, { comment: next })} />
              </td>
              {/* Дія */}
              <td className="recv-act" style={{ ...cell, textAlign: "right", position: "relative" }}>
                {canWriteOff && no !== "" && (
                  <WriteoffButton onClick={() => setWriteoffFor(
                    writeoffFor?.clientKey === clientKey && writeoffFor.invoiceNo === no
                      ? null : { clientKey, invoiceNo: no })} />
                )}
                {/* 🔴 ВІДСУТНЯ ДІЯ МУСИТЬ БУТИ ПОЯСНЕНА, А НЕ ПРОСТО ВІДСУТНЯ
                    (рішення власника 26.08.2026). Ключ списання — пара (клієнт,
                    номер), тож усі безномерні рахунки клієнта згортаються в ОДИН
                    ключ: кнопка стояла б у рядку, а діяла на кілька. Це рівно та
                    форма, від якої ми найбільше постраждали — технічно правдивий
                    підпис, що читається як інше. Тому кнопки тут немає, і
                    порожнечі теж немає.
                    ⏳ Знімається разом із ключуванням по `id` (борг, парна зміна):
                    тоді зʼявиться кнопка, а це пояснення зникне. */}
                {canWriteOff && no === "" && (
                  <Tip title="Списання недоступне"
                    style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)", whiteSpace: "nowrap" }}
                    body="Ключ списання — номер рахунку, а тут його немає: усі безномерні рахунки цього клієнта мають спільний ключ, тож кнопка в одному рядку списала б і сусідні. Списати можна цілим клієнтом.">
                    списання недоступне: рахунок без номера
                  </Tip>
                )}
                {writeoffFor?.clientKey === clientKey && writeoffFor.invoiceNo === no && (
                  <WriteoffDialog clientKey={clientKey} clientName={clientName}
                    invoiceNo={no} amount={x.amount}
                    alreadyWritten={{ n: x.writtenOff ? 1 : 0, amount: x.writtenOff ? x.amount : 0 }}
                    onClose={() => setWriteoffFor(null)}
                    onDone={() => { setWriteoffFor(null); loadInvoices(clientKey); onRefresh?.(); }} />
                )}
              </td>
            </tr>
          );
        })}

        {/* Підсумковий рядок — У ТИХ САМИХ колонках, що й рахунки. */}
        <tr>
          <td style={{ ...cell, borderTop: "1px solid var(--border-strong, #d1d5db)" }} />
          <td colSpan={4} style={{ ...cell, borderTop: "1px solid var(--border-strong, #d1d5db)", paddingLeft: 28, fontWeight: 600 }}>
            Разом по {nPlural(inv.length, "рахунку", "рахунках", "рахунках")}
          </td>
          <td className="recv-num" style={{ ...cell, borderTop: "1px solid var(--border-strong, #d1d5db)", textAlign: "right", fontWeight: 700, whiteSpace: "nowrap" }}>
            {formatAmount(debt)}
          </td>
          <td className="recv-num" style={{ ...cell, borderTop: "1px solid var(--border-strong, #d1d5db)", textAlign: "right", fontWeight: 700, whiteSpace: "nowrap" }}>
            {formatAmount(eTotal)}
          </td>
          <td colSpan={5} style={{ ...cell, borderTop: "1px solid var(--border-strong, #d1d5db)" }} />
        </tr>
      </>
    );
  };
  const caret = (clientKey: string) => (openKey === clientKey ? "▾ " : "▸ ");

  // Плоский список клієнтів + зведені KPI.
  const all = receivablesData
    .flatMap((m) => m.clients.map((c) => ({ ...c, managerName: m.managerName })))
    .sort((a, b) => b.amount - a.amount);
  // 🔴 `total` рахується по ВСЬОМУ списку, а не по відфільтрованому: плитка
  // «Загальний борг» описує стан дебіторки, а не стан фільтра. Підсумок видимих
  // рядків стоїть ОКРЕМО, під таблицею, і підписаний як видимий.
  const total = all.reduce((s, c) => s + c.amount, 0);
  const overdueClients = all.filter(isOverdue);
  const overdueSum = overdueClients.reduce((s, c) => s + c.amount, 0);
  // 🔴 РОЗКЛАД НА ДВІ ПРИЧИНИ — щоб число не читалось як «усі ці клієнти в біді».
  // Заміряно перед викатом Е4: із 45 нових прострочених 15 мають вік 1-7 днів —
  // це свіжі рахунки клієнтів, яким просто не ставили ліміт. Правило рахує їх
  // правильно (рішення власника), але без розкладу «63» лякало б дарма.
  const overdueBeyondAgreed = overdueClients.filter((c) => limitState(c.limitDays) === "agreed").length;
  const overdueNoLimit = overdueClients.length - overdueBeyondAgreed;

  // ✏️ Хто зараз редагується (ключ клієнта) і чи відкритий діалог склейки.
  const [ownerFor, setOwnerFor] = useState<string | null>(null);
  const [limitFor, setLimitFor] = useState<string | null>(null);
  /** Який клієнт зараз редагує домовленість — редактор переїхав у поповер (прохід B). */
  const [agreeFor, setAgreeFor] = useState<string | null>(null);
  const [limitReqFor, setLimitReqFor] = useState<string | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mgrOptions, setMgrOptions] = useState<ManagerOption[]>([]);
  useEffect(() => {
    // Список тягнемо ОДИН раз і лише тим, хто має право призначати: інакше це
    // запит, який нікому не потрібен, на кожному відкритті екрана.
    if (!canSetOwner || mgrOptions.length) return;
    fetchManagerOptions().then(setMgrOptions).catch(() => setMgrOptions([]));
  }, [canSetOwner, mgrOptions.length]);

  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  /* ↕️ Дефолт дорівнює тому, що вже було на екрані (борг спадно) — будується
     КЕРУВАННЯ, а не нова поведінка. Сортуються КЛІЄНТИ; рахунки малюються
     одразу за своїм клієнтом (`renderInvoices` усередині `.map`), тож відірвати
     їх від нього неможливо за побудовою. */
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const shown = sortClients(all.filter((c) => passesFilters(c, filters)), sort);
  const shownSum = shown.reduce((s, c) => s + c.amount, 0);

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Дебіторська заборгованість</h1>
        <div className="page-filters">
          {auth?.role !== "manager" && (
            <select
              value={receivablesTeamId}
              onChange={(e) => setReceivablesTeamId(e.target.value ? Number(e.target.value) : "")}
            >
              <option value="">Усі команди</option>
              {teamOptions(teams)}
            </select>
          )}
          {canEditReceivables && (
            <button onClick={refreshFromSheet} disabled={syncing} title="Перечитати дебіторку прямо з 1С — оплачені рахунки зникнуть одразу"
              style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", cursor: syncing ? "default" : "pointer", fontWeight: 600, fontSize: "var(--fs-13)" }}>
              {syncing ? "Оновлення…" : "🔄 Оновити з 1С"}
            </button>
          )}
          {receivablesSyncedAt && (
            <span className="loading-text" style={{ fontSize: "var(--fs-sm)" }}>
              {/* Сторож і тут, хоч це поле й не моє: клас той самий, і воно
                  рендериться в тій самій секції — одна нерозбірна дата з БД
                  поклала б увесь екран так само, як 26.08.2026. */}
              Оновлено: {parseDateSafe(receivablesSyncedAt)?.toLocaleString("uk-UA") ?? "час невідомий"}
            </span>
          )}
        </div>
      </div>

      {/* 🗄 ДВІ ВКЛАДКИ (макет v5). Архів — окремий екран, а не фільтр: списаний
          борг зникає з активного списку ПОВНІСТЮ, тож тримати їх в одній таблиці
          означало б повернути те, що власник щойно скасував. */}
      <div role="tablist" aria-label="Розділи дебіторки"
        style={{ display: "flex", gap: 4, borderBottom: "1px solid var(--border)", marginBottom: 16 }}>
        {([["active", "Активна дебіторка"], ["archive", "Архів"]] as const).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            style={{ font: "inherit", fontSize: "var(--fs-base)", background: "none", border: "none",
                     borderBottom: `2px solid ${tab === k ? "var(--brand, #c5141c)" : "transparent"}`,
                     color: tab === k ? "var(--text)" : "var(--text-muted)",
                     fontWeight: tab === k ? 600 : 500, padding: "10px 12px", cursor: "pointer" }}>
            {label}
          </button>
        ))}
      </div>

      {tab === "archive" ? (
        <ReceivablesArchive onRestored={() => onRefresh?.()} />
      ) : receivablesLoading ? (
        <p className="loading-text">Завантаження...</p>
      ) : receivablesData.length === 0 ? (
        <p className="loading-text">Немає даних.</p>
      ) : (
        <>
          <ReceivablesTiles
            totals={receivablesTotals}
            debtTotal={total}
            clientCount={all.length}
            overdueCount={overdueClients.length}
            overdueBeyondAgreed={overdueBeyondAgreed}
            overdueNoLimit={overdueNoLimit}
            overdueSum={overdueSum}
          />

          <div className="chart-card" style={{ marginBottom: 16 }}>
            <h2 className="chart-title" style={{ marginBottom: 4 }}>Боржники ({all.length})</h2>
            <p style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)", margin: "0 0 10px" }}>
              Клік по клієнту — неоплачені рахунки з дедлайном і коментарем до кожного. Червоні дні — прострочка понад ліміт.
            </p>
            <ReceivablesFilters filters={filters} setFilters={setFilters} shown={shown.length} totalRows={all.length} />
            {/* Кнопки НЕМАЄ ВЗАГАЛІ без права — не «є, але дає 403». Право рахує
                сервер тим самим виразом, що гейтить роут. */}
            {canMerge && (
              <button onClick={() => setMergeOpen(true)}
                title="Дві юрособи виявились одним клієнтом — обʼєднати в один рядок"
                style={{ font: "inherit", fontSize: "var(--fs-13)", fontWeight: 600, padding: "5px 12px",
                         borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)",
                         color: "var(--text)", cursor: "pointer", marginBottom: 12 }}>
                🔗 Обʼєднати клієнтів
              </button>
            )}
            <div style={{ overflowX: "auto" }}>
              <table className="data-table recv-table">
                <thead>
                  <tr>
                    {/* 📐 ШИРИНИ ЗАМІРЯНІ, А НЕ ПІДІБРАНІ (25.08.2026, живий прод).
                        Було: Клієнт 396px · Домовленість 220 · Відповідальний 163 —
                        а Сума боргу 85 · Днів 66 · Ліміт 67. Найширше віддано тексту,
                        найвужче — числам, заради яких екран існує.

                        🔴 І ТА САМА ВУЗЬКІСТЬ ЛАМАЛА ЧИПИ: «Юрособа» (95px) і
                        «Перевізник» (117px) уже мали `flex-wrap`, тож кожен чип
                        переносився на власний рядок — 5 візуальних рядків у ПВК
                        АРСЕНАЛ. Це не дві проблеми, а одна: колонкам бракує місця. */}
                    <th style={{ textAlign: "center", width: 36 }}>#</th>
                    <th style={{ textAlign: "left", width: 300 }}>Клієнт</th>
                    <th style={{ textAlign: "left", width: 150 }}>
                      Відповідальний
                      <Hint title="Мажоритар за сумою боргу"
                        body="Менеджер, на якого припадає найбільша частина рахунків цього клієнта. Олівець дозволяє призначити вручну — з обовʼязковою приміткою." />
                    </th>
                    <th style={{ textAlign: "left", width: 130 }}>
                      Юрособа
                      <Hint title="Наша компанія, на яку виставлені рахунки"
                        body="Якщо їх кілька — показано ту, на яку припадає найбільше; повний розклад при наведенні на саме значення. Виводиться з «форми оплати» в CRM." />
                    </th>
                    <th style={{ textAlign: "left", width: 150 }}>
                      Перевізник
                      <Hint title="Чи розрахувались ми з перевізником по цих угодах"
                        body="«н/д» означає «не знаємо» — у CRM не заповнена форма оплати. Це НЕ те саме, що «не оплачено»: заміряно 1.6 млн ₴ рахунків, які показувались би фальшивою неоплатою." />
                    </th>
                    {/* ↕️ ЗАГОЛОВОК — КНОПКА, А НЕ `div` З `onClick` (вимога).
                        Кнопка приходить у Tab-обхід і жме з клавіатури сама;
                        `div` довелось би вручну наділяти `role`, `tabIndex` і
                        обробником `Enter`/`Space` — тобто відтворювати кнопку,
                        і саме в цьому відтворенні щось незмінно губиться. */}
                    <th style={{ textAlign: "right", whiteSpace: "nowrap", width: 110 }}
                        aria-sort={ariaSort(sort, "amount")}>
                      <button type="button" className="recv-sort"
                        onClick={() => setSort(nextSort(sort, "amount"))}
                        title="Сортувати за сумою боргу">
                        Сума боргу{sortMark(sort, "amount")}
                      </button>
                      <Hint title="Скільки цей клієнт винен зараз"
                        body="Залишок за неоплаченими рахунками з 1С. Списані в архів сюди не входять." />
                    </th>
                    {/* 💰 ЗАРОБІТОК І МАРЖА — ОДНА КОЛОНКА (макет v5): сума й
                        відсоток читаються разом, а не двома стовпцями про одне. */}
                    <th style={{ textAlign: "right", whiteSpace: "nowrap", width: 130 }}>
                      Заробили
                      <Hint title="Наш заробіток по угодах цього клієнта"
                        body="Береться з поля «Бюджет» в угоді CRM — це не борг і не виручка. Відсоток — від суми рахунків, тобто від ПОВНОЇ суми угод, а не від залишку боргу: борг падає з кожною оплатою, і відношення до нього вибухає (заміряно максимум 6 667%)." />
                    </th>
                    <th className="recv-days" style={{ textAlign: "center", width: 70 }}
                        aria-sort={ariaSort(sort, "days")}>
                      <button type="button" className="recv-sort"
                        onClick={() => setSort(nextSort(sort, "days"))}
                        title="Сортувати за днями без оплати">
                        Днів{sortMark(sort, "days")}
                      </button>
                      <Hint title="Скільки днів найстаріший рахунок лишається неоплаченим"
                        body="Червоне — вже понад узгоджений ліміт відстрочки. «—» означає «не знаємо» і при сортуванні йде В КІНЕЦЬ в обидва боки: це не нуль днів." />
                    </th>
                    <th style={{ textAlign: "center", width: 138 }}>
                      Ліміт днів
                      <Hint title="Скільки днів відстрочки ми дали цьому клієнту"
                        body="«Не узгоджено» означає, що рахунок виставили, а відстрочку не погодили — таких клієнтів ми не кредитуємо. Це НЕ те саме, що «розглянули і не дали»: різницю видно в підказці самого значення." />
                    </th>
                    {/* 💰 ЛІМІТ СУМИ — ВЛАСНА КОЛОНКА (макет v6, прохід B).
                        Він жив ДРУГИМ РЯДКОМ під сумою боргу — і саме тому
                        клітинка боргу міряла 150px там, де даних на 18. Два
                        незалежні ліміти стоять поруч, кожен зі своїм олівцем:
                        клієнт може порушити один, обидва або жоден. */}
                    <th style={{ textAlign: "center", width: 143 }}>
                      Ліміт суми
                      <Hint title="Більше якої суми ми не даємо клієнту заходити в борг"
                        body="База — загальний борг за виставленими рахунками. Перевищення НІЧОГО не блокує: воно просто видно. «Не задано» і «відмова · 0 ₴» — різні стани й різні рішення." />
                    </th>
                    {/* 🗓 «Обіцяна дата» і «Домовленість» злиті: це одна думка,
                        а займала два стовпці (макет v5). */}
                    <th style={{ textAlign: "left", width: 220 }}>
                      Домовленість
                      <Hint title="Дата й суть домовленості з клієнтом"
                        body="Показано лише запис ПОТОЧНОГО тижня (від понеділка 00:00 за Києвом), щоб торішня обіцянка не читалась як сьогоднішня. Натисніть на рядок, щоб змінити; нічого не видаляється — попередні записи в «історії»." />
                    </th>
                    <th className="recv-act" aria-label="дії" />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((c, i) => {
                    const over = isOverdue(c);
                    const badges = originBadges(c.facts);
                    const ent = foldEntity(c.facts);
                    const car = foldCarrier(c.facts);
                    // 🗓 Активним є ЛИШЕ запис поточного тижня. Нічого не
                    // затирається — змінюється те, що вважається актуальним.
                    const noteNow = activeNote(c.comment, c.noteUpdatedAt ?? null, now);
                    // 🔴 РЯДОК І ПОПОВЕР БЕРУТЬ ОДНЕ Й ТЕ САМЕ `noteNow`. Якби
                    // згорнутий рядок читав `c.comment`, а редактор — звужений
                    // запис (чи навпаки), людина бачила б торішню обіцянку й
                    // правила б цьоготижневу. Тижнева межа лишається однією.
                    const agree = agreementLine(c.dueDate ?? null, noteNow);
                    return (
                      /* 🛡 МЕЖА НА РІВНІ РЯДКА (26.08.2026). Одна нерозбірна дата
                         вбила всю секцію — 75 справних рядків загинули з одним.
                         Межа не ховає дефект: вона називає клієнта й лишає решту
                         таблиці живою. Другий рубіж, а не заміна сторожам. */
                      <RowBoundary key={`${c.clientKey}-${i}`} label={c.clientName} cols={12}>
                        {/* 🖱 Клікабельний увесь рядок; клік по полю всередині НЕ
                            згортає — інакше кожен дотик до input/textarea закривав
                            би клієнта просто в момент редагування. */}
                        <tr role="button" tabIndex={0} aria-expanded={openKey === c.clientKey}
                          className="recv-row"
                          onClick={(e) => {
                            if ((e.target as HTMLElement).closest("input, textarea, button, select, a")) return;
                            toggleClient(c.clientKey);
                          }}
                          onKeyDown={(e) => {
                            if (e.key !== "Enter" && e.key !== " ") return;
                            if ((e.target as HTMLElement).closest("input, textarea, button, select, a")) return;
                            e.preventDefault();
                            toggleClient(c.clientKey);
                          }}
                          style={{ cursor: "pointer" }}>
                          <td style={{ color: "var(--text-muted)", textAlign: "center", verticalAlign: "middle" }}>{i + 1}</td>

                          <td style={{ textAlign: "left", verticalAlign: "middle" }}>
                            <span style={{ fontWeight: 600 }}>
                              <span style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)", marginRight: 4 }}>{caret(c.clientKey)}</span>
                              {/* 📐 ОБРІЗАННЯ НА 170px (макет v6.1). Повна назва —
                                  у `title`: обрізання не має ховати зміст. */}
                              <span className="recv-cname" title={c.clientName}>{c.clientName}</span>
                            </span>
                            {badges.length > 0 && (
                              <span className="recv-badges">
                                {badges.map((b) => (
                                  <Tip key={b.text} title={b.text} body={b.hint}
                                    style={{ fontSize: "var(--fs-xs)", marginRight: 6,
                                             color: b.tone === "warn" ? "var(--warn)" : "var(--text-muted)" }}>
                                    {b.icon} {b.text}
                                  </Tip>
                                ))}
                              </span>
                            )}
                          </td>

                          {/* 📐 ІМʼЯ Й ОЛІВЕЦЬ — В ОДНОМУ РЯДІ (прохід B).
                              Заміряно в браузері до правки: `OwnerCell` — блок на
                              ДВА рядки (імʼя + причина, і причина обовʼязкова, це
                              рішення `#136`), а олівець 32×32 падав ПІД нього.
                              ХЕВІ БУІЛД: 33 + 32 = 65px у клітинці, рядок **72**
                              при цільових 48 — тобто найвищим був не «Клієнт» і не
                              «Домовленість», а саме цей стовпець. Той самий засіб,
                              що для лімітів: значення ліворуч, кнопка праворуч. */}
                          <td style={{ textAlign: "left", verticalAlign: "middle", fontSize: "var(--fs-sm)", position: "relative" }}>
                            <div className="recv-ownercell">
                            <OwnerCell c={c} />
                            {/* 🔴 ГІЛКА ДЛЯ ГОТІВКИ ОБОВʼЯЗКОВА (#163). `PUT /receivables/owner`
                                віддає 404 на готівковому рядку — його CRM перебудовує щосинку,
                                тож override відкотився б сам. Кнопка, що гарантовано впаде,
                                гірша за відсутню; людина має дізнатись ПРИЧИНУ, а не загадку.
                                Я загубив цю гілку в переверстці — упіймав `#163`, не око. */}
                            {canSetOwner && (c.ownerSource === "cash-invoice" ? (
                              <span title="Готівковий рядок CRM перебудовує щосинку — ручне призначення відкотилось би саме"
                                style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)", marginLeft: 6 }}>
                                ✏️ змінюється в CRM, не тут
                              </span>
                            ) : (
                              <button onClick={() => setOwnerFor(ownerFor === c.clientKey ? null : c.clientKey)}
                                title="Змінити відповідального за борг" aria-label="Змінити відповідального за борг"
                                className="recv-ico">✏️</button>
                            ))}
                            </div>
                            {ownerFor === c.clientKey && (
                              <OwnerEditor client={c} managers={mgrOptions}
                                onClose={() => setOwnerFor(null)}
                                onDone={() => { setOwnerFor(null); onRefresh?.(); }} />
                            )}
                          </td>

                          {/* 🗜 ОДИН РЯДОК + РОЗКЛАД У ПІДКАЗЦІ. Багаторядковий блок
                              «ЮТС 27 / Автомув 3 / невідомо 11» роздував висоту
                              рядка втричі, а таких колонок дві. */}
                          <td style={{ textAlign: "left", verticalAlign: "middle", fontSize: "var(--fs-sm)" }}>
                            {ent ? (
                              <Tip title="Юрособи цього клієнта"
                                body={ent.parts > 1 ? ent.full : "усі рахунки виставлені на цю нашу компанію"}>
                                {ent.head} {ent.n}
                              </Tip>
                            ) : <span style={{ color: "var(--text-muted)" }}>—</span>}
                          </td>

                          {/* 🚚 ПІДПИС СКОРОЧЕНО (макет v6): «не оплачено · 28» замість
                              «ще не оплачено 28». Слово «перевізник» повторювалось у
                              78 рядках, хоч колонка так і зветься, а найдовший варіант
                              не влазив у 106px і переносив рядок.
                              ⚠️ Скорочується САМЕ ПІДСУМОК по клієнту. Стан ОДНОГО
                              рахунка (`carrierCell` у розкритті) лишається дослівним —
                              його стереже `#197c`, і «н/д» там окремий третій стан. */}
                          <td style={{ textAlign: "left", verticalAlign: "middle", fontSize: "var(--fs-sm)" }}>
                            {car ? (
                              <Tip title="Перевізники по цих угодах"
                                body={`${car.full}. «н/д» означає «не знаємо» — у CRM не заповнена форма оплати, а не те, що перевізник не оплачений.`}>
                                {car.head} · <span className="recv-num">{car.n}</span>
                              </Tip>
                            ) : <span style={{ color: "var(--text-muted)" }}>—</span>}
                          </td>

                          {/* 💰 СУМА БОРГУ + СТАН ЛІМІТУ ПО СУМІ. Кнопка запиту стоїть
                              САМЕ ТУТ (рішення власника 26.08.2026): ліміт задається
                              поклієнтно, отже й запит поклієнтний. У плитці «Загальний
                              борг» кнопки немає — там сума по всьому екрану. */}
                          <td className="recv-num" style={{ textAlign: "right", fontWeight: 700, verticalAlign: "middle",
                                       whiteSpace: "nowrap", position: "relative" }}
                              title={formatAmountFull(c.amount)}>
                            {/* 🔴 СУМА Й КНОПКА — В ОДНОМУ РЯДКУ, СТАН — ПІД НИМИ.
                                Спіймано скріншотом: кнопка, поставлена після
                                блокового підпису стану, переносилась під нього й
                                губилась у клітинці. Гейт цього не бачить — він
                                читає джерело, а перенос вирішує браузер. */}
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                              {formatAmount(c.amount)}
                              {canRequestLimit && (
                                <button onClick={() => setLimitReqFor(limitReqFor === c.clientKey ? null : c.clientKey)}
                                  title="Поставити задачу на перегляд ліміту"
                                  aria-label={`Запит на перегляд ліміту: ${c.clientName}`}
                                  className="recv-ico" style={{ minHeight: 24 }}>🧾</button>
                              )}
                            </span>
                            {/* 🧾 Кнопку бачить лише той, хто може поставити задачу ІНШОМУ.
                                Право віддає СЕРВЕР (`canRequestLimit`), і він же гейтить
                                роут: схована кнопка правом не є. Сама кнопка — вище,
                                поряд із сумою. */}
                            {limitReqFor === c.clientKey && (
                              <LimitRequestDialog clientKey={c.clientKey} onClose={() => setLimitReqFor(null)} />
                            )}
                          </td>

                          {/* 💰 ЗАРОБІТОК І МАРЖА — ОДНА КОЛОНКА. Сума й відсоток
                              читаються разом; двома стовпцями вони змушували
                              стрибати очима туди-сюди по одному твердженню. */}
                          <td className="recv-num" style={{ textAlign: "right", verticalAlign: "middle", whiteSpace: "nowrap", fontSize: "var(--fs-sm)" }}>
                            <Tip body={marginHint(c.margin)}>
                              {c.margin?.earned == null
                                ? <span style={{ color: "var(--text-muted)" }}>—</span>
                                : <>
                                    {formatAmount(c.margin.earned)}
                                    <span style={{ color: "var(--text-muted)", marginLeft: 4 }}>{marginPctText(c.margin)}</span>
                                  </>}
                            </Tip>
                          </td>

                          <td className="recv-num" style={{ textAlign: "center", verticalAlign: "middle", ...(over ? { color: "#dc2626", fontWeight: 700 } : {}) }}>
                            {c.overdueDays ?? "—"}
                            {isAncientDebt(c.overdueDays) && (
                              <Tip title="Старий рахунок" body="Рахунок старший за рік — це факт, а не збій розрахунку."
                                style={{ display: "block", fontSize: "var(--fs-xs)", fontWeight: 400, color: "var(--text-muted)" }}>🕰</Tip>
                            )}
                          </td>

                          {/* 📐 ОЛІВЕЦЬ БІЛЬШЕ НЕ ЇДЕ ЗА ТЕКСТОМ. Заміряно в браузері:
                              x у пʼяти сусідніх рядках `1240·1240·1240·1240·1216` —
                              він стояв інлайново одразу за значенням, тож «14 дн.» і
                              «не узгоджено» ставили його в різні місця. Тепер значення
                              ліворуч, олівець притиснутий до правого краю комірки
                              (`.recv-limitcell`), і позиція не залежить від тексту. */}
                          <td style={{ color: limitState(c.limitDays) === "agreed" ? "var(--text-muted)" : "var(--warn)",
                                       textAlign: "center", verticalAlign: "middle", position: "relative",
                                       fontSize: limitState(c.limitDays) === "agreed" ? undefined : "var(--fs-xs)" }}>
                            <div className="recv-limitcell">
                              <span className="recv-limitval">
                                <Tip body={limitHint(c.limitDays)}>{limitLabel(c.limitDays)}</Tip>
                              </span>
                              {canSetLimit && (
                                <button onClick={() => setLimitFor(limitFor === c.clientKey ? null : c.clientKey)}
                                  title="Змінити узгоджену відстрочку" aria-label="Змінити узгоджену відстрочку"
                                  className="recv-ico">✏️</button>
                              )}
                            </div>
                            {limitFor === c.clientKey && (
                              <LimitEditor client={c}
                                onClose={() => setLimitFor(null)}
                                onDone={() => { setLimitFor(null); onRefresh?.(); }} />
                            )}
                          </td>

                          {/* 💰 ЛІМІТ СУМИ — ТРИ СТАНИ, А НЕ ДВА, і колонка своя.
                              Пара «в межах / переліміт» збрехала б там, де ліміту
                              просто не ставили: `null` перетворився б на нуль.
                              🔴 Редактор ОДИН на обидва ліміти (рядок у БД один на
                              клієнта), тож олівець відкриває той самий `LimitEditor`
                              — сам поповер живе в сусідній клітинці, і другого тут
                              немає навмисно: два екземпляри одного редактора
                              розійшлися б станом. */}
                          <td className="recv-num"
                              style={{ textAlign: "center", verticalAlign: "middle",
                                       fontSize: "var(--fs-xs)",
                                       color: isOverAmount(c) ? "#dc2626"
                                            : amountLimitState(c.limitAmount) === "agreed" ? "var(--text-muted)" : "var(--warn)" }}>
                            <div className="recv-limitcell">
                              <span className="recv-limitval">
                                <Tip body={amountLimitHint(c.limitAmount)}>
                                  {amountLimitLabel(c.limitAmount)}
                                  {amountLimitState(c.limitAmount) === "agreed" && (
                                    <span style={{ display: "block", color: isOverAmount(c) ? "#dc2626" : "var(--text-muted)" }}>
                                      {isOverAmount(c) ? "переліміт" : "у межах"}
                                    </span>
                                  )}
                                </Tip>
                              </span>
                              {canSetLimit && (
                                <button onClick={() => setLimitFor(limitFor === c.clientKey ? null : c.clientKey)}
                                  title="Змінити ліміт суми" aria-label="Змінити ліміт суми"
                                  className="recv-ico">✏️</button>
                              )}
                            </div>
                          </td>

                          {/* 🗓 «Обіцяна дата» і «Домовленість» — ОДНА колонка, і
                              з проходу B вона згорнута в ОДИН рядок: дата, початок
                              коментаря, «історія · N». Заміряно, чому: три контроли
                              в рядку давали 117px клітинки при 18px даних і тримали
                              ритм УСІЄЇ таблиці. Редагування переїхало в поповер;
                              показується й далі лише запис ПОТОЧНОГО тижня. */}
                          <td style={{ textAlign: "left", verticalAlign: "middle", position: "relative" }}>
                            <div className="recv-agree">
                              {/* 🔴 УСЯ ДІЛЯНКА «ДАТА + КОМЕНТАР» — ОДНА КНОПКА
                                  (макет v6.1). Окремий олівець зʼїдав 38px і лишав
                                  тексту 12px — один символ і трикрапка, тобто
                                  колонка була, а прочитати в ній було нічого.
                                  Повний текст іде в `title`: обрізання не має
                                  ховати зміст.
                                  ⚠️ Кнопка є і для того, хто редагувати НЕ може —
                                  вона тоді просто не відкриває редактор. Ховати її
                                  означало б, що менеджер без права не бачить навіть
                                  того, про що домовились: право керує ДІЄЮ, а не
                                  видимістю факту. */}
                              <button type="button" className="recv-agree-open"
                                title={agree.tip}
                                aria-label={`Домовленість: ${c.clientName}`}
                                disabled={!canEditReceivables}
                                onClick={() => setAgreeFor(agreeFor === c.clientKey ? null : c.clientKey)}>
                                {agree.empty ? (
                                  <span className="recv-agree-empty">{AGREEMENT_EMPTY_LABEL}</span>
                                ) : (
                                  <>
                                    <span className="recv-agree-date recv-num">{agree.dateText || "—"}</span>
                                    <span className="recv-agree-text">{agree.text || NOTE_EMPTY_PLACEHOLDER}</span>
                                  </>
                                )}
                              </button>
                              {(c.noteHistoryCount ?? 0) > 0 && (
                              /* 🔴 ЗОНА НАТИСКАННЯ ≥32×32 (вимога власника 26.08.2026).
                                 Заміряно в браузері ДО правки: 56×17 — удвічі нижче
                                 порога, тобто в неї треба цілитись. Розмір бачить
                                 ТІЛЬКИ екран: жоден гейт не міряє піксель, тому
                                 число знято `boundingBox()` і в тесті звіряються
                                 саме ті стилі, з яких воно виходить.
                                 Підкреслення лишається — це й далі читається як
                                 посилання, збільшилась лише площа, куди можна влучити. */
                              <button onClick={() => setHistoryFor(c.clientKey)}
                                className="recv-hist"
                                aria-label={`Історія домовленостей: ${c.clientName}, записів ${c.noteHistoryCount}`}
                                style={{ background: "none", border: "none", cursor: "pointer",
                                         font: "inherit", fontSize: "var(--fs-xs)", color: "var(--info, #1d4ed8)",
                                         textDecoration: "underline dotted",
                                         minWidth: 32, minHeight: 32, padding: "8px 6px", flex: "0 0 auto",
                                         display: "inline-flex", alignItems: "center" }}>
                                історія · {c.noteHistoryCount}
                              </button>
                              )}
                            </div>
                            {agreeFor === c.clientKey && (
                              <AgreementEditor client={c} note={noteNow}
                                onPatch={(patch) => patchReceivableNote(c.clientKey, patch)}
                                onClose={() => setAgreeFor(null)}
                                onDone={() => { setAgreeFor(null); onRefresh?.(); }} />
                            )}
                          </td>

                          {/* 🗑 КНОПКА З ПІДПИСОМ, А НЕ КОШИК (рішення власника):
                              кошик читається як «видалити назавжди», а дія
                              оборотна й із журналом. Зʼявляється при наведенні,
                              щоб не шуміти в 74 рядках. */}
                          {/* 🗑 ШИРИНА ЗАРЕЗЕРВОВАНА КЛАСОМ, а не вмістом: кнопка
                              зʼявляється лише на наведенні, і без резерву поява
                              розсувала б сусідні колонки — таблиця «дихала» б під
                              курсором. Видимістю керують правила `.recv-wo`, які
                              стереже `#199ba`; тут тільки місце. */}
                          <td className="recv-act" style={{ textAlign: "right", verticalAlign: "middle", position: "relative", whiteSpace: "nowrap" }}>
                            {canWriteOff && (
                              <WriteoffButton onClick={() => setWriteoffFor(
                                writeoffFor?.clientKey === c.clientKey && writeoffFor.invoiceNo === null
                                  ? null : { clientKey: c.clientKey, invoiceNo: null })} />
                            )}
                            {writeoffFor?.clientKey === c.clientKey && writeoffFor.invoiceNo === null && (
                              <WriteoffDialog clientKey={c.clientKey} clientName={c.clientName}
                                invoiceNo={null} amount={c.amount}
                                alreadyWritten={{ n: c.facts?.writtenOffN ?? 0, amount: c.facts?.writtenOffAmount ?? 0 }}
                                onClose={() => setWriteoffFor(null)}
                                onDone={() => { setWriteoffFor(null); setInvCache((x) => { const nn = { ...x }; delete nn[c.clientKey]; return nn; }); if (openKey === c.clientKey) loadInvoices(c.clientKey); onRefresh?.(); }} />
                            )}
                          </td>
                        </tr>
                        {renderInvoices(c.clientKey, c.clientName, 12)}
                      </RowBoundary>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {/* 💬 ОДИН шар підказок на весь екран — у `body`, `position:fixed`.
                Усередині `overflow-x:auto` будь-який `absolute` обрізається
                контейнером, тобто підказка над правою колонкою була б відрізана
                рівно там, де вона потрібна. Єдиний прийом, узятий з макета
                дослівно. */}
            <TipLayer />
            {historyFor && (
              <NoteHistoryDialog clientKey={historyFor}
                clientName={shown.find((x) => x.clientKey === historyFor)?.clientName ?? historyFor}
                onClose={() => setHistoryFor(null)} />
            )}
            {/* 🔴 ПІДСУМОК ВИДИМИХ РЯДКІВ — ОКРЕМО від плитки «Загальний борг» і
                підписаний як видимий. Якби плитка їздила за фільтром, «загальний
                борг» означав би різне залежно від щойно натиснутого, а якби цього
                рядка не було — сума на екрані не сходилась би з плиткою, і це
                читалось би як поломка. */}
            {shown.length !== all.length && (
              <p style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)", margin: "10px 0 0" }}>
                Видимих рядків: <b style={{ color: "var(--text)" }}>{shown.length}</b> із {all.length} ·
                сума видимих <b style={{ color: "var(--text)" }} title={formatAmountFull(shownSum)}>{formatAmount(shownSum)}</b> із {formatAmount(total)}.
                Плитки вгорі показують УСЮ дебіторку у скоупі й за фільтром не змінюються.
              </p>
            )}
            {shown.length === 0 && (
              <p style={{ fontSize: "var(--fs-13)", color: "var(--text-muted)", margin: "12px 0 0" }}>
                Під цими фільтрами боржників немає — але в скоупі їх {all.length}. Зніміть фільтр, щоб побачити всіх.
              </p>
            )}
          </div>

          {mergeOpen && (
            /* Сторони — з того, що ВЖЕ на екрані (див. шапку MergeDialog про
               `/client-search` і `merge_clients`). `facts` дають кількість
               рахунків, тобто людина бачить обсяг, а не лише суму. */
            <MergeDialog
              sides={all.map<MergeSide>((c) => ({
                clientKey: c.clientKey, clientName: c.clientName,
                amount: c.amount, invoices: c.facts?.invoices ?? 0,
              }))}
              onClose={() => setMergeOpen(false)}
              onDone={() => { setMergeOpen(false); onRefresh?.(); }}
            />
          )}

          {receivablesData.length > 1 && (
            <div className="chart-card" style={{ marginBottom: 16 }}>
              <h2 className="chart-title">По відповідальних</h2>
              <div style={{ overflowX: "auto" }}>
                <table className="data-table compact" style={{ minWidth: 420 }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left" }}>Відповідальний</th>
                      <th style={{ textAlign: "right" }}>Борг</th>
                      <th style={{ textAlign: "right" }}>Клієнтів</th>
                      <th style={{ textAlign: "right" }}>Прострочено</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...receivablesData].sort((a, b) => b.total - a.total).map((m) => {
                      // Канонічний вираз, не власна копія: інлайн-дубль тут пережив зміну правила
                      // в Е4 і показував би СТАРУ прострочку поруч із новою плиткою.
                      const od = m.clients.filter(isOverdue);
                      return (
                        <tr key={m.managerId}>
                          <td style={{ textAlign: "left", fontWeight: 600 }}>{m.managerName}</td>
                          <td style={{ textAlign: "right", fontWeight: 700 }}>{formatAmount(m.total)}</td>
                          <td style={{ textAlign: "right" }}>{m.clients.length}</td>
                          <td style={{ textAlign: "right", color: od.length ? "#dc2626" : "#16a34a", fontWeight: 600 }}>
                            {od.length ? `${od.length} · ${formatAmount(od.reduce((s, c) => s + c.amount, 0))}` : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}
