---
name: site-uts-edits-1110
description: "Правки сайту uts.ua із зустрічі 10.11.2026 — лише ЗАФІКСОВАНО, роботу не починали (Роман: «просто фіксуємо правки»)"
metadata:
  node_type: memory
  type: project
  originSessionId: 280a3016-caea-485a-a97a-5c2f8ad2b58a
  modified: 2026-11-10T15:35:28.891Z
---

Зустріч 10.11.2026 (Олександр/ЮТ СЕРВИС, Сергій, Юлія, Роман), розшифровка «Дашборд - розбір і правки (2 з 2)». Презентація: https://claude.ai/artifact/PgM3kkDQbsbKBHEqRs1QWV.
Роман 10.11: «роботу ще не робимо, просто фіксуємо правки» — нічого на сайті не міняти без окремого слова.

**Робимо (коли скажуть):**
1. Ціни грн/км → актуальні; цифри готує Юля.
2. Сторінки послуг (бульдозер, будматеріали, верстати, комбайни, небезпечні вантажі, авто; НЕ переїзд квартири) — правки по кожній на узгодження, робимо самі без Євгена.
3. llms.txt до кінця тижня; з'ясувати, чи потрібні різні мови.
4. Подати в Google 30 сторінок поза індексом.
5. Додати (не замінити) відомих клієнтів — список від Юлі.
6. Прибрати старі контакти (Сергій): розділ «5. Контактна інформація» — тел. +38(093)-234-75-62, dy@ut-service.com.ua, адреса вул. Нижньоключова 14, кв. 665. Лише 2 сторінки: id 12516 /oplata-i-vozvrat/ (рос.) і id 12502 /uk/oplata-ta-povernennja/ (укр.). Інші 6 збігів за «Нижн…ключ» — хибні (звичайний текст). Питання: чим замінити (сторінка про оплату/повернення має мати якийсь контакт).

**Спершу оцінити ризик для SEO:** українська за замовчуванням (Polylang default = ru), скорочення 448 заголовків, додавання клієнтів.
**Аналіз:** окупність перевезень/лідів по місту (Київ) — Роман обіцяв надіслати.
**Відхилено:** прибирати «24/7»/«2 години»/«7–9%», нові поля форми, Telegram/Viber, Київ за зразком Одеси.

**How to apply:** доступ є — wp-cli на сервері (~/uts.ua/www, префікс таблиць uts_), тема utservice; перед правкою — резервна копія. Див. [[seo-uts-ua-state]].

**16.11 — Роман: «давай робити llms.txt і подавати сторінки в гугл».**
Подано в Google (GSC → Перевірка URL → Надіслати запит), квота ~11/день: kejs-gruzoperevozka-po-gorodu, kejs-uslugi-gruzchikov, uk/poslugi/pereyizd-kvartyry, razlichnye-tovary, lvov/gruzoperevozki-samosvalom-lvov, chernivczi/vantazhoperevezennja-v-kicmani, lvov/perevozka-mebeli-lvov, chernivczi/ofisnij-pereizd-chernivci, kejs-mezhdunarodnaja-gruzoperevozka, oformlenie-gruza-i-tovarov, razreshenie-na-perevozku-opasnyh-gruzov (11). На 12-й — квота.
Лишилось (наступні дні): chernivczi/vantazhniki-chernivci, chernivczi/gruzoperevozki-v-storozhince, uk/yak-perevezty-sklad, sroki-tamozhennogo-oformleniya, uk/.../snd/tadzhykystan, uk/umovi-inkoterms-2010-chomu-ce-potribno-znati, chernovtsi/perevozka-negabaritnoj-tehniki-chernovcy, lvov/dachnyj-pereezd-lvov (8). Після переробки: budmaterialiv, buldozera, verstativ, kombajny (4). /perevozka-opasnykh-gruzov/ уже в індексі. Теги й 2 переадресації не подаємо.
llms.txt: чернетка seo-zvit/llms.txt у worktree beautiful-mayer — на сайт НЕ покладено, чекає погодження тексту Романом. Класти в /home/evraziat/uts.ua/www/llms.txt.
GSC-токен (режим Testing) оновлено 11.11 → протухне ~18.11.
