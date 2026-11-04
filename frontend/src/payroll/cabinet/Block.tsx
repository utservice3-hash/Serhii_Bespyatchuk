/** Блок-секція кабінету: заголовок + підзаголовок + праве (чип). id — для переходу зі сповіщень. */
import type { ReactNode } from "react";

export function Block({ id, title, sub, aside, tone, children }: { id?: string; title?: ReactNode; sub?: ReactNode; aside?: ReactNode; tone?: "warn" | "gift"; children: ReactNode }) {
  return (
    <section id={id} className={`zp-card zc-block ${tone ? `zc-block--${tone}` : ""}`}>
      {(title || aside) && (
        <header className="zp-card__head">
          <h3>{title}{sub && <span className="zc-sub">{sub}</span>}</h3>
          {aside && <div className="zp-row">{aside}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

