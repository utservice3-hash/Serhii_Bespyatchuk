import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { AuthPayload } from "../../../auth";
import {
  fetchLoyaltyOverrides, saveLoyaltyOverride, removeLoyaltyOverride, fetchManagerOptions,
  type LoyaltyManager, type Team, type LoyaltyOverride, type ManagerOption,
} from "../../../api";
import { ClientPlansSection } from "./ClientPlansSection";
import { ReactivationSection } from "./ReactivationSection";
import { teamOptions } from "../teamColors";

/** Адмін-дії над постійним клієнтом: 🗑 прибрати · ↪ передати менеджеру. */
function AdminClientActions({ clientKey, clientName, managers, onDone }: {
  clientKey: string; clientName: string; managers: ManagerOption[]; onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<void>) => { setBusy(true); try { await fn(); onDone(); } finally { setBusy(false); } };
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center", whiteSpace: "nowrap" }}>
      <button title="Прибрати з постійних" disabled={busy}
        onClick={() => { if (confirm(`Прибрати «${clientName}» з постійних?`)) act(() => saveLoyaltyOverride({ clientKey, clientName, hidden: true })); }}
        style={{ border: "none", background: "transparent", cursor: "pointer", color: "#dc2626", fontSize: 14 }}>🗑</button>
      <select defaultValue="" disabled={busy} title="Передати іншому менеджеру"
        onChange={(e) => { const v = e.target.value; if (v) act(() => saveLoyaltyOverride({ clientKey, clientName, pinnedManagerId: Number(v) })); e.target.value = ""; }}
        style={{ fontSize: 11, maxWidth: 130 }}>
        <option value="">↪ передати…</option>
        {managers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
      </select>
    </span>
  );
}

/** Badge distinguishing a company regular (🏢, by name) from an individual
 * (👤, identified by phone) — so the list reads unambiguously and de-duped. */
function ClientType({ isCompany, identifier }: { isCompany: boolean; identifier: string | null }) {
  if (isCompany) {
    return <span style={{ fontSize: 12, color: "var(--text-muted)" }}>🏢 Компанія</span>;
  }
  return (
    <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
      👤 Фізособа{identifier ? ` · ${identifier}` : ""}
    </span>
  );
}

export function LoyaltySection({
  auth,
  teams,
  loyaltyTeamId,
  setLoyaltyTeamId,
  loyaltyLoading,
  loyaltyData,
}: {
  auth: AuthPayload | null;
  teams: Team[];
  loyaltyTeamId: number | "";
  setLoyaltyTeamId: Dispatch<SetStateAction<number | "">>;
  loyaltyLoading: boolean;
  loyaltyData: LoyaltyManager[];
}) {
  // Адмін: ручні правки постійних (прибрати/передати) + список менеджерів для передачі.
  const isAdmin = auth?.role === "admin";
  const [overrides, setOverrides] = useState<LoyaltyOverride[]>([]);
  const [allManagers, setAllManagers] = useState<ManagerOption[]>([]);
  const reloadOverrides = () => { fetchLoyaltyOverrides().then(setOverrides).catch(() => setOverrides([])); };
  useEffect(() => {
    if (!isAdmin) return;
    reloadOverrides();
    fetchManagerOptions().then(setAllManagers).catch(() => setAllManagers([]));
  }, [isAdmin]);
  const bumpOverrides = () => { reloadOverrides(); /* дані оновляться на наступному 5-хв рефреші дашборду */ };
  return (
    <>
      {/* ФАЗА A/B · новий екран за макетом.
          🪦 ПРИБРАНО 04.08.2026 (рішення власника) ТРИ БЛОКИ СТАРОГО ПОКОЛІННЯ:
            (а) «🔄 Реактивація — клієнти в роботі» (ручна таблиця 1-й/2-й контакт) —
                заміна: «Реактивація · сплячі та втрачені» з задачами й причиною закриття;
            (б) «Усі постійні клієнти (усі команди)» — заміна: «Постійні клієнти · план
                місяця» з ієрархією команда → менеджер → клієнти;
            (в) «Динаміка повторних оплат (12 міс.)» — заміна: гістограма 12 міс. У КАРТЦІ
                КЛІЄНТА (по канонічному ключу), а не однією цифрою по всьому зрізу.
          🔴 РАЗОМ ІЗ (а) прибрано кнопки «➕ в реактивацію» в картках менеджерів нижче:
          вони писали в `reactivation_clients` — таблицю, якої більше НІХТО не показує.
          Лишити їх означало б робити дані, які нікуди не потрапляють; це гірше за
          відсутність кнопки. Роути в DEAD_ROUTE_CANDIDATES, дані не чіпаємо. */}
      {auth && <ClientPlansSection auth={auth} />}
      {auth && <div style={{ height: 22 }} />}
      {auth && <ReactivationSection auth={auth} />}
      {auth && <div style={{ height: 22 }} />}

      <div className="page-header">
        <h1 className="page-title">Клієнти: постійні та реактивація</h1>
        {auth?.role !== "manager" && (
          <div className="page-filters">
            <select
              value={loyaltyTeamId}
              onChange={(e) => setLoyaltyTeamId(e.target.value ? Number(e.target.value) : "")}
            >
              {teamOptions(teams)}
            </select>
          </div>
        )}
      </div>

      {isAdmin && overrides.length > 0 && (
        <div className="chart-card" style={{ marginBottom: 16, borderLeft: "3px solid #d97706" }}>
          <h2 className="chart-title" style={{ marginBottom: 6 }}>🔧 Ручні правки постійних ({overrides.length})</h2>
          <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 8px" }}>
            Ручні зміни поверх авто-логіки. «Скасувати» повертає авто-визначення.
          </p>
          <div style={{ overflowX: "auto" }}>
            <table className="data-table compact" style={{ fontSize: 12 }}>
              <thead><tr><th style={{ textAlign: "left" }}>Клієнт</th><th>Дія</th><th style={{ textAlign: "left" }}>Деталі</th><th /></tr></thead>
              <tbody>
                {overrides.map((o) => (
                  <tr key={o.clientKey}>
                    <td style={{ textAlign: "left" }}>{o.clientName ?? o.clientKey}</td>
                    <td>{o.hidden ? "🗑 прибрано" : o.pinnedManagerId ? "↪ передано" : o.forceRegular ? "➕ додано" : "—"}</td>
                    <td style={{ textAlign: "left", color: "var(--text-muted)" }}>{o.pinnedManagerName ? `→ ${o.pinnedManagerName}` : ""}</td>
                    <td>
                      <button onClick={() => removeLoyaltyOverride(o.clientKey).then(reloadOverrides)}
                        style={{ border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", borderRadius: 6, padding: "2px 10px", cursor: "pointer", fontSize: 12 }}>
                        Скасувати
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 🪦 RepeatPlanGrid прибрано 03.08.2026 (рішення власника). Він рахував факт
          ВЛАСНИМ SQL і додавав НЕДАТОВАНИЙ знімок етапу 9 — тобто метрику ②, якої на
          екрані клієнтів бути не повинно, і знімок, що мутує минулі місяці. Заміна —
          ClientPlansSection вище (факт ① з ядра). Роут /repeat-plans-grid лишається
          живим ще один спринт і стоїть у DEAD_ROUTE_CANDIDATES з датою перегляду:
          зникнення має бути рішенням, а не наслідком. */}

      {loyaltyLoading ? (
        <p className="loading-text">Завантаження...</p>
      ) : loyaltyData.length === 0 ? (
        <p className="loading-text">Немає даних.</p>
      ) : (
        <div className="chart-grid">
          {loyaltyData.map((m) => (
            <div className="chart-card" key={m.managerId}>
              <h2 className="chart-title">{m.managerName}</h2>
              <div className="kpi-grid">
                <div className="kpi-card">
                  <span className="kpi-label">Постійні (2+ за 2 міс.)</span>
                  <span className="kpi-value">{m.regularCount}</span>
                </div>
                <div className="kpi-card">
                  <span className="kpi-label">Разові (1 за 2 міс.)</span>
                  <span className="kpi-value">{m.occasionalCount}</span>
                </div>
                <div className="kpi-card">
                  <span className="kpi-label">Сплячі (реактивація)</span>
                  <span className="kpi-value">{m.sleepingCount}</span>
                </div>
                <div className="kpi-card">
                  <span className="kpi-label">Втрачені (&gt;6 міс.)</span>
                  <span className="kpi-value">{m.lostCount}</span>
                </div>
              </div>

              {([
                { key: "regular", label: "Постійні клієнти", list: m.segments.regular },
                { key: "sleeping", label: "Сплячі — кандидати на реактивацію", list: m.segments.sleeping },
                { key: "lost", label: "Втрачені — давно не замовляли", list: m.segments.lost },
              ] as const).map((group) => {
                return (
                  group.list.length > 0 && (
                    <details key={group.key} style={{ marginTop: 12 }}>
                      <summary style={{ cursor: "pointer", fontWeight: 600 }}>
                        {group.label} ({group.list.length})
                      </summary>
                      {/* Кнопки «➕ в реактивацію» прибрано разом зі старим грідом:
                          вони писали в таблицю, якої більше ніхто не показує.
                          Взяти клієнта в роботу тепер можна на екрані «Реактивація ·
                          сплячі та втрачені» — там задача, виконавець і причина. */}
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>Клієнт</th>
                            <th>Тип</th>
                            <th>За 2 міс.</th>
                            <th>Всього оплат</th>
                            <th>Остання оплата</th>
                            {isAdmin && group.key === "regular" && <th>Адмін</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {group.list.slice(0, 100).map((c) => (
                            <tr key={c.clientKey}>
                              <td>{c.clientName}</td>
                              <td><ClientType isCompany={c.isCompany} identifier={c.identifier} /></td>
                              <td>{c.orders}</td>
                              <td>{c.totalPaid}</td>
                              <td>
                                {c.lastPaid
                                  ? new Date(c.lastPaid).toLocaleDateString("uk-UA")
                                  : "—"}
                              </td>
                              {isAdmin && group.key === "regular" && (
                                <td>
                                  <AdminClientActions clientKey={c.clientKey} clientName={c.clientName} managers={allManagers} onDone={bumpOverrides} />
                                </td>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </details>
                  )
                );
              })}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
