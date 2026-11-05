/**
 * 💰 «Архів» (ТЗ §7.1, макет p07-fin.js `archive`): фонд ЗП і маржа компанії по місяцях (ряд `deptStats` рушія — архів Excel,
 * закриті й поточний місяць «при виконанні плану»), працівник по місяцях (`payroll_archive` + виплачені листи), імпорт зі
 * старого Excel (право `payroll_settings`). Колонки Excel: «ПІБ» (або «id»), «Місяць» (РРРР-ММ), «Нараховано»; «Рівень», «Маржа».
 */
import { useMemo, useRef, useState } from "react";
import type { PayrollCtx } from "../PayrollSection";
import { errText, payrollApi, type Obj } from "../api";
import { Card, Empty, Loading, Pill, money, monthTitle, pct, readDataUrl, useLoad } from "../ui";
import { useToast } from "../../components/Toasts";
import { LEVEL_NAMES } from "./common";

const SRC: Record<string, [string, "muted" | "ok" | "info"]> = { excel: ["Excel (імпорт)", "muted"], paid: ["виплачено", "ok"] };

function Chart({ rows, live }: { rows: Array<{ month: string; pay: number; comp: number }>; live: string }) {
  if (!rows.length) return null;
  const W = 900, H = 230, n = rows.length, gw = (W - 50) / n;
  const maxM = Math.max(1, ...rows.map((r) => Math.max(r.comp, r.pay))) * 1.1;
  const y = (v: number) => H - 28 - (v / maxM) * (H - 56);
  return (
    <svg className="zps-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Фонд ЗП і маржа по місяцях">
      {[0.25, 0.5, 0.75, 1].map((t) => { const v = (maxM * t) / 1.1; return (
        <g key={t}><line className="grid" x1={36} x2={W - 6} y1={y(v)} y2={y(v)} /><text x={32} y={y(v) + 4} textAnchor="end">{v >= 1e6 ? `${(v / 1e6).toFixed(1).replace(".", ",")}М` : `${Math.round(v / 1e3)}К`}</text></g>
      ); })}
      {rows.map((r, i) => {
        const x = 40 + i * gw, isLive = r.month === live;
        return (
          <g key={r.month}>
            <rect x={x + 6} y={y(r.comp)} width={Math.max(2, gw / 2 - 8)} height={H - 28 - y(r.comp)} rx={3} fill="var(--border-strong)" />
            <rect x={x + gw / 2} y={y(r.pay)} width={Math.max(2, gw / 2 - 8)} height={H - 28 - y(r.pay)} rx={3} fill="var(--ok)" opacity={isLive ? 0.45 : 1} />
            <text x={x + gw / 2} y={H - 10} textAnchor="middle">{monthTitle(r.month).slice(0, 3).toLowerCase()}{isLive ? " (план)" : ""}</text>
            {r.comp > 0 && <text x={x + gw * 0.75 - 4} y={y(r.pay) - 5} textAnchor="middle">{pct((r.pay / r.comp) * 100)}</text>}
          </g>
        );
      })}
    </svg>
  );
}

export default function ArchiveTab({ ctx }: { ctx: PayrollCtx }) {
  const toast = useToast();
  const { data, err, reload } = useLoad(async () => {
    const [an, arch] = await Promise.all([payrollApi.analytics(ctx.liveMonth, true), payrollApi.archive()]);
    return { series: (an.series ?? []) as Array<{ month: string; pay: number; comp: number; pct: number | null }>, arch: arch as Obj[] };
  }, [ctx.liveMonth]);
  const [who, setWho] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ imported: number; errors: string[] } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const people = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of data?.arch ?? []) m.set(String(r.userId), String(r.name));
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1], "uk"));
  }, [data]);
  if (!data) return <Loading err={err} onRetry={reload} />;
  const sel = who || people[0]?.[0] || "";
  const mine = data.arch.filter((r) => String(r.userId) === sel).sort((a, b) => String(b.month).localeCompare(String(a.month)));

  async function onFile(f: File | undefined) {
    if (!f) return;
    setBusy(true); setResult(null);
    try { const r = await payrollApi.importArchive(await readDataUrl(f)); setResult(r); toast(`Імпортовано рядків: ${r.imported}${r.errors?.length ? `, помилок: ${r.errors.length}` : ""}.`); await reload(); }
    catch (e) { toast(errText(e), { error: true }); }
    finally { setBusy(false); if (file.current) file.current.value = ""; }
  }

  const rows = [...data.series].reverse();
  return (
    <div className="zp-grid">
      <Card title="Фонд ЗП і маржа по місяцях" aside="сірі — маржа компанії, зелені — фонд ЗП; підпис — частка ФЗП у маржі">
        <div className="zp-grid" style={{ gap: 12 }}>
          {data.series.length ? <div className="zp-table-wrap"><Chart rows={data.series} live={ctx.liveMonth} /></div> : <Empty>Даних по місяцях ще немає.</Empty>}
          {rows.length > 0 && (
            <div className="zp-table-wrap">
              <table className="zp-table">
                <thead><tr><th>Місяць</th><th className="r">Маржа компанії</th><th className="r">Фонд ЗП</th><th className="r">ФЗП / маржа</th><th>Джерело</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.month}>
                      <td>{monthTitle(r.month)}</td>
                      <td className="r">{money(r.comp)}</td>
                      <td className="r">{money(r.pay)}</td>
                      <td className="r">{r.comp > 0 ? pct((r.pay / r.comp) * 100, 1) : "—"}</td>
                      <td>{r.month === ctx.liveMonth ? <Pill tone="info">іде · при виконанні плану</Pill> : r.month === ctx.closedMonth ? <Pill tone="warn">закриття</Pill> : <Pill>архів / виплачено</Pill>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {ctx.perms.has("payroll_settings") && (
            <div className="zp-grid" style={{ gap: 8 }}>
              <div className="zp-row">
                <button className="zp-btn" disabled={busy} onClick={() => file.current?.click()}>{busy ? "Імпортуємо…" : "Імпорт зі старого Excel"}</button>
                <input ref={file} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={(e) => void onFile(e.target.files?.[0])} />
                <span className="zp-hint">Колонки: «ПІБ» (або «id»), «Місяць» (РРРР-ММ), «Нараховано»; необовʼязкові — «Рівень», «Маржа». Повторний імпорт місяця замінює рядок.</span>
              </div>
              {result && (
                <div className={`zp-note ${result.errors?.length ? "zp-note--warn" : "zp-note--ok"}`}>
                  Імпортовано: {result.imported}.{result.errors?.length ? ` Не взято ${result.errors.length}:` : ""}
                  {result.errors?.length ? <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>{result.errors.slice(0, 30).map((x) => <li key={x}>{x}</li>)}{result.errors.length > 30 && <li>… ще {result.errors.length - 30}</li>}</ul> : null}
                </div>
              )}
            </div>
          )}
        </div>
      </Card>
      <Card title="Працівник по місяцях" aside={people.length ? (
        <select className="zp-select" style={{ width: "auto" }} value={sel} onChange={(e) => setWho(e.target.value)}>
          {people.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>) : undefined}>
        {mine.length ? (
          <div className="zp-table-wrap">
            <table className="zp-table">
              <thead><tr><th>Місяць</th><th>Рівень</th><th className="r">Маржа</th><th className="r">Нараховано</th><th>Джерело</th></tr></thead>
              <tbody>
                {mine.map((r) => (
                  <tr key={`${r.month}-${r.source}`}>
                    <td>{monthTitle(r.month)}</td>
                    <td>{r.level ? LEVEL_NAMES[r.level] ?? r.level : "—"}</td>
                    <td className="r">{r.margin ? money(r.margin) : "—"}</td>
                    <td className="r">{money(r.fund)}</td>
                    <td><Pill tone={SRC[r.source]?.[1] ?? "muted"}>{SRC[r.source]?.[0] ?? r.source}</Pill></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>Архіву ще немає: тут будуть виплачені місяці й рядки, імпортовані зі старого Excel.</Empty>}
      </Card>
      <Card title="Безпека">
        <div className="zp-grid" style={{ gap: 6, fontSize: 13.5 }}>
          <div>Бачать усіх: фінансисти, операційний директор, CEO. Працівник — лише своє; тім-лід — план і маржу команди, без чужих зарплат.</div>
          <div>Змінюють: фінансисти й операційний директор; CEO — лише перегляд. ЗП фінансиста перевіряє операційний директор.</div>
          <div>Номери карт: на екрані — •••• останні 4 цифри; повністю — лише у відомості й Excel для фінансистів.</div>
          <div>Кожна зміна (умови, шкали, офіційна ЗП, перевірка, згода, аванс, форма, виплата, вивантаження Excel) — в історії: хто, коли, що було → стало.</div>
        </div>
      </Card>
    </div>
  );
}
