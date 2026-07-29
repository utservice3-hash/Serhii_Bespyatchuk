import type { Request, Response, NextFunction } from "express";
import { verifyToken, type AuthPayload, type Role } from "./auth.js";
import { tabForPath, roleHasTab, roleHasPerm, getRoleDef, scopeCompatRole } from "./rbac.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthPayload;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing authorization token" });
  }
  try {
    req.auth = verifyToken(header.slice("Bearer ".length));
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
  // 🔒 СЕРВЕРНИЙ TAB-ГЕЙТ: роут → вкладка; якщо ефективна роль не має вкладки → 403.
  // Не покладаємось на приховування у FE. Роути поза мапою (tab=null) — пропуск.
  const tab = tabForPath(req.originalUrl);
  if (tab && !roleHasTab(req.auth.roleKey, tab)) {
    return res.status(403).json({ error: "Доступ до цього розділу вимкнено для вашої ролі" });
  }
  // 🔒 SCOPE-КЛАМП за ЕФЕКТИВНОЮ роллю (кастовної теж), а не лише за синковою users.role.
  // Наявна per-route логіка клампить по auth.{role,managerId,teamId}; тут вирівнюємо їх під
  // data_scope РОЛІ. Ключове: власний/командний обсяг БЕЗ менеджера/команди = ПОРОЖНЬО
  // (managerId/teamId = -1), а не «усі дані» (раніше null → фільтр пропускався → company).
  const def = getRoleDef(req.auth.roleKey);
  const scope = def?.dataScope;
  if (scope === "own") {
    req.auth.role = "manager";
    if (req.auth.managerId == null) req.auth.managerId = -1;
  } else if (scope === "team") {
    req.auth.role = "team_lead";
    if (req.auth.teamId == null) req.auth.teamId = -1;
  } else if (scope === "company") {
    // Company-scope: вирівнюємо scope-compat роль LIVE під data_scope РОЛІ, а не під знімок
    // логіну. Для вбудованих — тотожність (admin→admin, kvp→company; нуль змін). Кастомна
    // company-роль (напр. hr), чий токен ще ніс 'manager' зі старого own-scope, стає 'company'
    // → перестає ловитись manager-гейтами (1Х1 blocker) і manager-гілкою створення задачі.
    // Робить зміну data_scope у налаштуваннях дієвою БЕЗ релогіну — як screens/perms.
    req.auth.role = scopeCompatRole(req.auth.roleKey, def);
  }
  // роль поза кешем → лишаємо як є (невідома роль уже 403 на tab-гейті вище).
  next();
}

/** Perm-гейт для write-роутів: право-дія з визначення ефективної ролі (напр. approve_plans). */
export function requirePerm(perm: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth || !roleHasPerm(req.auth.roleKey, perm)) {
      return res.status(403).json({ error: "Недостатньо прав для цієї дії" });
    }
    next();
  };
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    // auth.role — scope-compat (може бути 'company' для company-scope не-admin ролей);
    // порівняння з Role[] безпечне (жоден роут не передає 'company' у requireRole).
    if (!req.auth || !(roles as string[]).includes(req.auth.role)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    next();
  };
}
