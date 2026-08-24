import { useState } from "react";
import { mergeReceivableClients } from "../../../api";
import { formatAmount, formatAmountFull } from "../format";
import { mergeProblem, NOTE_MAX, type MergeSide } from "../receivablesView";

/**
 * 🔗 ОБʼЄДНАННЯ КЛІЄНТІВ У ДЕБІТОРЦІ.
 *
 * 🔴 ВИДНО, ЩО САМЕ ЗІЛЛЄТЬСЯ — обидві сторони з живими сумами й кількістю
 * рахунків, і ЯВНИЙ напрямок. Злиття не симетричне: канонічний лишається,
 * псевдонім зникає з екрана як окремий рядок. Діалог, який цього не показує,
 * просить підтвердити те, чого людина не бачить.
 *
 * 🔴 І ВИДНО, ЩО ЗВІДСИ ЦЕ НЕ СКАСУВАТИ. Роз'єднання живе на екрані «Клієнти»
 * (в роуті прямо написано, чому другої кнопки тут немає), а дебіторка підхопить
 * відкіт на наступному синку. Мовчазна незворотність — пастка, навіть коли
 * механізм відкоту існує: людина про нього не знає.
 *
 * 🔴 СТОРОНИ БЕРУТЬСЯ ЗІ СПИСКУ НА ЕКРАНІ, а не з пошуку. `/client-search`
 * гейтиться `merge_clients`, а кнопка — `merge_receivables`; список на екрані
 * прибирає цю розбіжність у принципі й водночас означає межу: зліпити з
 * клієнтом, якого в дебіторці немає, звідси не можна — це робота «Клієнтів».
 */
export function MergeDialog({ sides, onDone, onClose }: {
  sides: MergeSide[];
  onDone: () => void;
  onClose: () => void;
}) {
  const [aliasKey, setAliasKey] = useState("");
  const [canonicalKey, setCanonicalKey] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const alias = sides.find((s) => s.clientKey === aliasKey) ?? null;
  const canonical = sides.find((s) => s.clientKey === canonicalKey) ?? null;
  const problem = mergeProblem(alias, canonical, reason);

  const submit = async () => {
    if (problem) return;
    setBusy(true); setErr(null);
    try { await mergeReceivableClients({ alias: alias!.clientKey, canonical: canonical!.clientKey, reason }); onDone(); }
    catch (e: unknown) {
      const r = (e as { response?: { data?: { error?: string } } }).response;
      // Текст сервера як є: він знає про ланцюжки й дублі більше за нас.
      setErr(r?.data?.error ?? "Не вдалось обʼєднати");
      setBusy(false);
    }
  };

  const pick = (value: string, on: (v: string) => void, label: string) => (
    <select value={value} onChange={(e) => on(e.target.value)} disabled={busy} aria-label={label}
      style={{ font: "inherit", fontSize: 12.5, padding: "6px 8px", borderRadius: 8, width: "100%" }}>
      <option value="">— {label} —</option>
      {sides.map((s) => (
        <option key={s.clientKey} value={s.clientKey}>{s.clientName} · {formatAmount(s.amount)}</option>
      ))}
    </select>
  );
  const Side = ({ s, role }: { s: MergeSide | null; role: string }) => (
    <div style={{ fontSize: 11.5, color: "var(--text-muted)", minHeight: 32 }}>
      {s ? (
        <>
          <b style={{ color: "var(--text)" }} title={formatAmountFull(s.amount)}>{formatAmount(s.amount)}</b>
          {" · "}{s.invoices} рах. <span style={{ display: "block" }}>{role}</span>
        </>
      ) : <span>—</span>}
    </div>
  );

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 60,
                  display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
         onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 14,
                 padding: 18, width: "min(620px, 100%)", maxHeight: "90vh", overflowY: "auto", textAlign: "left" }}>
        <h3 style={{ margin: "0 0 4px", fontSize: 16 }}>🔗 Обʼєднати клієнтів</h3>
        <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 14px" }}>
          Дві юрособи виявились одним клієнтом. Після обʼєднання вони стануть ОДНИМ рядком дебіторки.
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 10, alignItems: "start" }}>
          <div>
            <div style={{ fontSize: 11.5, fontWeight: 700, marginBottom: 4 }}>Зникне як окремий рядок</div>
            {pick(aliasKey, setAliasKey, "псевдонім")}
            <Side s={alias} role="приєднається" />
          </div>
          <button disabled={busy} title="Поміняти сторони місцями"
            onClick={() => { const a = aliasKey; setAliasKey(canonicalKey); setCanonicalKey(a); }}
            style={{ font: "inherit", fontSize: 16, padding: "6px 8px", marginTop: 20, borderRadius: 8,
                     border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)",
                     cursor: busy ? "default" : "pointer" }}>⇄</button>
          <div>
            <div style={{ fontSize: 11.5, fontWeight: 700, marginBottom: 4 }}>Лишиться канонічним</div>
            {pick(canonicalKey, setCanonicalKey, "канонічний")}
            <Side s={canonical} role="прийме до себе" />
          </div>
        </div>

        {alias && canonical && alias.clientKey !== canonical.clientKey && (
          /* 🔴 ПІДСУМОК ПІСЛЯ — щоб підтверджували результат, а не намір. */
          <div style={{ marginTop: 12, padding: 10, borderRadius: 10,
                        background: "var(--bg-subtle, rgba(127,127,127,0.07))", fontSize: 12.5 }}>
            Після обʼєднання: один рядок <b>{canonical.clientName}</b> ·{" "}
            <b title={formatAmountFull(alias.amount + canonical.amount)}>{formatAmount(alias.amount + canonical.amount)}</b>
            {" · "}{alias.invoices + canonical.invoices} рах.
          </div>
        )}

        <textarea value={reason} maxLength={NOTE_MAX} disabled={busy}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Причина обовʼязкова — на підставі чого це один клієнт (спільний контакт, ЄДРПОУ, лист)"
          style={{ font: "inherit", fontSize: 12, padding: "8px", borderRadius: 8, width: "100%",
                   minHeight: 60, resize: "vertical", marginTop: 12, border: "1px solid var(--border)",
                   background: "var(--card-bg)", color: "var(--text)" }} />

        {/* 🔴 НЕЗВОРОТНІСТЬ СКАЗАНА ВГОЛОС І ДО ДІЇ, а не після. */}
        <p style={{ fontSize: 11.5, color: "var(--warn)", margin: "10px 0 0" }}>
          ⚠️ Звідси це не скасувати. Роз'єднати можна на екрані «Клієнти»,
          і дебіторка підхопить відкіт на наступному синку (до 15 хв).
        </p>

        {err && <p style={{ fontSize: 12, color: "#dc2626", margin: "8px 0 0" }}>🔴 {err}</p>}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
          <button onClick={onClose} disabled={busy}
            style={{ font: "inherit", fontSize: 13, padding: "7px 14px", borderRadius: 8,
                     border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)",
                     cursor: busy ? "default" : "pointer" }}>Скасувати</button>
          <button onClick={submit} disabled={busy || problem != null}
            title={problem ?? "Обʼєднати"}
            style={{ font: "inherit", fontSize: 13, fontWeight: 700, padding: "7px 14px", borderRadius: 8,
                     border: "none", background: problem ? "var(--border)" : "#c5141c",
                     color: problem ? "var(--text-muted)" : "#fff",
                     cursor: busy || problem ? "default" : "pointer" }}>
            {busy ? "Обʼєднуємо…" : "Обʼєднати"}
          </button>
        </div>
        {problem && <p style={{ fontSize: 11.5, color: "var(--text-muted)", margin: "6px 0 0", textAlign: "right" }}>{problem}</p>}
      </div>
    </div>
  );
}
