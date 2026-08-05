import { useEffect, useState } from "react";
import type { AuthPayload } from "../../../auth";
import { fetchClientArchive, archiveClient, type ArchiveResp } from "../../../api";
import { formatAmountFull } from "../format";

/**
 * 🗄 ВКЛАДКА «АРХІВ» — де опиняються клієнти, яких прибрали з екранів.
 *
 * 🔴 НАВІЩО ВЗАГАЛІ ЕКРАН, А НЕ ПРОСТО ФІЛЬТР. Стара дія `hidden` була булевим
 * тумблером: клієнт зникав, і через місяць ніхто не знав, хто це зробив і чому.
 * Тут кожен рядок відповідає на обидва питання — і на третє, «як повернути».
 *
 * 🟢 ПОВЕРНЕННЯ АВТОМАТИЧНЕ. Клієнт виходить з архіву САМ, щойно зʼявляється
 * оплата пізніша за дату архівації, — тому кнопка «повернути» тут для рішення
 * людини, а не для виправлення системи.
 */
export function ArchiveSection({ auth }: { auth: AuthPayload | null }) {
  const [data, setData] = useState<ArchiveResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => { setErr(null); fetchClientArchive().then(setData).catch(() => setErr("Не вдалося завантажити архів")); };
  useEffect(load, []);

  const restore = async (clientKey: string) => {
    setBusy(clientKey);
    try { await archiveClient({ clientKey, restore: true }); load(); }
    catch { setErr("Не вдалося повернути з архіву"); }
    finally { setBusy(null); }
  };

  if (err) return <div className="chart-card" style={{ padding: 20, color: "var(--danger)" }}>{err}</div>;
  if (!data) return <div className="loading-text" style={{ padding: 20 }}>Завантаження…</div>;
  if (data.clients.length === 0)
    return (
      <div className="chart-card" style={{ padding: 24, color: "var(--text-muted)" }}>
        Архів порожній — жодного клієнта не прибрано з екранів.
      </div>
    );

  const total = data.clients.reduce((s, c) => s + c.lifetimeRevenue, 0);
  return (
    <div>
      <div className="orph-tiles">
        <Tile lab="В архіві" val={String(data.clients.length)} sub="прибрані з планування й реактивації" />
        <Tile lab="Виручка за історію" val={formatAmountFull(total)} sub="зароблена, поки клієнт був наш" />
      </div>

      <div className="chart-card" style={{ padding: 0, overflow: "hidden" }}>
        <table className="data-table orph-table">
          <thead><tr>
            <th style={{ textAlign: "left" }}>Клієнт</th>
            <th style={{ textAlign: "left" }}>Причина</th>
            <th style={{ textAlign: "left" }}>Коли · хто</th>
            <th style={{ textAlign: "left" }}>Остання оплата</th>
            <th style={{ textAlign: "right" }}>Σ історія</th>
            <th />
          </tr></thead>
          <tbody>
            {data.clients.map((c) => (
              <tr key={c.clientKey}>
                <td style={{ textAlign: "left" }}>
                  <b>{c.clientName}</b>
                  <div className="orph-dim">{c.orders} оплат</div>
                </td>
                <td style={{ textAlign: "left" }}><span className="orph-seg">{c.reasonLabel}</span></td>
                <td style={{ textAlign: "left" }}>
                  {c.archivedAt}
                  <div className="orph-dim">{c.archivedBy ?? "—"}</div>
                </td>
                <td style={{ textAlign: "left" }}>{c.lastPaid ?? "—"}</td>
                <td style={{ textAlign: "right" }}><b>{formatAmountFull(c.lifetimeRevenue)}</b></td>
                <td style={{ textAlign: "right" }}>
                  {busy === c.clientKey
                    ? <span className="orph-dim">…</span>
                    : <button className="orph-take" onClick={() => restore(c.clientKey)}>Повернути</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="orph-foot">
        Клієнт повертається <b>сам</b>, щойно зʼявиться оплата пізніша за дату архівації — кнопка потрібна
        лише тоді, коли рішення змінилось, а оплати ще немає. Архівувати й повертати можуть КВП, ОД і адмін.
        {auth?.role !== "admin" && " Ви бачите цей екран, бо маєте відповідне право."}
      </p>
    </div>
  );
}

function Tile({ lab, val, sub }: { lab: string; val: string; sub: string }) {
  return (
    <div className="orph-tile">
      <div className="orph-tile-lab">{lab}</div>
      <div className="orph-tile-val">{val}</div>
      <div className="orph-tile-sub">{sub}</div>
    </div>
  );
}
