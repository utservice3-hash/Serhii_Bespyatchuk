/**
 * «Нагадати» про аванс (кабінет): перемикач `POST /payroll/me/advance-remind` → `{ on, day }`; коли заявки вже відкрито —
 * сервер відповідає 409 своїм текстом. Сповіщення в день відкриття шле джоба `payrollReminders` (09:00 за Києвом).
 * Стан — з `me.advanceRemind`, після дії — перечитуємо кабінет.
 */
import { useState } from "react";
import { api } from "../../api";
import { errText, type Obj } from "../api";
import { useToast } from "../../components/Toasts";

export function useAdvanceRemind(me: Obj, onChanged: () => Promise<void>) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const on = !!me.advanceRemind;
  const day = Number(me.live?.advance?.fromDay ?? me.settings?.advance?.fromDay ?? 25);
  async function toggle() {
    if (busy) return;
    setBusy(true);
    try {
      const r = (await api.post<{ on: boolean; day?: number }>("/payroll/me/advance-remind", {})).data;
      toast(r.on ? `Нагадаємо ${r.day ?? day}-го, коли відкриються заявки на аванс — у дзвіночку (і в Telegram, якщо його увімкнено).` : "Нагадування скасовано.");
      await onChanged();
    } catch (e) { toast(errText(e), { error: true }); }
    finally { setBusy(false); }
  }
  const label = on ? `Нагадаю ${day}-го ✓ · скасувати` : "Нагадати";
  return { on, busy, day, toggle, label };
}

/** Подія «показати угоди без ТТН» — кнопка в «Що зробити» → фільтр у «Мої угоди». */
export const DEALS_NO_TTN = "zc:deals-no-ttn";
