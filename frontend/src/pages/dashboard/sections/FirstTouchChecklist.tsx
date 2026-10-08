import type { AiCallCardResp, AiChecklistT } from "../../../api";
import { CHECK_ITEMS, CHECK_MARK_UI, PROMISE_UI, mmss, quoteTurnIndex, type PromiseStateT, type ConversationTypeT } from "../aiCallsView";

/**
 * ✅ ЧЕК-ЛИСТ ПЕРШОГО ДОТИКУ з доказами — ОДИН компонент для черги розбору й бічної картки (Роман 08.10.2026: «коли
 * нажимаєш на розібраний — показує так, а на нерозібраний — інакше»). Стани пунктів — від сервера; тут лише підписи,
 * текст-доказ і «▶ час і цитата» (лише дослівна цитата: не знайдена в репліках — без перемотки, не вгадуємо).
 */

const OBJ_TYPE_UA: Record<string, string> = { price: "дорого", think: "подумаю / передзвоню сам", competitor: "порівнює, є інший перевізник", not_now: "не зараз", other: "інше" };

const DOT: Record<"y" | "n" | "o", { mark: string; bg: string }> = { y: { mark: "✓", bg: "#166534" }, n: { mark: "✕", bg: "#b91c1c" }, o: { mark: "–", bg: "#9ca3af" } };

export function ChecklistBlock({ c, checklist, promiseState, conversationType, onSeek }: {
  c: AiCallCardResp; checklist: AiChecklistT | null; promiseState: PromiseStateT | null; conversationType: ConversationTypeT | null;
  onSeek: (t: number) => void;
}) {
  const r = c.result;
  if (!r || !checklist) return null;
  const turns = c.transcriptHidden ? null : c.turns;
  const at = (quote: string | undefined): number | null => {
    if (!quote || c.mono === "mixed") return null;
    const i = quoteTurnIndex(turns, quote);
    return i >= 0 ? turns?.[i]?.start ?? null : null;
  };
  const promise = r.promises.find((p) => p.who === "manager" && p.channel === "call") ?? null;
  // Обіцянка написати (Viber, Telegram) — Ringostat месенджерів не бачить: пункт «не рахується», але сказати «не було» — неправда.
  const msgPromise = !promise ? r.promises.find((p) => p.who === "manager" && p.channel !== "call") ?? null : null;
  const lost = conversationType === "lead_lost";
  const ob = c.row.objection;
  const evidence: Record<"request" | "price" | "promise" | "objection", { text: string; quote?: string }> = {
    request: { text: lost ? "втрачений лід — клієнт уже відмовився, розпитувати нема про що" : r.client_request?.trim() || "запиту клієнта модель не виділила" },
    price: { text: r.price.discussed ? "ціну назвали" : lost ? "втрачений лід — називати нікому" : "ціни не прозвучало", quote: r.price.quote },
    promise: promise
      ? { text: `${promise.what}${promiseState ? ` · ${PROMISE_UI[promiseState].label.toLowerCase()}` : ""}`, quote: promise.quote }
      : msgPromise
        ? { text: `обіцянка написати: ${msgPromise.what} — перевірити нічим, Ringostat месенджерів не бачить`, quote: msgPromise.quote }
        : { text: "обіцянки передзвонити чи написати не було" },
    // Заперечення (ТЗ 08.10.2026): окрема рубрика; до неї розмову ще не дійшли — чесно «ще не розібрано», не «не було».
    objection: !ob ? { text: "ще не розібрано: заперечення аналізуються для розмов від 09.10" }
      : !ob.present ? { text: "заперечення не було" }
      : { text: `${OBJ_TYPE_UA[ob.type] ?? ob.type} · ${ob.handled === "handled" ? "менеджер опрацював" : "менеджер не опрацював"}${ob.manager_action ? `: ${ob.manager_action}` : ""}`, quote: ob.client_quote },
  };
  return (
    <div className="ftd-checklist">
      {CHECK_ITEMS.map((it) => {
        const m = checklist[it.key];
        const ev = evidence[it.key];
        const t = at(ev.quote);
        return (
          <div key={it.key} className="ftd-check">
            <span aria-hidden="true" className="ftd-check-dot" style={{ background: DOT[m].bg }}>{DOT[m].mark}</span>
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <div><b>{it.label}</b> <span style={{ fontSize: 13, color: DOT[m].bg, fontWeight: 600 }}>· {CHECK_MARK_UI[m].label}</span></div>
              <div style={{ fontSize: 13, color: "var(--text-muted)" }}>{ev.text}</div>
              {ev.quote?.trim() && (t != null
                ? <button type="button" className="ftd-quote" onClick={() => onSeek(t)}>▶ <b>{mmss(t)}</b> «{ev.quote}»</button>
                : <span className="ftd-quote" style={{ cursor: "default" }}>«{ev.quote}»</span>)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
