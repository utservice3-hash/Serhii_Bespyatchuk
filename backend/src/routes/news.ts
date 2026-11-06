import { Router } from "express";
import { isAdminScope, isAdminOrLead, tabsOfRole } from "../auth/rbac.js";
import { pool } from "../db/pool.js";
import { unreadSinceQuery, MARK_SEEN_SQL, unreadByIdQuery, maxVisibleIdQuery } from "../core/newsSeen.js";
import { newsScope, DELETE_SQL, NEWS_KIND_SQL, parseNewsKind } from "../core/newsVisibility.js";
import { requireAuth } from "../auth/middleware.js";

export const newsRouter = Router();
newsRouter.use(requireAuth);

/** Вручну публікуються лише новини компанії — вкладка «Загальні» (06.11.2026: інших вкладок немає). */
const CATEGORIES = ["company"];

/** Останні новини; `kind=general|tech` — вкладка «Загальні» чи «Технічні» (без нього — обидві). */
newsRouter.get("/", async (req, res) => {
  const kind = parseNewsKind(req.query.kind);
  // 🎯 Умови віддаємо БІЛДЕРУ разом із параметрами — він допише «живе» й аудиторію і
  //    поверне готовий WHERE. Клеїти фрагмент тут не можна: категорія необовʼязкова,
  //    тож номер параметра аудиторії плаває між $1 і $2.
  const conds: string[] = [];
  const pre: unknown[] = [];
  if (kind) conds.push(NEWS_KIND_SQL[kind]);
  const { where, params } = newsScope(tabsOfRole(req.auth!.roleKey), conds, pre);
  const result = await pool.query(
    `SELECT id, category, title, body, author, image_url, created_at
     FROM news ${where} ORDER BY created_at DESC LIMIT 100`,
    params
  );
  res.json({ news: result.rows });
});

newsRouter.post("/", async (req, res) => {
  if (!isAdminScope(req.auth!)) return res.status(403).json({ error: "Лише адміністратор" });
  const { category, title, body, imageUrl } = req.body ?? {};
  if (!CATEGORIES.includes(category) || !String(title ?? "").trim()) {
    return res.status(400).json({ error: "Категорія і заголовок обов'язкові" });
  }
  const author = await pool.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [
    req.auth!.userId,
  ]);
  const result = await pool.query(
    `INSERT INTO news (category, title, body, author, image_url) VALUES ($1, $2, $3, $4, $5)
     RETURNING id, category, title, body, author, image_url, created_at`,
    [category, String(title).trim(), body ?? null, author.rows[0]?.email ?? null, imageUrl ?? null]
  );
  res.json({ news: result.rows[0] });
});

newsRouter.delete("/:id", async (req, res) => {
  if (!isAdminScope(req.auth!)) return res.status(403).json({ error: "Лише адміністратор" });
  /* 🔴 МʼЯКО: рядок лишається, з видачі зникає. Фізичне видалення не лишало ні сліду,
     ні шляху назад — 07.09.2026 новина про викат зникла за годину, і єдиним доказом її
     існування була моя памʼять про id. Повторне видалення вже видаленої нічого не
     змінює (`AND deleted_at IS NULL`), тож дві вкладки не перезаписують одна одну. */
  const r = await pool.query(DELETE_SQL, [Number(req.params.id), req.auth!.userId]);
  res.json({ ok: true, removed: r.rowCount ?? 0 });
});

/**
 * 🔔 СКІЛЬКИ НОВИН ЗʼЯВИЛОСЬ ПІСЛЯ МОГО ВІЗИТУ — окремим роутом, а не полем у списку.
 *
 * Значок у меню треба ще ДО того, як людина відкрила вкладку; вішати його на видачу
 * самого списку означало б, що лічильник зʼявляється лише там, де він уже не потрібен.
 */
newsRouter.get("/unread", async (req, res) => {
  // 🎯 Вкладки читача рахуються ОДИН раз і йдуть в усі три запити цього роуту — інакше
  //    лічильник і «долистав досюди» могли б розійтися між собою в межах однієї відповіді.
  const tabs = tabsOfRole(req.auth!.roleKey);
  const mq = maxVisibleIdQuery(tabs);
  const max = await pool.query<{ max_id: number }>(mq.text, mq.params);
  const maxId = max.rows[0]?.max_id ?? 0;

  // 🔔 Свіжий бандл шле `sinceId` — мітку зі СВОГО браузера (localStorage), тож спільний
  //    логін підсвітку не поділяє. Несвіжий бандл `sinceId` не знає — тоді фолбек на стару
  //    колонку акаунта, щоб він не показав раптом «усе непрочитане» (той самий підхід, що
  //    `month`/`months` в 1×1: контракт не ламає стару збірку).
  const raw = req.query.sinceId;
  const sinceId = raw != null && raw !== "" ? Number(raw) : null;
  let unread: number;
  if (sinceId != null && Number.isFinite(sinceId)) {
    const q = unreadByIdQuery(Math.trunc(sinceId), tabs);
    const r = await pool.query<{ n: number }>(q.text, q.params);
    unread = r.rows[0]?.n ?? 0;
  } else {
    const u = await pool.query<{ news_seen_at: Date | null }>(
      `SELECT news_seen_at FROM users WHERE id = $1`, [req.auth!.userId]);
    const q = unreadSinceQuery((u.rows[0]?.news_seen_at ?? null) as unknown as string | null, tabs);
    const r = await pool.query<{ n: number }>(q.text, q.params);
    unread = r.rows[0]?.n ?? 0;
  }
  res.json({ unread, maxId });
});

/**
 * Відкрив вкладку — побачив. Повертаємо `maxId`, щоб браузер запамʼятав «долистав досюди»
 * у себе. Колонку акаунта теж рухаємо — вона лишається фолбеком для несвіжих бандлів
 * (час СЕРВЕРНИЙ, див. `core/newsSeen.ts`), але підсвітку більше не поділяє між людьми.
 */
newsRouter.post("/seen", async (req, res) => {
  await pool.query(MARK_SEEN_SQL, [req.auth!.userId]);
  const mq = maxVisibleIdQuery(tabsOfRole(req.auth!.roleKey));
  const max = await pool.query<{ max_id: number }>(mq.text, mq.params);
  res.json({ ok: true, maxId: max.rows[0]?.max_id ?? 0 });
});

// 🚚 «Орієнтовні ціни за 1 км» (GET/PUT /km-prices) прибрано 06.11.2026 разом із блоком на сторінці — рішення
// Романа. Таблиця `km_prices` лишається в базі (один запис від 30.07), її ніхто більше не читає.
