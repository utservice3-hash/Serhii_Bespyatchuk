import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchAiTeamReport, hiringError, type AiManagerLineT, type AiPoolRowT, type AiTeamReportResp } from "../../../api";
import { InfoHint } from "../widgets";
import { PROMISE_UI, TONE_COLOR } from "../aiCallsView";
import { AiCallDrawer } from "./AiCallDrawer";

/**
 * 📊 «ПЕРШИЙ ДОТИК» У ЗВІТІ (ТЗ «звіт тімліда» 30.09.2026, п.6). Менеджер бачить себе, тімлід — свою команду (кламп
 * на сервері). Таблиця по менеджерах і пул заявок — з ТИХ САМИХ рядків сервера, а фільтри пулу — готові прапорці
 * сервера, тож число в клітинці й список за ним не розходяться. Угорі — червоний банер «Пообіцяв і не передзвонив»:
 * лише невиконані домовленості без «Опрацьовано». Ролі без вкладки блок не бачать (403 → ховається).
 */

type SortKey = keyof Pick<AiManagerLineT, "managerName" | "accepted" | "priceVoiced" | "pricePct" | "noPriceNoComment" | "agreements" | "done" | "late" | "missed">;
const COLS: readonly { key: SortKey; label: string; hint?: string }[] = [
  { key: "managerName", label: "Менеджер" },
  { key: "accepted", label: "Прийнято заявок з реклами", hint: "Перші розмови рекламних угод, які модель визнала запитом на перевезення (або непевні — з «Перевірити тип»). Лідген і повторні контакти не рахуються." },
  { key: "priceVoiced", label: "Озвучено ціну" },
  { key: "pricePct", label: "%", hint: "Від розібраних розмов: ще не розібрана розмова не читається як «ціну не назвали»." },
  { key: "noPriceNoComment", label: "Без ціни й коментаря", hint: "Ціни не було, а «Чому не озвучено ціну» ще ніхто не написав." },
  { key: "agreements", label: "Домовленостей", hint: "Менеджер пообіцяв передзвонити. Обіцянки в месенджер не перевіряються й сюди не входять." },
  { key: "done", label: "Виконано", hint: "Той, хто обіцяв, передзвонив до терміну." },
  { key: "late", label: "Запізнився", hint: "Передзвонив, але пізніше терміну." },
  { key: "missed", label: "Не передзвонив", hint: "Дзвінка того, хто обіцяв, немає, а дзвінки вже синхронізовано за термін." },
];

type PoolKey = "all" | "noPrice" | "noComment" | "missed" | "typeCheck";
const POOL: readonly { key: PoolKey; label: string; match: (r: AiPoolRowT) => boolean }[] = [
  { key: "all", label: "Усі", match: () => true },
  { key: "noPrice", label: "Без ціни", match: (r) => r.flags.noPrice },
  { key: "noComment", label: "Без коментаря", match: (r) => r.flags.noComment },
  { key: "missed", label: "Не передзвонив", match: (r) => r.flags.missed },
  { key: "typeCheck", label: "Перевірити тип", match: (r) => r.typeCheck },
];

const fmt = (iso: string) => new Date(iso).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const num: React.CSSProperties = { padding: "6px 10px", textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };
const muted: React.CSSProperties = { color: "var(--text-muted)" };
const chip = (tone: keyof typeof TONE_COLOR, text: string) =>
  <span style={{ background: TONE_COLOR[tone].bg, color: TONE_COLOR[tone].fg, borderRadius: 999, padding: "1px 8px", fontSize: 12, whiteSpace: "nowrap" }}>{text}</span>;

export function FirstTouchReportCard({ from, to, teamId }: { from: string; to: string; teamId?: number }) {
  const [rep, setRep] = useState<AiTeamReportResp | null>(null);
  const [hidden, setHidden] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "missed", desc: true });
  const [pool, setPool] = useState<{ managerId: number | null | "all"; title: string } | null>(null);
  const [poolKey, setPoolKey] = useState<PoolKey>("all");
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setErr(null);
    fetchAiTeamReport({ from, to, teamId })
      .then((x) => { if (alive) setRep(x); })
      .catch((e) => {
        if (!alive) return;
        if ((e as { response?: { status?: number } })?.response?.status === 403) setHidden(true);
        else setErr(hiringError(e));
      });
    return () => { alive = false; };
  }, [from, to, teamId, reload]);

  const managers = useMemo(() => {
    if (!rep) return [];
    const k = sort.key;
    return [...rep.managers].sort((a, b) => {
      const va = a[k], vb = b[k];
      const c = typeof va === "string" || typeof vb === "string" ? String(va).localeCompare(String(vb), "uk") : (Number(va ?? -1) - Number(vb ?? -1));
      return sort.desc ? -c : c;
    });
  }, [rep, sort]);
  const onClose = useCallback(() => setOpen(null), []);

  if (hidden) return null;
  if (err) return <div className="chart-card"><p style={{ margin: 0, color: "var(--danger, #b3261e)" }}>{err}</p></div>;
  if (!rep) return <div className="chart-card"><p className="loading-text" style={{ margin: 0 }}>Перший дотик: завантаження…</p></div>;

  const bannerRows = rep.rows.filter((r) => r.flags.banner);
  const poolRows = pool ? rep.rows.filter((r) => (pool.managerId === "all" || r.managerId === pool.managerId) && POOL.find((p) => p.key === poolKey)!.match(r)) : [];
  const cell = (l: AiManagerLineT, k: SortKey) => k === "pricePct" ? (l.pricePct == null ? "—" : `${String(l.pricePct)}%`) : String(l[k]);

  return (
    <div className="chart-card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <h3 style={{ margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
        Перший дотик · звіт по менеджерах
        <InfoHint text="Лише перші розмови з реклами, які є запитом на перевезення. Ціна, домовленості й чи передзвонив той, хто обіцяв, — з розбору розмови й дзвінків Ringostat. Клік по «Заявки» — усі розмови менеджера з фільтрами." />
      </h3>

      {rep.banner.total > 0 && (
        <div role="alert" style={{ background: "var(--danger-bg, #fde8e8)", border: "1px solid var(--danger, #b3261e)", borderRadius: 8, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontWeight: 700, color: "var(--danger, #b3261e)", fontSize: 15 }}>Пообіцяв і не передзвонив · {rep.banner.total}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {rep.banner.byManager.map((m) => <span key={String(m.managerId)}>{chip("bad", `${m.managerName} · ${String(m.count)}`)}</span>)}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 13 }}>
            {bannerRows.slice(0, 12).map((r) => (
              <button key={r.uniqueid} type="button" onClick={() => setOpen(r.uniqueid)}
                style={{ textAlign: "left", background: "none", border: 0, padding: "2px 0", cursor: "pointer", color: "inherit", font: "inherit" }}>
                {fmt(r.calledAt)} · <b>{r.managerName ?? "невідомий"}</b> · {r.summary ?? "—"}
              </button>
            ))}
            {bannerRows.length > 12 && <span style={muted}>ще {String(bannerRows.length - 12)} — у «Заявках» з фільтром «Не передзвонив»</span>}
          </div>
          <div style={{ fontSize: 12, ...muted }}>Рядок зникає, коли менеджер передзвонить або тімлід напише «Опрацьовано» в картці розмови.</div>
        </div>
      )}

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
          <thead>
            <tr style={{ color: "var(--text-muted)", fontSize: 12.5 }}>
              {COLS.map((c) => (
                <th key={c.key} style={{ ...(c.key === "managerName" ? { padding: "6px 10px", textAlign: "left" } : num), cursor: "pointer" }}
                  aria-sort={sort.key === c.key ? (sort.desc ? "descending" : "ascending") : "none"}
                  onClick={() => setSort((s) => ({ key: c.key, desc: s.key === c.key ? !s.desc : c.key !== "managerName" }))}>
                  <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>{c.label}{sort.key === c.key ? (sort.desc ? " ↓" : " ↑") : ""}{c.hint && <InfoHint text={c.hint} />}</span>
                </th>
              ))}
              <th style={num} />
            </tr>
          </thead>
          <tbody>
            {managers.map((l) => (
              <tr key={String(l.managerId)} style={{ borderTop: "1px solid var(--border)" }}>
                {COLS.map((c) => (
                  <td key={c.key} style={c.key === "managerName" ? { padding: "6px 10px" } : { ...num, color: c.key === "missed" && l.missed > 0 ? "var(--danger, #b3261e)" : c.key === "noPriceNoComment" && l.noPriceNoComment > 0 ? "var(--warn-fg, #8a5a00)" : undefined, fontWeight: c.key === "missed" && l.missed > 0 ? 700 : undefined }}>
                    {c.key === "managerName" ? <>{l.managerName}{l.teamName && <div style={{ fontSize: 12, ...muted }}>{l.teamName}</div>}</> : cell(l, c.key)}
                  </td>
                ))}
                <td style={num}><button type="button" className="hr-btn" onClick={() => { setPool({ managerId: l.managerId, title: l.managerName }); setPoolKey("all"); }}>Заявки</button></td>
              </tr>
            ))}
            {managers.length === 0 && <tr><td colSpan={COLS.length + 1} style={{ padding: 12, ...muted }}>За період заявок з реклами немає.</td></tr>}
            {managers.length > 1 && (
              <tr style={{ borderTop: "2px solid var(--border)", fontWeight: 700 }}>
                {COLS.map((c) => <td key={c.key} style={c.key === "managerName" ? { padding: "6px 10px" } : num}>{c.key === "managerName" ? "Разом по команді" : cell(rep.total, c.key)}</td>)}
                <td style={num}><button type="button" className="hr-btn" onClick={() => { setPool({ managerId: "all", title: "уся команда" }); setPoolKey("all"); }}>Заявки</button></td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {pool && (
        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <b>Заявки · {pool.title}</b>
            <div className="hr-seg2" role="group" aria-label="Фільтр заявок">
              {POOL.map((p) => {
                const n = rep.rows.filter((r) => (pool.managerId === "all" || r.managerId === pool.managerId) && p.match(r)).length;
                return <button key={p.key} type="button" className={poolKey === p.key ? "on" : ""} aria-pressed={poolKey === p.key} onClick={() => setPoolKey(p.key)}>{p.label} · {n}</button>;
              })}
            </div>
            <button type="button" className="hr-btn" style={{ marginLeft: "auto" }} onClick={() => setPool(null)}>Закрити</button>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ color: "var(--text-muted)", fontSize: 12.5, textAlign: "left" }}>
                  <th style={{ padding: "5px 8px" }}>Дата</th><th style={{ padding: "5px 8px" }}>Клієнт</th><th style={{ padding: "5px 8px" }}>Ціна</th>
                  <th style={{ padding: "5px 8px" }}>Чому ні</th><th style={{ padding: "5px 8px" }}>Домовленість</th><th style={{ padding: "5px 8px" }}>Заперечення</th>
                  <th style={{ padding: "5px 8px" }}>Короткий зміст</th>
                </tr>
              </thead>
              <tbody>
                {poolRows.map((r) => (
                  <tr key={r.uniqueid} tabIndex={0} onClick={() => setOpen(r.uniqueid)} onKeyDown={(e) => { if (e.key === "Enter") setOpen(r.uniqueid); }}
                    style={{ borderTop: "1px solid var(--border)", cursor: "pointer", verticalAlign: "top" }}>
                    <td style={{ padding: "5px 8px", whiteSpace: "nowrap" }}>{fmt(r.calledAt)}{pool.managerId === "all" && <div style={{ fontSize: 12, ...muted }}>{r.managerName ?? "невідомий"}</div>}</td>
                    <td style={{ padding: "5px 8px", whiteSpace: "nowrap" }}>{r.clientPhone ?? <span style={muted}>номера немає</span>}{r.kommoIds.length > 0 && <div style={{ fontSize: 12, ...muted }}>угода {r.kommoIds.join(", ")}</div>}</td>
                    <td style={{ padding: "5px 8px", whiteSpace: "nowrap" }}>{!r.flags.analysed ? <span style={muted}>ще не розібрано</span> : r.priceDiscussed ? <>так{r.priceValue ? ` · ${r.priceValue}` : ""}</> : chip("warn", "ні")}</td>
                    <td style={{ padding: "5px 8px", maxWidth: 220 }}>{r.priceNote?.text ?? (r.flags.noPrice ? chip("warn", "без коментаря") : <span style={muted}>—</span>)}</td>
                    <td style={{ padding: "5px 8px" }}>{r.promiseState ? chip(PROMISE_UI[r.promiseState].tone, PROMISE_UI[r.promiseState].label) : <span style={muted}>немає</span>}{r.missedNote && <div style={{ fontSize: 12, ...muted }}>опрацьовано</div>}</td>
                    <td style={{ ...num, textAlign: "center" }}>{r.flags.analysed ? r.objections : "—"}</td>
                    <td style={{ padding: "5px 8px", maxWidth: 380 }}>{r.typeCheck && <div style={{ marginBottom: 2 }}>{chip("warn", "Перевірити тип")}</div>}{r.summary ?? <span style={muted}>—</span>}</td>
                  </tr>
                ))}
                {poolRows.length === 0 && <tr><td colSpan={7} style={{ padding: 10, ...muted }}>Під цей фільтр заявок немає.</td></tr>}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 12, ...muted }}>Клік по рядку — картка розмови: розбір, транскрипція, запис і коментарі.</div>
        </div>
      )}

      {open && <AiCallDrawer uniqueid={open} onClose={onClose} onChanged={() => setReload((x) => x + 1)} />}
    </div>
  );
}
