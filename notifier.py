import os
import json
import requests
import logging

logger = logging.getLogger(__name__)

TG_TOKEN = os.getenv("TG_TOKEN", "")
TG_CHAT_ID = os.getenv("TG_CHAT_ID", "")
TG_THREAD_ID = os.getenv("TG_THREAD_ID", "")

# JSON: {"3379102": "@username", ...}
_MANAGER_MAP: dict[str, str] = {}
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


def _base_payload(text: str) -> dict:
    payload = {
        "chat_id": TG_CHAT_ID,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    if TG_THREAD_ID:
        payload["message_thread_id"] = int(TG_THREAD_ID)
    return payload


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
