import { Fragment, useState } from "react";
import type { FinApprLine, FinApprPot, FinApprOutside } from "../../../api";

/**
 * 🧾 Спільні блоки «План/факт витрат» для факту з таблиці «UTS Утверждение оплат» (задача Тетяни #5607): рядки оплат під
 * статтею (у картці статті) і «Не потрапило у статті» — кошики, які правило не віднесло до статей, з сумою, щоб гроші не
 * зникали мовчки. Жили у тестовій вкладці «План/факт · авто (тест)»; 21.10.2026 Тетяна: «авто тепер основний, ручний
 * прибирати» — вкладку прибрано, блоки лишились тут. Реквізитів і отримувачів немає — лише 5 полів рядка.
 */
const money = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString("uk-UA", { maximumFractionDigits: 2 }));
const r2 = (n: number) => Math.round(n * 100) / 100;
const dm = (d: string | null) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}` : "—");

/** Рядки таблиці оплат під статтею чи кошиком — без реквізитів і отримувача. */
export function Lines({ lines }: { lines: FinApprLine[] }) {
  return (
    <table className="hr-table" style={{ fontSize: 12.5, margin: "2px 0 6px" }}>
      <thead><tr><th>Дата оплати</th><th>Що купили</th><th className="num">Сума</th><th>Напрямок</th><th>Оплачено</th></tr></thead>
      <tbody>{lines.map((l, i) => (
        <tr key={i}><td style={{ whiteSpace: "nowrap" }}>{dm(l.payDate)}</td><td>{l.what || <span className="hr-muted">—</span>}</td><td className="num">{money(l.amount)}</td>
          <td>{l.direction || <span className="hr-muted">не вказано</span>}</td><td>{l.paid ? "так" : <span className="hr-pill wn">ні</span>}</td></tr>
      ))}</tbody>
    </table>
  );
}

/** Один кошик «не потрапило у статті» — рядки в спільній таблиці (`Outside`), щоб числа стояли в одній колонці. */
interface Bucket { title: string; hint: string; pots: FinApprPot[] }
/** «Не потрапило у статті»: усі кошики однією таблицею — назва кошика й пояснення, далі категорії; клік — рядки таблиці. */
export function Outside({ buckets }: { buckets: Bucket[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const live = buckets.filter((b) => b.pots.length);
  if (!live.length) return <div className="hr-sect hr-muted" style={{ fontSize: 12.5 }}>Усе з таблиці оплат за цей місяць потрапило у статті.</div>;
  return (
    <div className="hr-sect">
      <h4>Не потрапило у статті</h4>
      <div className="hr-tw">
        <table className="hr-table fin-table">
          <thead><tr><th>Категорія з таблиці оплат</th><th className="num">Сума</th><th className="num">Рядків</th><th /></tr></thead>
          <tbody>{live.map((b) => (
            <Fragment key={b.title}>
              <tr className="grp"><td colSpan={4} className="ind1">{b.title} · {money(r2(b.pots.reduce((s, p) => s + p.sum, 0)))} ₴
                <div style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400, fontSize: 12 }}>{b.hint}</div></td></tr>
              {b.pots.map((p) => {
                const k = `${b.title}:${p.key}`;
                return (
                  <Fragment key={k}>
                    <tr className={`it ${open === k ? "sel" : ""}`} onClick={() => setOpen(open === k ? null : k)}>
                      <td className="ind2"><span style={{ display: "inline-block", width: 16 }}>{open === k ? "▾" : "▸"}</span>{p.label}</td>
                      <td className="num">{money(p.sum)}</td><td className="num">{p.rows}</td>
                      <td>{p.unpaid ? <span className="hr-pill wn">не оплачено: {p.unpaid}</span> : null}</td>
                    </tr>
                    {open === k && <tr><td colSpan={4} className="ind2"><Lines lines={p.lines} /></td></tr>}
                  </Fragment>
                );
              })}
            </Fragment>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

/** Кошики «Не потрапило у статті» — один перелік для тестової вкладки й «План/факт витрат». */
export const outsideBuckets = (o: FinApprOutside): Bucket[] => [
  { title: "ЗП за назвою", hint: "Статей для ЗП немає — розділ береться з назви категорії. В операційні йдуть, у «План/факт» — ні.", pots: o.payroll },
  { title: "Лише для статистики", hint: "Категорія йде в операційні у свій розділ (Консалтинг СЕО → Комерційні), у «План/факт» — ні (Тетяна 21.10).", pots: o.statsOnly },
  { title: "Не розпізнано", hint: "Категорії немає серед статей — ні в «План/факт», ні в операційні не йде (Дивіденди — так і задумано, для інформації).", pots: o.unrecognized },
  { title: "Кілька статей з однією назвою", hint: "Категорія збігається з двома статтями — не вгадуємо, куди. Перейменуйте одну зі статей.", pots: o.ambiguous },
  { title: "Не UA", hint: "Напрямок не UA — у факт не йде (Тетяна 13.10: «беремо лише UA»).", pots: o.notUa },
  { title: "Сума не число", hint: "Сума в таблиці не читається як число — у факт не йде.", pots: o.badSum },
  { title: "Дата оплати не дата", hint: "У «Даті оплати» не дата (показано в місяці внесення) — у факт не йде.", pots: o.badPayDate },
  { title: "Ще без дати оплати", hint: "Внесено цього місяця, дати оплати ще немає — у факт піде, щойно її поставлять.", pots: o.noPayDate },
];
