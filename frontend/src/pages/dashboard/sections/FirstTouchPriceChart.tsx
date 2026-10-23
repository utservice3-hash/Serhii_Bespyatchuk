import { MIN_GROUP_CALLS, type PriceConvLine, type PriceConvPart } from "../aiCallsView";

/**
 * 📊 ВИГЛЯД «ГРАФІК» БЛОКУ «МЕНЕДЖЕРИ ЗА ЧЕК-ЛИСТОМ» (задача 6439 п.3; Роман 22.10.2026). Одне питання — чи допомагає
 * названа ціна успіху: сіра точка — успіх без ціни, зелена — з ціною, на одній шкалі; лінія між ними зелена, коли з ціною
 * вище, червона — коли нижче. Рахує `priceConversionByManager`; тут лише вигляд.
 */
const partText = (p: PriceConvPart) => (p.pct == null ? "—" : `${String(p.pct)}% (${String(p.n)} з ${String(p.of)})`);
const liftText = (l: PriceConvLine) => (l.liftPp == null ? "" : `${l.liftPp > 0 ? "+" : ""}${String(l.liftPp)} п.п.`);
const liftTone = (l: PriceConvLine) => (l.liftPp == null || l.liftPp === 0 ? "" : l.liftPp > 0 ? " is-up" : " is-down");

function note(l: PriceConvLine): string | null {
  if (l.withPrice.of === 0) return "ціну не називав";
  if (l.withoutPrice.of === 0) return "ціну називав завжди";
  if (!l.enough) return `замало розмов: ${String(l.withPrice.of)} з ціною / ${String(l.withoutPrice.of)} без (треба від ${String(MIN_GROUP_CALLS)})`;
  return null;
}

function Row({ l, total, on, onPick }: { l: PriceConvLine; total?: boolean; on?: boolean; onPick?: () => void }) {
  const a = l.withoutPrice.pct, b = l.withPrice.pct;
  const lo = a != null && b != null ? Math.min(a, b) : null, hi = a != null && b != null ? Math.max(a, b) : null;
  const n = note(l);
  const title = `${l.name}: з ціною ${partText(l.withPrice)} · без ціни ${partText(l.withoutPrice)} · ціну назвали ${partText(l.priced)}`;
  const name = (
    <>{l.name} <span>· {l.calls}{l.priced.pct != null ? ` · ціна в ${String(l.priced.pct)}%` : ""}</span></>
  );
  return (
    <div className={`ftd-db-row${total ? " is-total" : ""}${!total && !l.enough ? " is-weak" : ""}`} title={title}>
      {onPick
        ? <button type="button" className={`ftd-mgr-name${on ? " on" : ""}`} aria-pressed={on} onClick={onPick}>{name}</button>
        : <div className="ftd-mgr-name is-static">{name}</div>}
      <div className="ftd-db-track" aria-hidden="true">
        {[25, 50, 75].map((t) => <i key={t} className="ftd-db-tick" style={{ left: `${String(t)}%` }} />)}
        {lo != null && hi != null && <b className={`ftd-db-line${liftTone(l)}`} style={{ left: `${String(lo)}%`, width: `${String(hi - lo)}%` }} />}
        {a != null && <em className="ftd-db-dot is-without" style={{ left: `${String(a)}%` }} />}
        {b != null && <em className="ftd-db-dot is-with" style={{ left: `${String(b)}%` }} />}
      </div>
      <div className="ftd-db-val">
        <span>{a == null ? "—" : `${String(a)}%`} → {b == null ? "—" : `${String(b)}%`}</span>
        {n ? <span className="ftd-sub">{n}</span> : <b className={`ftd-db-lift${liftTone(l)}`}>{liftText(l)}</b>}
      </div>
    </div>
  );
}

export function FirstTouchPriceChart({ lines, total, selectedId, onPick }: {
  lines: readonly PriceConvLine[]; total: PriceConvLine | null; selectedId: number | null; onPick: (managerId: number | null) => void;
}) {
  if (!total) return <p className="ftd-sub" style={{ margin: 0 }}>Розібраних розмов у періоді ще немає.</p>;
  const ratio = total.withPrice.pct && total.withoutPrice.pct ? total.withPrice.pct / total.withoutPrice.pct : null;
  return (
    <div className="ftd-db">
      <div className="ftd-db-legend">
        <span><em className="ftd-db-dot is-without" /> успіх, коли ціну НЕ назвали</span>
        <span><em className="ftd-db-dot is-with" /> успіх, коли ціну назвали</span>
        <span className="ftd-sub">успіх — угода в «Авто працює» або далі · наведіть на рядок — «N з M»</span>
      </div>
      <div className="ftd-db-head"><span /><div className="ftd-db-axis">{[0, 25, 50, 75, 100].map((t) => <span key={t} style={{ left: `${String(t)}%` }}>{t}%</span>)}</div><span /></div>
      <Row l={total} total />
      {ratio != null && total.enough && (
        <div className="ftd-sub ftd-db-verdict">
          {ratio >= 1.05 ? `З названою ціною машина їде в ${ratio.toFixed(1).replace(".", ",")} раза частіше.`
            : ratio <= 0.95 ? "З названою ціною успіх НИЖЧИЙ, ніж без неї." : "Названа ціна на успіх майже не впливає."}
        </div>
      )}
      {lines.map((l) => <Row key={String(l.managerId)} l={l} on={selectedId === l.managerId}
        onPick={() => onPick(selectedId === l.managerId ? null : l.managerId)} />)}
    </div>
  );
}
