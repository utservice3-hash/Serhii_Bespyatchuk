import type { ReactElement } from "react";

/**
 * Команди діляться на два відділи: нових клієнтів (рекламний напрям) і постійних клієнтів (повний цикл).
 * Ніжний колір відокремлює їх в усіх випадаючих списках команд.
 *
 * 🔢 Відділ — за НОМЕРОМ команди, а не за словом у назві (30.10.2026, задача 7371): назви приходять із Kommo,
 * і з них прибирають «РНК/РПК». Пошук слова в назві після перейменування тихо зробив би всі команди сірими.
 * Номери відділу нових клієнтів — ті самі, що `RNK_TEAM_IDS` у `backend/src/core/metrics.ts` (звіряє гейт).
 */
export const NEW_CLIENTS_TEAM_IDS: readonly number[] = [13, 15];
export const REPEAT_CLIENTS_TEAM_IDS: readonly number[] = [5, 6, 14];

export function teamKind(id: number | null | undefined): "rnk" | "rpk" | "other" {
  if (id != null && NEW_CLIENTS_TEAM_IDS.includes(id)) return "rnk";
  if (id != null && REPEAT_CLIENTS_TEAM_IDS.includes(id)) return "rpk";
  return "other";
}

const COLORS: Record<string, string> = { rnk: "#4f46e5", rpk: "#0d9488" }; // індиго / бірюзовий
export function teamColor(id: number | null | undefined): string | undefined {
  return COLORS[teamKind(id)];
}

/**
 * Кольорові <option> для селектів команд — відділи ніжно розділені кольором.
 * Замінює `teams.map(t => <option>{t.name}</option>)` в усіх дропдаунах.
 */
export function teamOptions(teams: { id: number; name: string }[]): ReactElement[] {
  return teams.map((t) => (
    <option key={t.id} value={t.id} style={{ color: teamColor(t.id) }}>
      {t.name}
    </option>
  ));
}
