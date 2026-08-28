import { useEffect, useState } from "react";
import { fetchInvoiceRegistry, type ReceivableInvoice } from "../../../api";
import { formatAmount, formatAmountFull } from "../format";
import { invoiceStamp, nPlural, seenCell } from "../receivablesView";
import { Hint, Tip } from "../../../components/Hint";

/**
 * 📋 РЕЄСТР РАХУНКІВ — ТРЕТЯ ВКЛАДКА ДЕБІТОРКИ (макет власника, 27.08.2026).
 *
 * Плаский список УСІХ живих рахунків у скоупі — те, чим власник два роки
 * користувався в аркуші «выгрузка»: один рядок = один рахунок, без групування
 * по клієнту.
 *
 * 🔴 ДЖЕРЕЛО — ТОЙ САМИЙ РОУТ, ЩО Й РОЗКРИТТЯ КЛІЄНТА, просто без `clientKey`.
 * Окремий роут означав би другий предикат «живий рахунок», другий скоуп і
 * другий набір полів; саме така конструкція 27.08.2026 дала «рядок клієнта
 * 2 323 000 ₴ проти розкриття 691 000 ₴». Тут одне джерело, і розійтись їм
 * нема як — це стереже `#199ce`.
 *
 * 🔴 СКОУП — ПО КЛІЄНТУ, НЕ ПО РАХУНКУ (рішення власника). Менеджер бачить
 * рахунки СВОЇХ клієнтів, усі, незалежно від того, хто їх виставив. Колонка
 * «Менеджер» — інформаційна: вона каже, хто виставив, і саме тому зветься
 * нейтрально. «Виставив» було б технічно правдивим підписом, але після того,
 * як 15 рахунків не мають автора взагалі, він читався б як твердження про
 * авторство там, де автора немає.
 */
export function ReceivablesRegistry() {
  const [rows, setRows] = useState<ReceivableInvoice[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchInvoiceRegistry()
      .then((d) => { if (alive) setRows(d.invoices); })
      .catch((e: unknown) => {
        const r = (e as { response?: { data?: { error?: string } } }).response;
        if (alive) setErr(r?.data?.error ?? "Не вдалось завантажити реєстр");
      });
    return () => { alive = false; };
  }, []);

  if (err) return <p className="loading-text" style={{ color: "var(--danger)" }}>🔴 {err}</p>;
  if (!rows) return <p className="loading-text">Завантаження реєстру…</p>;

  const total = rows.reduce((s, x) => s + Number(x.amount), 0);
  const noMgr = rows.filter((x) => !x.managerName).length;
  const noTime = rows.filter((x) => !x.invoiceTime).length;

  return (
    <div className="chart-card">
      <h3 style={{ margin: "0 0 4px", fontSize: "var(--fs-lg)" }}>
        Реєстр рахунків ({rows.length})
      </h3>
      <p style={{ fontSize: "var(--fs-13)", color: "var(--text-muted)", margin: "0 0 12px" }}>
        Кожен неоплачений рахунок окремим рядком — так само, як у вивантаженні 1С.
        Разом <b title={formatAmountFull(total)}>{formatAmount(total)}</b>.
      </p>

      <div style={{ overflowX: "auto" }}>
        <table className="data-table recv-table">
          <thead>
            <tr>
              <th style={{ textAlign: "left", width: 240 }}>Контрагент</th>
              <th style={{ textAlign: "left", width: 190 }}>
                Рахунок
                <Hint title="Номер, дата і час виставлення"
                  body="Час приходить із 1С. «часу не записано» означає саме це — у 1С він порожній; це НЕ опівночі." />
              </th>
              <th style={{ textAlign: "left", width: 120 }}>ЄДРПОУ</th>
              <th style={{ textAlign: "left", width: 150 }}>
                Менеджер
                <Hint title="Хто виставив ЦЕЙ рахунок"
                  body="Не обовʼязково той, хто веде клієнта. Рахунок, виставлений напряму в 1С повз CRM, автора не має — так і написано." />
              </th>
              <th style={{ textAlign: "left" }}>Коментар</th>
              <th style={{ textAlign: "center", width: 90 }}>Угода</th>
              {/* 💰 Виписка приходить РАНІШЕ, ніж бухгалтерія рознесе рахунки.
                  Колонка каже, чи гроші вже видно — і НІКОЛИ не буває порожньою:
                  «не зіставлено» це відповідь, порожня клітинка — ні. */}
              <th style={{ textAlign: "left", width: 170 }}>Гроші</th>
              <th className="recv-num" style={{ textAlign: "right", width: 130 }}>Сума</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((x, i) => {
              const st = invoiceStamp(x.invoiceDate, x.invoiceTime);
              return (
                <tr key={`${x.clientKey}-${x.invoiceNo ?? ""}-${i}`}>
                  <td style={{ textAlign: "left" }} title={x.clientName ?? ""}>
                    <span className="recv-cname">{x.clientName ?? "—"}</span>
                  </td>
                  <td style={{ textAlign: "left" }}>
                    <span className="recv-num" style={{ fontWeight: 600 }}>{x.invoiceNo || "без номера"}</span>
                    <span style={{ display: "block", fontSize: "var(--fs-xs)", color: "var(--text-muted)" }}>
                      <span className="recv-num">{st.date}</span>
                      {" · "}
                      {/* 🕐 БРАК ЧАСУ — СЛОВАМИ. «00:00» стверджувало б мить доби,
                          якої ми не знаємо: у 1С це заглушка, а не час. */}
                      {st.time
                        ? <span className="recv-num">{st.time}</span>
                        : <i>часу не записано</i>}
                    </span>
                  </td>
                  <td className="recv-num" style={{ textAlign: "left", fontSize: "var(--fs-sm)" }}>
                    {x.edrpou || <span style={{ color: "var(--text-muted)" }}>—</span>}
                  </td>
                  <td style={{ textAlign: "left", fontSize: "var(--fs-sm)", color: "var(--text-muted)" }}>
                    {x.managerName ?? <i>без менеджера</i>}
                  </td>
                  <td style={{ textAlign: "left", fontSize: "var(--fs-sm)", color: "var(--text-muted)" }}
                      title={x.note ?? ""}>
                    <span style={{ display: "block", maxWidth: 320, overflow: "hidden",
                                   textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {x.note || "—"}
                    </span>
                  </td>
                  {/* 🔗 «УГОДА» — три стани, ті самі, що в розкритті клієнта.
                      У фіді 1С посилання НЕМАЄ ЖОДНОГО (перевірено: нуль полів
                      із serv/link/url), а те, що стояло в оригінальному аркуші,
                      вело на JSON-дамп. Тому лінк — на угоду в Kommo, і лише
                      там, де угода справді знайшлась. */}
                  <td style={{ textAlign: "center", fontSize: "var(--fs-sm)" }}>
                    {x.serviceUrl && x.dealFound ? (
                      <a href={x.serviceUrl} target="_blank" rel="noreferrer"
                        title={`Відкрити угоду ${x.dealId} в CRM`}
                        style={{ textDecoration: "none" }}>🔗</a>
                    ) : x.dealId == null ? (
                      <Tip title="Угоди немає" style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)" }}
                        body="Рахунок виставлено напряму в 1С, повз CRM — угоди не існує за задумом, це не втрачений лінк.">
                        немає
                      </Tip>
                    ) : (
                      <Tip title="Лінк битий" style={{ color: "var(--warn)", fontSize: "var(--fs-xs)" }}
                        body="№ угоди в рахунку є, а самої угоди в базі немає: одруківка в 1С або угоду видалили в Kommo. Це ІНШИЙ діагноз, ніж «угоди немає».">
                        битий
                      </Tip>
                    )}
                  </td>
                  {/* 💰 ЧОТИРИ СТАНИ, І ЖОДЕН НЕ ПОРОЖНІЙ. Підпис бере ядро
                      (`seenCell`) — фронт своєї думки про зіставлення не має. */}
                  <td style={{ textAlign: "left", fontSize: "var(--fs-sm)" }}>
                    {(() => { const c = seenCell(x.paymentSeen); return (
                      <Tip title="Гроші за рахунком" body={c.why ?? ""}
                        style={{ color: c.tone === "ok" ? "var(--ok, #16a34a)"
                                      : c.tone === "warn" ? "var(--warn)" : "var(--text-muted)",
                                 whiteSpace: "nowrap" }}>
                        {c.text}
                      </Tip>); })()}
                  </td>
                  <td className="recv-num" style={{ textAlign: "right", fontWeight: 600, whiteSpace: "nowrap" }}
                      title={formatAmountFull(x.amount)}>
                    {formatAmount(x.amount)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 🔴 ПРОГАЛИНИ — ЧИСЛОМ У ПІДПИСІ, А НЕ ПОЗНАЧКОЮ В КОЖНОМУ РЯДКУ.
          Коли невідомих багато, підпис у рядку перетворюється на шпалери, які
          перестають читати (рішення власника 05.08.2026). Тут — одним рядком
          під таблицею, і лише коли число ≠ 0. */}
      <p style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)", margin: "10px 2px 0", lineHeight: 1.5 }}>
        {noMgr > 0 && (
          <>Без менеджера — {nPlural(noMgr, "рахунок", "рахунки", "рахунків")}: виставлені напряму
            в 1С, повз CRM, тож автора в них немає. </>
        )}
        {noTime > 0 && (
          <>Без часу — {nPlural(noTime, "рахунок", "рахунки", "рахунків")}: у 1С час не записаний
            (це не «опівночі»).</>
        )}
      </p>
    </div>
  );
}
