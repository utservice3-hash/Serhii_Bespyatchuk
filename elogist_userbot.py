"""
eLogist userbot — читає Telegram-групу "[Euro Logistic] - Дошка оголошень"
під звичайним юзер-акаунтом (MTProto/Telethon), а не через Bot API.

Навіщо: Telegram Bot API за дизайном НЕ доставляє боту повідомлення,
надіслані іншим ботом (TransNowBot), навіть якщо наш бот — адмін групи.
Юзер-акаунт же бачить усі повідомлення, включно з ботовими, тож саме він
може ловити заявки eLogist і передавати їх у наявну логіку створення ліда.

Конфігурація через env (усі три обовʼязкові, інакше слухач не стартує):
  TG_API_ID    — api_id з https://my.telegram.org
  TG_API_HASH  — api_hash з https://my.telegram.org
  TG_SESSION   — StringSession (згенерувати локально: scripts/elogist_login.py)

Опційно:
  ELOGIST_SOURCE_CHAT_ID — id групи (типово -1002141432610)
"""
import os
import time
import asyncio
import logging
import threading

logger = logging.getLogger(__name__)

API_ID = os.getenv("TG_API_ID", "")
API_HASH = os.getenv("TG_API_HASH", "")
SESSION = os.getenv("TG_SESSION", "")
SOURCE_CHAT_ID = int(os.getenv("ELOGIST_SOURCE_CHAT_ID", "-1002141432610"))

_started = False


def is_configured() -> bool:
    return bool(API_ID and API_HASH and SESSION)


def start_listener(on_message) -> None:
    """Запускає Telethon-слухач у фоновому треді (один раз).
    on_message(text: str) викликається на кожне нове повідомлення у вихідній
    групі, включно з повідомленнями ботів (TransNowBot)."""
    global _started
    if _started:
        return
    if not is_configured():
        logger.info(
            "eLogist userbot вимкнено: не задані TG_API_ID/TG_API_HASH/TG_SESSION"
        )
        return
    _started = True
    threading.Thread(target=_run, args=(on_message,), daemon=True).start()
    logger.info("eLogist userbot: фоновий тред запущено")


def _run(on_message) -> None:
    try:
        from telethon import TelegramClient, events
        from telethon.sessions import StringSession
    except ImportError:
        logger.error("eLogist userbot: telethon не встановлено — слухач вимкнено")
        return

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    async def _amain() -> None:
        client = TelegramClient(StringSession(SESSION), int(API_ID), API_HASH)

        @client.on(events.NewMessage(chats=SOURCE_CHAT_ID))
        async def _handler(event):  # noqa: ANN001
            text = event.message.message or ""
            if not text:
                return
            try:
                on_message(text)
            except Exception as e:  # noqa: BLE001
                logger.error("eLogist userbot on_message: %s", e)

        await client.connect()
        if not await client.is_user_authorized():
            logger.error(
                "eLogist userbot: сесія не авторизована — згенеруйте валідний "
                "TG_SESSION через scripts/elogist_login.py"
            )
            return
        me = await client.get_me()
        logger.info(
            "eLogist userbot підключено як @%s, слухаю чат %s",
            getattr(me, "username", "?"), SOURCE_CHAT_ID,
        )
        await client.run_until_disconnected()

    # Цикл перепідключення: якщо зʼєднання впало — пробуємо знову через 30 с.
    while True:
        try:
            loop.run_until_complete(_amain())
        except Exception as e:  # noqa: BLE001
            logger.error("eLogist userbot впав: %s; перепідключення за 30 с", e)
        time.sleep(30)
