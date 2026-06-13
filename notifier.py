import os
import json
import requests
import logging

logger = logging.getLogger(__name__)

TG_TOKEN = os.getenv("TG_TOKEN", "")
TG_CHAT_ID = os.getenv("TG_CHAT_ID", "")
TG_THREAD_ID = os.getenv("TG_THREAD_ID", "")

# Група РНК (ЛІД ВЗЯТИЙ У РОБОТУ / ДЗВІНКИ / ДЗВІНКИ З САЙТУ)
TG_CHAT_ID_RNK = os.getenv("TG_CHAT_ID_RNK", "-1003779373880")
TG_THREAD_ID_RNK = "51"

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
    "14926076": "@cv01001",            # Панасюк Святослав
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
