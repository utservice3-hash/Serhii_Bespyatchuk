import { useEffect, useMemo, useState } from "react";
import { fetchO2OForm, saveO2OForm, type O2OForm, type O2OFormBody, type O2OFieldType } from "../../../api";

/** Редактор наборів питань 1×1 (право edit_1x1_forms). Збереження створює НОВУ версію форми;
 *  qKey стабільні (історія тримається за ними), тому наявні питання зберігають свій qKey. */
const FIELD_LABEL: Record<O2OFieldType, string> = { score: "Оцінка 1-10", text: "Текст", score_text: "Оцінка + текст" };
const newQKey = (type: string) => `${type.toLowerCase()}_${Math.random().toString(36).slice(2, 9)}`;
const clone = (b: O2OFormBody): O2OFormBody => JSON.parse(JSON.stringify(b));

export function OneOnOneFormsEditor({ type }: { type: string }) {
  const [draft, setDraft] = useState<O2OFormBody | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = () => fetchO2OForm(type).then((f: O2OForm) => { setDraft(clone(f.questions)); setVersion(f.version); }).catch(() => setDraft(null));
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [type]);

  const sectionKeys = useMemo(() => (draft?.sections ?? []).map((s) => ({ key: s.key, title: s.title })), [draft]);
  if (!draft) return <div className="chart-card"><p className="loading-text" style={{ margin: 0 }}>Завантаження форми…</p></div>;

  const mutate = (fn: (d: O2OFormBody) => void) => setDraft((prev) => { const d = clone(prev!); fn(d); return d; });

  const save = async () => {
    setSaving(true); setMsg(null);
    try { const { version: v } = await saveO2OForm(type, draft); setMsg(`Збережено як версію ${v}.`); await load(); }
    catch (e: unknown) { setMsg((e as { response?: { data?: { error?: string } } })?.response?.data?.error || "Помилка збереження"); }
    finally { setSaving(false); }
  };

  return (
    <div className="chart-card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
        <h2 className="chart-title" style={{ margin: 0 }}>✏️ Питання — тип {type} <span style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 400 }}>(активна v{version})</span></h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {msg && <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{msg}</span>}
          <button onClick={save} disabled={saving}
            style={{ padding: "7px 18px", borderRadius: 8, border: "none", background: "#c5141c", color: "#fff", fontWeight: 700, cursor: saving ? "default" : "pointer", opacity: saving ? 0.6 : 1 }}>
            {saving ? "Збереження…" : "💾 Зберегти нову версію"}
          </button>
        </div>
      </div>
      <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 14px" }}>
        Збереження створює нову версію. Наявні зустрічі лишаються привʼязані до своєї версії — історія не змінюється.
      </p>

      {(type === "V") && (
        <div style={{ display: "flex", gap: 16, marginBottom: 14 }}>
          <label style={{ fontSize: 13, display: "inline-flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={!!draft.enps} onChange={(e) => mutate((d) => { d.enps = e.target.checked; })} /> Блок eNPS
          </label>
          <label style={{ fontSize: 13, display: "inline-flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={!!draft.notes} onChange={(e) => mutate((d) => { d.notes = e.target.checked; })} /> Панель «Нотатки HR»
          </label>
        </div>
      )}

      {draft.sections.map((sec, si) => (
        <div key={sec.key} style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 12, marginBottom: 12 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
            <input value={sec.title} onChange={(e) => mutate((d) => { d.sections[si].title = e.target.value; })}
              style={{ font: "inherit", fontWeight: 700, padding: 6, borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", flex: 1 }} />
            <button title="Секцію вгору" disabled={si === 0} onClick={() => mutate((d) => { [d.sections[si - 1], d.sections[si]] = [d.sections[si], d.sections[si - 1]]; })} style={btn}>↑</button>
            <button title="Секцію вниз" disabled={si === draft.sections.length - 1} onClick={() => mutate((d) => { [d.sections[si + 1], d.sections[si]] = [d.sections[si], d.sections[si + 1]]; })} style={btn}>↓</button>
            <button title="Видалити секцію" onClick={() => mutate((d) => { d.sections.splice(si, 1); })} style={{ ...btn, color: "#dc2626" }}>🗑</button>
          </div>

          {sec.questions.map((q, qi) => (
            <div key={q.qKey} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "start", padding: "8px 0", borderTop: qi ? "1px dashed var(--border)" : "none" }}>
              <div>
                <textarea value={q.label} onChange={(e) => mutate((d) => { d.sections[si].questions[qi].label = e.target.value; })} rows={2}
                  style={{ width: "100%", resize: "vertical", font: "inherit", padding: 6, borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)" }} />
                <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}>
                  <select value={q.field} onChange={(e) => mutate((d) => { d.sections[si].questions[qi].field = e.target.value as O2OFieldType; })}
                    style={{ font: "inherit", padding: 4, borderRadius: 6, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)" }}>
                    {(Object.keys(FIELD_LABEL) as O2OFieldType[]).map((f) => <option key={f} value={f}>{FIELD_LABEL[f]}</option>)}
                  </select>
                  <label style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 4 }}>
                    <input type="checkbox" checked={!!q.quarterly} onChange={(e) => mutate((d) => { d.sections[si].questions[qi].quarterly = e.target.checked; })} /> 1×/квартал
                  </label>
                  <label style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 4, color: "var(--text-muted)" }}>
                    → секція
                    <select value={sec.key} onChange={(e) => mutate((d) => {
                      const target = d.sections.findIndex((s) => s.key === e.target.value);
                      if (target < 0 || target === si) return;
                      const [moved] = d.sections[si].questions.splice(qi, 1);
                      d.sections[target].questions.push(moved);
                    })} style={{ font: "inherit", padding: 3, borderRadius: 6, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)" }}>
                      {sectionKeys.map((s) => <option key={s.key} value={s.key}>{s.title}</option>)}
                    </select>
                  </label>
                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{q.qKey}</span>
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <button title="Вгору" disabled={qi === 0} onClick={() => mutate((d) => { const qs = d.sections[si].questions; [qs[qi - 1], qs[qi]] = [qs[qi], qs[qi - 1]]; })} style={btn}>↑</button>
                <button title="Вниз" disabled={qi === sec.questions.length - 1} onClick={() => mutate((d) => { const qs = d.sections[si].questions; [qs[qi + 1], qs[qi]] = [qs[qi], qs[qi + 1]]; })} style={btn}>↓</button>
                <button title="Видалити" onClick={() => mutate((d) => { d.sections[si].questions.splice(qi, 1); })} style={{ ...btn, color: "#dc2626" }}>🗑</button>
              </div>
            </div>
          ))}
          <button onClick={() => mutate((d) => { d.sections[si].questions.push({ qKey: newQKey(type), label: "Нове питання", field: "text" }); })}
            style={{ ...btn, marginTop: 8, width: "auto", padding: "6px 12px" }}>＋ Питання</button>
        </div>
      ))}

      <button onClick={() => mutate((d) => { d.sections.push({ key: newQKey(type), title: "Нова секція", questions: [] }); })}
        style={{ ...btn, padding: "8px 14px", width: "auto", fontWeight: 700 }}>＋ Секція</button>
    </div>
  );
}

const btn: React.CSSProperties = {
  minWidth: 28, height: 28, borderRadius: 6, cursor: "pointer", fontWeight: 700,
  border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)",
};
