import { useEffect, useState } from "react";
import {
  fetchSettings, saveSettings, type AppSettings,
  fetchUsers, createUser, provisionUsers, resetUserPassword, updateUser, reactivateUser, type DashboardUser,
  fetchRoles, createRole, updateRole, deleteRole, type RoleDef,
  fetchAudit, type AuditEntry,
  type Team, type SyncStatus,
} from "../../../api";
import { NAV_GROUPS } from "../../../components/Layout";

// Усі вкладки (ключ+назва) — беремо з реальної навігації, щоб screen_access-редактор
// точно збігався з тим, що гейтить сервер.
const SCREEN_TABS: { key: string; label: string }[] = NAV_GROUPS.flatMap((g) =>
  (g.items as readonly { key: string; label: string }[]).map((it) => ({ key: it.key, label: it.label }))
);
const PERMS: { key: string; label: string; hint?: string }[] = [
  { key: "admin_scope", label: "Рівень адміністратора", hint: "роль проходить усі admin-перевірки; раніше цей перелік був зашитий у коді" },
  { key: "approve_plans", label: "Затверджувати плани", hint: "пише в plans (зараз лише КВП/адмін)" },
  { key: "submit_plans", label: "Редагувати грід планів" },
  { key: "manage_goals", label: "Керувати цілями" },
  { key: "enter_manual_stats", label: "Вносити ручні показники статистик", hint: "бюджети/фінанси/HR" },
  { key: "manage_users", label: "Керувати користувачами й ролями", hint: "лише адмін" },
  { key: "reset_passwords", label: "Скидати паролі", hint: "окреме право; лише СЕО/ОД/адмін" },
  { key: "export", label: "Експорт у Excel / PDF" },
  { key: "view_hidden_payments", label: "Бачити приховані вихідні (Виписка)", hint: "інакше приховані отримувачі відсутні" },
  { key: "manage_bank_hidden", label: "Керувати списком прихованих (Виписка)" },
  { key: "manage_bank_accounts", label: "Керувати реквізитами рахунків (Виписка)" },
  { key: "view_balances", label: "Бачити баланси рахунків (Виписка)", hint: "кнопка «💰 Баланси» + залишки; лише адмін" },
  { key: "view_bank_totals", label: "Бачити підсумки виписки (Виписка)", hint: "картка агрегатів надходжень/платежів; лише адмін" },
  { key: "view_cashflow", label: "Бачити кешфлоу (Виписка)", hint: "помісячний рух коштів; admin + Фінансист" },
  { key: "view_all_1x1", label: "Наскрізний доступ до 1×1", hint: "усі типи/люди/історія/аналітика Ван-ту-ван; HR/СЕО/ОД" },
  { key: "edit_1x1_forms", label: "Редагувати питання 1×1", hint: "керувати наборами питань Ван-ту-ван у Налаштуваннях" },
];
const SCOPES: { key: "own" | "team" | "company"; label: string; sub: string }[] = [
  { key: "own", label: "Свої", sub: "лише власні" },
  { key: "team", label: "Команда", sub: "своя команда" },
  { key: "company", label: "Компанія", sub: "усі відділи" },
];
const SUBTABS = ["Загальні", "Користувачі", "Ролі та доступи", "Архів", "Журнал змін"] as const;
type Sub = (typeof SUBTABS)[number];

const RED = "#c8102e";
const err = (e: unknown) => (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? "Помилка";

function Toggle({ on, disabled, onClick }: { on: boolean; disabled?: boolean; onClick?: () => void }) {
  return (
    <button onClick={disabled ? undefined : onClick} disabled={disabled}
      style={{ width: 40, height: 22, borderRadius: 999, border: "none", position: "relative", flexShrink: 0,
        cursor: disabled ? "default" : "pointer", background: on ? "#16a34a" : "#cbd5e1", opacity: disabled ? 0.55 : 1, transition: "background .15s" }}>
      <span style={{ position: "absolute", top: 2, left: on ? 20 : 2, width: 18, height: 18, borderRadius: "50%", background: "#fff", transition: "left .15s" }} />
    </button>
  );
}

export default function SettingsSection({ role, teams, syncStatus, syncing, onManualSync }: {
  role?: string;
  teams: Team[];
  syncStatus: SyncStatus | null;
  syncing: boolean;
  onManualSync: () => void;
}) {
  const [sub, setSub] = useState<Sub>("Користувачі");
  const isAdminUx = role === "admin"; // лише UX-підказка; сервер гейтить 403 незалежно

  return (
    <div>
      <div className="page-header" style={{ marginBottom: 6 }}>
        <h1 className="page-title">⚙️ Налаштування · Користувачі, ролі та доступи</h1>
      </div>
      <p style={{ color: "var(--text-muted)", fontSize: 13.5, lineHeight: 1.5, marginTop: 0, maxWidth: 960 }}>
        Адмін заводить користувачів, створює ролі й налаштовує, які вкладки та які дані бачить кожна роль.
        Доступ контролюється <b>на сервері</b> — приховування вкладки це не безпека, тож кожна роль реально обмежена й у даних.
      </p>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "14px 0 18px" }}>
        {SUBTABS.map((s) => (
          <button key={s} onClick={() => setSub(s)}
            style={{ fontSize: 14, fontWeight: 700, padding: "9px 15px", borderRadius: 11, cursor: "pointer",
              border: sub === s ? "1px solid #1f2330" : "1px solid var(--border)",
              background: sub === s ? "#1f2330" : "var(--card-bg)", color: sub === s ? "#fff" : "var(--text)" }}>
            {s === "Загальні" ? "⚙️ " : s === "Користувачі" ? "👥 " : s === "Ролі та доступи" ? "🛡 " : s === "Архів" ? "🗄 " : "📜 "}{s}
          </button>
        ))}
      </div>

      {sub === "Загальні" && <GeneralTab syncStatus={syncStatus} syncing={syncing} onManualSync={onManualSync} canSync={role === "admin" || role === "team_lead"} />}
      {sub === "Користувачі" && <UsersTab teams={teams} isAdminUx={isAdminUx} />}
      {sub === "Ролі та доступи" && <RolesTab />}
      {sub === "Архів" && <ArchiveTab />}
      {sub === "Журнал змін" && <AuditTab />}
    </div>
  );
}

// ─────────────────────────── Загальні ───────────────────────────
function GeneralTab({ syncStatus, syncing, onManualSync, canSync }: { syncStatus: SyncStatus | null; syncing: boolean; onManualSync: () => void; canSync: boolean }) {
  const [form, setForm] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => { fetchSettings().then(setForm).catch(() => setForm(null)); }, []);
  const save = async () => { if (!form) return; setSaving(true); setSaved(false); try { await saveSettings(form); setSaved(true); } finally { setSaving(false); } };
  const NUMS = [
    { key: "loyaltyThreshold", label: "Поріг «постійного» (оплат)" },
    { key: "loyaltyWindowMonths", label: "Вікно, місяців" },
    { key: "sleepingWindowMonths", label: "Вікно «сплячих», місяців" },
    { key: "receivablesOverdueWarnDays", label: "Дебіторка: підсвічувати прострочення понад (днів)" },
    { key: "ratesFallbackFullPerKm", label: "Калькулятор: базовий тариф грн/км (ціла машина)" },
    { key: "ratesFallbackPartPerKm", label: "Калькулятор: базовий тариф грн/км (догруз)" },
  ] as const;
  return (
    <>
      {syncStatus && (
        <div className="chart-card" style={{ marginBottom: 16, borderLeft: `4px solid ${syncStatus.stale ? "#dc2626" : "#16a34a"}` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <h2 className="chart-title" style={{ marginBottom: 0 }}>Синхронізація з CRM</h2>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontWeight: 600, color: syncStatus.stale ? "#dc2626" : "#16a34a" }}>{syncStatus.stale ? "⚠️ Дані застаріли" : "🟢 Актуально"}</span>
              {canSync && <button onClick={onManualSync} disabled={syncing} style={{ padding: "6px 14px", borderRadius: 8, border: "none", background: syncing ? "#94a3b8" : RED, color: "#fff", fontWeight: 600, cursor: syncing ? "default" : "pointer" }}>{syncing ? "Синхронізація…" : "🔄 Синхронізувати зараз"}</button>}
            </div>
          </div>
          <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "8px 0 0" }}>
            Останнє оновлення: {syncStatus.lastSuccessAt ? `${new Date(syncStatus.lastSuccessAt).toLocaleString("uk-UA")} (${syncStatus.ageMinutes != null ? `${syncStatus.ageMinutes} хв тому` : "—"})` : "ще не було"}
          </p>
        </div>
      )}
      {!form ? <p className="loading-text">Завантаження…</p> : (
        <div className="chart-card">
          <h2 className="chart-title">Загальні параметри</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 14 }}>
            {NUMS.map((f) => (
              <label key={f.key} style={{ fontSize: 13, fontWeight: 600 }}>{f.label}
                <input type="number" value={form[f.key]} onChange={(e) => setForm({ ...form, [f.key]: Number(e.target.value) })}
                  style={{ display: "block", marginTop: 4, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", width: 140, background: "var(--card-bg)", color: "var(--text)" }} />
              </label>
            ))}
          </div>
          <div style={{ marginTop: 16, display: "flex", gap: 12, alignItems: "center" }}>
            <button onClick={save} disabled={saving} style={{ padding: "10px 20px", borderRadius: 8, border: "none", background: RED, color: "#fff", fontWeight: 700, cursor: "pointer" }}>{saving ? "Збереження…" : "Зберегти"}</button>
            {saved && <span style={{ color: "#16a34a" }}>✓ Збережено</span>}
          </div>
        </div>
      )}
    </>
  );
}

// ─────────────────────────── Користувачі ───────────────────────────
function UsersTab({ teams, isAdminUx }: { teams: Team[]; isAdminUx: boolean }) {
  const [users, setUsers] = useState<DashboardUser[]>([]);
  const [roles, setRoles] = useState<RoleDef[]>([]);
  const [issued, setIssued] = useState<Record<number, string>>({}); // показаний-раз пароль (reset)
  const [nf, setNf] = useState({ fullName: "", email: "", password: "", role: "manager", teamId: "" as number | "" });
  const [newCreds, setNewCreds] = useState<string | null>(null);
  const [provMsg, setProvMsg] = useState<string | null>(null);
  const [editName, setEditName] = useState<{ id: number; value: string } | null>(null); // інлайн-перейменування (лише не-CRM)

  const reload = () => fetchUsers(false).then(setUsers).catch(() => setUsers([]));
  useEffect(() => { reload(); fetchRoles().then(setRoles).catch(() => setRoles([])); }, []);
  const roleName = (key: string) => roles.find((r) => r.key === key)?.name ?? key;

  const create = async () => {
    if (!nf.email.trim()) return;
    try {
      const res = await createUser({ email: nf.email.trim(), password: nf.password || undefined, role: nf.role, teamId: nf.teamId || undefined, fullName: nf.fullName.trim() || undefined });
      setNewCreds(`${res.email} · ${res.password}`);
      setNf({ fullName: "", email: "", password: "", role: "manager", teamId: "" });
      await reload();
    } catch (e) { setNewCreds("✗ " + err(e)); }
  };
  const reset = async (id: number) => { try { const pw = await resetUserPassword(id); setIssued((s) => ({ ...s, [id]: pw })); } catch (e) { alert(err(e)); } };
  const setOverride = async (u: DashboardUser, val: string) => {
    const roleOverride = val === "__synced__" ? null : val;
    try { await updateUser(u.id, { roleOverride }); await reload(); } catch (e) { alert(err(e)); }
  };
  const [busy, setBusy] = useState<number | null>(null);
  // ⏱ Перемикач трекера. Оптимістично НЕ малюємо: спостереження за людиною —
  // не те місце, де можна показати «увімкнено», якщо сервер відмовив.
  const toggleTracker = async (id: number, on: boolean) => {
    setBusy(id);
    try { await updateUser(id, { trackerEnabled: on }); await reload(); }
    catch (e) { alert(err(e)); }
    finally { setBusy(null); }
  };
  const deactivate = async (u: DashboardUser) => { if (!window.confirm(`Деактивувати ${u.email}?`)) return; try { await updateUser(u.id, { isActive: false }); await reload(); } catch (e) { alert(err(e)); } };
  const provision = async () => { try { const c = await provisionUsers(); setProvMsg(c.length ? `Створено логінів: ${c.length}` : "Нових немає — усі вже створені"); await reload(); } catch (e) { setProvMsg("✗ " + err(e)); } };
  const saveName = async (u: DashboardUser) => {
    if (!editName || editName.id !== u.id) return;
    const v = editName.value.trim();
    if (!v) { alert("Ім'я не може бути порожнім"); return; }
    try { await updateUser(u.id, { fullName: v }); setEditName(null); await reload(); } catch (e) { alert(err(e)); }
  };

  return (
    <div className="chart-card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <h2 className="chart-title" style={{ marginBottom: 0 }}>Користувачі</h2>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>логіни авто-створюються з CRM · тут — ручне керування, ПІБ, пароль, роль, активність</span>
          <button onClick={provision} style={{ padding: "7px 13px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", cursor: "pointer", fontWeight: 600 }}>🔄 Синхронізувати з CRM</button>
        </div>
      </div>
      {provMsg && <div style={{ color: "#16a34a", fontSize: 13, marginTop: 6 }}>{provMsg}</div>}

      {/* Ручне заведення (окремо від CRM-синку) */}
      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1.4fr 1fr 1fr 1fr auto", gap: 10, alignItems: "end", margin: "14px 0", padding: 14, border: "1px solid var(--border)", borderRadius: 12, background: "var(--hover-bg, rgba(127,127,127,0.04))" }}>
        <L label="ПІБ"><input value={nf.fullName} onChange={(e) => setNf({ ...nf, fullName: e.target.value })} placeholder="Прізвище Ім'я По батькові" style={inp} /></L>
        <L label="E-MAIL (ЛОГІН)"><input value={nf.email} onChange={(e) => setNf({ ...nf, email: e.target.value })} placeholder="user@gmail.com" style={inp} /></L>
        <L label="ПАРОЛЬ"><input value={nf.password} onChange={(e) => setNf({ ...nf, password: e.target.value })} placeholder="авто, якщо порожньо" style={inp} /></L>
        <L label="РОЛЬ"><select value={nf.role} onChange={(e) => setNf({ ...nf, role: e.target.value })} style={inp}>{roles.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}</select></L>
        <L label="КОМАНДА"><select value={nf.teamId} onChange={(e) => setNf({ ...nf, teamId: e.target.value ? Number(e.target.value) : "" })} style={inp}><option value="">Без команди</option>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></L>
        <button onClick={create} style={{ padding: "9px 16px", borderRadius: 8, border: "none", background: RED, color: "#fff", fontWeight: 700, cursor: "pointer" }}>+ Створити</button>
      </div>
      {newCreds && <OneTimeCred text={newCreds} onClose={() => setNewCreds(null)} />}

      <table className="data-table">
        <thead><tr><th>ПІБ</th><th>E-MAIL</th><th>КОМАНДА</th><th>РОЛЬ</th><th>ПАРОЛЬ</th><th>АКТИВНИЙ</th><th title="Дозвіл трекеру часу збирати дані з машини цієї людини. Знімається так само просто, як ставиться.">⏱ ТРЕКЕР</th><th></th></tr></thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>
                {editName?.id === u.id ? (
                  <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                    <input autoFocus value={editName.value} onChange={(e) => setEditName({ id: u.id, value: e.target.value })}
                      onKeyDown={(e) => { if (e.key === "Enter") saveName(u); if (e.key === "Escape") setEditName(null); }}
                      style={{ ...inp, width: 180, padding: "4px 8px" }} />
                    <button onClick={() => saveName(u)} style={btn}>Зберегти</button>
                    <button onClick={() => setEditName(null)} style={{ ...btn, color: "var(--text-muted)" }}>Скасувати</button>
                  </span>
                ) : u.crm_linked ? (
                  <>{u.name ?? "—"} <CrmBadge /></>
                ) : (
                  <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                    {u.name ?? "—"}
                    <button onClick={() => setEditName({ id: u.id, value: u.name ?? "" })} title="Перейменувати" style={{ border: "none", background: "none", cursor: "pointer", fontSize: 12, opacity: 0.65 }}>✏️</button>
                  </span>
                )}
              </td>
              <td>{u.email}</td>
              <td>{u.team_name ?? "—"}</td>
              <td>
                <select value={u.role_override ?? "__synced__"} onChange={(e) => setOverride(u, e.target.value)}
                  title={u.crm_linked ? `Синкова роль із CRM: ${roleName(u.synced_role)}. Тут задаєте override (переважає).` : undefined}
                  style={{ borderRadius: 8, padding: "3px 8px", fontSize: 13, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", fontWeight: u.role_effective === "admin" ? 700 : 400 }}>
                  <option value="__synced__">{u.crm_linked ? `↺ синкована (${roleName(u.synced_role)})` : `↺ базова (${roleName(u.synced_role)})`}</option>
                  {roles.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
                </select>
              </td>
              <td style={{ fontFamily: "monospace" }}>{issued[u.id] ? <RevealCred text={issued[u.id]} /> : "••••••••"}</td>
              <td>{u.is_active ? "✓" : "—"}</td>
              {/* ⏱ Трекер: дозвіл на збір часу. Досі вмикався ЛИШЕ міграцією, тобто зняти
                  його з конкретної людини можна було тільки SQL-ом по проду. Для прапорця,
                  що вмикає спостереження за людиною, вимкнення має бути не важчим за вмикання. */}
              <td>
                <input
                  type="checkbox"
                  checked={u.tracker_enabled === true}
                  disabled={!u.is_active || busy === u.id}
                  title={u.is_active ? undefined : "Неактивний користувач — трекер і так не пустить"}
                  onChange={(e) => toggleTracker(u.id, e.target.checked)}
                  style={{ width: 16, height: 16, cursor: u.is_active ? "pointer" : "not-allowed" }}
                />
              </td>
              <td style={{ whiteSpace: "nowrap" }}>
                <button onClick={() => reset(u.id)} style={btn}>↺ Пароль</button>
                <button onClick={() => deactivate(u)} style={{ ...btn, color: "#dc2626" }}>Деактивувати</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!isAdminUx && <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>Ви бачите цей екран, бо сервер надав доступ; керування діє за правом <b>manage_users</b>.</p>}
    </div>
  );
}

// ─────────────────────────── Ролі та доступи ───────────────────────────
function RolesTab() {
  const [roles, setRoles] = useState<RoleDef[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [draft, setDraft] = useState<RoleDef | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const reload = () => fetchRoles().then((rs) => { setRoles(rs); setSel((cur) => cur ?? rs[0]?.key ?? null); }).catch(() => setRoles([]));
  useEffect(() => { reload(); }, []);
  useEffect(() => { const r = roles.find((x) => x.key === sel); setDraft(r ? JSON.parse(JSON.stringify(r)) : null); setMsg(null); }, [sel, roles]);

  const builtIn = !!draft?.built_in;
  const setScope = (s: "own" | "team" | "company") => draft && setDraft({ ...draft, data_scope: s });
  const tglTab = (k: string) => draft && setDraft({ ...draft, screen_access: { ...draft.screen_access, [k]: !draft.screen_access[k] } });
  const tglPerm = (k: string) => draft && setDraft({ ...draft, permissions: { ...draft.permissions, [k]: !draft.permissions[k] } });

  const save = async () => {
    if (!draft || builtIn) return;
    try { await updateRole(draft.key, { name: draft.name, dataScope: draft.data_scope, screenAccess: draft.screen_access, permissions: draft.permissions }); setMsg("✓ Збережено"); await reload(); }
    catch (e) { setMsg("✗ " + err(e)); }
  };
  const clone = async () => {
    if (!draft) return;
    const name = window.prompt("Назва нової ролі (клон з «" + draft.name + "»):", draft.name + " (копія)");
    if (!name) return;
    const key = window.prompt("Ключ (латиниця/цифри/_):", name.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 24));
    if (!key) return;
    try { await createRole({ key, name, cloneFrom: draft.key }); await reload(); setSel(key.replace(/[^a-z0-9_]/g, "")); }
    catch (e) { alert(err(e)); }
  };
  const newRole = async () => {
    const name = window.prompt("Назва нової ролі:"); if (!name) return;
    const key = window.prompt("Ключ (латиниця/цифри/_):", name.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 24)); if (!key) return;
    try { await createRole({ key, name, dataScope: "own", screenAccess: {}, permissions: {} }); await reload(); setSel(key.replace(/[^a-z0-9_]/g, "")); }
    catch (e) { alert(err(e)); }
  };
  const del = async () => {
    if (!draft || builtIn) return;
    if (!window.confirm(`Видалити роль «${draft.name}»?`)) return;
    try { await deleteRole(draft.key); setSel(null); await reload(); } catch (e) { alert(err(e)); }
  };

  return (
    <div className="chart-card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" }}>
        <h2 className="chart-title" style={{ marginBottom: 0 }}>Ролі та доступи</h2>
        <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>що бачить і що може кожна роль · зміни діють на сервері</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: 20, marginTop: 14 }}>
        {/* Список ролей */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {roles.map((r) => (
            <button key={r.key} onClick={() => setSel(r.key)}
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 12px", borderRadius: 10, cursor: "pointer", textAlign: "left",
                border: sel === r.key ? "1px solid #16a34a" : "1px solid var(--border)", background: sel === r.key ? "rgba(22,163,74,0.08)" : "var(--card-bg)", color: "var(--text)", fontWeight: 650 }}>
              <span>{r.name}</span>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{r.built_in ? "🔒 вбуд." : r.users_count}</span>
            </button>
          ))}
          <button onClick={newRole} style={{ padding: "9px 12px", borderRadius: 10, border: "1px dashed var(--border)", background: "transparent", color: RED, cursor: "pointer", fontWeight: 700 }}>+ Нова роль</button>
        </div>

        {/* Редактор */}
        {!draft ? <div style={{ color: "var(--text-muted)" }}>Оберіть роль.</div> : (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              {builtIn ? <b style={{ fontSize: 18 }}>{draft.name}</b>
                : <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} style={{ ...inp, fontSize: 16, fontWeight: 700, width: 260 }} />}
              <span style={{ fontSize: 11.5, fontWeight: 700, padding: "3px 9px", borderRadius: 999, background: builtIn ? "#e2e8f0" : "rgba(22,163,74,0.12)", color: builtIn ? "#475569" : "#16a34a" }}>{builtIn ? "🔒 вбудована" : "кастомна"}</span>
              {draft.cloned_from && <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>клон з «{draft.cloned_from}»</span>}
            </div>
            {builtIn && <p style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 6 }}>Вбудована роль — лише перегляд (редагувати/видаляти не можна; клонуйте, щоб змінити).</p>}

            <SectionLabel>ОБСЯГ ДАНИХ — ЧИЇ ПОКАЗНИКИ БАЧИТЬ</SectionLabel>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10 }}>
              {SCOPES.map((s) => (
                <button key={s.key} onClick={() => !builtIn && setScope(s.key)} disabled={builtIn}
                  style={{ textAlign: "left", padding: "12px 14px", borderRadius: 12, cursor: builtIn ? "default" : "pointer",
                    border: draft.data_scope === s.key ? "1px solid #2f6fdb" : "1px solid var(--border)", background: draft.data_scope === s.key ? "rgba(47,111,219,0.08)" : "var(--card-bg)", color: "var(--text)" }}>
                  <div style={{ fontWeight: 700 }}>{s.label} {draft.data_scope === s.key && "✓"}</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{s.sub}</div>
                </button>
              ))}
            </div>

            <SectionLabel>ДОСТУП ДО ВКЛАДОК</SectionLabel>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(230px,1fr))", gap: 10 }}>
              {SCREEN_TABS.map((t) => (
                <div key={t.key} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", border: "1px solid var(--border)", borderRadius: 10 }}>
                  <Toggle on={!!draft.screen_access[t.key]} disabled={builtIn} onClick={() => tglTab(t.key)} />
                  <span style={{ fontWeight: 600, fontSize: 13.5 }}>{t.label}{t.key === "settings" && " 🔒"}</span>
                </div>
              ))}
            </div>

            <SectionLabel>ПРАВА-ДІЇ</SectionLabel>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {PERMS.map((p) => (
                <div key={p.key} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <Toggle on={!!draft.permissions[p.key]} disabled={builtIn} onClick={() => tglPerm(p.key)} />
                  <span style={{ fontWeight: 600, fontSize: 13.5 }}>{p.label}</span>
                  {p.hint && <span style={{ fontSize: 12, color: "var(--text-muted)" }}>— {p.hint}</span>}
                </div>
              ))}
            </div>

            <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 18 }}>
              {!builtIn && <button onClick={save} style={{ padding: "10px 18px", borderRadius: 9, border: "none", background: "#16a34a", color: "#fff", fontWeight: 700, cursor: "pointer" }}>💾 Зберегти роль</button>}
              <button onClick={clone} style={{ padding: "10px 18px", borderRadius: 9, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", fontWeight: 600, cursor: "pointer" }}>Клонувати</button>
              {!builtIn && <button onClick={del} style={{ padding: "10px 18px", borderRadius: 9, border: "1px solid var(--border)", background: "var(--card-bg)", color: "#dc2626", fontWeight: 600, cursor: "pointer" }}>Видалити</button>}
              {msg && <span style={{ fontSize: 13, color: msg.startsWith("✓") ? "#16a34a" : "#dc2626" }}>{msg}</span>}
              {draft && <span style={{ marginLeft: "auto", fontSize: 12.5, color: "var(--text-muted)" }}>застосується до {draft.users_count} користувач(ів) одразу</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────── Архів ───────────────────────────
function ArchiveTab() {
  const [users, setUsers] = useState<DashboardUser[]>([]);
  const reload = () => fetchUsers(true).then(setUsers).catch(() => setUsers([]));
  useEffect(() => { reload(); }, []);
  const restore = async (id: number) => { try { await reactivateUser(id); await reload(); } catch (e) { alert(err(e)); } };
  return (
    <div className="chart-card">
      <h2 className="chart-title">Архів (деактивовані)</h2>
      <p style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 0 }}>
        Ручних користувачів можна відновити кнопкою. <b>CRM-менеджери</b> відновлюються лише поверненням у CRM — синк активує їх автоматично (кнопки немає навмисно).
      </p>
      {users.length === 0 ? <p className="loading-text">Порожньо.</p> : (
        <table className="data-table">
          <thead><tr><th>ПІБ</th><th>E-MAIL</th><th>ПРИЧИНА</th><th>КОЛИ</th><th>ДЖЕРЕЛО</th><th></th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.name ?? "—"}</td>
                <td>{u.email}</td>
                <td>{u.deactivated_reason ?? (u.crm_linked ? "зник із CRM" : "—")}</td>
                <td>{u.deactivated_at ? new Date(u.deactivated_at).toLocaleString("uk-UA") : "—"}</td>
                <td>{u.crm_linked ? <CrmBadge /> : "ручний"}</td>
                {/* 🔴 КНОПКА Є ДЛЯ ВСІХ, включно з CRM-менеджерами (рішення власника
                    06.08.2026). Раніше тут стояв напис «через CRM» — і він БРЕХАВ:
                    `syncKommo` таблицю `users` не чіпає взагалі, тож деактивований
                    CRM-менеджер не відновлювався ні сам, ні через інтерфейс. Разом із
                    guard-ом на бекенді це робило дію НЕЗВОРОТНОЮ: «вимкнути» працювало,
                    «увімкнути» — ні. Правило: дія, доступна в інтерфейсі, мусить бути
                    скасовною ТИМ САМИМ інтерфейсом. */}
                <td><button onClick={() => restore(u.id)} style={btn}>↺ Відновити</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ─────────────────────────── Журнал змін ───────────────────────────
function AuditTab() {
  const [rows, setRows] = useState<AuditEntry[]>([]);
  useEffect(() => { fetchAudit().then(setRows).catch(() => setRows([])); }, []);
  const label = (a: AuditEntry) => ({
    "user.create": "створив користувача", "user.update": "змінив користувача", "user.rename": "перейменував", "user.deactivate": "деактивував",
    "user.reactivate": "відновив", "user.reset_password": "скинув пароль", "role.create": "створив роль",
    "role.clone": "клонував роль", "role.update": "змінив роль", "role.delete": "видалив роль",
  } as Record<string, string>)[a.action] ?? a.action;
  return (
    <div className="chart-card">
      <h2 className="chart-title">Журнал змін</h2>
      {rows.length === 0 ? <p className="loading-text">Порожньо.</p> : (
        <table className="data-table">
          <thead><tr><th>КОЛИ</th><th>ХТО</th><th>ДІЯ</th><th>ОБ'ЄКТ</th></tr></thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id}>
                <td style={{ whiteSpace: "nowrap" }}>{new Date(a.at).toLocaleString("uk-UA")}</td>
                <td>{a.actor_email ?? "—"}</td>
                <td>{label(a)}</td>
                <td>{a.target_type === "role" ? "роль " : ""}{a.target_label ?? a.target_id}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ─────────────────────────── дрібні ───────────────────────────
const inp: React.CSSProperties = { padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", width: "100%", boxSizing: "border-box" };
const btn: React.CSSProperties = { cursor: "pointer", fontSize: 12, marginRight: 8, padding: "4px 8px", borderRadius: 7, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)" };
function L({ label, children }: { label: string; children: React.ReactNode }) { return <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)" }}>{label}<div style={{ marginTop: 4 }}>{children}</div></label>; }
function SectionLabel({ children }: { children: React.ReactNode }) { return <div style={{ fontSize: 12, fontWeight: 800, color: "var(--text-muted)", letterSpacing: 0.4, margin: "18px 0 10px" }}>{children}</div>; }
function CrmBadge() { return <span style={{ fontSize: 10.5, fontWeight: 700, padding: "2px 7px", borderRadius: 999, background: "rgba(47,111,219,0.12)", color: "#2f6fdb", whiteSpace: "nowrap" }}>з CRM</span>; }
function RevealCred({ text }: { text: string }) {
  return <span style={{ color: "#16a34a" }}>{text} <button onClick={() => navigator.clipboard?.writeText(text)} title="Копіювати" style={{ border: "none", background: "none", cursor: "pointer" }}>📋</button></span>;
}
function OneTimeCred({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderRadius: 10, background: "rgba(22,163,74,0.1)", border: "1px solid rgba(22,163,74,0.3)", marginBottom: 12 }}>
      <span style={{ fontSize: 13 }}>Новий логін (показується <b>один раз</b>): <span style={{ fontFamily: "monospace" }}>{text}</span></span>
      <button onClick={() => navigator.clipboard?.writeText(text)} style={{ border: "none", background: "none", cursor: "pointer" }} title="Копіювати">📋</button>
      <button onClick={onClose} style={{ marginLeft: "auto", border: "none", background: "none", cursor: "pointer", color: "var(--text-muted)" }}>×</button>
    </div>
  );
}
