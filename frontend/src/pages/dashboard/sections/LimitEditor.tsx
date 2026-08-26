import { useState } from "react";
import { setReceivableLimit, clearReceivableLimit, type ReceivableClient } from "../../../api";
import { limitHint, limitLabel, limitState,
  amountLimitHint, amountLimitLabel, amountLimitState } from "../receivablesView";

/**
 * 🧾 РЕДАКТОР УЗГОДЖЕНОЇ ВІДСТРОЧКИ (Е4).
 *
 * Замінює аркуш «Лист20», який дістався у спадок: власник не знає, хто його веде,
 * і орієнтується на дані контрагента. Заміряно перед переходом — аркуш покривав
 * 29 із 74 боржників.
 *
 * 🔴 ТРИ СТАНИ, А НЕ ДВА, І ЦЕ БІЗНЕС-СЕНС.
 *   N днів          — відстрочку узгоджено;
 *   0 днів          — розглянули і СВІДОМО не дали;
 *   ліміту немає    — клієнту його ніколи не встановлювали.
 * Останні два ведуть до однакового наслідку (перевізника не сплачуємо), але
 * відповідають різне на «чому», і плутати їх в одному підписі не можна.
 * Тому «не дали» — це ЗБЕРЕЖЕННЯ нуля, а «не встановлювали» — ВИДАЛЕННЯ рядка.
 *
 * ⚠️ Вік боргу тут не редагується взагалі: з Е4 він рахується з дат рахунків.
 * Щоденний факт не є налаштуванням — саме змішування цих двох речей в одному
 * аркуші й тримало нас на гугл-таблиці.
 */
export function LimitEditor({ client, onDone, onClose }: {
  client: ReceivableClient;
  onDone: () => void;
  onClose: () => void;
}) {
  const state = limitState(client.limitDays);
  const [days, setDays] = useState(state === "agreed" ? String(client.limitDays) : "");
  /**
   * 💰 ДРУГИЙ ЛІМІТ — ПО СУМІ, НЕЗАЛЕЖНИЙ ВІД ДЕННОГО (рішення власника 26.08.2026).
   * Порожнє поле означає «зняти цей ліміт», а не «не чіпати»: обидва поля
   * заповнені поточним станом, тож спорожнене читається однозначно.
   */
  const aState = amountLimitState(client.limitAmount);
  const [amount, setAmount] = useState(aState === "agreed" ? String(client.limitAmount) : "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const noteOk = note.trim().length > 0;
  const daysNum = days.trim() === "" ? NaN : Number(days);
  const daysOk = days.trim() === "" || (Number.isInteger(daysNum) && daysNum >= 0);
  const amtNum = amount.trim() === "" ? NaN : Number(amount.replace(/\s/g, ""));
  const amtOk = amount.trim() === "" || (Number.isFinite(amtNum) && amtNum >= 0);
  // Хоча б один ліміт мусить бути названий: порожня форма з приміткою нічого не
  // означає, а роут на неї відповість 400 — краще не давати натиснути.
  const anyGiven = days.trim() !== "" || amount.trim() !== "";

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setErr(null);
    try { await fn(); onDone(); }
    catch (e) {
      const r = e as { response?: { data?: { error?: string } } };
      setErr(r?.response?.data?.error ?? "Не вдалось зберегти");
      setBusy(false);
    }
  };

  // Той самий механізм, що в `OwnerEditor` після Е3: на вузькому екрані таблиця
  // скролиться горизонтально і різала б поповер разом із кнопками.
  const narrow = typeof window !== "undefined" && window.innerWidth < 900;
  const box: React.CSSProperties = narrow
    ? { position: "fixed", zIndex: 60, left: "50%", top: "50%", transform: "translate(-50%, -50%)",
        width: "min(340px, calc(100vw - 32px))", maxHeight: "calc(100vh - 32px)", overflowY: "auto",
        padding: 14, background: "var(--card-bg)", border: "1px solid var(--border)",
        borderRadius: 12, boxShadow: "0 18px 50px rgba(0,0,0,0.45)", textAlign: "left" }
    : { position: "absolute", zIndex: 30, marginTop: 4, width: 300, padding: 12,
        background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 10,
        boxShadow: "0 8px 24px rgba(0,0,0,0.18)", textAlign: "left" };

  const btn = (bg: string): React.CSSProperties => ({
    font: "inherit", fontSize: "var(--fs-13)", fontWeight: 600, padding: "6px 10px", borderRadius: 8,
    border: "1px solid var(--border)", background: bg, color: "var(--text)",
    cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1,
  });

  return (
    <>
      {narrow && (
        <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 59, background: "rgba(0,0,0,0.45)" }} />
      )}
      <div style={box}>
        <div style={{ fontSize: "var(--fs-13)", fontWeight: 700, marginBottom: 2 }}>Узгоджена відстрочка</div>
        <div style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)", marginBottom: 8 }}>
          Днів: <b>{limitLabel(client.limitDays)}</b>
          <div style={{ marginTop: 2 }}>{limitHint(client.limitDays)}</div>
          <div style={{ marginTop: 6 }}>Сума: <b>{amountLimitLabel(client.limitAmount)}</b></div>
          <div style={{ marginTop: 2 }}>{amountLimitHint(client.limitAmount)}</div>
        </div>

        <label style={{ display: "block", fontSize: "var(--fs-xs)", color: "var(--text-muted)", marginBottom: 3 }}>
          Днів відстрочки від дати рахунку
        </label>
        <input value={days} onChange={(e) => setDays(e.target.value)} inputMode="numeric"
          placeholder="напр. 14"
          style={{ font: "inherit", fontSize: "var(--fs-13)", padding: "5px 8px", borderRadius: 8, width: "100%",
                   border: "1px solid var(--border)", background: "var(--input-bg)",
                   color: "var(--text)", marginBottom: 8 }} />

        {/* 💰 ЛІМІТ ПО СУМІ. База — ЗАГАЛЬНИЙ БОРГ (виставлене рахунками), а НЕ
            «Очікуємо»: в очікуваннях є готівка, а готівка кредитом не є, і це
            два різні всесвіти з різницею в 11 разів (борг 8.6 млн ₴ проти
            внеску тих самих угод в очікувані 754 тис ₴).
            🔴 Ліміти НЕЗАЛЕЖНІ: клієнт може порушити один, обидва або жоден. */}
        <label style={{ display: "block", fontSize: "var(--fs-xs)", color: "var(--text-muted)", marginBottom: 3 }}>
          Ліміт боргу, ₴ — більше якого не даємо заходити
        </label>
        <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="numeric"
          placeholder="напр. 50000"
          style={{ font: "inherit", fontSize: "var(--fs-13)", padding: "5px 8px", borderRadius: 8, width: "100%",
                   border: "1px solid var(--border)", background: "var(--input-bg)",
                   color: "var(--text)", marginBottom: 4 }} />
        <div style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)", marginBottom: 8, lineHeight: 1.4 }}>
          Порожнє поле = зняти цей ліміт. Перевищення нічого не блокує — воно просто видно на екрані.
        </div>

        <textarea value={note} onChange={(e) => setNote(e.target.value.slice(0, 300))}
          placeholder="Чому саме так?"
          style={{ font: "inherit", fontSize: "var(--fs-sm)", padding: "6px 8px", borderRadius: 8, width: "100%",
                   minHeight: 46, resize: "vertical", border: "1px solid var(--border)",
                   background: "var(--input-bg)", color: "var(--text)", marginBottom: 4 }} />
        {/* 🔴 ПІДЛОГА ВИСОТИ — ЩОБ КНОПКИ НЕ ЇХАЛИ ПІД КУРСОРОМ.
            Заміряно на власній геометрії поповера: причина порожня → «Зберегти»
            на `y = 933`, введено ОДИН символ → `y = 918`. Двохрядкова підказка
            стискається в однорядковий лічильник, і всі чотири кнопки стрибають
            на **15px** — рівно тоді, коли до них тягнеться рука.
            Клас, а не інлайн: те саме правило треба й сусідньому поповеру, а
            двічі написане число розійшлось би. */}
        <div className="recv-hintslot"
             style={{ color: noteOk ? "var(--text-muted)" : "var(--warn)", marginBottom: 8 }}>
          {noteOk ? `${note.trim().length}/300`
                  : "Обовʼязково: через місяць ліміт без причини не відрізнити від помилки"}
        </div>

        {err && <div style={{ fontSize: "var(--fs-xs)", color: "var(--danger)", marginBottom: 6 }}>{err}</div>}

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button disabled={busy || !noteOk || !daysOk || !amtOk || !anyGiven} style={btn("var(--accent-soft)")}
            onClick={() => run(async () => {
              // Порожнє поле = `null` = «зняти саме цей ліміт». Поле, якого немає
              // в тілі, роут не чіпає — але тут обидва завжди є, бо форма їх
              // показує заповненими поточним станом.
              await setReceivableLimit({
                clientKey: client.clientKey, note: note.trim(),
                limitDays: days.trim() === "" ? null : daysNum,
                limitAmount: amount.trim() === "" ? null : amtNum,
              });
            })}>Зберегти</button>

          {/* 🔴 ОКРЕМІ КНОПКИ, а не «введіть 0»: свідома відмова — це рішення, і воно
              має бути одним кліком, а не числом, яке легко прийняти за порожнє поле.
              По одній на кожен ліміт, бо вони НЕЗАЛЕЖНІ: відмовити в сумі й лишити
              узгоджені дні — законний стан. */}
          <button disabled={busy || !noteOk} style={btn("transparent")}
            title="Відстрочку розглянули і не дали — перевізника не сплачуємо"
            onClick={() => run(async () => {
              await setReceivableLimit({ clientKey: client.clientKey, limitDays: 0, note: note.trim() });
            })}>Не давати днів</button>

          <button disabled={busy || !noteOk} style={btn("transparent")}
            title="Ліміт суми розглянули і не дали — будь-який борг вважається перевищенням"
            onClick={() => run(async () => {
              await setReceivableLimit({ clientKey: client.clientKey, limitAmount: 0, note: note.trim() });
            })}>Не давати суми</button>
        </div>

        {/* Дію видно, лише коли є що знімати. Умова дивиться на ОБИДВА ліміти:
            рядок у БД один на клієнта, тож «прибрати зовсім» знімає їх разом —
            і мусить бути доступна, якщо встановлений хоч один. */}
        {(state !== "never-set" || aState !== "never-set") && (
          <button disabled={busy} style={{ ...btn("transparent"), border: "none", marginTop: 6,
                                           color: "var(--text-muted)", fontSize: "var(--fs-sm)" }}
            title="Повернути стан «ліміт не встановлювали» — обидва ліміти"
            onClick={() => run(async () => { await clearReceivableLimit(client.clientKey); })}>
            Прибрати обидва ліміти
          </button>
        )}

        <button disabled={busy} style={{ ...btn("transparent"), border: "none", display: "block",
                                         color: "var(--text-muted)", marginTop: 2 }}
          onClick={onClose}>Скасувати</button>
      </div>
    </>
  );
}
