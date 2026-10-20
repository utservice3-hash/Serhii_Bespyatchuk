/**
 * Сторінка дашборда «Реєстри» (окремий пункт бокового меню). Поки що один реєстр — «Реєстр мінусових угод» (рішення Сергія 20.10).
 * Хто дивиться і що може — визначає сервер за сесією; пропсів користувача не треба.
 */
import { useState } from 'react';
import './registriesPage.css';
// Статичний імпорт (у пакеті вкладка вантажилась ліниво): дашборд збирається в ОДИН JS-чанк, гейт #225.
import MinusRegistryTab from './minusRegistry/MinusRegistryTab';

/** Назва — і в заголовку, і в пункті бокового меню. */
export const PAGE_TITLE = 'Реєстри';

export default function RegistriesPage() {
  const [n, setN] = useState(0);
  return (
    <div className="registries-page">
      <h1 className="rp-title">
        {PAGE_TITLE}
        {n > 0 && <span className="rp-cnt" title="Чекають вашої дії">{n}</span>}
      </h1>
      <MinusRegistryTab onCount={setN} />
    </div>
  );
}
