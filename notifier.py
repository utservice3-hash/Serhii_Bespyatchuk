import os
import json
import requests
import logging

logger = logging.getLogger(__name__)

TG_TOKEN = os.getenv("TG_TOKEN", "")
TG_CHAT_ID = os.getenv("TG_CHAT_ID", "")
TG_THREAD_ID = os.getenv("TG_THREAD_ID", "")

# Група "UTS | Контекст" — щотижневий звіт по рекламних кампаніях (п'ятниця).
# Звичайна група, без гілок-форумів — thread_id не потрібен.
TG_CHAT_ID_ADS = os.getenv("TG_CHAT_ID_ADS", "-453895294")
TG_THREAD_ID_ADS = os.getenv("TG_THREAD_ID_ADS", "")

# Група РНК (ЛІД ВЗЯТИЙ У РОБОТУ / ДЗВІНКИ / ДЗВІНКИ З САЙТУ)
TG_CHAT_ID_RNK = os.getenv("TG_CHAT_ID_RNK", "-1003779373880")
TG_THREAD_ID_RNK = "51"

# Група РНК — гілка для закритих угод (ЗАКРИТО - НЕ РЕАЛІЗОВАНО) — фолбек, якщо команда невідома
TG_THREAD_ID_RNK_CLOSED = "294"

# Група РНК — гілка "Відділ якості" (термінові сигнали ризику по угоді)
TG_THREAD_ID_QUALITY = "1571"

# Група РНК — гілка "Нецільові угоди" — фолбек, якщо команда невідома
TG_THREAD_ID_NONTARGET = "310"

# Окремі групи РНК на кожну команду: "закрито не реалізовано" і "нецільові угоди"
# в різних чатах/гілках для Михальчевської і Безпам'ятного.
_RNK_TEAM_ROUTES: dict[str, dict[str, str]] = {
    "Михальчевська": {
        "chat_id": "-1002925017503",
        "closed_thread": "2",
        "nontarget_thread": "1550",
        "tracking_thread": "6892",
    },
    "Безпам'ятний": {
        "chat_id": "-1002258732695",
        "closed_thread": "5341",
        "nontarget_thread": "13446",
        "tracking_thread": "13459",
    },
}

# Група РПК (нові заявки від лідогена)
TG_CHAT_ID_RPK = "-1004391044886"
TG_THREAD_ID_RPK = "3"

# Hardcoded map — overridden by MANAGER_MAP env var if set
_DEFAULT_MANAGER_MAP: dict[str, str] = {
    # Команда Яцика
    "3379102":  "@dmytro_yatsyk",      # Яцик Дмитро (керівник)
    "2013613":  "@sabaka88barabaka",   # Антипенко Олег
    "7347414":  "@artemG228",          # Свіржевський Артем
    "10022700": "@Galahad95",          # Мокляк Олександр
    "11739992": "@vikusia_h",          # Хомік Вікторія
    "12163420": "@semendm",            # Семенюк Дмитро

    # Команда Дмитрука
    "6062482":  "@Logist_dmytruk",     # Дмитрук Василь (керівник)
    "7863771":  "@gremry",             # Возович Антон
    "11295244": "@samokhvalov_sm",     # Самохвалов Сергій
    "11338832": "@fedorovsky_official",# Федоровський Іван

    # Команда Безпам'ятного
    "12644448": "@Andry_UTS",          # Безпам'ятний Андрій (керівник)
    "13689696": "@Zhechu",             # Чукін Євген
    "11293904": "@tgvdn",              # Крицька Діана
    "15192136": "@tarassss200",        # Палій Тарас
    "15354656": "@annteszi_s",         # Шендера Анастасія
    "15354672": "@misslesie",          # Борівець Олеся
    "15355168": "@a_l_e_xx_xx",        # Голоміна Олександра
    "15380780": "@ttorivrsh",          # Ворошилова Вікторія
    "15391908": "@katya_koval9",       # Коваль Катерина

    # Команда Михальчевської
    "12782896": "@darina_mx",          # Михальчевська Дарина (керівник)
    "13461608": "@litbfly",            # Андрусенко Богдана
    "13803600": "@l98989898l",         # Цалко Олександр
    "14083284": "@hoffmanivan",        # Гофман Іван
    "14431884": "@Edosj",              # Янчевський Едуард
    "14926076": "@CV01k",              # Панасюк Святослав
    "15227544": "@herelevychka",       # Герелевич Аліна
    "15227596": "@kkseniyaaa_11",      # Пехньо Ксенія
    "15279220": "@mmdschoc",           # Сугак Денис
    "12812476": "@syam_uts",           # Сердюк Ярослав

    # Команда Шаврової
    "12066792": "@lillly_aaa",         # Шаврова Лілія (керівник)
    "15040472": "@andriy_matsalak",    # Мацалак Андрій
    "15200560": "@Tanya_Seniv",        # Сенів Тетяна
    "15380676": "@irinabrateiko",      # Братейко Ірина
    "15414956": "@ggarkushyna",        # Гаркушина Юлія

    # Тендерний відділ
    "15317728": "@ggerto",             # Денисенко Микита
    "15336060": "@maasteron",          # Дьяков Денис
    "7181916":  "@nazarit_o",          # Шевчук Назар
}

_MANAGER_MAP: dict[str, str] = _DEFAULT_MANAGER_MAP.copy()
try:
    _raw = os.getenv("MANAGER_MAP", "")
    if _raw:
        _MANAGER_MAP = json.loads(_raw)
except Exception:
    pass


def get_manager_tag(user_id: int) -> str:
    tag = _MANAGER_MAP.get(str(user_id), "")
    return f" ({tag})" if tag else ""


def get_manager_name_by_id(user_id: int) -> str:
    tag = _MANAGER_MAP.get(str(user_id), "")
    return tag if tag else f"ID {user_id}"


def get_kommo_id_by_username(username: str) -> int | None:
    """Зворотний пошук: telegram @username -> kommo user_id (для особистих команд у DM)."""
    if not username:
        return None
    target = username.lower().lstrip("@")
    for kommo_id, tag in _MANAGER_MAP.items():
        if tag.lower().lstrip("@") == target:
            return int(kommo_id)
    return None


def send_personal_stats_buttons(chat_id: int, message_id: int | None = None) -> None:
    """Особисте меню статистики менеджера (взято/успіх/закрито/конверсія) в DM з ботом."""
    payload: dict = {
        "chat_id": chat_id,
        "text": "📊 Моя статистика — обери період:",
        "reply_markup": {
            "inline_keyboard": [[
                {"text": "Сьогодні", "callback_data": "mystats_1"},
                {"text": "7 днів", "callback_data": "mystats_7"},
                {"text": "30 днів", "callback_data": "mystats_30"},
            ]]
        },
    }
    if message_id:
        payload["reply_to_message_id"] = message_id
    try:
        requests.post(
            f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage",
            json=payload, timeout=10
        )
    except Exception as e:
        logger.error("send_personal_stats_buttons error: %s", e)


def _base_payload(text: str, chat_id: str = "", thread_id: str = "") -> dict:
    payload = {
        "chat_id": chat_id or TG_CHAT_ID,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    tid = thread_id or TG_THREAD_ID
    if tid:
        payload["message_thread_id"] = int(tid)
    return payload


def send_to_rnk_closed(text: str, team: str = "") -> bool:
    """Send closed-not-realized notification to the team's own RNK group/thread."""
    route = _RNK_TEAM_ROUTES.get(team)
    chat_id = route["chat_id"] if route else TG_CHAT_ID_RNK
    thread_id = route["closed_thread"] if route else TG_THREAD_ID_RNK_CLOSED
    if not TG_TOKEN or not chat_id:
        return False
    try:
        payload = _base_payload(text, chat_id=chat_id, thread_id=thread_id)
        resp = requests.post(
            f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage",
            json=payload, timeout=10
        )
        data = resp.json()
        if not data.get("ok"):
            logger.error("Telegram RNK closed error: %s", data)
            return False
        return True
    except Exception as e:
        logger.error("send_to_rnk_closed exception: %s", e)
        return False


def send_to_quality(text: str) -> bool:
    """Send urgent risk alert to the 'Відділ якості' thread (1571)."""
    if not TG_TOKEN or not TG_CHAT_ID_RNK:
        return False
    try:
        payload = _base_payload(text, chat_id=TG_CHAT_ID_RNK, thread_id=TG_THREAD_ID_QUALITY)
        resp = requests.post(
            f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage",
            json=payload, timeout=10
        )
        data = resp.json()
        if not data.get("ok"):
            logger.error("Telegram quality error: %s", data)
            return False
        return True
    except Exception as e:
        logger.error("send_to_quality exception: %s", e)
        return False


def send_to_nontarget(text: str, team: str = "") -> bool:
    """Send notification to the team's own 'Нецільові угоди' group/thread."""
    route = _RNK_TEAM_ROUTES.get(team)
    chat_id = route["chat_id"] if route else TG_CHAT_ID_RNK
    thread_id = route["nontarget_thread"] if route else TG_THREAD_ID_NONTARGET
    if not TG_TOKEN or not chat_id:
        return False
    try:
        payload = _base_payload(text, chat_id=chat_id, thread_id=thread_id)
        resp = requests.post(
            f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage",
            json=payload, timeout=10
        )
        data = resp.json()
        if not data.get("ok"):
            logger.error("Telegram nontarget error: %s", data)
            return False
        return True
    except Exception as e:
        logger.error("send_to_nontarget exception: %s", e)
        return False


def send_to_rnk_tracking(text: str, team: str = "") -> bool:
    """Send work-tracking notification (нова заявка / лід взято в роботу / дзвінки)
    to the team's own group/thread. Falls back to the shared РНК thread (51) for
    unknown teams."""
    route = _RNK_TEAM_ROUTES.get(team)
    chat_id = route["chat_id"] if route else TG_CHAT_ID_RNK
    thread_id = route["tracking_thread"] if route else TG_THREAD_ID_RNK
    if not TG_TOKEN or not chat_id:
        return False
    try:
        payload = _base_payload(text, chat_id=chat_id, thread_id=thread_id)
        resp = requests.post(
            f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage",
            json=payload, timeout=10
        )
        data = resp.json()
        if not data.get("ok"):
            logger.error("Telegram RNK tracking error: %s", data)
            return False
        return True
    except Exception as e:
        logger.error("send_to_rnk_tracking exception: %s", e)
        return False


def send_to_all_rnk_tracking(text: str) -> bool:
    """Дублює повідомлення в гілки трекінгу роботи ВСІХ команд РНК — для подій
    без конкретного відповідального (нерозібрані заявки), де невідомо, чию саме
    команду вони стосуватимуться."""
    ok = True
    for team in _RNK_TEAM_ROUTES:
        if not send_to_rnk_tracking(text, team):
            ok = False
    return ok


def _send_tracked(text: str, chat_id, thread_id) -> dict | None:
    """Шле повідомлення й повертає {chat_id, message_id} для подальшого видалення."""
    if not TG_TOKEN or not chat_id:
        return None
    try:
        payload = _base_payload(text, chat_id=chat_id, thread_id=thread_id)
        resp = requests.post(
            f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage", json=payload, timeout=10
        )
        data = resp.json()
        if data.get("ok"):
            return {"chat_id": str(chat_id), "message_id": data["result"]["message_id"]}
        logger.error("_send_tracked error: %s", data)
    except Exception as e:
        logger.error("_send_tracked exception: %s", e)
    return None


def send_unassigned_tracked(text_rnk: str, text_team: str | None = None) -> list[dict]:
    """Шле сповіщення про нерозібрану заявку в спільну РНК-групу + гілки трекінгу
    ВСІХ команд РНК. Повертає список рефів {chat_id, message_id} — щоб редагувати
    ці повідомлення, коли заявку візьмуть у роботу.

    Правило власника: тег тім-ліда лише в ОДНІЙ групі — спільній РНК-групі
    (`text_rnk`). У гілки трекінгу команд шлемо `text_team` (без тегу тім-ліда).
    Якщо `text_team` не задано — обидва однакові (сумісність)."""
    if text_team is None:
        text_team = text_rnk
    refs = []
    r = _send_tracked(text_rnk, TG_CHAT_ID_RNK, TG_THREAD_ID_RNK)
    if r:
        refs.append(r)
    for team, route in _RNK_TEAM_ROUTES.items():
        r = _send_tracked(text_team, route["chat_id"], route["tracking_thread"])
        if r:
            refs.append(r)
    return refs


def delete_tracked(refs: list[dict]) -> None:
    """Видаляє раніше надіслані повідомлення (список {chat_id, message_id})."""
    if not TG_TOKEN or not refs:
        return
    for ref in refs:
        try:
            requests.post(
                f"https://api.telegram.org/bot{TG_TOKEN}/deleteMessage",
                json={"chat_id": ref["chat_id"], "message_id": ref["message_id"]},
                timeout=10,
            )
        except Exception as e:
            logger.error("delete_tracked exception: %s", e)


def send_raw(text: str, chat_id, thread_id=None) -> dict:
    """Надсилає довільний текст у вказаний чат/тред, повертає відповідь Telegram.
    Порожній thread_id → загальна тема (без message_thread_id), БЕЗ фолбеку
    на дефолтний TG_THREAD_ID (на відміну від _base_payload)."""
    if not TG_TOKEN or not chat_id:
        return {"ok": False, "error": "no token/chat"}
    payload = {
        "chat_id": chat_id, "text": text,
        "parse_mode": "HTML", "disable_web_page_preview": True,
    }
    if thread_id:
        try:
            payload["message_thread_id"] = int(thread_id)
        except (ValueError, TypeError):
            pass
    try:
        resp = requests.post(
            f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage", json=payload, timeout=10
        )
        return resp.json()
    except Exception as e:
        return {"ok": False, "error": str(e)}


def edit_tracked(refs: list[dict], new_text: str, new_text_team: str | None = None) -> None:
    """Редагує раніше надіслані повідомлення (список {chat_id, message_id}) на
    новий текст — щоб оновлювати статус заявки в одному повідомленні без спаму.

    `new_text` — для спільної РНК-групи (з тегом тім-ліда); `new_text_team` —
    для гілок трекінгу команд (без тегу). Якщо `new_text_team` не задано —
    для всіх використовується `new_text` (сумісність)."""
    if not TG_TOKEN or not refs:
        return
    for ref in refs:
        text = new_text
        if new_text_team is not None and str(ref.get("chat_id")) != str(TG_CHAT_ID_RNK):
            text = new_text_team
        try:
            requests.post(
                f"https://api.telegram.org/bot{TG_TOKEN}/editMessageText",
                json={
                    "chat_id": ref["chat_id"],
                    "message_id": ref["message_id"],
                    "text": text,
                    "parse_mode": "HTML",
                    "disable_web_page_preview": True,
                },
                timeout=10,
            )
        except Exception as e:
            logger.error("edit_tracked exception: %s", e)


# Окремі групи РПК на кожну команду лідогенераторів для трекінгу роботи
# (нова заявка / лід взято в роботу / дзвінки). Тендерний — без власної гілки,
# фолбек на спільну групу РПК.
_RPK_TEAM_ROUTES: dict[str, dict[str, str]] = {
    "Шаврова": {"chat_id": "-1003239776842", "tracking_thread": "688"},
    "Дмитрук": {"chat_id": "-1002370766882", "tracking_thread": "6825"},
    "Яцик":    {"chat_id": "-1002363672295", "tracking_thread": "2354"},
}


def send_to_team_tracking(text: str, team: str = "") -> bool:
    """Routes 'трекінг роботи' (нова заявка / лід взято в роботу / дзвінки) to the
    manager's own team group/thread for both РНК and РПК teams. Falls back to the
    shared РПК group for teams without a dedicated route (e.g. Тендерний)."""
    route = _RNK_TEAM_ROUTES.get(team) or _RPK_TEAM_ROUTES.get(team)
    if not route:
        return send_to_rpk(text)
    chat_id = route["chat_id"]
    thread_id = route["tracking_thread"]
    if not TG_TOKEN or not chat_id:
        return False
    try:
        payload = _base_payload(text, chat_id=chat_id, thread_id=thread_id)
        resp = requests.post(
            f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage",
            json=payload, timeout=10
        )
        data = resp.json()
        if not data.get("ok"):
            logger.error("Telegram team tracking error: %s", data)
            return False
        return True
    except Exception as e:
        logger.error("send_to_team_tracking exception: %s", e)
        return False


# Гілки "Перший дотик по рекламі" — окремі для кожної команди РНК,
# плюс адмінська група для щоденного зведення.
_FIRST_TOUCH_ROUTES: dict[str, dict[str, str]] = {
    "Михальчевська": {"chat_id": "-1002925017503", "thread": "7689"},
    "Безпам'ятний": {"chat_id": "-1002258732695", "thread": "14232"},
}
TG_CHAT_ID_ADMIN_STATS = os.getenv("TG_CHAT_ID_ADMIN_STATS", "-1004407179676")
TG_THREAD_ID_ADMIN_STATS = os.getenv("TG_THREAD_ID_ADMIN_STATS", "6")


def send_to_first_touch(text: str, team: str = "") -> bool:
    """Сповіщення про перший дотик по рекламному ліду — у гілку команди РНК."""
    route = _FIRST_TOUCH_ROUTES.get(team)
    if not route or not TG_TOKEN:
        return False
    try:
        payload = _base_payload(text, chat_id=route["chat_id"], thread_id=route["thread"])
        resp = requests.post(
            f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage", json=payload, timeout=10
        )
        data = resp.json()
        if not data.get("ok"):
            logger.error("Telegram first_touch error: %s", data)
            return False
        return True
    except Exception as e:
        logger.error("send_to_first_touch exception: %s", e)
        return False


def send_to_admin_stats(text: str) -> bool:
    """Щоденне адмінське зведення (перший дотик по рекламі)."""
    if not TG_TOKEN or not TG_CHAT_ID_ADMIN_STATS:
        return False
    try:
        payload = _base_payload(text, chat_id=TG_CHAT_ID_ADMIN_STATS, thread_id=TG_THREAD_ID_ADMIN_STATS)
        resp = requests.post(
            f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage", json=payload, timeout=10
        )
        data = resp.json()
        if not data.get("ok"):
            logger.error("Telegram admin_stats error: %s", data)
            return False
        return True
    except Exception as e:
        logger.error("send_to_admin_stats exception: %s", e)
        return False


def send_to_rpk(text: str) -> bool:
    """Send message to РПК group."""
    if not TG_TOKEN or not TG_CHAT_ID_RPK:
        return False
    try:
        payload = _base_payload(text, chat_id=TG_CHAT_ID_RPK, thread_id=TG_THREAD_ID_RPK)
        resp = requests.post(
            f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage",
            json=payload, timeout=10
        )
        data = resp.json()
        if not data.get("ok"):
            logger.error("Telegram RPK error: %s", data)
            return False
        return True
    except Exception as e:
        logger.error("send_to_rpk exception: %s", e)
        return False


def send_to_rnk(text: str) -> bool:
    """Send message to РНК group (ЛІД ВЗЯТИЙ У РОБОТУ / ДЗВІНКИ events)."""
    if not TG_TOKEN or not TG_CHAT_ID_RNK:
        return False
    try:
        payload = _base_payload(text, chat_id=TG_CHAT_ID_RNK, thread_id=TG_THREAD_ID_RNK)
        resp = requests.post(
            f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage",
            json=payload, timeout=10
        )
        data = resp.json()
        if not data.get("ok"):
            logger.error("Telegram RNK error: %s", data)
            return False
        return True
    except Exception as e:
        logger.error("send_to_rnk exception: %s", e)
        return False


def send_message(text: str, with_stats_buttons: bool = False) -> bool:
    if not TG_TOKEN or not TG_CHAT_ID:
        logger.error("TG_TOKEN or TG_CHAT_ID not set")
        return False

    payload = _base_payload(text)

    if with_stats_buttons:
        payload["reply_markup"] = {
            "inline_keyboard": [[
                {"text": "📊 Сьогодні", "callback_data": "stats_today"},
                {"text": "📊 Тиждень", "callback_data": "stats_week"},
                {"text": "📊 Місяць", "callback_data": "stats_month"},
            ]]
        }

    try:
        resp = requests.post(
            f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage",
            json=payload, timeout=10
        )
        data = resp.json()
        if not data.get("ok"):
            logger.error("Telegram error: %s", data)
            return False
        logger.info("Telegram message sent ok")
        return True
    except Exception as e:
        logger.error("Telegram send exception: %s", e)
        return False


def send_dm_message(chat_id: int, text: str, message_id: int | None = None) -> None:
    """Надсилає звичайне повідомлення в приватний чат з ботом (без гілок групи)."""
    payload: dict = {"chat_id": chat_id, "text": text, "parse_mode": "HTML"}
    if message_id:
        payload["reply_to_message_id"] = message_id
    try:
        requests.post(
            f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage",
            json=payload, timeout=10
        )
    except Exception as e:
        logger.error("send_dm_message error: %s", e)


def send_ad_report(text: str) -> bool:
    """Щотижневий звіт по рекламних кампаніях. Йде в TG_CHAT_ID_ADS/TG_THREAD_ID_ADS,
    якщо налаштовано (бот доданий у потрібну групу), інакше у головний чат."""
    chat_id = TG_CHAT_ID_ADS or TG_CHAT_ID
    thread_id = TG_THREAD_ID_ADS if TG_CHAT_ID_ADS else TG_THREAD_ID
    if not TG_TOKEN or not chat_id:
        logger.error("send_ad_report: TG_TOKEN or chat_id not set")
        return False
    try:
        payload = _base_payload(text, chat_id=chat_id, thread_id=thread_id)
        resp = requests.post(
            f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage",
            json=payload, timeout=10
        )
        data = resp.json()
        if not data.get("ok"):
            logger.error("send_ad_report error: %s", data)
            return False
        return True
    except Exception as e:
        logger.error("send_ad_report exception: %s", e)
        return False


def send_ad_report_file(filename: str, file_bytes: bytes, caption: str = "") -> bool:
    """Надсилає xlsx-файл з деталізацією тижневого звіту по рекламі в ту саму
    групу/гілку, що й текстовий звіт (TG_CHAT_ID_ADS/TG_THREAD_ID_ADS)."""
    chat_id = TG_CHAT_ID_ADS or TG_CHAT_ID
    thread_id = TG_THREAD_ID_ADS if TG_CHAT_ID_ADS else TG_THREAD_ID
    if not TG_TOKEN or not chat_id:
        logger.error("send_ad_report_file: TG_TOKEN or chat_id not set")
        return False
    try:
        data = {"chat_id": chat_id, "parse_mode": "HTML"}
        if caption:
            data["caption"] = caption
        if thread_id:
            data["message_thread_id"] = thread_id
        files = {"document": (filename, file_bytes, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}
        resp = requests.post(
            f"https://api.telegram.org/bot{TG_TOKEN}/sendDocument",
            data=data, files=files, timeout=30,
        )
        result = resp.json()
        if not result.get("ok"):
            logger.error("send_ad_report_file error: %s", result)
            return False
        return True
    except Exception as e:
        logger.error("send_ad_report_file exception: %s", e)
        return False


def answer_callback(callback_query_id: str, text: str = "") -> None:
    try:
        requests.post(
            f"https://api.telegram.org/bot{TG_TOKEN}/answerCallbackQuery",
            json={"callback_query_id": callback_query_id, "text": text},
            timeout=5
        )
    except Exception:
        pass


def send_stats_message(chat_id: str | int, text: str, message_id: int | None = None) -> None:
    """Send stats as a reply or new message."""
    payload: dict = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
    }
    if TG_THREAD_ID:
        payload["message_thread_id"] = int(TG_THREAD_ID)
    if message_id:
        payload["reply_to_message_id"] = message_id

    try:
        requests.post(
            f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage",
            json=payload, timeout=10
        )
    except Exception as e:
        logger.error("send_stats_message error: %s", e)


def set_webhook(webhook_url: str) -> dict:
    resp = requests.post(
        f"https://api.telegram.org/bot{TG_TOKEN}/setWebhook",
        json={"url": webhook_url, "allowed_updates": ["callback_query", "message"]},
        timeout=10
    )
    return resp.json()


def get_webhook_info() -> dict:
    try:
        resp = requests.get(f"https://api.telegram.org/bot{TG_TOKEN}/getWebhookInfo", timeout=10)
        return resp.json()
    except Exception as e:
        return {"ok": False, "error": str(e)}


def test_bot() -> dict:
    if not TG_TOKEN:
        return {"ok": False, "error": "TG_TOKEN not set"}
    try:
        me = requests.get(f"https://api.telegram.org/bot{TG_TOKEN}/getMe", timeout=10).json()
        if not me.get("ok"):
            return {"ok": False, "error": "Invalid token", "detail": me}
    except Exception as e:
        return {"ok": False, "error": str(e)}

    if not TG_CHAT_ID:
        return {"ok": True, "bot": me["result"]["username"], "warning": "TG_CHAT_ID not set"}

    result = {
        "ok": True,
        "bot": me["result"]["username"],
        "chat_id": TG_CHAT_ID,
        "thread_id": TG_THREAD_ID or "not set",
    }
    sent = send_message("🔧 <b>Тест з'єднання</b>\nБот працює коректно.", with_stats_buttons=True)
    result["test_message_sent"] = sent
    return result
