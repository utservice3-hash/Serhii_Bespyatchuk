import { useState } from "react";
import { fetchLardiCheck, type LardiCheckOffer, type LardiCheckResp, type LardiCheckUser, type RegistryActivity } from "../../../api";
import { InfoHint } from "../widgets";

/**
 * 🔎 «ПЕРЕВІРИТИ НОМЕР НА ЛАРДІ» (задача 8136, ТЗ Юлі) — лідген вводить номер і за хвилину бачить, чи це не експедиція
 * або перевізник, чий вантаж уже висить на Ларді з ціною. Усе рахує сервер (`core/lardiCheckRules.ts`); тут лише показ.
 */
const MUTED = "var(--text-muted)";
const RULES = "Номер шукаємо на Ларді (назва, місто, відгуки) і в архіві заявок Ларді, який збирає дашборд. "
  + "Архів — це маршрути, які шукали в калькуляторі ставок, а не весь Ларді: «немає в архіві» не означає «немає на Ларді». "
  + "Типу компанії (вантажовідправник чи експедиція) Ларді не віддає — видно лише, що саме компанія розміщує: вантажі чи машини. "
  + "Тому для кожної знайденої компанії дашборд бере код ЄДРПОУ / ІПН з її профілю на Ларді й показує вид діяльності (КВЕД) з ЄДР "
  + "через YouControl. Якщо основний вид діяльності транспортний (експедирування 52.29, вантажний автотранспорт 49.41 "
  + "чи інший транспортний код) — вердикт угорі каже «не передавати». Нетранспортний вид діяльності рішення не приймає: його лишаємо вам.";
const TONE: Record<string, { bg: string; fg: string; line: string; mark: string }> = {
  no: { bg: "#fef2f2", fg: "#991b1b", line: "#fca5a5", mark: "⛔" },
  yes: { bg: "#f0fdf4", fg: "#166534", line: "#86efac", mark: "✅" },
  ask: { bg: "#fffbeb", fg: "#92400e", line: "#fcd34d", mark: "❔" },
};
const dm = (ymd: string) => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}`;
const price = (o: LardiCheckOffer) =>
  o.total != null && o.total > 0 ? `${Math.round(o.total).toLocaleString("uk-UA")} ${o.currency ?? ""}`.trim() : o.negotiable ? "договірна" : "—";

export function LeadgenLardiCheck() {
  const [phone, setPhone] = useState("");
  const [res, setRes] = useState<LardiCheckResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);

  const run = async () => {
    if (busy || !phone.trim()) return;
    setBusy(true); setErr(null);
    try { setRes(await fetchLardiCheck(phone.trim())); setMore(false); }
    catch (e) {
      setRes(null);
      const msg = (e as { response?: { data?: { error?: string } } }).response?.data?.error;
      setErr(msg ?? "Не вдалося перевірити номер — спробуйте ще раз.");
    } finally { setBusy(false); }
  };

  const v = res?.verdict;
  const tone = v ? TONE[v.pass === true ? "yes" : v.pass === false ? "no" : "ask"] : null;
  return (
    <div className="chart-card" style={{ margin: "4px 0 14px" }}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>🔎 Перевірити номер на Ларді<InfoHint text={RULES} /></div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input value={phone} onChange={(e) => setPhone(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void run(); }}
          placeholder="Номер клієнта, напр. 067 123 45 67" inputMode="tel" aria-label="Номер телефону для перевірки на Ларді"
          style={{ padding: "9px 12px", borderRadius: 9, border: "1px solid var(--border)", minWidth: 250, fontSize: 14, background: "var(--card-bg)", color: "var(--text)" }} />
        <button onClick={() => void run()} disabled={busy || !phone.trim()}
          style={{ padding: "9px 18px", borderRadius: 9, border: "none", background: "#2f6fdb", color: "#fff", fontWeight: 700,
            cursor: busy || !phone.trim() ? "default" : "pointer", opacity: busy || !phone.trim() ? 0.6 : 1 }}>
          {busy ? "Перевіряю…" : "Перевірити"}
        </button>
        <span style={{ color: MUTED, fontSize: 12.5 }}>Перед передачею прорахунку менеджеру — щоб не передати експедицію.</span>
      </div>
      {err && <div style={{ marginTop: 10, color: "var(--danger)", fontSize: 13.5 }}>{err}</div>}
      {res && v && tone && (
        <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
          <div style={{ background: tone.bg, color: tone.fg, border: `1px solid ${tone.line}`, borderRadius: 10, padding: "10px 14px" }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>{tone.mark} {res.phone} — {v.title}</div>
            <div style={{ fontSize: 13.5, marginTop: 2 }}>{v.advice}</div>
          </div>
          {!res.lardi.ok && <div style={{ color: MUTED, fontSize: 13.5 }}>Ларді зараз не відповів — показано лише архів дашборда.</div>}
          {res.lardi.users.length > 0 && (
            <div style={{ display: "grid", gap: 6 }}>
              {res.lardi.users.map((u) => <LardiUserCard key={u.refId} u={u} />)}
            </div>
          )}
          <div>
            <button onClick={() => setMore(!more)}
              style={{ background: "none", border: "none", padding: 0, color: "#2f6fdb", cursor: "pointer", fontSize: 13 }}>
              {more ? "▾ Сховати подробиці" : "▸ Подробиці: Ларді, заявки, усі види діяльності"}
            </button>
          </div>
          {more && <Details res={res} />}
        </div>
      )}
    </div>
  );
}

/* ───────────── 🏛 Компанія з Ларді + вид діяльності з ЄДР (24.11.2026) ─────────────
 * Роман 24.11: «перевірка номера дуже складно виглядає, памʼятай першочергову ціль». Ціль — за секунду зрозуміти, хто це.
 * Тому з першого погляду видно лише вердикт і по рядку на компанію: назва + основний вид діяльності. Решта (місто, відгуки,
 * інші КВЕД, архів заявок) — під «Подробиці», згорнуто. */

const ymdToDmy = (ymd: string) => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}.${ymd.slice(0, 4)}`;

function KvedLine({ a, big }: { a: RegistryActivity; big?: boolean }) {
  const transport = !!a.transport;
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
      {big && transport && (
        <span style={{ fontWeight: 700, fontSize: 12.5, padding: "2px 8px", borderRadius: 6, background: "#dbeafe", color: "#1e3a8a", whiteSpace: "nowrap" }}>
          🚚 транспорт
        </span>
      )}
      <span style={{ fontSize: big ? 14 : 13, fontWeight: big ? 600 : 400, color: big ? "var(--text)" : MUTED }}>
        {!big && transport ? "🚚 " : ""}{a.name || "назву виду діяльності реєстр не віддав"}
      </span>
      <span title={a.old ? "Код за старим класифікатором КВЕД-2005: так записано в цій копії реєстру" : undefined}
        style={{ fontSize: 12, color: MUTED, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
        КВЕД {a.code}{a.old ? " (2005)" : ""}
      </span>
    </div>
  );
}

/** Рядок під назвою: основний вид діяльності, або коротко — чому його немає. */
function MainActivity({ u }: { u: LardiCheckUser }) {
  const note = (t: string) => <div style={{ color: MUTED, fontSize: 13 }}>{t}</div>;
  if (!u.firmCode) return note("Вид діяльності невідомий: код ЄДРПОУ Ларді для цієї компанії не віддав.");
  const r = u.registry;
  if (!r) return note("Вид діяльності не перевірявся: за раз перевіряємо не більше трьох компаній.");
  if (r.state === "updating") return note("Реєстр саме оновлюється — натисніть «Перевірити» ще раз за хвилину.");
  if (r.state === "notFound") return note(`У реєстрі коду ${u.firmCode} немає — можливо, на Ларді його вписано з помилкою.`);
  if (r.state === "unconfigured") return note("Перевірка в реєстрі не налаштована (немає ключа YouControl).");
  if (r.state === "failed") return note("Реєстр не відповів — спробуйте ще раз пізніше.");
  const main = r.info.activities.find((a) => a.main) ?? r.info.activities[0] ?? null;
  if (!main) return note("Видів діяльності реєстр для цієї компанії не віддав.");
  return <KvedLine a={main} big />;
}

function LardiUserCard({ u }: { u: LardiCheckUser }) {
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "8px 14px", display: "grid", gap: 4 }}>
      <div style={{ fontWeight: 700, fontSize: 14.5 }}>{u.name}</div>
      <MainActivity u={u} />
    </div>
  );
}

/** Усе, що не потрібно для рішення з першого погляду. */
function Details({ res }: { res: LardiCheckResp }) {
  const cell: React.CSSProperties = { padding: "6px 10px", textAlign: "left", whiteSpace: "nowrap" };
  const head: React.CSSProperties = { ...cell, fontWeight: 600, fontSize: 12.5, color: MUTED };
  return (
    <div style={{ display: "grid", gap: 10, fontSize: 13 }}>
      {res.lardi.ok && res.lardi.users.length === 0 && <div style={{ color: MUTED }}>На Ларді користувача з таким номером немає.</div>}
      {res.lardi.users.map((u) => {
        const r = u.registry;
        const info = r?.state === "ok" ? r.info : null;
        const main = info?.activities.find((a) => a.main) ?? null;
        const other = info ? info.activities.filter((a) => a !== main) : [];
        return (
          <div key={u.refId} style={{ display: "grid", gap: 3 }}>
            <div><b>{u.name}</b> <span style={{ color: MUTED }}>
              {[u.town, u.since ? `на Ларді з ${u.since.slice(0, 4)}` : null, `відгуки +${u.positive} / −${u.negative}`].filter(Boolean).join(" · ")}
            </span></div>
            {u.firmCode && (
              <div style={{ color: MUTED }}>
                {u.firmCode.length === 10 ? "ІПН" : "ЄДРПОУ"} {u.firmCode}
                {info?.name ? ` · у реєстрі: ${info.name}` : ""}
                {info?.registered ? ` · зареєстровано ${ymdToDmy(info.registered)}` : ""}
                {info?.closing && <span style={{ color: "#991b1b", fontWeight: 700 }}> · ⚠ {info.status ?? "припиняється"}</span>}
              </div>
            )}
            {other.length > 0 && (
              <div style={{ display: "grid", gap: 2 }}>
                <div style={{ color: MUTED }}>Інші види діяльності ({other.length}):</div>
                {other.map((a) => <KvedLine key={a.code} a={a} />)}
              </div>
            )}
            {info && (
              <div style={{ fontSize: 11.5, color: MUTED }}>
                Джерело — ЄДР через YouControl{info.archived ? ", збережена копія (реєстр саме оновлювався, завтра підтягнеться свіжа)" : r?.state === "ok" && r.cached ? ", перевірено за останні 30 днів" : ""}.
              </div>
            )}
          </div>
        );
      })}
      <div>
        <b>Заявки за {res.days} днів (архів дашборда): </b>
        {res.archive.cargo + res.archive.lorry === 0
          ? <span style={{ color: MUTED }}>немає.</span>
          : <span>вантажів {res.archive.cargo}{res.archive.cargo > 0 && ` (з ціною ${res.archive.withPrice}, маршрутів ${res.archive.routes})`} · машин {res.archive.lorry}</span>}
      </div>
      {res.archive.last.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
            <thead><tr>
              <th style={head}>Дата</th><th style={head}>Маршрут</th><th style={head}>Вантаж</th>
              <th style={{ ...head, textAlign: "right" }}>Вага, т</th><th style={{ ...head, textAlign: "right" }}>Ціна на Ларді</th><th style={head}>Компанія · контакт</th>
            </tr></thead>
            <tbody>
              {res.archive.last.map((o) => (
                <tr key={o.offerId} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={cell}>{dm(o.seenAt)}</td>
                  <td style={cell}>{o.from ?? "—"} → {o.to ?? "—"}</td>
                  <td style={{ ...cell, whiteSpace: "normal" }}>{o.cargo ?? "—"}</td>
                  <td style={{ ...cell, textAlign: "right" }}>{o.mass ?? "—"}</td>
                  <td style={{ ...cell, textAlign: "right", fontWeight: 600 }}>{price(o)}</td>
                  <td style={{ ...cell, whiteSpace: "normal", color: MUTED }}>{[o.company, o.face].filter(Boolean).join(" · ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {res.archive.cargo > res.archive.last.length && (
            <div style={{ color: MUTED, fontSize: 12.5, marginTop: 4 }}>Показано останні {res.archive.last.length} з {res.archive.cargo}.</div>
          )}
        </div>
      )}
      {res.archive.lastLorry.length > 0 && (
        <div style={{ color: MUTED }}>
          Машини: {res.archive.lastLorry.map((o) => `${dm(o.seenAt)} ${o.from ?? "—"} → ${o.to ?? "—"}`).join(" · ")}
        </div>
      )}
    </div>
  );
}
