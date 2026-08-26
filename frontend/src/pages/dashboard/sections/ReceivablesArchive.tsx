import { useEffect, useState } from "react";
import { fetchReceivableArchive, revokeReceivableWriteoff, type ReceivableArchive } from "../../../api";
import { formatAmount, formatAmountFull } from "../format";
import { formatDateSafe, parseDateSafe } from "../receivablesView";
import { Hint, Tip } from "../../../components/Hint";

/**
 * 🗄 АРХІВ СПИСАНИХ БОРГІВ — окрема вкладка (рішення власника 26.08.2026).
 *
 * Списаний рахунок зникає з активного списку ПОВНІСТЮ й сліду в рядку клієнта
 * не лишає. Але «зникнути з очей» і «зникнути з обліку» — різні речі: тут він
 * лежить із причиною, автором і датою, і повертається однією кнопкою.
 *
 * 🔴 ЛІЧИЛЬНИК РОЗБІЖНОСТІ З CRM СТОЇТЬ ТУТ, А НЕ В ЛОЗІ. Списана угода
 * лишається в Kommo на грошовій стадії, а в нас її вже немає — тобто дашборд
 * показує МЕНШЕ за CRM, що суперечить «дашборд це дзеркало CRM». Власник закрив
 * суперечність не забороною, а видимістю: розбіжність названа числом, і вона ж
 * підказує, що ті угоди треба закрити і в Kommo.
 */
export function ReceivablesArchive({ onRestored }: { onRestored?: () => void }) {
  const [d, setD] = useState<ReceivableArchive | "loading" | "error">("loading");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => fetchReceivableArchive().then(setD).catch(() => setD("error"));
  useEffect(() => { load(); }, []);

  if (d === "loading") return <div className="loading-text">Завантаження архіву…</div>;
  if (d === "error") return <div style={{ color: "var(--danger)" }}>Не вдалося завантажити архів</div>;

  const restore = async (w: { clientKeyRaw: string; invoiceNo: string; clientName: string | null }) => {
    const note = window.prompt(
      `Повернути рахунок № ${w.invoiceNo} (${w.clientName ?? w.clientKeyRaw}) в активні.\n\n`
      + "Причина обовʼязкова — журнал мусить пояснювати обидві дії:");
    if (note == null) return;
    if (!note.trim()) { setErr("Причина обовʼязкова — без неї повернення не відрізнити від помилки"); return; }
    setBusy(w.invoiceNo); setErr(null);
    try {
      // 🔴 Повертаємо КАНОНІЧНИМ ключем — тим самим, яким списували: роут
      // розгортає його в рахунки й знімає позначку з кожного.
      await revokeReceivableWriteoff({ clientKey: w.clientKeyRaw, invoiceNo: w.invoiceNo, note: note.trim() });
      await load();
      // Активний список і всі очікувані перечитуються: сума повертається СКРІЗЬ.
      onRestored?.();
    } catch (e) {
      const r = e as { response?: { data?: { error?: string } } };
      setErr(r?.response?.data?.error ?? "Не вдалось повернути");
    } finally { setBusy(null); }
  };

  const tile = (label: string, value: string, note: string, hint: { title: string; body: string }) => (
    <div className="kpi-card">
      <span className="kpi-label">{label}<Hint title={hint.title} body={hint.body} /></span>
      <span className="kpi-value" style={{ color: "var(--text-muted)" }}>{value}</span>
      <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)" }}>{note}</span>
    </div>
  );

  const t = d.totals;
  const oldest = parseDateSafe(t.oldestAt);
  const oldestDays = oldest ? Math.floor((Date.now() - oldest.getTime()) / 86400000) : null;

  return (
    <>
      <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", marginBottom: 16 }}>
        {tile("Списано в архів", formatAmount(t.amount), `${t.n} рахунків · ${t.clients} клієнтів`,
          { title: "Борги, які ми визнали безнадійними",
            body: "Вони не входять ні в загальний борг, ні в очікувані кошти — ніде на дашборді. Але лежать тут із причиною й автором, і повертаються однією кнопкою." })}
        {tile("За цей місяць", formatAmount(t.thisMonth), new Date().toLocaleDateString("uk-UA", { month: "long", year: "numeric" }),
          { title: "Скільки списано з початку поточного місяця",
            body: "Різке зростання — привід подивитись, що відбувається зі стягненням, а не лише з обліком." })}
        {tile("Найстаріше списання", t.oldestAt ? formatDateSafe(t.oldestAt) : "—",
          oldestDays != null ? `${oldestDays} дн. тому` : "списань ще не було",
          { title: "Коли востаннє чистили дебіторку",
            body: "Якщо давно — можливо, безнадійні борги досі висять в активних і роздувають загальну суму." })}
      </div>

      {/* 🔴 РОЗБІЖНІСТЬ ІЗ CRM — НАЗВАНА, А НЕ СХОВАНА. Показуємо лише коли вона
          Є: підпис «розбіжності 0» у кожному відкритті перетворив би сигнал на
          шум (той самий висновок, що з «у т.ч. від менеджерів без плану»). */}
      {d.stillInZone.deals > 0 && (
        <div style={{ padding: "10px 14px", marginBottom: 14, borderRadius: 10,
                      background: "var(--warn-bg, #fef3c7)", color: "var(--warn, #b45309)", fontSize: "var(--fs-sm)" }}>
          ⚠️ <b>Списані борги, чиї угоди досі в грошовій зоні: {d.stillInZone.deals} на {formatAmount(d.stillInZone.amount)}</b>
          <Tip title="Що це означає"
            body="Ці угоди ми зі своїх очікуваних прибрали, а в Kommo вони досі на грошовій стадії. Тобто дашборд у цьому місці показує МЕНШЕ за CRM — і це названо навмисно: розбіжність, про яку не сказано, найдорожча. Щоб її не було, ті угоди треба закрити і в Kommo.">
            <span style={{ marginLeft: 6, textDecoration: "underline dotted" }}>чому так</span>
          </Tip>
        </div>
      )}

      {err && <div style={{ color: "var(--danger)", fontSize: "var(--fs-sm)", marginBottom: 8 }}>{err}</div>}

      {d.writeoffs.length === 0 ? (
        /* Порожній стан — ВІДПОВІДЬ, а не порожнє місце. */
        <div className="loading-text">
          Списаних боргів немає. Списати можна в активній дебіторці — кнопкою «Списати» в рядку клієнта або рахунку.
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Клієнт</th>
                <th style={{ textAlign: "left" }}>Рахунок №</th>
                <th style={{ textAlign: "right", whiteSpace: "nowrap" }}>Сума</th>
                <th style={{ textAlign: "left" }}>Списав</th>
                <th style={{ textAlign: "center" }}>Коли</th>
                <th style={{ textAlign: "left" }}>Причина</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {d.writeoffs.map((w) => (
                <tr key={`${w.clientKeyRaw}-${w.invoiceNo}`}>
                  <td style={{ textAlign: "left", fontWeight: 600 }}>{w.clientName ?? w.clientKeyRaw}</td>
                  <td style={{ textAlign: "left", textDecoration: "line-through", color: "var(--text-muted)" }}>{w.invoiceNo || "—"}</td>
                  <td style={{ textAlign: "right", fontWeight: 700, whiteSpace: "nowrap" }}
                      title={formatAmountFull(w.amount)}>{formatAmount(w.amount)}</td>
                  <td style={{ textAlign: "left", fontSize: "var(--fs-sm)" }}>{w.author ?? "—"}</td>
                  <td style={{ textAlign: "center", whiteSpace: "nowrap" }}>{formatDateSafe(w.at)}</td>
                  <td style={{ textAlign: "left", fontSize: "var(--fs-sm)" }}>{w.note}</td>
                  <td style={{ textAlign: "right" }}>
                    {/* 🔴 ДІЯ, ДОСТУПНА В ІНТЕРФЕЙСІ, МУСИТЬ БУТИ СКАСОВНОЮ ТИМ САМИМ
                        ІНТЕРФЕЙСОМ (правило власника 06.08.2026). Кнопки немає в тих,
                        хто не має права, — не «є, але дає 403». */}
                    {d.canWriteOff && (
                      <button disabled={busy === w.invoiceNo} onClick={() => restore(w)}
                        style={{ font: "inherit", fontSize: "var(--fs-xs)", fontWeight: 500,
                                 padding: "3px 8px", borderRadius: 6, whiteSpace: "nowrap",
                                 border: "1px solid var(--border)", background: "transparent",
                                 color: "var(--text)", cursor: busy ? "default" : "pointer" }}>
                        Повернути в активні
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2} style={{ fontWeight: 700 }}>Разом в архіві</td>
                <td style={{ textAlign: "right", fontWeight: 700 }}>{formatAmount(t.amount)}</td>
                <td colSpan={4} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </>
  );
}
