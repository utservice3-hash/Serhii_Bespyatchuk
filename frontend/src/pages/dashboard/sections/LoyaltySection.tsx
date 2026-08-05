import { useEffect, useMemo, useState } from "react";
import type { AuthPayload } from "../../../auth";
import { fetchOrphanClients, fetchManagerOptions, type OrphanPool, type ManagerOption } from "../../../api";
import { ClientPlansSection } from "./ClientPlansSection";
import { ReactivationSection } from "./ReactivationSection";
import { OrphanPoolSection } from "./OrphanPoolSection";
import { ArchiveSection } from "./ArchiveSection";

/**
 * 🗂 РОЗДІЛ «КЛІЄНТИ» — ОДИН РОЗДІЛ, ЧОТИРИ РОБОТИ (макет власника 05.08.2026).
 *
 * 🔴 БУЛО: усі блоки стояли одним довгим полотном, і кожен новий робив його
 * гіршим. Вкладка тепер визначає, ЩО ти зараз робиш; лічильник показує, ДЕ є
 * робота, не змушуючи відкривати.
 *
 * ⚠️ СТАН ВКЛАДКИ ЖИВЕ В URL (`?tab=`), щоб посилання відкривалось у тому
 * самому місці. Використовуємо `replaceState`, а не `pushState`: інакше кожне
 * перемикання вкладки клало б запис в історію, і «назад» переставало б
 * означати «назад із розділу».
 *
 * 🗄 ВКЛАДКА «АРХІВ» ЗʼЯВИЛАСЬ (хвиля 2, 05.08.2026) — реєстр збудовано, тож
 * заглушки більше немає. Її бачать ті самі, хто має право архівувати
 * (КВП/ОД/адмін): показувати вкладку тому, кому сервер віддасть 403, означало б
 * запропонувати глухий кут.
 */
type Tab = "plan" | "react" | "pool" | "archive";

const TABS: { key: Tab; label: string }[] = [
  { key: "plan", label: "План місяця" },
  { key: "react", label: "Реактивація" },
  { key: "pool", label: "Нічийні" },
  { key: "archive", label: "Архів" },
];

function readTab(): Tab {
  const t = new URLSearchParams(window.location.search).get("tab");
  return t === "react" || t === "pool" || t === "archive" ? t : "plan";
}

export function LoyaltySection({ auth }: { auth: AuthPayload | null }) {
  const [tab, setTab] = useState<Tab>(readTab);
  const [pool, setPool] = useState<OrphanPool | null>(null);
  const [managers, setManagers] = useState<ManagerOption[]>([]);

  // Пул бачать лише керівники — менеджеру вкладку не показуємо взагалі
  // (сервер усе одно віддасть 403; ховаємо, щоб не пропонувати глухий кут).
  const canSeePool = auth != null && auth.role !== "manager";

  useEffect(() => {
    const u = new URL(window.location.href);
    u.searchParams.set("tab", tab);
    window.history.replaceState({}, "", u);
  }, [tab]);

  // 🔴 ЛІЧИЛЬНИК ПУЛУ — З ТИХ САМИХ ДАНИХ, ЩО Й САМА ВКЛАДКА. Окремий
  // COUNT-запит одного дня розійшовся б зі списком, і ми довго шукали б, чому
  // «27» не дорівнює кількості рядків.
  useEffect(() => {
    if (!canSeePool) return;
    fetchOrphanClients().then(setPool).catch(() => setPool(null));
    fetchManagerOptions().then(setManagers).catch(() => setManagers([]));
  }, [canSeePool]);

  // Архів — та сама межа, що на сервері (`isAdminScope`): КВП/ОД/адмін.
  const canSeeArchive = auth != null && (auth.role === "admin" || auth.role === "company");
  const visible = useMemo(
    () => TABS.filter((t) => (t.key !== "pool" || canSeePool) && (t.key !== "archive" || canSeeArchive)),
    [canSeePool, canSeeArchive]);
  const active = visible.some((t) => t.key === tab) ? tab : "plan";

  return (
    <div>
      <div className="page-header" style={{ marginBottom: 4 }}>
        <div>
          <div className="cl-crumb">Клієнти · {TABS.find((t) => t.key === active)?.label}</div>
          <h1 className="page-title">Клієнти</h1>
          <div className="cl-sub">
            Один розділ — чотири роботи. Вкладка визначає, що ти зараз робиш; лічильник показує, де є робота.
          </div>
        </div>
      </div>

      <div className="cl-tabs">
        {visible.map((t) => (
          <button key={t.key} className="cl-tab" aria-pressed={active === t.key} onClick={() => setTab(t.key)}>
            {t.label}
            {t.key === "pool" && pool != null && (
              <span className="cl-count" data-hot={pool.tiles.clients > 0 ? "1" : "0"}>{pool.tiles.clients}</span>
            )}
          </button>
        ))}
      </div>

      {active === "plan" && auth && <ClientPlansSection auth={auth} />}
      {active === "react" && auth && <ReactivationSection auth={auth} />}
      {active === "pool" && canSeePool && <OrphanPoolSection auth={auth} managers={managers} />}
      {active === "archive" && canSeeArchive && <ArchiveSection auth={auth} />}
    </div>
  );
}
