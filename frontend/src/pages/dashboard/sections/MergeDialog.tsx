import { useState, useEffect, useMemo } from "react";
import { mergeReceivableClients } from "../../../api";
import { formatAmount, formatAmountFull } from "../format";
import { mergeProblem, mergeSummary, MERGE_LIMIT_RULE, NOTE_MAX, type MergeSide } from "../receivablesView";

/**
 * 🔗 ОБʼЄДНАННЯ КЛІЄНТІВ У ДЕБІТОРЦІ.
 *
 * 🔴 ВИДНО, ЩО САМЕ ЗІЛЛЄТЬСЯ — усі сторони з живими сумами й кількістю
 * рахунків, і ЯВНИЙ напрямок. Злиття не симетричне: канонічний лишається,
 * псевдоніми зникають з екрана як окремі рядки. Діалог, який цього не показує,
 * просить підтвердити те, чого людина не бачить.
 *
 * 🔴 N ЗА РАЗ, А НЕ ПАРА (рішення власника 27.08.2026). Модель це вміла завжди —
 * на проді один канонічний ключ тримає 11 псевдонімів; не вмів РОУТ, тож людина
 * робила N запитів поспіль, і кожен неповний стан між ними був видимий на
 * екрані. Тепер набір іде однією транзакцією.
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
  // ⌨️ ESC ЗАКРИВАЄ. Не було — і модалку можна було покинути, лише знайшовши
  // «Скасувати». Знайдено власним гейтом `#193`: він тиснув Escape, діалог
  // лишався, його підкладка накривала таблицю — і наступний клік по клієнту
  // «не проходив». Тобто відсутність Esc виглядала як зламане розкриття.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const [canonicalKey, setCanonicalKey] = useState("");
  const [aliasKeys, setAliasKeys] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const canonical = sides.find((s) => s.clientKey === canonicalKey) ?? null;
  const aliases = useMemo(
    () => aliasKeys.map((k) => sides.find((s) => s.clientKey === k)).filter((s): s is MergeSide => s != null),
    [aliasKeys, sides]);
  const problem = mergeProblem(aliases, canonical, reason);
  const sum = mergeSummary(aliases, canonical);

  // Пошук по видимому списку: боржників сьогодні 70+, і вибирати з такого
  // переліку очима — це та сама «41 кнопка в DOM», лише в іншій формі.
  const q = filter.trim().toLowerCase();
  const listed = q ? sides.filter((s) => s.clientName.toLowerCase().includes(q)) : sides;

  const toggleAlias = (key: string) =>
    setAliasKeys((prev) => prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]);

  const submit = async () => {
    if (problem) return;
    setBusy(true); setErr(null);
    try {
      await mergeReceivableClients({
        aliases: aliases.map((a) => a.clientKey), canonical: canonical!.clientKey, reason,
      });
      onDone();
    } catch (e: unknown) {
      const r = (e as { response?: { data?: { error?: string } } }).response;
      // Текст сервера як є: він знає про ланцюжки й дублі більше за нас.
      setErr(r?.data?.error ?? "Не вдалось обʼєднати");
      setBusy(false);
    }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 60,
                  display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
         onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 14,
                 padding: 18, width: "min(680px, 100%)", maxHeight: "90vh", overflowY: "auto", textAlign: "left" }}>
        <h3 style={{ margin: "0 0 4px", fontSize: "var(--fs-lg)" }}>🔗 Обʼєднати клієнтів</h3>
        <p style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)", margin: "0 0 14px" }}>
          Кілька юросіб виявились одним клієнтом. Після обʼєднання вони стануть ОДНИМ рядком дебіторки.
        </p>

        <div style={{ fontSize: "var(--fs-sm)", fontWeight: 700, marginBottom: 4 }}>Лишиться основним</div>
        <select value={canonicalKey} onChange={(e) => {
                  const v = e.target.value;
                  setCanonicalKey(v);
                  // Той, кого щойно призначили основним, не може лишатись у
                  // приєднуваних: інакше кнопка мовчки лишалась би сірою, а
                  // причину людина шукала б у списку з 70 рядків.
                  setAliasKeys((prev) => prev.filter((k) => k !== v));
                }}
                disabled={busy} aria-label="основний клієнт"
                style={{ font: "inherit", fontSize: "var(--fs-13)", padding: "6px 8px", borderRadius: 8, width: "100%" }}>
          <option value="">— оберіть основного —</option>
          {sides.map((s) => (
            <option key={s.clientKey} value={s.clientKey}>{s.clientName} · {formatAmount(s.amount)}</option>
          ))}
        </select>

        <div style={{ display: "flex", alignItems: "baseline", gap: 8, margin: "14px 0 4px" }}>
          <div style={{ fontSize: "var(--fs-sm)", fontWeight: 700 }}>
            Зникнуть як окремі рядки{aliases.length ? ` · обрано ${aliases.length}` : ""}
          </div>
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="пошук за назвою"
            disabled={busy} aria-label="пошук клієнта"
            style={{ font: "inherit", fontSize: "var(--fs-sm)", padding: "4px 8px", borderRadius: 8,
                     border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)",
                     marginLeft: "auto", width: 180 }} />
        </div>

        <div style={{ maxHeight: 220, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 10 }}>
          {listed.length === 0 && (
            <p style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)", margin: 10 }}>
              Під цим пошуком клієнтів немає.
            </p>
          )}
          {listed.map((s) => {
            const isCanonical = s.clientKey === canonicalKey;
            // 🔗 УЖЕ ПРИЙМАЄ ПСЕВДОНІМИ → псевдонімом стати не може (ланцюжок
            // заборонений тригером у БД). Не ховаємо рядок, а ПОЯСНЮЄМО: зникле
            // без пояснення читається як «клієнта немає».
            const chained = s.alreadyCanonical > 0;
            const off = busy || isCanonical || chained;
            return (
              <label key={s.clientKey}
                style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 10px",
                         fontSize: "var(--fs-13)", opacity: off ? 0.55 : 1,
                         cursor: off ? "default" : "pointer", borderBottom: "1px solid var(--border)" }}>
                <input type="checkbox" disabled={off} checked={aliasKeys.includes(s.clientKey)}
                       onChange={() => toggleAlias(s.clientKey)} />
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis",
                               whiteSpace: "nowrap" }}>{s.clientName}</span>
                {chained && (
                  <span style={{ color: "var(--warn)", whiteSpace: "nowrap" }}
                        title="Ланцюжок заборонено: ключ, що вже приймає псевдоніми, сам псевдонімом стати не може">
                    уже обʼєднує {s.alreadyCanonical} — лише основним
                  </span>
                )}
                {isCanonical && <span style={{ color: "var(--text-muted)", whiteSpace: "nowrap" }}>основний</span>}
                <b title={formatAmountFull(s.amount)} style={{ whiteSpace: "nowrap" }}>{formatAmount(s.amount)}</b>
                <span style={{ color: "var(--text-muted)", whiteSpace: "nowrap" }}>{s.invoices} рах.</span>
              </label>
            );
          })}
        </div>

        {canonical && aliases.length > 0 && (
          /* 🔴 ПІДСУМОК ПІСЛЯ — щоб підтверджували результат, а не намір. */
          <div style={{ marginTop: 12, padding: 10, borderRadius: 10,
                        background: "var(--bg-subtle, rgba(127,127,127,0.07))", fontSize: "var(--fs-13)" }}>
            Після обʼєднання: один рядок <b>{canonical.clientName}</b> ·{" "}
            <b title={formatAmountFull(sum.amount)}>{formatAmount(sum.amount)}</b>
            {" · "}{sum.invoices} рах. · зіллється {sum.parties} юросіб
            <div style={{ color: "var(--text-muted)", marginTop: 4 }}>{MERGE_LIMIT_RULE}</div>
          </div>
        )}

        <textarea value={reason} maxLength={NOTE_MAX} disabled={busy}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Причина обовʼязкова — на підставі чого це один клієнт (спільний контакт, ЄДРПОУ, лист)"
          style={{ font: "inherit", fontSize: "var(--fs-sm)", padding: "8px", borderRadius: 8, width: "100%",
                   minHeight: 60, resize: "vertical", marginTop: 12, border: "1px solid var(--border)",
                   background: "var(--card-bg)", color: "var(--text)" }} />

        {/* 🔴 НЕЗВОРОТНІСТЬ СКАЗАНА ВГОЛОС І ДО ДІЇ, а не після. */}
        <p style={{ fontSize: "var(--fs-sm)", color: "var(--warn)", margin: "10px 0 0" }}>
          ⚠️ Звідси це не скасувати. Роз'єднати можна на екрані «Клієнти»,
          і дебіторка підхопить відкіт на наступному синку (до 15 хв).
        </p>

        {err && <p style={{ fontSize: "var(--fs-sm)", color: "#dc2626", margin: "8px 0 0" }}>🔴 {err}</p>}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
          <button onClick={onClose} disabled={busy}
            style={{ font: "inherit", fontSize: "var(--fs-13)", padding: "7px 14px", borderRadius: 8,
                     border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)",
                     cursor: busy ? "default" : "pointer" }}>Скасувати</button>
          <button onClick={submit} disabled={busy || problem != null}
            title={problem ?? "Обʼєднати"}
            style={{ font: "inherit", fontSize: "var(--fs-13)", fontWeight: 700, padding: "7px 14px", borderRadius: 8,
                     border: "none", background: problem ? "var(--border)" : "#c5141c",
                     color: problem ? "var(--text-muted)" : "#fff",
                     cursor: busy || problem ? "default" : "pointer" }}>
            {busy ? "Обʼєднуємо…" : "Обʼєднати"}
          </button>
        </div>
        {problem && <p style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)", margin: "6px 0 0", textAlign: "right" }}>{problem}</p>}
      </div>
    </div>
  );
}
