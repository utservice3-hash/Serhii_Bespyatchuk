import { useCallback, useEffect, useRef, useState } from "react";
import { fetchClientPlans, type ClientPlansResp } from "../api";
import { clientPlansKey, clientPlansMemory } from "../pages/dashboard/clientPlansStore";

/**
 * 📋 СПИСОК ПОСТІЙНИХ КЛІЄНТІВ ДЛЯ ЕКРАНА — один вхід для «З ким говорити» і «Плани» (26.11.2026).
 *
 * Обидві вкладки беруть список звідси, а він — зі спільної пам'яті вкладки браузера (`clientPlansStore.ts`):
 * перемикання між ними більше не тягне 1,9 МБ заново. `load` — «я щойно щось змінив»: список перечитується
 * з сервера завжди. Відповідь, яку вже обігнало новіше читання (швидка зміна місяця, дія під час завантаження),
 * на екран не потрапляє.
 */
export function useClientPlans(userId: number | null, month: string): { data: ClientPlansResp | null; err: string | null; load: () => void } {
  const key = clientPlansKey({ userId, month });
  const [data, setData] = useState<ClientPlansResp | null>(() => (clientPlansMemory.peek(key) as ClientPlansResp | undefined) ?? null);
  const [err, setErr] = useState<string | null>(null);
  const req = useRef(0);
  const pull = useCallback((force: boolean) => {
    const n = ++req.current;
    setErr(null);
    clientPlansMemory.load(key, () => fetchClientPlans({ month }), force)
      .then((d) => { if (n === req.current) setData(d); })
      .catch((e) => { if (n === req.current) setErr(e?.response?.data?.error ?? "не вдалося завантажити"); });
  }, [key, month]);
  /** Після дії користувача: перечитати з сервера. Аргументи колбеків (`onSaved(value)`) свідомо ігноруються. */
  const load = useCallback(() => pull(true), [pull]);
  useEffect(() => pull(false), [pull]);
  return { data, err, load };
}
