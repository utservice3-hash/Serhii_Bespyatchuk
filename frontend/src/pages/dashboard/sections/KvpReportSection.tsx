import { Fragment, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { fetchKvpReport, fetchKvpPlan, saveKvpPlan, fetchManagerDetail, type KvpReport, type KvpPlans, type KvpTeam, type KvpManager, type KvpManagerDetail, type KvpWeek, type CreatedSplit } from "../../../api";
import { formatAmount, formatAmountFull } from "../format";
import { DatePicker } from "../../../components/DatePicker";
import { InfoHint } from "../widgets";
import { LeadgenRegularsCard } from "./LeadgenRegularsCard";

// ── Статус-палітра (зарезервована, НЕ дата-серія): good/warning/serious/critical ──
const GREEN = "#16a34a", AMBER = "#d97706", RED = "#dc2626", BLUE = "#2563eb", MUTED = "var(--text-muted)";
const pctColor = (p: number | null) => (p == null ? MUTED : p >= 100 ? GREEN : p >= 85 ? BLUE : p >= 70 ? AMBER : RED);
const sevColor: Record<string, string> = { critical: RED, serious: RED, warning: AMBER, info: BLUE };
const fmtMoney = (v: number) => formatAmount(v);
const fmtFull = (v: number) => formatAmountFull(v);
const fmtNum = (v: number | null) => (v == null ? "—" : Number(v).toLocaleString("uk-UA"));
const fmtPct = (v: number | null) => (v == null ? "—" : `${v}%`);

/** ⓘ на кожній метриці: що рахує / якір / включено / чому. */
const HINT: Record<string, string> = {
  received: "«Отримані кошти» = угоди, що ввійшли в етап 9 (Оплата отримана) АБО 10 (Успішна) у періоді, РАЗ (дедуп). Ядро core/money.ts.",
  strategic: "🔒 Стратегічний план виручки = Σ планів менеджерів (plans.payment_amount). Read-only — редагується у грід-редакторі планів, не тут.",
  planBar: "Смуга заповнюється ДВІЧІ: щільний сегмент — факт (отримані кошти), світліший — "
    + "очікування з ПЛАНОВОЮ ДАТОЮ оплати цього місяця. Разом = прогноз, тобто смуга показує те "
    + "саме, що число прогнозу поруч. Ширина обрізається на 100%, а відсоток у підписі — НІ: "
    + "перевищення видно числом. Добір нового бізнесу сюди не входить — він не підкріплений "
    + "документами і показаний окремо.",
  projection: "Прогноз місяця = факт ② + очікування з ПЛАНОВОЮ ДАТОЮ ОПЛАТИ в цьому ж місяці — "
    + "ТА САМА формула, що на картці менеджера у Звіті (рішення власника 06.08.2026). "
    + "Добір нового бізнесу в прогноз НЕ входить і показаний окремо: він не підкріплений "
    + "документами (це середнє за 3 місяці, а не угоди з датою). Завершений місяць нічого не "
    + "очікує — там прогноз дорівнює факту.",
  pace: "Темп = факт ÷ минулі робочі дні × усі робочі дні місяця. Це ІНШЕ питання, ніж прогноз: "
    + "прогноз каже «що вже домовлено» (є рахунок і планова дата), темп — «що вийде, якщо нічого "
    + "не зміниться». Розрив між ними і є те, заради чого сюди дивляться. «Зазвичай добирає» — "
    + "середнє за 3 місяці по відділу, розкладене часткою; це НЕ угоди й у жодну суму не входить.",
  lifecycle: "Життєвий цикл грошей: Відправлено (авто поїхало, дата загрузки load_at) → Очікуємо (зона виставлено→оплата, знімок) → Отримано (кошти в періоді). Три РІЗНІ якорі — "
    + "і середня плитка до того ж НЕ ЗВУЖУЄТЬСЯ ПЕРІОДОМ: крайні дві міняються від вибраного періоду, «Очікуємо» — ні. "
    + "Тому читати їх як три кроки одного потоку не можна: це не «з відправленого стільки чекає оплати».",
  sent: "Відправлено = угоди з проставленою «Датою загрузки» (load_at) у періоді. Фактичне відправлення авто, окремо від дати грошей.",
  // 🔴 ПІДПИС ПЕРЕПИСАНО 01.09.2026. Тут стояло «знімок «зараз»» — і це правда, але
  // НЕ та, якої бракувало: сусідні дві плитки в тому самому рядку звужуються ПЕРІОДОМ,
  // а ця — ні, і жодне слово на екрані цього не казало. Той самий клас, що два «очікуємо»
  // у Звіті: підпис правдивий, але поставлений не до тієї властивості.
  awaiting: "Очікуємо = УСЯ зона визнання доходу (виставлено рахунок→оплата), знімок «станом на зараз». "
    + "🔴 ПЕРІОД НА НЕЇ НЕ ДІЄ: це не «очікуємо за вибраний період», а вся зона цілком — туди входять і "
    + "прострочені домовленості, і наступний місяць, і угоди зовсім без планової дати. Тому число не "
    + "змінюється від перемикача періоду, і в жодну виручку періоду воно НЕ входить. "
    + "Очікування, ЗВУЖЕНЕ плановою датою цього місяця, — інша величина: воно в колонці «Очікуємо» команд "
    + "і в прогнозі. Два різні «очікуємо» — тому кожне підписане своїм.",
  teamPlan: "План команди = Σ планів її менеджерів (plans). Факт = отримані кошти команди. Σ команд = відділ (інваріант).",
  conversion: "Конверсія = вхідна когорта періоду → дійшли до грошей (MONEY_ZONE) у Повному циклі. Стеля ≤100%. Поточний місяць ⏳ (когорта <90 днів).",
  romi: "ROMI = дохід з реклами (отримані кошти каналу) ÷ рекламний бюджет × 100%.",
  cpa: "CPA = бюджет ÷ рекламні угоди, що дійшли до грошей (MONEY_ZONE). Поточний період ⏳ (незріла когорта).",
  cplGa: "CPL(GA) = бюджет ÷ заявки Google Ads (конверсії з таблиці).",
  cplCrm: "CPL(CRM) = бюджет ÷ рекламні ліди у зоні «взято в роботу».",
  transferred: "Передані заявки = «Реєстр» лідоген-бота (transferred_at). Дедуп по клієнту.",
  lgDispatched: "Поїхали (лідоген) = лідоген-угоди з «Датою загрузки» (load_at) у періоді.",
  lgRevenue: "Дохід лідогену = отримані кошти каналу «лідоген» (дата отримання коштів).",
  newToRepeat: "% нових→постійних = із когорти клієнтів, чия перша оплата в місяці M, скільки стали постійними (≥2 оплати lifetime). Зрілість 90 днів → свіжі місяці ⏳.",
  activeBase: "Активність бази = DISTINCT клієнтів з оплатою в місяці. «Замовили цей місяць».",
  weeklyRegulars: "Постійні щотижня = клієнти з оплатами у ≥4 з останніх 8 тижнів (евристика).",
  nonTarget: "Нецільові = рекламні ліди з причиною відмови «Дубль»/«Перевізник». Місяці до горизонту синку reject_reason → «—» (немає даних, не «0»).",
  receivablesPaidOff: "Історії погашень у базі НЕМАЄ, і це не «нуль погашень». `receivables` і "
    + "`receivable_invoices` — знімки: щосинку TRUNCATE+insert, тобто зберігається лише стан «зараз», "
    + "без подій. `receivable_notes` тримає ОБІЦЯНУ дату (due_date), а не факт оплати. Щоб показник "
    + "зʼявився, потрібна щоденна знімкова джоба (падіння боргу клієнта = погашення) — окрема задача. "
    + "Доти тут написано, що ми не знаємо, а не «—»: порожнє місце читається як нуль.",
  unattributed: "Угоди БЕЗ `client_key` — немає по чому віднести до нового/постійного. Показано ЯВНО, "
    + "не сховано, і входять у Σ (інваріант «нові + постійні + залишок == каса» тримається точно). "
    + "СУМА БУВАЄ ВІДʼЄМНОЮ, і це не помилка: сюди потрапляють мінусові угоди (сторно/повернення), "
    + "а ядро їх нетить — рівно як задумано. Дивитись треба на кількість угод поруч, а не лише на суму.",
  newRepeat: "Нові/постійні (client-grain лінз): клієнт з першою оплатою в періоді = новий. ОКРЕМО від team-based РПК/РНК (то ознака команди). Кожен клієнт → primary-менеджер, Σ = відділ.",
  // 🔴 ПІДПИС ПЕРЕПИСАНО 18.08.2026 РАЗОМ ІЗ ПРАВИЛОМ. Тут стояв дослівний опис
  // старої логіки («B=канал угоди: реклама/лідоген → новий»), і лишити його означало
  // б лишити на екрані підпис, який описує вже неіснуюче правило. Тримає гейт `#67e`.
  createdSplit: "Створено: НОВИЗНА клієнта і ДЖЕРЕЛО угоди — різні виміри. Новизна: якщо клієнта можна впізнати за ключем — вирішує його історія в повному циклі (вигравав або заходив у зону визнання ДО створення цієї угоди → постійний, інакше новий); ключа немає — фолбек на поле «Канал продажу»; немає й його → невизначено. Джерело (реклама/лідоген) новизну НЕ визначає: угода з реклами від клієнта, який уже возив, — це постійний клієнт із рекламним джерелом. Створено = Нові + Постійні (+ Невизн, показано лише коли >0); реклама/лідоген — підмножини, у суму не додаються.",
  structReceived: "«Отримано» = ТА САМА каса, що у вердикті (receivedMoney: 142⊎оплата, дедуп), розкладена по сегменту клієнта. Σ(нові+постійні+залишок) звіряється з загальним received.",
  structExpected: "«В очікуванні» = зона визнання доходу (виставлено→оплата, EXPECT_ZONE), знімок «зараз», по сегменту клієнта. Σ = загальна зона очікування.",
  avgCheck: "Середній чек = виручка успішних угод ÷ к-ть успішних угод менеджера.",
  expected: "Очікування менеджера = його угоди в зоні виставлено→оплата (знімок).",
};

const teamKindLabel: Record<string, string> = { rpk: "РПК · повний цикл", rnk: "РНК · реклама", leadgen: "Лідогенерація" };

// Блок B — секція «Логістика». Чесні мітки: ✓ пряме джерело · ~ проксі/наближення · ✗ нема даних.
// ⓘ у ТІЙ САМІЙ позиції, що в решті звіту (поряд із заголовком, у flex-лейблі) — тултіп працює.
const MK: Record<string, { c: string; ch: string }> = { ok: { c: GREEN, ch: "✓" }, proxy: { c: AMBER, ch: "~" }, none: { c: RED, ch: "✗" } };
function LogiCard({ title, kind, hint, children }: { title: string; kind: "ok" | "proxy" | "none"; hint: string; children: ReactNode }) {
  return (
    <div style={{ padding: 12, background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 8 }}>
        <b style={{ fontSize: 13 }}>{title}</b>
        <span style={{ color: MK[kind].c, fontWeight: 700, fontSize: 12 }} title={MK[kind].ch === "✓" ? "пряме джерело" : MK[kind].ch === "~" ? "проксі/наближення" : "нема даних"}>{MK[kind].ch}</span>
        <InfoHint text={hint} />
      </div>
      {children}
    </div>
  );
}
function ShareBar({ pct, color }: { pct: number; color: string }) {
  return <div style={{ height: 6, background: "var(--border)", borderRadius: 3, overflow: "hidden", marginTop: 3 }}><div style={{ width: `${Math.min(100, pct)}%`, height: "100%", background: color, borderRadius: 3 }} /></div>;
}
function LogisticsSection({ rep }: { rep: KvpReport }) {
  const L = rep.logistics;
  const totalDir = L.direction.reduce((a, d) => a + d.revenue, 0) || 1;
  const totalChan = L.salesChannel.reduce((a, c) => a + c.revenue, 0) || 1;
  const agingDebt = L.aging.buckets.reduce((a, b) => a + b.sum, 0);
  const agingCnt = L.aging.buckets.reduce((a, b) => a + b.count, 0);
  const tile = (label: string, val: string, sub: string) => (
    <div style={{ padding: "8px 10px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, textAlign: "center" }}>
      <div style={{ fontSize: 11, color: MUTED }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700 }}>{val}</div>
      <div style={{ fontSize: 10, color: MUTED }}>{sub}</div>
    </div>
  );
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 12 }}>
      {/* Напрямок — КАРТКИ з барами частки */}
      <LogiCard title="🧭 Напрямок (Тип запиту)" kind={L.fillRates.requestType >= 90 ? "ok" : "proxy"}
        hint={`Розклад отриманої виручки за «Тип запиту» (напрямок). Σ по напрямках == отримано. Fill-rate поля: ${L.fillRates.requestType}%. Конверсія = ad-new когорта (вхід→гроші) цього напрямку; ⏳ якщо <10 у зоні.`}>
        <div style={{ display: "grid", gap: 8 }}>
          {L.direction.map((d) => { const share = Math.round(d.revenue / totalDir * 100); return (
            <div key={d.key}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}><b style={{ ...clip }}>{d.key}</b><span style={{ fontWeight: 700 }}>{fmtMoney(d.revenue)}</span></div>
              <div style={{ fontSize: 10, color: MUTED }}>{fmtNum(d.deals)} авто · чек {d.deals > 0 ? fmtFull(Math.round(d.revenue / d.deals)) : "—"} · конв. {d.conversion == null ? "⏳" : `${d.conversion}%`} · {share}%</div>
              <ShareBar pct={share} color={BLUE} />
            </div>
          ); })}
        </div>
      </LogiCard>

      {/* Канал продажу — рядки з барами, Тендерний виділено */}
      <LogiCard title="🏷 Канал продажу" kind={L.fillRates.salesChannel >= 90 ? "ok" : "proxy"}
        hint={`Розклад отриманої виручки за «Канал продажу». Σ == отримано. Fill-rate поля: ${L.fillRates.salesChannel}%.`}>
        <div style={{ display: "grid", gap: 8 }}>
          {L.salesChannel.map((c) => { const share = Math.round(c.revenue / totalChan * 100); const solo = /самостій/i.test(c.key); return (
            <div key={c.key}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}><span style={{ ...clip, fontWeight: solo ? 700 : 400, color: solo ? AMBER : undefined }}>{c.key}{solo ? " ⭐" : ""}</span><span style={{ fontWeight: 600 }}>{fmtMoney(c.revenue)} · {share}%</span></div>
              <ShareBar pct={share} color={solo ? AMBER : GREEN} />
            </div>
          ); })}
        </div>
      </LogiCard>

      {/* Швидкість — плитки транзит / DSO / прострочено */}
      <LogiCard title="⚡ Швидкість грошей" kind="proxy"
        hint="Транзит: load_at→unload_at (unload=ДАТА АКТА, не фізичне розвантаження ~). DSO: unload→closed(142) — реальної банк-дати оплати в CRM нема, проксі по даті закриття ~. Прострочено: борг зі знімка aging.">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
          {tile("Транзит", L.transit.n === 0 ? "—" : `${L.transit.avg} дн`, L.transit.n === 0 ? "" : `медіана ${L.transit.median}`)}
          {tile("DSO ~", L.dso.n === 0 ? "—" : `${L.dso.avg} дн`, L.dso.n === 0 ? "" : `медіана ${L.dso.median}`)}
          {tile("Прострочено", fmtMoney(agingDebt), `${agingCnt} угод`)}
        </div>
      </LogiCard>

      {/* Концентрація — % + ТОП-5 список */}
      <LogiCard title="🧮 Концентрація клієнтів" kind="ok"
        hint={`Топ-${L.concentration.topN} клієнтів як % отриманої виручки (${L.concentration.clients} клієнтів з іменем у періоді).`}>
        <div style={{ fontSize: 20, fontWeight: 700, color: (L.concentration.pct ?? 0) > 50 ? AMBER : "var(--text)" }}>{L.concentration.pct == null ? "—" : `${L.concentration.pct}%`}<span style={{ fontSize: 11, fontWeight: 400, color: MUTED }}> топ-{L.concentration.topN} ({fmtMoney(L.concentration.topRevenue)} з {fmtMoney(L.concentration.totalRevenue)})</span></div>
        <table className="data-table" style={{ width: "100%", margin: "6px 0 0", fontSize: 12 }}>
          <tbody>{L.concentration.topClients.map((c, i) => (
            <tr key={c.key}><td style={{ color: MUTED, width: 18 }}>{i + 1}</td><td style={clip}>{c.key}</td><td style={{ textAlign: "right", fontWeight: 600 }}>{fmtMoney(c.revenue)}</td><td style={{ textAlign: "right", color: MUTED }}>{fmtNum(c.deals)}р</td></tr>
          ))}</tbody>
        </table>
      </LogiCard>

      {/* Повторні рейси */}
      <LogiCard title="🔁 Повторні рейси" kind="ok" hint="Клієнти з оплатою в періоді, згруповані за к-тю оплачених рейсів (1 / 2-3 / 4+).">
        <table className="data-table" style={{ width: "100%", margin: 0, fontSize: 12 }}><thead><tr><th>Рейсів</th><th style={{ textAlign: "right" }}>Клієнтів</th><th style={{ textAlign: "right" }}>Виручка</th></tr></thead>
          <tbody>{L.repeatRides.map((r) => <tr key={r.bucket}><td>{r.bucket}</td><td style={{ textAlign: "right", fontWeight: 600 }}>{fmtNum(r.clients)}</td><td style={{ textAlign: "right" }}>{fmtMoney(r.revenue)}</td></tr>)}</tbody></table>
      </LogiCard>

      {/* Aging */}
      <LogiCard title="📅 Прострочена дебіторка (aging)" kind="ok"
        hint="Неоплачені угоди з простроченою планова датою, по кошиках днів. Кошики = реальний борг до стягнення (позитивні); сторно/коригування (повернення) — окремим рядком, не борг.">
        <table className="data-table" style={{ width: "100%", margin: 0, fontSize: 12 }}><thead><tr><th>Днів</th><th style={{ textAlign: "right" }}>Угод</th><th style={{ textAlign: "right" }}>Борг</th></tr></thead>
          <tbody>
            {L.aging.buckets.map((a) => <tr key={a.bucket}><td>{a.bucket}</td><td style={{ textAlign: "right", fontWeight: 600 }}>{fmtNum(a.count)}</td><td style={{ textAlign: "right" }}>{fmtMoney(a.sum)}</td></tr>)}
            <tr style={{ borderTop: "1px solid var(--border)", fontWeight: 600 }}><td>Разом борг</td><td style={{ textAlign: "right" }}>{fmtNum(agingCnt)}</td><td style={{ textAlign: "right", color: GREEN }}>{fmtMoney(agingDebt)}</td></tr>
            {L.aging.reversals.count > 0 && <tr style={{ color: MUTED }}><td>сторно/коригування</td><td style={{ textAlign: "right" }}>{fmtNum(L.aging.reversals.count)}</td><td style={{ textAlign: "right" }}>{fmtMoney(L.aging.reversals.sum)}</td></tr>}
          </tbody></table>
      </LogiCard>

      {/* Маржа LOCKED */}
      <LogiCard title="💰 Маржа на авто" kind="none"
        hint="🔒 Заблоковано: собівартість (Видаток/Оплата перевізнику) заповнена ~0%. Поле в Kommo Є — потрібне заповнення менеджерами, не нове поле.">
        <div style={{ fontSize: 12, color: MUTED }}>🔒 Недоступно — заповніть собівартість рейсу в CRM.</div>
      </LogiCard>
    </div>
  );
}

/** Горизонтальний div-бар (magnitude), 4px заокруглені кінці, статус-колір по %. */
/**
 * 📊 ДВОСЕГМЕНТНА СМУГА ВИКОНАННЯ ПЛАНУ (рішення власника 20.08.2026).
 *
 * Щільний сегмент — ФАКТ (отримані кошти), світліший — ОЧІКУВАННЯ за плановою
 * датою оплати цього місяця. Разом вони дорівнюють ПРОГНОЗУ, тобто смуга показує
 * те саме, що число прогнозу поруч, а не власну версію.
 *
 * 🔴 ОБРІЗАЄТЬСЯ ШИРИНА, А НЕ ЧИСЛО. Сума ширин ніколи не більша за 100 (смуга не
 * вилазить із контейнера), але підпис показує СПРАВЖНІЙ відсоток. Заміряно на
 * проді 20.08.2026: РПК 106%, команда Яцика 118%, Шаврової 111% — перевищення не
 * гіпотеза, а сьогоднішній стан, і ховати його за «100%» означало б стерти саме
 * ту інформацію, заради якої смугу й дивляться.
 *
 * ⚠️ Другий сегмент НЕ малюється, коли очікування нема: смуга нульової ширини —
 * це не «нуль очікувань», це артефакт. Порожнє місце має лишатись порожнім.
 */
function PlanBar({ factPct, forecastPct, color, h = 8 }:
  { factPct: number | null; forecastPct: number | null; color?: string; h?: number }) {
  const f = Math.max(0, Math.min(100, factPct ?? 0));
  // Очікування — рівно те, що ЛИШИЛОСЬ до 100 після факту. Тому сума ширин ≤ 100
  // за побудовою, а не завдяки зовнішньому `min` десь у виклику.
  const e = Math.max(0, Math.min(100 - f, (forecastPct ?? 0) - (factPct ?? 0)));
  const base = color ?? BLUE;
  return (
    <div style={{ background: "var(--border)", borderRadius: 4, height: h, width: "100%", overflow: "hidden", display: "flex" }}>
      <div style={{ width: `${f}%`, height: "100%", background: base }} />
      {e > 0 && <div style={{ width: `${e}%`, height: "100%", background: base, opacity: 0.38 }} />}
    </div>
  );
}

function Stat({ label, value, sub, hint, color }: { label: string; value: string; sub?: string; hint?: string; color?: string }) {
  return (
    <div style={{ padding: "12px 14px", background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 12 }}>
      <div style={{ fontSize: 12, color: MUTED, display: "flex", alignItems: "center", gap: 4 }}>{label}{hint && <InfoHint text={hint} />}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: color ?? "var(--text)", lineHeight: 1.2, marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

const curMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
/** Сьогодні за КИЄВОМ — той самий часовий пояс, у якому сервер рахує `isCurrent`. */
const kyivToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });

/**
 * 📅 ЯКІР ПРЕСЕТА. Місячний селектор задає МІСЯЦЬ, а не день, тож для «Дня» і «Тижня»
 * його перше число — неправильний якір.
 *
 * 🔴 ЩО ЦЕ ЛАМАЛО (живий клік власника): при вибраному «Серпень 2026» перемикач
 * «Тиждень» надсилав `date=2026-08-01` — суботу, — і сервер брав тиждень, що її
 * містить, тобто **27.07-02.08**. Заголовок казав «Тиждень 2026-07-27» поруч із
 * селектором «Серпень 2026»: два керма на один діапазон, і обидва показували правду
 * про різні речі.
 *
 * Правило: день/тиждень — якір СЬОГОДНІ, якщо сьогодні всередині обраного місяця
 * (типовий випадок «дивлюсь поточний період»), інакше — 1-ше число обраного місяця,
 * щоб історичний місяць лишався досяжним. Місяць/квартал/рік якорем не переймаються:
 * вони month-aligned за побудовою.
 */
function anchorFor(preset: string, monthSel: string): string {
  if (preset !== "day" && preset !== "week") return monthSel + "-01";
  const today = kyivToday();
  return today.slice(0, 7) === monthSel ? today : monthSel + "-01";
}

export function KvpReportSection() {
  const [preset, setPreset] = useState<string>(() => localStorage.getItem("kvpDPreset") || "month");
  const [monthSel, setMonthSel] = useState<string>(() => localStorage.getItem("kvpDMonth") || curMonth());
  const [range, setRange] = useState<{ from: string; to: string }>(() => { try { return JSON.parse(localStorage.getItem("kvpDRange") || "null") || { from: "", to: "" }; } catch { return { from: "", to: "" }; } });
  const [rep, setRep] = useState<KvpReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [plans, setPlans] = useState<KvpPlans>({});
  const [openTeam, setOpenTeam] = useState<number | null>(null);
  const [showFull, setShowFull] = useState(false);
  const [showLogi, setShowLogi] = useState(false);
  const [weekMode, setWeekMode] = useState<"money" | "activity">("money");
  // #6: тижнево-скоупований дрил — клік по клітинці тижня команди → менеджери ЦЬОГО тижня.
  const [openWeekDrill, setOpenWeekDrill] = useState<{ teamId: number; weekIdx: number } | null>(null);
  const [openMgr, setOpenMgr] = useState<number | null>(null);   // денний дрил менеджера (weeks→days)

  const rangeMode = !!(range.from && range.to);
  useEffect(() => {
    let alive = true; setRep(null); setErr(null);
    const params = rangeMode ? { from: range.from, to: range.to } : { preset, date: anchorFor(preset, monthSel) };
    fetchKvpReport(params).then((r) => { if (alive) setRep(r); }).catch(() => { if (alive) setErr("Не вдалося завантажити звіт КВП."); });
    return () => { alive = false; };
  }, [preset, monthSel, rangeMode, range.from, range.to]);
  useEffect(() => { fetchKvpPlan(monthSel).then(setPlans).catch(() => setPlans({})); }, [monthSel]);

  const setPresetP = (p: string) => { setPreset(p); localStorage.setItem("kvpDPreset", p); setRange({ from: "", to: "" }); localStorage.removeItem("kvpDRange"); };
  const setRangeP = (r: { from: string; to: string }) => { setRange(r); localStorage.setItem("kvpDRange", JSON.stringify(r)); };
  const pickMonth = (v: string) => { const mm = v.slice(0, 7); setMonthSel(mm); localStorage.setItem("kvpDMonth", mm); };

  const v = rep?.verdict;
  const delta = v ? v.received.revenue - v.receivedPrev.revenue : 0;

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">🏆 Звіт КВП</h1>
        <div className="page-filters" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          {[["day", "День"], ["week", "Тиждень"], ["month", "Місяць"], ["quarter", "Квартал"], ["year", "Рік"]].map(([k, lbl]) => (
            <button key={k} onClick={() => setPresetP(k)}
              style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid var(--border)", cursor: "pointer",
                background: !rangeMode && preset === k ? "#c5141c" : "var(--card-bg)", color: !rangeMode && preset === k ? "#fff" : "var(--text)", fontWeight: !rangeMode && preset === k ? 600 : 400 }}>{lbl}</button>
          ))}
          <DatePicker mode="month" value={monthSel} onChange={(x) => x && pickMonth(x)} minWidth={140} />
          <span style={{ color: MUTED, margin: "0 2px" }}>|</span>
          <DatePicker value={range.from} onChange={(x) => setRangeP({ ...range, from: x })} placeholder="від" minWidth={120} />
          <span style={{ color: MUTED }}>—</span>
          <DatePicker value={range.to} onChange={(x) => setRangeP({ ...range, to: x })} placeholder="до" minWidth={120} />
          {rangeMode && <button onClick={() => { setRange({ from: "", to: "" }); localStorage.removeItem("kvpDRange"); }} style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", cursor: "pointer" }}>✕</button>}
        </div>
      </div>

      {err && <p className="loading-text" style={{ color: RED }}>{err}</p>}
      {!rep && !err && <p className="loading-text">Завантаження…</p>}

      {rep && v && (
        <>
          {/* ── ВЕРДИКТ: де ми зараз ── */}
          <div className="chart-card" style={{ marginBottom: 16, borderTop: "3px solid #c5141c" }}>
            <h2 className="chart-title">📍 {rep.scope.label} — де ми зараз {rep.scope.isCurrent && <span style={{ fontSize: 12, color: MUTED }}>(період триває)</span>}</h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 14 }}>
              <Stat label="Отримані кошти" value={fmtMoney(v.received.revenue)} hint={HINT.received}
                sub={`${delta >= 0 ? "▲" : "▼"} ${fmtMoney(Math.abs(delta))} до мин. періоду`} color={delta >= 0 ? GREEN : RED} />
              <Stat label="Стратегічний план 🔒" value={fmtMoney(v.strategicPlan)} hint={HINT.strategic}
                sub={`виконання ${fmtPct(v.planPct)}`} color={pctColor(v.planPct)} />
              <Stat label="Прогноз місяця" value={fmtMoney(v.projection.projected)} hint={HINT.projection}
                sub={`факт ${fmtMoney(v.projection.fact)} + ${fmtMoney(v.projection.expectedThisMonth)} за план. датою · ${fmtPct(v.projection.projectedPct)} плану`}
                color={pctColor(v.projection.projectedPct)} />
              {/* ⏱ ТЕМП — окрема плитка, бо це ІНШЕ питання: «що вийде, якщо нічого не
                  зміниться», проти «що вже домовлено». Розрив між ними і є вердикт. */}
              <Stat label="При поточному темпі" value={v.projection.pace == null ? "—" : fmtMoney(v.projection.pace)} hint={HINT.pace}
                sub={v.projection.pace == null ? "робочі дні ще не минули" : `${fmtPct(v.projection.pacePct)} плану · зазвичай добирає ${fmtMoney(v.projection.dobir)}`}
                color={pctColor(v.projection.pacePct)} />
              <Stat label="Робочі дні" value={`${v.projection.elapsedWorkingDays}/${v.projection.totalWorkingDays}`}
                sub="минуло / всього" />
            </div>
            {/* прогрес до плану */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: MUTED, marginBottom: 4 }}>
                <span>Виконання плану</span>
                <span>
                  <span style={{ color: pctColor(v.planPct), fontWeight: 600 }}>{fmtPct(v.planPct)}</span>
                  <span style={{ color: MUTED }}> факт · </span>
                  <span style={{ color: pctColor(v.projection.projectedPct), fontWeight: 600 }}>{fmtPct(v.projection.projectedPct)}</span>
                  <span style={{ color: MUTED }}> з очікуванням</span>
                </span>
              </div>
              <PlanBar factPct={v.planPct} forecastPct={v.projection.projectedPct} color={pctColor(v.planPct)} h={10} />
              <div style={{ fontSize: 11, color: MUTED, marginTop: 3, display: "flex", alignItems: "center", gap: 4 }}>
                ▉ факт {fmtMoney(v.received.revenue)} · ▨ очікуємо {fmtMoney(v.projection.expectedThisMonth)} за план. датою = прогноз {fmtMoney(v.projection.projected)}
                <InfoHint text={HINT.planBar} />
              </div>
            </div>
            {/* lifecycle-смуга */}
            <div style={{ fontSize: 12, color: MUTED, display: "flex", alignItems: "center", gap: 4, marginBottom: 6 }}>Життєвий цикл грошей<InfoHint text={HINT.lifecycle} /></div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              {/* 🔴 Скоуп кожної плитки ПІДПИСАНИЙ ПРЯМО НА НІЙ, а не лише в ⓘ: дві крайні
                  звужуються періодом, середня — ні, і при однаковому вигляді це читається
                  як один потік («з відправленого стільки чекає»), яким воно не є. */}
              {([["Відправлено", "за період", v.lifecycle.sent, BLUE, HINT.sent],
                 ["Очікуємо", "уся зона, без прив'язки до дати", v.lifecycle.awaiting, AMBER, HINT.awaiting],
                 ["Отримано", "за період", v.lifecycle.received, GREEN, HINT.received]] as const).map(([lbl, scopeLbl, agg, col, h]) => (
                <div key={lbl} style={{ padding: 10, background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 10 }}>
                  <div style={{ fontSize: 11, color: MUTED, display: "flex", alignItems: "center", gap: 3 }}>{lbl}<InfoHint text={h} /></div>
                  <div style={{ fontSize: 17, fontWeight: 700, color: col }}>{fmtMoney(agg.revenue)}</div>
                  <div style={{ fontSize: 11, color: MUTED }}>{agg.deals} авто</div>
                  <div style={{ fontSize: 10, color: MUTED, marginTop: 2, fontStyle: "italic" }}>{scopeLbl}</div>
                </div>
              ))}
            </div>
          </div>

          {/* ── СИГНАЛИ ── */}
          {rep.signals.length > 0 && (
            <div className="chart-card" style={{ marginBottom: 16 }}>
              <h2 className="chart-title">🚨 Сигнали (за гостротою)</h2>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {rep.signals.map((s, i) => (
                  <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "8px 12px", borderLeft: `3px solid ${sevColor[s.severity]}`, background: "var(--card-bg)", borderRadius: 8 }}>
                    <span style={{ fontSize: 18 }}>{s.icon}</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, color: sevColor[s.severity] }}>{s.title}</div>
                      <div style={{ fontSize: 13, color: "var(--text)" }}>{s.detail}</div>
                      {s.expectedThisMonth != null && <div style={{ fontSize: 12, color: AMBER, marginTop: 2 }}>Очікування: цей міс {fmtMoney(s.expectedThisMonth)} · наступний {fmtMoney(s.expectedNextMonth ?? 0)}</div>}
                      <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>→ {s.action}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── 🏆 ТРИМАЮТЬ ──
              Екран КВП складався з самих проблем: «Сигнали» показують лише падіння.
              Тут — хто попереду. Порогу «лідера» НЕМАЄ навмисно: заміряно 20.08.2026,
              що з 29 менеджерів із планом ≥100% має РІВНО ОДИН, тож умова «показувати
              тих, хто перевиконав» лишала б блок майже завжди порожнім.
              АБСОЛЮТ ПОРУЧ ІЗ ВІДСОТКОМ обовʼязковий: 97% на плані 39к і 64% на плані
              300к без нього читаються навпаки. */}
          {rep.topPerformers.length > 0 && (
            <div className="chart-card" style={{ marginBottom: 16 }}>
              <h2 className="chart-title">🏆 Тримають
                <span style={{ fontSize: 12, fontWeight: 400, color: MUTED }}> · топ-3 за виконанням плану</span>
              </h2>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {rep.topPerformers.map((m, i) => (
                  <div key={m.name} style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 12px", borderLeft: `3px solid ${GREEN}`, background: "var(--card-bg)", borderRadius: 8 }}>
                    <span style={{ fontSize: 18 }}>{["🥇", "🥈", "🥉"][i] ?? "•"}</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600 }}>{m.name} <span style={{ fontSize: 12, fontWeight: 400, color: MUTED }}>· {m.team}</span></div>
                      <div style={{ fontSize: 13, color: "var(--text)" }}>
                        <b style={{ color: pctColor(m.pct) }}>{m.pct}%</b> — {fmtMoney(m.fact)} з {fmtMoney(m.plan)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── ДВИГУНИ (4) ── */}
          <div className="chart-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16, marginBottom: 16 }}>
            {([["🏭 РПК", rep.engines.rpk, false], ["📢 РНК", rep.engines.rnk, true]] as const).map(([lbl, e, showConv]) => (
              <div key={lbl} className="chart-card">
                <h2 className="chart-title">{lbl}</h2>
                <Stat label="Факт / план" value={`${fmtMoney(e.revenue)}`} sub={`план ${fmtMoney(e.plan)} · ${fmtPct(e.pct)}`} color={pctColor(e.pct)} hint={HINT.teamPlan} />
                <div style={{ margin: "8px 0" }}><PlanBar factPct={e.pct} forecastPct={e.forecastPct} color={pctColor(e.pct)} /></div>
                <div style={{ fontSize: 11, color: MUTED, marginBottom: 2 }}>▉ факт {fmtPct(e.pct)} · ▨ з очікуванням <b style={{ color: pctColor(e.forecastPct) }}>{fmtPct(e.forecastPct)}</b></div>
                <div style={{ fontSize: 12, color: MUTED, display: "flex", alignItems: "center", gap: 3 }}>
                  Очікуємо: {fmtMoney(e.expectedThisMonth)} <span style={{ fontSize: 11 }}>за плановою датою цього місяця</span>
                  <InfoHint text={`Це очікування, що ВХОДИТЬ у прогноз: угоди з плановою датою оплати в цьому місяці. Уся зона визнання, без прив'язки до дати, — ${fmtMoney(e.expected)}; вона ширша (туди входять наступний місяць і прострочені домовленості) і в прогноз НЕ береться. Два різні «очікуємо» — тому кожне підписане своїм.`} />
                </div>
                {showConv && <div style={{ fontSize: 12, color: MUTED, display: "flex", alignItems: "center", gap: 3 }}>Конверсія: {fmtPct(e.conversion)} {e.entered < 10 && "(<10 лідів)"}<InfoHint text={HINT.conversion} /></div>}
              </div>
            ))}
            <div className="chart-card">
              <h2 className="chart-title">🎯 Реклама</h2>
              <Stat label="ROMI" value={fmtPct(rep.engines.ad.romi)} sub={`бюджет ${fmtMoney(rep.engines.ad.budget)} · дохід ${fmtMoney(rep.engines.ad.revenue)}`} hint={HINT.romi} />
              <div style={{ fontSize: 12, color: MUTED, marginTop: 6, display: "grid", gap: 2 }}>
                <span style={{ display: "flex", alignItems: "center", gap: 3 }}>CPA: {rep.engines.ad.cpa == null ? "—" : fmtMoney(rep.engines.ad.cpa)} {!rep.engines.ad.mature && "⏳"}<InfoHint text={HINT.cpa} /></span>
                <span style={{ display: "flex", alignItems: "center", gap: 3 }}>CPL(GA): {rep.engines.ad.cplGa == null ? "—" : fmtMoney(rep.engines.ad.cplGa)}<InfoHint text={HINT.cplGa} /></span>
                <span style={{ display: "flex", alignItems: "center", gap: 3 }}>Конверсія: {fmtPct(rep.engines.ad.conversion)} {!rep.engines.ad.mature && "⏳"}<InfoHint text={HINT.conversion} /></span>
              </div>
            </div>
            <div className="chart-card">
              <h2 className="chart-title">📞 Лідген (3 якорі)</h2>
              <div style={{ display: "grid", gap: 6, fontSize: 13 }}>
                <span style={{ display: "flex", alignItems: "center", gap: 3 }}>Передані: <b>{fmtNum(rep.engines.leadgen.transferred)}</b>{!rep.scope.monthAligned && <span style={{ color: MUTED, fontSize: 11 }}> (за місяці)</span>}<InfoHint text={HINT.transferred + (rep.scope.monthAligned ? "" : " ⚠️ Обраний період НЕ збігається з календарним місяцем, а денного розрізу для переданих заявок немає — це число описує МІСЯЦІ, що перетинаються з періодом, а не сам період.")} /></span>
                <span style={{ display: "flex", alignItems: "center", gap: 3 }}>Поїхали: <b>{fmtNum(rep.engines.leadgen.dispatched)}</b> ({fmtMoney(rep.engines.leadgen.dispatchedRevenue)})<InfoHint text={HINT.lgDispatched} /></span>
                <span style={{ display: "flex", alignItems: "center", gap: 3 }}>Дохід: <b>{fmtMoney(rep.engines.leadgen.revenue)}</b><InfoHint text={HINT.lgRevenue} /></span>
              </div>
              <p style={{ fontSize: 11, color: MUTED, marginTop: 6 }}>Три якорі не зводяться в межах місяця.</p>
            </div>
          </div>

          {/* ── КОМАНДИ → менеджери drill ── */}
          <div className="chart-card" style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <h2 className="chart-title" style={{ margin: 0 }}>🏅 Команди — план / факт {rep.weekBlocks.length > 0 && <span style={{ fontSize: 12, color: MUTED }}>(+ тижні Т1–Т{rep.weekBlocks.length}) </span>}<InfoHint text="Клік по команді → менеджери → клік менеджера → денний дрил. Клік по клітинці тижня → менеджери саме цього тижня → денний дрил тижня. Т1–Т5 = фіксовані блоки місяця (1-7/8-14/15-21/22-28/29-кінець). Тижневий факт = отримано за датою оплати; ✓/✗ = факт ≥ план тижня; майбутні тижні = план+очікування (у виконання НЕ входить). Вертикальна риска на смузі = темп (де мали б бути на сьогодні)." /></h2>
              {rep.weekBlocks.length > 0 && (
                <div style={{ display: "inline-flex", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden", fontSize: 12 }}>
                  {([["money", "💰 Гроші"], ["activity", "⚙️ Активність"]] as const).map(([k, lbl]) => (
                    <button key={k} onClick={() => setWeekMode(k)}
                      style={{ padding: "5px 12px", border: "none", cursor: "pointer", background: weekMode === k ? "#c5141c" : "var(--card-bg)", color: weekMode === k ? "#fff" : "var(--text)", fontWeight: weekMode === k ? 600 : 400 }}>{lbl}</button>
                  ))}
                </div>
              )}
            </div>
            <div style={{ overflowX: "auto" }}>
              <table className="data-table" style={{ width: "100%", tableLayout: "fixed", minWidth: 640 + rep.weekBlocks.length * WK_W }}>
                <colgroup>
                  <col style={{ width: 216 }} />
                  <col style={{ width: 84 }} /><col style={{ width: 84 }} /><col style={{ width: 108 }} /><col style={{ width: 88 }} /><col style={{ width: 56 }} />
                  {rep.weekBlocks.map((w) => <col key={w.idx} style={{ width: WK_W }} />)}
                </colgroup>
                <thead><tr>
                  <th>Команда / менеджер</th>
                  <th style={{ textAlign: "right" }}>План</th><th style={{ textAlign: "right" }}>Факт</th><th>Вик. %</th><th style={{ textAlign: "right" }}>Очікуємо <InfoHint text="За плановою датою оплати (коли має надійти); зміна дати переносить між місяцями. Верх — цей календарний місяць, низ — наступний. Знімок «зараз». Наведи на клітинку — + ср.чеки команди." /></th><th style={{ textAlign: "right" }}>Конв. <InfoHint text="Лайфтайм-конверсія (весь час, чесна воронка): РНК = рекламні угоди, що досягли «авто працює» ÷ прийнята реклама; РПК = лідген-угоди, що досягли «авто працює» ÷ лідген-заявки. Команда = Σчисельників÷Σзнаменників. Тонкий знаменник (0) → «—»." /></th>
                  {rep.weekBlocks.map((w) => <th key={w.idx} style={{ textAlign: "right", fontSize: 10, background: w.isCurrent ? "rgba(37,99,235,0.08)" : undefined }}>Т{w.idx}<div style={{ color: MUTED, fontWeight: 400 }}>{w.from.slice(8)}–{w.to.slice(8)}</div></th>)}
                </tr></thead>
                <tbody>
                  {rep.teams.map((t) => (
                    <Fragment key={t.teamId}>
                      <tr onClick={() => setOpenTeam(openTeam === t.teamId ? null : t.teamId)} style={{ cursor: "pointer" }}>
                        <td style={clip}>{openTeam === t.teamId ? "▾" : "▸"} <b>{t.name}</b> <span style={{ fontSize: 11, color: MUTED }}>{teamKindLabel[t.kind]}{t.kind === "leadgen" && <InfoHint text="Відділ лідогенерації — показано у списку команд, але його метрики продажів рахуються окремою логікою (задача на потім, не плутати з РПК/повним циклом)." />}</span></td>
                        <td style={{ textAlign: "right" }}>{fmtMoney(t.plan)}</td>
                        <td style={{ textAlign: "right", fontWeight: 600 }}>{fmtMoney(t.revenue)}</td>
                        <td><div style={{ display: "flex", alignItems: "center", gap: 6 }} title={`Факт ${fmtPct(t.pct)} · з очікуванням за плановою датою ${fmtPct(t.forecastPct)}`}><PlanBar factPct={t.pct} forecastPct={t.forecastPct} color={pctColor(t.pct)} /><span style={{ color: pctColor(t.pct), fontWeight: 600, minWidth: 38, textAlign: "right" }}>{fmtPct(t.pct)}</span></div></td>
                        <td style={{ textAlign: "right", color: MUTED }} title={`Очікування за ПЛАНОВОЮ датою оплати. Цей міс: ${fmtMoney(t.expectedThisMonth)} · наступний: ${fmtMoney(t.expectedNextMonth)}. Ср.чек команди — успішно: ${t.avgCheckSuccess == null ? "—" : fmtMoney(t.avgCheckSuccess)} · в очікуванні: ${t.avgCheckAwaiting == null ? "—" : fmtMoney(t.avgCheckAwaiting)}.`}>{fmtMoney(t.expectedThisMonth)}<div style={{ fontSize: 9.5, color: MUTED }}>наст {fmtMoney(t.expectedNextMonth)}</div></td>
                        <td style={{ textAlign: "right" }} title={`Лайфтайм (весь час): ${t.convLifetime.num} / ${t.convLifetime.den}${t.kind === "rnk" ? " (реклама)" : t.kind === "rpk" ? " (лідген)" : ""}`}>{t.kind === "rnk" || t.kind === "rpk" ? fmtPct(t.convLifetime.pct) : "—"}</td>
                        {rep.weekBlocks.map((w) => (
                          <WeekCell key={w.idx} mode={weekMode}
                            w={t.weeks?.find((x) => x.idx === w.idx)}
                            prev={t.weeks?.find((x) => x.idx === w.idx - 1)}
                            active={openWeekDrill?.teamId === t.teamId && openWeekDrill?.weekIdx === w.idx}
                            onClick={() => setOpenWeekDrill((cur) => cur?.teamId === t.teamId && cur?.weekIdx === w.idx ? null : { teamId: t.teamId, weekIdx: w.idx })} />
                        ))}
                      </tr>
                      {openWeekDrill?.teamId === t.teamId && <WeekManagerDrill team={t} weekIdx={openWeekDrill.weekIdx} weekBlocks={rep.weekBlocks} />}
                      {/* Спокійний вигляд менеджерів (макет kvp_managers_calm_mockup): тихий рядок +
                          спарклайн 5 тижнів; тижневі числа + діагноз + дні — на клік. Без банера. */}
                      {openTeam === t.teamId && (
                        <tr><td colSpan={6 + rep.weekBlocks.length} style={{ padding: 0, background: "var(--bg)" }}>
                          <CalmManagers team={t} rep={rep} plans={plans} openMgr={openMgr} setOpenMgr={setOpenMgr} />
                        </td></tr>
                      )}
                    </Fragment>
                  ))}
                  {/* #5: розріз відділу по тижнях = Σ команд (гейт Σ Dept == Σ teams == Σ days) */}
                  {rep.deptWeeks.length > 0 && (
                    <tr style={{ borderTop: "2px solid var(--border)", fontWeight: 600 }}>
                      <td style={clip}>Σ Відділ</td>
                      <td style={{ textAlign: "right" }}>{fmtMoney(rep.teams.reduce((s, t) => s + t.plan, 0))}</td>
                      <td style={{ textAlign: "right", fontWeight: 700 }}>{fmtMoney(rep.teams.reduce((s, t) => s + t.revenue, 0))}</td>
                      <td colSpan={3}></td>
                      {rep.deptWeeks.map((w) => (
                        <WeekCell key={w.idx} mode={weekMode} w={w} prev={rep.deptWeeks.find((x) => x.idx === w.idx - 1)} />
                      ))}
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── ЯКІСТЬ / ЛОЯЛЬНІСТЬ + РИЗИКИ ── */}
          <div className="chart-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16, marginBottom: 16 }}>
            <div className="chart-card"><StructureBlock rep={rep} /></div>
            <div className="chart-card">
              <h2 className="chart-title">🔁 Ризики / retention</h2>
              <RetentionBlock rep={rep} />
            </div>
          </div>

          <LeadgenRegularsCard />

          {/* ── ПОВНА ТАБЛИЦЯ (під катом) ── */}
          <div className="chart-card" style={{ marginBottom: 16 }}>
            <h2 className="chart-title" style={{ cursor: "pointer" }} onClick={() => setShowFull(!showFull)}>{showFull ? "▾" : "▸"} 📋 Повна таблиця</h2>
            {showFull && <FullTable rep={rep} plans={plans} onSave={(k, val) => { setPlans((p) => { const n = { ...p }; if (val == null) delete n[k]; else n[k] = val; return n; }); saveKvpPlan(monthSel, { [k]: val }).catch(() => {}); }} />}
          </div>

          {/* ── 🚚 ЛОГІСТИКА (під катом) ── */}
          <div className="chart-card" style={{ marginBottom: 16 }}>
            <h2 className="chart-title" style={{ cursor: "pointer" }} onClick={() => setShowLogi(!showLogi)}>{showLogi ? "▾" : "▸"} 🚚 Логістика</h2>
            {showLogi && <LogisticsSection rep={rep} />}
          </div>
        </>
      )}
    </>
  );
}

// Крок Д фінал A — ЛІНИВИЙ ДЕТАЛЬНИЙ дрил менеджера weeks→days (fetch при розкритті).
// Тижні Т1–Т5, «Разом» = Σ днів; клік тижня → дні. Поточний тиждень відкрито; майбутні
// — лише очікування. Колонки: створено · ліди р/лг · авто · отримано · очікування.
function ManagerDetailDrill({ managerId, from, to }: { managerId: number; from: string; to: string }) {
  const [d, setD] = useState<KvpManagerDetail | null>(null);
  const [err, setErr] = useState(false);
  const [openW, setOpenW] = useState<Set<number>>(new Set());
  useEffect(() => {
    let a = true; setD(null); setErr(false);
    fetchManagerDetail({ managerId, from, to }).then((x) => { if (!a) return; setD(x); setOpenW(new Set(x.weeks.filter((w) => w.isCurrent).map((w) => w.idx))); }).catch(() => a && setErr(true));
    return () => { a = false; };
  }, [managerId, from, to]);
  if (err) return <div style={{ fontSize: 12, color: RED }}>Не вдалося завантажити деталь.</div>;
  if (!d) return <div style={{ fontSize: 12, color: MUTED }}>Завантаження деталі…</div>;
  // Середній чек = отримано ÷ авто (ПОХІДНИЙ, не сумується — перераховується на кожному
  // рівні з received.revenue ÷ dispatched; «—» де авто=0).
  // 🔴 Е4: розкриття мусить пояснювати РЯДОК, а не сперечатись із ним. Рядок менеджера
  // показує партицію СТВОРЕНОГО за каналом; тут — та сама партиція по тижнях/днях
  // (`crAd/crLeadgen/crOther`, Σ == created). Дані вже приходили з `createdSplitByBucket`
  // і мовчки відкидались. Сусідні «Ліди рекл./лідоген» — ІНША популяція (ліди), тому
  // й підписані інакше: дві сімʼї не мають права зливатись в одну назву.
  const cell = (c: { created: number; newCount: number; repeatCount: number; undefCount: number; crAd: number; crLeadgen: number; crOther: number; leadsAd: number; leadsLeadgen: number; dispatched: number; received: { revenue: number; deals: number }; expected: { sum: number } }, future: boolean) => (<>
    <td style={{ textAlign: "right" }}>{future ? "—" : (c.created || "—")}{!future && c.undefCount > 0 && <span style={{ color: MUTED, fontSize: 10, fontWeight: 400 }}> ·{c.undefCount} невизн</span>}</td>
    <td style={{ textAlign: "right" }}>{future ? "—" : (c.newCount || "—")}</td>
    <td style={{ textAlign: "right", color: c.repeatCount > 0 ? GREEN : undefined }}>{future ? "—" : (c.repeatCount || "—")}</td>
    <td style={{ textAlign: "right", color: MUTED, fontSize: 11 }}>{future ? "—" : `${c.crAd || 0} / ${c.crLeadgen || 0} / ${c.crOther || 0}`}</td>
    <td style={{ textAlign: "right" }}>{future ? "—" : (c.leadsAd || "—")}</td>
    <td style={{ textAlign: "right" }}>{future ? "—" : (c.leadsLeadgen || "—")}</td>
    <td style={{ textAlign: "right" }}>{future ? "—" : (c.dispatched || "—")}</td>
    <td style={{ textAlign: "right", fontWeight: 600 }}>{future ? "—" : (c.received.deals ? fmtMoney(c.received.revenue) : "—")}</td>
    <td style={{ textAlign: "right" }}>{future || c.dispatched === 0 ? "—" : fmtFull(Math.round(c.received.revenue / c.dispatched))}</td>
    <td style={{ textAlign: "right", color: AMBER }}>{c.expected.sum ? fmtMoney(c.expected.sum) : "—"}</td>
  </>);
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="data-table" style={{ width: "100%", margin: 0, fontSize: 12 }}>
        <thead><tr><th>Тиждень / день</th><th style={{ textAlign: "right" }}>Створено</th><th style={{ textAlign: "right" }}>Нові</th><th style={{ textAlign: "right" }}>Постійні <InfoHint text={HINT.createdSplit} /></th><th style={{ textAlign: "right" }} title="Партиція СТВОРЕНОГО за каналом: реклама / лідген / не реклама і не лідген. Σ = Створено.">Канал ств.<InfoHint text={`Розклад стовпця «Створено» за каналом угоди: реклама / лідген / ${NO_CH_LABEL}. Сума = Створено. НЕ плутати з «Ліди рекл./лідоген» — то інша популяція (ліди Кваліфікації), а не створені угоди повного циклу.`} /></th><th style={{ textAlign: "right" }}>Ліди рекл.</th><th style={{ textAlign: "right" }}>Ліди лідоген</th><th style={{ textAlign: "right" }}>Авто</th><th style={{ textAlign: "right" }}>Отримано</th><th style={{ textAlign: "right" }}>Чек</th><th style={{ textAlign: "right" }}>Очікування</th></tr></thead>
        <tbody>
          {d.weeks.map((w) => {
            const open = openW.has(w.idx);
            return (
              <Fragment key={w.idx}>
                <tr onClick={() => setOpenW((s) => { const n = new Set(s); n.has(w.idx) ? n.delete(w.idx) : n.add(w.idx); return n; })}
                  style={{ cursor: "pointer", background: w.isCurrent ? "rgba(37,99,235,0.08)" : "var(--bg)", fontWeight: 600 }}>
                  <td>{open ? "▾" : "▸"} Т{w.idx} <span style={{ color: MUTED, fontWeight: 400 }}>{w.from.slice(8)}–{w.to.slice(8)}</span> Разом{w.isCurrent && " ●"}</td>
                  {cell(w.total, w.isFuture)}
                </tr>
                {open && w.days.map((x) => (
                  <tr key={x.day}>
                    <td style={{ paddingLeft: 24, color: MUTED }}>{x.day.slice(8)}.{x.day.slice(5, 7)}</td>
                    {cell(x, w.isFuture)}
                  </tr>
                ))}
                {open && w.days.length === 0 && <tr><td colSpan={8} style={{ paddingLeft: 24, color: MUTED, fontSize: 11 }}>Немає активності.</td></tr>}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Спокійний вигляд менеджерів (макет kvp_managers_calm_mockup) + рушій рекомендацій ──
/**
 * 🔀 ФАКТ МЕНЕДЖЕРА: ТРИ КАНАЛИ + НОВИЗНА — ОДНИМ КОМПОНЕНТОМ, ОДНАКОВО ВСІМ (Е4).
 *
 * 🔴 ПІДПИС І НОВИЗНА ЇДУТЬ РАЗОМ — це умова власника, а не оформлення. Сама назва
 * «не реклама і не лідген» менеджеру нічого не пояснює: вона лише чесна. Пояснює її
 * сусіднє число — «735, із них 523 постійні». Якби назва поїхала без новизни, екран
 * став би гіршим, ніж був. Тому обидві половини живуть в ОДНОМУ виразі: рознести їх
 * по різних місцях означало б дозволити їм розійтись.
 *
 * 📐 ЧОМУ ТРЕТІЙ КАНАЛ ВЗАГАЛІ ЗʼЯВИВСЯ. Проєкція `/kvp-report` віддавала лише
 * `ad`/`leadgen`, і 44% створеного (999-1010 угод серпня) не було на екрані ніде;
 * у РПК це 74.4% — три чверті роботи людини. Ядро рахувало всі чотири кошики завжди.
 *
 * 📐 ЧОМУ ПІДПИС ОПИСУЄ ПРЕДИКАТ, А НЕ СЕНС (рішення власника 26.08.2026 за заміром):
 * жоден позитивний підпис не переживає перевірки на ВСЬОМУ каналі. «Створено вручну»
 * — 131 із 1010 (13%). «Постійні» — правда для РПК (71% за каноном ядра) і НЕПРАВДА
 * для РНК (19%; там 222 нові з 273). Ділити канал за `client_source` теж не можна:
 * заміряно, що всередині РПК ця межа дає 92% проти 95% повторних, тобто не розрізняє
 * нічого. Єдина межа, що працює, — тип команди, а ФАКТ від нього залежати не має.
 * Тому канал ОДИН, підпис описовий, а розрізняє новизна поруч.
 *
 * ⚠️ Новизна — ТІЛЬКИ канон ядра (`priorClientSql`, поле `createdSplit`). Своє
 * означення «є рання угода» дає для РПК 92% замість 71% — інше число під тією самою
 * назвою. Одне правило, записане двічі, розходиться мовчки.
 */
const NO_CH_LABEL = "не реклама і не лідген";

/**
 * 🕐 ПІДПИС ПРО ДРЕЙФ КАНАЛІВ — рішення власника 26.08.2026, варіант «підпис біля блоку».
 *
 * 📐 ФАКТ, А НЕ ВИБАЧЕННЯ. `reclassifyAdChannel` ганяється ЩОСИНКУ по всій таблиці й
 * переставляє канал ЗАДНІМ ЧИСЛОМ: «останній дотик» за побудовою переоцінюється,
 * щойно зʼявляється новіший. Заміряно 26.08.2026: між двома замірами з різницею ~40 хв
 * «Реактивація закриті» в третьому каналі зросла 110 → 112, а `updated_at_kommo`
 * зрушив у 81 угоди серпня за годину. Тобто той самий місяць, відкритий двічі, може
 * дати різні числа — на одиниці, не на порядки.
 *
 * 🔴 ЧОМУ САМЕ ТУТ І САМЕ ТЕКСТОМ (три умови власника):
 *   • біля БЛОКУ каналів, а не внизу сторінки: число, що змінюється, і пояснення,
 *     чому воно змінюється, мусять бути видимі ОДНОЧАСНО;
 *   • НЕ тултип: людина, яка вже помітила розбіжність і засумнівалась, підказку при
 *     наведенні не шукатиме — вона піде питати, чи екран бреше;
 *   • не в кожному рядку: підпис під кожним менеджером перетворився б на шпалери,
 *     які перестають читати (той самий урок, що з «невідомим» у 77% рядків).
 * Тому — один рядок на розгорнуту команду, просто над її менеджерами.
 *
 * ⚠️ Заморожування каналу для закритих місяців НЕ робимо — це окрема будова, вона
 * піде в етап «Лідген» (рішення власника).
 */
const DRIFT_NOTE = "Канали уточнюються: атрибуція перераховується щопівгодини, тому числа за минулі періоди можуть змінитись на одиниці.";
function MgrFactLine({ cs }: { cs: CreatedSplit }) {
  if (!cs || cs.created <= 0) return null;
  const chip = (label: string, v: number, color?: string) =>
    v > 0 ? <span style={{ color: color ?? MUTED }}>{label} <b style={{ color: "var(--text)" }}>{v}</b></span> : null;
  return (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", fontSize: 10.5, color: MUTED, marginTop: 3, lineHeight: 1.4 }}>
      <span>створено <b style={{ color: "var(--text)" }}>{cs.created}</b></span>
      {chip("нові", cs.new, BLUE)}
      {chip("постійні", cs.repeat, GREEN)}
      {chip("невизн.", cs.undef)}
      <span style={{ color: "var(--border)" }}>|</span>
      {chip("реклама", cs.ad)}
      {chip("лідген", cs.leadgen)}
      {chip(NO_CH_LABEL, cs.other)}
      {chip("без каналу", cs.noChannel)}
      <InfoHint text={HINT.createdSplit} />
    </div>
  );
}

const CALM_COLS = "1fr 82px 116px 50px 78px 50px 122px"; // імʼя·план·факт·вик·очік·конв·спарклайн

// Спарклайн 5 тижнів — ТОНКІ бари ЛИШЕ кольором (зелений≥100/жовтий70-99/червоний<70/сірий нуль),
// поточний тиждень обведено. Без чисел/стрілок.
function Sparkline({ weeks, blocks }: { weeks: KvpWeek[]; blocks: KvpReport["weekBlocks"] }) {
  return (
    <div style={{ display: "flex", gap: 3, alignItems: "flex-end", justifyContent: "flex-end", height: 20 }}>
      {blocks.map((b) => {
        const w = weeks?.find((x) => x.idx === b.idx);
        const fact = w?.fact ?? 0, plan = w?.plan ?? 0, isFut = w?.isFuture ?? false, isCur = w?.isCurrent ?? false;
        let color = "var(--border)", h = 4;
        if (!isFut && fact > 0) { const p = plan > 0 ? (fact / plan) * 100 : 0; color = p >= 100 ? GREEN : p >= 70 ? AMBER : RED; h = 20; }
        return <span key={b.idx} title={`Т${b.idx} ${b.from.slice(8)}–${b.to.slice(8)}`}
          style={{ width: 15, height: h, borderRadius: "2px 2px 0 0", background: color, outline: isCur ? `1.5px solid ${BLUE}` : undefined, outlineOffset: 1 }} />;
      })}
    </div>
  );
}

// Детермінований рушій рекомендацій (БЕЗ AI). ПЕРВИННИЙ провал → дія з числами. Скоуп за
// роллю: РПК=лідоген, РНК=реклама. Флаг «відстає» — проти ТЕМПУ на сьогодні, не проти 100%.
type Rec = { level: "crit" | "warn" | "ok"; why: string; action: string };
function mgrRecommendation(m: KvpManager, kind: string, plans: KvpPlans, proj: KvpReport["verdict"]["projection"]): Rec {
  const remaining = Math.max(0, m.plan - m.revenue);              // залишок_плану = план − факт
  const pace = proj.totalWorkingDays > 0 ? proj.elapsedWorkingDays / proj.totalWorkingDays : 0;
  const paceTarget = m.plan * pace;                              // темп на сьогодні
  const behind = m.plan > 0 && m.revenue < paceTarget;
  const CHECK = 2000, LG_CONV = 0.10;                            // константи (чек 2000, лідоген 10%)
  const adTargetPct = plans.conversion_target ?? 10;            // конв_реклама_ціль (%)
  const paceNote = `факт ${fmtMoney(m.revenue)} < темп ${fmtMoney(Math.round(paceTarget))} (${proj.elapsedWorkingDays}/${proj.totalWorkingDays} роб. днів)`;
  // 1) ВІДСТАЄ ВІД ТЕМПУ (первинний)
  if (behind) {
    if (kind === "rnk") {
      const conv = adTargetPct / 100;
      const N = conv > 0 ? Math.round(remaining / CHECK / conv) : null;
      return { level: "crit", why: `Відстає від темпу: ${paceNote}.`,
        action: `Треба ~${N ?? "—"} реклама-лідів цього тижня = round(залишок ${fmtMoney(remaining)} ÷ чек ${CHECK} ÷ конв. реклами ${adTargetPct}%). Аналіз угод, коментар що не так, план дій, затвердити.` };
    }
    const N = Math.round(remaining / CHECK / LG_CONV);
    return { level: "crit", why: `Відстає від темпу: ${paceNote}.`,
      action: `Треба ~${N} лідогенів цього тижня = round(залишок ${fmtMoney(remaining)} ÷ чек ${CHECK} ÷ конв. лідоген 10%). Аналіз Прогноз/реактивація — клієнти зі зниженням обсягу, звʼязок, фіксація. Розбір дзвінків.` };
  }
  // 2) Конверсія каналу < ціль (РНК реклама)
  if (kind === "rnk" && m.conversion != null && m.conversion < adTargetPct) {
    return { level: "warn", why: `Конверсія реклами ${m.conversion}% нижча за ціль ${adTargetPct}%.`,
      action: `Аналіз угод, коментар що не так, план дій, затвердити.` };
  }
  // 3) НЕ відстає → позитивна нотатка (без червоного)
  return { level: "ok", why: `Тримає темп (${m.pct ?? 0}% плану).`,
    action: m.expected > 0 ? `Дотиснути очікувані ${fmtMoney(m.expected)}.` : `Тримати темп, закривати заплановане.` };
}

function CalmManagers({ team, rep, plans, openMgr, setOpenMgr }: { team: KvpTeam; rep: KvpReport; plans: KvpPlans; openMgr: number | null; setOpenMgr: (v: number | null) => void }) {
  const proj = rep.verdict.projection;
  const recCol = (l: Rec["level"]) => (l === "crit" ? RED : l === "warn" ? AMBER : GREEN);
  return (
    <div>
      {/* #4 два середні чеки команди (Σsum÷Σcount): «успішно реалізовано» (виграні 142 за
          місяць) + «в очікуванні оплат» (угоди зараз у роботі авто→оплата, знімок). */}
      <div style={{ padding: "7px 16px 7px 30px", fontSize: 11.5, color: MUTED, borderBottom: "1px solid var(--border)", display: "flex", gap: 16, flexWrap: "wrap" }}>
        <span>Ср. чек команди:</span>
        <span>успішно реалізовано <b style={{ color: "var(--text)" }}>{team.avgCheckSuccess == null ? "—" : fmtMoney(team.avgCheckSuccess)}</b><InfoHint text="Виграні угоди (142) за місяць по даті закриття: Σ суми ÷ Σ угод. Звірка з листом 2600–2900." /></span>
        <span>в очікуванні оплат <b style={{ color: "var(--text)" }}>{team.avgCheckAwaiting == null ? "—" : fmtMoney(team.avgCheckAwaiting)}</b><InfoHint text="Угоди ЗАРАЗ у роботі (авто працює→оплата отримана, без 142), знімок «станом на зараз»: Σ суми ÷ Σ угод." /></span>
      </div>
      <div style={{ padding: "5px 16px 6px 30px", fontSize: 10.5, color: MUTED, lineHeight: 1.45, borderBottom: "1px solid var(--border)" }}>
        🕐 {DRIFT_NOTE}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: CALM_COLS, gap: 8, padding: "6px 16px 6px 30px", color: MUTED, fontSize: 9.5, textTransform: "uppercase", letterSpacing: ".04em", borderBottom: "1px solid var(--border)" }}>
        <span>Менеджер</span><span style={{ textAlign: "right" }}>План</span><span style={{ textAlign: "right" }}>Факт</span><span style={{ textAlign: "right" }}>Вик</span><span style={{ textAlign: "right" }}>Очік</span><span style={{ textAlign: "right" }}>Конв</span><span style={{ textAlign: "right" }}>Тижні Т1–Т{rep.weekBlocks.length}</span>
      </div>
      {team.managers.map((m) => {
        const open = openMgr === m.managerId;
        const zero = m.revenue === 0;
        const pctColr = zero ? MUTED : pctColor(m.pct);
        const rec = mgrRecommendation(m, team.kind, plans, proj);
        return (
          <Fragment key={m.managerId}>
            <div onClick={() => setOpenMgr(open ? null : m.managerId)}
              style={{ display: "grid", gridTemplateColumns: CALM_COLS, gap: 8, alignItems: "center", padding: "9px 16px 9px 30px", borderBottom: "1px solid var(--border)", cursor: "pointer", background: open ? "rgba(37,99,235,0.05)" : undefined }}>
              {/* 🔴 `clip` (nowrap+overflow:hidden) — ЛИШЕ на імені. На обгортці він
                  обрізав рядок факту праворуч, і на вузькому екрані зникало саме
                  «не реклама і не лідген» — те єдине число, заради якого прохід.
                  Спіймав скріншот вузького екрана, жоден гейт цього не бачить. */}
              <span style={{ fontWeight: 560, fontSize: 12.5, minWidth: 0 }}>
                <span style={clip}><span style={{ color: MUTED, fontSize: 10 }}>{open ? "▾" : "▸"}</span> {m.name}</span>
                <MgrFactLine cs={m.createdSplit} />
              </span>
              <span style={{ textAlign: "right", color: MUTED }}>{fmtMoney(m.plan)}</span>
              <span style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6 }}><span style={{ width: 40, height: 6, background: "var(--bg)", borderRadius: 4, overflow: "hidden" }}><span style={{ display: "block", height: "100%", width: `${Math.min(100, m.pct ?? 0)}%`, background: zero ? "var(--border)" : pctColr, borderRadius: 4 }} /></span><b>{fmtMoney(m.revenue)}</b></span>
              <span style={{ textAlign: "right", fontWeight: 700, color: pctColr }}>{m.plan > 0 ? `${m.pct ?? 0}%` : "—"}</span>
              <span style={{ textAlign: "right", color: m.expectedThisMonth > 0 ? AMBER : MUTED }} title={`За плановою датою оплати — цей міс: ${fmtMoney(m.expectedThisMonth)} · наступний: ${fmtMoney(m.expectedNextMonth)}`}>{m.expectedThisMonth > 0 ? fmtMoney(m.expectedThisMonth) : "—"}</span>
              <span style={{ textAlign: "right", color: MUTED }}>{team.kind === "rnk" && m.conversion != null ? `${m.conversion}%` : "—"}</span>
              <Sparkline weeks={m.weeks} blocks={rep.weekBlocks} />
            </div>
            {open && (
              <div style={{ padding: "8px 16px 14px 30px", background: "rgba(37,99,235,0.03)", borderBottom: "1px solid var(--border)" }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, background: "var(--card-bg)", border: "1px solid var(--border)", borderLeft: `3px solid ${recCol(rec.level)}`, borderRadius: 9, padding: "9px 12px", marginBottom: 8 }}>
                  <div><span style={{ display: "block", fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 3, color: recCol(rec.level) }}>{rec.level === "ok" ? "Статус" : "Чому"}</span><div style={{ fontSize: 11.5, lineHeight: 1.5 }}>{rec.why}</div></div>
                  <div><span style={{ display: "block", fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 3, color: GREEN }}>Що робити</span><div style={{ fontSize: 11.5, lineHeight: 1.5 }}>{rec.action}</div></div>
                </div>
                {/* #4 два чеки менеджера · #2 очікування за плановою датою */}
                <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: 11.5, color: MUTED, marginBottom: 8 }}>
                  <span>чек успішно <b style={{ color: "var(--text)" }}>{m.avgCheck > 0 ? fmtMoney(m.avgCheck) : "—"}</b> <span style={{ fontSize: 10 }}>({m.successDeals} угод)</span></span>
                  <span>чек в очікуванні <b style={{ color: "var(--text)" }}>{m.avgCheckAwaiting == null ? "—" : fmtMoney(m.avgCheckAwaiting)}</b> <span style={{ fontSize: 10 }}>({m.awaitingDeals} угод)</span></span>
                  <span>очікуємо (план. дата) <b style={{ color: AMBER }}>{fmtMoney(m.expectedThisMonth)}</b> цей · <b>{fmtMoney(m.expectedNextMonth)}</b> наст. міс</span>
                </div>
                <ManagerDetailDrill managerId={m.managerId} from={rep.scope.from} to={rep.scope.to} />
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

const wkPct = (fact: number, plan: number) => (plan > 0 ? Math.round((fact / plan) * 100) : null);
const pctOf = (fact: number, plan: number | null): number | null => (plan && plan > 0 ? Math.round((fact / plan) * 100) : null);
const barColor = (p: number | null) => (p == null ? MUTED : p >= 100 ? GREEN : p >= 70 ? AMBER : RED);
type WeekLike = { plan: number; fact: number; expected: number; auto: number; autoRevenue?: number; leadsAd: number; leadsLeadgen: number; isCurrent: boolean; isFuture: boolean; pace: number | null };
// Фіксована ширина КОЖНОЇ тижневої колонки (команди, відділ, менеджери) — одна вертикальна
// сітка. table-layout:fixed + <colgroup> кріплять ці ширини, contain обрізає переповнення.
const WK_W = 94;
const wkTd = (bg?: string, clickable?: boolean): CSSProperties => ({
  width: WK_W, maxWidth: WK_W, boxSizing: "border-box", padding: "3px 7px", textAlign: "right",
  background: bg, cursor: clickable ? "pointer" : undefined, overflow: "hidden", verticalAlign: "middle",
});
const clip: CSSProperties = { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
// Компактна клітинка тижня — max 3 рядки: «факт /план» · бар(колір+темп) · «% ✓/✗ ↑↓».
// Очікування ЛИШЕ на майбутніх тижнях (минуле/поточне не дублює колонку «Очікуємо»).
// mode 'activity' → авто·ліди. onClick (лише командні) → менеджери цього тижня.
function WeekCell({ w, prev, mode, onClick, active }: { w: WeekLike | undefined; prev?: WeekLike; mode: "money" | "activity"; onClick?: () => void; active?: boolean }) {
  const bg = active ? "rgba(197,20,28,0.12)" : w?.isCurrent ? "rgba(37,99,235,0.07)" : undefined;
  const handle = onClick ? (e: { stopPropagation: () => void }) => { e.stopPropagation(); onClick(); } : undefined;
  if (!w) return <td style={{ ...wkTd(bg), textAlign: "center", color: MUTED, fontSize: 11 }}>—</td>;
  if (mode === "activity") return (
    <td onClick={handle} style={{ ...wkTd(bg, !!onClick), fontSize: 11 }}>
      {w.isFuture ? <span style={{ color: MUTED }}>—</span> : <>
        <div style={{ ...clip, fontWeight: 700 }}>{w.auto}<span style={{ fontWeight: 400, color: MUTED, fontSize: 10 }}> авто{w.autoRevenue ? ` · ${fmtMoney(w.autoRevenue)}` : ""}</span></div>
        <div style={{ ...clip, color: MUTED, fontSize: 10 }}>{w.leadsAd}р · {w.leadsLeadgen}лг</div>
      </>}
    </td>
  );
  if (w.isFuture) return (
    <td onClick={handle} style={{ ...wkTd(bg, !!onClick), fontSize: 10, color: MUTED }}>
      <div style={clip}>план {fmtMoney(w.plan)}</div>
      {w.expected > 0 && <div style={{ ...clip, color: AMBER }}>очік {fmtMoney(w.expected)}</div>}
    </td>
  );
  const p = wkPct(w.fact, w.plan), pp = prev ? wkPct(prev.fact, prev.plan) : null, col = barColor(p);
  const trend = p != null && pp != null ? (p > pp ? "↑" : p < pp ? "↓" : "") : "";
  return (
    <td onClick={handle} style={{ ...wkTd(bg, !!onClick), fontSize: 11 }}>
      <div style={{ ...clip, lineHeight: 1.25 }}><b>{fmtMoney(w.fact)}</b><span style={{ color: MUTED, fontSize: 10 }}> /{fmtMoney(w.plan)}</span></div>
      <div style={{ position: "relative", height: 5, background: "var(--border)", borderRadius: 3, margin: "2px 0" }}>
        <div style={{ width: `${Math.min(100, p ?? 0)}%`, height: "100%", background: col, borderRadius: 3 }} />
        {w.isCurrent && w.pace != null && <span title="темп: де мали б бути на сьогодні" style={{ position: "absolute", left: `${Math.min(100, Math.max(0, w.pace * 100))}%`, top: -1, bottom: -1, width: 1.5, background: "var(--text)", opacity: 0.65 }} />}
      </div>
      <div style={{ ...clip, color: col, fontWeight: 600, fontSize: 10, lineHeight: 1.1 }}>{p == null ? "—" : `${p >= 100 ? "✓" : "✗"} ${p}%`}{trend && <span style={{ color: trend === "↑" ? GREEN : RED, marginLeft: 3 }}>{trend}</span>}</div>
    </td>
  );
}

// #6: тижнево-скоупований дрил — менеджери ЦЬОГО тижня (факт/план тижня), клік → денний дрил
// саме цього тижня (ManagerDetailDrill з from/to = межі тижня). Не ламає «клік по команді».
function WeekManagerDrill({ team, weekIdx, weekBlocks }: { team: KvpTeam; weekIdx: number; weekBlocks: KvpReport["weekBlocks"] }) {
  const [openMgr, setOpenMgr] = useState<number | null>(null);
  const wb = weekBlocks.find((x) => x.idx === weekIdx);
  // 🔴 Е4: було `4 + (kind === "rnk" ? 1 : 0)` — тобто colSpan=5 у таблиці, що має
  // РІВНО 4 `<th>` (Менеджер · План тижня · Факт тижня · %). Зайвої колонки, яку
  // це нібито компенсувало, тут не існує; тип команди на структуру не впливає.
  const cols = 4;
  if (!wb) return null;
  const from = wb.from, to = wb.to;
  const rows = team.managers.map((m) => {
    const w = m.weeks?.find((x) => x.idx === weekIdx);
    return { m, plan: w?.plan ?? 0, fact: w?.fact ?? 0, expected: w?.expected ?? 0, isFuture: w?.isFuture ?? false };
  });
  return (
    <tr><td colSpan={6 + weekBlocks.length} style={{ padding: 0, background: "rgba(197,20,28,0.04)" }}>
      <div style={{ padding: "6px 12px", fontSize: 12, color: MUTED }}>📅 Т{weekIdx} ({from.slice(8)}–{to.slice(8)}) — менеджери цього тижня <span style={{ color: MUTED }}>(клік = дні тижня)</span></div>
      <table className="data-table" style={{ width: "100%", margin: 0, fontSize: 12 }}>
        <thead><tr><th style={{ paddingLeft: 28 }}>Менеджер</th><th style={{ textAlign: "right" }}>План тижня</th><th style={{ textAlign: "right" }}>Факт тижня</th><th style={{ minWidth: 70 }}>%</th></tr></thead>
        <tbody>
          {rows.map(({ m, plan, fact, expected, isFuture }) => {
            const pct = plan > 0 ? Math.round((fact / plan) * 100) : null;
            const open = openMgr === m.managerId;
            return (
              <Fragment key={m.managerId}>
                <tr onClick={() => setOpenMgr(open ? null : m.managerId)} style={{ cursor: "pointer" }}>
                  <td style={{ paddingLeft: 28 }}>{open ? "▾" : "▸"} {m.name}</td>
                  <td style={{ textAlign: "right", color: MUTED }}>{fmtMoney(plan)}</td>
                  <td style={{ textAlign: "right", fontWeight: 600 }}>{isFuture ? <span style={{ color: AMBER, fontWeight: 400 }}>очік {fmtMoney(expected)}</span> : fmtMoney(fact)}</td>
                  <td>{isFuture ? "—" : <span style={{ color: pctColor(pct), fontWeight: 600 }}>{pct == null ? "—" : `${pct >= 100 ? "✓" : "✗"} ${pct}%`}</span>}</td>
                </tr>
                {open && (
                  <tr><td colSpan={cols} style={{ padding: "8px 8px 12px 40px", background: "var(--card-bg)" }}>
                    <ManagerDetailDrill managerId={m.managerId} from={from} to={to} />
                  </td></tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </td></tr>
  );
}

function StructureBlock({ rep }: { rep: KvpReport }) {
  const rs = rep.revenueStructure;
  const rTotal = rs.received.total.revenue;
  const sumSeg = rs.received.new.revenue + rs.received.repeat.revenue + rs.received.unattributed.revenue;
  const reconcilesOk = Math.abs(sumSeg - rTotal) < 1;
  const seg = (label: string, recv: { deals: number; revenue: number }, exp: { deals: number; sum: number }, color: string) => (
    <div style={{ padding: 10, background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 10 }}>
      <div style={{ fontSize: 12, color: MUTED, fontWeight: 600 }}>{label}</div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
        <span style={{ fontSize: 11, color: MUTED, display: "flex", alignItems: "center", gap: 3 }}>Отримано<InfoHint text={HINT.structReceived} /></span>
        <span style={{ fontWeight: 700, color }}>{fmtMoney(recv.revenue)}</span>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span style={{ fontSize: 11, color: MUTED, display: "flex", alignItems: "center", gap: 3 }}>В очікуванні<InfoHint text={HINT.structExpected} /></span>
        <span style={{ fontWeight: 600, color: AMBER }}>{fmtMoney(exp.sum)}</span>
      </div>
    </div>
  );
  return (
    <>
      <h2 className="chart-title">💎 Структура виручки — 2 етапи <InfoHint text={HINT.newRepeat} /></h2>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {seg("Нові клієнти", rs.received.new, rs.expected.new, BLUE)}
        {seg("Постійні клієнти", rs.received.repeat, rs.expected.repeat, GREEN)}
      </div>
      <div style={{ marginTop: 8, fontSize: 12, color: MUTED, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 3 }}>Не віднесено (без клієнта): отримано <b style={{ color: "var(--text)" }}>{fmtMoney(rs.received.unattributed.revenue)}</b> <span style={{ color: MUTED }}>({rs.received.unattributed.deals} уг.)</span> · в очікуванні <b style={{ color: "var(--text)" }}>{fmtMoney(rs.expected.unattributed.sum)}</b> <span style={{ color: MUTED }}>({rs.expected.unattributed.deals} уг.)</span>{(rs.received.unattributed.revenue < 0 || rs.expected.unattributed.sum < 0) && <span style={{ color: MUTED }}> — мінус тут нормальний: у групі є сторно, і воно нетиться</span>}<InfoHint text={HINT.unattributed} /></span>
      </div>
      <div style={{ marginTop: 4, fontSize: 12, color: reconcilesOk ? GREEN : RED }}>
        {reconcilesOk ? "✅" : "⚠️"} Σ отримано (нові {fmtMoney(rs.received.new.revenue)} + постійні {fmtMoney(rs.received.repeat.revenue)} + залишок {fmtMoney(rs.received.unattributed.revenue)}) = {fmtMoney(sumSeg)} {reconcilesOk ? "==" : "≠"} каса {fmtMoney(rTotal)}
      </div>
    </>
  );
}

function RetentionBlock({ rep }: { rep: KvpReport }) {
  const mature = rep.retention.newToRepeat.filter((r) => r.mature).slice(-1)[0];
  const ab = rep.retention.activeBase.slice(-1)[0];
  return (
    <div style={{ display: "grid", gap: 8, fontSize: 13 }}>
      <span style={{ display: "flex", alignItems: "center", gap: 4 }}>% нових→постійних: <b>{mature ? fmtPct(mature.pct) : "⏳"}</b> {mature && <span style={{ color: MUTED }}>({mature.ym}, зрілий)</span>}<InfoHint text={HINT.newToRepeat} /></span>
      <span style={{ display: "flex", alignItems: "center", gap: 4 }}>Активність бази: <b>{fmtNum(ab?.activeClients ?? null)}</b> <span style={{ color: MUTED }}>клієнтів ({ab?.ym})</span><InfoHint text={HINT.activeBase} /></span>
      <span style={{ display: "flex", alignItems: "center", gap: 4 }}>Постійні щотижня: <b>{fmtNum(rep.retention.weeklyRegulars.clients)}</b><InfoHint text={HINT.weeklyRegulars} /></span>
      <span style={{ display: "flex", alignItems: "center", gap: 4 }}>Нецільові: <b>{rep.retention.nonTarget == null ? "—" : fmtNum(rep.retention.nonTarget)}</b><InfoHint text={HINT.nonTarget} /></span>
      <span style={{ display: "flex", alignItems: "center", gap: 4, color: MUTED }}>Погашено дебіторки: <b>історія не ведеться</b><InfoHint text={HINT.receivablesPaidOff} /></span>
    </div>
  );
}

// Блок A — повна таблиця: місяць (факт/план/%) + Т1–Т5 (факт/план) для показників з
// тижневою природою; ратіо/знімки — місяць-онлі (тижневі «—»). Місячний план ✎ КВП-ручних
// живо декомпозується на тижні за робочими днями. Нові метрики — окрема група.
function FullTable({ rep, plans, onSave }: { rep: KvpReport; plans: KvpPlans; onSave: (k: string, v: number | null) => void }) {
  const m = rep.money, en = rep.engines, nm = rep.newMetrics, wb = rep.weekBlocks;
  const [draft, setDraft] = useState<Record<string, number | null>>({});
  const planVal = (k: string): number | null => (k in draft ? draft[k] : (plans[k] ?? null));
  const wdMonth = wb.reduce((a, w) => a + w.workingDays, 0) || 1;
  const dw = (wi: number) => rep.deptWeeks.find((x) => x.idx === wi);
  const decomp = (monthPlan: number | null, wi: number) => (monthPlan == null ? null : monthPlan * (wb.find((w) => w.idx === wi)?.workingDays ?? 0) / wdMonth);
  const editCell = (k: string) => (
    <input type="number" value={planVal(k) ?? ""} placeholder="—"
      onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value === "" ? null : Number(e.target.value) }))}
      onBlur={(e) => onSave(k, e.target.value === "" ? null : Number(e.target.value))}
      style={{ width: 76, textAlign: "right", background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", padding: "1px 5px", fontSize: 12 }} />
  );
  // weekly cell: fact над plan (компактно, фікс.ширина). money/num formatter.
  const wkCell = (f: number | null, p: number | null, money: boolean) => {
    const fmt = money ? fmtMoney : (v: number) => fmtNum(Math.round(v));
    return (
      <td style={{ ...wkTd(), fontSize: 10 }}>
        {f == null && p == null ? <span style={{ color: MUTED }}>—</span> : <>
          <div style={{ ...clip, fontWeight: 700 }}>{f == null ? "—" : fmt(f)}</div>
          <div style={{ ...clip, color: MUTED }}>{p == null ? "" : `/${fmt(p)}`}</div>
        </>}
      </td>
    );
  };
  const dash = <td style={{ ...wkTd(), color: MUTED, fontSize: 10 }}>—</td>;
  type Row = { label: string; hint?: string; fact: string; pct?: number | null; planKey?: string; planFixed?: string;
    // weekly: per-idx {f,p} у сирих числах + money-прапор; null → «—»
    wk?: null | { money: boolean; f: (wi: number) => number | null; p: (wi: number) => number | null } };
  const sumDW = (k: "success" | "newRecv" | "repeatRecv" | "lostDeals" | "lostSum" | "expectedPlanned") => rep.deptWeeks.reduce((a, w) => a + (w[k] || 0), 0);
  const groups: [string, Row[]][] = [
    ["💰 Дохід (тижнева природа — факт/план по Т1–Т5)", [
      { label: "Отримано (каса)", hint: HINT.received, fact: fmtMoney(m.received.revenue), planFixed: fmtMoney(rep.strategicPlan) + " 🔒", pct: rep.verdict.planPct,
        wk: { money: true, f: (wi) => dw(wi)?.fact ?? null, p: (wi) => dw(wi)?.plan ?? null } },
      { label: "Успішно закриті (142)", hint: "Статус 142 за датою закриття, по тижнях. План КВП декомпозується на тижні.", fact: fmtMoney(sumDW("success")), planKey: "success_plan", pct: pctOf(sumDW("success"), planVal("success_plan")),
        wk: { money: true, f: (wi) => dw(wi)?.success ?? null, p: (wi) => decomp(planVal("success_plan"), wi) } },
      { label: "Нові — отримано", hint: "Каса нових клієнтів (перша оплата в періоді), по тижнях. План РНК декомпозується.", fact: fmtMoney(sumDW("newRecv")), planKey: "new_revenue_plan", pct: pctOf(sumDW("newRecv"), planVal("new_revenue_plan")),
        wk: { money: true, f: (wi) => dw(wi)?.newRecv ?? null, p: (wi) => decomp(planVal("new_revenue_plan"), wi) } },
      { label: "Постійні — отримано", hint: "Каса постійних клієнтів, по тижнях. План РПК декомпозується.", fact: fmtMoney(sumDW("repeatRecv")), planKey: "repeat_revenue_plan", pct: pctOf(sumDW("repeatRecv"), planVal("repeat_revenue_plan")),
        wk: { money: true, f: (wi) => dw(wi)?.repeatRecv ?? null, p: (wi) => decomp(planVal("repeat_revenue_plan"), wi) } },
      { label: "Дохід в очікуванні (план. дата)", hint: "Зона визнання за ПЛАНОВОЮ датою оплати (коли має зайти), по тижнях періоду.", fact: fmtMoney(sumDW("expectedPlanned")),
        wk: { money: true, f: (wi) => dw(wi)?.expectedPlanned ?? null, p: () => null } },
      { label: "Поставлені авто", hint: HINT.sent, fact: fmtNum(rep.verdict.lifecycle.sent.deals), planKey: "dispatched_cars", pct: pctOf(rep.verdict.lifecycle.sent.deals, planVal("dispatched_cars")),
        wk: { money: false, f: (wi) => dw(wi)?.auto ?? null, p: (wi) => decomp(planVal("dispatched_cars"), wi) } },
      { label: "Ліди реклама", hint: HINT.conversion, fact: fmtNum(rep.deptWeeks.reduce((a, w) => a + w.leadsAd, 0)), planKey: "ad_leads", pct: pctOf(rep.deptWeeks.reduce((a, w) => a + w.leadsAd, 0), planVal("ad_leads")),
        wk: { money: false, f: (wi) => dw(wi)?.leadsAd ?? null, p: (wi) => decomp(planVal("ad_leads"), wi) } },
      { label: "Ліди лідоген", hint: HINT.transferred, fact: fmtNum(rep.deptWeeks.reduce((a, w) => a + w.leadsLeadgen, 0)),
        wk: { money: false, f: (wi) => dw(wi)?.leadsLeadgen ?? null, p: () => null } },
      { label: "Втрачені (143)", hint: "Відмови (143 за датою закриття), к-сть по тижнях; сума в місяці.", fact: `${sumDW("lostDeals")} угод · ${fmtMoney(sumDW("lostSum"))}`,
        wk: { money: false, f: (wi) => dw(wi)?.lostDeals ?? null, p: () => null } },
    ]],
    ["🎯 Цілі-відношення (місяць-онлі: факт vs ціль ✎)", [
      { label: "Середній чек", hint: "Ціль КВП (звірка з листом 2600–2900). Відношення → без тижневої декомпозиції.", fact: "—", planKey: "avg_check", wk: null },
      { label: "CAC (вартість клієнта)", hint: `Факт: бюджет ${fmtMoney(nm.cacBudget)} ÷ ${nm.cacNewClients} нових. Ціль ✎.`, fact: nm.cac == null ? "—" : fmtFull(nm.cac), planKey: "cac_target", wk: null },
      { label: "Середній цикл угоди", hint: "Факт: днів створення→закриття (142). ⓘ created≈лід, closed≈оплата. Ціль ✎.", fact: nm.avgCycleDays == null ? "—" : `${nm.avgCycleDays} дн`, planKey: "cycle_target", wk: null },
      { label: "Конверсія реклами", hint: HINT.conversion, fact: en.ad.conversion == null ? "—" : `${en.ad.conversion}%${en.ad.mature ? "" : " ⏳"}`, planKey: "conversion_target", pct: en.ad.conversion != null && planVal("conversion_target") ? pctOf(en.ad.conversion, planVal("conversion_target")) : null, wk: null },
    ]],
    ["🔮 Похідні (місяць-онлі, без плану — по тижнях брехали б)", [
      { label: "Прогноз місяця", hint: HINT.projection, fact: `${fmtMoney(nm.forecast.projected)}${nm.forecast.projectedPct == null ? "" : ` (${nm.forecast.projectedPct}%)`}`, wk: null },
      { label: "Потрібний темп/день", hint: `Залишок плану ${fmtMoney(nm.remainingPlan)} ÷ ${nm.remainingWorkingDays} роб. днів, що лишились.`, fact: nm.neededPacePerDay == null ? "—" : `${fmtMoney(nm.neededPacePerDay)}/день`, wk: null },
      { label: "Прострочена оплата", hint: "planned_payment_at минув, угода ще не оплачена (не 142/143, не етап 9). Знімок «зараз».", fact: `${fmtMoney(nm.overduePayments.sum)} · ${nm.overduePayments.count} угод`, wk: null },
    ]],
  ];
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="data-table" style={{ width: "100%", tableLayout: "fixed", minWidth: 520 + wb.length * WK_W }}>
        <colgroup><col style={{ width: 210 }} /><col style={{ width: 128 }} /><col style={{ width: 96 }} /><col style={{ width: 64 }} />{wb.map((w) => <col key={w.idx} style={{ width: WK_W }} />)}</colgroup>
        <thead><tr>
          <th>Показник</th><th style={{ textAlign: "right" }}>Місяць (факт)</th><th style={{ textAlign: "right" }}>План ✎</th><th>%</th>
          {wb.map((w) => <th key={w.idx} style={{ textAlign: "right", fontSize: 10, background: w.isCurrent ? "rgba(37,99,235,0.08)" : undefined }}>Т{w.idx}</th>)}
        </tr></thead>
        <tbody>
          {groups.map(([grp, rows]) => (
            <Fragment key={grp}>
              <tr><td colSpan={4 + wb.length} style={{ fontWeight: 700, background: "var(--bg)", paddingTop: 8 }}>{grp}</td></tr>
              {rows.map((r) => (
                <tr key={grp + r.label}>
                  <td style={clip}><span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>{r.label}{r.hint && <InfoHint text={r.hint} />}</span></td>
                  <td style={{ textAlign: "right", fontWeight: 600 }}>{r.fact}</td>
                  <td style={{ textAlign: "right" }}>{r.planKey ? editCell(r.planKey) : r.planFixed ? <span style={{ color: MUTED, fontSize: 12 }}>{r.planFixed}</span> : <span style={{ color: MUTED }}>—</span>}</td>
                  <td>{r.pct == null ? <span style={{ color: MUTED }}>—</span> : <span style={{ color: pctColor(r.pct), fontWeight: 600, fontSize: 12 }}>{r.pct}%</span>}</td>
                  {wb.map((w) => r.wk ? wkCell(r.wk.f(w.idx), r.wk.p(w.idx), r.wk.money) : <Fragment key={w.idx}>{dash}</Fragment>)}
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

