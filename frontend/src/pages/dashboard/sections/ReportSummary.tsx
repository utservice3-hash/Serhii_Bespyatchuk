import type { ReportPlan, ReportPlanManager, ReportPlanDismissed } from "../../../api";
import { InfoHint } from "../widgets";
import {
  GREEN, AMBER, RED, MUTED, INK, SOFT, LINE,
  fmt, kk, ddmm, PaceBar, pctOfNeeded, HINTS,
} from "./ReportBands";

/**
 * 📋 ВЕРХНІЙ ПІДСУМОК ЗВІТУ + РОЗРІЗ ПО КОМАНДАХ (макет `zvit-2`, 06.08.2026).
 *
 * 🔴 ГОЛОВНЕ ПРАВИЛО ЦЬОГО ЕКРАНА: сортування таблиці — ЗА ВІДХИЛЕННЯМ ВІД ТЕМПУ,
 * а не за сумою. Питання тімліда — «хто не встигає», а не «хто більший»; сортування
 * за грішми ставить угорі найбільшу команду, навіть коли в неї все гаразд.
 */

const teamOf = (m: ReportPlanManager): string => m.teamName ?? "Поза командами";

export interface TeamAgg {
  key: string; name: string; managers: ReportPlanManager[];
  /** Звільнені цієї команди — згорнутим рядком; їхні гроші вже в сумах нижче. */
  dismissed: ReportPlanDismissed[];
  plan: number; fact: number; factSuccess: number; factPaid: number;
  expectThisMonth: number; dobir: number; byPace: number;
  /** Скільки з `fact` прийшло від менеджерів без плану (+ звільнених). Може бути 0. */
  factNoPlan: number;
  collectedNotClosed: number; r: number; a: number; g: number;
}

export function aggregateTeams(managers: ReportPlanManager[], dismissed: ReportPlanDismissed[] = []): TeamAgg[] {
  const map = new Map<string, TeamAgg>();
  for (const m of managers) {
    const key = teamOf(m);
    let e = map.get(key);
    if (!e) {
      e = { key, name: key, managers: [], dismissed: [], plan: 0, fact: 0, factSuccess: 0, factPaid: 0,
        expectThisMonth: 0, dobir: 0, byPace: 0, factNoPlan: 0, collectedNotClosed: 0, r: 0, a: 0, g: 0 };
      map.set(key, e);
    }
    e.managers.push(m);
    // Менеджер без плану: його гроші в чисельнику, знаменника він не додав.
    if (m.plan <= 0) e.factNoPlan += m.fact;
    e.plan += m.plan; e.fact += m.fact; e.factSuccess += m.factSuccess; e.factPaid += m.factPaid;
    e.expectThisMonth += m.expectThisMonth; e.dobir += m.dobir; e.byPace += m.byPace;
    // 🔴 «Гроші є · не закрито» лічиться ОКРЕМО і НЕ входить у r/a/g — інакше
    // «зрив» і далі означав би дві різні речі, а саме це ми й розчіпляли.
    if (m.factSuccess === 0 && m.factPaid > 0) e.collectedNotClosed++;
    else if (m.status === "r") e.r++; else if (m.status === "a") e.a++; else e.g++;
  }
  // 🔴 Звільнені додаються В ТУ САМУ команду і в ТІ САМІ грошові суми, але НЕ в
  // лічильники станів: світлофор на людині, якої немає, читався б як докір нікому.
  // Якщо команди звільненого вже немає в мапі (усі її активні пішли) — заводимо
  // рядок, інакше його гроші зникли б разом із командою.
  for (const d of dismissed) {
    const key = d.teamName ?? "Поза командами";
    let e = map.get(key);
    if (!e) {
      e = { key, name: key, managers: [], dismissed: [], plan: 0, fact: 0, factSuccess: 0, factPaid: 0,
        expectThisMonth: 0, dobir: 0, byPace: 0, factNoPlan: 0, collectedNotClosed: 0, r: 0, a: 0, g: 0 };
      map.set(key, e);
    }
    e.dismissed.push(d);
    e.fact += d.fact; e.factSuccess += d.factSuccess; e.factPaid += d.factPaid;
    // Звільнені теж без плану за побудовою — спотворюють відсоток так само.
    e.factNoPlan += d.fact;
  }
  return [...map.values()];
}

function Chip({ n, label, color, bg }: { n: number; label: string; color: string; bg: string }) {
  if (!n) return null;
  return (
    <span style={{ fontSize: 10.5, fontWeight: 700, color, background: bg, borderRadius: 4, padding: "2px 7px", whiteSpace: "nowrap" }}>
      {n} {label}
    </span>
  );
}

/**
 * Плитка «виконано» — і для тижня, і для місяця. `neededPct` обовʼязковий в ОБОХ:
 * це єдина величина, яку можна порівнювати між періодами різної довжини.
 */
function DoneTile({ title, fact, plan, markPct, markLabel, hint, footer }: {
  title: string; fact: number; plan: number; markPct: number; markLabel: string; hint: string; footer: string;
}) {
  const pct = plan > 0 ? (fact / plan) * 100 : 0;
  const dev = pct - markPct;
  const color = plan <= 0 ? MUTED : dev >= 0 ? GREEN : dev >= -10 ? AMBER : RED;
  const need = pctOfNeeded(fact, plan, markPct);
  return (
    <div className="rpt-card" style={{ padding: "16px 18px" }}>
      <div className="rpt-lab">{title} <InfoHint text={hint} /></div>
      <div style={{ fontWeight: 800, fontSize: 26, letterSpacing: "-.5px", color, marginTop: 4 }}>
        {plan > 0 ? pct.toFixed(1) : "—"}<span style={{ fontSize: 14, color: MUTED, fontWeight: 600 }}> % · {fmt(fact)} / {fmt(plan)} ₴</span>
      </div>
      <PaceBar pct={pct} markPct={markPct} color={color} />
      <div style={{ fontSize: 11, color: MUTED }}>{markLabel}</div>
      <div style={{ marginTop: 8, fontSize: 12.5, color, fontWeight: 700 }}>
        {plan > 0 ? `${dev >= 0 ? "+" : ""}${dev.toFixed(1)} п.п.` : "плану немає"}
        {need != null && (
          <span style={{ color: INK, fontWeight: 600 }}>
            {" "}· це <b>{need}%</b> від необхідного на сьогодні
          </span>
        )}
      </div>
      <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>{footer}</div>
    </div>
  );
}

export function ReportSummary({ data, weekLabel, onPickTeam, pickedTeam }: {
  data: ReportPlan;
  weekLabel: string;
  onPickTeam: (key: string | null) => void;
  pickedTeam: string | null;
}) {
  const g = data.glance;
  const wdT = data.scope.workingDaysTotal, wdE = data.scope.workingDaysElapsed;
  const monthMark = wdT > 0 ? (wdE / wdT) * 100 : 0;

  // Тиждень: факт і план — Σ по менеджерах (той самий вираз, що в рядку), мітка —
  // частка робочих днів тижня, що минули. Беремо її з `workingDaysWeek` ядра, а не
  // рахуємо на фронті: другий календар — це друга правда.
  const weekFact = data.managers.reduce((s, m) => s + m.week.fact, 0);
  const weekPlan = data.managers.reduce((s, m) => s + m.week.target, 0);
  const wdWeek = Math.max(...data.managers.map((m) => m.week.workingDaysWeek), 0);
  const wdWeekElapsed = (() => {
    const wf = data.managers.find((m) => m.week.weekFrom)?.week.weekFrom;
    if (!wf || !wdWeek) return 0;
    // Скільки робочих днів тижня вже минуло — рахуємо від дати початку тижня до «сьогодні».
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
    let n = 0; const d = new Date(wf + "T00:00:00Z");
    while (d.toISOString().slice(0, 10) <= today) {
      const dw = d.getUTCDay(); if (dw !== 0 && dw !== 6) n++;
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return Math.min(n, wdWeek);
  })();
  const weekMark = wdWeek > 0 ? (wdWeekElapsed / wdWeek) * 100 : 0;
  const reconstructed = data.managers.some((m) => m.week.reconstructed);

  const teams = aggregateTeams(data.managers, data.dismissed ?? [])
    // 🔴 СОРТУВАННЯ ЗА ВІДХИЛЕННЯМ ВІД ТЕМПУ, не за сумою: екран існує, щоб бачити,
    // хто не встигає. Команда без плану % не має, тож іде ПІСЛЯ тих, у кого план є —
    // інакше «найгірші» очолили б ті, кому плану просто не поставили.
    .map((t) => ({ t, dev: t.plan > 0 ? (t.fact / t.plan) * 100 - monthMark : Number.POSITIVE_INFINITY }))
    .sort((x, y) => x.dev - y.dev)
    .map((x) => x.t);

  const needPerDay = data.remainingWorkdays > 0 ? Math.max(0, Math.round((g.plan - g.fact) / data.remainingWorkdays)) : 0;

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: 14, marginBottom: 16 }}>
        <DoneTile
          title={`Виконано · тиждень ${weekLabel}`} fact={weekFact} plan={weekPlan}
          markPct={weekMark} markLabel={`мало б бути ${weekMark.toFixed(0)}% · минуло ${wdWeekElapsed} з ${wdWeek} роб. днів`}
          hint={HINTS.week + (reconstructed ? " ⚠️ За частину минулих тижнів знімок ВІДНОВЛЕНО ретроспективно, а не збережено в момент." : "")}
          footer="динамічний план: залишок місяця ÷ робочі дні, що лишились"
        />
        <DoneTile
          title="Виконано · місяць" fact={g.fact} plan={g.plan}
          markPct={monthMark} markLabel={`мало б бути ${monthMark.toFixed(0)}% · минуло ${wdE} з ${wdT} роб. днів`}
          hint={HINTS.month}
          footer={`треба ${fmt(needPerDay)} ₴/день на ${data.remainingWorkdays} роб. днів`}
        />
        <div className="rpt-card" style={{ padding: "16px 18px" }}>
          <div className="rpt-lab">Гроші, що вже надійшли <InfoHint text={HINTS.fact} /></div>
          <div style={{ fontWeight: 800, fontSize: 26, letterSpacing: "-.5px", marginTop: 4 }}>{fmt(g.fact)} <span style={{ fontSize: 14, color: MUTED }}>₴</span></div>
          <div style={{ display: "flex", gap: 16, marginTop: 12, flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: 10, color: MUTED, fontWeight: 700, textTransform: "uppercase" }}>закрито ① <InfoHint text={HINTS.closed} /></div>
              <div style={{ fontWeight: 700, color: GREEN }}>{fmt(g.factSuccess)}</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: MUTED, fontWeight: 700, textTransform: "uppercase" }}>прийшло ⑨ <InfoHint text={HINTS.paid} /></div>
              <div style={{ fontWeight: 700, color: "var(--rpt-link)" }}>{fmt(g.factPaid)}</div>
            </div>
          </div>
          <div style={{ fontSize: 11, color: MUTED, marginTop: 8 }}>
            В оцінку роботи менеджера йде лише «закрито ①». Решта — гроші на рахунку за незакритими угодами.
          </div>
        </div>
        <div className="rpt-card" style={{ padding: "16px 18px" }}>
          <div className="rpt-lab">Ще не надійшли <InfoHint text={HINTS.withInvoices} /></div>
          <div style={{ fontWeight: 800, fontSize: 26, letterSpacing: "-.5px", marginTop: 4 }}>{fmt(g.fact + g.expectThisMonth)} <span style={{ fontSize: 14, color: MUTED }}>₴ з рахунками</span></div>
          <div style={{ display: "flex", gap: 16, marginTop: 12, flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: 10, color: MUTED, fontWeight: 700, textTransform: "uppercase" }}>чекаємо цей міс</div>
              <div style={{ fontWeight: 700, color: AMBER }}>{fmt(g.expectThisMonth)}</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: MUTED, fontWeight: 700, textTransform: "uppercase" }}>зазвичай добирає <InfoHint text={HINTS.dobir} /></div>
              <div style={{ fontWeight: 700, color: MUTED }}>{fmt(g.dobir)}</div>
            </div>
          </div>
          <div style={{ fontSize: 11, color: MUTED, marginTop: 8 }}>
            «Добір» у прогноз НЕ входить — це середнє за 3 міс., а не угоди й не документи.
          </div>
        </div>
        <div className="rpt-card" style={{ padding: "16px 18px" }}>
          <div className="rpt-lab">Люди · {data.managers.length} менеджер(ів)</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
            <Chip n={g.collectedNotClosed} label="гроші є · не закрито" color="var(--rpt-link)" bg="var(--rpt-soft)" />
            <Chip n={g.statusCounts.r} label="зрив" color={RED} bg="var(--rpt-bad-bg)" />
            <Chip n={g.statusCounts.a} label="відстає" color={AMBER} bg="var(--rpt-warn-bg)" />
            <Chip n={g.statusCounts.g} label="у нормі" color={GREEN} bg="var(--rpt-ok-bg)" />
          </div>
          <div style={{ fontSize: 11, color: MUTED, marginTop: 10 }}>
            {g.collectedNotClosed > 0
              ? <>{g.collectedNotClosed} менеджер(ів) зібрали гроші, але не перевели жодної угоди в «успішно реалізовано» — раніше вони читались як «зрив». Це не відставання, це незакриті угоди.</>
              : <>Стан «гроші є · не закрито» порожній: у всіх, хто зібрав гроші, є й закриті угоди.</>}
          </div>
        </div>
      </div>

      <div className="rpt-card" style={{ padding: "16px 18px", marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
          <div className="rpt-lab">Підсумок по командах <span style={{ color: MUTED, textTransform: "none", fontWeight: 500 }}>Σ команд = компанія · клік на команду → менеджери</span></div>
          <div style={{ fontSize: 11, color: MUTED }}>сортування: за відхиленням від темпу</div>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table className="data-table" style={{ fontSize: 12.5, minWidth: 820 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Команда</th>
                <th style={{ textAlign: "right" }}>План місяця</th>
                <th style={{ textAlign: "right" }}>Факт ②</th>
                <th style={{ textAlign: "right" }}>Виконано · темп <InfoHint text={HINTS.teamPct} /></th>
                <th style={{ textAlign: "right" }}>З рахунками</th>
                <th style={{ textAlign: "right" }}>За темпом</th>
                <th style={{ textAlign: "right" }}>Зазвичай добирає</th>
              </tr>
            </thead>
            <tbody>
              {teams.map((t) => {
                const pct = t.plan > 0 ? (t.fact / t.plan) * 100 : 0;
                const dev = pct - monthMark;
                const color = t.plan <= 0 ? MUTED : dev >= 0 ? GREEN : dev >= -10 ? AMBER : RED;
                return (
                  <tr key={t.key} onClick={() => onPickTeam(pickedTeam === t.key ? null : t.key)}
                    style={{ cursor: "pointer", background: pickedTeam === t.key ? SOFT : undefined }}>
                    <td>
                      <div style={{ fontWeight: 700 }}>{t.name}</div>
                      <div style={{ fontSize: 10.5, color: MUTED }}>
                        {t.managers.length} менеджер(ів)
                        {t.dismissed.length > 0 && (
                          <span title={"Звільнені з грішми в цьому періоді. План, відсоток, світлофор і темп їм НЕ рахуються — "
                            + "ставити план людині, якої немає, безглуздо. Але гроші (① і ⑨) входять у суму команди й компанії: "
                            + "вони зароблені тоді, коли людина працювала, і від звільнення не зникають.\n"
                            + t.dismissed.map((d) => `${d.name}: ${fmt(d.fact)} ₴ (${d.factPaidDeals} угод на «оплата отримана»)`).join("\n")}>
                            {" · "}<b style={{ color: MUTED }}>звільнені · {t.dismissed.length}</b>
                            {" "}<span style={{ color: MUTED }}>({fmt(t.dismissed.reduce((s2, d) => s2 + d.fact, 0))} ₴)</span>
                          </span>
                        )}
                      </div>
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 3 }}>
                        <Chip n={t.collectedNotClosed} label="гроші є" color="var(--rpt-link)" bg={SOFT} />
                        <Chip n={t.r} label="зрив" color={RED} bg="var(--rpt-bad-bg)" />
                        <Chip n={t.a} label="відстає" color={AMBER} bg="var(--rpt-warn-bg)" />
                        <Chip n={t.g} label="норма" color={GREEN} bg="var(--rpt-ok-bg)" />
                      </div>
                    </td>
                    <td style={{ textAlign: "right" }}>{fmt(t.plan)}</td>
                    <td style={{ textAlign: "right" }}>
                      <div style={{ fontWeight: 700 }}>{fmt(t.fact)}</div>
                      <div style={{ fontSize: 10.5, color: MUTED }}>{fmt(t.factSuccess)} + {fmt(t.factPaid)}</div>
                      {/* 🔴 ПОКАЗУЄМО ЛИШЕ КОЛИ ≠ 0 (рішення власника): у чотирьох із
                          пʼяти команд тут нуль, і підпис у кожному рядку перетворив би
                          сигнал на шум. */}
                      {t.factNoPlan !== 0 && (
                        <div style={{ fontSize: 10.5, color: AMBER }}
                          title="Гроші менеджерів, яким не виставлено місячного плану (і звільнених — у них плану немає за побудовою). План команди = Σ планів її менеджерів, тож ця сума піднімає відсоток, не піднявши знаменник.">
                          у т.ч. {fmt(t.factNoPlan)} ₴ від менеджерів без плану
                        </div>
                      )}
                    </td>
                    <td style={{ textAlign: "right", minWidth: 150 }}>
                      <div style={{ fontWeight: 700, color }}>{t.plan > 0 ? `${pct.toFixed(1)}%` : "—"}</div>
                      <PaceBar pct={pct} markPct={monthMark} color={color} />
                      <div style={{ fontSize: 10, color, fontWeight: 700 }}>
                        {t.plan > 0 ? `${dev >= 0 ? "+" : ""}${dev.toFixed(1)} п.п. від темпу` : "плану немає"}
                      </div>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <div style={{ fontWeight: 700 }}>{fmt(t.fact + t.expectThisMonth)}</div>
                      <div style={{ fontSize: 10.5, color: MUTED }}>+{fmt(t.expectThisMonth)} рахунків</div>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <div>{fmt(t.byPace)}</div>
                      <div style={{ fontSize: 10.5, color: MUTED }}>{t.plan > 0 ? `${Math.round((t.byPace / t.plan) * 100)}% плану` : "—"}</div>
                    </td>
                    <td style={{ textAlign: "right", color: MUTED }}>{fmt(t.dobir)}</td>
                  </tr>
                );
              })}
              <tr style={{ borderTop: `2px solid ${LINE}`, fontWeight: 800 }}>
                <td>КОМПАНІЯ</td>
                <td style={{ textAlign: "right" }}>{fmt(g.plan)}</td>
                <td style={{ textAlign: "right" }}>{fmt(g.fact)}</td>
                <td style={{ textAlign: "right" }}>{g.plan > 0 ? `${((g.fact / g.plan) * 100).toFixed(1)}%` : "—"}</td>
                <td style={{ textAlign: "right" }}>{fmt(g.fact + g.expectThisMonth)}</td>
                <td style={{ textAlign: "right" }}>{fmt(g.byPace)}</td>
                <td style={{ textAlign: "right" }}>{fmt(g.dobir)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {g.jam > 0 && (
        <div className="rpt-card" style={{ padding: "14px 18px", marginBottom: 16, borderLeft: `3px solid ${AMBER}` }}>
          <div className="rpt-lab" style={{ color: AMBER }}>Затор на стадії «Виставлення рахунку»</div>
          <div style={{ fontSize: 12.5, color: INK, marginTop: 6 }}>
            З <b>{fmt(g.expectThisMonth)} ₴</b> очікувань <b>{fmt(g.jam)} ₴</b>
            {g.expectThisMonth > 0 && <> ({Math.round((g.jam / g.expectThisMonth) * 100)}%)</>} сидять на стадії
            виставлення рахунку — <b>{g.jamDeals}</b> угод. Гроші реальні, але поки рахунок не виставлений,
            дата оплати — <b>намір, а не домовленість</b>.
            {g.expectNoDate > 0 && <> Окремо <b>{fmt(g.expectNoDate)} ₴</b> взагалі без планової дати — у жодну суму не входять. <InfoHint text={HINTS.noDate} /></>}
          </div>
        </div>
      )}
    </>
  );
}

export { ddmm, kk };
