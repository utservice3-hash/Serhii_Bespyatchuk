import { useEffect, useMemo, useState } from "react";
import { fetchNews, addNews, deleteNews, uploadFile, type NewsItem, type NewsKind } from "../../../api";
import { useDialogs } from "../../../components/Dialogs";

/**
 * 📰 СТОРІНКА «НОВИНИ» (рішення Романа 06.11.2026, макет погоджено). Дві вкладки:
 *  • «Загальні» — новини компанії, додані вручну (публікує адміністратор);
 *  • «Технічні» — автоматичні новини про оновлення дашборда (пише ланцюг викату, `release_sha`).
 * «Світ логістики», «Продажі логістичних послуг» і блок «Орієнтовні ціни за 1 км» прибрано повністю.
 *
 * «Нове» — новина з id більшим за мітку браузера ДО цього візиту (`seenBefore`): контейнер знімає її перед тим,
 * як позначити стрічку прочитаною, тож підсвітка показує саме те, чого людина ще не бачила.
 */

const ACCENT = "#c5141c";
const TECH = "#2f5d8a";
const MUTED = "var(--text-muted)";
const LIMIT = 100;

/** Розділ технічної новини — частина заголовка до двокрапки («Клієнти: …»); так написані всі новини про викат. */
function splitArea(title: string): { area: string | null; rest: string } {
  const i = title.indexOf(":");
  if (i <= 0 || i > 40) return { area: null, rest: title };
  return { area: title.slice(0, i).trim(), rest: title.slice(i + 1).trim() || title };
}

const kyivDay = (iso: string) => new Date(iso).toLocaleDateString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", year: "numeric" });
const kyivTime = (iso: string) => new Date(iso).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
function dayLabel(iso: string): string {
  const d = kyivDay(iso);
  const today = kyivDay(new Date().toISOString());
  const yest = kyivDay(new Date(Date.now() - 86_400_000).toISOString());
  const wd = new Date(iso).toLocaleDateString("uk-UA", { timeZone: "Europe/Kyiv", weekday: "long" });
  return d === today ? `Сьогодні, ${d.slice(0, 5)}` : d === yest ? `Учора, ${d.slice(0, 5)}` : `${d.slice(0, 5)}, ${wd}`;
}

export function NewsSection({ isAdmin, seenBefore }: { isAdmin: boolean; seenBefore: number }) {
  const dlg = useDialogs();
  const [kind, setKind] = useState<NewsKind>("general");
  const [items, setItems] = useState<Record<NewsKind, NewsItem[] | null>>({ general: null, tech: null });
  const [area, setArea] = useState<string>("");
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [composing, setComposing] = useState(false);
  const [form, setForm] = useState<{ title: string; body: string; imageUrl?: string }>({ title: "", body: "" });

  const load = (k: NewsKind) => fetchNews(k).then((xs) => setItems((p) => ({ ...p, [k]: xs }))).catch(() => setItems((p) => ({ ...p, [k]: [] })));
  useEffect(() => { void load("general"); void load("tech"); }, []);

  const isNew = (n: NewsItem) => n.id > seenBefore;
  const count = (k: NewsKind) => { const xs = items[k]; return xs == null ? "…" : xs.length >= LIMIT ? `${LIMIT}+` : String(xs.length); };
  const newCount = (k: NewsKind) => (items[k] ?? []).filter(isNew).length;

  const tech = items.tech ?? [];
  const areas = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of tech) { const a = splitArea(n.title).area ?? "Інше"; m.set(a, (m.get(a) ?? 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([a]) => a);
  }, [tech]);
  const shownTech = tech.filter((n) => !area || (splitArea(n.title).area ?? "Інше") === area);
  const techDays = useMemo(() => {
    const out: { label: string; rows: NewsItem[] }[] = [];
    for (const n of shownTech) {
      const label = dayLabel(n.created_at);
      const last = out[out.length - 1];
      if (last && last.label === label) last.rows.push(n); else out.push({ label, rows: [n] });
    }
    return out;
  }, [shownTech]);

  async function remove(n: NewsItem, k: NewsKind) {
    /* 🔴 ПІДТВЕРДЖЕННЯ — БО ДІЯ ДЛЯ ВСІХ. 07.09.2026 новина про викат зникла за годину саме так: значок у кутку
       картки читався як «прибрати з очей», а робив видалення для всієї компанії. */
    if (!(await dlg.confirm(`Видалити новину «${n.title}»?\n\nВона зникне В УСІХ, не лише у вас. Запис зберігається, і адміністратор може повернути його через базу.`))) return;
    await deleteNews(n.id);
    await load(k);
  }

  async function publish() {
    if (!form.title.trim()) return;
    await addNews({ category: "company", title: form.title, body: form.body, imageUrl: form.imageUrl });
    setForm({ title: "", body: "" });
    setComposing(false);
    await load("general");
  }

  const tabBtn = (k: NewsKind, label: string) => {
    const on = kind === k, nn = newCount(k);
    return (
      <button key={k} role="tab" aria-selected={on} onClick={() => setKind(k)}
        style={{ border: 0, borderRadius: 9, padding: "9px 16px", cursor: "pointer", fontWeight: 650, fontSize: 14.5,
          display: "inline-flex", alignItems: "center", gap: 8, background: on ? ACCENT : "transparent", color: on ? "#fff" : "var(--text)" }}>
        {label} <span style={{ fontSize: 12, opacity: 0.75, fontVariantNumeric: "tabular-nums" }}>{count(k)}</span>
        {nn > 0 && <span style={{ fontSize: 11, fontWeight: 700, borderRadius: 999, padding: "1px 7px", background: on ? "#fff" : "rgba(197,20,28,.12)", color: ACCENT }}>
          {nn} {nn === 1 ? "нова" : nn < 5 ? "нові" : "нових"}</span>}
      </button>
    );
  };

  const trash = (n: NewsItem, k: NewsKind) => isAdmin && (
    <button onClick={() => void remove(n, k)} title="Видалити новину для всіх"
      style={{ border: "none", background: "transparent", cursor: "pointer", color: MUTED }}>🗑</button>
  );

  return (
    <>
      <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "end", gap: 16, flexWrap: "wrap" }}>
        <div>
          <h1 className="page-title">Новини</h1>
          <div style={{ color: MUTED, fontSize: 14, marginTop: 2 }}>Що змінилось у компанії й у дашборді</div>
        </div>
        <div role="tablist" aria-label="Тип новин"
          style={{ display: "inline-flex", gap: 4, padding: 4, borderRadius: 12, background: "var(--card-bg)", border: "1px solid var(--border)" }}>
          {tabBtn("general", "Загальні")}
          {tabBtn("tech", "Технічні")}
        </div>
      </div>

      {kind === "general" && (
        <div style={{ display: "grid", gap: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div style={{ color: MUTED, fontSize: 13.5, maxWidth: "70ch" }}>Новини компанії: події, рішення, оголошення. Публікує адміністратор.</div>
            {isAdmin && !composing && (
              <button onClick={() => setComposing(true)}
                style={{ padding: "9px 14px", background: ACCENT, color: "#fff", border: "none", borderRadius: 10, fontWeight: 650, cursor: "pointer" }}>+ Додати новину</button>
            )}
          </div>

          {isAdmin && composing && (
            <div className="chart-card" style={{ display: "grid", gap: 8 }}>
              <h2 className="chart-title" style={{ margin: 0 }}>Нова загальна новина</h2>
              <input id="news-title" placeholder="Заголовок" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} style={{ width: "100%" }} />
              <textarea id="news-body" placeholder="Текст новини" value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })}
                style={{ width: "100%", minHeight: 90, padding: 8, borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)" }} />
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <input id="news-image" type="file" accept="image/*" onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (f) { const up = await uploadFile(f); setForm((p) => ({ ...p, imageUrl: up.url })); }
                }} />
                {form.imageUrl && <img src={form.imageUrl} alt="" style={{ height: 40, borderRadius: 6 }} />}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => void publish()} disabled={!form.title.trim()}
                  style={{ padding: "8px 18px", background: ACCENT, color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", opacity: form.title.trim() ? 1 : 0.5 }}>Опублікувати</button>
                <button onClick={() => { setComposing(false); setForm({ title: "", body: "" }); }}
                  style={{ padding: "8px 14px", background: "transparent", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8, cursor: "pointer" }}>Скасувати</button>
              </div>
            </div>
          )}

          {items.general == null ? <p className="loading-text">Завантаження…</p>
            : items.general.length === 0 ? <p className="loading-text">Загальних новин поки немає.</p>
            : items.general.map((n) => (
              <article key={n.id} className="chart-card"
                style={{ display: "grid", gap: 8, borderLeft: isNew(n) ? `4px solid ${ACCENT}` : undefined }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", gap: 8 }}>
                  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", color: MUTED, fontSize: 13 }}>
                    {isNew(n) && <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", borderRadius: 999, padding: "2px 8px", background: "rgba(197,20,28,.12)", color: ACCENT }}>нова</span>}
                    <span>{kyivTime(n.created_at)}</span>{n.author && <span>· {n.author}</span>}
                  </div>
                  {trash(n, "general")}
                </div>
                <h2 className="chart-title" style={{ margin: 0, fontSize: 20, textWrap: "balance" }}>{n.title}</h2>
                {n.image_url && <img src={n.image_url} alt="" style={{ maxWidth: "100%", borderRadius: 10 }} />}
                {n.body && <p style={{ margin: 0, color: "var(--text)", whiteSpace: "pre-wrap", maxWidth: "72ch" }}>{n.body}</p>}
              </article>
            ))}
        </div>
      )}

      {kind === "tech" && (
        <div style={{ display: "grid", gap: 12 }}>
          <div style={{ color: MUTED, fontSize: 13.5, maxWidth: "75ch" }}>
            Оновлення дашборда. Публікуються автоматично після кожного викату; кожен бачить лише новини про ті розділи, до яких має доступ.
          </div>
          {areas.length > 1 && (
            <div role="group" aria-label="Розділ" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {["", ...areas].map((a) => {
                const on = area === a;
                return (
                  <button key={a || "all"} aria-pressed={on} onClick={() => setArea(a)}
                    style={{ borderRadius: 999, padding: "4px 11px", fontSize: 13, cursor: "pointer",
                      border: `1px solid ${on ? TECH : "var(--border)"}`, background: on ? TECH : "var(--card-bg)", color: on ? "#fff" : "var(--text)" }}>
                    {a || "Усі розділи"}
                  </button>
                );
              })}
            </div>
          )}
          {items.tech == null ? <p className="loading-text">Завантаження…</p>
            : shownTech.length === 0 ? <p className="loading-text">У цьому розділі оновлень поки немає.</p>
            : techDays.map((d) => (
              <div key={d.label} style={{ display: "grid", gap: 8 }}>
                <h3 style={{ margin: "8px 0 0", fontSize: 12.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", color: MUTED }}>{d.label}</h3>
                {d.rows.map((n) => {
                  const { area: a, rest } = splitArea(n.title);
                  const expanded = open.has(n.id);
                  return (
                    <article key={n.id} className="chart-card" style={{ display: "grid", gridTemplateColumns: "10px 1fr auto", gap: "4px 12px", padding: "13px 16px", margin: 0 }}>
                      <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: "50%", marginTop: 8, background: isNew(n) ? ACCENT : "transparent" }} />
                      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                        {a && <span style={{ fontSize: 12, fontWeight: 600, color: TECH, background: "rgba(47,93,138,.12)", borderRadius: 6, padding: "1px 7px", whiteSpace: "nowrap" }}>{a}</span>}
                        <h4 style={{ margin: 0, fontSize: 15.5, fontWeight: 650 }}>{rest}</h4>
                      </div>
                      {trash(n, "tech") || <span />}
                      {n.body && (
                        <div style={{ gridColumn: 2, fontSize: 14, color: "var(--text)", whiteSpace: "pre-wrap", maxWidth: "78ch",
                          ...(expanded ? {} : { display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as const, overflow: "hidden" }) }}>
                          {n.body}
                        </div>
                      )}
                      <div style={{ gridColumn: 2, display: "flex", gap: 12, alignItems: "center", color: MUTED, fontSize: 12.5, flexWrap: "wrap" }}>
                        {n.body && (
                          <button onClick={() => setOpen((p) => { const s = new Set(p); if (s.has(n.id)) s.delete(n.id); else s.add(n.id); return s; })}
                            style={{ border: 0, background: "none", color: TECH, fontWeight: 600, fontSize: 12.5, cursor: "pointer", padding: 0 }}>
                            {expanded ? "Згорнути" : "Детальніше"}
                          </button>
                        )}
                        <span>{kyivTime(n.created_at).slice(-5)}</span>
                        {isNew(n) && <span>нове з вашого останнього візиту</span>}
                      </div>
                    </article>
                  );
                })}
              </div>
            ))}
        </div>
      )}
    </>
  );
}
