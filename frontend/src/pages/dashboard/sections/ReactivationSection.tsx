import { Fragment, useCallback, useEffect, useState, type ReactNode } from "react";
import type { AuthPayload } from "../../../auth";
import {
  fetchReactivationList, setClientSeasonal,
  createClientReactivationTask, closeReactivationTask,
  type ReactivationResp, type ReactivationRow,
} from "../../../api";
import { formatAmountFull } from "../format";
import { MergePanel, ManagerPanel } from "./ClientAdminPanels";
import { SegmentBadge, ForcedBadge } from "./SegmentBadge";

/**
 * ФАЗА B · «РЕАКТИВАЦІЯ · СПЛЯЧІ ТА ВТРАЧЕНІ» (макет 2).
 *
 * 🔴 Стани НЕ перемикаються руками: постійний → сплячий (60 дн.) → втрачений
 * (180 дн.) → повернений — усе з дат замовлень, рахує ядро. Руками ставиться
 * рівно одне — «сезонний»: з дат його вивести неможливо.
 */

/**
 * Менеджер без команди в `managers.team_id` — це стан бази, а не помилка екрана.
 * Ховати такі рядки не можна: клієнт зник би зі списку реактивації мовчки.
 */
const BEZ_KOMANDY = "Без команди";

const S = {
  card: { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: "12px 14px" } as const,
  th: { textAlign: "left", fontSize: 10, letterSpacing: .4, textTransform: "uppercase", color: "#6b7280",
        fontWeight: 600, padding: "8px 10px", borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap" } as const,
  td: { padding: "12px 10px", borderBottom: "1px solid #f1f5f9", fontSize: 13, verticalAlign: "top" } as const,
  chip: (bg: string, fg: string) => ({ display: "inline-block", padding: "2px 8px", borderRadius: 999,
        fontSize: 11, fontWeight: 700, background: bg, color: fg, whiteSpace: "nowrap" } as const),
  btn: (primary?: boolean) => ({ fontSize: 12, fontWeight: primary ? 700 : 500, padding: "6px 12px",
        borderRadius: 8, cursor: "pointer", border: primary ? "none" : "1px solid #d1d5db",
        background: primary ? "#111827" : "#fff", color: primary ? "#fff" : "#374151" } as const),
  input: { fontSize: 12, padding: "6px 9px", border: "1px solid #d1d5db", borderRadius: 8, width: "100%",
           boxSizing: "border-box" } as const,
};

function Tile({ title, value, sub, tone }: { title: string; value: string; sub?: string; tone?: "good" | "warn" }) {
  return (
    <div style={{ ...S.card, flex: "1 1 200px", minWidth: 190 }}>
      <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 28, fontWeight: 800, lineHeight: 1.05,
                    color: tone === "good" ? "#166534" : tone === "warn" ? "#b45309" : "#111827" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "#6b7280", marginTop: 5 }}>{sub}</div>}
    </div>
  );
}

/**
 * 🔴 ДВІ ДАТИ В РЯДКУ, І ПІДПИСАНО, ЯКА З НИХ РАХУЄ СТАН.
 *
 * Стан («сплячий»/«втрачений») рахується ВИКЛЮЧНО від останньої ОПЛАТИ — так у
 * ядрі, і так лишається. Але власник бачив «без контакту 120 днів» серед
 * активних і «з контактом» серед сплячих і не міг зрозуміти, від чого екран
 * рахує. Обидві причини правильні; невидимою була сама відповідь.
 *
 * Тому: оплата — з підписом «джерело стану», дзвінок — з підписом «довідка».
 * Дзвінок НЕ впливає на стан і не має впливати: розмова не робить клієнта
 * платником.
 */
function TwoDates({ c }: { c: ReactivationRow }) {
  const callTone = c.lastTalkDays == null ? "#9ca3af"
    : c.lastTalkDays <= 30 ? "#166534" : c.lastTalkDays <= 90 ? "#b45309" : "#b91c1c";
  return (
    <div style={{ lineHeight: 1.45 }}>
      <div>
        <span style={{ fontSize: 10, letterSpacing: .3, textTransform: "uppercase", color: "#6b7280" }}>
          остання оплата
        </span>
        <div>
          <b>{c.lastPaid ?? "—"}</b>
          <span style={{ color: "#6b7280" }}> · {c.daysSince} дн. тому</span>
        </div>
        <div style={{ fontSize: 10, color: "#9ca3af" }}>джерело стану</div>
      </div>
      <div style={{ marginTop: 6, paddingTop: 6, borderTop: "1px dashed #e5e7eb" }}>
        <span style={{ fontSize: 10, letterSpacing: .3, textTransform: "uppercase", color: "#6b7280" }}>
          останній контакт
        </span>
        {c.lastTalk == null ? (
          // Порожньо — це відповідь, а не діра: звʼязка дзвінок→клієнт іде через
          // телефон контакту Kommo і покриває не всіх. Мовчазний прочерк читався
          // б як «не дзвонили», а це різні твердження.
          <div style={{ color: "#9ca3af" }}>розмов не знайдено</div>
        ) : (
          <>
            <div>
              <b style={{ color: callTone }}>{c.lastTalk}</b>
              <span style={{ color: "#6b7280" }}> · {c.lastTalkDays} дн. тому</span>
            </div>
            <div style={{ fontSize: 10, color: "#9ca3af" }}>
              {c.lastTalkDirection === "out" ? "вихідний" : "вхідний"} · розмова
              {" · довідка, на стан не впливає"}
            </div>
          </>
        )}
        {/* 🔴 СПРОБИ — ОКРЕМО ВІД КОНТАКТУ, і саме тому окремим рядком. «Набирав
            тричі й не додзвонився» — це робота менеджера, а не контакт із
            клієнтом; в одній цифрі вони збрехали б про контакт, якого не було. */}
        {c.attempts > 0 && (
          <div style={{ fontSize: 11, color: "#b45309", marginTop: 3 }}
            title="дзвінки без відповіді ПІСЛЯ останньої розмови (якщо розмов не було — усі)">
            📞 спроб {c.attempts}
            {c.lastAttempt && <span style={{ color: "#92400e" }}> · остання {c.lastAttempt} ({c.lastAttemptDays} дн.)</span>}
            <div style={{ fontSize: 10, color: "#9ca3af" }}>без відповіді — контакту ще не було</div>
          </div>
        )}
      </div>
    </div>
  );
}

function StateChip({ c }: { c: ReactivationRow }) {
  if (c.seasonal) return <span style={S.chip("#eef2ff", "#4338ca")}>сезонний{c.seasonalNote ? ` · ${c.seasonalNote}` : ""}</span>;
  if (c.returned) return <span style={S.chip("#dcfce7", "#166534")}>повернено · +{formatAmountFull(c.returnedRevenue)}</span>;
  if (c.state === "lost") return <span style={S.chip("#fee2e2", "#b91c1c")}>втрачено {c.daysSince} дн.</span>;
  if (c.state === "sleeping") return <span style={S.chip("#fef3c7", "#92400e")}>спить {c.daysSince} дн.</span>;
  return <span style={S.chip("#f1f5f9", "#475569")}>активний · {c.daysSince} дн.</span>;
}



/**
 * Підсумок рівня ієрархії — З ТИХ САМИХ рядків, що показані нижче. Той самий
 * інваріант, що на екрані планів: «згорнути» ховає рядки й не змінює жодної
 * цифри. Якби рівень рахувався окремим запитом, згорнутий і розгорнутий вигляд
 * могли б розійтись, і ніхто не сказав би, який із них правильний.
 */
function levelTotals(rows: ReactivationRow[]) {
  return {
    clients: rows.length,
    sleeping: rows.filter((c) => c.state === "sleeping" && !c.seasonal).length,
    lost: rows.filter((c) => c.state === "lost" && !c.seasonal).length,
    inWork: rows.filter((c) => c.taskId != null && c.taskStatus !== "done").length,
    potential: rows.reduce((s, c) => s + c.lifetimeRevenue, 0),
    value: rows.reduce((s, c) => s + c.value, 0),
  };
}

/** Рядок-шапка рівня (команда / менеджер) з підсумками й «розгорнути». */
function GroupRow({ level, title, sub, open, onToggle, totals }: {
  level: "team" | "manager"; title: string; sub?: string; open: boolean;
  onToggle: () => void; totals: ReturnType<typeof levelTotals>;
}) {
  const isTeam = level === "team";
  return (
    <tr onClick={onToggle}
      style={{ background: isTeam ? "#f1f5f9" : "#fafcff", cursor: "pointer",
               borderTop: isTeam ? "2px solid #e2e8f0" : "1px solid #eef2f7" }}>
      <td style={{ ...S.td, paddingLeft: isTeam ? 10 : 28, fontWeight: isTeam ? 800 : 700,
                   fontSize: isTeam ? 14 : 13, borderBottom: "none", verticalAlign: "middle" }}>
        <span style={{ color: "#64748b", marginRight: 6 }}>{open ? "▾" : "▸"}</span>
        {isTeam ? "🏢 " : "👤 "}{title}
        <span style={{ fontWeight: 400, fontSize: 11, color: "#6b7280" }}>
          {sub ? ` · ${sub}` : ""} · {totals.clients} {totals.clients === 1 ? "клієнт" : "клієнтів"}
        </span>
      </td>
      {/* Підсумки станів — на рівні «Стан», тобто рівно під тим стовпчиком, який
          вони підсумовують. Показуємо лише ненульові: рядок «💤 0 · ❌ 0 · 🔧 0»
          нічого не каже, а місце займає. */}
      <td style={{ ...S.td, borderBottom: "none", verticalAlign: "middle" }} colSpan={2}>
        <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {totals.sleeping > 0 && <span style={S.chip("#fef3c7", "#92400e")}>💤 {totals.sleeping}</span>}
          {totals.lost > 0 && <span style={S.chip("#fee2e2", "#b91c1c")}>❌ {totals.lost}</span>}
          {totals.inWork > 0 && <span style={S.chip("#dbeafe", "#1d4ed8")}>🔧 {totals.inWork}</span>}
          <span style={{ fontSize: 11, color: "#6b7280" }}>потенціал {formatAmountFull(totals.potential)}</span>
        </span>
      </td>
      <td style={{ ...S.td, borderBottom: "none" }} colSpan={3} />
    </tr>
  );
}

/** Модалка — спільна оболонка, щоб обидва діалоги виглядали однаково. */
function Modal({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.45)", display: "flex",
                  alignItems: "center", justifyContent: "center", zIndex: 60 }}>
      <div style={{ ...S.card, width: 460, maxWidth: "92vw", boxShadow: "0 18px 48px rgba(0,0,0,.22)" }}>
        <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 10 }}>{title}</div>
        {children}
      </div>
    </div>
  );
}

function CreateTaskDialog({ client, busy, onCancel, onSubmit }: {
  client: { clientKey: string; name: string }; busy: boolean;
  onCancel: () => void; onSubmit: (deadline: string, comment: string) => void;
}) {
  const inWeek = (() => { const d = new Date(); d.setDate(d.getDate() + 7); return d.toISOString().slice(0, 10); })();
  const [deadline, setDeadline] = useState(inWeek);
  const [comment, setComment] = useState("");
  return (
    <Modal title={`＋ Задача реактивації · ${client.name}`}>
      <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 10, lineHeight: 1.5 }}>
        Одна задача = один клієнт. Виконавець — основний менеджер цього клієнта.
        Закрити її буде можна лише з причиною.
      </div>
      <div style={{ fontSize: 10, letterSpacing: .4, textTransform: "uppercase", color: "#6b7280", marginBottom: 4 }}>Строк</div>
      <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} style={S.input} />
      <div style={{ fontSize: 10, letterSpacing: .4, textTransform: "uppercase", color: "#6b7280", margin: "10px 0 4px" }}>Що зробити (не обовʼязково)</div>
      <input value={comment} onChange={(e) => setComment(e.target.value)}
        placeholder="подзвонити, запропонувати серпневі тарифи" style={S.input} />
      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <button style={S.btn(true)} disabled={busy} onClick={() => onSubmit(deadline, comment)}>Створити</button>
        <button style={S.btn()} disabled={busy} onClick={onCancel}>Скасувати</button>
      </div>
    </Modal>
  );
}

function CloseTaskDialog({ task, reasons, busy, onCancel, onSubmit }: {
  task: { taskId: number; name: string }; reasons: { key: string; label: string }[];
  busy: boolean; onCancel: () => void; onSubmit: (reason: string, note: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  // 🔴 «Інше» без пояснення — це та сама відсутність причини під іншою назвою.
  const needNote = reason === "other";
  const ready = reason !== "" && (!needNote || note.trim() !== "");
  return (
    <Modal title={`Закрити задачу · ${task.name}`}>
      <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 10, lineHeight: 1.5 }}>
        Причина обовʼязкова. Це єдине джерело даних про те, ЧОМУ клієнт не повернувся —
        без неї через півроку список покаже тих самих людей, і ніхто не згадає, чим скінчилась розмова.
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {reasons.map((r) => (
          <button key={r.key} onClick={() => setReason(r.key)}
            style={{ ...S.btn(reason === r.key), fontSize: 12 }}>{r.label}</button>
        ))}
      </div>
      <input value={note} onChange={(e) => setNote(e.target.value)}
        placeholder={needNote ? "Поясніть — для «Інше» обовʼязково" : "Деталі (не обовʼязково)"}
        style={{ ...S.input, marginTop: 10, borderColor: needNote && !note.trim() ? "#fca5a5" : "#d1d5db" }} />
      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <button style={S.btn(true)} disabled={busy || !ready} onClick={() => onSubmit(reason, note.trim())}>Закрити задачу</button>
        <button style={S.btn()} disabled={busy} onClick={onCancel}>Скасувати</button>
      </div>
    </Modal>
  );
}

export function ReactivationSection({ auth }: { auth: AuthPayload }) {
  const [data, setData] = useState<ReactivationResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [view, setView] = useState<"sleeping" | "lost" | "inwork" | "returned">("sleeping");
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState<{ clientKey: string; name: string } | null>(null);
  const [closing, setClosing] = useState<{ taskId: number; name: string } | null>(null);
  const [openTeams, setOpenTeams] = useState<Set<string>>(new Set());
  const [openMgrs, setOpenMgrs] = useState<Set<number>>(new Set());
  const [longLapsedOpen, setLongLapsedOpen] = useState(false);

  const load = useCallback(() => {
    setErr(null);
    fetchReactivationList().then(setData).catch((e) => setErr(e?.response?.data?.error ?? "не вдалося завантажити"));
  }, []);
  useEffect(load, [load]);

  /**
   * Стартовий вигляд — той самий, що на екрані планів (те саме рішення власника,
   * тому й та сама поведінка, а не «схожа»):
   *   тімлід       — його команда РОЗГОРНУТА одразу (вона в нього одна);
   *   адмін/ОД/КВП — усе згорнуто до команд;
   *   менеджер     — плаский список, ієрархія додала б лише два кліки.
   */
  useEffect(() => {
    if (!data || auth.role !== "team_lead") return;
    setOpenTeams(new Set(data.clients.map((c) => c.teamName ?? BEZ_KOMANDY)));
  }, [data, auth.role]);

  if (err) return <div style={{ ...S.card, color: "#dc2626" }}>{err}</div>;
  if (!data) return <div style={{ ...S.card, color: "#6b7280" }}>завантаження…</div>;

  const t = data.tiles;
  const inView = data.clients.filter((c) => {
    if (view === "sleeping") return c.state === "sleeping";
    if (view === "lost") return c.state === "lost";
    if (view === "inwork") return c.taskId != null && c.taskStatus !== "done";
    return c.returned;
  });
  // 🗄 АРХІВ — втрачені понад рік. Вони НЕ зникають (це були б втрачені дані), а
  // йдуть у згорнуту секцію: на головній сцені мають бути ті, кого ще реально
  // повернути. Порядок у «давно втрачених» — за КОЛИШНЬОЮ цінністю (найжирніші зверху), бо
  // «свіжість» там уже нічого не розрізняє.
  const rows = inView.filter((c) => !c.longLapsed);
  const longLapsed = inView.filter((c) => c.longLapsed)
    .sort((a, b) => b.lifetimeRevenue - a.lifetimeRevenue);

  /**
   * 🔴 ІЄРАРХІЯ — ЦЕ ПОДАЧА, А НЕ СКОУП. Групуємо ТІ САМІ рядки, що прийшли з
   * бекенду й пройшли той самий фільтр вкладки: жоден клієнт не додається і не
   * зникає. Клієнт кріпиться до ОДНОГО менеджера (`COALESCE(закріплений,
   * основний за оплатами)` з ядра), тож роздвоїтись між командами не може.
   * Порядок усередині — той, що прийшов із бекенду (за цінністю); рівні —
   * за Σ цінності, щоб «найважчі» команди були зверху.
   */
  const grouped = auth.role !== "manager";
  const teams = (() => {
    if (!grouped) return [];
    const byTeam = new Map<string, Map<number, { name: string; rows: ReactivationRow[] }>>();
    for (const c of rows) {
      const tk = c.teamName ?? BEZ_KOMANDY;
      const mgrs = byTeam.get(tk) ?? new Map();
      const m = mgrs.get(c.managerId) ?? { name: c.managerName, rows: [] };
      m.rows.push(c);
      mgrs.set(c.managerId, m);
      byTeam.set(tk, mgrs);
    }
    const byValue = <T extends { rows: ReactivationRow[] }>(a: T, b: T) =>
      levelTotals(b.rows).value - levelTotals(a.rows).value;
    return [...byTeam.entries()]
      .map(([teamName, mgrs]) => ({
        teamName,
        rows: [...mgrs.values()].flatMap((m) => m.rows),
        mgrs: [...mgrs.entries()].map(([id, m]) => ({ id, name: m.name, rows: m.rows })).sort(byValue),
      }))
      .sort(byValue);
  })();

  const renderRow = (c: ReactivationRow) => (
    <tr key={c.clientKey} style={{ background: c.seasonal ? "#fafafa" : undefined }}>
      <td style={S.td}>
        <div style={{ fontWeight: 700 }}>{c.clientName}</div>
        <div style={{ fontSize: 11, color: "#6b7280", marginTop: 3 }}>
          {c.orders} зам. · сер. чек {formatAmountFull(Math.round(c.lifetimeRevenue / Math.max(1, c.orders)))}
          {" · "}
          <span title={c.pinned ? "закріплений за менеджером вручну" : "основний менеджер за оплатами"}>
            👤 {c.managerName}{c.pinned ? " 📌" : ""}
          </span>
        </div>
        <div style={{ marginTop: 4 }}>
          <SegmentBadge segment={c.segment} gap={c.medianGapDays} />
          {c.forcedRegular && <ForcedBadge note={c.forceNote} />}
        </div>
      </td>
      <td style={S.td}><StateChip c={c} /></td>
      <td style={S.td}>
        <b>{formatAmountFull(c.lifetimeRevenue)}</b>
        <div style={{ fontSize: 11, color: "#9ca3af" }}>lifetime · вага {Math.round(c.value).toLocaleString("uk-UA")}</div>
      </td>
      <td style={S.td}>
        {c.taskId && c.taskStatus !== "done" ? (
          <div>
            <b>{c.taskAssignee ?? "—"}</b>
            {c.taskDeadline && <span style={{ color: "#b45309" }}> · до {c.taskDeadline.slice(5)}</span>}
            <div>
              <button disabled={busy} style={{ ...S.btn(), marginTop: 5, fontSize: 11, padding: "4px 9px" }}
                onClick={() => setClosing({ taskId: c.taskId!, name: c.clientName })}>Закрити…</button>
            </div>
          </div>
        ) : c.taskId ? (
          <span style={{ color: "#6b7280" }}>закрита</span>
        ) : c.seasonal ? (
          // 🔴 Сезонним задачі НЕ ставимо: їхній «простій» — це не втрата
          // клієнта, а календар. Смикати їх означає вчити менеджера, що
          // список реактивації можна ігнорувати.
          <span style={{ color: "#9ca3af" }}>сезонний — задача не потрібна</span>
        ) : (
          <button disabled={busy} style={{ ...S.btn(true), fontSize: 11, padding: "5px 10px" }}
            onClick={() => setCreating({ clientKey: c.clientKey, name: c.clientName })}>＋ Задача</button>
        )}
      </td>
      <td style={S.td}><TwoDates c={c} /></td>
      <td style={S.td}>
        {c.closeReason
          ? <span style={S.chip("#f3f4f6", "#4b5563")}>{data.closeReasons.find((r) => r.key === c.closeReason)?.label ?? c.closeReason}</span>
          : <span style={{ color: "#d1d5db" }}>—</span>}
        {(auth.role === "team_lead" || auth.role === "admin") && (
          <button title={c.seasonal ? "Зняти позначку «сезонний»" : "Позначити сезонним"}
            disabled={busy}
            onClick={async () => { setBusy(true);
              try { await setClientSeasonal({ clientKey: c.clientKey, seasonal: !c.seasonal }); load(); }
              finally { setBusy(false); } }}
            style={{ marginLeft: 8, border: "none", background: "transparent", cursor: "pointer", fontSize: 13 }}>
            {c.seasonal ? "↩" : "🌱"}
          </button>
        )}
      </td>
    </tr>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>Реактивація · сплячі та втрачені</h2>
          <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
            {auth.role === "manager" ? "мої клієнти" : auth.role === "team_lead" ? "моя команда" : "усі команди"}
            {" · ранжовано за цінністю клієнта (виручка за життя × свіжість)"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {([["sleeping", "Сплячі"], ["lost", "Втрачені"], ["inwork", "У роботі"], ["returned", "Повернені"]] as const).map(([k, label]) => (
            <button key={k} onClick={() => setView(k)} style={{ ...S.btn(view === k), minWidth: 92 }}>{label}</button>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {/* 🔴 ПІДПИС БРАВСЯ З НЕ ТОГО ПОРОГУ. Стояло «Сплячих (60–180 дн.)» — з
            `sleepingDays`, тобто зі СТАРОГО єдиного порога, хоча стан уже рахується
            за сегментом (14/30/60). Формально «з ядра», по суті — брехня: правило
            під плиткою казало одне, плитка інше. Тепер числа беруться з тих самих
            `bySegment`, що й правило, і виводяться СПИСКОМ унікальних порогів —
            зміниться поріг у ядрі, зміниться підпис. */}
        <Tile title={`Сплячі · поріг за сегментом (${
          [...new Set([data.thresholds.bySegment.vip, data.thresholds.bySegment.regular,
                       data.thresholds.bySegment.episodic, data.thresholds.bySegment.unknown])]
            .sort((a, b) => a - b).join("/")} дн.)`} value={String(t.sleeping)}
          sub={`потенціал ${formatAmountFull(t.sleepingPotential)} за історією`} tone={t.sleeping ? "warn" : undefined} />
        <Tile title={`Втрачених (${data.thresholds.lostDays}+ дн.)`} value={String(t.lost)}
          sub={t.seasonal ? `з них ${t.seasonal} сезонних — не смикаємо` : "сезонних немає"} />
        <Tile title="Задач у роботі" value={String(t.inWork)} sub="реактиваційні задачі без закриття" />
        <Tile title="Повернено за 30 дн." value={`${t.returned30} · +${formatAmountFull(t.returned30Revenue)}`}
          sub="замовили ПІСЛЯ реактиваційної задачі" tone="good" />
      </div>

      <div style={{ ...S.card, padding: 0, overflowX: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "12px 14px 8px" }}>
          <b style={{ fontSize: 15 }}>Кандидати на реактивацію</b>
          <span style={{ fontSize: 11, color: "#6b7280" }}>цінність = виручка за життя × свіжість · сезонні внизу</span>
        </div>

        {/* 🔴 ПРАВИЛО НАПИСАНЕ НАД СПИСКОМ, А ПОРОГИ ПРИЇХАЛИ З ЯДРА
            (`data.thresholds` ← `SLEEPING_DAYS`/`LOST_DAYS`). Зашити «60/180»
            текстом означало б завести другу редакцію правила: підкрутили б поріг
            у ядрі — і підпис почав би брехати, причому мовчки. */}
        <div style={{ margin: "0 14px 10px", background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 8,
                      padding: "8px 11px", fontSize: 12, color: "#1e3a8a", lineHeight: 1.55 }}>
          <b>Стан — від останньої ОПЛАТИ, а поріг залежить від СЕГМЕНТА:</b>{" "}
          ⚡ ВІП {data.thresholds.bySegment.vip}+ днів · 🔁 Регулярний {data.thresholds.bySegment.regular}+ ·
          {" "}🌙 Епізодичний {data.thresholds.bySegment.episodic}+ · без історії (менше{" "}
          {data.thresholds.segmentMinPayments} оплат) — {data.thresholds.bySegment.unknown}+.
          Втрачений — {data.thresholds.lostDays}+ днів для всіх. Дзвінки на стан <b>не впливають</b> — вони довідка.
          <b> Контакт = РОЗМОВА</b> (дзвінок, що відбувся); недодзвони показані окремо як
          <b> спроби</b> — щоб було видно, що менеджер працює, навіть коли контакту ще не було.
        </div>

        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 980 }}>
          <thead>
            <tr>
              <th style={S.th}>Клієнт</th><th style={S.th}>Стан</th><th style={S.th}>Цінність</th>
              <th style={S.th}>Задача</th>
              <th style={S.th}>Оплата · контакт</th>
              <th style={S.th}>Причина (при закритті)</th>
            </tr>
          </thead>
          <tbody>
            {!grouped && rows.map(renderRow)}
            {grouped && teams.map((tm) => {
              const tOpen = openTeams.has(tm.teamName);
              return (
                <Fragment key={tm.teamName}>
                  <GroupRow level="team" title={tm.teamName} open={tOpen}
                    sub={`${tm.mgrs.length} ${tm.mgrs.length === 1 ? "менеджер" : "менеджерів"}`}
                    totals={levelTotals(tm.rows)}
                    onToggle={() => setOpenTeams((prev) => {
                      const n = new Set(prev); n.has(tm.teamName) ? n.delete(tm.teamName) : n.add(tm.teamName); return n;
                    })} />
                  {tOpen && tm.mgrs.map((mg) => {
                    const mOpen = openMgrs.has(mg.id);
                    return (
                      <Fragment key={mg.id}>
                        <GroupRow level="manager" title={mg.name} open={mOpen} totals={levelTotals(mg.rows)}
                          onToggle={() => setOpenMgrs((prev) => {
                            const n = new Set(prev); n.has(mg.id) ? n.delete(mg.id) : n.add(mg.id); return n;
                          })} />
                        {mOpen && mg.rows.map(renderRow)}
                      </Fragment>
                    );
                  })}
                </Fragment>
              );
            })}
            {rows.length === 0 && longLapsed.length === 0 && (
              <tr><td colSpan={6} style={{ ...S.td, textAlign: "center", color: "#9ca3af", padding: 26 }}>у цій категорії порожньо</td></tr>
            )}
            {longLapsed.length > 0 && (
              <>
                <tr onClick={() => setLongLapsedOpen((v) => !v)}
                  style={{ background: "#f8fafc", cursor: "pointer", borderTop: "2px solid #e2e8f0" }}>
                  <td colSpan={6} style={{ ...S.td, borderBottom: "none", fontWeight: 700 }}>
                    <span style={{ color: "#64748b", marginRight: 6 }}>{longLapsedOpen ? "▾" : "▸"}</span>
                    🕰 Давно втрачені · понад рік · {longLapsed.length} — без оплат понад {Math.round(data.thresholds.longLapsedDays / 30)} міс.
                    <span style={{ fontWeight: 400, fontSize: 11, color: "#6b7280" }}>
                      {" "}· найбільші за колишньою виручкою зверху · Σ {formatAmountFull(longLapsed.reduce((x, c) => x + c.lifetimeRevenue, 0))}
                    </span>
                  </td>
                </tr>
                {longLapsedOpen && longLapsed.map(renderRow)}
              </>
            )}
          </tbody>
        </table>
        <div style={{ padding: "10px 14px", fontSize: 12, color: "#4b5563", lineHeight: 1.6, borderTop: "1px solid #f1f5f9" }}>
          <b>Стани рахуються з дат замовлень автоматично</b> — постійний → сплячий ({data.thresholds.sleepingDays} дн.)
          → втрачений ({data.thresholds.lostDays} дн.) → повернений (замовив після задачі). Тумблера «зробити сплячим»
          немає: збережений стан довелося б комусь оновлювати, і клієнт, що вчора замовив, лишався б «сплячим».
          Причина обовʼязкова при закритті задачі: {data.closeReasons.map((r) => r.label).join(" · ")}.
        </div>
      </div>

      {/* Обʼєднання — тімліду теж (у межах його команди); передача відповідального
          лишилась за правом merge_clients. Тому дві різні умови, а не одна. */}
      {(data.canMerge || data.canAssign) && (
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
          {data.canMerge && <MergePanel onDone={load} teamOnly={data.mergeScope === "team"} />}
          {data.canAssign && <ManagerPanel clients={data.clients} onDone={load} />}
        </div>
      )}

      {creating && (
        <CreateTaskDialog client={creating} busy={busy}
          onCancel={() => setCreating(null)}
          onSubmit={async (deadline, comment) => {
            setBusy(true);
            try { await createClientReactivationTask({ clientKey: creating.clientKey, deadline, comment }); setCreating(null); load(); }
            finally { setBusy(false); }
          }} />
      )}
      {closing && (
        <CloseTaskDialog task={closing} reasons={data.closeReasons} busy={busy}
          onCancel={() => setClosing(null)}
          onSubmit={async (reason, note) => {
            setBusy(true);
            try { await closeReactivationTask({ taskId: closing.taskId, reason, note }); setClosing(null); load(); }
            finally { setBusy(false); }
          }} />
      )}
    </div>
  );
}
