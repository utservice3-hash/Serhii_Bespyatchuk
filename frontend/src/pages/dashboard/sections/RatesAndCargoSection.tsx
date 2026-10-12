/**
 * 🧮🚚 Екран «Калькулятор ставок та вантажу» (12.10.2026) — перейменований «Калькулятор ставок», дві вкладки
 * (пакет Сергія `client/RatesAndCargoPage.tsx`, макет v3, екран V-17):
 *   «Розрахунок ставки»           — наявний `RatesSection` БЕЗ ЗМІН, відкривається за замовчуванням;
 *   «Конфігуратор вантажу в авто» — новий розділ.
 * Між собою не повʼязані (рішення 10.10). Вкладка — в адресі: `/rates?tab=cargo` відкриває конфігуратор.
 * Конфігуратор монтується при першому відкритті й далі лише ховається — розрахунок не губиться при перемиканні.
 *
 * Відмінність від пакета одна: БЕЗ `lazy()` — правило «один JS-чанк» (#225). Важке тут лише three.js, і воно
 * не в бандлі: вантажиться з нашого сервера при відкритті 3D (`cargo/client/cargo/api.ts → loadThree`).
 */
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { RatesSection } from "./RatesSection";
import CargoConfiguratorTab, { CARGO_ADMIN_PERM } from "../../../cargo/client/cargo/CargoConfiguratorTab";
import type { CargoUser } from "../../../cargo/client/cargo/configurator";
import { getAuthPayload } from "../../../auth";
import "../../../cargo/client/ratesAndCargoPage.css";

/** Назва екрана — і в заголовку, і в пункті бокового меню (`Layout.tsx`). */
export const PAGE_TITLE = "Калькулятор ставок та вантажу";
type Tab = "rate" | "cargo";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "rate", label: "Розрахунок ставки" },
  { id: "cargo", label: "Конфігуратор вантажу в авто" },
];

export function RatesAndCargoSection() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get("tab") === "cargo" ? "cargo" : "rate";
  const [cargoOpened, setCargoOpened] = useState(tab === "cargo");
  // похідний стан під час рендеру (не в ефекті): раз відкритий — лишається змонтованим і лише ховається
  if (tab === "cargo" && !cargoOpened) setCargoOpened(true);
  const setTab = (t: Tab) => setParams((p) => { const n = new URLSearchParams(p); if (t === "cargo") n.set("tab", "cargo"); else n.delete("tab"); return n; }, { replace: true });
  // «Адмін» конфігуратора = право manage_cargo (admin, СЕО, ОД). Лише ховає кнопку «Довідник» — межу тримає сервер.
  const user = useMemo<CargoUser>(() => {
    const a = getAuthPayload();
    return { id: String(a?.userId ?? ""), name: a?.email ?? "", role: a?.perms?.includes(CARGO_ADMIN_PERM) ? "admin" : "manager" };
  }, []);
  return (
    <div className="rates-cargo">
      <h1>{PAGE_TITLE}</h1>
      <nav className="screentabs" role="tablist" aria-label="Розділи калькулятора">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" id={`rc-tab-${t.id}`} aria-controls={`rc-panel-${t.id}`}
            aria-selected={tab === t.id} tabIndex={tab === t.id ? 0 : -1} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </nav>
      <div role="tabpanel" id="rc-panel-rate" aria-labelledby="rc-tab-rate" hidden={tab !== "rate"}><RatesSection /></div>
      <div role="tabpanel" id="rc-panel-cargo" aria-labelledby="rc-tab-cargo" hidden={tab !== "cargo"}>
        {cargoOpened && <CargoConfiguratorTab user={user} />}
      </div>
    </div>
  );
}
