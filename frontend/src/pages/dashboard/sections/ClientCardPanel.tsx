import { useCallback, useEffect, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, Cell } from "recharts";
import { fetchClientCard, archiveClient, saveLoyaltyOverride, type ClientCard } from "../../../api";
import { MergePanel, ManagerPanel } from "./ClientAdminPanels";
import { formatAmountFull } from "../format";

/**
 * 💳 КАРТКА КЛІЄНТА — «як він платив».
 *
 * 🔴 ГІСТОГРАМУ РАХУЄ ЯДРО (`successByClientBucket` по канонічному ключу) — та сама
 * функція, що дає факт менеджера у Звіті. Тому стовпчик «липень» тут і рядок
 * «липень» там — одна цифра, а не дві схожі.
 *
 * ⚠️ ДВА РІЗНІ ЯКОРІ, І ЦЕ ПІДПИСАНО. Стовпчики — гроші ① (анкер = дата входу в
 * «успішно реалізовано»). Список унизу — журнал угод (дата закриття, для
 * незакритих — створення) і показує ВСІ стадії, не лише виграні. Тому Σ списку не
 * дорівнює Σ стовпчиків, і зводити їх не треба.
 */
export function ClientCardPanel({ clientKey, onChanged }: { clientKey: string; onChanged?: () => void }) {
  const [openYear, setOpenYear] = useState<number | null>(null);
  const [card, setCard] = useState<ClientCard | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const [forceNote, setForceNote] = useState("");
  const load = useCallback(() => {
    setCard(null); setErr(null);
    fetchClientCard(clientKey).then(setCard)
      .catch((e) => setErr((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? "не вдалося завантажити картку"));
  }, [clientKey]);
  useEffect(load, [load]);

  if (err) return <div style={{ fontSize: 12, color: "#b91c1c" }}>{err}</div>;
  if (!card) return <div style={{ fontSize: 12, color: "#9ca3af" }}>завантаження картки…</div>;

  const data = card.months.map((m) => ({
    label: m.month.slice(2).split("-").reverse().join("."),   // 07.26
    revenue: m.revenue, deals: m.deals, month: m.month,
  }));
  const maxIdx = data.reduce((best, r, i) => (r.revenue > data[best].revenue ? i : best), 0);
  const empty = card.monthsTotal === 0;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 13 }}>📊 Надходження за 12 міс. · «успішно реалізовано» ①</div>
        <div style={{ fontSize: 11, color: "#6b7280" }}>
          за 12 міс: <b style={{ color: "#111827" }}>{formatAmountFull(card.monthsTotal)}</b>
          {" · "}lifetime: {formatAmountFull(card.lifetimeRevenue)} / {card.orders} опл
          {card.firstPaid ? ` · з ${card.firstPaid.slice(0, 7)}` : ""}
        </div>
      </div>

      {/* 🛠 ДІЇ КЕРУВАННЯ КЛІЄНТОМ — САМЕ ТУТ, поруч із гістограмою й угодами,
          бо це і є підстава для рішення (рішення власника 04.08.2026, підтверджене
          05.08.2026 після того, як дії з екрана зникли, а в картці не зʼявились).

          🔴 ЩО ТУТ БУЛО ДО ЦЬОГО. Кнопка «прибрати з постійних», яка слала
          `{clientKey, hidden}`. Хвиля 2 перестала писати `hidden` — кнопка
          лишилась і **мовчки нічого не робила**: 200 у відповідь, нуль змін,
          `hidden` завжди false (роут його навіть не віддавав). Це другий випадок
          того самого класу за тиждень, тому тепер його ловить гейт, а не увага.

          🔴 ПРАВА ВІДДАЄ СЕРВЕР (`canArchive`/`canMerge`/`canAssign`) тими самими
          функціями, що гейтять роути: кнопка не може розійтись із дозволом. */}
      {(card.canArchive || card.canMerge || card.canAssign) && (
        <div style={{ marginTop: 10, border: "1px solid #e5e7eb", borderRadius: 10, padding: "10px 12px", background: "#fafafa" }}>
          <div style={{ fontSize: 11, letterSpacing: .4, textTransform: "uppercase", color: "#6b7280", marginBottom: 8 }}>
            Керування клієнтом
          </div>

          {card.canArchive && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              {card.archived ? (
                <>
                  <button disabled={busy} style={BTN("#166534")}
                    onClick={async () => {
                      if (!confirm(`Повернути «${card.clientName}» з архіву?`)) return;
                      setBusy(true);
                      try { await archiveClient({ clientKey, restore: true }); load(); onChanged?.(); }
                      finally { setBusy(false); }
                    }}>↩ повернути з архіву</button>
                  <span style={{ fontSize: 11, color: "#6b7280" }}>
                    Зараз в архіві{card.archiveReason ? ` · причина: ${card.archiveReasons.find((r) => r.key === card.archiveReason)?.label ?? card.archiveReason}` : ""}.
                    Повернеться <b>сам</b>, щойно зʼявиться оплата пізніша за дату архівації.
                  </span>
                </>
              ) : (
                <>
                  <select value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy}
                    style={{ fontSize: 12, padding: "5px 8px", border: "1px solid #d1d5db", borderRadius: 8 }}>
                    <option value="">причина архівації…</option>
                    {card.archiveReasons.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                  </select>
                  <button disabled={busy || !reason} style={BTN("#b91c1c")}
                    onClick={async () => {
                      if (!confirm(`Прибрати «${card.clientName}» в архів?\n\nКлієнт зникне з планування й реактивації. Дія зворотна.`)) return;
                      setBusy(true);
                      try { await archiveClient({ clientKey, reason }); setReason(""); load(); onChanged?.(); }
                      finally { setBusy(false); }
                    }}>🗄 в архів</button>
                  <span style={{ fontSize: 11, color: "#6b7280" }}>
                    Прибирає з планування й реактивації. Причина обовʼязкова — інакше через місяць
                    ніхто не згадає, чому клієнта немає. Угоди та гроші не змінюються.
                  </span>
                </>
              )}
            </div>
          )}

          {/* ⭐ «ВВАЖАТИ ПОСТІЙНИМ ПОПРИ ПРАВИЛО» (рішення власника 05.08.2026).
              Після двошляхової кваліфікації 342 клієнти стали разовими АВТОМАТИЧНО —
              правило без винятків жорсткіше за реальність, і КВП має могти сказати
              «цей постійний, я знаю чому».
              🔴 ПРИМІТКА ОБОВʼЯЗКОВА, і стереже її БД (`CHECK`), а не ця форма:
              валідацію в UI обходить будь-який скрипт, а прапорець без пояснення
              через місяць нічим не відрізняється від помилки. */}
          {card.canForceRegular && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
              {card.forcedRegular ? (
                <>
                  <button disabled={busy} style={BTN("#6b7280")}
                    onClick={async () => {
                      if (!confirm(`Скинути ручну правку для «${card.clientName}»?\n\nКлієнт повернеться під загальне правило кваліфікації.`)) return;
                      setBusy(true);
                      try { await saveLoyaltyOverride({ clientKey, forceRegular: false }); load(); onChanged?.(); }
                      finally { setBusy(false); }
                    }}>↩ скинути ручну правку</button>
                  <span style={{ fontSize: 11, color: "#6b7280" }}>
                    ⭐ <b>Включений вручну</b> попри правило{card.forceNote ? <> · «{card.forceNote}»</> : null}.
                    Скидання поверне його під загальне правило кваліфікації.
                  </span>
                </>
              ) : (
                <>
                  <input value={forceNote} onChange={(e) => setForceNote(e.target.value)} disabled={busy}
                    placeholder="чому цей клієнт постійний (обовʼязково)…"
                    style={{ fontSize: 12, padding: "5px 9px", border: "1px solid #d1d5db", borderRadius: 8, minWidth: 280 }} />
                  <button disabled={busy || !forceNote.trim()} style={BTN("#b45309")}
                    onClick={async () => {
                      setBusy(true);
                      try { await saveLoyaltyOverride({ clientKey, forceRegular: true, note: forceNote.trim() }); setForceNote(""); load(); onChanged?.(); }
                      finally { setBusy(false); }
                    }}>⭐ вважати постійним</button>
                  <span style={{ fontSize: 11, color: "#6b7280" }}>
                    Клієнт потрапить у планування й реактивацію, навіть якщо не проходить
                    кваліфікацію. Примітка обовʼязкова — вона буде видна в списках.
                  </span>
                </>
              )}
            </div>
          )}

          {(card.canMerge || card.canAssign) && (
            <details style={{ marginTop: 10 }}>
              <summary style={{ cursor: "pointer", fontSize: 12, fontWeight: 600, color: "#374151" }}>
                🔗 Обʼєднання · роз'єднання · передача відповідального
              </summary>
              <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 10 }}>
                {card.canMerge && <MergePanel onDone={() => { load(); onChanged?.(); }} teamOnly={card.mergeScope === "team"} />}
                {card.canAssign && <ManagerPanel clients={[]} onDone={() => { load(); onChanged?.(); }} />}
              </div>
            </details>
          )}
        </div>
      )}

      {empty ? (
        // Порожньо — це відповідь, а не помилка: клієнт не платив 12 міс.
        <div style={{ marginTop: 8, background: "#f8fafc", border: "1px dashed #cbd5e1", borderRadius: 8,
                      padding: "12px 14px", fontSize: 12, color: "#64748b" }}>
          За останні 12 місяців оплат ①  немає. Остання оплата: {card.lastPaid ?? "—"}.
        </div>
      ) : (
        <div style={{ height: 190, marginTop: 8 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `${Math.round(Number(v) / 1000)}k`} width={44} />
              <Tooltip
                formatter={(v, _n, p) => [`${formatAmountFull(Number(v))} · ${(p?.payload as { deals: number })?.deals ?? 0} угод`, "Успішно реалізовано"]}
                labelFormatter={(l) => `Місяць ${l}`} />
              <Bar dataKey="revenue" radius={[4, 4, 0, 0]}>
                {data.map((r, i) => (
                  // Найбільший місяць виділено, останній — акцентом: це форма, не шкала.
                  <Cell key={r.month} fill={i === data.length - 1 ? "#c5141c" : i === maxIdx ? "#2563eb" : "#93c5fd"} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {card.callsByYear && card.callsByYear.length > 0 && (
        <>
          <div style={{ fontWeight: 700, fontSize: 13, margin: "12px 0 6px" }}>📞 Дзвінки по роках</div>
          {card.callsByYear.map((y) => (
            <div key={y.year} style={{ borderBottom: "1px solid #f1f5f9" }}>
              <button onClick={() => setOpenYear(openYear === y.year ? null : y.year)}
                style={{ display: "flex", gap: 10, alignItems: "center", width: "100%", textAlign: "left",
                         background: "none", border: "none", cursor: "pointer", padding: "7px 2px", fontSize: 12 }}>
                <span style={{ color: "#6b7280" }}>{openYear === y.year ? "▾" : "▸"}</span>
                <b style={{ minWidth: 42 }}>{y.year}</b>
                <span>розмов <b>{y.talks}</b> із {y.calls}</span>
                <span style={{ color: "#6b7280" }}>· {Math.round(y.totalSec / 60)} хв</span>
                {y.lastAt && <span style={{ color: "#6b7280" }}>· останній {y.lastAt.slice(0, 10)}</span>}
              </button>
              {openYear === y.year && card.calls && (
                <div style={{ maxHeight: 190, overflowY: "auto", margin: "0 0 8px 22px" }}>
                  {card.calls.filter((c) => new Date(c.at).getFullYear() === y.year).map((c, i) => (
                    <div key={i} style={{ fontSize: 12, padding: "3px 0", color: c.answered ? "#111827" : "#9ca3af" }}>
                      {c.at.slice(0, 16).replace("T", " ")} · {c.direction === "out" ? "вих" : "вх"}
                      {c.answered ? ` · ${c.billsec} с` : " · не додзвонились"}
                      {c.manager && ` · ${c.manager}`}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
          {/* 🔴 Обрізання й глибина памʼяті НАЗВАНІ. Порожній рік без цього підпису
              читався б як «клієнт не дзвонив», хоча даних просто не існує. */}
          <div style={{ fontSize: 11, color: "#9ca3af", margin: "6px 0 2px" }}>
            {card.callsShown === card.callsLimit && `показано останні ${card.callsLimit} · `}
            {card.callsSince ? `історія дзвінків у системі — з ${card.callsSince}` : ""}
          </div>
        </>
      )}

      <div style={{ fontWeight: 700, fontSize: 13, margin: "12px 0 6px" }}>🧾 Успішні угоди</div>
      {card.deals.length === 0 ? (
        <div style={{ fontSize: 12, color: "#9ca3af" }}>угод немає</div>
      ) : (
        <div style={{ maxHeight: 210, overflowY: "auto", border: "1px solid #f1f5f9", borderRadius: 8 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <tbody>
              {card.deals.map((d) => (
                <tr key={d.kommoId} style={{ borderBottom: "1px solid #f1f5f9" }}>
                  <td style={{ padding: "6px 8px", whiteSpace: "nowrap", color: "#6b7280" }}>
                    {d.date ?? "—"}
                    {/* Підпис якоря рядка: закрита угода чи ще ні — інакше дата читалась
                        би як «дата оплати», якої в CRM не існує взагалі. */}
                    <div style={{ fontSize: 10, color: "#9ca3af" }}>{d.dateKind === "closed" ? "закрито" : "створено"}</div>
                  </td>
                  <td style={{ padding: "6px 8px" }}>
                    <a href={d.crmUrl} target="_blank" rel="noreferrer" style={{ color: "#1d4ed8", textDecoration: "none" }}>
                      {d.name ?? `Угода ${d.kommoId}`}
                    </a>
                    <div style={{ fontSize: 10, color: "#9ca3af" }}>{d.manager ?? "—"}</div>
                  </td>
                  <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>
                    <span style={{ display: "inline-block", padding: "1px 7px", borderRadius: 999, fontSize: 10, fontWeight: 700,
                                   background: d.won ? "#dcfce7" : "#f3f4f6", color: d.won ? "#166534" : "#4b5563" }}>
                      {d.stage}
                    </span>
                  </td>
                  <td style={{ padding: "6px 8px", textAlign: "right", fontWeight: 700, whiteSpace: "nowrap",
                               color: d.price < 0 ? "#b91c1c" : "#111827" }}>
                    {d.price.toLocaleString("uk-UA")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ fontSize: 11, color: "#6b7280", marginTop: 6, lineHeight: 1.5 }}>{card.anchorNote}</div>
    </div>
  );
}

/** Кнопка дії керування — один вигляд на всі, щоб «архів» і «повернути» не роз'їхались. */
const BTN = (color: string) => ({
  fontSize: 12, fontWeight: 600, padding: "5px 11px", borderRadius: 8, cursor: "pointer",
  border: "1px solid #d1d5db", background: "#fff", color,
} as const);
