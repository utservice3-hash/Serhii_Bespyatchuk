// 🛡 Корінь класу «async-throw → вічне зависання» (інцидент 27.07, /overview).
//
// Express 4 НЕ ловить відхилений проміс, повернутий з async-роут-хендлера: reject летить
// у process.on("unhandledRejection") (index.ts) — процес виживає, АЛЕ відповідь HTTP
// НІКОЛИ не надсилається → запит висить → воркер PHP-FPM тримається до таймауту → під
// ранковим напливом пул воркерів вичерпується → edge 503 для всіх.
//
// Тут ми раз патчимо СПІЛЬНИЙ прототип express.Router так, щоб КОЖЕН verb-хендлер
// (get/post/…) був обгорнутий: і синхронний throw, і відхилений проміс ідуть у next(err)
// → error-middleware (index.ts) віддає швидкий 500 + лог. Так один баг у хендлері падає
// ЛОКАЛЬНО (500 на цей запит), а не кладе весь дашборд.
//
// Чому прототип, а не кожен роут: метод резолвиться по ланцюгу прототипів у МОМЕНТ
// виклику, тож патч діє на всі 20 роутерів, створених пізніше. app.get делегує у
// внутрішній Router, тож app-рівневі роути (health, SPA-fallback) теж покриті.
//
// Що НЕ чіпаємо: .use — щоб не поламати монтування суброутерів; там лише СИНХРОННІ
// requireAuth/requireRole, чиї throw Express і так ловить. Успішні хендлери не змінюються:
// повертаємо оригінальне значення, .catch навішується лише на проміс і не спрацьовує на
// успіху → ті самі коди й тіла. Error-middleware (arity 4) не обгортаємо.
//
// ⚠️ ІМПОРТУВАТИ ПЕРШИМ у index.ts — до імпортів роутерів, щоб патч стояв на місці, коли
// їхні модулі реєструють роути на етапі завантаження.
import express from "express";

type Next = (err?: unknown) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (...args: any[]) => unknown;

function wrap(fn: Handler): Handler {
  // error-middleware (4 арг) і не-функції (шляхи/масиви обробляються вище) — як є
  if (typeof fn !== "function" || fn.length === 4) return fn;
  return function wrapped(this: unknown, req: unknown, res: unknown, next: Next) {
    try {
      const out = fn.call(this, req, res, next);
      if (out && typeof (out as Promise<unknown>).then === "function") {
        (out as Promise<unknown>).catch(next);
      }
      return out;
    } catch (err) {
      next(err);
    }
  };
}

const VERBS = ["get", "post", "put", "patch", "delete", "all", "options", "head"] as const;
// express.Router === спільний прототип, з якого успадковують усі інстанси Router().
const proto = express.Router as unknown as Record<string, Handler>;

for (const verb of VERBS) {
  const orig = proto[verb];
  if (typeof orig !== "function") continue;
  proto[verb] = function patched(this: unknown, path: unknown, ...handlers: unknown[]) {
    // Перший аргумент verb-методу — завжди шлях; обгортаємо лише хендлери (і масиви їх).
    const wrapped = handlers.map((h) =>
      Array.isArray(h) ? h.map((x) => wrap(x as Handler)) : wrap(h as Handler),
    );
    return orig.call(this, path, ...wrapped);
  };
}

export {};
