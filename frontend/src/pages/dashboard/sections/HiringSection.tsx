import { useCallback, useEffect, useState } from "react";
import { useToast } from "../../../components/Toasts";
import { fetchHiringMeta, fetchSecretsStatus, fetchTeamVaultStatus, hiringError, type HiringMeta } from "../../../api";
import { LS } from "../hiringView";
import type { Toast } from "./HiringShared";
import { HiringSchedule } from "./HiringSchedule";
import { HiringCandidates } from "./HiringCandidates";
import { HiringDaily } from "./HiringDaily";
import { HiringVacancies } from "./HiringVacancies";
import { HiringTraining } from "./HiringTraining";
import { HiringEmployees } from "./HiringEmployees";
import { HiringTeam } from "./HiringTeam";
import { HiringSummary } from "./HiringSummary";
import { OfferTemplatesTab } from "./HiringOffer";
import { HiringChurnTab, HiringExitTab } from "./HiringChurn";
import { PlannedTabCard, LiveTabNote, type PlannedTab } from "./HiringRoadmap";
import "./hiring.css";

/**
 * 🧑‍💼 «НАЙМ», прохід 1 (17.09.2026) — замість вкладок Google-таблиці «UTS Співробітники УКР»:
 * «Графік Іван» → Графік, «Кандидати UA» → Кандидати, «Щоденний звіт NEW» → Щоденний звіт.
 * Макет затвердив Іван (рекрутер). Доступ вирішує сервер (`access` у /meta):
 *  • edit — рекрутер (HR) і адмін-рівень: усі три вкладки;
 *  • lead — тімлід: лише «Кандидати» своєї команди після співбесіди з ним.
 */
type Tab = "sched" | "base" | "vac" | "train" | "daily" | "acc" | "tpl" | PlannedTab;

export function HiringSection() {
  const [meta, setMeta] = useState<HiringMeta | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(() => (LS.get("tab") as Tab) || "sched");
  const [nonce, setNonce] = useState(0);
  // Клік по числу кандидатів вакансії відкриває «Кандидатів» із фільтром (прохід 1a).
  const [vacFilter, setVacFilter] = useState<{ id: number; seq: number } | null>(null);

  const reloadMeta = useCallback(() => {
    fetchHiringMeta().then(setMeta).catch((e) => setErr(hiringError(e)));
  }, []);
  useEffect(reloadMeta, [reloadMeta, nonce]);
  // 🔐 «Доступи» бачить лише той, кому сервер відповідає (право `view_employee_secrets`). Не з токена:
  // право могли видати після входу, а сервер однаково гейтить кожен запит.
  const [canSecrets, setCanSecrets] = useState(false);
  useEffect(() => { fetchSecretsStatus().then(() => setCanSecrets(true)).catch(() => setCanSecrets(false)); }, []);
  // 👥 Тімлід (29.09.2026): «Співробітники» — люди й паролі СВОЄЇ команди (право `view_team_secrets`, межа — сервер).
  const [canTeam, setCanTeam] = useState(false);
  useEffect(() => { fetchTeamVaultStatus().then(() => setCanTeam(true)).catch(() => setCanTeam(false)); }, []);

  // 🔔 Спільне повідомлення дашборда (`components/Toasts.tsx`) — раніше тут жила своя копія.
  const toast: Toast = useToast();

  if (err) return <div className="chart-card"><b>Розділ «Найм» недоступний.</b> <span className="hr-muted">{err}</span></div>;
  if (!meta) return <p className="loading-text">Завантаження…</p>;
  if (meta.access === "none") return <div className="chart-card"><b>Розділ «Найм» недоступний для вашої ролі.</b></div>;

  // Усі сім вкладок затвердженого макета. Незроблені відкривають пояснення «що буде і чому ще немає»
  // (прохання Романа 17.09): людина бачить повну картину, а не гадає, чи вкладку забули.
  const tabs: [Tab, string][] = meta.access === "edit"
    ? [["sched", "Графік"], ["base", "Кандидати"], ["vac", "Вакансії"], ["train", "На навчанні"], ["daily", "Щоденний звіт"], ["tpl", "Шаблони"], ["emp", "Співробітники"], ["churn", "Плинність"], ["exit", "Exit-інтервʼю"], ["sum", "Зведення"]]
    : [["base", "Кандидати"], ["train", "На навчанні"], ["emp", "Співробітники"]];
  // «Співробітники» живі для тих, хто має право сейфу (імпорт кладе паролі туди); решті — пояснення.
  // «Зведення» живе (етап 2, 18.09.2026) для тих, хто редагує «Найм»; «Співробітники» — з правом сейфу.
  // «Плинність» і «Exit» (етап 5, 18.09.2026) — з реєстру, тож для тих самих, хто бачить «Співробітників».
  const planned = new Set<Tab>([...(canSecrets ? [] : [...(canTeam ? [] : ["emp" as Tab]), "churn" as Tab, "exit" as Tab]), ...(meta.access === "edit" ? [] : ["sum" as Tab])]);
  // «Доступи» злиті в «Співробітники» (18.09.2026): збережена стара вкладка веде туди.
  const want: Tab = tab === "acc" ? "emp" : tab;
  const active = tabs.some(([k]) => k === want) ? want : tabs[0][0];
  const pick = (t: Tab) => { setTab(t); LS.set("tab", t); };

  return (
    <div>
      <h1 className="page-title" style={{ marginBottom: 4 }}>Найм</h1>
      <p className="hr-muted" style={{ margin: "0 0 14px", fontSize: 13 }}>
        {meta.access === "edit"
          ? "Графік відкривається на сьогодні; клітинки редагуються на місці. Стрілки й смуга тижня ведуть на інші дні."
          : "Кандидати вашої команди після співбесіди з вами: прогрес і рішення «кандидат», «на навчанні», «менеджер»."}
      </p>
      <div className="hr-tabs">
        {tabs.map(([k, l]) => (
          <button key={k} className={active === k ? "on" : ""} onClick={() => pick(k)} title={planned.has(k) ? "Ще не зроблено — усередині пояснення чому" : undefined}>
            {l}{planned.has(k) && <span style={{ marginLeft: 6, fontSize: 10, opacity: 0.75 }}>скоро</span>}
          </button>
        ))}
      </div>
      {(active === "sched" || active === "base" || active === "vac" || active === "train" || active === "daily") && <LiveTabNote tab={active} />}
      {planned.has(active) && <PlannedTabCard tab={active as PlannedTab} />}
      {active === "sched" && <HiringSchedule meta={meta} toast={toast} onMetaStale={() => setNonce((n) => n + 1)} />}
      {active === "base" && <HiringCandidates key={vacFilter?.seq ?? 0} meta={meta} toast={toast} initialVacancyId={vacFilter?.id ?? null} onMetaStale={() => setNonce((n) => n + 1)} />}
      {active === "vac" && <HiringVacancies meta={meta} toast={toast} onChanged={() => setNonce((n) => n + 1)}
        onOpenCandidates={(id) => { setVacFilter({ id, seq: Date.now() }); pick("base"); }} />}
      {active === "emp" && canSecrets && <HiringEmployees toast={toast} />}
      {active === "emp" && !canSecrets && canTeam && <HiringTeam toast={toast} />}
      {active === "sum" && meta.access === "edit" && <HiringSummary />}
      {active === "tpl" && meta.access === "edit" && <OfferTemplatesTab toast={toast} />}
      {active === "churn" && canSecrets && <HiringChurnTab />}
      {active === "exit" && canSecrets && <HiringExitTab toast={toast} />}
      {active === "train" && <HiringTraining meta={meta} toast={toast} onChanged={() => setNonce((n) => n + 1)} />}
      {active === "daily" && <HiringDaily toast={toast} />}
    </div>
  );
}
