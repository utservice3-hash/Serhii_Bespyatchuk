/**
 * 📒 РЕЄСТР МІНУСОВИХ УГОД — /api/minus-deals/* (пакет Сергія, макет v5, 20.10.2026; ТЗ — `minusRegistry/` + задача 6466).
 *
 * Логіка — роутер пакета (`minusRegistry/router.ts`) без змін. Тут — лише стик із дашбордом, як ТЗ §3 п.4 і просить:
 *  1. Вхід — наш `requireAuth`; межа — вкладка `registries` першим оператором (її видано ролям, що мають доступ; решта — 403).
 *  2. `req.user = { id, name, role }` пакета — з нашої сесії: роль реєстру — `registryRoleOf` (одне місце), імʼя — як у
 *     «Опитуваннях» (`NAME_SQL`: менеджер CRM / картка співробітника / акаунт).
 *  3. Угоди — з нашого клієнта Kommo (`kommoDealSource`, спільний тротл і запобіжник), а не з окремого токена пакета.
 * Async-мідлвари `.use` наш патч `lib/asyncRoutes.ts` не обгортає — тому помилки тут явно йдуть у `next(err)`.
 */
import { kommoGet } from "../kommo/client.js";
import { kommoDealSource } from "../minusRegistry/kommoSource.js";
import { buildMinusDealsRouter } from "../minusRegistry/mount.js";

export { REGISTRIES_TAB } from "../minusRegistry/mount.js";
/** Дії людини чекають Kommo не довше 12 с (`deadlineMs`); фонова звірка (`jobs/minusRegistrySync.ts`) — без стелі. */
export const minusDealsRouter = buildMinusDealsRouter(kommoDealSource(kommoGet, { deadlineMs: 12_000 }));
