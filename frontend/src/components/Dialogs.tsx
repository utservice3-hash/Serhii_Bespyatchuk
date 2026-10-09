import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { confirmLabel, firstInvalid, keyAction, submittedValues, type FieldSpec } from "./dialogRules";

/**
 * 🪟 ДІАЛОГИ ДАШБОРДА — ОДНА РЕАЛІЗАЦІЯ ЗАМІСТЬ `window.confirm/prompt` (прохід B стандарту сповіщень, 09.10.2026).
 *
 * Сірі вікна браузера блокували всю вкладку, не мали стилю дашборда, а «обовʼязково» в них трималось лише на перевірці
 * ПІСЛЯ закриття. Тепер — `useDialogs()`:
 *  · `confirm(text | {…})` → `true/false`; кнопка — назва дії («Видалити»), небезпечна — червона, фокус на «Скасувати»;
 *  · `prompt(label, initial)` або `prompt({…})` → рядок без крайніх пробілів або `null` (скасовано);
 *  · `choose({ options })` → значення зі списку або `null`;
 *  · `form({ fields })` → кілька полів одним діалогом (створення ролі) або `null`.
 * Поведінка — `dialogRules.ts`: Esc скасовує, Enter підтверджує (крім багаторядкового поля й порожнього обовʼязкового).
 *
 * 🔴 КОЖЕН ВИКЛИК — З `await`. Діалог повертає обіцянку, а вона завжди «правдива»: `if (!confirm(…)) return` без `await`
 * пропустив би «Видалити?» БЕЗ питання, і `tsc` цього не бачить. Тримає `#1500b`.
 */
type ConfirmOpts = { title?: string; text: string; okLabel?: string; danger?: boolean };
type PromptOpts = { title?: string; label: string; initial?: string; placeholder?: string; required?: boolean; multiline?: boolean; okLabel?: string };
type ChooseOpts = { title: string; text?: string; options: { value: string; label: string; hint?: string }[]; okLabel?: string };
type FormOpts = { title: string; text?: string; fields: FieldSpec[]; okLabel?: string };

export interface Dialogs {
  confirm: (o: string | ConfirmOpts) => Promise<boolean>;
  prompt: (o: string | PromptOpts, initial?: string) => Promise<string | null>;
  choose: (o: ChooseOpts) => Promise<string | null>;
  form: (o: FormOpts) => Promise<Record<string, string> | null>;
}

type Req = {
  id: number; title?: string; text?: string; fields: FieldSpec[]; okLabel: string; danger: boolean; hasCancel: boolean;
  resolve: (v: Record<string, string> | null) => void;
};

const DialogContext = createContext<Dialogs | null>(null);

export function DialogProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<Req[]>([]);
  const seq = useRef(0);
  const open = useCallback((r: Omit<Req, "id" | "resolve">) => new Promise<Record<string, string> | null>((resolve) => {
    setQueue((q) => [...q, { ...r, id: ++seq.current, resolve }]);
  }), []);

  const dialogs: Dialogs = {
    confirm: useCallback(async (o) => {
      const c = typeof o === "string" ? { text: o } : o;
      const auto = confirmLabel(c.text);
      return (await open({ title: c.title, text: c.text, fields: [], okLabel: c.okLabel ?? auto.label, danger: c.danger ?? auto.danger, hasCancel: true })) !== null;
    }, [open]),
    prompt: useCallback(async (o, initial) => {
      const p: PromptOpts = typeof o === "string" ? { label: o, initial } : o;
      const r = await open({ title: p.title, fields: [{ key: "v", label: p.label, initial: p.initial ?? "", placeholder: p.placeholder, required: p.required, multiline: p.multiline }],
        okLabel: p.okLabel ?? "Зберегти", danger: false, hasCancel: true });
      return r === null ? null : r.v;
    }, [open]),
    choose: useCallback(async (o) => {
      const r = await open({ title: o.title, text: o.text, fields: [{ key: "v", label: "", options: o.options, required: true }], okLabel: o.okLabel ?? "Обрати", danger: false, hasCancel: true });
      return r === null ? null : r.v;
    }, [open]),
    form: useCallback(async (o) => open({ title: o.title, text: o.text, fields: o.fields, okLabel: o.okLabel ?? "Зберегти", danger: false, hasCancel: true }), [open]),
  };

  const cur = queue[0] ?? null;
  const close = (v: Record<string, string> | null) => {
    if (!cur) return;
    cur.resolve(v);
    setQueue((q) => q.slice(1));
  };

  return (
    <DialogContext.Provider value={dialogs}>
      {children}
      {cur && createPortal(<DialogView key={cur.id} req={cur} onClose={close} />, document.body)}
    </DialogContext.Provider>
  );
}

function DialogView({ req, onClose }: { req: Req; onClose: (v: Record<string, string> | null) => void }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(req.fields.map((f) => [f.key, f.initial ?? ""])));
  const invalid = firstInvalid(req.fields, values) !== null;
  const firstRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const okRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    // Фокус: у поле; у небезпечному підтвердженні — на «Скасувати» (Enter не видалить випадково); інакше — на кнопку дії.
    const t = window.setTimeout(() => {
      if (firstRef.current) { firstRef.current.focus(); if ("select" in firstRef.current) firstRef.current.select(); }
      else (req.danger ? cancelRef.current : okRef.current)?.focus();
    }, 0);
    return () => window.clearTimeout(t);
  }, [req.danger]);
  const submit = () => { if (!invalid) onClose(submittedValues(req.fields, values)); };
  const onKey = (e: React.KeyboardEvent) => {
    const inMultiline = (e.target as HTMLElement).tagName === "TEXTAREA";
    const a = keyAction(e.key, { inMultiline, invalid });
    if (a === "cancel") { e.preventDefault(); e.stopPropagation(); onClose(null); }
    else if (a === "submit" && (e.target as HTMLElement).tagName !== "BUTTON") { e.preventDefault(); submit(); }
  };
  const inputStyle = { width: "100%", boxSizing: "border-box" as const, border: "1px solid var(--border-strong)", borderRadius: "var(--r-md)", padding: "8px 10px", font: "inherit", fontSize: 14, background: "var(--card-bg)", color: "var(--text)" };
  return (
    <div onKeyDown={onKey} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(null); }}
      style={{ position: "fixed", inset: 0, zIndex: 5000, background: "rgba(15, 23, 42, .45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div role="dialog" aria-modal="true" aria-labelledby={req.title ? "dlg-title" : undefined}
        style={{ width: "min(460px, 100%)", background: "var(--card-bg)", color: "var(--text)", borderRadius: "var(--r-xl)", boxShadow: "var(--shadow-lg)", padding: "18px 18px 14px" }}>
        {req.title && <div id="dlg-title" style={{ fontWeight: 700, fontSize: 16, marginBottom: 8 }}>{req.title}</div>}
        {req.text && <div style={{ fontSize: 14, lineHeight: 1.5, whiteSpace: "pre-wrap", marginBottom: req.fields.length ? 12 : 4 }}>{req.text}</div>}
        {req.fields.map((f, i) => (
          <div key={f.key} style={{ marginBottom: 10 }}>
            {f.label && <label htmlFor={`dlg-f-${f.key}`} style={{ display: "block", fontSize: 13, marginBottom: 5, whiteSpace: "pre-wrap", lineHeight: 1.45 }}>
              {f.label}{f.required && !f.options ? <span style={{ color: "var(--danger)" }}> *</span> : null}</label>}
            {f.options ? (
              <div role="radiogroup" style={{ display: "grid", gap: 6 }}>
                {f.options.map((o) => (
                  <label key={o.value} style={{ display: "flex", gap: 8, alignItems: "flex-start", border: values[f.key] === o.value ? "2px solid var(--brand)" : "1px solid var(--border)", borderRadius: "var(--r-md)", padding: "8px 10px", cursor: "pointer", fontSize: 13.5 }}>
                    <input type="radio" name={`dlg-${f.key}`} checked={values[f.key] === o.value} onChange={() => setValues((v) => ({ ...v, [f.key]: o.value }))}
                      ref={i === 0 && o === f.options![0] ? (el) => { firstRef.current = el; } : undefined} />
                    <span><b>{o.label}</b>{o.hint && <span style={{ display: "block", color: "var(--text-muted)", fontSize: 12.5 }}>{o.hint}</span>}</span>
                  </label>
                ))}
              </div>
            ) : f.multiline ? (
              <textarea id={`dlg-f-${f.key}`} value={values[f.key]} placeholder={f.placeholder} rows={3}
                ref={i === 0 ? (el) => { firstRef.current = el; } : undefined}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} style={{ ...inputStyle, resize: "vertical" }} />
            ) : (
              <input id={`dlg-f-${f.key}`} value={values[f.key]} placeholder={f.placeholder}
                ref={i === 0 ? (el) => { firstRef.current = el; } : undefined}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} style={inputStyle} />
            )}
          </div>
        ))}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
          {req.hasCancel && <button ref={cancelRef} type="button" onClick={() => onClose(null)}
            style={{ border: "1px solid var(--border-strong)", background: "var(--card-bg)", color: "var(--text)", borderRadius: "var(--r-md)", padding: "7px 14px", font: "inherit", fontSize: 13.5, cursor: "pointer" }}>Скасувати</button>}
          <button ref={okRef} type="button" onClick={submit} disabled={invalid}
            style={{ border: "none", background: invalid ? "var(--border-strong)" : req.danger ? "var(--danger)" : "var(--brand)", color: "#fff", borderRadius: "var(--r-md)", padding: "7px 14px", font: "inherit", fontSize: 13.5, fontWeight: 600, cursor: invalid ? "not-allowed" : "pointer" }}>{req.okLabel}</button>
        </div>
      </div>
    </div>
  );
}

export function useDialogs(): Dialogs {
  const d = useContext(DialogContext);
  if (!d) throw new Error("useDialogs() поза <DialogProvider>");
  return d;
}
