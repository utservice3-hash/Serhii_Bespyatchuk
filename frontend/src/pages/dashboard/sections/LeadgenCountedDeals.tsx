import { useEffect, useMemo, useState } from "react";
import { fetchLeadgenStageDeals, fetchLeadgenLtvClients, type LeadgenStageDeal, type LeadgenStageDealsResp, type LeadgenLtvClientsResp } from "../../../api";
import { ClientTable } from "./LeadgenLtvBlock";

/**
 * 🔎 «ЯКІ УГОДИ РАХУЄМО» (рішення власника 16.10.2026, регламент лідгенів §14, §16): окремий екран вкладки «Лідогенерація»
 * (перемикач «Статистика / Які угоди рахуємо»); період і лідген — спільні з екраном статистики (вибір угорі вкладки).
 * Угоди одного лідгена за вибраний період, які дашборд зарахував у ліди, ОПР і прорахунки, — щоб звірити з Kommo самим.
 * Числа вкладок рахує той самий сервер тими самими правилами, що картки лідгенів (`#1506`). Позначки описують шлях
 * угоди, а не оцінюють його (рішення 14.10: відхилення від регламенту в дашборді не показуємо).
 */
type Tab = "lead" | "opr" | "quote" | "ltv";
const MUTED = "var(--text-muted)";
const fmt = new Intl.DateTimeFormat("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const fmtSec = new Intl.DateTimeFormat("uk-UA", { timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const when = (iso: string | null) => (iso ? fmt.format(new Date(iso)).replace(",", "") : "—");

function Tag({ tone, children, title }: { tone: "warn" | "info"; children: React.ReactNode; title: string }) {
  const c = tone === "warn" ? "var(--warn)" : "var(--accent)";
  return <span title={title} style={{ display: "inline-block", fontSize: 11.5, fontWeight: 600, color: c, border: `1px solid ${c}`, borderRadius: 999, padding: "1px 7px", whiteSpace: "nowrap", marginRight: 4 }}>{children}</span>;
}

export function LeadgenCountedDeals({ from, to, periodLabel, own, managerId, people, onPick, startTab }: {
  from: string; to: string; periodLabel: string; own: boolean;
  /** З якої вкладки почати: «усі клієнти →» у блоці LTV відкриває «Клієнти LTV». */
  startTab?: Tab;
  /** Лідген, вибраний угорі вкладки; `null` — «Усі лідгени» (тоді просимо обрати одного). */
  managerId: number | null;
  people: { managerId: number; name: string }[];
  onPick: (id: number) => void;
}) {
  const [tab, setTab] = useState<Tab>(startTab ?? "lead");
  // 💎 «Клієнти LTV» (ТЗ LTV 28.10.2026, п. 5.4) — за весь час, від періоду не залежить; без вибраного лідгена — усі.
  const [ltv, setLtv] = useState<LeadgenLtvClientsResp | null>(null);
  const [ltvErr, setLtvErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setLtvErr(null);
    fetchLeadgenLtvClients({ managerId: own || managerId == null ? undefined : managerId })
      .then((r) => { if (alive) setLtv(r); })
      .catch((e) => { if (alive) { setLtv(null); setLtvErr(e?.response?.data?.error ?? "Не вдалося завантажити клієнтів LTV."); } });
    return () => { alive = false; };
  }, [managerId, own]);
  const [d, setD] = useState<LeadgenStageDealsResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const need = !own && managerId == null && tab !== "ltv";

  useEffect(() => {
    if (!own && managerId == null) { setD(null); return; } // без лідгена списку етапів немає (лише «Клієнти LTV» — усі)
    let alive = true;
    setLoading(true); setErr(null);
    fetchLeadgenStageDeals({ from, to, managerId: own ? undefined : managerId ?? undefined })
      .then((r) => { if (alive) setD(r); })
      .catch((e) => { if (alive) { setD(null); setErr(e?.response?.data?.error ?? "Не вдалося завантажити список. Спробуйте ще раз."); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [from, to, managerId, own]);

  const rows = useMemo(() => {
    const xs = (d?.deals ?? []).filter((x) => (tab === "lead" ? x.leadAt : tab === "opr" ? x.oprAt : x.quoteAt));
    const at = (x: LeadgenStageDeal) => (tab === "lead" ? x.leadAt : tab === "opr" ? x.oprAt : x.quoteAt) ?? "";
    return xs.sort((a, b) => at(a).localeCompare(at(b)));
  }, [d, tab]);

  const counted = (x: LeadgenStageDeal) => tab === "lead" ? `${x.leadStage ?? "—"} · ${when(x.leadAt)}`
    : tab === "opr" ? `${x.oprStage ?? "—"} · ${when(x.oprAt)}` : `Кваліфіковано · ${when(x.quoteAt)}`;
  const tabs: [Tab, string, number | undefined][] = [["lead", "Ліди", d?.counts.leads], ["opr", "ОПР", d?.counts.opr], ["quote", "Прорахунки", d?.counts.quotes],
    ["ltv", "Клієнти LTV", ltv?.clients.length]];
  const th: React.CSSProperties = { textAlign: "left", padding: "7px 8px", fontSize: 11.5, color: MUTED, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".3px", borderBottom: "1px solid var(--border)" };
  const td: React.CSSProperties = { padding: "7px 8px", borderBottom: "1px solid var(--border)", verticalAlign: "top", fontSize: 13 };

  const who = people.find((p) => p.managerId === (d?.managerId ?? managerId))?.name;
  return (
    <div style={{ background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 15, padding: "16px 18px 18px", display: "flex", flexDirection: "column", gap: 12, marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Які угоди рахуємо</h2>
          <span style={{ color: MUTED, fontSize: 13 }}>{who ? `${who} · ` : ""}{periodLabel}{loading && d ? " · оновлюю…" : ""}</span>
        </div>

        {need && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 14 }}>Оберіть лідгена — у списку вгорі або тут:</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {people.map((p) => (
                <button key={p.managerId} type="button" onClick={() => onPick(p.managerId)}
                  style={{ border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", borderRadius: 999, padding: "5px 12px", cursor: "pointer", fontSize: 13 }}>{p.name}</button>
              ))}
            </div>
          </div>
        )}

        <div style={{ fontSize: 12.5, color: MUTED, background: "var(--bg)", borderRadius: 8, padding: "8px 10px", lineHeight: 1.55 }}>
          <b style={{ color: "var(--text)" }}>Лід</b> — угоду перевели в Продзвоні на «Взято в роботу» або «Отримано контакти ОПР», або в Реактивації на «Клієнт підігрівається».{" "}
          <b style={{ color: "var(--text)" }}>ОПР</b> — «Отримано контакти ОПР» або «Клієнт підігрівається».{" "}
          <b style={{ color: "var(--text)" }}>Прорахунок</b> — «Кваліфіковано», якщо його не повернули й не закрили протягом 15 хв.{" "}
          Одна угода за період рахується один раз; угода — на того, хто відповідальний за неї зараз; день — за київським часом.
        </div>

        {<div role="tablist" style={{ display: "flex", gap: 4, borderBottom: "1px solid var(--border)" }}>
          {tabs.map(([k, label, n]) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
              style={{ border: 0, background: "transparent", padding: "7px 12px", cursor: "pointer", fontSize: 14, color: tab === k ? "var(--text)" : MUTED,
                fontWeight: tab === k ? 700 : 500, borderBottom: tab === k ? "2px solid var(--text)" : "2px solid transparent", marginBottom: -1 }}>
              {label} <span style={{ color: MUTED, fontWeight: 600 }}>{n ?? "…"}</span>
            </button>
          ))}
        </div>}

        {tab === "ltv" && <>
          <div style={{ fontSize: 12.5, color: MUTED }}>
            Клієнти, чия перша успішна угода виросла з переданого ліда, — за весь час, незалежно від періоду. «Хто передав» — хто перевів угоду
            Продзвону в «Кваліфіковано». LTV — маржа всіх успішних угод клієнта; оборот — сума їхніх рахунків, довідково.
          </div>
          {ltvErr && <div style={{ color: "var(--danger)", fontSize: 13 }}>{ltvErr}</div>}
          {!ltv && !ltvErr && <div style={{ color: MUTED, fontSize: 13 }}>Завантажую…</div>}
          {ltv && ltv.clients.length === 0 && <div style={{ color: MUTED, fontSize: 13 }}>Клієнтів, приведених цим лідгеном, ще немає.</div>}
          {ltv && ltv.clients.length > 0 && <ClientTable rows={ltv.clients} wide />}
          {ltv && ltv.pool.length > 0 && <>
            <div style={{ fontWeight: 650, marginTop: 6 }}>Повернуті з пулу <span style={{ color: MUTED, fontWeight: 400, fontSize: 12.5 }}>· маржа лише після повернення, в основний LTV не входить</span></div>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr><th style={th}>Клієнт</th><th style={th}>Узяв із пулу</th><th style={th}>Коли</th><th style={{ ...th, textAlign: "right" }}>Угод після</th><th style={{ ...th, textAlign: "right" }}>Маржа після ₴</th><th style={th}>Позначка</th></tr></thead>
              <tbody>{ltv.pool.map((p) => (
                <tr key={p.clientKey}><td style={td}>{p.name}</td><td style={td}>{p.handedBy}</td><td style={td}>{p.takenAt}</td>
                  <td style={{ ...td, textAlign: "right" }}>{p.deals}</td><td style={{ ...td, textAlign: "right" }}>{p.ltv.toLocaleString("uk-UA")}</td>
                  <td style={td}><Tag tone="info" title="Клієнта взяли з «Пулу лідгенів»">повернутий з пулу</Tag></td></tr>
              ))}</tbody>
            </table>
          </>}
        </>}
        {tab !== "ltv" && err && <div style={{ color: "var(--danger)", fontSize: 13 }}>{err}</div>}
        {tab !== "ltv" && loading && !d && <div style={{ color: MUTED, fontSize: 13 }}>Завантажую…</div>}
        {tab !== "ltv" && d && rows.length === 0 && !loading && <div style={{ color: MUTED, fontSize: 13 }}>За цей період таких угод немає.</div>}
        {tab !== "ltv" && d && rows.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 760 }}>
              <thead><tr><th style={th}>Угода</th><th style={th}>Назва · джерело</th><th style={th}>Що зарахувалось</th><th style={th}>Шлях етапів</th><th style={th}>Позначка</th></tr></thead>
              <tbody>
                {rows.map((x) => (
                  <tr key={x.dealId}>
                    <td style={{ ...td, whiteSpace: "nowrap" }}><a href={x.url} target="_blank" rel="noreferrer" style={{ color: "var(--accent)", fontWeight: 600 }}>{x.dealId} ↗</a></td>
                    <td style={{ ...td, maxWidth: 240 }}>{x.name ?? "—"}<div style={{ color: MUTED, fontSize: 12 }}>{x.source ?? ""}</div></td>
                    <td style={{ ...td, whiteSpace: "nowrap" }}>{counted(x)}</td>
                    <td style={{ ...td, color: MUTED, fontSize: 12.5 }}>
                      {x.path.map((p, i) => <div key={i}>{when(p.at)} · {p.stage}</div>)}
                    </td>
                    <td style={td}>
                      {x.flags.noTaken && <Tag tone="warn" title="ОПР у Продзвоні, а «Взято в роботу» до нього не ставили">без «Взято»</Tag>}
                      {x.flags.fastSec != null && <Tag tone="warn" title={`«Взято в роботу» і ОПР з різницею ${x.flags.fastSec} с (останній «Взято» ${x.oprAt ? fmtSec.format(new Date(new Date(x.oprAt).getTime() - x.flags.fastSec * 1000)) : ""})`}>Взято й ОПР за {x.flags.fastSec} с</Tag>}
                      {x.flags.fromReact && <Tag tone="info" title="До ліда угода вже була в «Клієнт підігрівається» Реактивації">з реактивації</Tag>}
                      {x.manualQuote && <Tag tone="info" title="Етап повернули протягом 15 хв, але угода менеджера лишилась у роботі; прорахунок зараховано рішенням керівника">прорахунок зараховано вручну</Tag>}
                      {x.manualOwner && <Tag tone="info" title="У CRM відповідальний за угоду інший, але етапи робив цей лідген; угоду закріплено за ним рішенням керівника">закріплено вручну</Tag>}
                      {!x.flags.noTaken && x.flags.fastSec == null && !x.flags.fromReact && !x.manualQuote && !x.manualOwner && <span style={{ color: MUTED }}>—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ fontSize: 12, color: MUTED }}>Угода відкривається в Kommo. Позначки описують шлях угоди й нічого не віднімають від цифр.</div>
    </div>
  );
}
