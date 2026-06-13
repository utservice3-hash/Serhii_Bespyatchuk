import os
import json
import logging
from datetime import datetime, timezone, timedelta
from flask import Flask, request, jsonify
from apscheduler.schedulers.background import BackgroundScheduler

import kommo
import notifier
import sheets
import ai_analyzer

SNAPSHOT_FILE = "/tmp/plan_snapshot.json"


def _load_snapshot() -> dict:
    try:
        with open(SNAPSHOT_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


def _save_snapshot(data: dict) -> None:
    try:
        with open(SNAPSHOT_FILE, "w") as f:
            json.dump(data, f)
    except Exception as e:
        logger.error("_save_snapshot: %s", e)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

app = Flask(__name__)

QUAL_PIPELINE_ID = 8921928
NEW_FROM_LIDOGEN = 69716164   # "НОВА ЗАЯВКА ВІД ЛІДОГЕНЕРАТОРА"
TAKEN_TO_WORK = 69693652      # "Лід взятий у роботу"
REMINDER_MINUTES = 20

PEREVOZY_PIPELINE_ID = 8921932  # Перевозки (Продажі повний цикл)
CLOSED_NOT_REALIZED = 143        # ЗАКРИТО І НЕ РЕАЛІЗОВАНО
WON_STATUS_ID = 142              # УСПІШНА УГОДА

# Telegram — гілка для звітів по плану
TG_PLAN_THREAD_ID = 175862

# Плани на червень 2026 {user_id: plan_amount}
MANAGER_PLANS: dict[int, int] = {
    # Команда Безпам'ятного (РНК) — план 260,000
    12644448: 25000,   # Безпам'ятний Андрій
    13689696: 60000,   # Чукін Євген
    11293904: 60000,   # Крицька Діана
    15192136: 40000,   # Палій Тарас
    15354672: 20000,   # Борівець Олеся
    15354656: 20000,   # Шендера Анастасія
    15355168: 20000,   # Голоміна Олександра
    15380780: 15000,   # Ворошилова Вікторія
    15391908: 15000,   # Коваль Катерина

    # Команда Михальчевської (РНК) — план 549,000
    12782896: 20000,   # Михальчевська Дарина
    14926076: 70000,   # Панасюк Святослав
    13803600: 100000,  # Цалко Олександр
    14083284: 70000,   # Гофман Іван
    14431884: 45000,   # Янчевський Едуард
    13461608: 160000,  # Андрусенко Богдана
    15227596: 27000,   # Пехньо Ксенія
    15279220: 27000,   # Сугак Денис
    15227544: 30000,   # Герелевич Аліна

    # Команда Дмитрука (РПК) — план 810,000
    6062482:  225000,  # Дмитрук Василь
    7863771:  150000,  # Возович Антон
    11338832: 110000,  # Федоровський Іван
    11295244: 325000,  # Самохвалов Сергій

    # Команда Шаврової (РПК) — план 185,000
    12066792: 110000,  # Шаврова Лілія
    15200560: 30000,   # Сенів Тетяна
    15040472: 45000,   # Мацалак Андрій

    # Команда Яцика (РПК) — план 845,000
    3379102:  0,       # Яцик Дмитро
    10022700: 100000,  # Мокляк Олександр
    7347414:  110000,  # Свіржевський Артем
    12163420: 350000,  # Семенюк Дмитро
    2013613:  185000,  # Антипенко Олег
    11739992: 100000,  # Хомік Вікторія

    # Тендерний відділ — план 200,000
    7181916:  200000,  # Шевчук Назар
}

TEAM_PLANS: dict[str, int] = {
    "Безпам'ятний": 275000,
    "Михальчевська": 549000,
    "Дмитрук": 810000,
    "Шаврова": 185000,
    "Яцик": 845000,
    "Тендерний": 200000,
}

# Назва команди у родовому відмінку для повідомлень
TEAM_GENITIVE: dict[str, str] = {
    "Безпам'ятний": "Безпам'ятного",
    "Михальчевська": "Михальчевської",
    "Дмитрук": "Дмитрука",
    "Шаврова": "Шаврової",
    "Яцик": "Яцика",
    "Тендерний": "Тендерного відділу",
}

MANAGER_TEAM: dict[int, str] = {
    12644448: "Безпам'ятний", 13689696: "Безпам'ятний",
    11293904: "Безпам'ятний", 15192136: "Безпам'ятний",
    15354672: "Безпам'ятний", 15354656: "Безпам'ятний",
    15355168: "Безпам'ятний", 15380780: "Безпам'ятний", 15391908: "Безпам'ятний",
    12782896: "Михальчевська", 14926076: "Михальчевська",
    13803600: "Михальчевська", 14083284: "Михальчевська",
    14431884: "Михальчевська", 13461608: "Михальчевська",
    15227596: "Михальчевська", 15279220: "Михальчевська",
    15227544: "Михальчевська",
    6062482: "Дмитрук", 7863771: "Дмитрук",
    11338832: "Дмитрук", 11295244: "Дмитрук",
    12066792: "Шаврова", 15200560: "Шаврова", 15040472: "Шаврова",
    3379102: "Яцик", 10022700: "Яцик", 7347414: "Яцик",
    12163420: "Яцик", 2013613: "Яцик", 11739992: "Яцик",
    7181916: "Тендерний", 15317728: "Тендерний", 15336060: "Тендерний",
}

# РНК — Михальчевська, Безпам'ятний
# РПК — Яцик, Дмитрук, Шаврова, Тендерний
RNK_TEAMS = {"Михальчевська", "Безпам'ятний"}
RPK_TEAMS = {"Яцик", "Дмитрук", "Шаврова", "Тендерний"}


def send_to_team_group(manager_id: int, text: str) -> bool:
    """Відправляє сповіщення в правильну групу (РНК або РПК) залежно від команди менеджера."""
    team = MANAGER_TEAM.get(manager_id, "")
    if team in RNK_TEAMS:
        return notifier.send_to_rnk(text)
    else:
        return notifier.send_to_rpk(text)

# In-memory: список успішних угод поточного місяця
# {lead_id, manager_id, amount, closed_at}
_won_log: list[dict] = []

# Менеджери, яких вже привітали з виконанням плану цього місяця
_plan_congrats_sent: set[int] = set()
_plan_congrats_month: int = datetime.now(timezone.utc).month

# Етапи з нерозібраними заявками (без відповідального)
UNASSIGNED_STATUSES = {
    69693648: "Неразобранное",
    69693656: "Дзвінки",
    69693660: "Дзвінки з сайту",
    69716160: "Дзвінок по пропущеному (реклама)",
}
ADMIN_USER_ID = 904923  # Admin — означає немає реального відповідального

# Тімліди РНК — для нерозібраних заявок (без відповідального)
ALL_SUPERVISORS = "@Andry_UTS @darina_mx"
# Всі тімліди (для інших сповіщень)
ALL_SUPERVISORS_ALL = "@dmytro_yatsyk @Logist_dmytruk @Andry_UTS @darina_mx @lillly_aaa"

# In-memory: lead_id -> {arrived_at, status_name, lead_name, last_reminded_count}
unassigned: dict[int, dict] = {}

# Менеджери команд Дарини і Андрія
DARINA_ANDRIY_TEAMS = {
    # Команда Михальчевської
    12782896, 13461608, 13803600, 14083284, 14431884,
    14926076, 15227544, 15227596, 15279220, 12812476,
    # Команда Безпам'ятного
    12644448, 13689696, 11293904, 15192136, 15354656,
    15354672, 15355168, 15380780, 15391908,
}

# Етапи з яких повторна передача НЕ викликає сповіщення
SKIP_FROM_STATUSES = {
    69693652,  # Лід взятий у роботу
    69693656,  # Дзвінки
    69693660,  # Дзвінки з сайту
    70419108,  # Дзвінки на мобільні
}

# Керівник для кожного менеджера: {manager_id: supervisor_tg}
SUPERVISOR_MAP = {
    # Команда Яцика (керівник @dmytro_yatsyk)
    2013613:  "@dmytro_yatsyk",   # Антипенко Олег
    7347414:  "@dmytro_yatsyk",   # Свіржевський Артем
    10022700: "@dmytro_yatsyk",   # Мокляк Олександр
    11739992: "@dmytro_yatsyk",   # Хомік Вікторія
    12163420: "@dmytro_yatsyk",   # Семенюк Дмитро

    # Команда Дмитрука (керівник @Logist_dmytruk)
    7863771:  "@Logist_dmytruk",  # Возович Антон
    11295244: "@Logist_dmytruk",  # Самохвалов Сергій
    11338832: "@Logist_dmytruk",  # Федоровський Іван

    # Команда Безпам'ятного (керівник @Andry_UTS)
    13689696: "@Andry_UTS",       # Чукін Євген
    11293904: "@Andry_UTS",       # Крицька Діана
    15192136: "@Andry_UTS",       # Палій Тарас
    15354656: "@Andry_UTS",       # Шендера Анастасія
    15354672: "@Andry_UTS",       # Борівець Олеся
    15355168: "@Andry_UTS",       # Голоміна Олександра
    15380780: "@Andry_UTS",       # Ворошилова Вікторія
    15391908: "@Andry_UTS",       # Коваль Катерина

    # Команда Михальчевської (керівник @darina_mx)
    13461608: "@darina_mx",       # Андрусенко Богдана
    13803600: "@darina_mx",       # Цалко Олександр
    14083284: "@darina_mx",       # Гофман Іван
    14431884: "@darina_mx",       # Янчевський Едуард
    14926076: "@darina_mx",       # Панасюк Святослав
    15227544: "@darina_mx",       # Герелевич Аліна
    15227596: "@darina_mx",       # Пехньо Ксенія
    15279220: "@darina_mx",       # Сугак Денис
    12812476: "@darina_mx",       # Сердюк Ярослав

    # Команда Шаврової (керівник @lillly_aaa)
    15040472: "@lillly_aaa",      # Мацалак Андрій
    15200560: "@lillly_aaa",      # Сенів Тетяна
    15380676: "@lillly_aaa",      # Братейко Ірина
    15414956: "@lillly_aaa",      # Гаркушина Юлія

    # Тендерний відділ (керівник @dmytro_yatsyk)
    15317728: "@dmytro_yatsyk",   # Денисенко Микита
    15336060: "@dmytro_yatsyk",   # Дьяков Денис
    7181916:  "@dmytro_yatsyk",   # Шевчук Назар
}


def _format_duration(minutes: float) -> str:
    """Форматує тривалість: 1 д. 3 год. 25 хв → замість 1405 хв."""
    total_min = int(minutes)
    days = total_min // (60 * 24)
    hours = (total_min % (60 * 24)) // 60
    mins = total_min % 60
    parts = []
    if days: parts.append(f"{days} д.")
    if hours: parts.append(f"{hours} год.")
    if mins or not parts: parts.append(f"{mins} хв.")
    return " ".join(parts)


def _is_working_hours() -> bool:
    """Пн–Пт, 09:00–18:30 за Києвом (UTC+3)."""
    now_kyiv = datetime.now(timezone.utc) + timedelta(hours=3)
    if now_kyiv.weekday() >= 5:
        return False
    h, m = now_kyiv.hour, now_kyiv.minute
    return (h > 9 or (h == 9 and m >= 0)) and (h < 18 or (h == 18 and m <= 30))


def _is_unassigned_hours() -> bool:
    """Пн–Нд, 09:00–18:30 за Києвом — для нерозібраних заявок."""
    now_kyiv = datetime.now(timezone.utc) + timedelta(hours=3)
    h, m = now_kyiv.hour, now_kyiv.minute
    return (h > 9 or (h == 9 and m >= 0)) and (h < 18 or (h == 18 and m <= 30))


def _weekend_duty_supervisor() -> str:
    """Повертає тег чергового тімліда у вихідні: сб→Дарина, нд→Андрій."""
    weekday = (datetime.now(timezone.utc) + timedelta(hours=3)).weekday()
    if weekday == 5:
        return "@darina_mx"
    if weekday == 6:
        return "@Andry_UTS"
    return ""


def _check_overdue_leads():
    """Runs every 5 min — reminds about leads not called within 20 min, then every 20 min until taken.
    Only sends between 09:00 and 18:30 Kyiv time, Mon–Fri."""
    if not _is_working_hours():
        return

    now = datetime.now(timezone.utc)
    for lead_id, info in list(pending.items()):
        age_min = (now - info["transferred_at"]).total_seconds() / 60
        if age_min < REMINDER_MINUTES:
            continue

        # Fire every 20 min: at 20, 40, 60, 80... minutes
        reminder_count = int(age_min // REMINDER_MINUTES)
        last_reminded = info.get("last_reminded_count", 0)
        if reminder_count <= last_reminded:
            continue

        responsible_id = info.get("responsible_id", 0)
        manager_name = info.get("manager", kommo.get_user_name(responsible_id))
        tg_tag = notifier.get_manager_tag(responsible_id)
        supervisor_tag = SUPERVISOR_MAP.get(responsible_id, "")
        lead_name = info.get("lead_name", f"Лід #{lead_id}")
        kommo_url = f"https://utsercice.kommo.com/leads/detail/{lead_id}"

        sup_part = f" {supervisor_tag}" if supervisor_tag else ""
        msg = (
            f"🚨 <b>Лід не опрацьований {_format_duration(age_min)}!</b>\n"
            f"👤 Менеджер: <b>{manager_name}</b>{tg_tag}{sup_part}\n"
            f"🏷 Назва: {lead_name}\n"
            f"❓ Чому не опрацьований лід?\n"
            f"🔗 <a href='{kommo_url}'>Відкрити лід #{lead_id}</a>"
        )
        notifier.send_message(msg)
        pending[lead_id]["last_reminded_count"] = reminder_count
        logger.info("Reminder #%d sent for lead %s (%.0f min)", reminder_count, lead_id, age_min)


def _send_plan_message(text: str) -> None:
    """Send message to plan thread. Splits if over Telegram 4096 char limit."""
    import requests as req
    tg_token = os.getenv("TG_TOKEN", "")
    tg_chat = os.getenv("TG_CHAT_ID", "")
    if not tg_token or not tg_chat:
        logger.error("_send_plan_message: TG_TOKEN or TG_CHAT_ID not set")
        return

    chunks = []
    if len(text) <= 4000:
        chunks = [text]
    else:
        # Розбиваємо по рядках, зберігаємо цілісність блоків
        lines = text.split("\n")
        chunk = ""
        for line in lines:
            if len(chunk) + len(line) + 1 > 4000:
                chunks.append(chunk)
                chunk = line
            else:
                chunk += ("\n" if chunk else "") + line
        if chunk:
            chunks.append(chunk)

    for chunk in chunks:
        try:
            r = req.post(
                f"https://api.telegram.org/bot{tg_token}/sendMessage",
                json={"chat_id": tg_chat, "text": chunk, "parse_mode": "HTML",
                      "message_thread_id": TG_PLAN_THREAD_ID,
                      "disable_web_page_preview": True},
                timeout=15,
            )
            data = r.json()
            if not data.get("ok"):
                logger.error("_send_plan_message TG error: %s | chunk_len=%d", data.get("description"), len(chunk))
            else:
                logger.info("_send_plan_message ok, msg_id=%s", data.get("result", {}).get("message_id"))
        except Exception as e:
            logger.error("_send_plan_message: %s", e)


def _build_progress_bar(fact: int, plan: int) -> str:
    if plan <= 0:
        return "—"
    pct = min(fact / plan, 1.0)
    filled = int(pct * 10)
    bar = "▓" * filled + "░" * (10 - filled)
    return f"{bar}  {int(pct * 100)}%"


_CONGRATS_HEADERS = [
    "🔥 Місяць закритий — план виконано!",
    "💎 Ціль досягнута, результат є!",
    "🚀 Ще один місяць у плюсі!",
    "⚡️ Фінішна пряма пройдена!",
    "🏁 Місяць зроблено — план закритий!",
    "🎯 Влучно в ціль — план виконано!",
]

_CONGRATS_FOOTERS = [
    "Так тримати — команда пишається! 💪",
    "Відмінна робота, продовжуй у тому ж темпі! 🔝",
    "Результат говорить сам за себе. Молодець! 👏",
    "Місяць зроблено — тепер цілимося вище! 🎯",
    "Команда бачить твій результат. Дякуємо! 🤝",
    "Сильний фінал — саме так і треба! 🔥",
]


def _check_plan_completion(responsible_id: int) -> None:
    """Перевіряє чи менеджер виконав план місяця. Якщо так — привітання в РНК."""
    import random
    global _plan_congrats_month, _plan_congrats_sent

    plan = MANAGER_PLANS.get(responsible_id, 0)
    if not plan:
        return

    # Скидаємо лічильник на початку нового місяця
    current_month = datetime.now(timezone.utc).month
    if current_month != _plan_congrats_month:
        _plan_congrats_sent = set()
        _plan_congrats_month = current_month

    if responsible_id in _plan_congrats_sent:
        return

    month_start_ts = int(datetime.now(timezone.utc).replace(day=1, hour=0, minute=0, second=0, microsecond=0).timestamp())

    def fetch_all(status_id: int, date_filter: bool = True) -> list:
        all_leads = []
        for page in range(1, 50):
            batch = kommo.get_pipeline_leads(
                PEREVOZY_PIPELINE_ID, status_id=status_id, page=page,
                with_custom_fields=True,
                closed_at_from=month_start_ts if date_filter else None
            ) or []
            all_leads.extend(batch)
            if len(batch) < 250:
                break
        return all_leads

    try:
        won = fetch_all(WON_STATUS_ID, date_filter=True)
        pay = fetch_all(69716460, date_filter=False)

        def deal_amount(lead: dict) -> int:
            if kommo.is_fictive_deal(lead):
                return 0
            amt = lead.get("price", 0) or 0
            return -amt if kommo.is_minus_deal(lead) else amt

        total = 0
        trucks = 0
        for lead in won + pay:
            if lead.get("responsible_user_id") == responsible_id:
                amt = deal_amount(lead)
                total += amt
                if amt != 0:
                    trucks += 1

        logger.info("Plan check for %s: fact=%d plan=%d trucks=%d", responsible_id, total, plan, trucks)

        if total < plan:
            return

        _plan_congrats_sent.add(responsible_id)

        manager_name = kommo.get_user_name(responsible_id)
        manager_tag = notifier.get_manager_tag(responsible_id).strip(" ()")
        supervisor_tag = SUPERVISOR_MAP.get(responsible_id, "")
        team = MANAGER_TEAM.get(responsible_id, "")
        pct = int(total / plan * 100)
        over = total - plan

        header = random.choice(_CONGRATS_HEADERS)
        footer = random.choice(_CONGRATS_FOOTERS)

        over_line = f"\n│ 📈 Перевиконання: +{over:,} грн" if over > 0 else ""
        record_line = "\n│ 🏆 Більше 110% — новий рекорд!" if pct >= 110 else ""
        sup_line = f"\n\n👔 {supervisor_tag} — твій менеджер закрив місяць ✅" if supervisor_tag else ""
        mgr_tag_line = f" {manager_tag}" if manager_tag else ""

        team_gen = TEAM_GENITIVE.get(team, team)
        msg = (
            f"{header}\n\n"
            f"👤 <b>{manager_name}</b>{mgr_tag_line}\n"
            f"🏢 Команда {team_gen}\n\n"
            f"┌─────────────────────┐\n"
            f"│ 💰 Факт: {total:,} грн\n"
            f"│ 🎯 План: {plan:,} грн\n"
            f"│ 🚛 Відправлено машин: {trucks}\n"
            f"│ 📊 {_build_progress_bar(total, plan)}{over_line}{record_line}\n"
            f"└─────────────────────┘\n\n"
            f"{footer}"
            f"{sup_line}"
        )
        send_to_team_group(responsible_id, msg)
        logger.info("Plan completion congrats sent for manager %s (%s)", responsible_id, manager_name)
    except Exception as e:
        logger.error("_check_plan_completion(%s): %s", responsible_id, e)


_BIG_DEAL_PHRASES = [
    "Результат неймовірний. Так тримати! 🔥",
    "Ось це рівень! Команда тебе бачить і захоплюється! 💪",
    "Молодець! Саме так і робляться великі місяці! 🚀",
    "Неймовірно! Продовжуй — ти задаєш планку для всіх! ⭐️",
    "Класно! Команда пишається таким результатом! 👏",
    "Так тримати! Це і є той рівень, до якого всі прагнуть! 🏆",
]

BIG_DEAL_THRESHOLD = 10_000  # грн


def _handle_big_deal_notification(lead_id: int, responsible_id: int, amount: int) -> None:
    import random
    if amount < BIG_DEAL_THRESHOLD:
        return

    manager_name = kommo.get_user_name(responsible_id)
    manager_tag = notifier.get_manager_tag(responsible_id).strip(" ()")
    supervisor_tag = SUPERVISOR_MAP.get(responsible_id, "")
    team = MANAGER_TEAM.get(responsible_id, "")
    kommo_url = f"https://utsercice.kommo.com/leads/detail/{lead_id}"

    phrase = random.choice(_BIG_DEAL_PHRASES)
    mgr_tag_line = f" {manager_tag}" if manager_tag else ""
    sup_line = f"  {supervisor_tag}" if supervisor_tag else ""

    team_gen = TEAM_GENITIVE.get(team, team)
    msg = (
        f"💥 <b>Велика угода перенесена в успіх!</b>\n\n"
        f"👤 <b>{manager_name}</b>{mgr_tag_line}{sup_line}\n"
        f"🏢 Команда {team_gen}\n\n"
        f"💰 <b>{amount:,} грн</b>\n\n"
        f"{phrase}"
    )
    send_to_team_group(responsible_id, msg)
    logger.info("Big deal notification: lead %s amount %d by %s", lead_id, amount, manager_name)


def _handle_won_deal(lead_id: int, responsible_id: int, amount: int) -> None:
    now = datetime.now(timezone.utc)
    _won_log.append({"lead_id": lead_id, "manager_id": responsible_id,
                     "amount": amount, "closed_at": now})
    logger.info("Won deal logged: lead %s by manager %s amount %d", lead_id, responsible_id, amount)
    _handle_big_deal_notification(lead_id, responsible_id, amount)
    if responsible_id in MANAGER_PLANS:
        _check_plan_completion(responsible_id)


def _send_daily_plan_report() -> None:
    """Щоденний звіт о 18:00 Київ — факт (Успіх + Оплата отримана) по менеджерах і командах."""
    now = datetime.now(timezone.utc)
    day_of_month = now.day
    days_in_month = 30
    tempo_pct = day_of_month / days_in_month
    month_start = int(now.replace(day=1, hour=0, minute=0, second=0, microsecond=0).timestamp())

    def fetch_all_leads(status_id: int, date_filter: bool = True) -> list:
        """Kommo повертає _total_items=0 для деяких статусів, але дані є.
        Тому перебираємо сторінки поки є результати."""
        all_leads = []
        for page in range(1, 50):
            batch = kommo.get_pipeline_leads(
                PEREVOZY_PIPELINE_ID, status_id=status_id, page=page,
                with_custom_fields=True,
                closed_at_from=month_start if date_filter else None
            ) or []
            all_leads.extend(batch)
            if len(batch) < 250:
                break
        return all_leads

    # WON — тільки угоди закриті в поточному місяці
    # Оплата отримана — всі угоди в цьому етапі (без фільтру по даті)
    won_leads = fetch_all_leads(WON_STATUS_ID, date_filter=True)
    pay_leads = fetch_all_leads(69716460, date_filter=False)

    def deal_amount(lead: dict) -> int:
        """Повертає суму з урахуванням знаку. Фіктивні = 0, мінусові = від'ємна."""
        if kommo.is_fictive_deal(lead):
            return 0
        amt = lead.get("price", 0) or 0
        return -amt if kommo.is_minus_deal(lead) else amt

    mgr_won: dict[int, int] = {}; mgr_wc: dict[int, int] = {}
    mgr_pay: dict[int, int] = {}; mgr_pc: dict[int, int] = {}
    for l in won_leads:
        uid = l.get("responsible_user_id", 0); amt = deal_amount(l)
        mgr_won[uid] = mgr_won.get(uid, 0) + amt
        if amt != 0:
            mgr_wc[uid] = mgr_wc.get(uid, 0) + 1
    for l in pay_leads:
        uid = l.get("responsible_user_id", 0); amt = deal_amount(l)
        mgr_pay[uid] = mgr_pay.get(uid, 0) + amt
        if amt != 0:
            mgr_pc[uid] = mgr_pc.get(uid, 0) + 1

    all_mgrs = set(mgr_won) | set(mgr_pay)
    mgr_tot = {uid: mgr_won.get(uid, 0) + mgr_pay.get(uid, 0) for uid in all_mgrs}
    mgr_trucks = {uid: mgr_wc.get(uid, 0) + mgr_pc.get(uid, 0) for uid in all_mgrs}

    team_facts: dict[str, int] = {}
    team_trucks: dict[str, int] = {}
    for uid, amt in mgr_tot.items():
        team = MANAGER_TEAM.get(uid)
        if team:
            team_facts[team] = team_facts.get(team, 0) + amt
            team_trucks[team] = team_trucks.get(team, 0) + mgr_trucks.get(uid, 0)

    total_fact = sum(v for uid, v in mgr_tot.items() if uid in MANAGER_TEAM)
    total_plan = sum(TEAM_PLANS.values())
    total_trucks = sum(v for uid, v in mgr_trucks.items() if uid in MANAGER_TEAM)

    def tempo(fact: int, plan: int) -> str:
        if not plan: return ""
        pct = fact / plan
        if pct >= tempo_pct: return "✅"
        elif pct >= tempo_pct * 0.7: return "🟡"
        return "🔴"

    # Завантажуємо знімок попереднього дня
    prev = _load_snapshot()
    prev_mgr: dict[str, dict] = prev.get("managers", {})
    prev_team: dict[str, dict] = prev.get("teams", {})
    prev_total_fact: int = prev.get("total_fact", 0)
    prev_total_trucks: int = prev.get("total_trucks", 0)

    def delta_str(cur: int, prev_val: int, unit: str = "грн") -> str:
        d = cur - prev_val
        if d == 0:
            return "без змін"
        sign = "+" if d > 0 else ""
        return f"{sign}{d:,} {unit}"

    # Тімліди команд {team: user_id}
    TEAM_LEAD: dict[str, int] = {
        "Безпам'ятний": 12644448,
        "Михальчевська": 12782896,
        "Дмитрук": 6062482,
        "Шаврова": 12066792,
        "Яцик": 3379102,
        "Тендерний": 7181916,
    }

    lines = [
        f"📊 <b>Звіт по плану — {now.strftime('%d.%m.%Y')} ({day_of_month}-й день)</b>",
        f"🎯 Місячний темп: <b>{int(tempo_pct * 100)}%</b> пройдено",
        f"📌 ✅ в темпі  🟡 трохи відстає  🔴 критично відстає\n",
    ]

    for team, team_plan in TEAM_PLANS.items():
        fact = team_facts.get(team, 0)
        trucks = team_trucks.get(team, 0)
        p_fact = prev_team.get(team, {}).get("fact", 0)
        p_trucks = prev_team.get(team, {}).get("trucks", 0)
        d_fact = fact - p_fact
        d_trucks = trucks - p_trucks

        # Заголовок команди
        lines.append(f"👥 <b>Команда {TEAM_GENITIVE.get(team, team)}</b>  {tempo(fact, team_plan)}")
        lines.append(f"   {_build_progress_bar(fact, team_plan)}  💰 {fact:,} / {team_plan:,} грн  🚛 {trucks} маш.")
        if prev_team:
            fact_part = f"+{d_fact:,} грн" if d_fact > 0 else ("без змін" if d_fact == 0 else f"{d_fact:,} грн")
            truck_part = f"  +{d_trucks} маш." if d_trucks > 0 else ""
            lines.append(f"   📈 За день: {fact_part}{truck_part}")

        # Менеджери команди — тімлід першим, решта за сумою
        team_lead_id = TEAM_LEAD.get(team)
        team_members = [(uid, mgr_tot.get(uid, 0)) for uid, t in MANAGER_TEAM.items() if t == team]
        team_members.sort(key=lambda x: (0 if x[0] == team_lead_id else 1, -x[1]))

        for i, (uid, total) in enumerate(team_members):
            is_last = (i == len(team_members) - 1)
            prefix = "   └" if is_last else "   ├"
            mgr_plan = MANAGER_PLANS.get(uid, 0)
            name = kommo.get_user_name(uid)
            tl_mark = " <b>(TL)</b>" if uid == team_lead_id else ""
            pct = f"{int(total / mgr_plan * 100)}%" if mgr_plan else "—"
            w = mgr_won.get(uid, 0); wc = mgr_wc.get(uid, 0)
            p = mgr_pay.get(uid, 0); pc = mgr_pc.get(uid, 0)
            tc = mgr_trucks.get(uid, 0)
            avg = int(total / tc) if tc else 0
            avg_str = f"  ср. чек {avg:,} грн" if avg else ""
            p_fact = prev_mgr.get(str(uid), {}).get("fact", 0)
            p_trucks = prev_mgr.get(str(uid), {}).get("trucks", 0)

            cont = "   │" if not is_last else "    "
            line = f"{prefix} {tempo(total, mgr_plan)} {name}{tl_mark}: <b>{total:,} грн</b> ({pct})  🚛 {tc} маш.{avg_str}"
            if w: line += f"\n{cont}    ✓ Успішно реалізовано: {w:,} грн / {wc} маш."
            if p: line += f"\n{cont}    ⏳ Оплата отримана: {p:,} грн / {pc} маш."
            if prev_mgr:
                d_f = total - p_fact
                d_t = tc - p_trucks
                f_part = f"+{d_f:,} грн" if d_f > 0 else ("без змін" if d_f == 0 else f"{d_f:,} грн")
                t_part = f"  +{d_t} маш." if d_t > 0 else ""
                line += f"\n{cont}    📈 За день: {f_part}{t_part}"
            lines.append(line)
        lines.append("")

    # Підсумок компанії
    d_total_fact = total_fact - prev_total_fact
    d_total_trucks = total_trucks - prev_total_trucks
    day_company = ""
    if prev_total_fact:
        f_part = f"+{d_total_fact:,} грн" if d_total_fact >= 0 else f"{d_total_fact:,} грн"
        t_part = f"  +{d_total_trucks} маш." if d_total_trucks > 0 else ""
        day_company = f"\n📈 За день: {f_part}{t_part}"

    total_pct = int(total_fact / total_plan * 100) if total_plan else 0
    lines.append(
        f"🏢 <b>Компанія загалом</b>\n"
        f"   {_build_progress_bar(total_fact, total_plan)}\n"
        f"   💰 <b>{total_fact:,} / {total_plan:,} грн ({total_pct}%)</b>\n"
        f"   🚛 <b>Машин відправлено: {total_trucks}</b>"
        f"{day_company}"
    )

    _send_plan_message("\n".join(lines))
    logger.info("Daily plan report sent")

    # Зберігаємо знімок поточного дня
    _save_snapshot({
        "date": now.strftime("%Y-%m-%d"),
        "total_fact": total_fact,
        "total_trucks": total_trucks,
        "teams": {t: {"fact": team_facts.get(t, 0), "trucks": team_trucks.get(t, 0)} for t in TEAM_PLANS},
        "managers": {str(uid): {"fact": mgr_tot.get(uid, 0), "trucks": mgr_trucks.get(uid, 0)} for uid in MANAGER_PLANS},
    })


def _send_month_end_report() -> None:
    """Щогодинний звіт в останній день місяця — тільки факт/план по Успішно реалізовано."""
    import calendar
    now = datetime.now(timezone.utc)
    kyiv_now = now + timedelta(hours=3)

    # Запускаємо тільки в останній день місяця, з 9:00 до 21:00 Київ
    last_day = calendar.monthrange(kyiv_now.year, kyiv_now.month)[1]
    if kyiv_now.day != last_day:
        return
    if not (9 <= kyiv_now.hour <= 21):
        return

    month_start_end = int(kyiv_now.replace(day=1, hour=0, minute=0, second=0, microsecond=0).timestamp())

    def fetch_all(status_id: int) -> list:
        all_leads = []
        for page in range(1, 20):
            batch = kommo.get_pipeline_leads(
                PEREVOZY_PIPELINE_ID, status_id=status_id, page=page,
                with_custom_fields=True, closed_at_from=month_start_end
            ) or []
            all_leads.extend(batch)
            if len(batch) < 250:
                break
        return all_leads

    def deal_amount(lead: dict) -> int:
        if kommo.is_fictive_deal(lead):
            return 0
        amt = lead.get("price", 0) or 0
        return -amt if kommo.is_minus_deal(lead) else amt

    won_leads = fetch_all(WON_STATUS_ID)

    mgr_fact: dict[int, int] = {}
    mgr_trucks: dict[int, int] = {}
    for l in won_leads:
        uid = l.get("responsible_user_id", 0)
        amt = deal_amount(l)
        mgr_fact[uid] = mgr_fact.get(uid, 0) + amt
        if amt != 0:
            mgr_trucks[uid] = mgr_trucks.get(uid, 0) + 1

    team_facts: dict[str, int] = {}
    team_trucks: dict[str, int] = {}
    for uid, amt in mgr_fact.items():
        team = MANAGER_TEAM.get(uid)
        if team:
            team_facts[team] = team_facts.get(team, 0) + amt
            team_trucks[team] = team_trucks.get(team, 0) + mgr_trucks.get(uid, 0)

    total_fact = sum(v for uid, v in mgr_fact.items() if uid in MANAGER_TEAM)
    total_plan = sum(TEAM_PLANS.values())
    total_trucks = sum(v for uid, v in mgr_trucks.items() if uid in MANAGER_TEAM)
    total_pct = int(total_fact / total_plan * 100) if total_plan else 0

    lines = [
        f"🏁 <b>ОСТАННІЙ ДЕНЬ МІСЯЦЯ — {kyiv_now.strftime('%d.%m.%Y')}</b>",
        f"🕐 Оновлення: {kyiv_now.strftime('%H:%M')}\n",
        f"<i>Тільки Успішно реалізовано</i>\n",
        "👥 <b>По командах:</b>",
    ]

    for team, plan in TEAM_PLANS.items():
        fact = team_facts.get(team, 0)
        trucks = team_trucks.get(team, 0)
        pct = int(fact / plan * 100) if plan else 0
        gap = plan - fact
        gap_line = f" (ще {gap:,} грн)" if gap > 0 else " ✅ план виконано!"
        lines.append(f"  {'✅' if fact >= plan else '🔴'} <b>{team}</b>: {fact:,} / {plan:,} грн ({pct}%){gap_line}  🚛 {trucks} маш.")

    lines.append("\n👤 <b>По менеджерах:</b>")
    for uid, fact in sorted(mgr_fact.items(), key=lambda x: x[1], reverse=True):
        if uid not in MANAGER_TEAM:
            continue
        plan = MANAGER_PLANS.get(uid, 0)
        name = kommo.get_user_name(uid)
        trucks = mgr_trucks.get(uid, 0)
        pct = int(fact / plan * 100) if plan else 0
        done = "✅" if fact >= plan else "🔴"
        gap = plan - fact
        gap_str = f"+{abs(gap):,}" if fact >= plan else f"-{gap:,}"
        lines.append(f"  {done} {name}: <b>{fact:,} грн</b> ({pct}%)  {gap_str} грн  🚛 {trucks} маш.")

    lines.append(
        f"\n📈 <b>Загальний факт: {total_fact:,} / {total_plan:,} грн ({total_pct}%)</b>\n"
        f"🚛 <b>Машин відправлено: {total_trucks}</b>\n"
        f"📊 {_build_progress_bar(total_fact, total_plan)}"
    )

    _send_plan_message("\n".join(lines))
    logger.info("Month-end hourly report sent at %s", kyiv_now.strftime("%H:%M"))


def _scan_unassigned_leads():
    """Scans Kommo API for unassigned leads in Кваліфікація and adds new ones to queue."""
    now = datetime.now(timezone.utc)
    for status_id, status_name in UNASSIGNED_STATUSES.items():
        try:
            leads = kommo.get_pipeline_leads(QUAL_PIPELINE_ID, status_id=status_id)
            for lead in leads:
                lid = lead.get("id")
                uid = lead.get("responsible_user_id", 0)
                if not lid or (uid and uid != ADMIN_USER_ID):
                    continue
                if lid in unassigned:
                    continue
                lead_name = lead.get("name", f"Лід #{lid}")
                source = kommo.get_lead_source(lead)
                # Використовуємо updated_at як реальний час появи в черзі
                updated_at = lead.get("updated_at", 0)
                arrived = datetime.fromtimestamp(updated_at, tz=timezone.utc) if updated_at else now
                unassigned[lid] = {
                    "arrived_at": arrived,
                    "status_name": status_name,
                    "lead_name": lead_name,
                    "last_reminded_count": 0,
                }
                # Одразу сповіщаємо про нерозібрану заявку
                kommo_url = f"https://utsercice.kommo.com/leads/detail/{lid}"
                source_line = f"\n🌐 Джерело: {source}" if source else ""
                msg = (
                    f"📬 <b>Нерозібрана заявка!</b>\n"
                    f"🏷 Назва: {lead_name}\n"
                    f"📍 Етап: {status_name}{source_line}\n"
                    f"⏱ Щойно виявлено сканером\n"
                    f"👥 {_weekend_duty_supervisor() or ALL_SUPERVISORS}\n"
                    f"🔗 <a href='{kommo_url}'>Відкрити лід #{lid}</a>"
                )
                notifier.send_to_rnk(msg)
                logger.info("Scan found unassigned lead %s in %s", lid, status_name)
        except Exception as e:
            logger.error("_scan_unassigned_leads: %s", e)


def _check_unassigned_leads():
    """Runs every 15 min — scans CRM for unassigned leads, then sends reminders.
    Schedule: notify at 15, 30 min → escalate at 45 min → stop."""
    if not _is_unassigned_hours():
        return

    _scan_unassigned_leads()

    now = datetime.now(timezone.utc)
    duty = _weekend_duty_supervisor()
    tag_line = duty if duty else ALL_SUPERVISORS

    for lead_id, info in list(unassigned.items()):
        age_min = (now - info["arrived_at"]).total_seconds() / 60
        last = info.get("last_reminded_count", 0)
        kommo_url = f"https://utsercice.kommo.com/leads/detail/{lead_id}"

        # Ескалація на 45 хв (одноразово, позначається як count=99)
        if age_min >= 45 and last < 99:
            msg = (
                f"🔴 <b>Заявка не опрацьована більше 45 хв!</b>\n"
                f"🏷 Назва: {info['lead_name']}\n"
                f"📍 Етап: {info['status_name']}\n"
                f"⏱ Очікує: <b>{_format_duration(age_min)}</b>\n"
                f"👥 {ALL_SUPERVISORS}\n"
                f"🔗 <a href='{kommo_url}'>Відкрити лід #{lead_id}</a>"
            )
            notifier.send_to_rnk(msg)
            unassigned[lead_id]["last_reminded_count"] = 99
            logger.info("Escalation for lead %s (%.0f min)", lead_id, age_min)
            continue

        # Нагадування на 15 і 30 хв (максимум 2 рази)
        if age_min < 15 or last >= 2 or last >= 99:
            continue

        reminder_count = int(age_min // 15)
        if reminder_count <= last:
            continue

        msg = (
            f"📬 <b>Нерозібрана заявка!</b>\n"
            f"🏷 Назва: {info['lead_name']}\n"
            f"📍 Етап: {info['status_name']}\n"
            f"⏱ Очікує: <b>{_format_duration(age_min)}</b>\n"
            f"👥 {tag_line}\n"
            f"🔗 <a href='{kommo_url}'>Відкрити лід #{lead_id}</a>"
        )
        notifier.send_to_rnk(msg)
        unassigned[lead_id]["last_reminded_count"] = reminder_count
        logger.info("Unassigned reminder #%d for lead %s (%.0f min)", reminder_count, lead_id, age_min)


def _write_daily_snapshot():
    """Runs at 21:55 UTC (≈ 23:55 Kyiv) — saves daily stats to Google Sheets."""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    cutoff = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)

    # Aggregate from in-memory stats log
    counts: dict[int, int] = {}
    for entry in _stats_log:
        if entry["ts"] >= cutoff:
            uid = entry["manager_id"]
            counts[uid] = counts.get(uid, 0) + 1

    if not counts:
        return

    stats = []
    for uid, cnt in sorted(counts.items(), key=lambda x: x[1], reverse=True):
        stats.append({
            "manager": kommo.get_user_name(uid),
            "team": sheets.get_team(uid),
            "count": cnt,
        })
    sheets.write_daily_snapshot(today, stats)
    logger.info("Daily snapshot written: %d managers", len(stats))


def _send_rnk_daily_reminder() -> None:
    """О 17:00 Київ — сповіщення тімлідам РНК що реєстр відмов готовий до перегляду."""
    sheet_id = os.getenv("GOOGLE_SHEETS_ID", "") or os.getenv("SPREADSHEET_ID", "")
    sheet_link = f"https://docs.google.com/spreadsheets/d/{sheet_id}" if sheet_id else ""
    link_part = f"\n📎 <a href='{sheet_link}'>Відкрити реєстр відмов</a>" if sheet_link else ""
    msg = (
        f"📋 <b>Реєстр закритих угод оновлено</b>\n"
        f"Перевірте угоди «Закрито не реалізовано» за сьогодні.\n"
        f"👥 @darina_mx @Andry_UTS"
        f"{link_part}"
    )
    notifier.send_to_rnk(msg)


def _send_rnk_ai_report() -> None:
    """Щоденний AI звіт по відмовах РНК командам — о 18:00 Київ."""
    TL_TAGS = {
        "Михальчевська": ("@darina_mx", notifier.send_to_rnk),
        "Безпам'ятний": ("@Andry_UTS", notifier.send_to_rnk),
    }
    for team, (tl_tag, send_fn) in TL_TAGS.items():
        deals = sheets.get_today_closed_deals(team, cutoff_hour_utc=14)
        if not deals:
            continue

        analysis = ai_analyzer.analyze_team_deals(team, deals)
        if not analysis:
            continue

        lines = [
            f"🤖 <b>AI-аналіз відмов — команда {team}</b>",
            f"👔 {tl_tag}\n",
            f"📊 Закрито сьогодні: <b>{len(deals)}</b> угод\n",
        ]
        for d in deals:
            lines.append(
                f"• <b>{d.get('Менеджер', '—')}</b>: {d.get('Причина відмови') or 'без причини'} "
                f"({d.get('Дзвінків', 0)} дзв., {d.get('Днів в роботі', '?')} дн.)"
            )

        lines.append(f"\n💡 <b>Рекомендації:</b>\n{analysis}")
        send_fn("\n".join(lines))
        logger.info("AI report sent for team %s (%d deals)", team, len(deals))


scheduler = BackgroundScheduler(timezone="UTC")
scheduler.add_job(_check_overdue_leads, "interval", minutes=5)
scheduler.add_job(_check_unassigned_leads, "interval", minutes=15)
scheduler.add_job(_write_daily_snapshot, "cron", hour=21, minute=55)
scheduler.add_job(_send_daily_plan_report, "cron", hour=15, minute=0)   # 18:00 Kyiv = 15:00 UTC
scheduler.add_job(_send_month_end_report, "interval", hours=1)           # останній день місяця — щогодини
scheduler.add_job(_send_rnk_ai_report, "cron", hour=13, minute=50)      # 16:50 Kyiv = 13:50 UTC
scheduler.add_job(_send_rnk_daily_reminder, "cron", hour=14, minute=0)  # 17:00 Kyiv = 14:00 UTC
scheduler.start()
sheets.ensure_headers()

# In-memory: lead_id -> {transferred_at, manager, lead_name}
pending: dict[int, dict] = {}

# Stats log: list of {ts: datetime, manager_id: int}
_stats_log: list[dict] = []


def _parse_status(data: dict) -> dict | None:
    """Extract status change info. Returns dict with id/status_id/pipeline_id/responsible_user_id."""
    # JSON format
    if isinstance(data.get("leads"), dict):
        items = data["leads"].get("status", []) or data["leads"].get("add", [])
        if items and isinstance(items, list):
            return items[0]

    # Form-encoded format
    lead_id = data.get("leads[status][0][id]") or data.get("leads[add][0][id]")
    if lead_id:
        return {
            "id": int(lead_id),
            "status_id": int(data.get("leads[status][0][status_id]", 0)),
            "old_status_id": int(data.get("leads[status][0][old_status_id]", 0)),
            "pipeline_id": int(data.get("leads[status][0][pipeline_id]", 0)),
            "responsible_user_id": int(data.get("leads[status][0][responsible_user_id]", 0)),
        }
    return None


def _parse_responsible(data: dict) -> dict | None:
    """Extract responsible change event (Отв-й сделки изменен)."""
    lead_id = data.get("leads[responsible][0][id]")
    responsible_id = data.get("leads[responsible][0][responsible_user_id]")
    pipeline_id = data.get("leads[responsible][0][pipeline_id]")
    status_id = data.get("leads[responsible][0][status_id]")
    if lead_id:
        return {
            "id": int(lead_id),
            "responsible_user_id": int(responsible_id) if responsible_id else 0,
            "pipeline_id": int(pipeline_id) if pipeline_id else 0,
            "status_id": int(status_id) if status_id else 0,
        }
    return None


def _parse_note(data: dict) -> dict | None:
    """Extract call note info (note_type 10=call_in, 11=call_out)."""
    note_type = data.get("leads[note][0][note_type]")
    lead_id = data.get("leads[note][0][element_id]")
    user_id = data.get("leads[note][0][main_user_id]")
    if note_type and lead_id:
        return {
            "note_type": str(note_type),
            "lead_id": int(lead_id),
            "responsible_user_id": int(user_id) if user_id else 0,
        }
    return None


@app.route("/webhook", methods=["POST"])
def webhook():
    content_type = request.content_type or ""
    if "application/json" in content_type:
        data = request.get_json(force=True, silent=True) or {}
    else:
        data = request.form.to_dict()

    logger.info("Webhook received: %s", data)

    # ── Call note (Ringostat) ──────────────────────────────────────
    note = _parse_note(data)
    if note and note["note_type"] in ("10", "11", "call_in", "call_out"):
        _handle_call(note)
        return jsonify({"ok": True})

    # ── Responsible changed ───────────────────────────────────────
    resp_change = _parse_responsible(data)
    if resp_change:
        if (resp_change["pipeline_id"] == QUAL_PIPELINE_ID and
                resp_change["status_id"] == NEW_FROM_LIDOGEN):
            # Перевіряємо чи ліd не з "робочих" етапів
            lead = kommo.get_lead(resp_change["id"])
            old_status = lead.get("old_status_id", 0) if lead else 0
            if old_status not in SKIP_FROM_STATUSES:
                _handle_new_lead(resp_change["id"], resp_change["responsible_user_id"])
            else:
                logger.info("Skipped lead %s — came from excluded status %s", resp_change["id"], old_status)
        return jsonify({"ok": True})

    # ── Status change ─────────────────────────────────────────────
    item = _parse_status(data)
    if not item:
        logger.warning("Could not parse webhook payload")
        return jsonify({"ok": True})

    lead_id = int(item.get("id", 0))
    status_id = int(item.get("status_id", 0))
    old_status_id = int(item.get("old_status_id", 0))
    pipeline_id = int(item.get("pipeline_id", 0))
    responsible_id = int(item.get("responsible_user_id", 0))

    # Нерозібрані заявки — лід отримав реального відповідального → сповістити і прибрати з черги
    if lead_id in unassigned and responsible_id and responsible_id != ADMIN_USER_ID:
        info = unassigned.pop(lead_id, {})
        manager_name = kommo.get_user_name(responsible_id)
        tg_tag = notifier.get_manager_tag(responsible_id)
        waited_min = int((datetime.now(timezone.utc) - info["arrived_at"]).total_seconds() / 60) if info.get("arrived_at") else 0
        kommo_url = f"https://utsercice.kommo.com/leads/detail/{lead_id}"
        msg = (
            f"✅ <b>Заявку взято в роботу</b>\n"
            f"🏷 Назва: {info.get('lead_name', f'Лід #{lead_id}')}\n"
            f"📍 Етап: {info.get('status_name', '—')}\n"
            f"👤 Менеджер: <b>{manager_name}</b>{tg_tag}\n"
            f"⏱ Час очікування: <b>{waited_min} хв</b>\n"
            f"🔗 <a href='{kommo_url}'>Відкрити лід #{lead_id}</a>"
        )
        send_to_team_group(responsible_id, msg)
        logger.info("Lead %s assigned to %s after %d min", lead_id, manager_name, waited_min)

    if pipeline_id == PEREVOZY_PIPELINE_ID:
        if status_id == CLOSED_NOT_REALIZED and responsible_id in DARINA_ANDRIY_TEAMS:
            _handle_closed_not_realized(lead_id, responsible_id)
        elif status_id == WON_STATUS_ID:
            lead = kommo.get_lead(lead_id)
            amount = int(lead.get("price", 0)) if lead else 0
            _handle_won_deal(lead_id, responsible_id, amount)
        elif status_id == 69716460:  # Оплата отримана
            if responsible_id in MANAGER_PLANS:
                _check_plan_completion(responsible_id)
        return jsonify({"ok": True})

    if pipeline_id != QUAL_PIPELINE_ID:
        return jsonify({"ok": True})

    # Нерозібрана заявка — лід без відповідального в одному з цих етапів
    if status_id in UNASSIGNED_STATUSES and (not responsible_id or responsible_id == ADMIN_USER_ID):
        _handle_unassigned(lead_id, status_id)

    if status_id == NEW_FROM_LIDOGEN:
        if old_status_id in SKIP_FROM_STATUSES:
            logger.info("Skipped lead %s — came from excluded status %s", lead_id, old_status_id)
        else:
            _handle_new_lead(lead_id, responsible_id)

    elif status_id == TAKEN_TO_WORK:
        is_lidogen = lead_id in pending
        _handle_taken(lead_id, responsible_id)
        if not is_lidogen:
            _handle_rnk_event(lead_id, responsible_id, "🟢 Лід взятий у роботу")

    elif status_id == 69693656:  # Дзвінки — тільки без відповідального (Admin)
        if not responsible_id or responsible_id == ADMIN_USER_ID:
            _handle_rnk_event(lead_id, responsible_id, "📞 Дзвінки")

    elif status_id == 69693660:  # Дзвінки з сайту — тільки без відповідального (Admin)
        if not responsible_id or responsible_id == ADMIN_USER_ID:
            _handle_rnk_event(lead_id, responsible_id, "🌐 Дзвінки з сайту")

    return jsonify({"ok": True})


def _handle_unassigned(lead_id: int, status_id: int):
    now = datetime.now(timezone.utc)
    if lead_id in unassigned:
        return  # вже в черзі

    lead = kommo.get_lead(lead_id)
    lead_name = lead.get("name", f"Лід #{lead_id}") if lead else f"Лід #{lead_id}"
    source = kommo.get_lead_source(lead) if lead else ""
    status_name = UNASSIGNED_STATUSES.get(status_id, "—")
    kommo_url = f"https://utsercice.kommo.com/leads/detail/{lead_id}"

    source_line = f"\n🌐 Джерело: {source}" if source else ""
    msg = (
        f"📬 <b>Нерозібрана заявка!</b>\n"
        f"🏷 Назва: {lead_name}\n"
        f"📍 Етап: {status_name}{source_line}\n"
        f"⏱ Щойно надійшла\n"
        f"👥 {_weekend_duty_supervisor() or ALL_SUPERVISORS}\n"
        f"🔗 <a href='{kommo_url}'>Відкрити лід #{lead_id}</a>"
    )
    notifier.send_to_rnk(msg)

    unassigned[lead_id] = {
        "arrived_at": now,
        "status_name": status_name,
        "lead_name": lead_name,
        "last_reminded_count": 0,
    }
    logger.info("Unassigned lead %s in status %s", lead_id, status_name)


def _handle_closed_not_realized(lead_id: int, responsible_id: int):
    details = kommo.get_lead_details(lead_id)
    manager_name = kommo.get_user_name(responsible_id) if responsible_id else "—"
    tg_tag = notifier.get_manager_tag(responsible_id)
    supervisor_tag = SUPERVISOR_MAP.get(responsible_id, "")
    kommo_url = f"https://utsercice.kommo.com/leads/detail/{lead_id}"

    sup_part = f" {supervisor_tag}" if supervisor_tag else ""
    days = f"{details['days_in_work']} дн." if details["days_in_work"] is not None else "—"
    reason = details["reject_reason"] or "не вказана"
    last_status = details["last_status"] or "—"
    notes = details["notes_count"]
    calls = details["calls_count"]

    activity = "✅ Була активність" if (notes > 0 or calls > 0) else "🚫 Активності не було"

    msg = (
        f"❌ <b>Закрито і не реалізовано</b>\n"
        f"👤 Менеджер: <b>{manager_name}</b>{tg_tag}{sup_part}\n"
        f"🏷 Назва: {details['name']}\n"
        f"📋 Причина: {reason}\n"
        f"🔀 Закрито з етапу: {last_status}\n"
        f"📞 Дзвінків: <b>{calls}</b> | Нотаток: <b>{notes}</b>\n"
        f"📅 Днів в роботі: <b>{days}</b>\n"
        f"{activity}\n"
        f"🔗 <a href='{kommo_url}'>Відкрити угоду #{lead_id}</a>"
    )
    send_to_team_group(responsible_id, msg)
    logger.info("Closed not realized: lead %s by %s", lead_id, manager_name)

    # Логуємо в Google Sheets реєстр відмов РНК
    if MANAGER_TEAM.get(responsible_id, "") in RNK_TEAMS:
        lead = kommo.get_lead(lead_id)
        amount = int(lead.get("price", 0)) if lead else 0
        deal_data = {
            "lead_id": lead_id,
            "name": details["name"],
            "manager": manager_name,
            "team": MANAGER_TEAM.get(responsible_id, ""),
            "reject_reason": details["reject_reason"],
            "last_status": details["last_status"],
            "days_in_work": details["days_in_work"],
            "calls_count": details["calls_count"],
            "notes_count": details["notes_count"],
            "amount": amount,
            "closed_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M"),
            "ai_recommendation": ai_analyzer.analyze_closed_deal({
                **details, "manager": manager_name, "amount": amount
            }),
        }
        sheets.log_closed_deal(deal_data)


def _handle_rnk_event(lead_id: int, responsible_id: int, label: str):
    lead = kommo.get_lead(lead_id)
    lead_name = lead.get("name", f"Лід #{lead_id}") if lead else f"Лід #{lead_id}"
    manager_name = kommo.get_user_name(responsible_id) if responsible_id else "—"
    tg_tag = notifier.get_manager_tag(responsible_id)
    kommo_url = f"https://utsercice.kommo.com/leads/detail/{lead_id}"
    msg = (
        f"{label}\n"
        f"👤 Менеджер: <b>{manager_name}</b>{tg_tag}\n"
        f"🏷 Назва: {lead_name}\n"
        f"🔗 <a href='{kommo_url}'>Відкрити лід #{lead_id}</a>"
    )
    send_to_team_group(responsible_id, msg)
    logger.info("Team event: %s lead %s by %s", label, lead_id, manager_name)


def _handle_new_lead(lead_id: int, responsible_id: int):
    lead = kommo.get_lead(lead_id)
    lead_name = lead.get("name", f"Лід #{lead_id}") if lead else f"Лід #{lead_id}"
    manager_name = kommo.get_user_name(responsible_id) if responsible_id else "—"
    now = datetime.now(timezone.utc)

    pending[lead_id] = {
        "transferred_at": now,
        "manager": manager_name,
        "lead_name": lead_name,
        "responsible_id": responsible_id,
        "reminded": False,
    }
    if responsible_id:
        _stats_log.append({"ts": now, "manager_id": responsible_id})

    source = kommo.get_lead_source(lead) if lead else ""
    kommo_url = f"https://utsercice.kommo.com/leads/detail/{lead_id}"
    tg_tag = notifier.get_manager_tag(responsible_id)
    source_line = f"\n🌐 Джерело: {source}" if source else ""
    msg = (
        f"📥 <b>Нова заявка від лідогенератора</b>\n"
        f"👤 Менеджер: <b>{manager_name}</b>{tg_tag}\n"
        f"🏷 Назва: {lead_name}{source_line}\n"
        f"🔗 <a href='{kommo_url}'>Відкрити лід #{lead_id}</a>"
    )
    if _is_working_hours():
        notifier.send_to_rpk(msg)
        # Якщо менеджер з РНК команди — дублюємо і в РНК
        if MANAGER_TEAM.get(responsible_id, "") in RNK_TEAMS:
            notifier.send_to_rnk(msg)
    sheets.append_transfer(lead_id, lead_name, manager_name, now, manager_id=responsible_id)
    logger.info("New lead: %s → %s", lead_id, manager_name)


def _handle_taken(lead_id: int, responsible_id: int):
    now = datetime.now(timezone.utc)
    info = pending.get(lead_id)
    manager_name = kommo.get_user_name(responsible_id) if responsible_id else "—"
    tg_tag = notifier.get_manager_tag(responsible_id)

    if info:
        sheets.update_taken(lead_id, now)
    logger.info("Taken to work: lead %s by %s", lead_id, manager_name)


def _handle_call(note: dict):
    lead_id = note["lead_id"]
    responsible_id = note["responsible_user_id"]
    note_type = note["note_type"]
    now = datetime.now(timezone.utc)

    info = pending.get(lead_id)
    manager_name = kommo.get_user_name(responsible_id) if responsible_id else "—"
    tg_tag = notifier.get_manager_tag(responsible_id)
    call_type = "вхідний" if note_type == "10" else "вихідний"

    if info:
        sheets.update_first_call(lead_id, now)
        pending.pop(lead_id, None)
    logger.info("Call note: lead %s type %s by %s", lead_id, note_type, manager_name)


def _build_stats_text(days: int, label: str) -> str:
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    counts: dict[int, int] = {}
    for entry in _stats_log:
        if entry["ts"] >= cutoff:
            uid = entry["manager_id"]
            counts[uid] = counts.get(uid, 0) + 1

    if not counts:
        return f"📊 <b>Статистика ({label})</b>\nДаних немає"

    lines = [f"📊 <b>Статистика лідів від лідогенератора ({label})</b>\n"]
    sorted_counts = sorted(counts.items(), key=lambda x: x[1], reverse=True)
    for i, (uid, cnt) in enumerate(sorted_counts, 1):
        name = kommo.get_user_name(uid)
        tag = notifier.get_manager_tag(uid)
        lines.append(f"{i}. {name}{tag} — <b>{cnt}</b> лід{'ів' if cnt > 4 else 'и' if cnt > 1 else ''}")

    return "\n".join(lines)


@app.route("/tg-update", methods=["POST"])
def tg_update():
    """Telegram bot webhook — handles callback_query (button clicks)."""
    data = request.get_json(force=True, silent=True) or {}
    logger.info("TG update: %s", data)

    callback = data.get("callback_query")
    if not callback:
        return jsonify({"ok": True})

    cb_id = callback["id"]
    cb_data = callback.get("data", "")
    chat_id = callback["message"]["chat"]["id"]
    message_id = callback["message"]["message_id"]

    notifier.answer_callback(cb_id)

    if cb_data == "stats_today":
        text = _build_stats_text(days=1, label="сьогодні")
    elif cb_data == "stats_week":
        text = _build_stats_text(days=7, label="7 днів")
    elif cb_data == "stats_month":
        text = _build_stats_text(days=30, label="30 днів")
    else:
        return jsonify({"ok": True})

    notifier.send_stats_message(chat_id, text, message_id)
    return jsonify({"ok": True})


@app.route("/setup-tg-webhook", methods=["GET"])
def setup_tg_webhook():
    """Register Telegram bot webhook. Call once after deploy."""
    base_url = request.host_url.rstrip("/")
    result = notifier.set_webhook(f"{base_url}/tg-update")
    return jsonify(result)


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


@app.route("/test-tg", methods=["GET"])
def test_tg():
    result = notifier.test_bot()
    return jsonify(result)


@app.route("/daily", methods=["GET"])
def daily():
    msg = f"📊 <b>Щоденний звіт</b> за {datetime.now(timezone.utc).strftime('%d.%m.%Y')}\nОчікує обробки: {len(pending)} лідів"
    sent = notifier.send_message(msg)
    return jsonify({"ok": sent, "pending": len(pending)})


@app.route("/scan-now", methods=["GET"])
def scan_now():
    """Manually trigger unassigned leads scan and reminders."""
    _check_unassigned_leads()
    return jsonify({"ok": True, "unassigned_count": len(unassigned)})


@app.route("/test-groups", methods=["GET"])
def test_groups():
    """Send test messages to РНК and lidogen groups."""
    results = {}
    results["rnk"] = notifier.send_to_rnk("✅ Тест групи РНК — гілка 51")
    results["rpk"] = notifier.send_to_rpk("✅ Тест групи РПК — гілка 3")
    return jsonify(results)


@app.route("/test-plan-thread", methods=["GET"])
def test_plan_thread():
    """Send a test message to plan thread to verify bot access."""
    import requests as req
    tg_token = os.getenv("TG_TOKEN", "")
    tg_chat = os.getenv("TG_CHAT_ID", "")
    r = req.post(
        f"https://api.telegram.org/bot{tg_token}/sendMessage",
        json={"chat_id": tg_chat, "text": "✅ Тест гілки плану", "message_thread_id": TG_PLAN_THREAD_ID},
        timeout=10,
    )
    return jsonify({"tg_chat": tg_chat, "thread": TG_PLAN_THREAD_ID, "response": r.json()})


@app.route("/send-plan-report", methods=["GET"])
def send_plan_report():
    """Manually trigger daily plan report."""
    import traceback
    log_lines = []
    original_info = logger.info

    def capture_info(msg, *args):
        log_lines.append(msg % args if args else msg)
        original_info(msg, *args)

    logger.info = capture_info
    try:
        _send_daily_plan_report()
        return jsonify({"ok": True, "log": log_lines})
    except Exception as e:
        tb = traceback.format_exc()
        logger.error("send_plan_report: %s", e)
        return jsonify({"ok": False, "error": str(e), "traceback": tb, "log": log_lines})
    finally:
        logger.info = original_info


@app.route("/send-rnk-daily-reminder", methods=["GET"])
def send_rnk_daily_reminder():
    """Manually trigger RNK daily reminder about closed deals registry."""
    _send_rnk_daily_reminder()
    return jsonify({"ok": True})


@app.route("/send-rnk-ai-report", methods=["GET"])
def send_rnk_ai_report():
    """Manually trigger RNK AI deals analysis report."""
    import traceback
    try:
        _send_rnk_ai_report()
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e), "traceback": traceback.format_exc()})


@app.route("/backfill-closed-rnk", methods=["GET"])
def backfill_closed_rnk():
    """
    Retroactively process closed-not-realized leads for RNK teams.
    ?date=2026-06-12  (default: yesterday)
    """
    from datetime import datetime, timezone, timedelta
    import traceback
    try:
        date_str = request.args.get("date")
        if date_str:
            day = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        else:
            day = datetime.now(timezone.utc) - timedelta(days=1)

        day_start = int(day.replace(hour=0, minute=0, second=0, microsecond=0).timestamp())
        day_end = int(day.replace(hour=23, minute=59, second=59, microsecond=0).timestamp())

        QUAL_PIPELINE_ID = 8921928
        CLOSED_STATUS_ID = 143

        leads = kommo.get_pipeline_leads(
            QUAL_PIPELINE_ID, status_id=CLOSED_STATUS_ID,
            with_custom_fields=True, closed_at_from=day_start
        )

        processed = 0
        for lead in leads:
            closed_at = lead.get("closed_at") or lead.get("updated_at", 0)
            if not (day_start <= closed_at <= day_end):
                continue

            responsible_id = lead.get("responsible_user_id", 0)
            if MANAGER_TEAM.get(responsible_id, "") not in RNK_TEAMS:
                continue

            lead_id = lead["id"]
            details = kommo.get_lead_details(lead_id)
            manager_name = kommo.get_user_name(responsible_id)
            amount = int(lead.get("price", 0))

            deal_data = {
                "lead_id": lead_id,
                "name": details["name"],
                "manager": manager_name,
                "team": MANAGER_TEAM.get(responsible_id, ""),
                "reject_reason": details["reject_reason"],
                "last_status": details["last_status"],
                "days_in_work": details["days_in_work"],
                "calls_count": details["calls_count"],
                "notes_count": details["notes_count"],
                "amount": amount,
                "closed_at": datetime.fromtimestamp(closed_at, tz=timezone.utc).strftime("%Y-%m-%d %H:%M"),
                "ai_recommendation": ai_analyzer.analyze_closed_deal({
                    **details, "manager": manager_name, "amount": amount
                }),
            }
            sheets.log_closed_deal(deal_data)
            processed += 1

        return jsonify({"ok": True, "date": day.strftime("%Y-%m-%d"), "processed": processed})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e), "traceback": traceback.format_exc()})


if __name__ == "__main__":
    app.run(debug=False)
