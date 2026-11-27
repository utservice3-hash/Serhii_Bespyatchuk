// Замір 27.11.2026 (задача 10723): ставки тімлідів і ЗП за листопад — як зараз і за новою схемою
// (ставка + % власних угод за рівнем + 3/6 % команди). ЛИШЕ ЧИТАННЯ: сесія read-only, перевіряється до розрахунку.
// Запуск на сервері з backend/: node /tmp/lp.mjs
import { pathToFileURL } from "node:url";
process.env.PGOPTIONS = `${process.env.PGOPTIONS ?? ""} -c default_transaction_read_only=on`.trim();
const imp = (p) => import(pathToFileURL(`${process.cwd()}/dist/${p}`).href);
const { pool } = await imp("db/pool.js");
const ro = (await pool.query("SHOW default_transaction_read_only")).rows[0].default_transaction_read_only;
if (ro !== "on") { console.error("СТОП: сесія не read-only"); process.exit(1); }
const { engine } = await imp("payroll/service.js");
const e = await engine(pool, { fresh: true });
const zp = e.zp, S = zp.settings, mk = zp.liveMonth;
const r0 = (x) => Math.round(Number(x) || 0);
console.log(`місяць ${mk}, зараз ${zp.now}; Старт ${S.start.pctLow}%, Профі ${S.profi.pct1}/${S.profi.pct2}% (поріг ${S.profi.threshold}), команда ${S.lead.pctLow}/${S.lead.pctHigh}%`);
for (const p of zp.employees.filter((x) => x.role === "lead" && zp.employedIn(x, mk))) {
  const c = zp.calc(p, mk), L = zp.advanceLimit(p, mk);
  const own = L.basis === "ownMargin" ? L.base : null, lv = zp.levelOf(p, mk) || "start";
  const ownPct = own === null ? null : lv === "profi" ? (own >= S.profi.threshold ? S.profi.pct2 : S.profi.pct1) : S.start.pctLow;
  const ownAmt = own === null ? null : own * ownPct / 100;
  console.log([p.name, `ставка ${r0(zp.rateOf(p, mk))} (за дні ${r0(c.now.rate)})`, `рівень ${zp.levelOf(p, mk) ?? "не вказано → Старт"}`,
    `команда: маржа ${r0(c.margin)} / план ${r0(c.plan)} → ${c.now.pct}% = ${r0(c.now.pctAmount)}`,
    `власна маржа ${own === null ? "?" : r0(own)} → ${ownPct ?? "?"}% = ${ownAmt === null ? "?" : r0(ownAmt)}`,
    `ЗАРАЗ ${r0(c.now.total)} → НОВА ${ownAmt === null ? "?" : r0(c.now.total + ownAmt)}`].join(" | "));
}
await pool.end();
