import os
import requests
import logging

logger = logging.getLogger(__name__)

TG_TOKEN = os.getenv("TG_TOKEN", "")
TG_CHAT_ID = os.getenv("TG_CHAT_ID", "")
TG_THREAD_ID = os.getenv("TG_THREAD_ID", "")

# JSON: {"3379102": "@username", ...}
_MANAGER_MAP: dict[str, str] = {}
try:
    import json as _json
    _raw = os.getenv("MANAGER_MAP", "")
    if _raw:
        _MANAGER_MAP = _json.loads(_raw)
except Exception:
    pass


def get_manager_tag(user_id: int) -> str:
    tag = _MANAGER_MAP.get(str(user_id), "")
    return f" ({tag})" if tag else ""


def send_message(text: str) -> bool:
    if not TG_TOKEN or not TG_CHAT_ID:
        logger.error("TG_TOKEN or TG_CHAT_ID not set")
        return False

    url = f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage"
    payload = {
        "chat_id": TG_CHAT_ID,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    if TG_THREAD_ID:
        payload["message_thread_id"] = int(TG_THREAD_ID)

    try:
        resp = requests.post(url, json=payload, timeout=10)
        data = resp.json()
        if not data.get("ok"):
            logger.error("Telegram error: %s", data)
            return False
        logger.info("Telegram message sent ok, thread=%s", TG_THREAD_ID)
        return True
    except Exception as e:
        logger.error("Telegram send exception: %s", e)
        return False


def test_bot() -> dict:
    """Verify bot credentials and chat access."""
    if not TG_TOKEN:
        return {"ok": False, "error": "TG_TOKEN not set"}

    try:
        me = requests.get(
            f"https://api.telegram.org/bot{TG_TOKEN}/getMe", timeout=10
        ).json()
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

    # Try sending a test message
    sent = send_message("🔧 <b>Тест з'єднання</b>\nБот працює коректно.")
    result["test_message_sent"] = sent
    return result
