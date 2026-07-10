import type { ReactElement } from "react";

// Команди діляться на РНК (робота з наявними клієнтами) і РПК (робота з потенційними
// клієнтами). Ніжний колір відокремлює типи в усіх випадаючих списках команд.
export function teamKind(name: string | null | undefined): "rnk" | "rpk" | "other" {
  const n = name ?? "";
  if (/\bРНК\b/i.test(n)) return "rnk";
  if (/\bРПК\b/i.test(n)) return "rpk";
  return "other";
}

const COLORS: Record<string, string> = { rnk: "#4f46e5", rpk: "#0d9488" }; // індиго / бірюзовий
export function teamColor(name: string | null | undefined): string | undefined {
  return COLORS[teamKind(name)];
}

/**
 * Кольорові <option> для селектів команд — РНК/РПК ніжно розділені кольором.
 * Замінює `teams.map(t => <option>{t.name}</option>)` в усіх дропдаунах.
 */
export function teamOptions(teams: { id: number; name: string }[]): ReactElement[] {
  return teams.map((t) => (
    <option key={t.id} value={t.id} style={{ color: teamColor(t.name) }}>
      {t.name}
    </option>
  ));
}
