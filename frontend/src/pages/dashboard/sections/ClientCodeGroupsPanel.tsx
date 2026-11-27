import { useEffect, useState } from "react";
import { fetchClientCodeGroups, type ClientCodeGroups, type CodeGroup, type CodeGroupCode } from "../../../api";

/**
 * 🧾 КЛІЄНТИ З ОДНИМ КОДОМ ЄДРПОУ — кандидати на обʼєднання (задача 11225, прохід 1; план затверджено Романом 27.11.2026).
 *
 * Лише СПИСОК. Кнопки «обʼєднати» тут немає свідомо: до ключа клієнта привʼязані плани, коментарі, анкета, ліміти,
 * а наявне обʼєднання переносить тільки угоди. Кнопка зʼявиться в проході 2 разом із переносом цих «хвостів».
 * Правило груп і три види живуть на сервері (`core/clientCodes.ts`); тут лише подача.
 * Число на плитці = кількість рядків у списку під нею, одним викликом (гейт `#11258`).
 */

type Tab = "clean" | "multi" | "collective";

const C = {
  card: { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10 } as const,
  th: { textAlign: "left", fontSize: 10, letterSpacing: .4, textTransform: "uppercase", color: "#6b7280", fontWeight: 600,
        padding: "7px 12px", borderBottom: "1px solid #eef2f7", whiteSpace: "nowrap" } as const,
  td: { padding: "8px 12px", borderBottom: "1px solid #f1f5f9", fontSize: 13 } as const,
  num: { textAlign: "right", fontVariantNumeric: "tabular-nums" } as const,
  chip: (bg: string, fg: string) => ({ display: "inline-block", padding: "2px 8px", borderRadius: 999, fontSize: 11,
        fontWeight: 700, background: bg, color: fg, whiteSpace: "nowrap" } as const),
  muted: { color: "#6b7280" } as const,
};

const codeLabel = (c: CodeGroupCode) => `${c.kind === "edrpou" ? "ЄДРПОУ" : "ІПН"} ${c.code}`;
const dmy = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
const plural = (n: number, one: string, few: string, many: string) => {
  const d = n % 10, h = n % 100;
  return d === 1 && h !== 11 ? one : d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many;
};

function GroupCard({ g }: { g: CodeGroup }) {
  const clean = g.kind === "clean";
  return (
    <div style={{ ...C.card, marginBottom: 10 }} data-code-group={g.kind}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 8, padding: "10px 12px", borderBottom: "1px solid #eef2f7" }}>
        <b style={{ fontSize: 13 }}>{g.codes.map(codeLabel).join(" і ")}</b>
        <span style={clean ? C.chip("#dcfce7", "#166534") : C.chip("#fef3c7", "#92400e")}>{clean ? "чистий дубль" : "кілька юросіб"}</span>
        <span style={{ fontSize: 12, ...C.muted }}>
          {!clean && <>{g.codes.length} {plural(g.codes.length, "код", "коди", "кодів")}, </>}
          {g.keys.length} {plural(g.keys.length, "запис", "записи", "записів")} у дашборді
        </span>
      </div>
      {/* Назва платника з 1С: саме вона пояснює, чому ці записи опинились разом. */}
      <div style={{ padding: "6px 12px", fontSize: 12, ...C.muted, borderBottom: "1px solid #f1f5f9" }}>
        У 1С: {g.codes.map((c) => `${c.kontragent ?? "назву не вказано"} (${c.code})`).join(" · ")}
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr>
          <th style={C.th}>Клієнт у дашборді</th>
          <th style={{ ...C.th, ...C.num }}>Оплачених угод</th>
          <th style={{ ...C.th, ...C.num }}>Оплат 1С з кодом</th>
          <th style={{ ...C.th, ...C.num }}>Остання оплата</th>
        </tr></thead>
        <tbody>
          {g.keys.map((k) => (
            <tr key={k.key}>
              <td style={C.td}>
                {k.name ?? k.key}
                {k.phoneKey && <span style={C.muted}> · запис за телефоном</span>}
                {k.name && !k.phoneKey && <span style={{ ...C.muted, fontSize: 11 }}> · {k.key}</span>}
              </td>
              <td style={{ ...C.td, ...C.num }}>{k.paidDeals}</td>
              <td style={{ ...C.td, ...C.num }}>{k.payments}</td>
              <td style={{ ...C.td, ...C.num, ...C.muted }}>{k.lastPaid ? dmy(k.lastPaid) : "дати немає"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ClientCodeGroupsPanel() {
  const [all, setAll] = useState(false);
  const [data, setData] = useState<ClientCodeGroups | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "denied" | "error">("loading");
  const [tab, setTab] = useState<Tab>("clean");

  useEffect(() => {
    let dead = false;
    setState("loading");
    fetchClientCodeGroups(all)
      .then((r) => { if (!dead) { setData(r); setState("ok"); } })
      .catch((e) => { if (!dead) setState((e as { response?: { status?: number } })?.response?.status === 403 ? "denied" : "error"); });
    return () => { dead = true; };
  }, [all]);

  // Межу тримає сервер (право обʼєднання будь-якої пари). Кому не можна, тому блок не показуємо зовсім.
  if (state === "denied") return null;

  const tiles: { key: Tab; label: string; n: number | null; sub: string }[] = [
    { key: "clean", label: "Чисті дублі", n: data?.clean.length ?? null,
      sub: data ? `один код, кілька записів · стане на ${data.minusClean} менше` : "" },
    { key: "multi", label: "Кілька юросіб", n: data?.multi.length ?? null, sub: "кілька кодів у групі · рішення по кожній" },
    { key: "collective", label: "Збірні імена", n: data?.collective.length ?? null, sub: "різні фірми під одним імʼям · не обʼєднуються" },
  ];
  const noCodesYet = !!data && data.codedPayments === 0;
  const list = data ? (tab === "collective" ? [] : data[tab]) : [];

  return (
    <div style={{ ...C.card, padding: "12px 14px", flex: "1 1 100%" }} data-code-groups>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <b style={{ fontSize: 14 }}>🧾 Клієнти з одним кодом ЄДРПОУ</b>
        <span style={{ display: "inline-flex", gap: 4 }}>
          {[{ v: false, t: "оплати з 2026" }, { v: true, t: "за весь час" }].map((o) => (
            <button key={o.t} onClick={() => setAll(o.v)} aria-pressed={all === o.v}
              style={{ fontSize: 12, padding: "4px 10px", borderRadius: 8, cursor: "pointer",
                       border: "1px solid " + (all === o.v ? "#111827" : "#d1d5db"),
                       background: all === o.v ? "#111827" : "#fff", color: all === o.v ? "#fff" : "#374151" }}>{o.t}</button>
          ))}
        </span>
      </div>
      <div style={{ fontSize: 12, ...C.muted, margin: "4px 0 10px", lineHeight: 1.5 }}>
        Код узято з оплат 1С по угодах. Тут лише кандидати: нічого не обʼєднується само. Обʼєднати пару можна формою вище,
        і це можна скасувати в журналі.
      </div>

      {state === "error" && <div style={{ fontSize: 12, color: "#b91c1c" }}>Не вдалося завантажити список. Спробуйте відкрити вікно ще раз.</div>}
      {state === "loading" && !data && <div style={{ fontSize: 12, ...C.muted }}>Рахую групи…</div>}

      {data && (
        <>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
            {tiles.map((t) => (
              <button key={t.key} onClick={() => setTab(t.key)} aria-pressed={tab === t.key} data-code-tile={t.key}
                style={{ flex: "1 1 200px", textAlign: "left", cursor: "pointer", borderRadius: 10, padding: "10px 12px",
                         background: "#fff", border: tab === t.key ? "2px solid #2563eb" : "1px solid #e5e7eb" }}>
                <div style={{ fontSize: 10, letterSpacing: .4, textTransform: "uppercase", ...C.muted, fontWeight: 600 }}>{t.label}</div>
                <div style={{ fontSize: 24, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{noCodesYet ? "…" : t.n}</div>
                <div style={{ fontSize: 11, ...C.muted }}>{t.sub}</div>
              </button>
            ))}
          </div>

          {/* Покриття: без нього «39 дублів» читалось би як «дублів усього 39», хоча код є лише в частини клієнтів. */}
          <div style={{ fontSize: 12, ...C.muted, marginBottom: 10, lineHeight: 1.5 }} data-code-coverage>
            Клієнтів з оплатою 1С {data.from ? "з 2026 року" : "за весь час"}: <b style={{ color: "#111827" }}>{data.clients}</b>,
            код відомий у <b style={{ color: "#111827" }}>{data.withCode}</b>. У решти коду немає (здебільшого готівка), їхні дублі цей список не бачить.
            {data.otherCodes > 0 && <> Кодів іншого вигляду (не 8, 10 чи 12 цифр): <b style={{ color: "#111827" }}>{data.otherCodes}</b> у {data.otherPayments} оплатах, у групи вони не входять.</>}
          </div>

          {noCodesYet ? (
            <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: "9px 11px", fontSize: 12, color: "#78350f", lineHeight: 1.5 }} data-code-empty="sync">
              Кодів у базі ще немає: їх приносить синк 1С раз на годину, о 45-й хвилині. Оплат у періоді {data.payments}, з кодом поки 0.
              Це не «дублів немає», а «ще не рахували».
            </div>
          ) : tab === "collective" ? (
            data.collective.length === 0
              ? <div style={{ fontSize: 12, ...C.muted }}>Збірних імен із кодами не знайдено.</div>
              : (
                <div style={C.card}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead><tr>
                      <th style={C.th}>Імʼя в дашборді</th>
                      <th style={{ ...C.th, ...C.num }}>Оплачених угод</th>
                      <th style={{ ...C.th, ...C.num }}>Різних кодів</th>
                      <th style={{ ...C.th, ...C.num }}>Ті самі коди в інших клієнтів</th>
                      <th style={C.th}>Хто платив (приклади з 1С)</th>
                    </tr></thead>
                    <tbody>
                      {data.collective.map((e) => (
                        <tr key={e.key} data-code-group="collective">
                          <td style={C.td}>{e.name ?? e.key}</td>
                          <td style={{ ...C.td, ...C.num }}>{e.paidDeals}</td>
                          <td style={{ ...C.td, ...C.num }}>{e.codes}</td>
                          <td style={{ ...C.td, ...C.num }}>{e.shared}</td>
                          <td style={{ ...C.td, ...C.muted, fontSize: 12 }}>
                            {e.sample.map((c) => c.kontragent ?? c.code).join(" · ")}
                            {e.codes > e.sample.length && <> · ще {e.codes - e.sample.length}</>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
          ) : list.length === 0
            ? <div style={{ fontSize: 12, ...C.muted }}>У цьому списку груп немає.</div>
            : list.map((g) => <GroupCard key={g.keys.map((k) => k.key).join("|")} g={g} />)}
        </>
      )}
    </div>
  );
}
