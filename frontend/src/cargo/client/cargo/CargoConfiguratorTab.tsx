/**
 * React-обгортка вкладки «Конфігуратор вантажу в авто». Уся логіка — у configurator.ts (той самий код, що в макеті v3).
 * Монтується один раз; зміна користувача — без перемонтування, стан розрахунку не губиться.
 * Відмінності від пакета: three — `loadThree` з нашого сервера (не `import('three')`); «адмін» — право `manage_cargo`
 * (admin, СЕО, ОД — рішення 12.10). Кнопку «Довідник» це лише ховає: межу тримає сервер (403).
 */
import { useEffect, useRef } from 'react';
import { mountCargoConfigurator, type CargoConfiguratorHandle, type CargoUser } from './configurator';
import { cargoApi, loadThree } from './api';
import './configurator.css';

export const CARGO_ADMIN_PERM = 'manage_cargo';

export default function CargoConfiguratorTab({ user }: { user: CargoUser }) {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<CargoConfiguratorHandle | null>(null);
  useEffect(() => {
    if (!host.current) return;
    const h = mountCargoConfigurator(host.current, {
      user, api: cargoApi, loadThree,
      isAdmin: u => u.role === 'admin',
    });
    handle.current = h;
    return () => { h.destroy(); handle.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (handle.current) handle.current.setUser(user); }, [user.id, user.role, user.name]);   // eslint-disable-line react-hooks/exhaustive-deps
  return <div ref={host} />;
}
