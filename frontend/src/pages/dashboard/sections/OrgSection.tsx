import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactElement } from "react";
import {
  fetchOrgTree, setMyOrgTelegram, uploadMyOrgPhoto, moveOrgPerson, createOrgUnit, updateOrgUnit, deleteOrgUnit, fetchOrgLog, hiringError,
  type OrgTreeResp, type OrgUnit, type OrgPerson, type OrgDept, type OrgUnitInput, type OrgLogRow,
} from "../../../api";
import { useToast, type Toast } from "../../../components/Toasts";
import { EmployeePhoto, PhotoUploadDialog, initialsOf } from "./EmployeePhotos";
import { fmtTs, useEscape } from "./BaShared";
import { OrgTeamsCard, TeamOptions, useTeams } from "./OrgTeams";
import { createOrgTeam } from "../../../api";
import "./hiring.css";
import "./org.css";
import { splitKids } from "./orgLayout";

/**
 * 🏢 ОРГ СТРУКТУРА (задача 7062; ТЗ Даші 23.10.2026, вигляд затвердив ОД; рішення Романа 27.10.2026).
 *  • Дерево зверху вниз із лініями підпорядкування, список із сортуванням, пошук (імʼя / посада / @нік), фільтр
 *    «Відділ», картка людини справа. Дані — лише з «Найм → Співробітники»; блок людини = її КОМАНДА (27.10.2026):
 *    з Kommo — для менеджерів і тімлідів, інакше — вибрана (команда Kommo або відділ дашборду, `OrgTeams.tsx`).
 *  • Людина без команди або з командою без блоку — у «Без блоку» з причиною: невідоме видно.
 *  • Свій нік і фото кожен змінює сам; режим «Редагувати» (перетягнути людину, керівник, блок, журнал) — `canEdit`
 *    із сервера (право `edit_org`). Контакт — лише Telegram (ТЗ).
 *  • Етап 2 — «Написати» в картці й у списку ВІДКРИВАЄ Telegram (t.me/<нік>); надсилати повідомлення з дашборда
 *    не можна, діалогів і бота немає (рішення Романа 27.10.2026: «тільки відкривання телеграма»).
 */
const narrow = () => typeof window !== "undefined" && window.innerWidth < 700;
/** Плавність (Роман 27.10.2026): картка ховається за стільки ж, скільки виїжджає; без анімацій — якщо людина їх вимкнула в системі. */
const CARD_OUT_MS = 200;
/** Згортання блоку: стільки триває анімація, перш ніж вміст зникне з DOM (дорівнює `org-close` у CSS). */
const FOLD_MS = 260;
const calm = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
type SortKey = "name" | "position" | "unit" | "telegram";

/** Кольори ініціалів — палітра прототипу Даші; колір сталий для імені (сума кодів символів). */
const PALETTE = ["#d0261f", "#2f6fdf", "#1f8a4c", "#a352d6", "#c9700a", "#0f8f99", "#5b5b66"];
const tone = (name: string) => PALETTE[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % PALETTE.length];
/** Фото, якщо є; інакше — ініціали на кольоровому колі, як у прототипі. */
function OrgAvatar({ p, size }: { p: Pick<OrgPerson, "name" | "photo">; size: number }) {
  if (p.photo) return <EmployeePhoto photo={p.photo} name={p.name} size={size} />;
  return <span className="org-av" style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.34)), background: tone(p.name) }} aria-label={p.name}>{initialsOf(p.name)}</span>;
}

export function OrgSection() {
  const toast = useToast();
  const [data, setData] = useState<OrgTreeResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [view, setView] = useState<"tree" | "list">(() => (narrow() ? "list" : "tree"));
  const [q, setQ] = useState("");
  const [dept, setDept] = useState<OrgDept | "">("");
  const [noTg, setNoTg] = useState(false);
  const [open, setOpen] = useState<Set<number> | null>(null);
  const [closing, setClosing] = useState<Set<number>>(new Set());
  const foldTimers = useRef(new Map<number, number>());
  useEffect(() => () => { for (const t of foldTimers.current.values()) window.clearTimeout(t); }, []);
  const [card, setCard] = useState<number | null>(null);
  const [edit, setEdit] = useState(false);
  const [unitDlg, setUnitDlg] = useState<OrgUnit | "new" | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [teamsOpen, setTeamsOpen] = useState(false);
  const [over, setOver] = useState<number | "loose" | null>(null);
  const [sort, setSort] = useState<{ k: SortKey; up: boolean }>({ k: "name", up: true });
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    fetchOrgTree().then((d) => { setData(d); setErr(null); }).catch((e) => setErr(hiringError(e)));
  }, [nonce]);

  const units = useMemo(() => new Map((data?.units ?? []).map((u) => [u.id, u])), [data]);
  const people = useMemo(() => new Map((data?.people ?? []).map((p) => [p.id, p])), [data]);
  const kids = useCallback((id: number | null) => (data?.units ?? []).filter((u) => u.parentId === id && !u.side), [data]);
  const sides = useCallback((id: number) => (data?.units ?? []).filter((u) => u.parentId === id && u.side), [data]);
  // Як у прототипі: за замовчуванням розгорнуто ВСЕ — кожна команда з людьми й ніками.
  const opened = useMemo(() => open ?? new Set((data?.units ?? []).map((u) => u.id)), [open, data]);
  // Плавно (Роман 28.10.2026): розгорнуте зʼявляється з анімацією; згорнуте спершу ховається (`closing`), і лише
  // через FOLD_MS зникає з DOM. Повторний клік під час згортання скасовує його таймер.
  const fold = (ids: number[], shut: boolean) => {
    const base = (cur: Set<number> | null) => new Set(cur ?? (data?.units ?? []).map((u) => u.id));
    const unclose = (list: number[]) => setClosing((c) => { const x = new Set(c); list.forEach((id) => x.delete(id)); return x; });
    if (!shut) {
      ids.forEach((id) => { window.clearTimeout(foldTimers.current.get(id)); foldTimers.current.delete(id); });
      unclose(ids);
      setOpen((cur) => { const x = base(cur); ids.forEach((id) => x.add(id)); return x; });
      return;
    }
    const drop = (list: number[]) => setOpen((cur) => { const x = base(cur); list.forEach((id) => x.delete(id)); return x; });
    if (calm()) return drop(ids);
    setClosing((c) => new Set([...c, ...ids]));
    for (const id of ids) foldTimers.current.set(id, window.setTimeout(() => { foldTimers.current.delete(id); drop([id]); unclose([id]); }, FOLD_MS));
  };
  const toggle = (id: number) => fold([id], opened.has(id) && !closing.has(id));

  const query = q.trim().toLowerCase();
  const match = (p: OrgPerson) => !query || [p.name, p.position ?? "", p.telegram ?? ""].join(" ").toLowerCase().includes(query);
  const placed = (u: OrgUnit) => [...(u.headId != null && people.get(u.headId)?.unitId === u.id ? [u.headId] : []), ...u.memberIds];
  const deep = (u: OrgUnit): number => placed(u).length + (data?.units ?? []).filter((x) => x.parentId === u.id).reduce((a, x) => a + deep(x), 0);
  // Дерево вписується в ширину екрана (зменшення до 75%, як у прототипі) — після кожного рендеру й на зміні розміру.
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const fit = useCallback(() => {
    const b = boxRef.current, c = canvasRef.current;
    if (!b || !c) return;
    c.style.setProperty("zoom", "1");
    c.style.setProperty("zoom", String(Math.max(0.75, Math.min(1, (b.clientWidth - 8) / c.scrollWidth))));
  }, []);
  useLayoutEffect(fit);
  useEffect(() => { window.addEventListener("resize", fit); return () => window.removeEventListener("resize", fit); }, [fit]);
  const unitHit = (u: OrgUnit): boolean => [u.headId, ...u.memberIds].some((id) => id != null && match(people.get(id)!))
    || (data?.units ?? []).some((x) => x.parentId === u.id && unitHit(x));

  if (err) return <div className="hr-card"><div className="hr-sect" style={{ color: "var(--danger)", padding: 16 }}>{err}</div></div>;
  if (!data) return <p className="loading-text" style={{ padding: 16 }}>Завантаження…</p>;

  const drop = async (e: DragEvent, unitId: number | null) => {
    e.preventDefault(); setOver(null);
    const id = Number(e.dataTransfer.getData("text/org-person"));
    if (!id) return;
    const p = people.get(id);
    if (!p || p.unitId === unitId) return;
    try {
      await moveOrgPerson(id, unitId);
      toast(`${p.name} → ${unitId == null ? "Без блоку" : units.get(unitId)?.name}. Команду змінено`);
      reload();
    } catch (x) { toast(hiringError(x), { error: true }); }
  };
  const dropZone = (key: number | "loose", unitId: number | null, can: boolean) => (edit && can ? {
    onDragOver: (e: DragEvent) => { e.preventDefault(); if (over !== key) setOver(key); },
    onDragLeave: () => setOver(null),
    onDrop: (e: DragEvent) => void drop(e, unitId),
  } : {});

  const personBtn = (id: number, small = false) => {
    const p = people.get(id)!;
    return (
      <button key={id} className={`org-person ${query && match(p) ? "hit" : ""}`} onClick={() => setCard(id)}
        draggable={edit} onDragStart={(e) => e.dataTransfer.setData("text/org-person", String(id))}>
        <OrgAvatar p={p} size={small ? 26 : 36} />
        <span>
          <span className="org-pn">{p.name}</span><br />
          <span className="org-pr">{p.position || "посада не вказана"}</span><br />
          <span className="org-tg">{p.telegram ?? <span className="org-pr">Telegram не вказано</span>}</span>
        </span>
      </button>
    );
  };

  const node = (u: OrgUnit) => {
    const shown = opened.has(u.id) || !!query;
    const out = !query && closing.has(u.id);
    const isOpen = shown && !out;
    const ch = kids(u.id);
    const dim = (dept && u.dept !== dept && u.dept !== "top") || (query && !unitHit(u));
    const hit = query && [u.headId, ...u.memberIds].some((id) => id != null && match(people.get(id)!));
    const n = u.memberIds.length;
    const root = u.parentId == null;
    // Як у прототипі: великі кружки — у керівництві й фінансах, у команд — малі; верхній блок без «Згорнути».
    const small = u.dept !== "top" && u.dept !== "fin";
    return (
      <div key={u.id} className={`org-node ${hit ? "hit" : ""} ${dim ? "dim" : ""} ${over === u.id ? "drop" : ""}`} {...dropZone(u.id, u.id, !!u.label)}>
        <div className="org-ntitle">
          <span>{u.name}</span>
          {edit && <button title="Змінити блок" aria-label={`Змінити блок ${u.name}`} onClick={() => setUnitDlg(u)}>✎</button>}
        </div>
        {u.headId != null ? personBtn(u.headId)
          : <span className="org-pr">{edit ? "Керівника не вказано · " : ""}{ch.length ? `${ch.length} команди · ` : ""}{deep(u)} люд.</span>}
        {n > 0 && root && <div className="org-members">{u.memberIds.map((id) => personBtn(id, small))}</div>}
        {n > 0 && !root && shown && (
          <div className={`org-fold ${out ? "out" : ""}`}><div className="org-fold-in"><div className="org-members">{u.memberIds.map((id) => personBtn(id, small))}</div></div></div>
        )}
        {!root && (n > 0 || ch.length > 0) && (
          <div className="org-nfoot">
            <span className="org-pr">{deep(u)} люд.{edit && u.label ? ` · «${u.label}»` : ""}</span>
            <button className="org-tog" onClick={() => toggle(u.id)}>{isOpen ? "Згорнути" : n && !ch.length ? `Команда · ${n} ▾` : "Розгорнути"}</button>
          </div>
        )}
      </div>
    );
  };

  const branch = (u: OrgUnit): ReactElement => {
    const ch = kids(u.id);
    const sd = sides(u.id);
    const shown = opened.has(u.id) || !!query;
    const out = !query && closing.has(u.id);
    // Команди без власних блоків — сіткою по чотири, як у прототипі. Відділ із власними блоками (напр. «Маркетинговий
    // відділ» з Лідогенерацією, Роман 28.10.2026) — окремою гілкою від того самого керівника, поруч із сіткою (#2715).
    const { branches, rows } = splitKids(ch, (c) => kids(c.id).length > 0);
    const grid = <div className="org-vgrid">{rows.map((r, i) => <div key={i} className="org-vrow">{r.map(node)}</div>)}</div>;
    const sub = !rows.length ? <ul>{ch.map(branch)}</ul>
      : branches.length ? <ul>{branches.map(branch)}<li key="grid" className="org-gridli">{grid}</li></ul>
      : grid;
    return (
      <li key={u.id}>
        {/* `--org-sides` — скільки бічних блоків праворуч: стільки ж місця зліва, і лінія йде з-під основного (#2719). */}
        <div className="org-nwrap" style={sd.length ? ({ "--org-sides": sd.length } as CSSProperties) : undefined}>{node(u)}{sd.map((s) => <div key={s.id} className="org-side">{node(s)}</div>)}</div>
        {ch.length > 0 && shown && <div className={`org-fold sub ${out ? "out" : ""}`}><div className="org-fold-in">{sub}</div></div>}
      </li>
    );
  };

  const unitName = (p: OrgPerson) => (p.unitId == null ? "Без блоку" : units.get(p.unitId)?.name ?? "—");
  const inDept = (p: OrgPerson) => !dept || (p.unitId != null && units.get(p.unitId)?.dept === dept);
  const listRows = data.people.filter((p) => match(p) && inDept(p) && (!noTg || !p.telegram)).sort((a, b) => {
    const v = (p: OrgPerson) => (sort.k === "name" ? p.name : sort.k === "position" ? p.position ?? "" : sort.k === "unit" ? unitName(p) : p.telegram ?? "яяя");
    return (sort.up ? 1 : -1) * v(a).localeCompare(v(b), "uk");
  });
  const th = (k: SortKey, label: string) => (
    <th><button onClick={() => setSort((s) => ({ k, up: s.k === k ? !s.up : true }))}>{label}{sort.k === k ? (sort.up ? " ▲" : " ▼") : ""}</button></th>
  );
  const allIds = data.units.map((u) => u.id);
  const allOpen = allIds.every((id) => opened.has(id) && !closing.has(id));
  const s = data.stats;

  return (
    <div className="org">
      <div>
        <h1>Орг структура</h1>
        <div className="org-sub">Хто де працює і як з ним звʼязатися. Натисни на людину, щоб написати їй у Telegram або подзвонити.</div>
      </div>
      <div className="org-tool">
        <input className="hr-inp org-search" type="search" placeholder="Пошук: імʼя, посада або @нік" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Пошук людини" />
        <select className="hr-inp" value={dept} onChange={(e) => setDept(e.target.value as OrgDept | "")} aria-label="Відділ">
          <option value="">Усі відділи</option>
          {(Object.keys(data.depts) as OrgDept[]).map((k) => <option key={k} value={k}>{data.depts[k]}</option>)}
        </select>
        <div className="org-seg" role="group" aria-label="Вигляд">
          <button className={view === "tree" ? "on" : ""} onClick={() => setView("tree")}>Дерево</button>
          <button className={view === "list" ? "on" : ""} onClick={() => setView("list")}>Список</button>
        </div>
        {view === "tree" && <button className="hr-btn" onClick={() => (allOpen
          ? fold(allIds.filter((id) => kids(id).length === 0), true)
          : fold(allIds.filter((id) => !opened.has(id) || closing.has(id)), false))}>{allOpen ? "Згорнути все" : "Розгорнути все"}</button>}
        {data.canEdit && <button className={`hr-btn ${edit ? "p" : ""}`} onClick={() => setEdit((x) => !x)}>{edit ? "Готово" : "Редагувати"}</button>}
      </div>
      <div className="org-stats">
        <span>Працюють: <b>{s.total}</b></span>
        <span>без Telegram: <button onClick={() => { setNoTg((x) => !x); setView("list"); }}>{s.noTelegram}</button>{noTg ? " (фільтр увімкнено)" : ""}</span>
        <span>без фото: <b>{s.noPhoto}</b></span>
        {s.unassigned > 0 && <span style={{ color: "var(--warn)" }}>без блоку: <b>{s.unassigned}</b></span>}
      </div>
      {edit && (
        <div className="org-edit-bar">
          <span>Перетягни людину на блок — їй зміниться команда (менеджерів і тімлідів — лише в Kommo). ✎ — змінити блок.</span>
          <button className="hr-btn xs" onClick={() => setUnitDlg("new")}>+ Блок</button>
          <button className="hr-btn xs" onClick={() => setTeamsOpen(true)}>Відділи</button>
          <button className="hr-btn xs" onClick={() => setLogOpen(true)}>Журнал змін</button>
        </div>
      )}

      {view === "tree" ? (
        <div className="org-treebox" ref={boxRef}><div className="org-canvas" ref={canvasRef}>
          <ul className="org-tree">{kids(null).map(branch)}</ul>
        </div></div>
      ) : (
        <div className="hr-card org-tbl" style={{ marginBottom: 0 }}>
          <table className="org-list">
            <thead><tr>{th("name", "Співробітник")}{th("position", "Посада")}{th("unit", "Відділ / команда")}{th("telegram", "Telegram")}<th /></tr></thead>
            <tbody>
              {listRows.map((p) => (
                <tr key={p.id}>
                  <td><button className="org-person" style={{ width: "auto", margin: 0 }} onClick={() => setCard(p.id)}><OrgAvatar p={p} size={26} /><span className="org-pn">{p.name}</span></button></td>
                  <td>{p.position || <span className="hr-muted">не вказано</span>}</td>
                  <td>{p.unitId == null ? <span style={{ color: "var(--warn)" }}>Без блоку</span> : unitName(p)}</td>
                  <td className="org-tg" style={{ fontSize: 13 }}>{p.telegram ?? <span className="hr-muted">не вказано</span>}</td>
                  {/* Етап 2 = лише відкрити Telegram (рішення Романа 27.10.2026): повідомлень у дашборді немає. */}
                  <td>{p.telegram && <a className="hr-btn xs org-write" href={`https://t.me/${p.telegram.slice(1)}`} target="_blank" rel="noopener noreferrer">Написати</a>}</td>
                </tr>
              ))}
              {!listRows.length && <tr><td colSpan={5} className="hr-muted">Нікого не знайдено. Спробуй інше імʼя або прибери фільтр.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {data.unassigned.length > 0 && (view === "tree" || edit) && (
        <div className={`org-loose ${over === "loose" ? "drop" : ""}`} {...dropZone("loose", null, true)}>
          <b>Без блоку · {data.unassigned.length} люд.</b>
          <span className="hr-muted">
            У цих людей не вибрано команду або під їхню команду немає блоку. Блок людини — це її команда:
            {data.canEdit ? " перетягни людину на блок або обери команду в картці співробітника." : " розставляє HR."}
          </span>
          <div className="org-chips">{data.unknownLabels.map((x) => <span key={x.label} className="org-chip">{x.label} — {x.count} люд.</span>)}</div>
          <div className="org-people">{data.unassigned.filter((id) => match(people.get(id)!)).map((id) => personBtn(id, true))}</div>
        </div>
      )}

      {card != null && people.get(card) && (
        <PersonCard p={people.get(card)!} data={data} unitName={unitName(people.get(card)!)} toast={toast} onClose={() => setCard(null)} onChanged={reload} />
      )}
      {unitDlg && <UnitDialog data={data} unit={unitDlg === "new" ? null : unitDlg} toast={toast} onClose={() => setUnitDlg(null)} onSaved={() => { setUnitDlg(null); reload(); }} />}
      {logOpen && <LogDialog onClose={() => setLogOpen(false)} toast={toast} />}
      {teamsOpen && <TeamsDialog toast={toast} onClose={() => setTeamsOpen(false)} onChanged={reload} />}
    </div>
  );
}

function PersonCard({ p, data, unitName, toast, onClose, onChanged }: {
  p: OrgPerson; data: OrgTreeResp; unitName: string; toast: Toast; onClose: () => void; onChanged: () => void;
}) {
  const [leaving, setLeaving] = useState(false);
  const close = () => { if (calm()) return onClose(); setLeaving(true); window.setTimeout(onClose, CARD_OUT_MS); };
  useEscape(close);
  const [nick, setNick] = useState(p.telegram ?? "");
  const [busy, setBusy] = useState(false);
  const [photoDlg, setPhotoDlg] = useState(false);
  useEffect(() => { setNick(p.telegram ?? ""); }, [p.id, p.telegram]);
  const copy = (v: string | null | undefined, what: string) => {
    if (!v) return;
    (navigator.clipboard?.writeText(v) ?? Promise.reject()).then(() => toast(`Скопійовано: ${v}`)).catch(() => toast(`Виділи ${what} і скопіюй вручну`));
  };
  const saveNick = async () => {
    setBusy(true);
    try { const v = await setMyOrgTelegram(nick); toast(v ? `Нік збережено: ${v}` : "Нік прибрано"); onChanged(); }
    catch (e) { toast(hiringError(e), { error: true }); } finally { setBusy(false); }
  };
  const move = async (v: string) => {
    setBusy(true);
    try { await moveOrgPerson(p.id, v ? Number(v) : null); toast(`${p.name}: блок і команду змінено`); onChanged(); }
    catch (e) { toast(hiringError(e), { error: true }); } finally { setBusy(false); }
  };
  return (
    <>
      <div className={`org-scrim ${leaving ? "out" : ""}`} onClick={close} />
      <aside className={`org-drawer ${leaving ? "out" : ""}`} role="dialog" aria-label={`Картка: ${p.name}`}>
        <div style={{ display: "flex", justifyContent: "flex-end" }}><button className="hr-btn xs" onClick={close}>Закрити ✕</button></div>
        <div className="org-dhead">
          <OrgAvatar p={p} size={76} />
          <div className="org-dname">{p.name}</div>
          <div className="org-pr" style={{ fontSize: 13.5 }}>{p.position || "посада не вказана"}</div>
          <div className="org-pr">{unitName}{p.isHead ? " · керівник" : ""}</div>
        </div>
        <div className="org-row">
          <span><span className="org-lbl">Telegram</span><br />
            {p.telegram ? <span className="org-tg" style={{ fontSize: 14, fontWeight: 650 }}>{p.telegram}</span>
              : <span className="hr-muted">{p.telegramInvalid ? "у «Наймі» записано не нік — не показуємо" : "не вказано"}</span>}
          </span>
          {p.telegram && <button className="hr-btn xs" onClick={() => copy(p.telegram, "нік")}>Копіювати</button>}
        </div>
        {p.telegram && (
          <div className="org-acts">
            <a href={`https://t.me/${p.telegram.slice(1)}`} target="_blank" rel="noopener noreferrer">Написати в Telegram</a>
          </div>
        )}
        {/* Телефон — у картці, усім (рішення Романа 28.10.2026); нерозпізнаний номер — як записано, без посилання. */}
        <div className="org-row">
          <span><span className="org-lbl">Телефон</span><br />
            {!p.phone ? <span className="hr-muted">не вказано</span>
              : p.phone.tel ? <a className="org-tel" href={`tel:${p.phone.tel}`}>{p.phone.text}</a>
              : <span className="org-tel">{p.phone.text}</span>}
          </span>
          {p.phone && <button className="hr-btn xs" onClick={() => copy(p.phone?.tel ?? p.phone?.text, "номер")}>Копіювати</button>}
        </div>
        {p.isMe && (
          <div className="org-mine">
            <span className="org-lbl">Моє</span>
            <label className="hr-muted" htmlFor="org-my-nick">Мій нік у Telegram</label>
            <div style={{ display: "flex", gap: 6 }}>
              <input id="org-my-nick" className="hr-inp" style={{ flex: 1 }} placeholder="@nick" value={nick} onChange={(e) => setNick(e.target.value)} />
              <button className="hr-btn p" disabled={busy || nick.trim() === (p.telegram ?? "")} onClick={() => void saveNick()}>Зберегти</button>
            </div>
            <button className="hr-btn" onClick={() => setPhotoDlg(true)}>{p.photo ? "Змінити своє фото" : "Додати своє фото"}</button>
          </div>
        )}
        {data.canEdit && p.isHead && (
          <div className="org-mine">
            <span className="org-lbl">Блок на схемі</span>
            <span className="hr-muted">Керівник блоку «{unitName}» — змінюється в самому блоці (✎ у режимі «Редагувати»).</span>
          </div>
        )}
        {data.canEdit && !p.isHead && (
          <div className="org-mine">
            <span className="org-lbl">Блок на схемі</span>
            {p.teamLocked ? (
              <span className="hr-muted">Команда «{p.teamName}» — з Kommo. Переводять у Kommo, синк перенесе людину сам.</span>
            ) : (
              <>
                <select className="hr-inp" disabled={busy} value={p.unitId ?? ""} onChange={(e) => void move(e.target.value)} aria-label="Блок на схемі">
                  <option value="">Без блоку (команду зняти)</option>
                  {data.units.filter((u) => u.teamKey).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
                <span className="hr-muted">Команда зараз: {p.teamName ?? (p.teamLabel ? `не вибрано (у таблиці було «${p.teamLabel}»)` : "не вибрано")}</span>
              </>
            )}
          </div>
        )}
      </aside>
      {photoDlg && <PhotoUploadDialog name={p.name} onClose={() => setPhotoDlg(false)} onSave={async (dataUrl) => {
        await uploadMyOrgPhoto(dataUrl); setPhotoDlg(false); toast("Фото збережено"); onChanged();
      }} />}
    </>
  );
}

function UnitDialog({ data, unit, toast, onClose, onSaved }: { data: OrgTreeResp; unit: OrgUnit | null; toast: Toast; onClose: () => void; onSaved: () => void }) {
  useEscape(onClose);
  const [f, setF] = useState<Required<OrgUnitInput>>({
    name: unit?.name ?? "", parentId: unit?.parentId ?? null, dept: unit?.dept ?? "sales",
    team: unit?.teamId != null ? `k:${unit.teamId}` : unit?.dashTeamId != null ? `d:${unit.dashTeamId}` : null,
    headEmployeeId: unit?.headSource === "manual" ? unit.headId : null, side: unit?.side ?? false, sort: unit?.sort ?? 0,
  });
  const [busy, setBusy] = useState(false);
  const [teams, reloadTeams] = useTeams();
  const [newDept, setNewDept] = useState("");
  // Батьком не може бути сам блок і ніхто з його підпорядкованих — інакше коло (сервер теж не пустить).
  const below = useMemo(() => {
    const out = new Set<number>(); if (!unit) return out;
    const walk = (id: number) => { out.add(id); data.units.filter((u) => u.parentId === id).forEach((u) => walk(u.id)); };
    walk(unit.id); return out;
  }, [data, unit]);
  const addDept = async () => {
    setBusy(true);
    try { const id = await createOrgTeam({ name: newDept.trim() }); setNewDept(""); reloadTeams(); setF({ ...f, team: `d:${id}` }); toast(`Відділ «${newDept.trim()}» створено`); }
    catch (e) { toast(hiringError(e), { error: true }); } finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true);
    try {
      if (unit) await updateOrgUnit(unit.id, f); else await createOrgUnit(f);
      toast(unit ? `Блок «${f.name}» збережено` : `Блок «${f.name}» створено`); onSaved();
    } catch (e) { toast(hiringError(e), { error: true }); setBusy(false); }
  };
  const remove = async () => {
    if (!unit) return;
    setBusy(true);
    try { await deleteOrgUnit(unit.id); toast(`Блок «${unit.name}» видалено`); onSaved(); }
    catch (e) { toast(hiringError(e), { error: true }); setBusy(false); }
  };
  const num = (v: string) => (v ? Number(v) : null);
  return (
    <div className="hr-modal-back" onClick={onClose}>
      <div className="hr-modal" style={{ maxWidth: 560 }} role="dialog" aria-label={unit ? `Блок: ${unit.name}` : "Новий блок"} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>{unit ? `Блок «${unit.name}»` : "Новий блок"}</h3>
        <div className="org-form">
          <label htmlFor="ou-name">Назва</label>
          <input id="ou-name" className="hr-inp" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <label htmlFor="ou-parent">Підпорядковується</label>
          <select id="ou-parent" className="hr-inp" value={f.parentId ?? ""} onChange={(e) => setF({ ...f, parentId: num(e.target.value) })}>
            <option value="">— (верхній рівень)</option>
            {data.units.filter((u) => !below.has(u.id)).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <label htmlFor="ou-dept">Відділ</label>
          <select id="ou-dept" className="hr-inp" value={f.dept} onChange={(e) => setF({ ...f, dept: e.target.value as OrgDept })}>
            {(Object.keys(data.depts) as OrgDept[]).map((k) => <option key={k} value={k}>{data.depts[k]}</option>)}
          </select>
          <label htmlFor="ou-team">Команда</label>
          <select id="ou-team" className="hr-inp" value={f.team ?? ""} onChange={(e) => setF({ ...f, team: e.target.value || null })}>
            <option value="">— без команди (контейнер)</option>
            <TeamOptions data={teams} current={f.team} />
          </select>
          {teams?.canManage && <>
            <label htmlFor="ou-newdept">Новий відділ</label>
            <span style={{ display: "flex", gap: 6 }}>
              <input id="ou-newdept" className="hr-inp" style={{ flex: 1 }} placeholder="напр. «IT відділ»" value={newDept} onChange={(e) => setNewDept(e.target.value)} />
              <button className="hr-btn" disabled={busy || !newDept.trim()} onClick={() => void addDept()}>+ Відділ</button>
            </span>
          </>}
          <label htmlFor="ou-head">Керівник</label>
          <select id="ou-head" className="hr-inp" value={f.headEmployeeId ?? ""} onChange={(e) => setF({ ...f, headEmployeeId: num(e.target.value) })}>
            <option value="">{f.team?.startsWith("k:") ? "— тімлід команди Kommo" : "— не вказано"}</option>
            {data.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <label htmlFor="ou-side">Збоку (пунктиром)</label>
          <input id="ou-side" type="checkbox" checked={f.side} onChange={(e) => setF({ ...f, side: e.target.checked })} style={{ justifySelf: "start" }} />
          <label htmlFor="ou-sort">Порядок</label>
          <input id="ou-sort" className="hr-inp" type="number" value={f.sort} onChange={(e) => setF({ ...f, sort: Number(e.target.value) || 0 })} />
        </div>
        <p className="hr-muted">Люди потрапляють у блок за командою: менеджери й тімліди — за командою в Kommo, решта — за вибраною в картці. Блок із людьми команду не змінює — спершу перемістіть людей.</p>
        <div style={{ display: "flex", gap: 8, justifyContent: "space-between", flexWrap: "wrap" }}>
          <span>{unit && <button className="hr-btn" disabled={busy} onClick={() => void remove()}>Видалити блок</button>}</span>
          <span style={{ display: "flex", gap: 8 }}>
            <button className="hr-btn" onClick={onClose}>Скасувати</button>
            <button className="hr-btn p" disabled={busy || !f.name.trim()} onClick={() => void save()}>Зберегти</button>
          </span>
        </div>
      </div>
    </div>
  );
}

function TeamsDialog({ toast, onClose, onChanged }: { toast: Toast; onClose: () => void; onChanged: () => void }) {
  useEscape(onClose);
  return (
    <div className="hr-modal-back" onClick={onClose}>
      <div className="hr-modal" style={{ maxWidth: 720 }} role="dialog" aria-label="Відділи дашборду" onClick={(e) => e.stopPropagation()}>
        <OrgTeamsCard toast={toast} onChanged={onChanged} />
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}><button className="hr-btn" onClick={onClose}>Закрити</button></div>
      </div>
    </div>
  );
}

function LogDialog({ onClose, toast }: { onClose: () => void; toast: Toast }) {
  useEscape(onClose);
  const [rows, setRows] = useState<OrgLogRow[] | null>(null);
  // Один раз на відкриття: `onClose` — нова стрілка щорендеру батька, і в залежностях вона перезапитувала б журнал.
  useEffect(() => { fetchOrgLog().then(setRows).catch((e) => { toast(hiringError(e), { error: true }); onClose(); }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="hr-modal-back" onClick={onClose}>
      <div className="hr-modal" style={{ maxWidth: 640 }} role="dialog" aria-label="Журнал змін орг-структури" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>Журнал змін</h3>
        {!rows ? <p className="loading-text">Завантаження…</p> : (
          <div className="org-log">
            {rows.map((r) => (
              <Fragment key={r.id}>
                <div><span className="hr-muted">{fmtTs(r.at)}{r.actor ? ` · ${r.actor}` : ""}</span><br />{r.summary}</div>
              </Fragment>
            ))}
            {!rows.length && <span className="hr-muted">Змін ще не було.</span>}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}><button className="hr-btn" onClick={onClose}>Закрити</button></div>
      </div>
    </div>
  );
}
