---
name: seo-uts-ua-state
description: "SEO uts.ua — доступи (GSC https://uts.ua/ підтверджено файлом 03.11, GA4, Ads лише браузером) і перша діагностика 03.11"
metadata:
  node_type: memory
  type: project
  originSessionId: 280a3016-caea-485a-a97a-5c2f8ad2b58a
  modified: 2026-11-03T11:32:54.561Z
---

03.11.2026: Search Console для r.v.denysiuk@gmail.com — ресурс `https://uts.ua/` (префікс URL), підтверджено файлом
`google8557e8fe58d5485f.html` у `/home/evraziat/uts.ua/www` (поклав я за словом Романа «клади»; поруч чужий `google6ac…` — не чіпати;
у Yoast поле Google теж чуже — не міняти). Доступи до API: `~/.env.google` (GSC_SITE=https://uts.ua/), Cloud-проєкт uts-seo, режим Testing
→ refresh token живе 7 днів. Developer token Google Ads немає (ні в .env дашборду) — частотність брати вручну через Keyword Planner у Chrome.
Журналів доступу через SSH не видно (CageFS) — лише панель adm.tools.

Діагностика 03.11: індекс 864/894 (30 поза індексом: послуги будматеріали/бульдозер/верстати/авто/комбайни/небезпечні, Чернівці/Львів-підсторінки, 4 теги).
Тиждень 26.10–01.11: 632 кліки/56 820 показів. Найбільший недобір — Київ (попит ~35 тис/міс, ми на 18–29 місці); Одеса 4-те місце працює.

**Why:** на сайті є інший власник/підрядник SEO — правки сайту лише після з'ясування з Сергієм і за словом Романа.
**How to apply:** скрипти скіла в scratchpad сесії — ефемерні; access token живе 1 год, довгі прогони оновлювати.

04.11: діагностику завершено. Журнал — панель adm.tools → Мої сайти → www.uts.ua → «Звіти GoAccess» (місяць генерується ~2 хв;
пошук у Access Log — 12 с/запит, перебором не ганяти). Жовтень: AI-боти OpenAI 2 519 (ChatGPT-User 843), Claude 1 280; швидкість 428/0 повільних.
Безпека: xmlrpc.php відкритий (87 тис. POST за жовтень), wp-login 15 тис.; 503 — 4 417. Хостинг оплачено до 15.11.2026, диск 95%.
Пакет на затвердження: seo-zvit/ у worktree beautiful-mayer (PDF 18 пунктів + 7 картинок + telegram.txt).

10.11: презентація для керівництва «Сайт uts.ua — що змінюємо» https://claude.ai/artifact/PgM3kkDQbsbKBHEqRs1QWV (19 слайдів: 6 правок Юлії + Google + безпека, 8 рішень). Обхід 894 сторінок: «2 години» 894, «24/7» 673, «7–9%» 401, грн/км 623 (від 4 до 30), бренди 139, Telegram/Viber 0; рос 497 / укр 397.
Сайт віддає 403 на User-Agent «HeadlessChrome» — для скрінів ставити звичайний UA. Форма бере код країни з ipapi.co за IP (з Польщі — +48, це не вада).
10.11 refresh token Google протух (invalid_grant, режим Testing) — для GSC знову get_token.py з входом Романа або «Publish app».
