import { useEffect, useState, type Dispatch, type SetStateAction, Fragment } from "react";
import type { AuthPayload } from "../../../auth";
import {
  saveReceivableNote, saveReceivableInvoiceNote, fetchReceivableInvoices, triggerReceivablesSync,
  fetchManagerOptions, type ManagerOption,
  type ReceivableInvoice, type ReceivableManager, type ReceivableClient, type ReceivableTotals, type Team,
} from "../../../api";
import { ReceivablesTiles } from "./ReceivablesTiles";
import { ReceivablesFilters } from "./ReceivablesFilters";
import { OwnerEditor } from "./OwnerEditor";
import { LimitEditor } from "./LimitEditor";
import { MergeDialog } from "./MergeDialog";
import {
  CARRIER_LABEL, CARRIER_REASON_LABEL, carrierCell, EMPTY_FILTERS, ENTITY_LABEL, ENTITY_REASON_LABEL,
  entityBreakdown, isAncientDebt, isOverdue,
  limitHint, limitLabel, limitState, originBadges, ownerState, passesFilters, t,
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
        <span style={{ display: "block", fontSize: 11, color: "var(--text-muted)" }}>{why}</span>
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
        <span style={{ display: "block", fontSize: 11, color: "var(--text-muted)" }}>
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
        <span style={{ display: "block", fontSize: 11, color: "var(--text-muted)" }}>{mark.hint}</span>
      )}
    </span>
  );
}

/**
 * 🚚 СТАН ПЕРЕВІЗНИКА В РЯДКУ КЛІЄНТА.
 *
 * 🔴 «н/д» ТУТ — ЦЕ ВІДПОВІДЬ, А НЕ ПОРОЖНЄ МІСЦЕ, і воно НІКОЛИ не зливається
 * з «не оплачено». Заміряно на живому проді 24.08.2026: рахунки, виставлені
 * напряму в 1С, — 1 589 000 ₴; назви їх «не оплачено», і фінансист побачив би
 * 28% фальшивої неоплати зверху до справжніх 5 663 227 ₴.
 *
 * Причина «н/д» підписана завжди: виставлено через 1С · лінк не веде на угоду ·
 * воронка поза мапою етапів. Три різні діагнози — три різні дії різних людей.
 */
function CarrierCell({ facts }: { facts: ReceivableClient["facts"] }) {
  if (!facts) return <span style={{ color: "var(--text-muted)" }}>—</span>;
  const paid = t(facts.carrier.paid), unpaid = t(facts.carrier.unpaid), na = t(facts.carrier.na);
  const parts: React.ReactNode[] = [];
  if (paid.n) parts.push(<span key="p" style={{ color: "#16a34a" }} title={`${CARRIER_LABEL.paid} · ${formatAmount(paid.amount)}`}>✓ {paid.n}</span>);
  if (unpaid.n) parts.push(<span key="u" style={{ color: "#f59e0b" }} title={`${CARRIER_LABEL.unpaid} · ${formatAmount(unpaid.amount)}`}>◷ {unpaid.n}</span>);
  if (na.n) parts.push(<span key="n" style={{ color: "var(--text-muted)" }} title={`н/д · ${formatAmount(na.amount)}`}>н/д {na.n}</span>);
  return (
    <span>
      <span style={{ display: "flex", gap: 8, whiteSpace: "nowrap" }}>{parts.length ? parts : "—"}</span>
      {facts.carrierReasons.length > 0 && (
        <span style={{ display: "block", fontSize: 11, color: "var(--text-muted)" }}>
          {facts.carrierReasons.map((r) => CARRIER_REASON_LABEL[r]).join(" · ")}
        </span>
      )}
    </span>
  );
}

const inputStyle: React.CSSProperties = {
  font: "inherit", fontSize: 12, padding: "3px 6px", borderRadius: 6,
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
  const renderInvoices = (clientKey: string, colSpan: number) => {
    if (openKey !== clientKey) return null;
    const inv = invCache[clientKey];
    // Юрособи всередині клієнта. Кілька — означає, що клієнта ОБʼЄДНАЛИ, і це
    // треба сказати вголос: інакше на екрані один рядок там, де компанії дві.
    const entities = Array.isArray(inv)
      ? [...new Set(inv.map((x) => x.entityName).filter((n): n is string => !!n))]
      : [];
    const merged = entities.length > 1;
    return (
      <tr>
        <td colSpan={colSpan} style={{ background: "var(--bg-subtle, rgba(127,127,127,0.05))", padding: "10px 12px 14px 28px" }}>
          {inv === "loading" || inv === undefined ? (
            <span className="loading-text">Завантаження рахунків…</span>
          ) : inv.length === 0 ? (
            <span className="loading-text">Деталізації рахунків немає.</span>
          ) : (
            <>
              {/* 🧾 ШАПКА РОЗКРИТТЯ (Е4b): скільки рахунків, на скільки грошей і
                  який найстаріший. Без неї людина бачила перші пʼять рядків і не
                  знала, скільки їх усього — а їх буває сорок. */}
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 10, margin: "0 0 8px" }}>
                <b style={{ fontSize: 13 }}>Рахунки клієнта</b>
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  {inv.length} шт · {formatAmount(inv.reduce((a, x) => a + x.amount, 0))}
                  {(() => {
                    const ages = inv.map((x) => x.invoiceDate).filter((d): d is string => !!d);
                    if (!ages.length) return null;
                    const oldest = ages.reduce((m, d) => (d < m ? d : m), ages[0]);
                    const days = Math.floor((Date.now() - new Date(oldest).getTime()) / 86400000);
                    return ` · найстаріший ${days} дн.`;
                  })()}
                </span>
              </div>
              <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "0 0 6px" }}>
                📅 Постав <b>дедлайн оплати по рахунку</b> — якщо мине, а оплата не надійде, менеджеру автоматично створиться задача «отримати оплату».
                {" "}Це <i>інший</i> рівень, ніж «обіцяна дата» у рядку клієнта: там домовленість <b>з клієнтом</b> загалом, тут — строк по <b>конкретному рахунку</b>.
              </p>
              {merged && (
                /* 🔗 ОБʼЄДНАНИЙ КЛІЄНТ. Без цього рядка склейка читається як
                   зникнення другої компанії: на екрані один рядок, а юросіб дві.
                   Колонка «Юрособа» показується ЛИШЕ тут — у звичайного клієнта
                   вона повторювала б його ж назву в кожному рядку. */
                <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 8px" }}>
                  🔗 Обʼєднаний клієнт — усередині {entities.length} юрособи:{" "}
                  <b style={{ color: "var(--text)" }}>{entities.join(" · ")}</b>
                </p>
              )}
              <div className="recv-detail">
              <table className="data-table compact" style={{ fontSize: 12, minWidth: 680 }}>
                <thead>
                  <tr>
                    {merged && <th style={{ textAlign: "left" }} title="Юрособа КЛІЄНТА — видно лише в обʼєднаного">Клієнт</th>}
                    <th style={{ textAlign: "left" }}>Рахунок №</th>
                    <th>Дата</th>
                    {/* 🏢 НАША юрособа по КОЖНОМУ рахунку. Плитка обіцяє
                        «ЮТС 26 · Автомув 3 · невідомо 11», а всередині цього не
                        було видно — підсумок є, складу немає. */}
                    <th style={{ textAlign: "left" }} title="Наша юрособа, від якої виставлено рахунок">Наша юрособа</th>
                    {/* 🚚 «Перевізник» — стан по КОЖНОМУ рахунку, з тієї самої
                        плитки. Підпис навмисно не «оплачено?», бо колонка має
                        ТРИ стани, і третій — «не знаємо», а не «ні». */}
                    <th style={{ textAlign: "left" }} title="Чи оплачений перевізник за цим рахунком">Перевізник</th>
                    <th style={{ textAlign: "right", width: 96, whiteSpace: "nowrap" }}>Сума</th>
                    <th>📅 Дедлайн оплати</th>
                    <th style={{ textAlign: "left" }}>Коментар до рахунка</th>
                    <th>Угода</th>
                  </tr>
                </thead>
                <tbody>
                  {inv.map((x, i) => {
                    const overdue = x.dueDate != null && x.dueDate < today;
                    return (
                      <tr key={i}>
                        {merged && (
                          <td style={{ textAlign: "left", color: "var(--text-muted)", fontSize: 11.5 }}>
                            {x.entityName ?? "—"}
                          </td>
                        )}
                        <td style={{ textAlign: "left", fontWeight: 600 }}>{x.invoiceNo ?? "—"}</td>
                        <td>{x.invoiceDate ? new Date(x.invoiceDate).toLocaleDateString("uk-UA") : "—"}</td>
                        <td style={{ textAlign: "left", fontSize: 11.5 }}>
                          {x.ourEntity && x.ourEntity !== "unknown" ? (
                            <span style={{ color: "var(--text)" }}>{ENTITY_LABEL[x.ourEntity]}</span>
                          ) : (
                            /* 🔴 «НЕВІДОМО» З ПРИЧИНОЮ. Порожнє місце читається як
                               «нічого немає», а тут це три різні речі з трьома
                               різними діями: 1С-рахунок, битий лінк, не вказана
                               форма оплати. */
                            <span style={{ color: "var(--text-muted)" }}>
                              невідомо
                              {x.ourEntityReason && (
                                <span style={{ display: "block", fontSize: 10 }}>
                                  {ENTITY_REASON_LABEL[x.ourEntityReason]}
                                </span>
                              )}
                            </span>
                          )}
                        </td>
                        {/* 🔴 ТРИ СТАНИ, І ТРЕТІЙ НЕ ЗЛИВАЄТЬСЯ З ДРУГИМ.
                            «Угоди немає» ≠ «перевізник не оплачений»: у першому
                            випадку ми НЕ ЗНАЄМО. Заміряно 25.08.2026 — злиття
                            додало б 1 604 500 ₴ вигаданої неоплати. Тому «н/д»
                            малюється сірим і з причиною під ним. */}
                        <td style={{ textAlign: "left", fontSize: 11.5 }}>
                          {(() => {
                            const cc = carrierCell(x.carrierPaid, x.carrierReason);
                            const color = cc.tone === "paid" ? "#16a34a"
                              : cc.tone === "unpaid" ? "var(--text)" : "var(--text-muted)";
                            return (
                              <span style={{ color }}>
                                {cc.text}
                                {cc.why && <span style={{ display: "block", fontSize: 10 }}>{cc.why}</span>}
                              </span>
                            );
                          })()}
                        </td>
                        <td style={{ textAlign: "right", fontWeight: 600, width: 96, whiteSpace: "nowrap" }}
                          title={formatAmountFull(x.amount)}>{formatAmount(x.amount)}</td>
                        <td>
                          <input
                            type="date"
                            value={x.dueDate ?? ""}
                            onChange={(e) => patchInvoice(clientKey, x.invoiceNo ?? "", { dueDate: e.target.value || null })}
                            style={{ ...inputStyle, ...(overdue ? { borderColor: "#dc2626", color: "#dc2626", fontWeight: 700 } : {}) }}
                            title={overdue ? "Дедлайн минув — менеджеру створено задачу отримати оплату" : "Дедлайн оплати рахунку"}
                          />
                          {overdue && <span style={{ color: "#dc2626", fontSize: 10, display: "block" }}>прострочено</span>}
                        </td>
                        <td style={{ textAlign: "left", verticalAlign: "top", minWidth: 200 }}>
                          <CommentField
                            value={x.comment}
                            editable={canEditReceivables}
                            onSave={(next) => patchInvoice(clientKey, x.invoiceNo ?? "", { comment: next || null })}
                          />
                        </td>
                        {/* 🔗 ЛІНК ЛИШЕ ТАМ, ДЕ УГОДА Є. Мертва іконка в сорока
                            рядках поспіль обіцяє перехід, якого не буде — і це
                            гірше за чесний підпис. 1С-рахунок угоди не має в
                            принципі, а не «десь загубив». */}
                        <td style={{ whiteSpace: "nowrap" }}>
                          {x.serviceUrl && x.dealFound ? (
                            <a href={x.serviceUrl} target="_blank" rel="noreferrer" title="Відкрити угоду в Kommo">🔗 угода</a>
                          ) : (
                            <span style={{ color: "var(--text-muted)", fontSize: 10.5 }}
                              title={x.dealId == null ? "рахунок виставлено через 1С — угоди в Kommo немає"
                                                      : "лінк веде на угоду, якої немає в базі"}>
                              {x.dealId == null ? "угоди немає" : "лінк битий"}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {/* 🔴 ПІДСУМКОВИЙ РЯДОК РАХУЄ КОЛОНКИ, А НЕ «ПРИБЛИЗНО».
                      Був зсув: у ОБʼЄДНАНОГО клієнта шапка мала на одну колонку
                      більше за підсумок, тож «Разом» опинялось під сусідньою
                      колонкою. Тепер `merged` додає клітинку і сюди. */}
                  <tr>
                    {merged && <td />}
                    <td style={{ fontWeight: 700, textAlign: "left" }}>Разом: {inv.length} рах.</td>
                    <td />
                    <td />
                    {/* 🚚 ПІДСУМОК ПО ПЕРЕВІЗНИКУ — КІЛЬКІСТЮ, А НЕ ₴, І ЦЕ
                        СВІДОМО. Скільки саме заплачено перевізнику, ми НЕ
                        ЗНАЄМО: суми лежать у полях Kommo, яких ми не синкаємо
                        (перевірено 25.08.2026 — у `deals` 34 колонки і жодної
                        про перевізника). Підписати сумою рахунків «заплачено
                        перевізникам N ₴» означало б назвати БОРГ КЛІЄНТА нашою
                        виплатою — дві різні величини під одним підписом. */}
                    <td style={{ textAlign: "left", fontSize: 11, color: "var(--text-muted)" }}>
                      оплачених: {inv.filter((x) => x.carrierPaid === "paid").length} з {inv.length}
                    </td>
                    <td style={{ textAlign: "right", fontWeight: 700 }}>{formatAmount(inv.reduce((s, x) => s + x.amount, 0))}</td>
                    <td colSpan={3} />
                  </tr>
                </tbody>
              </table>
              </div>
            </>
          )}
        </td>
      </tr>
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
              style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", cursor: syncing ? "default" : "pointer", fontWeight: 600, fontSize: 13 }}>
              {syncing ? "Оновлення…" : "🔄 Оновити з 1С"}
            </button>
          )}
          {receivablesSyncedAt && (
            <span className="loading-text" style={{ fontSize: 12 }}>
              Оновлено: {new Date(receivablesSyncedAt).toLocaleString("uk-UA")}
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
            <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 10px" }}>
              Клік по клієнту — неоплачені рахунки з дедлайном і коментарем до кожного. Червоні дні — прострочка понад ліміт.
            </p>
            <ReceivablesFilters filters={filters} setFilters={setFilters} shown={shown.length} totalRows={all.length} />
            {/* Кнопки НЕМАЄ ВЗАГАЛІ без права — не «є, але дає 403». Право рахує
                сервер тим самим виразом, що гейтить роут. */}
            {canMerge && (
              <button onClick={() => setMergeOpen(true)}
                title="Дві юрособи виявились одним клієнтом — обʼєднати в один рядок"
                style={{ font: "inherit", fontSize: 12.5, fontWeight: 600, padding: "5px 12px",
                         borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)",
                         color: "var(--text)", cursor: "pointer", marginBottom: 12 }}>
                🔗 Обʼєднати клієнтів
              </button>
            )}
            <div style={{ overflowX: "auto" }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ textAlign: "center", width: 36 }}>#</th>
                    <th style={{ textAlign: "left" }}>Клієнт</th>
                    <th style={{ textAlign: "left" }}>Відповідальний</th>
                    <th style={{ textAlign: "left" }} title="Наша юрособа, від якої виставлено рахунок — з «форми оплати» Kommo">Юрособа</th>
                    <th style={{ textAlign: "left" }} title="Чи оплачено перевізника по угоді рахунку. «н/д» = не знаємо, а НЕ «не оплачено»">Перевізник</th>
                    <th style={{ textAlign: "right", whiteSpace: "nowrap" }}>Сума боргу</th>
                    <th style={{ textAlign: "center" }}>Днів без оплати</th>
                    <th style={{ textAlign: "center" }}>Ліміт</th>
                    {/* 🔴 ДВА РІВНІ ПОЛІВ РОЗВЕДЕНО ПІДПИСАМИ (Е4b).
                        Тут — домовленість із КЛІЄНТОМ загалом; у розкритті —
                        дедлайн і коментар по КОНКРЕТНОМУ рахунку. Раніше обидві
                        пари звались однаково («дата оплати» / «коментар»), і
                        людина не бачила, що це різні речі з різними наслідками:
                        від дедлайну по рахунку створюється задача менеджеру. */}
                    <th style={{ textAlign: "center" }} title="Коли клієнт пообіцяв заплатити — домовленість із ним загалом">
                      Обіцяна дата
                    </th>
                    <th style={{ textAlign: "left" }} title="Домовленість із клієнтом. Строк по конкретному рахунку — у розкритті">
                      Домовленість з клієнтом
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((c, i) => {
                    const over = isOverdue(c);
                    const badges = originBadges(c.facts);
                    const ent = entityBreakdown(c.facts);
                    return (
                      <Fragment key={`${c.clientKey}-${i}`}>
                        {/* 🖱 КЛІКАБЕЛЬНИЙ УВЕСЬ РЯДОК (Е4b).
                            Раніше реагувала вузька смужка на самій назві: людина
                            тиснула в рядок і думала, що зламано. Тепер рядок —
                            повноцінний контрол: курсор-палець, підсвітка, стрілка
                            повертається, Enter/Space працюють із клавіатури.

                            🔴 КЛІК ПО ПОЛЮ ВСЕРЕДИНІ НЕ РОЗГОРТАЄ. У рядку живуть
                            input дати, textarea коментаря і кнопки «змінити» —
                            без цієї умови кожен дотик до них згортав би клієнта
                            просто в момент редагування. `closest` бере САМЕ той
                            елемент, у який влучив користувач, а не той, на якому
                            висить обробник. */}
                        <tr role="button" tabIndex={0} aria-expanded={openKey === c.clientKey}
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
                          className="recv-row"
                          style={{ cursor: "pointer", ...(over ? { background: "rgba(220,38,38,0.04)" } : {}) }}>
                          <td style={{ color: "var(--text-muted)", textAlign: "center", verticalAlign: "top" }}>{i + 1}</td>
                          <td style={{ textAlign: "left", verticalAlign: "top" }}>
                            <span style={{ fontWeight: 600, color: "var(--text)" }}>
                              {caret(c.clientKey)}{c.clientName}
                            </span>
                            {/* 🔴 ЯРЛИК ІЗ ЧИСЛОМ, бо клієнт БУВАЄ ЗМІШАНИЙ: у ПВК
                                АРСЕНАЛ 11 рахунків із 40 виставлені через 1С, решта
                                29 — звичайні угоди Kommo. Ярлик без числа стверджував
                                би, що весь клієнт такий, — неправда рівно про той
                                випадок, заради якого категорію й заводили. */}
                            {badges.map((b) => (
                              <span key={b.icon} title={b.hint}
                                style={{ display: "block", fontSize: 11, marginTop: 2,
                                         color: b.tone === "warn" ? "var(--warn)" : "var(--text-muted)" }}>
                                {b.icon} {b.text}
                              </span>
                            ))}
                          </td>
                          <td style={{ textAlign: "left", color: "var(--text-muted)", fontSize: 12, verticalAlign: "top", position: "relative" }}>
                            <OwnerCell c={c} />
                            {/* 🔴 ГОТІВКОВИЙ РЯДОК КОНТРОЛА НЕ ДІСТАЄ, і це не забудькуватість.
                                `PUT /receivables/owner` віддає 404 на `source='cash'`: ці рядки CRM
                                перебудовує щосинку, тож ручне призначення відкотилось би саме.
                                Пропонувати дію, яка ГАРАНТОВАНО впаде, гірше, ніж її не мати. */}
                            {canSetOwner && (c.ownerSource === "cash-invoice" ? (
                              <span style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", marginTop: 2 }}>
                                ✏️ змінюється в CRM, не тут
                              </span>
                            ) : (
                              <button onClick={() => setOwnerFor(ownerFor === c.clientKey ? null : c.clientKey)}
                                title="Змінити відповідального за борг"
                                style={{ display: "block", border: "none", background: "none", cursor: "pointer",
                                         padding: 0, marginTop: 3, fontSize: 11.5, color: "var(--text-muted)",
                                         textDecoration: "underline dotted" }}>
                                ✏️ змінити
                              </button>
                            ))}
                            {ownerFor === c.clientKey && (
                              <OwnerEditor client={c} managers={mgrOptions}
                                onClose={() => setOwnerFor(null)}
                                // 🔴 ПЕРЕЧИТУЄМО, а не малюємо своє: сервер після запису
                                // робить `recomputeOwners`, тож правильний відповідальний
                                // відомий лише з наступної відповіді (`#166`).
                                onDone={() => { setOwnerFor(null); onRefresh?.(); }} />
                            )}
                          </td>
                          <td style={{ textAlign: "left", verticalAlign: "top", fontSize: 12 }}>
                            {ent ? (
                              <span title={ent.hint} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                {ent.rows.map((r) => (
                                  <span key={r.key} style={{ color: r.key === "unknown" ? "var(--text-muted)" : "var(--text)" }}>
                                    {r.label} {r.n}
                                  </span>
                                ))}
                              </span>
                            ) : <span style={{ color: "var(--text-muted)" }}>—</span>}
                          </td>
                          <td style={{ textAlign: "left", verticalAlign: "top", fontSize: 12 }}>
                            <CarrierCell facts={c.facts} />
                          </td>
                          <td style={{ textAlign: "right", fontWeight: 700, verticalAlign: "top", whiteSpace: "nowrap" }} title={formatAmountFull(c.amount)}>{formatAmount(c.amount)}</td>
                          <td style={{ textAlign: "center", verticalAlign: "top", ...(over ? { color: "#dc2626", fontWeight: 700 } : {}) }}>
                            {c.overdueDays ?? "—"}
                            {isAncientDebt(c.overdueDays) && (
                              <span title="рахунок старший за рік — це факт, а не збій розрахунку"
                                    style={{ display: "block", fontSize: 10, fontWeight: 400, color: "var(--text-muted)" }}>
                                🕰 старий рахунок
                              </span>
                            )}
                          </td>
                          <td title={limitHint(c.limitDays)}
                              style={{ color: limitState(c.limitDays) === "agreed" ? "var(--text-muted)" : "var(--warn)",
                                       textAlign: "center", verticalAlign: "top", position: "relative",
                                       fontSize: limitState(c.limitDays) === "agreed" ? undefined : 11 }}>
                            {limitLabel(c.limitDays)}
                            {canSetLimit && (
                              <button onClick={() => setLimitFor(limitFor === c.clientKey ? null : c.clientKey)}
                                title="Змінити узгоджену відстрочку"
                                style={{ display: "block", border: "none", background: "none", cursor: "pointer",
                                         padding: 0, marginTop: 3, fontSize: 11, color: "var(--text-muted)",
                                         textDecoration: "underline dotted", width: "100%" }}>
                                ✏️ змінити
                              </button>
                            )}
                            {limitFor === c.clientKey && (
                              <LimitEditor client={c}
                                onClose={() => setLimitFor(null)}
                                // Перечитуємо: ліміт міняє не лише клітинку, а й прострочку
                                // рядка, плитку і фільтр «Прострочені» — усе з одного виразу.
                                onDone={() => { setLimitFor(null); onRefresh?.(); }} />
                            )}
                          </td>
                          <td style={{ textAlign: "center", verticalAlign: "top" }}>
                            {canEditReceivables ? (
                              <input
                                type="date"
                                value={c.dueDate ?? ""}
                                onChange={(e) => patchReceivableNote(c.clientKey, { dueDate: e.target.value || null })}
                                onBlur={(e) => saveReceivableNote({ clientKey: c.clientKey, dueDate: e.target.value || null, comment: c.comment })}
                                style={inputStyle}
                              />
                            ) : (
                              c.dueDate ? new Date(c.dueDate).toLocaleDateString("uk-UA") : "—"
                            )}
                          </td>
                          <td style={{ textAlign: "left", verticalAlign: "top", minWidth: 220 }}>
                            <CommentField
                              value={c.comment}
                              editable={canEditReceivables}
                              onSave={(next) => { patchReceivableNote(c.clientKey, { comment: next }); saveReceivableNote({ clientKey: c.clientKey, comment: next, dueDate: c.dueDate }); }}
                            />
                          </td>
                        </tr>
                        {renderInvoices(c.clientKey, 10)}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {/* 🔴 ПІДСУМОК ВИДИМИХ РЯДКІВ — ОКРЕМО від плитки «Загальний борг» і
                підписаний як видимий. Якби плитка їздила за фільтром, «загальний
                борг» означав би різне залежно від щойно натиснутого, а якби цього
                рядка не було — сума на екрані не сходилась би з плиткою, і це
                читалось би як поломка. */}
            {shown.length !== all.length && (
              <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "10px 0 0" }}>
                Видимих рядків: <b style={{ color: "var(--text)" }}>{shown.length}</b> із {all.length} ·
                сума видимих <b style={{ color: "var(--text)" }} title={formatAmountFull(shownSum)}>{formatAmount(shownSum)}</b> із {formatAmount(total)}.
                Плитки вгорі показують УСЮ дебіторку у скоупі й за фільтром не змінюються.
              </p>
            )}
            {shown.length === 0 && (
              <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "12px 0 0" }}>
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
