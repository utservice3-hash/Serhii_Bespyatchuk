import { useEffect, useState } from "react";
import { fetchDataQuality, fetchCarrierPhoneQuality, type DataQualityCheck, type Reconciliation, type CarrierPhoneQuality, type CarrierPhoneItem } from "../../../api";
import { groupCarrierItems, lacksClientPhone } from "../carrierPhoneGroups";

const HINT: Record<string, string> = {
  noManager: "Угоди повного циклу без відповідального. Випадають з усіх per-manager звітів.",
  noAmount: "Угоди на грошових етапах (Авто працює/Рахунок) із сумою 0. Занижують «очікувані» та «відправлено авто».",
  unmapped: "Статус угоди не змаплено у воронку — угода невидима для аналітики. 143 = «закрито/втрачено» (нормально), інші — треба змапити.",
  negatives: "Відʼємна сума БЕЗ прапорця «Мінусова угода» в CRM — ймовірна помилка вводу (нетить суми хибно). Знак дає поле, а не слово в назві: із 117 мінусових угод за рік лише 2 мають «мінус» у назві.",
  duplicates: "Один клієнт має 2+ активні угоди повного циклу. Або кілька перевезень (норм), або дубль — треба перевірити вручну.",
};

const KOMMO_BASE = "https://uts.kommo.com/leads/detail/";

/** «Контроль якості даних» (ТЗ §7) — записи, що спотворюють інші метрики.
 *  Джерело істини — CRM; тут підсвічуються розбіжності/аномалії. Admin/тімлід. */
export function DataQualitySection() {
  const [data, setData] = useState<DataQualityCheck[] | null>(null);
  const [recon, setRecon] = useState<Reconciliation | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    fetchDataQuality().then((r) => { setData(r.checks); setRecon(r.reconciliation); }).catch(() => setErr("Не вдалося завантажити."));
  }, []);

  return (
    <>
      <div className="page-header"><h1 className="page-title">🔍 Якість даних</h1></div>
      <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 16px", maxWidth: 760 }}>
        CRM — єдине істинне джерело; тут підсвічені записи, що можуть спотворювати цифри дашборду. Клік по картці — перелік прикладів (клік по угоді відкриває її в Kommo).
      </p>

      {/* Нічна авто-звірка — інваріанти-запобіжники (ловлять «тихі» баги). */}
      {recon && (
        <div className="chart-card" style={{ marginBottom: 16, borderLeft: `4px solid ${recon.warnings > 0 ? "#d97706" : "#16a34a"}` }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <h2 className="chart-title" style={{ marginBottom: 0 }}>
              🛡 Авто-звірка з CRM {recon.warnings > 0 ? <span style={{ color: "#d97706" }}>· {recon.warnings} попередж.</span> : <span style={{ color: "#16a34a" }}>· усе гаразд ✓</span>}
            </h2>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>прогін: {new Date(recon.ranAt).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 8, marginTop: 10 }}>
            {recon.checks.map((c) => (
              <div key={c.key} style={{ padding: "8px 10px", border: "1px solid var(--border)", borderLeft: `3px solid ${c.ok ? "#16a34a" : "#d97706"}`, borderRadius: 8 }} title={c.detail}>
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{c.label}</div>
                <div style={{ fontWeight: 700, color: c.ok ? "#16a34a" : "#d97706" }}>
                  {c.ok ? "✓ " : "⚠ "}{c.value}{c.threshold > 0 && !c.ok ? ` (поріг ${c.threshold})` : ""}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      <CarrierPhonesBlock />
      {err && <p className="loading-text" style={{ color: "#dc2626" }}>{err}</p>}
      {!data && !err && <p className="loading-text">Перевірка…</p>}
      {data && (
        <>
          <div className="kpi-grid">
            {data.map((c) => (
              <button key={c.key} className="kpi-card" onClick={() => setOpen(open === c.key ? null : c.key)}
                style={{ textAlign: "left", border: "none", cursor: "pointer", background: "var(--card-bg)", borderLeft: `4px solid ${c.count > 0 ? "#d97706" : "#16a34a"}` }}
                title="Натисніть для прикладів">
                <span className="kpi-label">{c.label}</span>
                <span className="kpi-value" style={{ color: c.count > 0 ? "#d97706" : "#16a34a" }}>{c.count > 0 ? c.count.toLocaleString("uk-UA") : "✓ 0"}</span>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{HINT[c.key]}</span>
              </button>
            ))}
          </div>

          {open && (() => {
            const c = data.find((x) => x.key === open)!;
            if (c.sample.length === 0) return <p className="loading-text" style={{ marginTop: 16 }}>Немає прикладів — усе чисто ✓</p>;
            return (
              <div className="chart-card" style={{ marginTop: 16 }}>
                <h2 className="chart-title">{c.label} — приклади ({c.sample.length}{c.count > c.sample.length ? ` з ${c.count}` : ""})</h2>
                <div style={{ overflowX: "auto" }}>
                  <table className="data-table compact" style={{ minWidth: 560 }}>
                    <thead><tr><th style={{ textAlign: "left" }}>Угода</th><th style={{ textAlign: "left" }}>Менеджер</th><th style={{ textAlign: "left" }}>Деталь</th><th></th></tr></thead>
                    <tbody>
                      {c.sample.map((s, i) => (
                        <tr key={i}>
                          <td style={{ textAlign: "left", maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.name ?? ""}>{s.name || "—"}</td>
                          <td style={{ textAlign: "left", color: "var(--text-muted)" }}>{s.manager || "—"}</td>
                          <td style={{ textAlign: "left", color: "var(--text-muted)" }}>{s.extra || "—"}</td>
                          <td><a href={`${KOMMO_BASE}${s.kommoId}`} target="_blank" rel="noreferrer" style={{ color: "#c5141c", fontSize: 12 }}>Kommo ↗</a></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })()}
        </>
      )}
    </>
  );
}

const VERDICT_LABEL: Record<CarrierPhoneItem["verdict"], string> = {
  no_phone: "немає жодного номера",
  only_carrier: "лише номери перевізників",
  has_carrier: "є номер перевізника",
};

/**
 * 📵 Задача 7359 (ТЗ Юлії «Контакти клієнтів», етап 1): клієнти екрана «Клієнти та реактивація» без номера
 * замовника або з номером перевізника — по командах і менеджерах, щоб кожен виправив свої картки в Kommo.
 * Перевізник = номер з машин Lardi або номер, який закривали як «Перевізник»; номер з угодою замовника — ні.
 */
function CarrierPhonesBlock() {
  const [d, setD] = useState<CarrierPhoneQuality | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [openTeams, setOpenTeams] = useState<Record<string, boolean>>({});
  useEffect(() => {
    fetchCarrierPhoneQuality().then(setD).catch(() => setErr("Не вдалося завантажити номери клієнтів."));
  }, []);
  if (err) return <p className="loading-text" style={{ color: "#dc2626" }}>{err}</p>;
  if (!d) return <p className="loading-text">Номери клієнтів…</p>;
  const groups = groupCarrierItems(d.items);
  const lacks = d.counts.no_phone + d.counts.only_carrier;
  // Одна команда (тімлід бачить лише свою) — розгорнута одразу.
  const isOpen = (k: string) => openTeams[k] ?? groups.length === 1;
  return (
    <div className="chart-card" style={{ marginBottom: 16, borderLeft: `4px solid ${d.items.length > 0 ? "#d97706" : "#16a34a"}` }}>
      <h2 className="chart-title" style={{ marginBottom: 4 }}>
        📵 Номери клієнтів · {d.items.length > 0 ? <span style={{ color: "#d97706" }}>{d.items.length} з {d.counts.clients}</span> : <span style={{ color: "#16a34a" }}>усе гаразд ✓</span>}
      </h2>
      <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 10px", maxWidth: 820 }}>
        Клієнти екрана «Клієнти та реактивація»: <b>без номера замовника — {lacks}</b> (немає номера {d.counts.no_phone}, лише
        номери перевізників {d.counts.only_carrier}) · <b>є номер перевізника — {d.counts.has_carrier}</b>.
        Перевізник — номер із машин Lardi або номер, який закривали як «Перевізник»; номер з угодою замовника в роботі чи
        в «Успіх» перевізником не вважається. Розмови на номери перевізників на екрані клієнтів не рахуються.
        {" "}Довідник: {d.dictionary.phones.toLocaleString("uk-UA")} номерів
        {d.dictionary.rebuiltAt ? `, оновлено ${d.dictionary.rebuiltAt}` : " — ще не зібрано (перевізників поки не виключено)"}.
      </p>
      {groups.map((t) => (
        <div key={t.teamKey} style={{ borderTop: "1px solid var(--border)", padding: "6px 0" }}>
          <button type="button" onClick={() => setOpenTeams((o) => ({ ...o, [t.teamKey]: !isOpen(t.teamKey) }))}
            style={{ border: "none", background: "transparent", cursor: "pointer", fontWeight: 700, fontSize: 13, padding: 0, color: "var(--text)" }}>
            {isOpen(t.teamKey) ? "▾" : "▸"} {t.teamName} · {t.total}
          </button>
          {isOpen(t.teamKey) && t.managers.map((m) => (
            <div key={m.managerId} style={{ margin: "6px 0 4px 16px" }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2 }}>{m.managerName} · {m.items.length}</div>
              <table className="data-table compact" style={{ minWidth: 560 }}>
                <tbody>
                  {m.items.map((it) => (
                    <tr key={it.clientKey}>
                      <td style={{ textAlign: "left", width: 260, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={it.clientName}>{it.clientName}</td>
                      <td style={{ textAlign: "left", whiteSpace: "nowrap", color: lacksClientPhone(it.verdict) ? "#dc2626" : "#d97706", fontSize: 12 }}>{VERDICT_LABEL[it.verdict]}</td>
                      <td style={{ textAlign: "left", fontSize: 12 }}>
                        {it.phones.length === 0 ? <span style={{ color: "var(--text-muted)" }}>у контактах угод номерів немає</span>
                          : it.phones.map((p) => (
                            <span key={p.phone} style={{ display: "inline-block", marginRight: 10, color: p.carrier ? "#b45309" : "var(--text-muted)" }}>
                              {p.phone}
                              {p.carrier?.lardi && <span title={p.carrier.lardiCompany ?? undefined}> · Lardi{p.carrier.lardiCompany ? ` (${p.carrier.lardiCompany})` : ""}</span>}
                              {p.carrier?.history && (p.carrier.historyUrl
                                ? <> · <a href={p.carrier.historyUrl} target="_blank" rel="noreferrer" style={{ color: "#c5141c" }}>«Перевізник» ↗</a></>
                                : " · «Перевізник»")}
                            </span>
                          ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
