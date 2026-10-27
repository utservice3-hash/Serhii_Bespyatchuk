import { useState } from "react";
import { fetchFinCalendarDue, type RecReminder } from "../api";
import { usePolling } from "../hooks/usePolling";
import { useToast } from "./Toasts";

/**
 * 🔔 НАГАДУВАННЯ «КАЛЕНДАРЯ ОПЛАТ» (задача #6369, 27.10.2026; канал «Б» — Роман): значок біля «Фінансів» = скільки оплат
 * мені платити (прострочені, сьогодні, за 3 дні — рахує сервер, `remindersFor`), і ОДНЕ повідомлення на день про кожну
 * оплату-дату: показані сьогодні ключі `id@дата` памʼятаються в localStorage до кінця дня, тож опитування кожні 10 хв
 * не дзвонить повторно. Лише тому, хто платить; лише в кого є право `view_private_finance`.
 */
export const FIN_TAB_EVENT = "finance:tab";
const LS_KEY = "finCal.reminded";
const money = (n: number) => `${Math.round(n).toLocaleString("uk-UA").replace(/ /g, " ")} ₴`;
const when = (r: RecReminder) => (r.days < 0 ? `прострочено ${-r.days} дн.` : r.days === 0 ? "сьогодні" : r.days === 1 ? "завтра" : `через ${r.days} дн.`);

function seen(today: string): string[] {
  try { const v = JSON.parse(localStorage.getItem(LS_KEY) ?? "null"); return v?.day === today && Array.isArray(v.keys) ? v.keys : []; } catch { return []; }
}
function remember(today: string, keys: string[]): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ day: today, keys })); } catch { /* приватний режим — повідомлення просто повториться */ }
}

export function useFinanceReminders(enabled: boolean, openFinance: () => void): number {
  const toast = useToast();
  const [n, setN] = useState(0);
  usePolling(() => {
    fetchFinCalendarDue().then((d) => {
      setN(d.items.length);
      const was = seen(d.today);
      const fresh = d.items.filter((r) => !was.includes(`${r.id}@${r.next}`));
      if (!fresh.length) return;
      remember(d.today, [...was, ...fresh.map((r) => `${r.id}@${r.next}`)]);
      const late = fresh.some((r) => r.days < 0);
      const text = fresh.length === 1 ? `«${fresh[0].name}» — ${money(fresh[0].amount)}, ${when(fresh[0])}`
        : `${fresh.map((r) => `«${r.name}» ${when(r)}`).join(", ")} · разом ${money(fresh.reduce((a, r) => a + r.amount, 0))}`;
      toast(text, { event: true, tone: late ? "warn" : "info", key: "fin-calendar-due", src: "Фінанси · Календар оплат", head: late ? "Є прострочена оплата" : "Скоро оплата",
        action: { label: "Відкрити", run: () => { try { localStorage.setItem("fin.tab", "calendar"); } catch { /* приватне вікно */ } openFinance(); window.dispatchEvent(new CustomEvent(FIN_TAB_EVENT, { detail: "calendar" })); } } });
    }).catch(() => undefined);
  }, 10 * 60_000, { immediate: true, enabled });
  return enabled ? n : 0;
}
