/**
 * 🏆 ФІКСАЦІЯ НОМІНАЦІЙ ТИЖНЯ — вівторок 08:00 за Києвом (рішення 21.09.2026) + догін на старті.
 *
 * Фіксує МИНУЛИЙ тиждень Пн–Нд. Ідемпотентна: зафіксований тиждень не чіпає (`freezeWeek` →
 * "already"), до вівторка 08:00 нічого не робить ("not-due"). Якщо сервер лежав у вівторок —
 * стартовий прогін зафіксує пізніше, і `frozen_at` чесно покаже, коли саме.
 */
import { freezeWeek } from "../core/nominations.js";
import { lastWeek } from "../core/nominationRules.js";

export async function runFreezeNominations(at: Date = new Date()): Promise<{ week: string; result: string }> {
  const { from } = lastWeek(at);
  const result = await freezeWeek(from, at);
  console.log(`freezeNominations: тиждень ${from} → ${result}`);
  return { week: from, result };
}
