"""
Одноразовий логін юзер-акаунта для eLogist userbot (Pyrogram).

Запускати інтерактивно (локально або де є доступ до Telegram):

    pip install pyrogram tgcrypto
    TG_API_ID=12345 TG_API_HASH=xxxxx python scripts/elogist_login.py

Скрипт попросить номер телефону акаунта, що Є В ГРУПІ
"[Euro Logistic] - Дошка оголошень", код підтвердження з Telegram і, якщо
ввімкнено, пароль двоетапної перевірки. Після успіху виведе session_string —
скопіюйте його у змінну середовища Render (TG_SESSION=...).
"""
import os
import asyncio
from pyrogram import Client

API_ID = int(os.environ["TG_API_ID"])
API_HASH = os.environ["TG_API_HASH"]


async def main() -> None:
    async with Client(":memory:", api_id=API_ID, api_hash=API_HASH, in_memory=True) as app:
        s = await app.export_session_string()
        print("\n=== TG_SESSION (скопіюйте весь рядок у Render env) ===\n")
        print(s)
        print("\n====================================================\n")


asyncio.run(main())
