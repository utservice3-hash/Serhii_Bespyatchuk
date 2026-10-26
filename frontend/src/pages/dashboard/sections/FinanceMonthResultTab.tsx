import { useState } from "react";
import type { ManagerPick } from "./FinanceMonthDealsTab";
import { MUTED, money, stamp, ymName, useMonthResult, excelOf, MonthSwitch, SourcesNote, type Ask, type Toast } from "./financeMonthShared";

/**
 * 🏁 «РЕЗУЛЬТАТ МІСЯЦЯ» (#5583, Тетяна; прохід 1 — 23.10.2026). Замість ручного аркуша «09.26»: успішні угоди «Повного
 * циклу», закриті в місяці (і мінусові теж), сума бюджетів Kommo — за менеджером, який був відповідальним У МОМЕНТ
 * ЗАКРИТТЯ (перепризначення після закриття не переносить угоду). Угоди без рахунку, без фактичного приходу, валютні, з
 * готівковим розходом поза запитами, з бюджетом 1С ≠ Kommo — «на перевірці»: у результаті вони Є, позначка лише просить
 * подивитись. Це ЗВЕДЕННЯ по менеджерах; угоди — окремою вкладкою «Угоди місяця» (26.10.2026), клік по менеджеру
 * відкриває її з його фільтром. Рахує сервер (`core/monthResult.ts`).
 */
export function FinanceMonthResultTab({ toast, ym, setYm, onOpenDeals }: {
  ask: Ask; toast: Toast; ym: string; setYm: (ym: string) => void; onOpenDeals: (manager: ManagerPick) => void;
}) {
  const { data, err, busy, pending, load } = useMonthResult(ym);
  const [onlyReview, setOnlyReview] = useState(false);

  if (err && !data) return <div className="chart-card"><b>Результат місяця</b> <span className="hr-muted">{err}</span></div>;
  if (!data) return <p className="loading-text">Рахую {ymName(ym)}{pending ? " — поля частини угод ще тягнуться з Kommo" : ""}…</p>;

  const tile = (label: string, value: string, color?: string, sub?: string) => (
    <div style={{ background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 12, padding: "10px 14px" }}>
      <div style={{ fontSize: 12, color: MUTED }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: color ?? "var(--text)" }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: MUTED }}>{sub}</div>}
    </div>
  );
  const rows = onlyReview ? data.managers.filter((m) => m.review.n || m.overrides) : data.managers;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <MonthSwitch ym={ym} setYm={setYm} />
        <label style={{ fontSize: 13, display: "inline-flex", gap: 6, alignItems: "center", marginLeft: 8 }}>
          <input type="checkbox" checked={onlyReview} onChange={(e) => setOnlyReview(e.target.checked)} /> лише на перевірці й з рішенням
        </label>
        <span style={{ fontSize: 12, color: MUTED, marginLeft: "auto" }}>пораховано {stamp(data.computedAt)}</span>
        <button className="hr-btn" disabled={busy} onClick={() => load(true)}>{busy ? "Рахую…" : "↻ Оновити з Kommo"}</button>
        <button className="hr-btn" onClick={() => void excelOf(ym, toast)}>⬇ Excel</button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, marginBottom: 14 }}>
        {tile("Угод", String(data.totals.deals))}
        {tile("Результат", `${money(data.totals.result)} ₴`, "#16a34a")}
        {tile("На перевірці", String(data.totals.review.n), data.totals.review.n ? "#b45309" : undefined, data.totals.review.n ? `${money(data.totals.review.sum)} ₴ — у результаті є` : undefined)}
        {tile("Мінусові", String(data.totals.minus.n), data.totals.minus.n ? "#dc2626" : undefined, data.totals.minus.n ? `${money(data.totals.minus.sum)} ₴` : undefined)}
      </div>

      <div className="chart-card">
        <SourcesNote data={data} />
        <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>Клік по менеджеру — його угоди у вкладці «Угоди місяця».</div>
        <div style={{ overflowX: "auto" }}>
          <table className="hr-table fin-table" style={{ width: "100%", fontSize: 13 }}>
            <thead><tr><th>Менеджер</th><th style={{ textAlign: "right" }}>Угод</th><th style={{ textAlign: "right" }}>Результат</th><th style={{ textAlign: "right" }}>На перевірці</th><th style={{ textAlign: "right" }}>Мінусові</th><th style={{ textAlign: "right" }}>Рішень</th></tr></thead>
            <tbody>
              {rows.map((m) => (
                <tr key={String(m.kommoUserId)} className="it" onClick={() => onOpenDeals(m.kommoUserId)} title="Відкрити угоди менеджера">
                  <td>{m.name} <span style={{ color: MUTED }}>→</span>{!m.active && <span style={{ fontSize: 11, color: MUTED, marginLeft: 6 }}>неактивний</span>}</td>
                  <td style={{ textAlign: "right" }}>{m.deals}</td>
                  <td style={{ textAlign: "right" }}><b>{money(m.result)}</b></td>
                  <td style={{ textAlign: "right", color: m.review.n ? "#b45309" : MUTED }}>{m.review.n ? `${m.review.n} · ${money(m.review.sum)}` : "—"}</td>
                  <td style={{ textAlign: "right", color: m.minus.n ? "#dc2626" : MUTED }}>{m.minus.n ? `${m.minus.n} · ${money(m.minus.sum)}` : "—"}</td>
                  <td style={{ textAlign: "right", color: m.overrides ? "#2563eb" : MUTED }}>{m.overrides || "—"}</td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={6} className="hr-muted">{onlyReview ? "Нічого на перевірці й жодного рішення." : "У цьому місяці немає успішних угод «Повного циклу»."}</td></tr>}
              <tr className="it" onClick={() => onOpenDeals("all")} title="Відкрити всі угоди місяця"><td><b>Разом</b> <span style={{ color: MUTED }}>→ усі угоди</span></td><td style={{ textAlign: "right" }}><b>{data.totals.deals}</b></td><td style={{ textAlign: "right" }}><b>{money(data.totals.result)}</b></td><td /><td /><td /></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
