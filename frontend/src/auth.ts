export interface AuthPayload {
  userId: number;
  role: "admin" | "team_lead" | "manager" | "company";
  roleKey?: string;      // ефективний ключ ролі (для кастомних)
  screens?: string[];    // дозволені вкладки (screen_access) — косметика nav; сервер гейтить
  managerId: number | null;
  teamId: number | null;
}

export function getAuthPayload(): AuthPayload | null {
  const token = localStorage.getItem("token");
  if (!token) return null;
  try {
    const [, payload] = token.split(".");
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return json as AuthPayload;
  } catch {
    return null;
  }
}
