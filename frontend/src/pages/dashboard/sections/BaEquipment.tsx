import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  fetchBaEquipment, fetchBaEquipmentCard, createBaEquipment, updateBaEquipment, archiveBaEquipment, issueBaEquipment,
  returnBaIssue, undoReturnBaIssue, fetchBaEmployees, hiringError,
  type BaMeta, type BaEquipmentItem, type BaEquipmentCard, type BaEmployee,
} from "../../../api";
import { money, fmtDate, todayKyiv, useEscape, Docs, History, type Toast } from "./BaShared";

/**
 * 🗂 «ОБЛІК ТЕХНІКИ» (Бізнес-асистент, прохід 2, 29.09.2026). Реєстр одиниць, як у таблиці Даші
 * «Облік техніки 2026», і видачі: кому, коли, договір, повернення. Видають БУДЬ-ЯКОМУ співробітнику з
 * реєстру (відповідь Даші). «Звільнений, не повернено» підсвічується й винесено числом у шапку.
 */
type Filter = "all" | "hands" | "free" | "dismissed" | "archive";

export function BaEquipment({ meta, toast }: { meta: BaMeta; toast: Toast }) {
  const [rows, setRows] = useState<BaEquipmentItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [kind, setKind] = useState("");
  const [loc, setLoc] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<number | "new" | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => { fetchBaEquipment().then(setRows).catch((e) => setErr(hiringError(e))); }, [nonce]);
  const refresh = () => setNonce((n) => n + 1);

  const active = useMemo(() => (rows ?? []).filter((r) => !r.archived), [rows]);
  const kinds = useMemo(() => [...new Set(active.map((r) => r.kind))].sort((a, b) => a.localeCompare(b, "uk")), [active]);
  const locs = useMemo(() => [...new Set(active.map((r) => r.location).filter(Boolean))].sort(), [active]);
  const shown = useMemo(() => (rows ?? []).filter((r) => {
    if (filter === "archive" ? !r.archived : r.archived) return false;
    if (filter === "hands" && !r.holder) return false;
    if (filter === "free" && r.holder) return false;
    if (filter === "dismissed" && !r.holder?.dismissed) return false;
    if (kind && r.kind !== kind) return false;
    if (loc && r.location !== loc) return false;
    const needle = q.trim().toLowerCase();
    return !needle || [r.invNo, r.kind, r.model, r.holder?.name ?? ""].some((x) => x.toLowerCase().includes(needle));
  }), [rows, filter, kind, loc, q]);

  if (err) return <div className="chart-card"><span className="hr-muted">{err}</span></div>;
  if (!rows) return <p className="loading-text">Завантаження…</p>;
  const onHands = active.filter((r) => r.holder).length;
  const atDismissed = active.filter((r) => r.holder?.dismissed).length;
  const chips: [Filter, string, number][] = [
    ["all", "Усі", active.length], ["hands", "На руках", onHands], ["free", "Вільна", active.length - onHands],
    ["dismissed", "У звільнених", atDismissed], ["archive", "Архів (списано)", rows.length - active.length],
  ];
  return (
    <div className="hr-card">
      <div className="hd">
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "end" }}>
          <label className="hr-muted">Пошук<br />
            <input className="hr-inp" type="search" placeholder="Обліковий №, модель, людина" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <label className="hr-muted">Тип<br />
            <select className="hr-inp" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">Усі типи</option>{kinds.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </label>
          <label className="hr-muted">Розташування<br />
            <select className="hr-inp" value={loc} onChange={(e) => setLoc(e.target.value)}>
              <option value="">Усі</option>{locs.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </label>
        </div>
        <button className="hr-btn p" onClick={() => setOpen("new")}>+ Техніка</button>
      </div>
      {atDismissed > 0 && (
        <div className="hr-note" style={{ background: "var(--warn-bg)", color: "var(--warn)", margin: "0 16px 10px" }}>
          У звільнених співробітників на руках {atDismissed} од. техніки. <button className="hr-link" onClick={() => setFilter("dismissed")}>Показати</button>
        </div>
      )}
      <div className="hr-sect" style={{ borderTop: 0, paddingBottom: 0 }}>
        <div className="hr-pills" role="group" aria-label="Фільтр за статусом">
          {chips.map(([k, l, n]) => <button key={k} className={filter === k ? "on" : ""} aria-pressed={filter === k} onClick={() => setFilter(k)}>{l} · {n}</button>)}
        </div>
      </div>
      <div className="hr-tw">
        <table className="hr-table">
          <thead><tr><th>Техніка</th><th>Кому видано</th><th>Видано</th><th>Договір</th><th>Розташування</th><th>Статус</th></tr></thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} className="row" tabIndex={0} onClick={() => setOpen(r.id)} onKeyDown={(e) => { if (e.key === "Enter") setOpen(r.id); }}>
                <td><b>{r.kind}</b>{r.model && <> · {r.model}</>}<br /><span className="hr-muted">{r.invNo ? `інв. № ${r.invNo}` : "інв. № не заповнено"}</span></td>
                <td>{r.holder ? <>{r.holder.name}{r.holder.dismissed && <><br /><span className="hr-pill dg">звільнений{r.holder.dismissedOn ? ` ${fmtDate(r.holder.dismissedOn)}` : ""}, не повернено</span></>}{r.holder.employeeId == null && <><br /><span className="hr-muted">не зіставлено з реєстром</span></>}</> : <span className="hr-muted">—</span>}</td>
                <td>{r.holder ? (r.holder.issuedOn ? fmtDate(r.holder.issuedOn) : <span className="hr-muted">дата невідома</span>) : r.lastReturnedOn ? <span className="hr-muted">повернено {fmtDate(r.lastReturnedOn)}</span> : <span className="hr-muted">—</span>}</td>
                <td>{r.holder ? (r.holder.contractFiles ? `файлів: ${r.holder.contractFiles}` : <span className="hr-muted">без договору</span>) : <span className="hr-muted">—</span>}</td>
                <td>{r.location || <span className="hr-muted">не вказано</span>}</td>
                <td>{r.archived ? <span className="hr-pill gr">списано</span> : r.holder ? <span className="hr-pill pl">На руках</span> : <span className="hr-pill ok">Вільна</span>}</td>
              </tr>
            ))}
            {!shown.length && <tr><td colSpan={6} className="hr-muted" style={{ padding: 16 }}>{rows.length ? "Нічого не знайдено за цим фільтром." : "Техніки в обліку ще немає. Додайте через «+ Техніка»."}</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="hr-sect hr-muted">Видають будь-якому співробітнику з реєстру дашборда. Помилково внесене повернення можна скасувати в картці.</div>
      {open != null && <EquipmentDrawer meta={meta} id={open} toast={toast} onClose={() => setOpen(null)} onChanged={refresh} onCreated={(id) => setOpen(id)} />}
    </div>
  );
}

function EquipmentDrawer({ meta, id, toast, onClose, onChanged, onCreated }: {
  meta: BaMeta; id: number | "new"; toast: Toast; onClose: () => void; onChanged: () => void; onCreated: (id: number) => void;
}) {
  const [card, setCard] = useState<BaEquipmentCard | null>(null);
  const [form, setForm] = useState({ kind: "", invNo: "", model: "", purchasedOn: "", price: "", purchaseUrl: "", location: "", comment: "" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [emps, setEmps] = useState<BaEmployee[] | null>(null);
  const [issueTo, setIssueTo] = useState("");
  const [issueOn, setIssueOn] = useState(todayKyiv());
  const [returnOn, setReturnOn] = useState(todayKyiv());
  const load = useCallback(() => {
    if (id === "new") return;
    fetchBaEquipmentCard(id).then((c) => {
      setCard(c);
      setForm({ kind: c.kind, invNo: c.invNo, model: c.model, purchasedOn: c.purchasedOn ?? "", price: c.price == null ? "" : String(c.price),
        purchaseUrl: c.purchaseUrl ?? "", location: c.location, comment: c.comment });
    }).catch((e) => setErr(hiringError(e)));
  }, [id]);
  useEffect(load, [load]);
  useEffect(() => { fetchBaEmployees().then(setEmps).catch(() => setEmps([])); }, []);
  useEscape(onClose);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setErr(null);
    try { await fn(); onChanged(); load(); toast(ok); } catch (e) { setErr(hiringError(e)); } finally { setBusy(false); }
  };
  const save = async () => {
    if (!form.kind.trim()) { setErr("Вкажіть тип техніки"); return; }
    const body = { ...form, purchasedOn: form.purchasedOn || null, price: form.price || null };
    if (id === "new") {
      setBusy(true); setErr(null);
      try { const nid = await createBaEquipment(body); onChanged(); onCreated(nid); toast("Техніку додано. Тепер її можна видати."); }
      catch (e) { setErr(hiringError(e)); } finally { setBusy(false); }
    } else await act(() => updateBaEquipment(id, body), "Збережено");
  };
  const lastReturned = card && !card.holder ? card.issues.find((x) => x.returnedOn) : undefined;
  const loading = id !== "new" && !card && !err;
  return createPortal(
    <div className="hr-overlay" onClick={onClose}>
      <aside className="hr-drawer" role="dialog" aria-label="Картка техніки" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "start" }}>
          <div>
            <div className="hr-muted">Облік техніки{card?.invNo ? ` · інв. № ${card.invNo}` : ""}</div>
            <h2 style={{ margin: "2px 0 12px", fontSize: 19 }}>{id === "new" ? "Нова техніка" : card ? `${card.kind}${card.model ? ` · ${card.model}` : ""}` : "…"}</h2>
          </div>
          <button className="hr-btn xs" onClick={onClose} aria-label="Закрити картку">×</button>
        </div>
        {loading ? <p className="loading-text">Завантаження…</p> : (<>
          {card?.archived && <div className="hr-note" style={{ background: "var(--warn-bg)", color: "var(--warn)", marginTop: 0, marginBottom: 10 }}>Техніку списано (в архіві). Її можна повернути кнопкою внизу.</div>}
          {card && !card.archived && (card.holder ? (
            <div className="hr-note" style={{ marginTop: 0, marginBottom: 12, ...(card.holder.dismissed ? { background: "var(--danger-bg)", color: "var(--danger)" } : {}) }}>
              <b>На руках:</b> {card.holder.name} · {card.holder.issuedOn ? `видано ${fmtDate(card.holder.issuedOn)}` : "дата видачі невідома"}
              {card.holder.dismissed && <> · <b>співробітника звільнено, техніку не повернено</b></>}
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
                <label className="hr-muted">Дата повернення <input className="hr-inp" type="date" value={returnOn} onChange={(e) => setReturnOn(e.target.value)} /></label>
                <button className="hr-btn xs" disabled={busy} onClick={() => void act(() => returnBaIssue(card.holder!.issueId, returnOn), "Повернення оформлено")}>Оформити повернення</button>
              </div>
            </div>
          ) : (
            <div className="hr-note" style={{ marginTop: 0, marginBottom: 12 }}>
              <b>Вільна.</b> Видати:
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
                <select className="hr-inp" value={issueTo} onChange={(e) => setIssueTo(e.target.value)} aria-label="Кому видати">
                  <option value="">— співробітник —</option>
                  {(emps ?? []).filter((e) => e.status === "active").map((e) => <option key={e.id} value={e.id}>{e.fullName}</option>)}
                </select>
                <input className="hr-inp" type="date" value={issueOn} onChange={(e) => setIssueOn(e.target.value)} aria-label="Дата видачі" />
                <button className="hr-btn xs p" disabled={busy || !issueTo} onClick={() => void act(() => issueBaEquipment(card.id, { employeeId: Number(issueTo), issuedOn: issueOn }), "Видано. Додайте договір у історії видач нижче.")}>Видати</button>
              </div>
              {lastReturned && <div style={{ marginTop: 8 }}>Повернення від {lastReturned.name} ({fmtDate(lastReturned.returnedOn)}) внесено помилково? <button className="hr-link" disabled={busy} onClick={() => void act(() => undoReturnBaIssue(lastReturned.id), "Повернення скасовано — техніка знову на руках")}>Скасувати повернення</button></div>}
            </div>
          ))}
          <div className="hr-kv">
            <span className="k">Тип</span><input className="hr-inp" placeholder="ноутбук, телефон, мишка…" value={form.kind} onChange={set("kind")} />
            <span className="k">Модель</span><input className="hr-inp" value={form.model} onChange={set("model")} />
            <span className="k">Обліковий №</span><input className="hr-inp" value={form.invNo} onChange={set("invNo")} />
            <span className="k">Розташування</span><input className="hr-inp" placeholder="Київ 201" value={form.location} onChange={set("location")} />
            <span className="k">Дата придбання</span><input className="hr-inp" type="date" value={form.purchasedOn} onChange={set("purchasedOn")} />
            <span className="k">Ціна, ₴</span><input className="hr-inp" inputMode="decimal" value={form.price} onChange={set("price")} />
            <span className="k">Де придбано</span><input className="hr-inp" placeholder="https://…" value={form.purchaseUrl} onChange={set("purchaseUrl")} />
            <span className="k">Коментар</span><textarea className="hr-inp" rows={2} value={form.comment} onChange={set("comment")} />
          </div>
          {card?.price != null && <p className="hr-muted" style={{ margin: "6px 0 0" }}>Ціна: {money(card.price)}</p>}
          {err && <div style={{ color: "var(--danger)", fontSize: 12, marginTop: 8 }}>{err}</div>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12, flexWrap: "wrap" }}>
            {card && (card.archived
              ? <button className="hr-btn" onClick={() => void act(() => archiveBaEquipment(card.id, false), "Повернуто з архіву")}>Повернути з архіву</button>
              : <button className="hr-btn" onClick={() => void act(() => archiveBaEquipment(card.id, true), "Списано в архів")}>Списати в архів</button>)}
            <button className="hr-btn" onClick={onClose}>Скасувати</button>
            <button className="hr-btn p" disabled={busy} onClick={() => void save()}>{id === "new" ? "Додати" : "Зберегти"}</button>
          </div>
          {card && (
            <div className="hr-sect" style={{ marginTop: 14, paddingLeft: 0, paddingRight: 0 }}>
              <h4>Історія видач · {card.issues.length}</h4>
              {!card.issues.length && <p className="hr-muted" style={{ margin: 0 }}>Техніку ще не видавали.</p>}
              {card.issues.map((x) => (
                <div key={x.id} style={{ borderBottom: "1px solid var(--border)", padding: "8px 0" }}>
                  <div style={{ fontSize: 13 }}>
                    <b>{x.name}</b>{x.dismissed && <span className="hr-pill dg" style={{ marginLeft: 6 }}>звільнений</span>}
                    <span className="hr-muted"> · видано {x.issuedOn ? fmtDate(x.issuedOn) : "(дата невідома)"} · {x.returnedOn ? `повернено ${fmtDate(x.returnedOn)}` : "на руках"}</span>
                  </div>
                  <Docs kind="issues" ownerId={x.id} files={x.files} types={meta.issueDocTypes} maxBytes={meta.fileMaxBytes} toast={toast} onAdded={() => { load(); onChanged(); }} />
                </div>
              ))}
            </div>
          )}
          {card && <History events={card.events} />}
          {id === "new" && <p className="hr-muted" style={{ marginTop: 14 }}>Видати й додати договір можна після того, як техніку додано.</p>}
        </>)}
      </aside>
    </div>, document.body);
}
