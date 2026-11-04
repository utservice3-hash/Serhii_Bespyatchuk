/**
 * 💰 Налаштування → «Оргструктура» (макет p08-set.js `orgSettings`): відділ визначає, як платимо, який кабінет бачить працівник
 * («продає» — повний; ні — простий) і де він в аналітиці; команда — офер (стандартний / Лілії Шаврової) і звʼязок з командою Kommo.
 * Змінювати — право `payroll_settings` (`saveDepartment`, `saveTeam`; код — латиниця, нового рядка з тим самим кодом не буде — оновиться).
 */
import { useState } from "react";
import { errText, payrollApi, type Obj } from "../api";
import { Card, Empty } from "../ui";
import { useToast } from "../../components/Toasts";
import { Field, Modal, OFFER_NAMES, ROLE_NAMES } from "./common";

function DeptModal({ d, onClose, onDone }: { d: Obj | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [code, setCode] = useState(d?.code ?? ""), [name, setName] = useState(d?.name ?? ""), [isSales, setSales] = useState(!!d?.isSales);
  const [err, setErr] = useState<string | null>(null), [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); setErr(null);
    try { await payrollApi.saveDepartment({ code: code.trim(), name: name.trim(), isSales }); toast("Відділ збережено."); onDone(); }
    catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  }
  return (
    <Modal title={d ? `Відділ · ${d.name}` : "Новий відділ"} onClose={onClose}
      foot={<><button className="zp-btn zp-btn--primary" disabled={busy} onClick={() => void save()}>Зберегти</button><button className="zp-btn" onClick={onClose}>Скасувати</button></>}>
      <div className="zps-g2">
        <Field label="Код" req hint="латиниця, цифри, _"><input className="zp-input" value={code} disabled={!!d} onChange={(e) => setCode(e.target.value)} placeholder="напр. log" /></Field>
        <Field label="Назва" req><input className="zp-input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      </div>
      <label className="zp-check"><input type="checkbox" checked={isSales} onChange={(e) => setSales(e.target.checked)} />Відділ продає — повний кабінет (план, ціль і калькулятор, ТТН, КПІ)</label>
      {err && <div className="zp-err">{err}</div>}
    </Modal>
  );
}

function TeamModal({ t, depts, onClose, onDone }: { t: Obj | null; depts: Obj[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [code, setCode] = useState(t?.code ?? ""), [name, setName] = useState(t?.name ?? ""), [dept, setDept] = useState(t?.dept ?? "sales");
  const [offer, setOffer] = useState(t?.offer ?? "std"), [kommo, setKommo] = useState(t?.kommoTeamId ? String(t.kommoTeamId) : "");
  const [err, setErr] = useState<string | null>(null), [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); setErr(null);
    try { await payrollApi.saveTeam({ code: code.trim(), name: name.trim(), dept, offer, kommoTeamId: kommo.trim() ? Number(kommo) : null }); toast("Команду збережено."); onDone(); }
    catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  }
  return (
    <Modal title={t ? `Команда · ${t.name}` : "Нова команда"} onClose={onClose}
      foot={<><button className="zp-btn zp-btn--primary" disabled={busy} onClick={() => void save()}>Зберегти</button><button className="zp-btn" onClick={onClose}>Скасувати</button></>}>
      <div className="zps-g2">
        <Field label="Код" req hint="латиниця, цифри, _"><input className="zp-input" value={code} disabled={!!t} onChange={(e) => setCode(e.target.value)} /></Field>
        <Field label="Назва" req><input className="zp-input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Відділ"><select className="zp-select" value={dept} onChange={(e) => setDept(e.target.value)}>{depts.map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></Field>
        <Field label="Офер команди" hint="умови однакові для всіх у команді">
          <select className="zp-select" value={offer} onChange={(e) => setOffer(e.target.value)}>{Object.entries(OFFER_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        </Field>
        <Field label="Команда в Kommo (id)" hint="звідки брати угоди й людей; порожньо — без звʼязку"><input className="zp-input" inputMode="numeric" value={kommo} onChange={(e) => setKommo(e.target.value)} /></Field>
      </div>
      {err && <div className="zp-err">{err}</div>}
    </Modal>
  );
}

export function OrgSettings({ org, people, canEdit, onChanged }: { org: Obj; people: Obj[]; canEdit: boolean; onChanged: () => void }) {
  const [dept, setDept] = useState<Obj | null | undefined>(undefined);
  const [team, setTeam] = useState<Obj | null | undefined>(undefined);
  const depts = (org.departments ?? []) as Obj[], teams = (org.teams ?? []) as Obj[];
  const active = people.filter((p) => !p.leave);
  return (
    <Card title="Оргструктура" aside="відділ визначає, як платимо, який кабінет бачить працівник і де він в аналітиці">
      <div className="zp-grid" style={{ gap: 12 }}>
        {depts.length ? (
          <div className="zp-table-wrap">
            <table className="zp-table">
              <thead><tr><th>Відділ</th><th className="r">Людей</th><th>Хто</th><th>Як платимо</th><th>Кабінет</th></tr></thead>
              <tbody>
                {depts.map((d) => {
                  const ps = active.filter((p) => p.dept === d.code);
                  return (
                    <tr key={d.code} className={canEdit ? "is-click" : ""} onClick={() => canEdit && setDept(d)}>
                      <td><b>{d.name}</b><div className="zp-hint">{d.code}</div></td>
                      <td className="r">{ps.length}</td>
                      <td>{d.isSales ? teams.filter((t) => t.dept === d.code).map((t) => {
                        const m = ps.filter((p) => p.team === t.code);
                        return m.length ? <div key={t.code}><b>{t.name}:</b> {m.map((p) => `${p.name}${p.role === "lead" ? " (тім-лід)" : ""}`).join(", ")}</div> : null;
                      }) : ps.map((p) => <div key={p.userId}>{p.name} <span className="zp-muted">· {p.title} · {ROLE_NAMES[p.role] ?? p.role}</span></div>)}
                        {!ps.length && <span className="zp-hint">нікого</span>}
                      </td>
                      <td>{d.isSales ? "ставка + % від маржі, бонуси; «Профі» — % від маржі" : "ставка"}</td>
                      <td>{d.isSales ? "повний: план, ціль і калькулятор, ТТН, КПІ" : "простий: сума за місяць, на руки, дати, аванс, виплати"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <Empty>Відділів немає.</Empty>}
        <div className="zps-lbl">Команди</div>
        {teams.length ? (
          <div className="zp-table-wrap">
            <table className="zp-table">
              <thead><tr><th>Команда</th><th>Відділ</th><th>Офер</th><th>Kommo</th><th className="r">Людей</th></tr></thead>
              <tbody>
                {teams.map((t) => (
                  <tr key={t.code} className={canEdit ? "is-click" : ""} onClick={() => canEdit && setTeam(t)}>
                    <td><b>{t.name}</b><div className="zp-hint">{t.code}</div></td>
                    <td>{depts.find((d) => d.code === t.dept)?.name ?? t.dept}</td>
                    <td>{OFFER_NAMES[t.offer] ?? t.offer}</td>
                    <td>{t.kommoTeamId ? `#${t.kommoTeamId}` : <span className="zp-hint">не повʼязано</span>}</td>
                    <td className="r">{active.filter((p) => p.team === t.code).length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>Команд немає — без них менеджера в зарплату не додати.</Empty>}
        {canEdit && <div className="zp-row"><button className="zp-btn zp-btn--sm" onClick={() => setDept(null)}>Новий відділ</button><button className="zp-btn zp-btn--sm" onClick={() => setTeam(null)}>Нова команда</button></div>}
        <div className="zp-hint">Новий відділ — рядок тут; аналітика «ЗП до результату» рахує його автоматично. Новий офер (інші умови) — окрема зміна правил.</div>
      </div>
      {dept !== undefined && <DeptModal d={dept} onClose={() => setDept(undefined)} onDone={() => { setDept(undefined); onChanged(); }} />}
      {team !== undefined && <TeamModal t={team} depts={depts} onClose={() => setTeam(undefined)} onDone={() => { setTeam(undefined); onChanged(); }} />}
    </Card>
  );
}
