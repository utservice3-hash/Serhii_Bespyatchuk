import { useEffect, useMemo, useState } from "react";
import type { AuthPayload } from "../../../auth";
import { fetchOrphanClients, claimOrphanClient, type OrphanPool, type OrphanGroup, type OrphanClientRow, type ManagerOption } from "../../../api";

/**
 * 🧭 ВКЛАДКА «НІЧИЙНІ» — 1:1 з макетом власника (05.08.2026).
 *
 * 🔴 ГОЛОВНЕ, ЩО РОБИТЬ ЦЕЙ ЕКРАН, — НЕ ПОКАЗУЄ 350 РЯДКІВ. Групи згорнуті за
 * колишнім власником; розгорнута тільки перша; всередині групи — «показати ще».
 * Без цього вкладка стає тим самим полотном, від якого ми тікали.
 *
 * ⚠️ Цифри плиток НЕ рахуються тут. Вони приходять із `tiles`, порахованих тим
 * самим запитом, що й список: окремий підрахунок на фронті рано чи пізно
 * розійшовся б зі списком, і «27» перестало б збігатися з кількістю рядків.
 */
const money = (n: number) => Math.round(n).toLocaleString("uk-UA").replace(/,/g, " ");
const PAGE = 50;

const SEG_COLOR: Record<string, { c: string; bg: string }> = {
  "ВІП": { c: "var(--rpt-bad, #b4231d)", bg: "var(--rpt-bad-bg, #fdecea)" },
  "Регулярний": { c: "var(--info, #1d4ed8)", bg: "var(--info-bg, #eff6ff)" },
  "Епізодичний": { c: "var(--text-muted)", bg: "var(--surface-2)" },
  "недостатньо історії": { c: "var(--text-muted)", bg: "var(--surface-2)" },
};

export function OrphanPoolSection({ auth, managers }: { auth: AuthPayload | null; managers: ManagerOption[] }) {
  const [all, setAll] = useState(false);
  const [sortFresh, setSortFresh] = useState(false);
  const [data, setData] = useState<OrphanPool | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [shown, setShown] = useState<Record<number, number>>({});
  const [claiming, setClaiming] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    setData(null); setErr(null);
    fetchOrphanClients(all ? "all" : undefined)
      .then((d) => { if (dead) return; setData(d); setOpen(new Set(d.groups.slice(0, 1).map((g) => g.managerId))); })
      .catch(() => { if (!dead) setErr("Не вдалося завантажити пул"); });
    return () => { dead = true; };
  }, [all]);

  // Тімлід призначає лише свою команду — той самий кламп, що на сервері.
  // Дублювання навмисне: сервер лишається джерелом істини (409/403), а тут ми
  // просто не пропонуємо того, кого все одно відхилять.
  const assignable = useMemo(
    () => managers.filter((m) => auth?.role !== "team_lead" || m.teamId === auth?.teamId),
    [managers, auth]);

  const claim = async (row: OrphanClientRow, managerId: number) => {
    setClaiming(row.clientKey); setNotice(null);
    try {
      await claimOrphanClient(row.clientKey, managerId);
      // Рядок зникає без перезавантаження сторінки (вимога макета).
      setData((d) => d && ({
        ...d,
        tiles: { ...d.tiles, clients: d.tiles.clients - 1, claimedThisMonth: d.tiles.claimedThisMonth + 1 },
        groups: d.groups
          .map((g) => ({ ...g, clients: g.clients.filter((c) => c.clientKey !== row.clientKey) }))
          .filter((g) => g.clients.length > 0),
      }));
    } catch (e) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setNotice(msg ?? "Не вдалося взяти клієнта");
    } finally { setClaiming(null); }
  };

  if (err) return <div className="chart-card" style={{ padding: 20, color: "var(--danger)" }}>{err}</div>;
  if (!data) return <div className="loading-text" style={{ padding: 20 }}>Завантаження…</div>;
  if (data.tiles.clients === 0)
    return <div className="chart-card" style={{ padding: 24, color: "var(--text-muted)" }}>Нічийних клієнтів немає.</div>;

  const groups = [...data.groups].sort((a, b) => (sortFresh ? freshest(b) - freshest(a) : b.sumAll - a.sumAll));

  return (
    <div>
      <div className="orph-tiles">
        <Tile lab="Клієнтів без власника" val={String(data.tiles.clients)}
          sub={all ? "усі, за весь час" : `за 18 міс · усього в базі ${data.tiles.totalAllTime}`} />
        <Tile lab="Гроші за 12 міс" val={money(data.tiles.money12)} unit="₴" sub="що зараз ніхто не веде" />
        <Tile lab="З них постійні" val={String(data.tiles.regulars)} sub={`ВІП ${data.tiles.vip}`} />
        <Tile lab="Взято в роботу" val={String(data.tiles.claimedThisMonth)} sub="за цей місяць · закріплені одразу" />
      </div>

      <div className="orph-filters">
        <span className="orph-flab">Період:</span>
        <button className="orph-chip" aria-pressed={!all} onClick={() => setAll(false)}>оплата за 18 міс</button>
        <button className="orph-chip" aria-pressed={all} onClick={() => setAll(true)}>показати всіх</button>
        <span className="orph-flab" style={{ marginLeft: 18 }}>Сортування:</span>
        <button className="orph-chip" aria-pressed={!sortFresh} onClick={() => setSortFresh(false)}>найцінніші зверху</button>
        <button className="orph-chip" aria-pressed={sortFresh} onClick={() => setSortFresh(true)}>найсвіжіші</button>
      </div>

      {notice && <div className="orph-notice">{notice}</div>}

      <div className="chart-card" style={{ padding: 0, overflow: "hidden" }}>
        <table className="data-table orph-table">
          <thead><tr>
            <th style={{ textAlign: "left" }}>Клієнт</th>
            <th style={{ textAlign: "left" }}>Сегмент</th>
            <th style={{ textAlign: "left" }}>Остання оплата</th>
            <th style={{ textAlign: "left" }}>Остання розмова</th>
            <th style={{ textAlign: "right" }}>Σ 12 міс</th>
            <th style={{ textAlign: "right" }}>Σ історія</th>
            <th />
          </tr></thead>
          <tbody>
            {groups.map((g) => {
              const isOpen = open.has(g.managerId);
              const limit = shown[g.managerId] ?? PAGE;
              const rest = g.clients.length - limit;
              return (
                <Fragmented key={g.managerId}>
                  <tr className="orph-group" onClick={() => setOpen((s) => {
                    const n = new Set(s); n.has(g.managerId) ? n.delete(g.managerId) : n.add(g.managerId); return n;
                  })}>
                    <td colSpan={4}>
                      <span className="orph-caret">{isOpen ? "▼" : "▶"}</span>
                      <b>{g.reason === "service" ? `Адмін-акаунт «${g.manager}»` : g.manager}</b>
                      <span className="orph-dim"> · {g.reason === "service" ? "службовий акаунт" : "звільнений"} · {g.clients.length} кл.</span>
                    </td>
                    <td style={{ textAlign: "right" }}><span className="orph-dim">Σ 12 міс </span><b>{money(g.sum12)} ₴</b></td>
                    <td style={{ textAlign: "right" }}><span className="orph-dim">Σ історія </span><b>{money(g.sumAll)} ₴</b></td>
                    <td />
                  </tr>
                  {isOpen && g.clients.slice(0, limit).map((c) => (
                    <tr key={c.clientKey}>
                      <td style={{ textAlign: "left" }}>
                        <b>{c.name}</b>
                        <div className="orph-dim">{c.paymentType ?? "—"} · {c.payments} оплат</div>
                      </td>
                      <td style={{ textAlign: "left" }}>
                        <span className="orph-seg" style={{ color: SEG_COLOR[c.segment]?.c, background: SEG_COLOR[c.segment]?.bg }}>{c.segment}</span>
                      </td>
                      <td style={{ textAlign: "left" }}>
                        {c.lastPaidAt ?? "—"}
                        {c.daysSincePaid != null && <span className="orph-days"> · {c.daysSincePaid} дн</span>}
                      </td>
                      <td style={{ textAlign: "left" }}>
                        {c.lastCallAt ? <>{c.lastCallAt}<span className="orph-dim"> · {c.daysSinceCall} дн</span></> : <span className="orph-dim">розмов не було</span>}
                      </td>
                      <td style={{ textAlign: "right" }}>{c.revenue12 ? money(c.revenue12) + " ₴" : "—"}</td>
                      <td style={{ textAlign: "right" }}><b>{money(c.revenueAll)} ₴</b></td>
                      <td style={{ textAlign: "right" }}>
                        <ClaimButton row={c} busy={claiming === c.clientKey} managers={assignable} onClaim={claim} />
                      </td>
                    </tr>
                  ))}
                  {isOpen && rest > 0 && (
                    <tr><td colSpan={7} className="orph-more"
                      onClick={() => setShown((s) => ({ ...s, [g.managerId]: limit + PAGE }))}>
                      ↓ показати ще {Math.min(rest, PAGE)} клієнтів цієї групи
                    </td></tr>
                  )}
                </Fragmented>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="orph-foot">
        Групи згорнуті за замовчуванням. Взяв у роботу → клієнт закріплюється за виконавцем
        і <b>зникає з пулу</b>, щоб двоє не дзвонили тому самому.
      </p>
    </div>
  );
}

/** `<>` не можна з ключем у мапі — потрібен саме Fragment із key. */
function Fragmented({ children }: { children: React.ReactNode }) { return <>{children}</>; }

function freshest(g: OrphanGroup): number {
  return g.clients.reduce((m, c) => Math.max(m, c.lastPaidAt ? Date.parse(c.lastPaidAt) : 0), 0);
}

function Tile({ lab, val, unit, sub }: { lab: string; val: string; unit?: string; sub: string }) {
  return (
    <div className="orph-tile">
      <div className="orph-tile-lab">{lab}</div>
      <div className="orph-tile-val">{val}{unit && <span className="orph-tile-unit"> {unit}</span>}</div>
      <div className="orph-tile-sub">{sub}</div>
    </div>
  );
}

/** «Взяти в роботу»: спершу вибір виконавця, потім дія — щоб не було випадкових кліків. */
function ClaimButton({ row, busy, managers, onClaim }: {
  row: OrphanClientRow; busy: boolean; managers: ManagerOption[];
  onClaim: (r: OrphanClientRow, id: number) => void;
}) {
  const [pick, setPick] = useState(false);
  if (busy) return <span className="orph-dim">…</span>;
  if (!pick) return <button className="orph-take" onClick={() => setPick(true)}>Взяти в роботу</button>;
  return (
    <select className="orph-pick" autoFocus defaultValue=""
      onChange={(e) => e.target.value && onClaim(row, Number(e.target.value))}
      onBlur={() => setPick(false)}>
      <option value="">кому передати…</option>
      {managers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
    </select>
  );
}
