import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { AuthPayload } from "../../../auth";
import {
  saveReceivableNote, saveReceivableInvoiceNote, fetchReceivableInvoices, triggerReceivablesSync,
  fetchManagerOptions, type ManagerOption,
  type ReceivableInvoice, type ReceivableManager, type ReceivableClient, type ReceivableTotals, type Team,
} from "../../../api";
import { WriteoffDialog } from "./WriteoffDialog";
import { WriteoffButton } from "./WriteoffButton";
import { RowBoundary } from "./RowBoundary";
import { NoteHistoryDialog } from "./NoteHistoryDialog";
import { Hint, Tip, TipLayer } from "../../../components/Hint";
import { ReceivablesTiles } from "./ReceivablesTiles";
import { ReceivablesFilters } from "./ReceivablesFilters";
import { OwnerEditor } from "./OwnerEditor";
import { LimitEditor } from "./LimitEditor";
import { MergeDialog } from "./MergeDialog";
import {
  carrierCell, EMPTY_FILTERS, ENTITY_LABEL, ENTITY_REASON_LABEL,
  isAncientDebt, isOverdue, foldEntity, foldCarrier, activeNote, NOTE_EMPTY_PLACEHOLDER,
  formatDateSafe, parseDateSafe,
  limitHint, limitLabel, limitState, originBadges, ownerState, passesFilters,
  marginHint, marginPctText,
  earnedCells, earnedCellHint, earnedCellText, earnedShownTotal,
  type Filters, type MergeSide,
} from "../receivablesView";
import { formatAmount, formatAmountFull } from "../format";
import { teamOptions } from "../teamColors";
import { CommentField } from "../../../components/CommentField";

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
  // 🗓 Один якір часу на весь рендер: інакше рядки, порахувані на різних
  // мілісекундах, могли б розійтись на самій межі понеділка.
  const now = new Date();
  /** Олівець правки — один стиль на всі клітинки, щоб вони не роз'їхались. */
  const pencilStyle: React.CSSProperties = {
    border: "none", background: "none", cursor: "pointer", padding: 0, marginLeft: 4,
    fontSize: "var(--fs-sm)", color: "var(--text-muted)", textDecoration: "underline dotted",
  };
  const [invCache, setInvCache] = useState<Record<string, ReceivableInvoice[] | "loading">>({});
  const loadInvoices = (clientKey: string) => {
    fetchReceivableInvoices(clientKey)
      .then((inv) => setInvCache((c) => ({ ...c, [clientKey]: inv })))
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
    const ages = inv.map((x) => parseDateSafe(x.invoiceDate)).filter((d): d is Date => d != null);
    const oldest = ages.length
      ? Math.floor((Date.now() - Math.min(...ages.map((d) => d.getTime()))) / 86400000)
      : null;
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
            <tr key={`${clientKey}-inv-${i}`}>
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
              {/* Відповідальний → хто створив рахунок */}
              <td style={{ ...cell, color: "var(--text-muted)" }}>{x.managerName ?? "—"}</td>
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
              <td style={{ ...cell, textAlign: "right", fontWeight: 600, whiteSpace: "nowrap" }}
                  title={formatAmountFull(x.amount)}>{formatAmount(x.amount)}</td>
              {/* Заробили → заробили на цій угоді */}
              <td style={{ ...cell, textAlign: "right", whiteSpace: "nowrap",
                           fontWeight: ec.kind === "value" ? 600 : 400,
                           color: ec.kind === "value" ? undefined : "var(--text-muted)" }}>
                {eTxt == null
                  ? formatAmount(ec.kind === "value" ? ec.earned : 0)
                  : <Tip body={earnedCellHint(ec)}>{eTxt}</Tip>}
              </td>
              {/* Днів → вік цього рахунку */}
              <td style={{ ...cell, textAlign: "center", ...(age != null && age > 30 ? { color: "#dc2626", fontWeight: 600 } : {}) }}>
                {age ?? "—"}
              </td>
              {/* Ліміт → дедлайн оплати ПО РАХУНКУ */}
              <td style={{ ...cell, textAlign: "center" }}>
                <input type="date" value={x.dueDate ?? ""} disabled={!canEditReceivables}
                  aria-label={`Дедлайн оплати рахунка ${no}`}
                  onChange={(e) => patchInvoice(clientKey, no, { dueDate: e.target.value || null })}
                  style={{ ...inputStyle, ...(overdue ? { borderColor: "#dc2626" } : {}) }} />
              </td>
              {/* Домовленість → коментар до рахунка */}
              <td style={{ ...cell, minWidth: 180 }}>
                <CommentField value={x.comment} editable={canEditReceivables}
                  onSave={(next) => patchInvoice(clientKey, no, { comment: next })} />
              </td>
              {/* Дія */}
              <td style={{ ...cell, textAlign: "right", position: "relative" }}>
                {canWriteOff && no !== "" && (
                  <WriteoffButton onClick={() => setWriteoffFor(
                    writeoffFor?.clientKey === clientKey && writeoffFor.invoiceNo === no
                      ? null : { clientKey, invoiceNo: no })} />
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
            Разом по {inv.length} рах.
          </td>
          <td style={{ ...cell, borderTop: "1px solid var(--border-strong, #d1d5db)", textAlign: "right", fontWeight: 700, whiteSpace: "nowrap" }}>
            {formatAmount(debt)}
          </td>
          <td style={{ ...cell, borderTop: "1px solid var(--border-strong, #d1d5db)", textAlign: "right", fontWeight: 700, whiteSpace: "nowrap" }}>
            {formatAmount(eTotal)}
          </td>
          <td colSpan={4} style={{ ...cell, borderTop: "1px solid var(--border-strong, #d1d5db)" }} />
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
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mgrOptions, setMgrOptions] = useState<ManagerOption[]>([]);
  useEffect(() => {
    // Список тягнемо ОДИН раз і лише тим, хто має право призначати: інакше це
    // запит, який нікому не потрібен, на кожному відкритті екрана.
    if (!canSetOwner || mgrOptions.length) return;
    fetchManagerOptions().then(setMgrOptions).catch(() => setMgrOptions([]));
  }, [canSetOwner, mgrOptions.length]);

  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const shown = all.filter((c) => passesFilters(c, filters));
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

      {receivablesLoading ? (
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
                    <th style={{ textAlign: "right", whiteSpace: "nowrap", width: 110 }}>
                      Сума боргу
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
                    <th style={{ textAlign: "center", width: 70 }}>
                      Днів
                      <Hint title="Скільки днів найстаріший рахунок лишається неоплаченим"
                        body="Червоне — вже понад узгоджений ліміт відстрочки." />
                    </th>
                    <th style={{ textAlign: "center", width: 104 }}>
                      Ліміт
                      <Hint title="Скільки днів відстрочки ми дали цьому клієнту"
                        body="«Не узгоджено» означає, що рахунок виставили, а відстрочку не погодили — таких клієнтів ми не кредитуємо. Це НЕ те саме, що «розглянули і не дали»: різницю видно в підказці самого значення." />
                    </th>
                    {/* 🗓 «Обіцяна дата» і «Домовленість» злиті: це одна думка,
                        а займала два стовпці (макет v5). */}
                    <th style={{ textAlign: "left", width: 220 }}>
                      Домовленість
                      <Hint title="Дата й суть домовленості з клієнтом"
                        body="Поле показує лише запис ПОТОЧНОГО тижня (від понеділка 00:00 за Києвом), щоб торішня обіцянка не читалась як сьогоднішня. Нічого не видаляється — попередні записи під полем, кнопка «історія»." />
                    </th>
                    <th style={{ width: 90 }} aria-label="дії" />
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
                    return (
                      /* 🛡 МЕЖА НА РІВНІ РЯДКА (26.08.2026). Одна нерозбірна дата
                         вбила всю секцію — 75 справних рядків загинули з одним.
                         Межа не ховає дефект: вона називає клієнта й лишає решту
                         таблиці живою. Другий рубіж, а не заміна сторожам. */
                      <RowBoundary key={`${c.clientKey}-${i}`} label={c.clientName} cols={11}>
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
                              {c.clientName}
                            </span>
                            {badges.length > 0 && (
                              <span style={{ display: "block", marginTop: 2 }}>
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

                          <td style={{ textAlign: "left", verticalAlign: "middle", fontSize: "var(--fs-sm)", position: "relative" }}>
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
                                style={pencilStyle}>✏️</button>
                            ))}
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

                          <td style={{ textAlign: "left", verticalAlign: "middle", fontSize: "var(--fs-sm)" }}>
                            {car ? (
                              <Tip title="Перевізники по цих угодах"
                                body={`${car.full}. «н/д» означає «не знаємо» — у CRM не заповнена форма оплати, а не те, що перевізник не оплачений.`}>
                                {car.head} {car.n}
                              </Tip>
                            ) : <span style={{ color: "var(--text-muted)" }}>—</span>}
                          </td>

                          <td style={{ textAlign: "right", fontWeight: 700, verticalAlign: "middle", whiteSpace: "nowrap" }}
                              title={formatAmountFull(c.amount)}>{formatAmount(c.amount)}</td>

                          {/* 💰 ЗАРОБІТОК І МАРЖА — ОДНА КОЛОНКА. Сума й відсоток
                              читаються разом; двома стовпцями вони змушували
                              стрибати очима туди-сюди по одному твердженню. */}
                          <td style={{ textAlign: "right", verticalAlign: "middle", whiteSpace: "nowrap", fontSize: "var(--fs-sm)" }}>
                            <Tip body={marginHint(c.margin)}>
                              {c.margin?.earned == null
                                ? <span style={{ color: "var(--text-muted)" }}>—</span>
                                : <>
                                    {formatAmount(c.margin.earned)}
                                    <span style={{ color: "var(--text-muted)", marginLeft: 4 }}>{marginPctText(c.margin)}</span>
                                  </>}
                            </Tip>
                          </td>

                          <td style={{ textAlign: "center", verticalAlign: "middle", ...(over ? { color: "#dc2626", fontWeight: 700 } : {}) }}>
                            {c.overdueDays ?? "—"}
                            {isAncientDebt(c.overdueDays) && (
                              <Tip title="Старий рахунок" body="Рахунок старший за рік — це факт, а не збій розрахунку."
                                style={{ display: "block", fontSize: "var(--fs-xs)", fontWeight: 400, color: "var(--text-muted)" }}>🕰</Tip>
                            )}
                          </td>

                          <td style={{ color: limitState(c.limitDays) === "agreed" ? "var(--text-muted)" : "var(--warn)",
                                       textAlign: "center", verticalAlign: "middle", position: "relative",
                                       fontSize: limitState(c.limitDays) === "agreed" ? undefined : "var(--fs-xs)" }}>
                            <Tip body={limitHint(c.limitDays)}>{limitLabel(c.limitDays)}</Tip>
                            {canSetLimit && (
                              <button onClick={() => setLimitFor(limitFor === c.clientKey ? null : c.clientKey)}
                                title="Змінити узгоджену відстрочку" aria-label="Змінити узгоджену відстрочку"
                                style={pencilStyle}>✏️</button>
                            )}
                            {limitFor === c.clientKey && (
                              <LimitEditor client={c}
                                onClose={() => setLimitFor(null)}
                                onDone={() => { setLimitFor(null); onRefresh?.(); }} />
                            )}
                          </td>

                          {/* 🗓 «Обіцяна дата» і «Домовленість» — ОДНА колонка: це
                              одна думка, а займала два стовпці. Дата стоїть
                              підписом НАД полем. Поле показує лише запис
                              ПОТОЧНОГО тижня; історія не гине — вона під полем. */}
                          <td style={{ textAlign: "left", verticalAlign: "middle", minWidth: 210 }}>
                            <span style={{ display: "block", fontSize: "var(--fs-xs)", color: "var(--text-muted)" }}>
                              {c.dueDate ? `обіцяли ${formatDateSafe(c.dueDate)}` : "дати немає"}
                            </span>
                            {canEditReceivables ? (
                              <input type="date" value={c.dueDate ?? ""}
                                aria-label={`Обіцяна дата ${c.clientName}`}
                                onChange={(e) => patchReceivableNote(c.clientKey, { dueDate: e.target.value || null })}
                                onBlur={(e) => saveReceivableNote({ clientKey: c.clientKey, dueDate: e.target.value || null, comment: c.comment })}
                                style={{ ...inputStyle, marginBottom: 3 }} />
                            ) : null}
                            <CommentField
                              value={noteNow || null}
                              placeholder={NOTE_EMPTY_PLACEHOLDER}
                              editable={canEditReceivables}
                              onSave={(next) => { patchReceivableNote(c.clientKey, { comment: next }); saveReceivableNote({ clientKey: c.clientKey, comment: next, dueDate: c.dueDate }); }}
                            />
                            {(c.noteHistoryCount ?? 0) > 0 && (
                              <button onClick={() => setHistoryFor(c.clientKey)}
                                style={{ background: "none", border: "none", padding: 0, cursor: "pointer",
                                         font: "inherit", fontSize: "var(--fs-xs)", color: "var(--info, #1d4ed8)",
                                         textDecoration: "underline dotted" }}>
                                історія · {c.noteHistoryCount}
                              </button>
                            )}
                          </td>

                          {/* 🗑 КНОПКА З ПІДПИСОМ, А НЕ КОШИК (рішення власника):
                              кошик читається як «видалити назавжди», а дія
                              оборотна й із журналом. Зʼявляється при наведенні,
                              щоб не шуміти в 74 рядках. */}
                          <td style={{ textAlign: "right", verticalAlign: "middle", position: "relative", whiteSpace: "nowrap" }}>
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
                        {renderInvoices(c.clientKey, c.clientName, 11)}
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
