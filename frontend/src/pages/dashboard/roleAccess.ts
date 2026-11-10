/**
 * 🔑 Тумблери ролі (Налаштування → Ролі та доступи): увімкнено лише те, що лежить у мапі ВЛАСНИМ ключем зі значенням `true`.
 *
 * 🔴 Привід (10.11.2026): `screen_access["constructor"]` при відсутньому ключі віддає не `undefined`, а вбудований
 * `Object.prototype.constructor` — функцію, тобто «правду». Екран показував «Конструктор документів» УВІМКНЕНИМ у ролі,
 * де його немає (так роль «Операційний директор» лишилась без Конструктора й ніхто цього не бачив), а клік по такому
 * тумблеру писав `false` замість `true`. Те саме з будь-яким ключем, що збігається з іменем із прототипу.
 */
export const isGranted = (map: Record<string, boolean>, key: string): boolean =>
  Object.hasOwn(map, key) && map[key] === true;

/** Нова мапа з перемкненим ключем — від того, що бачить людина, а не від прототипу. */
export const toggled = (map: Record<string, boolean>, key: string): Record<string, boolean> =>
  ({ ...map, [key]: !isGranted(map, key) });
