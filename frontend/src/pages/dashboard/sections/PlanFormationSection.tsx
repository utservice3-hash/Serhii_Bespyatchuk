import { useEffect, useMemo, useState } from "react";
import {
  fetchPlanFormation, fetchFormationRepeatClients, submitFormationPlan, approveFormationPlan, returnFormationPlan,
  type PlanFormation, type PFManager, type PFTeam, type PFStatus, type PFRepeatBreakdown, type Team,
} from "../../../api";

// Палітра (тема-безпечна, статуси з іконкою+підписом — не колір-наодинці).
const GREEN = "#16a34a", AMBER = "#d97706", RED = "#dc2626", BAR = "#2f6fdb", PURPLE = "#7a52c7", MUTED = "var(--text-muted)";
const fmt = (n: number) => Math.round(n).toLocaleString("uk-UA").replace(/,/g, " ");
const k = (n: number) => Math.round(n / 1000) + "к";
const MN = ["січ", "лют", "бер", "кві", "тра", "чер", "лип", "сер", "вер", "жов", "лис", "гру"];
const MN_FULL = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
const MN_GEN = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
const mi = (ym: string) => Number(ym.slice(5, 7)) - 1;
const monLbl = (ym: string) => MN[mi(ym)];          // «лют» — підписи барів
const monFull = (ym: string) => MN_FULL[mi(ym)];    // «Липень» — заголовки сегментів
const monGen = (ym: string) => MN_GEN[mi(ym)];      // «липня» — «Перенесено з …»
const monthTitle = (ym: string) => `${MN_FULL[mi(ym)]} ${ym.slice(0, 4)}`;
const dm = (iso: string | null) => iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}` : (iso ?? "");
const curMonth = () => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}`; };

/**
 * «Виставлене» значення менеджера для ЖИВОЇ суми: пріоритет — те, що зараз у полі вводу
 * (drafts), далі подане/затверджене, і лише потім рекомендація. Саме так тімлід бачить
 * підсумок ще ДО подачі. Σ менеджерів = команда = компанія за побудовою: обидві суми
 * рахуються цією ж функцією над тим самим набором.
 */
function issuedOf(m: PFManager, drafts: Record<number, number>): number {
  const d = drafts[m.managerId];
  if (typeof d === "number" && Number.isFinite(d)) return d;
  return m.formation.proposedValue ?? m.recommendation.value;
}

// Стани картки: колір + іконка + підпис.
const ST: Record<PFStatus, { c: string; icon: string; label: string }> = {
  draft: { c: MUTED, icon: "●", label: "Чернетка" },
  submitted: { c: AMBER, icon: "⏳", label: "На затвердженні" },
  approved: { c: GREEN, icon: "✓", label: "Затверджено" },
  returned: { c: RED, icon: "↩", label: "Повернуто" },
};

export function PlanFormationSection({ auth, teams, previewData }: {
  auth: { role: string; managerId: number | null; teamId: number | null };
  teams: Team[];
  previewData?: PlanFormation;   // лише для офлайн-скріншот-гейта (Phase 3): пропускає fetch
}) {
  const [month, setMonth] = useState<string>(() => previewData?.month || localStorage.getItem("pfMonth") || curMonth());
  const [teamFilter, setTeamFilter] = useState<number | "">("");
  const [growth, setGrowth] = useState<number>(10);
  const [data, setData] = useState<PlanFormation | null>(previewData ?? null);
  const [loading, setLoading] = useState(!previewData);
  const [err, setErr] = useState<string | null>(null);
  const [openTeams, setOpenTeams] = useState<Set<string>>(new Set());
  const [reload, setReload] = useState(0);
  // ЖИВІ значення полів вводу (managerId → ₴). Підняті сюди, бо сума команди й компанії
  // має оновлюватись ПІД ЧАС набору, ще до подачі — інакше тімлід рахує в голові.
  const [drafts, setDrafts] = useState<Record<number, number>>({});
  const setDraft = (id: number, v: number) => setDrafts((p) => (p[id] === v ? p : { ...p, [id]: v }));

  const setMonthP = (v: string) => { setMonth(v); localStorage.setItem("pfMonth", v); };
  const shiftMonth = (d: number) => { const [y, m] = month.split("-").map(Number); const nd = new Date(y, m - 1 + d, 1); setMonthP(`${nd.getFullYear()}-${String(nd.getMonth() + 1).padStart(2, "0")}`); };

  useEffect(() => {
    if (previewData) { setData(previewData); setOpenTeams(new Set(previewData.teams.slice(0, 1).map((t) => String(t.teamId ?? "none")))); setLoading(false); return; }
    let alive = true; setLoading(true); setErr(null);
    fetchPlanFormation(month, teamFilter ? Number(teamFilter) : undefined, growth / 100)
      .then((d) => { if (!alive) return; setData(d); setOpenTeams((prev) => prev.size ? prev : new Set(d.teams.slice(0, 1).map((t) => String(t.teamId ?? "none")))); })
      .catch(() => alive && setErr("Не вдалося завантажити формування плану."))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [month, teamFilter, growth, reload]);
  // Нові дані (інший місяць/команда) → чернетки скидаємо, інакше показували б чужі суми.
  useEffect(() => { setDrafts({}); }, [month, teamFilter]);

  const refresh = () => setReload((n) => n + 1);
  const teamOpts = useMemo(() => teams.filter((t) => !new Set([11, 12]).has(t.id)), [teams]);

  return (
    <div style={{ maxWidth: 1180, margin: "0 auto" }}>
      {/* Хедер */}
      <div style={{ marginBottom: 12 }}>
        <h1 style={{ fontSize: 22, margin: 0, display: "flex", alignItems: "center", gap: 9 }}>💼 Формування плану · {monthTitle(month + "-01")}</h1>
        <div style={{ color: MUTED, fontSize: 13, marginTop: 5, maxWidth: 960, lineHeight: 1.5 }}>
          Історія «успішно реалізовано» за <b>6 місяців</b> · рекомендація рахується на <b>останніх 3</b> (підсвічені) +ріст%.
          Постійні клієнти розкриваються з сумою та динамікою по кожному. <b>Тімлід формує і подає план зі своїм обґрунтуванням, КВП (адмін) затверджує або повертає.</b>{" "}
          Живим (Звіт/КВП/плани) стає лише затверджений план.
        </div>
      </div>

      <ProcessLegend />

      {/* Фільтри */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", margin: "12px 0 16px" }}>
        {auth.role === "admin" && (
          <select value={teamFilter} onChange={(e) => setTeamFilter(e.target.value ? Number(e.target.value) : "")}
            style={{ padding: "7px 12px", borderRadius: 9, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", fontWeight: 600 }}>
            <option value="">Усі команди</option>
            {teamOpts.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        )}
        <div style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "var(--bg)", padding: 4, borderRadius: 10 }}>
          <button onClick={() => shiftMonth(-1)} style={navBtn}>◀</button>
          <span style={{ fontWeight: 700, fontSize: 14, minWidth: 120, textAlign: "center" }}>{monthTitle(month + "-01")}</span>
          <button onClick={() => shiftMonth(1)} style={navBtn}>▶</button>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13, color: MUTED }}>
            Ріст:
            <span style={{ display: "inline-flex", alignItems: "center", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden", background: "var(--card-bg)" }}>
              <input type="number" value={growth} min={0} max={100} onChange={(e) => setGrowth(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
                style={{ width: 52, padding: "6px 8px", border: "none", background: "transparent", color: "var(--text)", fontWeight: 700, textAlign: "right" }} />
              <span style={{ padding: "6px 8px", color: MUTED }}>%</span>
            </span>
          </label>
          <span style={{ fontSize: 12, color: MUTED, background: "var(--card-bg)", border: "1px solid var(--border)", padding: "5px 11px", borderRadius: 20 }}>
            Ти: <b style={{ color: "var(--text)" }}>{roleTag(auth.role)}</b>
          </span>
        </div>
      </div>

      {err && <p style={{ color: RED }}>{err}</p>}
      {loading && !data && <p style={{ color: MUTED }}>Завантаження…</p>}

      {data && data.teams.map((t) => (
        <TeamBlock key={String(t.teamId ?? "none")} team={t} month={month} data={data}
          drafts={drafts} setDraft={setDraft}
          open={openTeams.has(String(t.teamId ?? "none"))}
          onToggle={() => setOpenTeams((p) => { const n = new Set(p); const key = String(t.teamId ?? "none"); n.has(key) ? n.delete(key) : n.add(key); return n; })}
          onChanged={refresh} />
      ))}
      {data && data.teams.length === 0 && !loading && <p style={{ color: MUTED }}>Немає команд у цьому скоупі.</p>}

      {/* ПІДСУМОК ПО КОМПАНІЇ — для КВП/ОД: це фактично майбутній план компанії, бо з
          наступного місяця він рахується з виставлених. Σ команд = компанія за побудовою
          (обидві суми беруть ті самі значення менеджерів). */}
      {data && data.canApprove && data.teams.length > 1 && (() => {
        const all = data.teams.flatMap((t) => t.managers);
        const total = all.reduce((a, m) => a + issuedOf(m, drafts), 0);
        return (
          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", marginTop: 14,
                        background: "var(--card-bg)", border: `1px solid ${BAR}55`, borderRadius: 14, padding: "14px 18px" }}>
            <b style={{ fontSize: 14 }}>🏢 ВИСТАВЛЕНО ПО КОМПАНІЇ</b>
            <b style={{ fontSize: 22, color: BAR }}>{fmt(total)} ₴</b>
            <span style={{ fontSize: 12, color: MUTED }}>
              {data.teams.length} команд · {all.length} менеджерів · оновлюється наживо під час введення
            </span>
          </div>
        );
      })()}

      <RoleNote />
    </div>
  );
}

const navBtn: React.CSSProperties = { padding: "6px 11px", borderRadius: 7, border: "none", background: "var(--card-bg)", color: "var(--text)", cursor: "pointer", fontWeight: 700 };
const roleTag = (r: string) => r === "admin" ? "КВП / адмін · затверджуєш або повертаєш" : r === "team_lead" ? "тімлід · формуєш і подаєш" : "менеджер · лише перегляд";

function ProcessLegend() {
  const chip = (c: string, icon: string, label: string, sub: string) => (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 700, fontSize: 12.5, padding: "3px 10px", borderRadius: 20, background: c + "22", color: c }}>
        <span>{icon}</span>{label}
      </span>
      <span style={{ fontSize: 12, color: MUTED }}>{sub}</span>
    </span>
  );
  const arrow = <span style={{ color: MUTED, margin: "0 4px" }}>→</span>;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 12, padding: "10px 14px" }}>
      <span style={{ fontWeight: 700, fontSize: 13, marginRight: 4 }}>Процес:</span>
      {chip(MUTED, "●", "Чернетка", "тімлід редагує")}{arrow}
      {chip(AMBER, "⏳", "На затвердженні", "подав тімлід")}{arrow}
      {chip(GREEN, "✓", "Затверджено", "КВП / адмін")}
      <span style={{ color: MUTED, margin: "0 2px" }}>або</span>
      {chip(RED, "↩", "Повернуто", "КВП на доопрацювання")}
    </div>
  );
}

function TeamBlock({ team, month, data, open, onToggle, onChanged, drafts, setDraft }: {
  team: PFTeam; month: string; data: PlanFormation; open: boolean; onToggle: () => void; onChanged: () => void;
  drafts: Record<number, number>; setDraft: (id: number, v: number) => void;
}) {
  const [busy, setBusy] = useState(false);
  const allApproved = team.approved >= team.total && team.total > 0;
  const approveAll = async () => {
    if (!data.canApprove || team.submitted === 0) return;
    setBusy(true);
    try { await approveFormationPlan({ teamId: team.teamId ?? undefined, month }); onChanged(); }
    finally { setBusy(false); }
  };
  const stat = (v: string, l: string) => (
    <div style={{ textAlign: "center", minWidth: 62 }}>
      <div style={{ fontWeight: 750, fontSize: 15, lineHeight: 1.1 }}>{v}</div>
      <div style={{ fontSize: 10.5, color: MUTED, textTransform: "uppercase", letterSpacing: ".3px", marginTop: 2 }}>{l}</div>
    </div>
  );
  return (
    <div style={{ background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 14, marginBottom: 14, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "15px 18px", cursor: "pointer", flexWrap: "wrap" }} onClick={onToggle}>
        <div style={{ fontWeight: 750, fontSize: 16, display: "flex", alignItems: "center", gap: 9, flex: 1, minWidth: 220 }}>
          <span style={{ color: MUTED, fontSize: 13 }}>{open ? "▼" : "▶"}</span>{team.teamName}
        </div>
        {/* ЖИВА сума виставленого — оновлюється під час набору, ще до подачі. */}
        <div style={{ minWidth: 96 }}>
          <div style={{ fontWeight: 800, fontSize: 20, lineHeight: 1.1, color: BAR }}>
            {fmt(team.managers.reduce((a, m) => a + issuedOf(m, drafts), 0))} ₴
          </div>
          <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>ВИСТАВЛЕНО</div>
        </div>
        {stat(k(team.recommended), "рекомендовано")}
        {stat(k(team.carryover), "перенесено")}
        {stat(`${team.approved} / ${team.total}`, "затверджено")}
        {stat(`${team.submitted} / ${team.total}`, "подано")}
        {data.canApprove && (
          <button onClick={(e) => { e.stopPropagation(); approveAll(); }} disabled={busy || team.submitted === 0 || allApproved}
            style={{ padding: "9px 16px", borderRadius: 10, border: "none", cursor: team.submitted && !allApproved ? "pointer" : "default",
              background: allApproved ? "var(--bg)" : team.submitted ? GREEN : "var(--bg)", color: allApproved || !team.submitted ? MUTED : "#fff", fontWeight: 700, fontSize: 13.5, whiteSpace: "nowrap" }}>
            {allApproved ? "Усе затверджено" : busy ? "…" : "✓ Затвердити подані"}
          </button>
        )}
      </div>
      {open && (
        <div style={{ borderTop: "1px solid var(--border)", padding: "6px 18px 18px" }}>
          {team.managers.map((m) => <ManagerCard key={m.managerId} m={m} month={month} data={data} onChanged={onChanged} onValue={setDraft} />)}
          {team.managers.length === 0 && <p style={{ color: MUTED, fontSize: 13, padding: "10px 0" }}>Немає активних менеджерів.</p>}
        </div>
      )}
    </div>
  );
}

function ManagerCard({ m, month, data, onChanged, onValue }: { m: PFManager; month: string; data: PlanFormation; onChanged: () => void; onValue?: (id: number, v: number) => void }) {
  const st = ST[m.formation.status];
  return (
    <div style={{ border: "1px solid var(--border)", borderLeft: `4px solid ${st.c}`, borderRadius: 12, marginTop: 12, padding: "15px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 750, fontSize: 15 }}>{m.name}</span>
        {m.teamName && <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 8px", borderRadius: 20, background: "var(--bg)", color: MUTED }}>{m.teamName}</span>}
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, fontWeight: 700, padding: "3px 10px", borderRadius: 20, background: st.c + "22", color: st.c }}>
          <span>{st.icon}</span>{st.label}
        </span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(230px,1fr) minmax(260px,1.15fr) minmax(280px,1.2fr)", gap: 18, alignItems: "start" }}>
        <HistorySeg m={m} />
        <ClientsSeg m={m} refMonth={data.refMonth} />
        <PlanSeg m={m} month={month} data={data} onChanged={onChanged} onValue={onValue} />
      </div>
    </div>
  );
}

const segTitle: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 10 };

function HistorySeg({ m }: { m: PFManager }) {
  const h = m.history;
  const max = Math.max(1, ...h.map((x) => x.revenue));
  const avg6 = h.length ? h.reduce((a, x) => a + x.revenue, 0) / h.length : 0;
  return (
    <div>
      <div style={segTitle}>Успішно реалізовано · 6 міс</div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 7, height: 96 }}>
        {h.map((x, i) => {
          const base = i >= h.length - 3;            // останні 3 — база рекомендації (підсвічені)
          return (
            <div key={x.month} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }} title={`${fmt(x.revenue)} ₴ · ${x.deals} угод`}>
              <span style={{ fontSize: 10.5, fontWeight: 700, color: base ? "var(--text)" : MUTED }}>{k(x.revenue)}</span>
              <div style={{ width: "100%", maxWidth: 30, height: Math.max(3, (x.revenue / max) * 62), borderRadius: "4px 4px 0 0", background: base ? BAR : "var(--border)" }} />
              <span style={{ fontSize: 10, color: MUTED }}>{monLbl(x.month)}</span>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 12, color: MUTED, marginTop: 10 }}>
        Середнє 6 міс: <b style={{ color: "var(--text)" }}>{k(avg6)}</b> · база (3 міс): <b style={{ color: BAR }}>{k(m.recommendation.baseMonthlyAvg)}</b>
        {m.recommendation.sparseHistory && <span style={{ color: AMBER }}> · ⚠ неповна історія</span>}
      </div>
      <div style={{ fontSize: 11.5, color: BAR, marginTop: 3 }}>▸ рекомендація на останніх 3 міс</div>
    </div>
  );
}

function ClientsSeg({ m, refMonth }: { m: PFManager; refMonth: string }) {
  const [open, setOpen] = useState(false);
  const [bd, setBd] = useState<PFRepeatBreakdown | null>(null);
  const [loading, setLoading] = useState(false);
  const c = m.clients;
  const toggle = () => {
    const nx = !open; setOpen(nx);
    if (nx && !bd && !loading) {
      setLoading(true);
      // 🔴 Розклад постійних — за РЕФЕРЕНСНИМ місяцем (той самий, що клієнт-спліт вище),
      // НЕ за target-місяцем (той ще не настав/неповний → список був би порожній ≠ «54·88к»).
      fetchFormationRepeatClients(m.managerId, refMonth).then(setBd).catch(() => setBd(null)).finally(() => setLoading(false));
    }
  };
  const row = (dot: string, label: string, cs: { count: number; sum: number }, extra?: React.ReactNode) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", fontSize: 13 }}>
      <span style={{ width: 9, height: 9, borderRadius: "50%", background: dot, flex: "0 0 auto" }} />
      <span style={{ fontWeight: 600 }}>{label}</span>
      {extra}
      <span style={{ marginLeft: "auto", fontWeight: 700 }}>{cs.count}</span>
      <span style={{ color: MUTED, fontSize: 12 }}>· {k(cs.sum)} ₴</span>
    </div>
  );
  return (
    <div>
      <div style={segTitle}>Клієнти · {monFull(refMonth)}</div>
      {/* 🔴 РОЗБІЖНІСТЬ ПОКАЗУЄМО, А НЕ ХОВАЄМО (рішення власника 03.08.2026).
          Ручне поле «постійні принесуть» лишається як є; Σ ЗАТВЕРДЖЕНИХ планів по
          клієнтах стоїть поруч довідково. Якщо вони не збігаються — це видно
          бейджем, а не з'ясовується постфактум, коли план уже затверджено. */}
      {m.repeatClients && (m.repeatClients.declared > 0 || m.repeatClients.approved > 0) && (
        <div style={{ margin: "4px 0 8px", padding: "6px 9px", borderRadius: 8, fontSize: 12, lineHeight: 1.5,
          background: m.repeatClients.declared === m.repeatClients.approved ? "var(--surface-2, #f8fafc)" : "#fffbeb",
          border: `1px solid ${m.repeatClients.declared === m.repeatClients.approved ? "var(--border)" : "#fcd34d"}` }}>
          {m.repeatClients.declared === m.repeatClients.approved ? (
            <>✓ «Постійні принесуть» {k(m.repeatClients.declared)} ₴ — збігається з Σ затверджених
              планів по {m.repeatClients.approvedClients} клієнтах.</>
          ) : (
            <><b>⚠️ Заявлено {k(m.repeatClients.declared)} ₴</b>, затверджено по клієнтах{" "}
              <b>{k(m.repeatClients.approved)} ₴</b> ({m.repeatClients.approvedClients} кл.)
              {m.repeatClients.entered !== m.repeatClients.approved &&
                <> · ще не погоджено {k(m.repeatClients.entered - m.repeatClients.approved)} ₴</>}
              . Ручне поле лишається як є — це орієнтир, а не помилка.</>
          )}
        </div>
      )}
      {row(GREEN, "Постійні", c.repeat, (
        <button onClick={toggle} style={{ background: "none", border: "none", color: BAR, cursor: "pointer", fontSize: 12, padding: 0 }}>
          {open ? "▲ згорнути" : "▼ розгорнути"}
        </button>
      ))}
      {open && (
        <div style={{ margin: "2px 0 6px 17px", paddingLeft: 10, borderLeft: "2px solid var(--border)" }}>
          {loading && <div style={{ fontSize: 12, color: MUTED, padding: "4px 0" }}>Завантаження…</div>}
          {bd && <RepeatList bd={bd} />}
        </div>
      )}
      {row(PURPLE, "Лідоген", c.leadgen)}
      {row(BAR, "Нові", c.new)}
      {c.undef.count > 0 && row(MUTED, "Невизн.", c.undef)}
      <div style={{ fontSize: 12, color: MUTED, marginTop: 8, borderTop: "1px solid var(--border)", paddingTop: 7 }}>
        Перенесено з {monGen(refMonth)}: <b style={{ color: "var(--text)" }}>{k(m.carryover)} ₴</b>
      </div>
    </div>
  );
}

function RepeatList({ bd }: { bd: PFRepeatBreakdown }) {
  const max = Math.max(1, ...bd.clients.map((c) => c.revenue), bd.rest.revenue);
  const delta = (d: number | null) => {
    if (d == null) return <span style={{ color: MUTED, fontSize: 11 }}>новий</span>;
    const up = d > 0, flat = d === 0;
    return <span style={{ color: flat ? MUTED : up ? GREEN : RED, fontSize: 11, fontWeight: 700 }}>{flat ? "— 0%" : `${up ? "▲" : "▼"}${Math.abs(d)}%`}</span>;
  };
  return (
    <div style={{ display: "grid", gap: 5, padding: "4px 0" }}>
      {bd.clients.map((c) => (
        <div key={c.clientKey || c.name} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
          <span style={{ flex: "0 0 96px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={c.name}>{c.name}</span>
          <span style={{ flex: 1, height: 6, background: "var(--border)", borderRadius: 4, overflow: "hidden" }}>
            <span style={{ display: "block", width: `${(c.revenue / max) * 100}%`, height: "100%", background: GREEN, borderRadius: 4 }} />
          </span>
          <span style={{ fontWeight: 700, minWidth: 54, textAlign: "right" }}>{fmt(c.revenue)}</span>
          <span style={{ color: MUTED, minWidth: 44 }}>{c.orders} зам.</span>
          <span style={{ minWidth: 42, textAlign: "right" }}>{delta(c.deltaPct)}</span>
        </div>
      ))}
      {bd.rest.count > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: MUTED }}>
          <span style={{ flex: "0 0 96px" }}>+ ще {bd.rest.count} клієнт{bd.rest.count > 4 ? "ів" : "и"}</span>
          <span style={{ flex: 1, height: 6, background: "var(--border)", borderRadius: 4, overflow: "hidden" }}>
            <span style={{ display: "block", width: `${(bd.rest.revenue / max) * 100}%`, height: "100%", background: "var(--border)", borderRadius: 4 }} />
          </span>
          <span style={{ fontWeight: 700, minWidth: 54, textAlign: "right", color: "var(--text)" }}>{fmt(bd.rest.revenue)}</span>
          <span style={{ minWidth: 44 }} />
          <span style={{ minWidth: 42 }} />
        </div>
      )}
    </div>
  );
}

function PlanSeg({ m, month, data, onChanged, onValue }: { m: PFManager; month: string; data: PlanFormation; onChanged: () => void; onValue?: (id: number, v: number) => void }) {
  const f = m.formation;
  const rec = m.recommendation;
  const [val, setVal] = useState<string>(String(f.proposedValue ?? rec.value));
  const [busy, setBusy] = useState(false);
  const [returning, setReturning] = useState(false);
  const [retComment, setRetComment] = useState("");
  const [comment, setComment] = useState("");
  useEffect(() => { setVal(String(f.proposedValue ?? rec.value)); }, [f.proposedValue, rec.value]);
  const num = () => Number(String(val).replace(/[^\d.-]/g, "")) || 0;
  // Живий підйом значення нагору → сума команди/компанії рахується під час набору.
  useEffect(() => { onValue?.(m.managerId, num()); }, [val, m.managerId]);

  // МʼЯКА НИЖНЯ МЕЖА (з налаштувань): нижче мінімуму подача лише з обґрунтуванням.
  const minPer = data.minPerManager ?? 0;
  const belowMin = minPer > 0 && num() < minPer;
  const hasReason = Boolean((comment || f.comment || "").trim());
  const blockSubmit = belowMin && !hasReason;

  const doSubmit = async () => { setBusy(true); try { await submitFormationPlan(m.managerId, month, num(), comment || undefined); onChanged(); } finally { setBusy(false); } };
  const doApprove = async () => { setBusy(true); try {
    if (f.status !== "submitted" || num() !== (f.proposedValue ?? 0)) await submitFormationPlan(m.managerId, month, num(), f.comment || comment || undefined);
    await approveFormationPlan({ managerId: m.managerId, month }); onChanged();
  } finally { setBusy(false); } };
  const doReturn = async () => { setBusy(true); try { await returnFormationPlan(m.managerId, month, retComment || undefined); setReturning(false); onChanged(); } finally { setBusy(false); } };

  const canSubmit = data.canSubmit;   // тімлід/адмін своєї команди
  const canApprove = data.canApprove; // лише адмін

  const subtitle = (
    <div style={{ fontSize: 11.5, color: MUTED, marginTop: 3 }}>
      база {k(rec.baseMonthlyAvg)}/міс → {fmt(rec.perWorkingDay)} ₴/день × {rec.targetWorkingDays} роб. дні × {(1 + rec.growthPct).toFixed(2)}
    </div>
  );
  const input = (
    <input value={val} onChange={(e) => setVal(e.target.value)} inputMode="numeric"
      style={{ width: 120, padding: "8px 10px", borderRadius: 9, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", fontWeight: 700, fontSize: 15, textAlign: "right" }} />
  );
  const btn = (label: string, color: string, onClick: () => void, solid = true, off = false) => (
    <button onClick={onClick} disabled={busy || off} title={off ? `Нижче мінімуму ${fmt(minPer)} ₴ — вкажи обґрунтування` : undefined}
      style={off ? { padding: "9px 14px", borderRadius: 9, border: "1px solid var(--border)", cursor: "not-allowed",
        background: "var(--bg)", color: MUTED, fontWeight: 700, fontSize: 13.5 } : undefined}
      {...(off ? {} : { style: { padding: "9px 14px", borderRadius: 9, border: solid ? "none" : `1px solid ${color}`, cursor: "pointer",
        background: solid ? color : "transparent", color: solid ? "#fff" : color, fontWeight: 700, fontSize: 13.5 } })}>{busy ? "…" : label}</button>
  );

  return (
    <div>
      <div style={segTitle}>План · {monFull(month + "-01")}</div>

      {/* Головне число: рекомендація (draft/submitted/returned) АБО затверджене (approved) */}
      {f.status === "approved" ? (
        <div style={{ background: GREEN + "12", border: `1px solid ${GREEN}55`, borderRadius: 12, padding: "12px 14px" }}>
          <div style={{ fontSize: 26, fontWeight: 800, color: "var(--text)" }}>{fmt(f.proposedValue ?? 0)} <span style={{ fontSize: 14, fontWeight: 600 }}>₴</span></div>
          <div style={{ fontSize: 12, color: GREEN, fontWeight: 600, marginTop: 2 }}>затверджено КВП · діє скрізь (Звіт/КВП/плани)</div>
        </div>
      ) : (
        <div style={{ background: BAR + "0d", border: "1px solid var(--border)", borderRadius: 12, padding: "12px 14px" }}>
          <div style={{ fontSize: 26, fontWeight: 800 }}>{fmt(rec.value)} <span style={{ fontSize: 13, fontWeight: 600, color: MUTED }}>₴ рекоменд.</span></div>
          {subtitle}
        </div>
      )}

      {/* Пропозиція тімліда (є, коли подано/затверджено) */}
      {(f.status === "submitted" || f.status === "approved") && f.proposedValue != null && (
        <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "10px 12px", marginTop: 10 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: ".4px" }}>Пропозиція тімліда</div>
          <div style={{ fontSize: 18, fontWeight: 800, marginTop: 2, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span>{fmt(f.proposedValue)} ₴</span>
            {f.status === "approved" && <span style={{ color: GREEN }}>✓</span>}
            {/* Бейдж винятку — щоб затверджувач бачив, що план свідомо нижчий за мінімум,
                і одразу поруч читав обґрунтування (нижче в тому ж блоці). */}
            {f.belowMin && (
              <span title={`Нижче мінімуму ${fmt(minPer)} ₴ — подано як виняток з обґрунтуванням`}
                style={{ fontSize: 10.5, fontWeight: 800, padding: "2px 9px", borderRadius: 20, cursor: "help",
                         background: "rgba(217,119,6,0.16)", color: AMBER }}>
                ⚠️ нижче мінімуму
              </span>
            )}
          </div>
          {f.comment && <div style={{ fontSize: 12.5, color: "var(--text)", fontStyle: "italic", marginTop: 4 }}>«{f.comment}»</div>}
          <div style={{ fontSize: 11.5, color: MUTED, marginTop: 4 }}>
            {f.submittedBy}{f.submittedAt ? ` · подав ${dm(f.submittedAt)}` : ""}{f.decidedBy && f.status === "approved" ? ` · КВП затвердив ${dm(f.decidedAt)}` : ""}
          </div>
        </div>
      )}

      {/* Повернуто — коментар КВП */}
      {f.status === "returned" && (
        <div style={{ background: RED + "10", border: `1px solid ${RED}44`, borderRadius: 10, padding: "10px 12px", marginTop: 10 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: RED, textTransform: "uppercase", letterSpacing: ".4px" }}>↩ Повернуто КВП</div>
          {f.returnComment && <div style={{ fontSize: 12.5, color: "var(--text)", fontStyle: "italic", marginTop: 4 }}>«{f.returnComment}»</div>}
          <div style={{ fontSize: 11.5, color: MUTED, marginTop: 4 }}>КВП{f.decidedAt ? ` · ${dm(f.decidedAt)}` : ""} · чекає нову пропозицію тімліда</div>
        </div>
      )}

      {/* Дії за роллю і станом */}
      <div style={{ marginTop: 12 }}>
        {returning ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <textarea value={retComment} onChange={(e) => setRetComment(e.target.value)} placeholder="Причина повернення…" rows={2}
              style={{ padding: "8px 10px", borderRadius: 9, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", fontSize: 13, resize: "vertical" }} />
            <div style={{ display: "flex", gap: 8 }}>{btn("↩ Повернути тімліду", RED, doReturn)}<button onClick={() => setReturning(false)} style={{ ...ghostBtn }}>Скасувати</button></div>
          </div>
        ) : (
          <>
            {/* submitted → адмін затверджує/повертає */}
            {f.status === "submitted" && canApprove && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>{input}{btn("✓ Затвердити", GREEN, doApprove)}{btn("↩ Повернути", RED, () => setReturning(true), false)}</div>
            )}
            {/* submitted, не адмін → чекаємо КВП */}
            {f.status === "submitted" && !canApprove && (
              <div style={{ fontSize: 12.5, color: AMBER }}>⏳ подано · очікує рішення КВП</div>
            )}
            {/* draft → тімлід/адмін формує і подає */}
            {f.status === "draft" && canSubmit && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {belowMin && (
                  <div style={{ fontSize: 12, color: AMBER, background: "rgba(217,119,6,0.1)", border: "1px solid rgba(217,119,6,0.3)",
                                borderRadius: 8, padding: "7px 10px" }}>
                    ⚠️ Нижче мінімуму <b>{fmt(minPer)} ₴</b>. Це допускається (напр. менеджер вийшов у середині місяця),
                    але потрібне обґрунтування — інакше подати не можна.
                  </div>
                )}
                <input value={comment} onChange={(e) => setComment(e.target.value)}
                  placeholder={belowMin ? "Обґрунтування (обовʼязково — план нижчий за мінімум)…" : "Обґрунтування (необовʼязково)…"}
                  style={{ padding: "7px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", fontSize: 12.5 }} />
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>{input}{btn("Подати", BAR, doSubmit, true, blockSubmit)}</div>
              </div>
            )}
            {/* returned → тімлід/адмін переробляє і подає знову */}
            {f.status === "returned" && canSubmit && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {belowMin && (
                  <div style={{ fontSize: 12, color: AMBER }}>⚠️ Нижче мінімуму {fmt(minPer)} ₴ — потрібне обґрунтування.</div>
                )}
                {belowMin && !f.comment && (
                  <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Обґрунтування (обовʼязково)…"
                    style={{ padding: "7px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", fontSize: 12.5 }} />
                )}
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>{input}{btn("↑ Подати знову", RED, doSubmit, true, blockSubmit)}</div>
              </div>
            )}
            {/* approved → адмін може змінити; інші — read-only */}
            {f.status === "approved" && canApprove && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>{input}{btn("Змінити", MUTED, doApprove, false)}</div>
            )}
            {f.status === "approved" && !canApprove && (
              <div style={{ fontSize: 12.5, color: GREEN }}>✓ затверджено · діє з 01.{month.slice(5, 7)}</div>
            )}
            {/* менеджер (не canSubmit) на неспетверджених — лише перегляд */}
            {!canSubmit && f.status !== "approved" && f.status !== "submitted" && (
              <div style={{ fontSize: 12.5, color: MUTED }}>план формується тімлідом</div>
            )}
          </>
        )}
        <div style={{ fontSize: 11.5, color: MUTED, marginTop: 8 }}>
          поточний план: <b style={{ color: "var(--text)" }}>{k(m.currentPlan)}</b>{f.status === "returned" ? " · на боці тімліда" : f.status === "submitted" ? " · рішення КВП" : f.status === "approved" ? ` · діє з 01.${month.slice(5, 7)}` : ""}
        </div>
      </div>
    </div>
  );
}

const ghostBtn: React.CSSProperties = { padding: "9px 14px", borderRadius: 9, border: "1px solid var(--border)", background: "transparent", color: MUTED, fontWeight: 600, fontSize: 13.5, cursor: "pointer" };

function RoleNote() {
  return (
    <div style={{ background: "rgba(217,119,6,0.08)", border: "1px solid rgba(217,119,6,0.3)", borderRadius: 12, padding: "13px 16px", fontSize: 12.5, color: "var(--text)", lineHeight: 1.55, marginTop: 4 }}>
      <b>Ролі:</b> <b>Тімлід</b> формує план по кожному своєму менеджеру — редагує число (стартує з рекомендації), пише обґрунтування і <b>подає на затвердження</b> (● Чернетка → ⏳ На затвердженні).
      <b> КВП/адмін</b> бачить подані, <b>затверджує</b> (✓ живий скрізь: Звіт/КВП/плани) <b>або повертає</b> з коментарем (↩ Повернуто → тімлід переробляє). Менеджер бачить лише затверджений план.
      <b> Постійні клієнти</b> розкриваються списком: сума, к-сть замовлень і динаміка ± до попереднього місяця по кожному — видно, хто розганяється, а хто просідає.
      Рекомендація = денний темп (Σ won 3 міс ÷ Σ роб. дні) × роб. дні нового міс × +ріст%.
    </div>
  );
}
