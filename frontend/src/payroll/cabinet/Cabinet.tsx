/**
 * Кабінет «Моя зарплата» (ТЗ §7.2, макет `UTS_Moya_zarplata.html`): Огляд / Ціль (лише менеджер) / Виплати / Умови.
 * Простий кабінет (відділ не продає): Огляд / Виплати / Умови — без «Що зробити», плану, угод і калькулятора.
 * Дані — `ctx.me` (`/payroll/me`, лише свої); після кожної дії — `ctx.reloadMe()`. Посилання зі сповіщень:
 * `ctx.goExtra = { cab: home|goal|pay|terms, focus: id блоку }` — відкриваємо вкладку й прокручуємо до блоку.
 */
import { useEffect, useState } from "react";
import type { PayrollCtx } from "../PayrollSection";
import { Tabs } from "../ui";
import Overview, { type CabTab } from "./Overview";
import Goal from "./Goal";
import Payouts from "./Payouts";
import Terms from "./Terms";
import "./cabinet.css";

const LABELS: Record<CabTab, string> = { home: "Огляд", goal: "Ціль", pay: "Виплати", terms: "Умови" };

export default function Cabinet({ ctx }: { ctx: PayrollCtx }) {
  const me = ctx.me;
  const tabs: CabTab[] = me.simple || me.employee?.role !== "manager" ? ["home", "pay", "terms"] : ["home", "goal", "pay", "terms"];
  const want = ctx.goExtra?.cab as CabTab | undefined;
  const [tab, setTab] = useState<CabTab>(want && tabs.includes(want) ? want : "home");
  const [focus, setFocus] = useState<string | null>((ctx.goExtra?.focus as string | undefined) ?? null);

  // новий перехід зі сповіщення, поки кабінет відкритий: підхоплюємо під час рендеру (без каскаду ефектів)
  const [seenGo, setSeenGo] = useState(ctx.goExtra);
  if (ctx.goExtra !== seenGo) {
    setSeenGo(ctx.goExtra);
    const t = ctx.goExtra?.cab as CabTab | undefined;
    if (t && tabs.includes(t)) setTab(t);
    if (ctx.goExtra?.focus) setFocus(String(ctx.goExtra.focus));
  }
  // прокрутка до блоку після рендеру вкладки
  useEffect(() => {
    if (!focus) return;
    const t = setTimeout(() => {
      const el = document.getElementById(focus);
      if (el) { el.scrollIntoView({ behavior: "smooth", block: "start" }); el.classList.add("zc-flash"); setTimeout(() => el.classList.remove("zc-flash"), 1600); }
      setFocus(null);
    }, 80);
    return () => clearTimeout(t);
  }, [focus, tab]);

  const go = (t: CabTab, f?: string) => { if (tabs.includes(t)) setTab(t); if (f) setFocus(f); else window.scrollTo({ top: 0, behavior: "smooth" }); };
  const onChanged = () => ctx.reloadMe();

  if (!me.enrolled) return <div className="zp-empty">Вас ще немає в зарплаті — кабінет зʼявиться, щойно фінансист внесе ваші умови.</div>;
  return (
    <div className="zc">
      <div className="zc-tabs"><Tabs items={tabs.map((k) => ({ key: k, label: LABELS[k] }))} value={tab} onChange={(k) => go(k)} /></div>
      {tab === "home" && <Overview me={me} go={go} onChanged={onChanged} />}
      {tab === "goal" && <Goal me={me} />}
      {tab === "pay" && <Payouts me={me} onChanged={onChanged} />}
      {tab === "terms" && <Terms me={me} onChanged={onChanged} />}
    </div>
  );
}
