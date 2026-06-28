"""
Одноразовий логін юзер-акаунта для eLogist userbot.

Запускати ЛОКАЛЬНО (не на Render), інтерактивно:

    pip install telethon
    TG_API_ID=12345 TG_API_HASH=xxxxx python scripts/elogist_login.py

Скрипт попросить номер телефону (того акаунта, що Є В ГРУПІ
"[Euro Logistic] - Дошка оголошень") і код підтвердження з Telegram.
Після успіху виведе рядок TG_SESSION — скопіюйте його в змінні
середовища Render (TG_SESSION=...). Цей акаунт має бути учасником групи.
"""
import os
from telethon.sync import TelegramClient
from telethon.sessions import StringSession

API_ID = int(os.environ["TG_API_ID"])
API_HASH = os.environ["TG_API_HASH"]

with TelegramClient(StringSession(), API_ID, API_HASH) as client:
    print("\n=== TG_SESSION (скопіюйте весь рядок у Render env) ===\n")
    print(client.session.save())
    print("\n====================================================\n")
