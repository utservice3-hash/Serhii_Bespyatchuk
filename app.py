import os
import json
import logging
import re
import calendar
import threading
from collections import deque
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo
from flask import Flask, request, jsonify, render_template_string, redirect, url_for
from apscheduler.schedulers.background import BackgroundScheduler

# Київський час з урахуванням переведення годинників (влітку UTC+3, взимку
# UTC+2). Фіксований +3 взимку зсував би всі робочі години і звіти на годину.
try:
    KYIV_TZ = ZoneInfo("Europe/Kyiv")
except Exception:  # старіші tzdata знають лише стару назву
    KYIV_TZ = ZoneInfo("Europe/Kiev")

import kommo
import notifier
import sheets
import ai_analyzer
import transcriber
import excel_report
import elogist_userbot

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
DZVINKY_Z_SAITU = 69693660    # "Дзвінки з сайту"
NON_TARGET_STATUS = 143       # "Не цільові"
REMINDER_MINUTES = 20

# Telegram-група "[Euro Logistic] - Дошка оголошень" — сюди прилітають заявки
# із сайту eLogist (через бота Trans_NowBot), їх треба автоматично заводити
# в Kommo на етапі "Дзвінки з сайту".
ELOGIST_SOURCE_CHAT_ID = -1002141432610
ELOGIST_TAG = "eLogist"
# Окремий етап у воронці Кваліфікація під заявки з сайту eLogist (щоб їх було
# видно окремо й відстежувати конверсію по тегу eLogist).
ELOGIST_STATUS = 108581472   # "Заявки eLogist (сайт)"
ELOGIST_DEDUP_MINUTES = 30
_elogist_recent_phones: dict[str, datetime] = {}

# Секрет у URL прямого веб-хука eLogist (щоб сторонні не спамили ліди)
ELOGIST_HOOK_TOKEN = "uts-elg-9Kx27Qm4tR"
ELOGIST_PHONE_RE = re.compile(
    r"\+?3?8?0\s*\(?\d{2,3}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}"
)


def _parse_elogist_message(text: str) -> dict | None:
    """Парсить повідомлення eLogist (два відомі формати) і повертає
    {"phone", "route"} або None, якщо не вдалось знайти телефон."""
    if not text or "elogist" not in text.lower():
        return None

    phone_match = re.search(r"\+?3?8?0\s*\(?\d{2,3}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}", text)
    if not phone_match:
        return None
    phone_digits = re.sub(r"\D", "", phone_match.group())
    if not phone_digits.startswith("380"):
        phone_digits = "380" + phone_digits[-9:]
    phone = "+" + phone_digits

    route = ""
    route_match = re.match(r"eLogist:\s*(.+?)\n", text)
    if route_match and "дзвінок з сайту" not in route_match.group(1).lower():
        route = route_match.group(1).strip().replace("  ", " ")

    return {"phone": phone, "route": route}


def _create_elogist_lead(phone: str, route: str = "") -> tuple[int | None, str]:
    """Дедуп + створення ліда eLogist у кваліфікації (етап «Дзвінки з сайту»).
    Спільна логіка для Telegram-userbot і прямого веб-хука. Повертає (lead_id, статус)."""
    now = datetime.now(timezone.utc)
    last_seen = _elogist_recent_phones.get(phone)
    if last_seen and (now - last_seen).total_seconds() < ELOGIST_DEDUP_MINUTES * 60:
        logger.info("Skipped duplicate eLogist lead for phone %s", phone)
        return None, "duplicate"
    # Дедуп через CRM: in-memory кеш губиться при рестарті Render, тож
    # додатково перевіряємо, чи за останню добу вже не створено лід із цим
    # телефоном — дубль заявки в СРМ має прийти лише один раз.
    existing = kommo.find_recent_lead_by_phone(phone, hours=24)
    if existing:
        _elogist_recent_phones[phone] = now
        logger.info("Skipped duplicate eLogist lead for phone %s (existing lead %s)", phone, existing)
        return None, "duplicate"
    _elogist_recent_phones[phone] = now
    if len(_elogist_recent_phones) > 500:
        cutoff = now - timedelta(minutes=ELOGIST_DEDUP_MINUTES)
        for k in [k for k, v in _elogist_recent_phones.items() if v < cutoff]:
            _elogist_recent_phones.pop(k, None)

    name = f"eLogist — {route}" if route else f"eLogist — {phone}"
    lead_id = kommo.create_lead_with_phone(
        name=name, phone=phone,
        pipeline_id=QUAL_PIPELINE_ID, status_id=ELOGIST_STATUS, tag_name=ELOGIST_TAG,
    )
    if lead_id:
        logger.info("Created eLogist lead %s for phone %s", lead_id, phone)
        return lead_id, "created"
    logger.error("Failed to create eLogist lead for phone %s", phone)
    return None, "create_failed"


def _handle_elogist_message(text: str):
    parsed = _parse_elogist_message(text)
    if not parsed:
        logger.info("eLogist message did not contain a recognizable phone: %s", text[:80])
        return
    _create_elogist_lead(parsed["phone"], parsed["route"])


def _detect_elogist(lead: dict | None, status_id: int = 0) -> bool:
    """Чи лід прийшов з eLogist (за етапом, тегом або назвою)."""
    if status_id == ELOGIST_STATUS:
        return True
    tags = [t.get("name") for t in ((lead or {}).get("_embedded", {}).get("tags") or [])]
    if ELOGIST_TAG in tags:
        return True
    return str((lead or {}).get("name", "")).startswith("eLogist")


def _source_badge(is_elogist: bool) -> str:
    """Рядок-мітка джерела ліда для сповіщень: eLogist чи власний UTS."""
    return "📨 Джерело ліда: <b>eLogist</b>" if is_elogist else "📨 Джерело ліда: <b>UTS</b>"


# Персист черги нерозібраних через маркер-нотатки в CRM: стан черги живе в
# пам'яті процесу і губиться при кожному рестарті Render (деплой). Без
# персисту скан після рестарту пере-надсилав би «Нерозібрана заявка» вдруге,
# а редагування на «Взято в роботу» втрачало б message_id старого повідомлення.
UNASSIGNED_NOTE_MARKER = "🤖 Сповіщення про нерозібрану заявку надіслано в Telegram"
UNASSIGNED_TAKEN_MARKER = "🤖 Нерозібрану заявку взято в роботу"


def _restore_unassigned_refs(lead_id: int) -> tuple[list, int] | None:
    """Шукає в нотатках ліда маркер надісланого сповіщення. Повертає
    (msg_refs, created_at нотатки) або None, якщо сповіщення не надсилалось
    чи заявку вже було взято в роботу після нього."""
    refs_note = None
    taken_ts = 0
    for n in kommo.get_lead_notes(lead_id):
        if n.get("note_type") not in (4, "common"):
            continue
        text = ((n.get("params") or {}).get("text") or "")
        if UNASSIGNED_TAKEN_MARKER in text:
            taken_ts = max(taken_ts, n.get("created_at", 0))
        elif UNASSIGNED_NOTE_MARKER in text:
            if not refs_note or n.get("created_at", 0) > refs_note.get("created_at", 0):
                refs_note = n
    if not refs_note or taken_ts >= refs_note.get("created_at", 0):
        return None
    refs = []
    m = re.search(r"tg-refs:\s*(\[.*\])", ((refs_note.get("params") or {}).get("text") or ""), re.S)
    if m:
        try:
            refs = json.loads(m.group(1))
        except Exception:
            refs = []
    return refs, refs_note.get("created_at", 0)


def _save_unassigned_refs(lead_id: int, msg_refs: list) -> None:
    """Пише маркер-нотатку з tg-refs (chat_id/message_id надісланих
    сповіщень), щоб після рестарту черга відновилась без дублів."""
    try:
        refs_json = json.dumps(msg_refs or [], ensure_ascii=False)
    except Exception:
        refs_json = "[]"
    kommo.add_note(lead_id, f"{UNASSIGNED_NOTE_MARKER}\ntg-refs: {refs_json}")

PEREVOZY_PIPELINE_ID = 8921932  # Перевозки (Продажі повний цикл)
CLOSED_NOT_REALIZED = 143        # ЗАКРИТО І НЕ РЕАЛІЗОВАНО
WON_STATUS_ID = 142              # УСПІШНА УГОДА
# Етап "Повернуто АІ Відділ якості (на допрацювання)" на початку воронки
# Продаж повний цикл — сюди AI переводить угоди, закриті як "не цільові" чи
# "закрито не реалізовано" передчасно, щоб тімлід далі вів їх у повному циклі.
RETURNED_QC_STATUS = 108361876
RETURNED_QC_TAG = "Повернуто АІ"

# Прапорець повернення угод AI-Відділом якості. Коли False — AI НЕ переводить
# угоди в етап «Повернуто АІ» (ні передчасно закриті, ні помилково «не цільові»).
# AI-аналіз і сповіщення лишаються (інформативні), але угода фізично не рухається.
QC_RETURN_ENABLED = True

# Telegram — гілка для звітів по плану
TG_PLAN_THREAD_ID = 175862

# Плани на липень 2026 {user_id: plan_amount}
MANAGER_PLANS: dict[int, int] = {
    # Команда Безпам'ятного (РНК) — план 320,000
    12644448: 25000,   # Безпам'ятний Андрій
    13689696: 60000,   # Чукін Євген
    11293904: 70000,   # Крицька Діана
    15192136: 40000,   # Палій Тарас
    15380780: 35000,   # Ворошилова Вікторія
    15354672: 30000,   # Борівець Олеся
    15355168: 35000,   # Голоміна Олександра
    15336060: 25000,   # Дьяков Денис

    # Команда Михальчевської (РНК) — план 430,000
    12782896: 20000,   # Михальчевська Дарина
    14926076: 60000,   # Панасюк Святослав
    13803600: 110000,  # Цалко Олександр
    14431884: 45000,   # Янчевський Едуард
    13461608: 90000,   # Андрусенко Богдана
    15227596: 30000,   # Пехньо Ксенія
    15279220: 45000,   # Сугак Денис
    15227544: 30000,   # Герелевич Аліна
    14083284: 40000,   # Гофман Іван

    # Команда Дмитрука (РПК) — план 780,000
    6062482:  265000,  # Дмитрук Василь
    7863771:  185000,  # Возович Антон
    15044916: 30000,   # Матюнін Олександр
    11295244: 300000,  # Самохвалов Сергій

    # Команда Шаврової (РПК) — план 225,000
    12066792: 120000,  # Шаврова Лілія
    15414956: 30000,   # Гаркушина Юлія
    15514596: 25000,   # Шамрай Олександр
    15515016: 25000,   # Пехньо Олександра (не плутати з Пехньо Ксенія 15227596)
    # + Крістіна Захарченко 25,000 — акаунт у Kommo не знайдено, уточнити user_id

    # Команда Яцика (РПК) — план 835,000
    3379102:  0,       # Яцик Дмитро
    10022700: 80000,   # Мокляк Олександр
    7347414:  100000,  # Свіржевський Артем
    12163420: 350000,  # Семенюк Дмитро
    2013613:  185000,  # Антипенко Олег
    11739992: 120000,  # Хомік Вікторія

    # Тендерний відділ — план 100,000
    7181916:  100000,  # Шевчук Назар
}

TEAM_PLANS: dict[str, int] = {
    "Безпам'ятний": 320000,
    "Михальчевська": 470000,
    "Дмитрук": 780000,
    "Шаврова": 225000,
    "Яцик": 835000,
    "Тендерний": 100000,
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
    15354672: "Безпам'ятний", 15355168: "Безпам'ятний",
    15380780: "Безпам'ятний", 15336060: "Безпам'ятний",
    12782896: "Михальчевська", 14926076: "Михальчевська",
    13803600: "Михальчевська", 14431884: "Михальчевська",
    13461608: "Михальчевська", 15227596: "Михальчевська",
    15279220: "Михальчевська", 15227544: "Михальчевська",
    14083284: "Михальчевська",  # Гофман Іван
    6062482: "Дмитрук", 7863771: "Дмитрук",
    15044916: "Дмитрук", 11295244: "Дмитрук",
    12066792: "Шаврова", 15414956: "Шаврова",
    15514596: "Шаврова", 15515016: "Шаврова",
    3379102: "Яцик", 10022700: "Яцик", 7347414: "Яцик",
    12163420: "Яцик", 2013613: "Яцик", 11739992: "Яцик",
    7181916: "Тендерний",
}

# РНК — Михальчевська, Безпам'ятний
# РПК — Яцик, Дмитрук, Шаврова, Тендерний
RNK_TEAMS = {"Михальчевська", "Безпам'ятний"}
RPK_TEAMS = {"Яцик", "Дмитрук", "Шаврова", "Тендерний"}


def _refresh_plans_from_sheet() -> str:
    """Підтягує плани з аркушів «Плани менеджерів» / «Плани команд»
    (див. sheets.read_plans). Значення в коді — лише стартовий фолбек,
    щомісячне оновлення робиться редагуванням таблиці, без деплою.
    Мутуємо словники на місці, щоб усі, хто їх імпортував, бачили зміни."""
    data = sheets.read_plans()
    if data is None:
        return "таблиця недоступна або аркуш не створено — лишаю значення з коду"
    mgr_plans, mgr_team, team_plans = data
    # Оновлюємо на місці БЕЗ clear(): паралельний читач (звіт) не повинен
    # застати порожній dict у вікні між clear() і update(). Прибираємо лише
    # ключі, яких уже немає в таблиці, потім оновлюємо решту.
    if mgr_plans:
        with _state_lock:
            for k in [k for k in MANAGER_PLANS if k not in mgr_plans]:
                MANAGER_PLANS.pop(k, None)
            MANAGER_PLANS.update(mgr_plans)
    if mgr_team:
        # Тільки додаємо/оновлюємо: видалення рядка з таблиці не повинно
        # ламати роутинг сповіщень по командах.
        MANAGER_TEAM.update(mgr_team)
    if team_plans:
        with _state_lock:
            for k in [k for k in TEAM_PLANS if k not in team_plans]:
                TEAM_PLANS.pop(k, None)
            TEAM_PLANS.update(team_plans)
    result = f"ok: {len(mgr_plans)} менеджерів, {len(team_plans)} команд"
    logger.info("Plans refreshed from sheet: %s", result)
    return result


def send_to_team_group(manager_id: int, text: str) -> bool:
    """Відправляє сповіщення в правильну групу (РНК або РПК) залежно від команди менеджера."""
    team = MANAGER_TEAM.get(manager_id, "")
    return notifier.send_to_team_tracking(text, team)


def _route_tracking_message(responsible_id: int, text: str) -> bool:
    """Трекінг роботи: якщо є реальний відповідальний — у групу його команди
    (РНК або РПК) з тегом менеджера; якщо відповідального немає — у спільну
    групу РНК (а не у фолбек РПК, як зробив би send_to_team_group(0, ...))."""
    if responsible_id and responsible_id != ADMIN_USER_ID:
        return send_to_team_group(responsible_id, text)
    return notifier.send_to_rnk_tracking(text)

# In-memory: список успішних угод поточного місяця
# {lead_id, manager_id, amount, closed_at}
_won_log: list[dict] = []

# Менеджери, яких вже привітали з виконанням плану цього місяця
_plan_congrats_sent: set[int] = set()
_plan_congrats_month: int = datetime.now(timezone.utc).month

# Етапи з нерозібраними заявками (без відповідального) — усі етапи кваліфікації,
# окрім "Дзвінки на мобільні" (70419108) та фінальних статусів (успіх/не цільові)
UNASSIGNED_STATUSES = {
    69693648: "Неразобранное",
    69693652: "Лід взятий у роботу",
    69693656: "Дзвінки",
    69693660: "Дзвінки з сайту",
    69716160: "Дзвінок по пропущеному (реклама)",
    69716164: "Нова заявка від лідогенератора",
    69738660: "Реактивовано",
    108581472: "Заявки eLogist (сайт)",
}
ADMIN_USER_ID = 904923  # Admin — означає немає реального відповідального

# Ringostat SIP → Kommo manager ID (заповнити після першого тестового дзвінка)
SIP_MAP: dict[str, int] = {
    "utsua_103": 15355168,  # Голоміна Олександра Євгеніївна (Безпам'ятний)
}

# Тімліди РНК — для нерозібраних заявок (без відповідального)
ALL_SUPERVISORS = "@Andry_UTS @darina_mx"
# Всі тімліди (для інших сповіщень)
ALL_SUPERVISORS_ALL = "@dmytro_yatsyk @Logist_dmytruk @Andry_UTS @darina_mx @lillly_aaa"

# In-memory: lead_id -> {arrived_at, status_name, lead_name, last_reminded_count}
unassigned: dict[int, dict] = {}

# Спільний лок для check-then-act над in-memory чергами (unassigned / pending /
# _first_touch_done): вебхуки (Flask-треди), scheduler і фонові daemon-треди
# мутують їх паралельно. Захищає лише короткі критичні секції «перевірити-і-
# зайняти» (не мережеві виклики), щоб на одну заявку не пішло два сповіщення /
# дві транскрибації.
_state_lock = threading.RLock()

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


def _tracking_supervisor_tag(responsible_id: int) -> str:
    """Тег тімліда для трекінг-сповіщень.

    Правило власника: теги тім-лідів у сповіщеннях про трекінг роботи шлемо
    ТІЛЬКИ для команд РНК (Михальчевська/Безпам'ятний) — тобто в групу РНК.
    В інші групи (РПК тощо) трекінг шлемо, але БЕЗ тегу тім-ліда. Тому для
    не-РНК менеджерів повертаємо порожній рядок.
    """
    if MANAGER_TEAM.get(responsible_id) in RNK_TEAMS:
        return SUPERVISOR_MAP.get(responsible_id, "")
    return ""


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
    """Пн–Пт, 09:00–18:30 за Києвом."""
    now_kyiv = datetime.now(KYIV_TZ)
    if now_kyiv.weekday() >= 5:
        return False
    h, m = now_kyiv.hour, now_kyiv.minute
    return (h > 9 or (h == 9 and m >= 0)) and (h < 18 or (h == 18 and m <= 30))


def _is_unassigned_hours() -> bool:
    """Пн–Нд, 09:00–18:30 за Києвом — для нерозібраних заявок."""
    now_kyiv = datetime.now(KYIV_TZ)
    h, m = now_kyiv.hour, now_kyiv.minute
    return (h > 9 or (h == 9 and m >= 0)) and (h < 18 or (h == 18 and m <= 30))


def _weekend_duty_supervisor() -> str:
    """Повертає тег чергового тімліда у вихідні: сб→Дарина, нд→Андрій."""
    weekday = datetime.now(KYIV_TZ).weekday()
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
        supervisor_tag = _tracking_supervisor_tag(responsible_id)  # тег тімліда лише для РНК
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
        # Мутуємо через посилання info, а не pending[lead_id]: паралельний
        # _handle_call міг уже зробити pop → реіндексація дала б KeyError і
        # обірвала решту проходу циклу.
        info["last_reminded_count"] = reminder_count
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
        notifier.send_message(msg)
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
    notifier.send_message(msg)
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
    days_in_month = calendar.monthrange(now.year, now.month)[1]
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
    kyiv_now = now.astimezone(KYIV_TZ)

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
                is_elogist = _detect_elogist(lead, status_id)
                # Атомарно «займаємо» лід під локом: якщо вебхук
                # (_handle_unassigned) або паралельний прохід уже додав його —
                # пропускаємо, щоб не надіслати дубль сповіщення.
                with _state_lock:
                    if lid in unassigned:
                        continue
                    unassigned[lid] = {
                        "arrived_at": arrived,
                        "status_name": status_name,
                        "lead_name": lead_name,
                        "last_reminded_count": 0,
                        "is_elogist": is_elogist,
                    }
                # Якщо сповіщення вже надсилалось до рестарту — відновлюємо
                # msg_refs з CRM-нотатки і НЕ шлемо дубль у Telegram.
                restored = _restore_unassigned_refs(lid)
                if restored is not None:
                    refs, noted_at = restored
                    unassigned[lid]["msg_refs"] = refs
                    if noted_at:
                        unassigned[lid]["arrived_at"] = datetime.fromtimestamp(noted_at, tz=timezone.utc)
                    logger.info("Restored unassigned lead %s from CRM note (no re-send)", lid)
                    continue
                # Одразу сповіщаємо про нерозібрану заявку
                kommo_url = f"https://utsercice.kommo.com/leads/detail/{lid}"
                source_line = f"\n🌐 Джерело: {source}" if source else ""
                _body = (
                    f"📬 <b>Нерозібрана заявка!</b>\n"
                    f"{_source_badge(is_elogist)}\n"
                    f"🏷 Назва: {lead_name}\n"
                    f"📍 Етап: {status_name}{source_line}\n"
                    f"⏱ Щойно виявлено сканером\n"
                )
                _tail = f"🔗 <a href='{kommo_url}'>Відкрити лід #{lid}</a>"
                _sup = f"👥 {_weekend_duty_supervisor() or ALL_SUPERVISORS}\n"
                # Шлемо з відстеженням message_id — щоб редагувати ці сповіщення,
                # коли заявку візьмуть у роботу. Тег тім-лідів — лише в спільній
                # РНК-групі; у гілки трекінгу команд — без тегу (правило власника).
                unassigned[lid]["msg_refs"] = notifier.send_unassigned_tracked(
                    _body + _sup + _tail, _body + _tail
                )
                _save_unassigned_refs(lid, unassigned[lid]["msg_refs"])
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
        # Самозцілення черги: якщо вебхук про взяття загубився — звіряємо
        # стан у CRM, щоб не нагадувати про вже опрацьований лід.
        lead = kommo.get_lead(lead_id)
        if lead:  # None = помилка API, тоді лишаємо в черзі як є
            resp_uid = lead.get("responsible_user_id", 0)
            if resp_uid and resp_uid != ADMIN_USER_ID:
                _mark_lead_taken(lead_id, resp_uid)
                continue
            if lead.get("status_id") not in UNASSIGNED_STATUSES:
                # Посунули по етапу без менеджера — просто прибираємо з черги
                unassigned.pop(lead_id, None)
                logger.info("Unassigned lead %s left queue (status moved)", lead_id)
                continue

        age_min = (now - info["arrived_at"]).total_seconds() / 60
        last = info.get("last_reminded_count", 0)
        kommo_url = f"https://utsercice.kommo.com/leads/detail/{lead_id}"

        # Ескалація на 45 хв (одноразово, позначається як count=99)
        if age_min >= 45 and last < 99:
            _body = (
                f"🔴 <b>Заявка не опрацьована більше 45 хв!</b>\n"
                f"{_source_badge(info.get('is_elogist'))}\n"
                f"🏷 Назва: {info['lead_name']}\n"
                f"📍 Етап: {info['status_name']}\n"
                f"⏱ Очікує: <b>{_format_duration(age_min)}</b>\n"
            )
            _tail = f"🔗 <a href='{kommo_url}'>Відкрити лід #{lead_id}</a>"
            _sup = f"👥 {ALL_SUPERVISORS}\n"
            # Оновлюємо те саме повідомлення (без нового спаму). Через info,
            # не unassigned[lead_id] — паралельний _mark_lead_taken міг зробити
            # pop, і реіндексація живого dict дала б KeyError. Тег тім-лідів —
            # лише в спільній РНК-групі, у гілки команд без тегу.
            notifier.edit_tracked(info.get("msg_refs", []), _body + _sup + _tail, _body + _tail)
            info["last_reminded_count"] = 99
            logger.info("Escalation for lead %s (%.0f min)", lead_id, age_min)
            continue

        # Нагадування на 15 і 30 хв (максимум 2 рази)
        if age_min < 15 or last >= 2 or last >= 99:
            continue

        reminder_count = int(age_min // 15)
        if reminder_count <= last:
            continue

        _body = (
            f"📬 <b>Нерозібрана заявка!</b>\n"
            f"{_source_badge(info.get('is_elogist'))}\n"
            f"🏷 Назва: {info['lead_name']}\n"
            f"📍 Етап: {info['status_name']}\n"
            f"⏱ Очікує: <b>{_format_duration(age_min)}</b>\n"
        )
        _tail = f"🔗 <a href='{kommo_url}'>Відкрити лід #{lead_id}</a>"
        _sup = f"👥 {tag_line}\n"
        # Оновлюємо те саме повідомлення (без нового спаму) — через info,
        # не unassigned[lead_id] (див. коментар про KeyError вище). Тег тім-лідів —
        # лише в спільній РНК-групі, у гілки команд без тегу.
        notifier.edit_tracked(info.get("msg_refs", []), _body + _sup + _tail, _body + _tail)
        info["last_reminded_count"] = reminder_count
        logger.info("Unassigned reminder #%d for lead %s (%.0f min)", reminder_count, lead_id, age_min)


# Етапи Кваліфікації, де лід вважається "в роботі" — застрягання тут варто
# нагадувати, навіть якщо вже призначений реальний менеджер. Виключені:
# NEW_FROM_LIDOGEN (щойно прийшов, трекається через pending з точністю до хвилин),
# 142 "КВАЛІФІКОВАНО" і 143 "Не цільові" (це вихід з вирки, не застрягання),
# 70419108 "Дзвінки на мобільні" (виключений з усіх сповіщень про нерозібрану
# кваліфікацію за окремим правилом).
# Включає ELOGIST_STATUS (108581472): eLogist-заявка, що зависла з реальним
# відповідальним 2+ дні, теж має флагатись як застрягла.
ACTIVE_QUAL_STATUSES = [69693648, 69693652, 69693656, 69693660, 69716160, 69738660, ELOGIST_STATUS]
STALE_QUAL_DAYS = 2
STALE_QUAL_REMINDER_HOURS = 24
_stale_qual_reminders: dict[int, datetime] = {}


def _check_stale_qualification_leads():
    """Раз на годину (робочий час) — шукає лідів у Кваліфікації без руху
    STALE_QUAL_DAYS+ днів, навіть якщо вже призначений реальний менеджер, і
    нагадує в групу його команди (РНК/РПК) з тегом. Без відповідального такі
    ліди вже трекаються через _check_unassigned_leads, тому тут пропускаються."""
    if not _is_working_hours():
        return

    now = datetime.now(timezone.utc)
    threshold = now - timedelta(days=STALE_QUAL_DAYS)
    current_stale_ids = set()

    for status_id in ACTIVE_QUAL_STATUSES:
        try:
            leads = kommo.get_pipeline_leads(QUAL_PIPELINE_ID, status_id=status_id)
        except Exception as e:
            logger.error("_check_stale_qualification_leads(%s): %s", status_id, e)
            continue

        for lead in leads:
            lead_id = lead.get("id")
            responsible_id = lead.get("responsible_user_id", 0)
            if not lead_id or not responsible_id or responsible_id == ADMIN_USER_ID:
                continue

            updated_at = lead.get("updated_at", 0)
            if not updated_at:
                continue
            updated_dt = datetime.fromtimestamp(updated_at, tz=timezone.utc)
            if updated_dt > threshold:
                continue

            current_stale_ids.add(lead_id)
            last_reminded = _stale_qual_reminders.get(lead_id)
            if last_reminded and (now - last_reminded).total_seconds() < STALE_QUAL_REMINDER_HOURS * 3600:
                continue

            age_days = (now - updated_dt).total_seconds() / 86400
            manager_name = kommo.get_user_name(responsible_id)
            tg_tag = notifier.get_manager_tag(responsible_id)
            supervisor_tag = _tracking_supervisor_tag(responsible_id)  # тег тімліда лише для РНК
            sup_part = f" {supervisor_tag}" if supervisor_tag else ""
            lead_name = lead.get("name", f"Лід #{lead_id}")
            kommo_url = f"https://utsercice.kommo.com/leads/detail/{lead_id}"
            msg = (
                f"🕒 <b>Лід без руху {int(age_days)} дн. у кваліфікації</b>\n"
                f"👤 Менеджер: <b>{manager_name}</b>{tg_tag}{sup_part}\n"
                f"🏷 Назва: {lead_name}\n"
                f"🔗 <a href='{kommo_url}'>Відкрити лід #{lead_id}</a>"
            )
            send_to_team_group(responsible_id, msg)
            _stale_qual_reminders[lead_id] = now
            logger.info("Stale qualification lead %s (%.1f days) reminded for %s", lead_id, age_days, manager_name)

    for lead_id in list(_stale_qual_reminders.keys()):
        if lead_id not in current_stale_ids:
            _stale_qual_reminders.pop(lead_id, None)


def _write_daily_snapshot():
    """Runs at 23:55 Kyiv — saves daily stats to Google Sheets."""
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
    """Щоденний AI звіт по відмовах РНК командам — о 16:50 Київ."""
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


def _enrich_campaigns_with_spend(report: dict, days: int) -> None:
    """Додає до кожної кампанії в report['campaigns'] оцінку витрат, виручку
    (по виграних угодах), маржу і CPL — джерело витрат: Google Sheets маркетингу
    (sheets.get_ad_spend_by_campaign), зіставлення назв через normalize_campaign_name."""
    spend_map = sheets.get_ad_spend_by_campaign(days)
    revenue_by_campaign: dict[str, int] = {}
    for lead in report.get("leads", []):
        if lead.get("revenue_eligible"):
            revenue_by_campaign[lead["campaign"]] = revenue_by_campaign.get(lead["campaign"], 0) + lead["amount"]

    for name, c in report["campaigns"].items():
        spend_entry = spend_map.get(sheets.normalize_campaign_name(name))
        revenue = revenue_by_campaign.get(name, 0)
        c["revenue"] = revenue
        if spend_entry:
            spend = spend_entry["estimated_period_cost"]
            c["spend"] = spend
            c["margin"] = round(revenue - spend, 2)
            c["cpl"] = round(spend / c["total"], 2) if c["total"] else 0.0
            c["roas"] = round(revenue / spend * 100, 1) if spend else None
        else:
            c["spend"] = None
            c["margin"] = None
            c["cpl"] = None
            c["roas"] = None


def _pct_change(current: float, previous: float) -> str:
    """Знак+відсоток зміни для WoW-порівняння, напр. '+12.5%' / '-8.0%' / '0%'."""
    if not previous:
        return "—" if not current else "нове"
    delta = (current - previous) / previous * 100
    sign = "+" if delta >= 0 else ""
    return f"{sign}{delta:.1f}%"


def _build_wow_comparison(report: dict, prev_report: dict, label: str = "WoW") -> list[str]:
    """Порівняння ключових метрик з попереднім рівновеликим періодом
    (label: 'WoW' для тижня, 'MoM' для місяця)."""
    total = report["total"]
    prev_total = prev_report["total"]
    if not prev_total:
        return []

    conv = lambda r: round(
        sum(c["won"] for c in r["campaigns"].values())
        / max(sum(c["won"] + c["lost"] for c in r["campaigns"].values()), 1) * 100, 1
    )
    revenue = lambda r: sum(c.get("revenue", 0) for c in r["campaigns"].values())

    lines = [f"\n📊 <b>Порівняння з попереднім періодом ({label}):</b>"]
    lines.append(f"• Угод: {total} ({_pct_change(total, prev_total)})")
    lines.append(f"• Конверсія: {conv(report)}% (попередньо {conv(prev_report)}%)")
    if any(c.get("revenue") is not None for c in report["campaigns"].values()):
        lines.append(
            f"• Виручка: {revenue(report):,.0f} грн ({_pct_change(revenue(report), revenue(prev_report))})".replace(",", " ")
        )
    return lines


def _build_repeat_customers_block(repeat_info: dict) -> list[str]:
    lines = ["\n🔁 <b>Повторні клієнти з реклами:</b>"]
    repeat_count = repeat_info.get("repeat_count", 0)
    new_count = repeat_info.get("new_count", 0)
    total = repeat_count + new_count
    if total == 0:
        lines.append("— немає успішних угод з реклами за період")
        return lines
    lines.append(f"• Повторних (2+ замовлення): <b>{repeat_count}</b> з {total}")
    lines.append(f"• Нових: {new_count} з {total}")
    for c in repeat_info.get("repeat_customers", [])[:5]:
        lines.append(f"• {c['name']} ({c['campaign']}, {c['manager_name']}) — всього замовлень: {c['total_orders']}")
    return lines


def _build_ad_report_text(
    report: dict,
    days: int = 7,
    prev_report: dict | None = None,
    repeat_info: dict | None = None,
    title: str | None = None,
    comparison_label: str = "WoW",
    empty_note: str | None = None,
) -> str:
    total = report["total"]
    non_target_total = report.get("non_target_total", 0)
    campaigns = report["campaigns"]

    header = title or f"📢 <b>Тижневий звіт по рекламі</b> (останні {days} днів)"

    if total == 0:
        return f"{header}\n{empty_note or 'Цього тижня угод з реклами не надходило.'}"

    MIN_DEALS_FOR_RANKING = 3  # щоб 1 угода з 1 виграною не виглядала як "100% конверсія"

    ranked = [(name, c) for name, c in campaigns.items() if c["total"] >= MIN_DEALS_FOR_RANKING]
    by_conversion = sorted(ranked, key=lambda x: x[1]["conversion"], reverse=True)
    by_lost = sorted(campaigns.items(), key=lambda x: x[1]["lost"], reverse=True)
    by_non_target = sorted(campaigns.items(), key=lambda x: x[1]["non_target"], reverse=True)

    non_target_pct = round(non_target_total / total * 100, 1) if total else 0.0

    lines = [
        header,
        f"📥 Всього угод з реклами: <b>{total}</b>",
        f"🚫 З них нецільові: <b>{non_target_total}</b> ({non_target_pct}%)\n",
    ]

    lines.append("🏆 <b>Найуспішніші/найефективніші кампанії:</b>")
    if by_conversion:
        for name, c in by_conversion[:5]:
            lines.append(
                f"• {name} — {c['won']}/{c['total']} угод у успіху, конверсія <b>{c['conversion']}%</b>"
            )
    else:
        lines.append(f"— недостатньо даних (потрібно ≥{MIN_DEALS_FOR_RANKING} угод по кампанії)")

    lines.append("\n🔴 <b>Найбільше закрито не реалізовано:</b>")
    top_lost = [(name, c) for name, c in by_lost if c["lost"] > 0][:5]
    if top_lost:
        for name, c in top_lost:
            lines.append(f"• {name} — {c['lost']} закрито з {c['total']} угод")
    else:
        lines.append("— закритих не реалізовано угод немає")

    lines.append("\n🚫 <b>Найбільше нецільових лідів по кампаніях:</b>")
    top_non_target = [(name, c) for name, c in by_non_target if c["non_target"] > 0][:5]
    if top_non_target:
        for name, c in top_non_target:
            lines.append(f"• {name} — {c['non_target']} нецільових з {c['total']} лідів")
    else:
        lines.append("— нецільових лідів немає")

    in_progress_total = sum(c["in_progress"] for c in campaigns.values())
    lines.append(f"\n⏳ Ще в роботі: <b>{in_progress_total}</b>")

    with_spend = [(name, c) for name, c in campaigns.items() if c.get("spend") is not None]
    if with_spend:
        total_spend = sum(c["spend"] for _, c in with_spend)
        total_revenue = sum(c["revenue"] for _, c in with_spend)
        total_margin = round(total_revenue - total_spend, 2)
        lines.append(
            f"\n💰 <b>Витрати на рекламу (оцінка, Google):</b> {total_spend:,.0f} грн".replace(",", " ")
        )
        lines.append(
            (f"📈 Виручка по успішних угодах: {total_revenue:,.0f} грн | "
             f"Маржа: <b>{total_margin:,.0f} грн</b>").replace(",", " ")
        )
        by_margin = sorted(with_spend, key=lambda x: x[1]["margin"], reverse=True)
        lines.append("\n💹 <b>Маржинальність по кампаніях:</b>")
        for name, c in by_margin[:5]:
            roas_part = f", ROAS {c['roas']:.0f}%" if c.get("roas") is not None else ""
            lines.append(
                (f"• {name} — витрати ~{c['spend']:,.0f} грн, виручка {c['revenue']:,.0f} грн, "
                 f"маржа <b>{c['margin']:,.0f} грн</b>, CPL ~{c['cpl']:.0f} грн{roas_part}").replace(",", " ")
            )
    else:
        lines.append("\n💰 Дані по витратах на рекламу недоступні (немає збігу кампаній з таблицею маркетингу).")

    if repeat_info is not None:
        lines.extend(_build_repeat_customers_block(repeat_info))

    if prev_report and prev_report.get("total"):
        lines.extend(_build_wow_comparison(report, prev_report, label=comparison_label))

    return "\n".join(lines)


def _send_weekly_ad_report() -> None:
    """Щоп'ятничний звіт по рекламних кампаніях за тиждень: текст + xlsx з деталізацією,
    WoW-порівняння з попереднім тижнем і тренд за останні 3 місяці (12 тижнів)."""
    days = 7
    report = kommo.get_weekly_ad_campaign_report(days)
    prev_report = kommo.get_weekly_ad_campaign_report(days, offset_days=days)
    if report["total"] > 0:
        _enrich_campaigns_with_spend(report, days)
    if prev_report["total"] > 0:
        _enrich_campaigns_with_spend(prev_report, days)
    repeat_info = kommo.get_repeat_customers(report) if report["total"] > 0 else None
    text = _build_ad_report_text(report, days, prev_report, repeat_info)
    notifier.send_ad_report(text)
    if report["total"] > 0:
        trend = kommo.get_campaign_trend(weeks=12)
        excel_bytes = excel_report.build_ad_report_excel(report, days, trend=trend, repeat_info=repeat_info)
        filename = f"ad_report_{datetime.now(timezone.utc).strftime('%Y-%m-%d')}.xlsx"
        notifier.send_ad_report_file(filename, excel_bytes, caption="📎 Деталізація по угодах і кампаніях")
    logger.info("Weekly ad report sent")


_UA_MONTHS = {
    1: "січень", 2: "лютий", 3: "березень", 4: "квітень", 5: "травень", 6: "червень",
    7: "липень", 8: "серпень", 9: "вересень", 10: "жовтень", 11: "листопад", 12: "грудень",
}


def _enrich_campaigns_with_spend_month(report: dict, year: int, month: int) -> None:
    """Як _enrich_campaigns_with_spend, але витрати — повний підсумок за
    завершений календарний місяць (sheets.get_ad_spend_by_campaign_for_month)."""
    spend_map = sheets.get_ad_spend_by_campaign_for_month(year, month)
    revenue_by_campaign: dict[str, int] = {}
    for lead in report.get("leads", []):
        if lead.get("revenue_eligible"):
            revenue_by_campaign[lead["campaign"]] = revenue_by_campaign.get(lead["campaign"], 0) + lead["amount"]

    for name, c in report["campaigns"].items():
        spend_entry = spend_map.get(sheets.normalize_campaign_name(name))
        revenue = revenue_by_campaign.get(name, 0)
        c["revenue"] = revenue
        if spend_entry:
            spend = spend_entry["estimated_period_cost"]
            c["spend"] = spend
            c["margin"] = round(revenue - spend, 2)
            c["cpl"] = round(spend / c["total"], 2) if c["total"] else 0.0
            c["roas"] = round(revenue / spend * 100, 1) if spend else None
        else:
            c["spend"] = None
            c["margin"] = None
            c["cpl"] = None
            c["roas"] = None


def _send_monthly_ad_report(year: int | None = None, month: int | None = None) -> None:
    """Місячний звіт по рекламі у форматі тижневого, з MoM-порівнянням із
    попереднім місяцем. Без аргументів — за МИНУЛИЙ місяць (для запуску 1-го
    числа). Витрати беруться з блоку відповідного місяця (повний підсумок)."""
    now = datetime.now(timezone.utc)
    if year is None or month is None:
        # місяць, що щойно завершився
        month = now.month - 1 or 12
        year = now.year if now.month > 1 else now.year - 1
    pmonth = month - 1 or 12
    pyear = year if month > 1 else year - 1

    report = kommo.get_ad_campaign_report_for_month(year, month)
    prev_report = kommo.get_ad_campaign_report_for_month(pyear, pmonth)
    if report["total"] > 0:
        _enrich_campaigns_with_spend_month(report, year, month)
    if prev_report["total"] > 0:
        _enrich_campaigns_with_spend_month(prev_report, pyear, pmonth)
    repeat_info = kommo.get_repeat_customers(report) if report["total"] > 0 else None

    mname = _UA_MONTHS.get(month, str(month))
    title = f"📢 <b>Місячний звіт по рекламі</b> — {mname} {year}"
    empty_note = f"За {mname} {year} угод з реклами не надходило."
    text = _build_ad_report_text(
        report, days=0, prev_report=prev_report, repeat_info=repeat_info,
        title=title, comparison_label="MoM", empty_note=empty_note,
    )
    notifier.send_ad_report(text)
    if report["total"] > 0:
        try:
            excel_bytes = excel_report.build_ad_report_excel(report, 0, trend=None, repeat_info=repeat_info)
            filename = f"ad_report_{year}-{month:02d}.xlsx"
            notifier.send_ad_report_file(filename, excel_bytes, caption=f"📎 Деталізація за {mname} {year}")
        except Exception as e:
            logger.error("monthly ad report xlsx: %s", e)
    logger.info("Monthly ad report sent for %s-%02d", year, month)


_last_ad_report_error: dict = {"error": None}


@app.route("/last-ad-report-error", methods=["GET"])
def last_ad_report_error_endpoint():
    """Діагностика: результат останньої спроби побудувати/надіслати xlsx у фоні."""
    return jsonify(_last_ad_report_error)


@app.route("/send-ad-report", methods=["GET"])
def send_ad_report_endpoint():
    """Ручний запуск/перевірка тижневого звіту по рекламі.
    ?days=7 (default) ?dry=1 щоб лише показати текст (без xlsx) ?excel=1 щоб теж надіслати xlsx."""
    days = int(request.args.get("days", 7))
    report = kommo.get_weekly_ad_campaign_report(days)
    prev_report = kommo.get_weekly_ad_campaign_report(days, offset_days=days)
    if report["total"] > 0:
        _enrich_campaigns_with_spend(report, days)
    if prev_report["total"] > 0:
        _enrich_campaigns_with_spend(prev_report, days)
    repeat_info = kommo.get_repeat_customers(report) if report["total"] > 0 else None
    text = _build_ad_report_text(report, days, prev_report, repeat_info)
    if request.args.get("dry") == "1":
        return jsonify({"ok": True, "text": text, "leads_count": len(report["leads"])})
    notifier.send_ad_report(text)
    excel_queued = False
    if request.args.get("excel") == "1" and report["total"] > 0:
        # Тренд за 12 тижнів — окремий важкий запит до Kommo (~60-90с), не
        # тримаємо HTTP-запит відкритим — будуємо й надсилаємо xlsx у фоні.
        def _build_and_send_excel():
            try:
                trend = kommo.get_campaign_trend(weeks=12)
                excel_bytes = excel_report.build_ad_report_excel(report, days, trend=trend, repeat_info=repeat_info)
                filename = f"ad_report_{datetime.now(timezone.utc).strftime('%Y-%m-%d')}.xlsx"
                ok = notifier.send_ad_report_file(filename, excel_bytes, caption="📎 Деталізація по угодах і кампаніях")
                _last_ad_report_error["error"] = None if ok else "send_ad_report_file returned False"
            except Exception as e:
                logger.error("_build_and_send_excel failed: %s", e, exc_info=True)
                _last_ad_report_error["error"] = repr(e)

        threading.Thread(target=_build_and_send_excel, daemon=True).start()
        excel_queued = True
    return jsonify({"ok": True, "sent": True, "excel_queued": excel_queued, "text": text})


@app.route("/send-monthly-ad-report", methods=["GET"])
def send_monthly_ad_report_endpoint():
    """Ручний запуск місячного звіту по рекламі.
    ?year=2026&month=7 — конкретний місяць (за замовч. — минулий місяць).
    ?dry=1 — лише показати текст (без відправки в Telegram)."""
    year = request.args.get("year")
    month = request.args.get("month")
    year = int(year) if year else None
    month = int(month) if month else None
    if request.args.get("dry") == "1":
        now = datetime.now(timezone.utc)
        y = year if year is not None else (now.year if now.month > 1 else now.year - 1)
        m = month if month is not None else (now.month - 1 or 12)
        pm = m - 1 or 12
        py = y if m > 1 else y - 1
        report = kommo.get_ad_campaign_report_for_month(y, m)
        prev_report = kommo.get_ad_campaign_report_for_month(py, pm)
        if report["total"] > 0:
            _enrich_campaigns_with_spend_month(report, y, m)
        if prev_report["total"] > 0:
            _enrich_campaigns_with_spend_month(prev_report, py, pm)
        repeat_info = kommo.get_repeat_customers(report) if report["total"] > 0 else None
        mname = _UA_MONTHS.get(m, str(m))
        text = _build_ad_report_text(
            report, days=0, prev_report=prev_report, repeat_info=repeat_info,
            title=f"📢 <b>Місячний звіт по рекламі</b> — {mname} {y}",
            comparison_label="MoM", empty_note=f"За {mname} {y} угод з реклами не надходило.",
        )
        return jsonify({"ok": True, "text": text, "leads_count": len(report["leads"])})
    threading.Thread(target=_send_monthly_ad_report, kwargs={"year": year, "month": month}, daemon=True).start()
    return jsonify({"ok": True, "queued": True, "year": year, "month": month})


WEBHOOK_URL = "https://my-bot-8nib.onrender.com/webhook"
WEBHOOK_SETTINGS = ["note_lead", "status_lead", "update_lead", "responsible_lead"]


def _check_webhook_health():
    """Kommo сам відключає вебхук після серії помилок доставки (saw this happen
    silently — leads kept closing but no events ever reached the bot). Перевіряємо
    раз на 20 хв і автоматично перевидаємо підписку, якщо вона вимкнена."""
    webhooks = kommo.get_webhooks()
    hook = next((w for w in webhooks if w.get("destination") == WEBHOOK_URL), None)
    if hook is None:
        notifier.send_message(f"⚠️ Вебхук бота ({WEBHOOK_URL}) відсутній у Kommo! Сповіщення не приходитимуть.")
        logger.error("Webhook health check: subscription not found")
        return
    if hook.get("disabled"):
        ok = kommo.reenable_webhook(WEBHOOK_URL, WEBHOOK_SETTINGS)
        if ok:
            notifier.send_message("🔧 Kommo автоматично вимкнув вебхук бота (помилки доставки) — перевидано, знову активний.")
            logger.warning("Webhook health check: was disabled, re-created successfully")
        else:
            notifier.send_message("🔴 Вебхук бота вимкнений Kommo, автовідновлення не вдалось! Потрібна ручна перевірка.")
            logger.error("Webhook health check: was disabled, re-creation FAILED")


# Cron-джоби задаються в КИЇВСЬКОМУ часі — pytz/tzdata самі враховують
# переведення годинників (влітку UTC+3, взимку UTC+2).
scheduler = BackgroundScheduler(timezone="Europe/Kyiv")
scheduler.add_job(_check_webhook_health, "interval", minutes=20)
scheduler.add_job(_check_overdue_leads, "interval", minutes=5)
scheduler.add_job(_check_unassigned_leads, "interval", minutes=15)
scheduler.add_job(_check_stale_qualification_leads, "interval", hours=1)
scheduler.add_job(_write_daily_snapshot, "cron", hour=23, minute=55)     # 23:55 Kyiv — денний зріз
scheduler.add_job(_send_daily_plan_report, "cron", hour=18, minute=0)    # 18:00 Kyiv
scheduler.add_job(_send_month_end_report, "interval", hours=1)           # останній день місяця — щогодини
scheduler.add_job(_send_rnk_ai_report, "cron", hour=16, minute=50)       # 16:50 Kyiv
scheduler.add_job(_send_rnk_daily_reminder, "cron", hour=17, minute=0)   # 17:00 Kyiv
scheduler.add_job(_send_weekly_ad_report, "cron", day_of_week="fri", hour=17, minute=0)  # П'ятниця 17:00 Kyiv
scheduler.add_job(_send_monthly_ad_report, "cron", day=1, hour=9, minute=0)  # 1-ше число 09:00 Kyiv — звіт за минулий місяць
scheduler.add_job(_refresh_plans_from_sheet, "cron", hour=6, minute=0)   # плани з таблиці, 06:00 Kyiv
# і одразу на старті (деплой міг статися після редагування таблиці)
threading.Thread(target=_refresh_plans_from_sheet, daemon=True).start()
scheduler.start()
# Джоба першого дотику реєструється нижче, після визначення функції
# (_send_first_touch_admin_report оголошена далі у файлі) — інакше NameError на старті.

# eLogist userbot — читає групу "Дошка оголошень" під юзер-акаунтом (Telethon),
# бо Bot API не віддає повідомлення від TransNowBot (бот не бачить інших ботів).
# Стартує лише якщо задані TG_API_ID/TG_API_HASH/TG_SESSION, інакше тихо пропускає.
elogist_userbot.start_listener(_handle_elogist_message)
sheets.ensure_headers()

# In-memory: lead_id -> {transferred_at, manager, lead_name}
pending: dict[int, dict] = {}

# Stats log: list of {ts: datetime, manager_id: int}
_stats_log: list[dict] = []

# Антигеймінг: manager_id -> кількість угод, повернутих AI з "Не цільові" (з моменту останнього деплою)
_nontarget_returns: dict[int, int] = {}


def _parse_statuses(data: dict) -> list[dict]:
    """Extract status change info for every lead in this webhook call.
    Kommo can batch several lead status changes into a single webhook request
    (leads[status][0], leads[status][1], ...) — processing only index 0 silently
    drops every other lead in the batch."""
    # JSON format
    if isinstance(data.get("leads"), dict):
        items = data["leads"].get("status", []) or data["leads"].get("add", [])
        if items and isinstance(items, list):
            return items

    # Form-encoded format
    result = []
    i = 0
    while True:
        lead_id = data.get(f"leads[status][{i}][id]") or data.get(f"leads[add][{i}][id]")
        if not lead_id:
            break
        result.append({
            "id": int(lead_id),
            "status_id": int(data.get(f"leads[status][{i}][status_id]", 0) or 0),
            "old_status_id": int(data.get(f"leads[status][{i}][old_status_id]", 0) or 0),
            "pipeline_id": int(data.get(f"leads[status][{i}][pipeline_id]", 0) or 0),
            "responsible_user_id": int(data.get(f"leads[status][{i}][responsible_user_id]", 0) or 0),
        })
        i += 1
    return result


def _parse_responsible_changes(data: dict) -> list[dict]:
    """Extract responsible-changed events (Отв-й сделки изменен) for every lead in
    this webhook call (see _parse_statuses for why batching matters)."""
    result = []
    i = 0
    while True:
        lead_id = data.get(f"leads[responsible][{i}][id]")
        if not lead_id:
            break
        result.append({
            "id": int(lead_id),
            "responsible_user_id": int(data.get(f"leads[responsible][{i}][responsible_user_id]", 0) or 0),
            "pipeline_id": int(data.get(f"leads[responsible][{i}][pipeline_id]", 0) or 0),
            "status_id": int(data.get(f"leads[responsible][{i}][status_id]", 0) or 0),
        })
        i += 1
    return result


def _parse_notes(data: dict) -> list[dict]:
    """Extract call note info (note_type 10=call_in, 11=call_out) for every note in
    this webhook call (see _parse_statuses for why batching matters)."""
    result = []
    i = 0
    while True:
        # Kommo надсилає нотатки у двох форматах: пласкому
        # (leads[note][i][note_type]) і вкладеному (leads[note][i][note][note_type]).
        # Підтримуємо обидва — беремо перше непорожнє значення для кожного поля.
        def field(name):
            return (data.get(f"leads[note][{i}][note][{name}]")
                    or data.get(f"leads[note][{i}][{name}]"))
        note_type = field("note_type")
        lead_id = field("element_id")
        if not (note_type and lead_id):
            break
        result.append({
            "note_type": str(note_type),
            "lead_id": int(lead_id),
            "responsible_user_id": int(field("main_user_id") or 0),
            "note_id": int(field("id") or 0),
        })
        i += 1
    return result


def _process_status_change(item: dict):
    """Handle a single lead status-change event (one of possibly several batched
    into one webhook call)."""
    lead_id = int(item.get("id", 0))
    status_id = int(item.get("status_id", 0))
    old_status_id = int(item.get("old_status_id", 0))
    pipeline_id = int(item.get("pipeline_id", 0))
    responsible_id = int(item.get("responsible_user_id", 0))

    # Нерозібрані заявки — лід отримав реального відповідального → редагуємо
    # те саме повідомлення на «Взято в роботу» (без нового спаму) і прибираємо
    # з черги. Умова по old_status покриває випадок, коли черга обнулилась
    # рестартом (тоді refs відновлюються з CRM-нотатки всередині).
    if responsible_id and responsible_id != ADMIN_USER_ID and (
            lead_id in unassigned or old_status_id in UNASSIGNED_STATUSES):
        _mark_lead_taken(lead_id, responsible_id)

    if pipeline_id == PEREVOZY_PIPELINE_ID:
        if (status_id == CLOSED_NOT_REALIZED and old_status_id != status_id
                and responsible_id and responsible_id != ADMIN_USER_ID):
            # _handle_closed_not_realized сама маршрутизує в РНК (з AI-аналізом)
            # чи РПК (просте сповіщення) залежно від команди — раніше тут
            # помилково пускали лише DARINA_ANDRIY_TEAMS (РНК), тож РПК-команди
            # не отримували сповіщень про "Закрито і не реалізовано" взагалі.
            threading.Thread(
                target=_handle_closed_not_realized,
                args=(lead_id, responsible_id, old_status_id, pipeline_id),
                daemon=True,
            ).start()
            threading.Thread(
                target=_check_duplicate_reference,
                args=(lead_id, responsible_id),
                daemon=True,
            ).start()
        elif status_id == WON_STATUS_ID:
            lead = kommo.get_lead(lead_id)
            amount = int(lead.get("price", 0)) if lead else 0
            _handle_won_deal(lead_id, responsible_id, amount)
        elif status_id == 69716460:  # Оплата отримана
            if responsible_id in MANAGER_PLANS:
                _check_plan_completion(responsible_id)
        return

    if pipeline_id != QUAL_PIPELINE_ID:
        return

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

    elif status_id == NON_TARGET_STATUS and old_status_id != status_id:
        threading.Thread(
            target=_check_non_target_lead,
            args=(lead_id, responsible_id),
            daemon=True,
        ).start()
        threading.Thread(
            target=_check_duplicate_reference,
            args=(lead_id, responsible_id),
            daemon=True,
        ).start()


_recent_webhooks: deque = deque(maxlen=30)


@app.route("/webhook", methods=["POST"])
def webhook():
    # ⏸ Пауза синхронізації з Kommo: приймаємо 200 (щоб Kommo не ретраїв), але
    # НЕ обробляємо подію й не робимо вихідних запитів. Відновлення — зняти
    # kommo.SYNC_PAUSED (env KOMMO_SYNC_PAUSED=0 або деплой). Див. kommo.py.
    if kommo.SYNC_PAUSED:
        return jsonify({"ok": True, "paused": True})

    content_type = request.content_type or ""
    if "application/json" in content_type:
        data = request.get_json(force=True, silent=True) or {}
    else:
        data = request.form.to_dict()

    _recent_webhooks.append({"ts": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"), "data": data})

    logger.info("Webhook received: %s", data)

    # ── Call notes (Ringostat) ──────────────────────────────────────
    notes = _parse_notes(data)
    handled_notes = False
    for note in notes:
        if note["note_type"] in ("10", "11", "call_in", "call_out"):
            _handle_call(note)
            handled_notes = True
    if handled_notes:
        return jsonify({"ok": True})

    # ── Responsible changed ───────────────────────────────────────
    resp_changes = _parse_responsible_changes(data)
    if resp_changes:
        for resp_change in resp_changes:
            # Лід із черги нерозібраних міг бути взятий зміною ЛИШЕ
            # відповідального (без руху по етапу) — цей вебхук приходить
            # окремо від зміни статусу, тож черга чистилась би тільки
            # по статусу і нагадування сипались би на вже взятий лід.
            new_resp = resp_change.get("responsible_user_id", 0)
            if (new_resp and new_resp != ADMIN_USER_ID
                    and (resp_change["id"] in unassigned
                         or resp_change.get("status_id") in UNASSIGNED_STATUSES)):
                _mark_lead_taken(resp_change["id"], new_resp)
            if (resp_change["pipeline_id"] == QUAL_PIPELINE_ID and
                    resp_change["status_id"] == NEW_FROM_LIDOGEN):
                # old_status_id недоступний поза payload вебхука зміни статусу
                # (GET /leads/{id} його не віддає, тож перевірка була мертвою і
                # завжди читала 0). SKIP_FROM_STATUSES тут не оцінити; дедуп
                # повторної передачі забезпечує сам _handle_new_lead
                # (pending + _notified_new_leads).
                _handle_new_lead(resp_change["id"], resp_change["responsible_user_id"])
        return jsonify({"ok": True})

    # ── Status changes ─────────────────────────────────────────────
    items = _parse_statuses(data)
    if not items:
        logger.warning("Could not parse webhook payload")
        return jsonify({"ok": True})

    for item in items:
        _process_status_change(item)

    return jsonify({"ok": True})


def _mark_lead_taken(lead_id: int, responsible_id: int):
    """Лід із черги нерозібраних отримав реального відповідального:
    редагуємо сповіщення на «Взято в роботу» і прибираємо з черги.
    Викликається і з вебхука зміни статусу, і з вебхука зміни
    відповідального, і з самозцілення в _check_unassigned_leads."""
    info = unassigned.pop(lead_id, None)
    if info is None:
        # Черга могла обнулитись рестартом — пробуємо відновити refs з
        # CRM-нотатки, щоб повідомлення в TG таки стало «Взято в роботу».
        restored = _restore_unassigned_refs(lead_id)
        if restored is None:
            return
        refs, noted_at = restored
        lead = kommo.get_lead(lead_id)
        info = {
            "arrived_at": datetime.fromtimestamp(noted_at, tz=timezone.utc) if noted_at else None,
            "lead_name": (lead or {}).get("name", f"Лід #{lead_id}"),
            "status_name": UNASSIGNED_STATUSES.get((lead or {}).get("status_id", 0), "—"),
            "is_elogist": _detect_elogist(lead),
            "msg_refs": refs,
        }
    manager_name = kommo.get_user_name(responsible_id)
    tg_tag = notifier.get_manager_tag(responsible_id)
    waited_min = int((datetime.now(timezone.utc) - info["arrived_at"]).total_seconds() / 60) if info.get("arrived_at") else 0
    kommo_url = f"https://utsercice.kommo.com/leads/detail/{lead_id}"
    msg = (
        f"✅ <b>Взято в роботу</b>\n"
        f"{_source_badge(info.get('is_elogist'))}\n"
        f"🏷 Назва: {info.get('lead_name', f'Лід #{lead_id}')}\n"
        f"📍 Етап: {info.get('status_name', '—')}\n"
        f"👤 Менеджер: <b>{manager_name}</b>{tg_tag}\n"
        f"⏱ Час очікування: <b>{waited_min} хв</b>\n"
        f"🔗 <a href='{kommo_url}'>Відкрити лід #{lead_id}</a>"
    )
    # Редагуємо початкове сповіщення по місцю; якщо рефів немає (напр. після
    # рестарту) — фолбек на звичайне повідомлення в групу команди.
    if info.get("msg_refs"):
        notifier.edit_tracked(info["msg_refs"], msg)
    else:
        send_to_team_group(responsible_id, msg)
    # Маркер «взято» в CRM: щоб відновлення після рестарту не воскрешало
    # вже опрацьовану заявку і не глушило сповіщення при повторному падінні
    # ліда в нерозібрані.
    kommo.add_note(lead_id, f"{UNASSIGNED_TAKEN_MARKER}: {manager_name}, очікування {waited_min} хв")
    logger.info("Lead %s assigned to %s after %d min", lead_id, manager_name, waited_min)


def _handle_unassigned(lead_id: int, status_id: int):
    now = datetime.now(timezone.utc)
    status_name = UNASSIGNED_STATUSES.get(status_id, "—")

    # Атомарно «займаємо» слот під локом: скан (_scan_unassigned_leads) міг
    # стартувати одночасно на іншому треді — так на один лід не піде два
    # повідомлення. Поля, потрібні циклу нагадувань, заповнюємо одразу;
    # lead_name/is_elogist уточнимо після GET (msg_refs — після надсилання).
    with _state_lock:
        if lead_id in unassigned:
            return  # вже в черзі
        unassigned[lead_id] = {
            "arrived_at": now,
            "status_name": status_name,
            "lead_name": f"Лід #{lead_id}",
            "last_reminded_count": 0,
            "is_elogist": False,
        }

    lead = kommo.get_lead(lead_id)
    lead_name = lead.get("name", f"Лід #{lead_id}") if lead else f"Лід #{lead_id}"
    source = kommo.get_lead_source(lead) if lead else ""
    is_elogist = _detect_elogist(lead, status_id)
    kommo_url = f"https://utsercice.kommo.com/leads/detail/{lead_id}"
    unassigned[lead_id]["lead_name"] = lead_name
    unassigned[lead_id]["is_elogist"] = is_elogist

    # Сповіщення могло вже піти до рестарту (вебхук повторився / скан
    # встиг раніше) — тоді відновлюємо msg_refs і не шлемо дубль.
    restored = _restore_unassigned_refs(lead_id)
    if restored is not None:
        refs, noted_at = restored
        unassigned[lead_id]["msg_refs"] = refs
        if noted_at:
            unassigned[lead_id]["arrived_at"] = datetime.fromtimestamp(noted_at, tz=timezone.utc)
        logger.info("Restored unassigned lead %s from CRM note (no re-send)", lead_id)
        return

    source_line = f"\n🌐 Джерело: {source}" if source else ""
    _body = (
        f"📬 <b>Нерозібрана заявка!</b>\n"
        f"{_source_badge(is_elogist)}\n"
        f"🏷 Назва: {lead_name}\n"
        f"📍 Етап: {status_name}{source_line}\n"
        f"⏱ Щойно надійшла\n"
    )
    _tail = f"🔗 <a href='{kommo_url}'>Відкрити лід #{lead_id}</a>"
    _sup = f"👥 {_weekend_duty_supervisor() or ALL_SUPERVISORS}\n"
    # Тег тім-лідів — лише в спільній РНК-групі; у гілки команд без тегу.
    msg_refs = notifier.send_unassigned_tracked(_body + _sup + _tail, _body + _tail)
    unassigned[lead_id]["msg_refs"] = msg_refs
    _save_unassigned_refs(lead_id, msg_refs)
    logger.info("Unassigned lead %s in status %s", lead_id, status_name)


def _gather_deal_context(lead_id: int, manager_name: str):
    """Збирає повний контекст угоди для AI-оцінки якості закриття:
    тексти всіх нотаток CRM, транскрипти всіх дзвінків (беруться з аркуша
    «Дзвінки РНК», а відсутні — дотранскрибовуються), і статистику спроб
    контакту (к-сть дзвінків + у скільки різних днів). Повертає
    (notes_text, calls_text, contact_summary)."""
    notes = kommo.get_lead_notes(lead_id)
    note_texts = [
        ((n.get("params") or {}).get("text") or "").strip()
        for n in notes
        if n.get("note_type") in (4, "common") and (n.get("params") or {}).get("text")
    ]
    notes_text = "\n".join(f"- {t}" for t in note_texts)[:4000]

    call_notes = sorted(
        (n for n in notes if n.get("note_type") in (10, 11, "call_in", "call_out")),
        key=lambda n: n.get("created_at", 0),
    )
    attempts = len(call_notes)
    days = set()
    for n in call_notes:
        ts = n.get("created_at", 0)
        if ts:
            days.add(datetime.fromtimestamp(ts, tz=timezone.utc).date().isoformat())

    # Транскрипти: якщо вже накопичені в аркуші (транскрибовані за життя угоди) —
    # беремо звідти (без повторної транскрибації); інакше транскрибуємо ≥40с
    # дзвінки зараз (з обмеженням, щоб не перевантажувати).
    calls = sheets.get_calls_for_lead(lead_id)
    if not calls:
        for n in call_notes[:15]:
            nid = n.get("id")
            full = kommo.get_note(lead_id, nid) if nid else n
            params = full.get("params") or {}
            dur = int(params.get("duration", 0) or 0)
            if dur < 40:
                continue
            link = params.get("link", "") or params.get("LINK", "")
            tr = transcriber.transcribe_call(link) if link else ""
            ctype = "вхідний" if full.get("note_type") in (10, "call_in") else "вихідний"
            ts = full.get("created_at", 0)
            at = datetime.fromtimestamp(ts, tz=timezone.utc) if ts else datetime.now(timezone.utc)
            sheets.append_call(lead_id, manager_name, ctype, dur, tr, at)
        calls = sheets.get_calls_for_lead(lead_id)

    calls_text = ""
    for i, c in enumerate(calls, 1):
        tr = (c.get("Транскрипт") or "")[:1500]
        calls_text += (
            f"\n[Дзвінок {i} {c.get('Дата','')} {c.get('Тип','')} "
            f"{c.get('Тривалість (с)','?')}с]\n{tr}"
        )
    calls_text = calls_text[:6000]

    contact_summary = (
        f"Спроби контакту: {attempts} дзвінк(ів) у {len(days)} різни(х) дн(ів)."
    )
    return notes_text, calls_text, contact_summary


def _handle_closed_not_realized(lead_id: int, responsible_id: int, old_status_id: int = 0, pipeline_id: int = 0):
    lead = kommo.get_lead(lead_id)

    # Перевезення «По місту» (без маржі) — повний ігнор: без аналізу,
    # повернення й сповіщень (бізнес-правило).
    if lead and kommo.is_city_transport(lead):
        logger.info("Closed lead %s — перевезення по місту, повний ігнор", lead_id)
        return

    # AI-аналіз і повернення — ЛИШЕ для команд РНК. Угоди, які закриває РПК
    # (та невідомі команди), цьому флоу НЕ піддаються: без аналізу, повернення
    # й сповіщень. Виходимо до будь-яких важких запитів/транскрибації.
    team = MANAGER_TEAM.get(responsible_id, "")
    if team not in RNK_TEAMS:
        logger.info("Closed lead %s — команда «%s» не РНК → без AI-аналізу й повернення (тихо)", lead_id, team or "—")
        return

    details = kommo.get_lead_details(lead_id, old_status_id, pipeline_id)
    manager_name = kommo.get_user_name(responsible_id) if responsible_id else "—"
    tg_tag = notifier.get_manager_tag(responsible_id)
    supervisor_tag = SUPERVISOR_MAP.get(responsible_id, "")
    kommo_url = f"https://utsercice.kommo.com/leads/detail/{lead_id}"
    sup_part = f" {supervisor_tag}" if supervisor_tag else ""

    reason = details["reject_reason"] or "не вказана"
    reason_lower = (details["reject_reason"] or "").lower()
    is_duplicate = "дубл" in reason_lower
    is_test = "тест" in reason_lower
    no_return = is_duplicate or is_test  # легітимні закриття
    last_status = details["last_status"] or "—"
    amount = int(lead.get("price", 0)) if lead else 0

    # Анти-цикл / повага до правок тімліда: якщо угоду вже повертали (тег
    # «Повернуто АІ») — не повертаємо повторно (рішення тімліда головніше за AI).
    tags = [t.get("name") for t in (lead.get("_embedded", {}).get("tags") or [])] if lead else []
    already_returned = RETURNED_QC_TAG in tags

    # Повна картина: усі нотатки + транскрипти всіх дзвінків + спроби контакту.
    notes_text, calls_text, contact_summary = _gather_deal_context(lead_id, manager_name)

    recommendation = ai_analyzer.analyze_closed_deal(
        {**details, "manager": manager_name, "amount": amount},
        notes_text=notes_text, calls_text=calls_text, contact_summary=contact_summary,
    )

    closure_match = re.search(r"CLOSURE:\s*(ПЕРЕДЧАСНЕ|ОБ['ʼ’]?ЄКТИВНЕ)\s*-?\s*(.*)", recommendation)
    verdict = ""
    if closure_match:
        verdict = "ПЕРЕДЧАСНЕ" if "ПЕРЕДЧАСНЕ" in closure_match.group(1) else "ОБ'ЄКТИВНЕ"
    verdict_reason = closure_match.group(2).strip() if closure_match else ""
    rule_match = re.search(r"RULE:\s*(.+)", recommendation)
    rule = rule_match.group(1).strip() if rule_match else ""
    if rule in ("-", "—"):
        rule = ""
    category_match = re.search(r"CATEGORY:\s*(.+)", recommendation)
    category = category_match.group(1).strip() if category_match else ""
    nextstep_match = re.search(r"NEXTSTEP:\s*(.+)", recommendation)
    next_step = nextstep_match.group(1).strip() if nextstep_match else ""
    if next_step in ("-", "—", ""):
        next_step = ""
    recommendation_clean = re.sub(r"\n?CLOSURE:.*", "", recommendation)
    recommendation_clean = re.sub(r"\n?RULE:.*", "", recommendation_clean)
    recommendation_clean = re.sub(r"\n?CATEGORY:.*", "", recommendation_clean)
    recommendation_clean = re.sub(r"\n?NEXTSTEP:.*", "", recommendation_clean).strip()
    tip_match = re.search(r"→\s*тімліду:\s*(.+)", recommendation_clean)
    teamlead_tip = tip_match.group(1).strip() if tip_match else ""

    # Лог у аркуш закритих угод — завжди (тихий запис для аналітики), для всіх команд.
    sheets.log_closed_deal({
        "lead_id": lead_id,
        "name": details["name"],
        "manager": manager_name,
        "team": team,
        "reject_reason": details["reject_reason"],
        "last_status": details["last_status"],
        "days_in_work": details["days_in_work"],
        "calls_count": details["calls_count"],
        "notes_count": details["notes_count"],
        "amount": amount,
        "closed_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M"),
        "ai_recommendation": recommendation_clean,
        "verdict": verdict,
        "category": category,
    })

    return_deal = (
        verdict == "ПЕРЕДЧАСНЕ" and not no_return
        and not already_returned and QC_RETURN_ENABLED
    )

    if not return_deal:
        # Коректне закриття / дубль / тест / вже поверталось →
        # ТИХО (без сповіщень і тегів). Бот не шумить на нормальні закриття.
        logger.info(
            "Closed lead %s by %s — тихо (verdict=%s, no_return=%s, already_returned=%s)",
            lead_id, manager_name, verdict, no_return, already_returned,
        )
        return

    # ── ПОВЕРНЕННЯ на допрацювання — єдиний випадок, коли бот сповіщає й тегує ──
    returned = kommo.move_lead_to(lead_id, PEREVOZY_PIPELINE_ID, RETURNED_QC_STATUS, RETURNED_QC_TAG)
    note = (
        "🤖 AI Відділ якості — угоду повернуто на допрацювання\n\n"
        f"❗ Чому повернуто: {verdict_reason or '—'}\n"
        f"📏 Правило: {rule or '—'}\n"
        f"📋 Категорія: {category or '—'}\n"
    )
    if next_step:
        note += f"➡️ Наступний крок: {next_step}\n"
    if teamlead_tip:
        note += f"👁 Тімліду звернути увагу: {teamlead_tip}\n"
    if recommendation_clean:
        note += f"\n📊 Детальний розбір:\n{recommendation_clean}"
    kommo.add_note(lead_id, note)

    msg = (
        f"🔴 <b>Угоду повернуто на допрацювання</b>\n"
        f"👤 Менеджер: <b>{manager_name}</b>{tg_tag}{sup_part}\n"
        f"🏷 Назва: {details['name']}\n"
        f"📋 Причина закриття: {reason}\n"
        f"🔀 Етап: {last_status} | 📞 {details['calls_count']} дзв. | 📝 {details['notes_count']} нот.\n"
        f"⚠️ Чому повертаємо: {verdict_reason or '—'}\n"
        f"📏 Правило: {rule or '—'}\n"
        f"📋 Категорія: {category or '—'}\n"
    )
    if next_step:
        msg += f"➡️ Наступний крок: {next_step}\n"
    if teamlead_tip:
        msg += f"🧠 Тімліду: {teamlead_tip}\n"
    msg += (
        f"🛠 Переведено у «Продаж повний цикл» → «Повернуто АІ Відділ якості».\n"
        f"🔗 <a href='{kommo_url}'>Відкрити угоду #{lead_id}</a>"
    )
    notifier.send_to_rnk_closed(msg, team)  # сюди доходить лише РНК
    logger.info("Closed not realized RETURNED: lead %s by %s (rule=%s, moved=%s)", lead_id, manager_name, rule, returned)


def _check_non_target_lead(lead_id: int, responsible_id: int):
    """Перевіряє ліда, закритого як 'Не цільові', через AI за розшифровками дзвінків.
    Якщо клієнту дійсно потрібне вантажне перевезення — повертає лід у роботу і сповіщає тімліда."""
    lead = kommo.get_lead(lead_id)
    if not lead:
        return
    if kommo.is_city_transport(lead):
        logger.info("Non-target lead %s — перевезення по місту, повний ігнор", lead_id)
        return  # перевезення по місту — повний ігнор (без аналізу/повернення/сповіщень)
    # AI-повернення — лише для РНК. РПК (та невідомі команди) не піддаються.
    if MANAGER_TEAM.get(responsible_id, "") not in RNK_TEAMS:
        logger.info("Non-target lead %s — не РНК-команда, без повернення", lead_id)
        return
    if not kommo.has_utm_campaign(lead):
        return  # відстежуємо лише угоди, що прийшли по таргету (utm_campaign)

    # Дубль/Тест — легітимне закриття: не повертаємо, навіть якщо в дзвінках
    # обговорювалось перевезення (той самий виняток, що й у closed-not-realized).
    reason = kommo.get_reject_reason(lead).lower()
    if "дубл" in reason or "тест" in reason:
        logger.info("Non-target lead %s closed as дубль/тест — не повертаємо", lead_id)
        return

    # Захист від зациклення: якщо угоду вже повертали (є тег «Повернуто АІ»),
    # не повертаємо повторно — інакше AI воює з тімлідом, який рухає її назад.
    tags = [t.get("name") for t in (lead.get("_embedded", {}).get("tags") or [])]
    if RETURNED_QC_TAG in tags:
        logger.info("Non-target lead %s already returned (tag present) — пропуск", lead_id)
        return

    lead_name = lead.get("name", f"Лід #{lead_id}")

    notes = kommo.get_lead_notes(lead_id)
    call_notes = [n for n in notes if n.get("note_type") in (10, 11, "call_in", "call_out")]
    transcripts = []
    for n in call_notes:
        note_id = n.get("id")
        if not note_id:
            continue
        full_note = kommo.get_note(lead_id, note_id)
        params = full_note.get("params") or {}
        link = params.get("link", "") or params.get("LINK", "")
        if link:
            transcripts.append(transcriber.transcribe_call(link))

    if not transcripts:
        return

    manager_note = kommo.get_last_text_note(lead_id)
    result = ai_analyzer.check_target_lead(transcripts, lead_name, manager_note)
    if not result.get("is_target"):
        return

    # Повернення угод AI-Відділом якості вимкнено — не переводимо в «Повернуто АІ»
    # і не сповіщаємо (сповіщення без переведення лише вводило б в оману).
    if not QC_RETURN_ENABLED:
        logger.info("Non-target lead %s flagged by AI but QC return disabled: %s",
                    lead_id, result.get("reason"))
        return

    # Переводимо у воронку "Продаж повний цикл" на етап "Повернуто АІ Відділ
    # якості" + тег, щоб тімлід міг вести угоду далі в повному циклі.
    kommo.move_lead_to(lead_id, PEREVOZY_PIPELINE_ID, RETURNED_QC_STATUS, RETURNED_QC_TAG)
    kommo.add_note(lead_id, (
        "🤖 AI Відділ якості — лід повернуто з «Не цільові»\n\n"
        "❗ Чому: за змістом дзвінків клієнту потрібне вантажне перевезення — "
        "закрито як нецільовий помилково.\n"
        f"📋 Деталі: {result.get('reason', '')}\n"
        "➡️ Наступний крок: зв'язатися з клієнтом, уточнити параметри вантажу "
        "(маршрут, вага, дати) і відпрацювати запит на перевезення."
    ))

    _nontarget_returns[responsible_id] = _nontarget_returns.get(responsible_id, 0) + 1
    return_count = _nontarget_returns[responsible_id]

    manager_name = kommo.get_user_name(responsible_id) if responsible_id else "—"
    tg_tag = notifier.get_manager_tag(responsible_id)
    supervisor_tag = SUPERVISOR_MAP.get(responsible_id, "")
    team = MANAGER_TEAM.get(responsible_id, "")
    sup_part = f" {supervisor_tag}" if supervisor_tag else ""
    kommo_url = f"https://utsercice.kommo.com/leads/detail/{lead_id}"

    warning_line = ""
    if return_count >= 3:
        warning_line = f"\n⚠️ Це вже {return_count}-й випадок для цього менеджера — можлива системна проблема з кваліфікацією лідів."

    msg = (
        f"♻️ <b>Лід повернуто з 'Не цільові'</b>\n"
        f"👤 Менеджер: <b>{manager_name}</b>{tg_tag}{sup_part}\n"
        f"🏷 Назва: {lead_name}\n"
        f"📋 АІ-аналіз (правила продажу не дотримані — лід стосувався перевезення): {result.get('reason', '')}{warning_line}\n"
        f"🛠 Переведено у воронку «Продаж повний цикл», етап «Повернуто АІ Відділ якості».\n"
        f"🔗 <a href='{kommo_url}'>Відкрити угоду #{lead_id}</a>"
    )
    notifier.send_to_nontarget(msg, team)
    logger.info("Non-target lead %s returned to work: %s", lead_id, result.get("reason"))


# Маркери посилання на активну угоду в примітках до дубля: або #<id>, або
# повний лінк Kommo (leads/detail/<id>). Шукаємо ID іншої (не цієї) угоди.
_DUP_HASH_RE = re.compile(r"#(\d{5,9})")
_DUP_URL_RE = re.compile(r"leads/detail/(\d{5,9})")


def _check_duplicate_reference(lead_id: int, responsible_id: int):
    """Якщо угоду закрито з причиною 'Дубль', менеджер має вказати в примітках
    #ID активної угоди (або посилання на неї). Якщо ID немає — нагадуємо
    менеджеру/тімліду додати його."""
    lead = kommo.get_lead(lead_id)
    if not lead:
        return
    reason = kommo.get_reject_reason(lead)
    if "дубл" not in reason.lower():
        return  # не дубль — нічого не перевіряємо

    notes = kommo.get_lead_notes(lead_id)
    text = " ".join(
        (n.get("params") or {}).get("text", "") or ""
        for n in notes
        if n.get("note_type") in (4, "common")
    )

    referenced_ids = {
        int(m) for m in (_DUP_HASH_RE.findall(text) + _DUP_URL_RE.findall(text))
    }
    referenced_ids.discard(lead_id)  # посилання на саму себе не рахується
    if referenced_ids:
        logger.info("Duplicate lead %s references active deal(s) %s — OK", lead_id, referenced_ids)
        return

    manager_name = kommo.get_user_name(responsible_id) if responsible_id else "—"
    tg_tag = notifier.get_manager_tag(responsible_id)
    supervisor_tag = SUPERVISOR_MAP.get(responsible_id, "")
    sup_part = f" {supervisor_tag}" if supervisor_tag else ""
    lead_name = lead.get("name", f"Лід #{lead_id}")
    kommo_url = f"https://utsercice.kommo.com/leads/detail/{lead_id}"

    msg = (
        f"⚠️ <b>Угоду закрито як дубль без ID активної угоди</b>\n"
        f"👤 Менеджер: <b>{manager_name}</b>{tg_tag}{sup_part}\n"
        f"🏷 Назва: {lead_name}\n"
        f"📋 Вкажіть, будь ласка, в примітках #ID активної угоди (або посилання на неї).\n"
        f"🔗 <a href='{kommo_url}'>Відкрити угоду #{lead_id}</a>"
    )
    send_to_team_group(responsible_id, msg)
    logger.info("Duplicate lead %s closed without active-deal ID — reminded %s", lead_id, manager_name)


def _find_active_deal_ref(lead_id: int) -> str:
    """Шукає в текстових нотатках угоди посилання на активну угоду (#ID або
    leads/detail/ID, окрім самої себе). Повертає HTML-лінк або '' якщо немає."""
    notes = kommo.get_lead_notes(lead_id)
    text = " ".join(
        (n.get("params") or {}).get("text", "") or ""
        for n in notes
        if n.get("note_type") in (4, "common")
    )
    ids = {int(m) for m in (_DUP_HASH_RE.findall(text) + _DUP_URL_RE.findall(text))}
    ids.discard(lead_id)
    if not ids:
        return ""
    ref_id = sorted(ids)[0]
    return f"<a href='https://utsercice.kommo.com/leads/detail/{ref_id}'>#{ref_id}</a>"


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
    _route_tracking_message(responsible_id, msg)
    logger.info("Team event: %s lead %s by %s", label, lead_id, manager_name)


_notified_new_leads: dict[int, datetime] = {}
_NEW_LEAD_DEDUP_SECONDS = 300

# Лічильник відфільтрованих «Автосделок» (технічні запити на оплату перевізника,
# не ліди) — щоб було видно в логах/статусі, що фільтр працює, а не мовчить.
_filtered_autodeal_count = 0


def _handle_new_lead(lead_id: int, responsible_id: int):
    if lead_id in pending:
        # Лід вже в очікуванні (сповіщення надіслано, дзвінок ще не зафіксований) —
        # Kommo іноді повторно надсилає той самий вебхук "Отв-й сделки изменен"
        # (підтверджено: ідентичний payload двічі для одного ліда), а 5-хвилинний
        # дедуп нижче не рятує, якщо процес встиг перезапуститись між доставками.
        logger.info("Skipped duplicate new-lead notification for %s (already pending)", lead_id)
        return

    now_check = datetime.now(timezone.utc)
    last_sent = _notified_new_leads.get(lead_id)
    if last_sent and (now_check - last_sent).total_seconds() < _NEW_LEAD_DEDUP_SECONDS:
        # Kommo надсилає окремі вебхуки "Статус сделки изменен" і "Отв-й сделки изменен"
        # для одного й того ж переведення ліда лідогеном — без дедупу одна заявка
        # дублюється в групі двічі.
        logger.info("Skipped duplicate new-lead notification for %s", lead_id)
        return
    _notified_new_leads[lead_id] = now_check
    if len(_notified_new_leads) > 500:
        cutoff = now_check - timedelta(seconds=_NEW_LEAD_DEDUP_SECONDS)
        for k in [k for k, v in _notified_new_leads.items() if v < cutoff]:
            _notified_new_leads.pop(k, None)

    lead = kommo.get_lead(lead_id)
    lead_name = lead.get("name", f"Лід #{lead_id}") if lead else f"Лід #{lead_id}"

    # ── Фільтр «Автосделок» ──────────────────────────────────────────
    # «Автосделка: …» — технічний запит на оплату перевізника (обов'язкова
    # умова роботи системи), а НЕ лід від лідогенератора. Такі угоди теж
    # проходять статус 69716164 (створюються в ньому, потім їм міняють
    # відповідального), тож без фільтра роздували б «Реєстр» технічними
    # рядками. Не пишемо в Sheets і не шлемо сповіщення.
    if (lead_name or "").strip().lower().startswith("автосделка"):
        global _filtered_autodeal_count
        with _state_lock:
            _filtered_autodeal_count += 1
            total_filtered = _filtered_autodeal_count
        logger.info(
            "Автосделка відфільтрована (не лід): #%s «%s» — усього відфільтровано %d",
            lead_id, lead_name[:40], total_filtered,
        )
        return

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
        team = MANAGER_TEAM.get(responsible_id, "")
        notifier.send_to_team_tracking(msg, team)

    # Визначаємо лідогена (поле 2098037 → автор зміни відповідального з відділу →
    # updated_by з відділу → порожньо). Живий захват при передачі — updated_by/
    # автор події ще вказує на лідогена, бо менеджер угоди ще не чіпав.
    lidogen = ""
    if lead:
        lidogen, lidogen_src = kommo.resolve_lidogen(lead, lead_id)
        logger.info("Lidogen for lead %s: «%s» (джерело: %s)", lead_id, lidogen or "—", lidogen_src)
    sheets.append_transfer(lead_id, lead_name, manager_name, now, manager_id=responsible_id, lidogen=lidogen)
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
    note_id = note.get("note_id", 0)
    now = datetime.now(timezone.utc)

    info = pending.get(lead_id)
    manager_name = kommo.get_user_name(responsible_id) if responsible_id else "—"
    call_type = "вхідний" if note_type == "10" else "вихідний"

    if info:
        sheets.update_first_call(lead_id, now)
        pending.pop(lead_id, None)
    logger.info("Call note: lead %s type %s by %s", lead_id, note_type, manager_name)
    # Дзвінки РНК аналізуються постфактум, лише коли угода закривається як
    # "Закрито і не реалізовано" — див. _handle_closed_not_realized.
    # Окремо — перший дотик по рекламних лідах (Дарина/Андрій): транскрибація
    # + AI-оцінка озвучення ціни. Сам гейтиться по команді/utm/першому дзвінку.
    threading.Thread(
        target=_handle_first_touch, args=(lead_id, responsible_id), daemon=True
    ).start()


def _analyze_rnk_closed_deal_calls(lead_id: int, lead_name: str, manager_name: str) -> str:
    """Розшифровує і аналізує всі дзвінки (≥40с) закритої-не реалізованої угоди РНК.
    Повертає текст аналізу для додавання до рекомендації AI (або "")."""
    notes = kommo.get_lead_notes(lead_id)
    call_notes = sorted(
        (n for n in notes if n.get("note_type") in (10, 11, "call_in", "call_out")),
        key=lambda n: n.get("created_at", 0),
    )
    for n in call_notes:
        note_id = n.get("id")
        full_note = kommo.get_note(lead_id, note_id) if note_id else n
        params = full_note.get("params") or {}
        duration = int(params.get("duration", 0) or 0)
        if duration < 40:
            continue
        record_url = params.get("link", "") or params.get("LINK", "")
        call_type = "вхідний" if full_note.get("note_type") in (10, "call_in") else "вихідний"
        transcript = transcriber.transcribe_call(record_url) if record_url else ""
        created_at = full_note.get("created_at", 0)
        call_at = datetime.fromtimestamp(created_at, tz=timezone.utc) if created_at else datetime.now(timezone.utc)
        sheets.append_call(lead_id, manager_name, call_type, duration, transcript, call_at)

    calls = sheets.get_calls_for_lead(lead_id)
    if not calls:
        return ""

    analysis = ai_analyzer.analyze_deal_calls(calls, manager_name, lead_name)
    if not analysis:
        return ""
    return re.sub(r"\n?RISK:.*", "", analysis).strip()


def _process_rnk_deal_call(lead_id: int, lead_name: str, manager_name: str, call_type: str, duration: int, record_url: str) -> None:
    """Розшифровує дзвінок, накопичує в реєстрі по угоді й надсилає AI-аналіз усієї історії дзвінків."""
    transcript = transcriber.transcribe_call(record_url) if record_url else ""
    row = sheets.append_call(lead_id, manager_name, call_type, duration, transcript, datetime.now(timezone.utc))

    calls = sheets.get_calls_for_lead(lead_id)
    analysis = ai_analyzer.analyze_deal_calls(calls, manager_name, lead_name)
    if not analysis:
        return

    risk_match = re.search(r"RISK:\s*ТАК\s*-?\s*(.*)", analysis)
    analysis_clean = re.sub(r"\n?RISK:.*", "", analysis).strip()
    risk_label = ("Ризик: " + re.sub(r"[*#]+", "", risk_match.group(1)).strip()) if risk_match else "Немає"

    sheets.update_call_analysis(row, analysis_clean, risk_label)

    kommo_url = f"https://utsercice.kommo.com/leads/detail/{lead_id}"
    msg = (
        f"🤖 <b>AI-аналіз дзвінків по угоді</b>\n"
        f"👤 {manager_name}\n"
        f"🏷 {lead_name} | 📞 дзвінків: {len(calls)}\n\n"
        f"{analysis_clean}\n\n"
        f"🔗 <a href='{kommo_url}'>Відкрити угоду #{lead_id}</a>"
    )
    notifier.send_to_rnk(msg)

    if risk_match:
        reason = risk_label.removeprefix("Ризик: ") or "виявлено ризик втрати угоди"
        urgent_msg = (
            f"🔴 <b>ТЕРМІНОВО — ризик втрати угоди</b>\n"
            f"👤 Менеджер: {manager_name}\n"
            f"🏷 Угода: {lead_name}\n"
            f"⚠️ {reason}\n\n"
            f"🔗 <a href='{kommo_url}'>Відкрити угоду #{lead_id}</a>"
        )
        notifier.send_to_quality(urgent_msg)


# ── Перший дотик по рекламних лідах (команди Дарини/Андрія) ──────────────────
# Слухаємо лише дзвінки по рекламних лідах (has_utm_campaign). На ПЕРШОМУ
# реальному дзвінку (≥40с) AI перевіряє: чи розмова про перевезення, чи
# озвучено ціну, чи відпрацьовано заперечення. Сповіщення йде в гілку команди,
# а раз на день о 18:00 — зведення в адмінську групу.
FIRST_TOUCH_TEAMS = RNK_TEAMS
FIRST_TOUCH_MIN_DURATION = 40
# Маркер у CRM-нотатці ліда — персистентний дедуп аналізу першого дотику.
# In-memory set нижче губиться при кожному рестарті Render (деплой), і без
# маркера бот повторно транскрибував би та аналізував той самий дзвінок.
FIRST_TOUCH_MARKER = "🤖 AI: перший дотик проаналізовано"
_first_touch_log: list[dict] = []   # {date, manager_id, team, lead_id, price_voiced}
_first_touch_done: set[int] = set()  # lead_id, по яких перший дотик уже оброблено
_first_touch_contacts: set[int] = set()  # contact_id, по яких перший дотик уже був
                                         # (одна аналітика на клієнта — повторні
                                         # дзвінки того самого номеру не рахуємо,
                                         # навіть на іншій угоді). Персист — маркер
                                         # на контакті (kommo.contact_has_note_marker).


def _handle_first_touch(lead_id: int, responsible_id: int):
    if lead_id in _first_touch_done:
        return
    lead = kommo.get_lead(lead_id)
    if not lead:
        return
    resp_id = lead.get("responsible_user_id", 0) or responsible_id
    team = MANAGER_TEAM.get(resp_id, "")
    if team not in FIRST_TOUCH_TEAMS:
        return  # лише рекламні команди РНК (Дарина/Андрій)
    if not kommo.has_utm_campaign(lead):
        return  # лише ліди з реклами (геомітка/utm)

    # Перший дотик = найперший ВХІДНИЙ дзвінок тривалістю ≥40с (клієнт сам
    # зателефонував нам уперше). Вихідні дзвінки менеджера не рахуються.
    notes = kommo.get_lead_notes(lead_id)

    # Персистентний дедуп: маркер-нотатка в CRM переживає рестарт сервісу
    # (in-memory _first_touch_done — ні). Нотатки вже завантажені вище.
    for n in notes:
        if n.get("note_type") in (4, "common"):
            if FIRST_TOUCH_MARKER in ((n.get("params") or {}).get("text") or ""):
                _first_touch_done.add(lead_id)
                return

    call_notes = sorted(
        (n for n in notes if n.get("note_type") in (10, "call_in")),
        key=lambda n: n.get("created_at", 0),
    )
    first = None
    for n in call_notes:
        params = n.get("params") or {}
        if int(params.get("duration", 0) or 0) >= FIRST_TOUCH_MIN_DURATION:
            first = n
            break
    if not first:
        return  # реального дзвінка ще не було — почекаємо наступного

    # Дедуп по КЛІЄНТУ (номеру): перший дотик аналізуємо лише раз на контакт.
    # Повторні дзвінки того самого номеру — навіть якщо це вже інша угода — НЕ
    # аналізуємо на озвучення ціни. Контакт стабільний по номеру. Перевірка до
    # транскрибації (economія Groq): спершу in-memory, потім персистентний
    # маркер на контакті (переживає рестарт, спільний для всіх угод контакту).
    contact_id = kommo.get_lead_main_contact_id(lead_id)
    if contact_id:
        with _state_lock:
            seen_contact = contact_id in _first_touch_contacts
        if not seen_contact and kommo.contact_has_note_marker(contact_id, FIRST_TOUCH_MARKER):
            seen_contact = True
        if seen_contact:
            with _state_lock:
                _first_touch_contacts.add(contact_id)
                _first_touch_done.add(lead_id)
            logger.info(
                "First touch lead %s: контакт %s уже аналізувався — пропуск (повторний дзвінок номеру)",
                lead_id, contact_id,
            )
            return

    # Атомарний claim під локом: два близькі дзвінкові вебхуки могли підняти
    # два треди — так лише один транскрибує (платний Groq) і шле сповіщення.
    with _state_lock:
        if lead_id in _first_touch_done:
            return
        _first_touch_done.add(lead_id)
        if len(_first_touch_done) > 5000:
            _first_touch_done.clear()

    params = first.get("params") or {}
    record_url = params.get("link", "") or params.get("LINK", "")
    call_type = "вхідний" if first.get("note_type") in (10, "call_in") else "вихідний"
    manager_name = kommo.get_user_name(resp_id) if resp_id else "—"
    lead_name = lead.get("name", f"Лід #{lead_id}")
    transcript = transcriber.transcribe_call(record_url) if record_url else ""

    result = ai_analyzer.analyze_first_touch(transcript, lead_name, manager_name)
    if transcript and not result.get("about_transport"):
        logger.info("First touch lead %s: розмова не про перевезення — пропуск", lead_id)
        kommo.add_note(lead_id, f"{FIRST_TOUCH_MARKER}\nРозмова не про перевезення — сповіщення не надсилалось.")
        return  # не рахуємо нерелевантні (спам/не про перевезення)

    now = datetime.now(timezone.utc)
    _first_touch_log.append({
        "date": now.date().isoformat(),
        "manager_id": resp_id,
        "team": team,
        "lead_id": lead_id,
        "price_voiced": bool(result.get("price_voiced")),
    })
    # прибрати старі записи (>7 днів)
    if len(_first_touch_log) > 2000:
        cutoff = (now - timedelta(days=7)).date().isoformat()
        _first_touch_log[:] = [e for e in _first_touch_log if e["date"] >= cutoff]
    # Персистентний запис у Google Sheets (аркуш «Перший дотик») — щоб звіт за
    # будь-який період читався з таблиці без сканування Kommo API.
    sheets.append_first_touch(
        lead_id, manager_name, team, bool(result.get("price_voiced")), now,
        objections=bool(result.get("objections_handled")),
        about_transport=bool(result.get("about_transport", True)),
        has_transcript=bool(transcript),
    )

    tg_tag = notifier.get_manager_tag(resp_id)
    kommo_url = f"https://utsercice.kommo.com/leads/detail/{lead_id}"
    if not transcript:
        head = "📞 Перший дотик по рекламі"
        body = "⚠️ Запис дзвінка недоступний — автоаналіз неможливий."
    else:
        price = "✅ ціну озвучено" if result["price_voiced"] else "❌ ціну НЕ озвучено"
        obj = ("✅ заперечення відпрацьовано" if result["objections_handled"]
               else "➖ заперечень не було / не відпрацьовано")
        head = ("✅ Перший дотик: ціну озвучено" if result["price_voiced"]
                else "❌ Перший дотик: ціну НЕ озвучено")
        body = f"{price}\n{obj}"
        if result.get("weakness"):
            body += f"\n⚠️ Слабка сторона: {result['weakness']}"
        if result.get("reco"):
            body += f"\n🔧 Наступного разу: {result['reco']}"
        if not result.get("weakness") and not result.get("reco"):
            body += f"\n🧠 {result.get('summary', '')}"
    msg = (
        f"{head}\n"
        f"👤 Менеджер: <b>{manager_name}</b>{tg_tag}\n"
        f"🏷 {lead_name} | 📞 {call_type}\n"
        f"{body}\n"
        f"🔗 <a href='{kommo_url}'>Відкрити лід #{lead_id}</a>"
    )
    notifier.send_to_first_touch(msg, team)
    # Маркер-нотатка в CRM: персистентний дедуп + результат аналізу видно
    # тімліду прямо в угоді.
    note_body = body.replace("<b>", "").replace("</b>", "")
    kommo.add_note(lead_id, f"{FIRST_TOUCH_MARKER}\n{head}\n{note_body}")
    # Персистентний дедуп по клієнту: маркер на контакті + in-memory set →
    # повторні дзвінки того самого номеру (навіть на іншій угоді) більше не
    # аналізуються. Позначаємо лише тут (реальний відправлений аналіз), а не
    # на claim — щоб перший спам-дзвінок не заблокував майбутній реальний.
    if contact_id:
        with _state_lock:
            _first_touch_contacts.add(contact_id)
            if len(_first_touch_contacts) > 5000:
                _first_touch_contacts.clear()
        kommo.add_contact_note(contact_id, f"{FIRST_TOUCH_MARKER} (lead #{lead_id})")
    logger.info("First touch lead %s (%s): price=%s", lead_id, team, result.get("price_voiced"))


def _send_first_touch_admin_report():
    """О 18:00 Київ — адмінське зведення першого дотику по рекламі за день."""
    today = datetime.now(timezone.utc).date().isoformat()
    todays = [e for e in _first_touch_log if e["date"] == today]
    accepted = len(todays)
    priced = sum(1 for e in todays if e["price_voiced"])

    by_team: dict[str, dict[str, int]] = {}
    for e in todays:
        t = by_team.setdefault(e["team"], {"acc": 0, "price": 0})
        t["acc"] += 1
        t["price"] += 1 if e["price_voiced"] else 0
    lines = "\n".join(
        f"• {team}: прийнято {v['acc']}, озвучено ціну {v['price']}"
        for team, v in by_team.items()
    ) or "—"

    msg = (
        f"📊 <b>Перший дотик по рекламі за день</b>\n"
        f"📥 Прийнято рекламних лідів (перший дотик): <b>{accepted}</b>\n"
        f"💬 Озвучено ціну на першому дотику: <b>{priced}</b>\n"
        f"{lines}"
    )
    notifier.send_to_admin_stats(msg)
    logger.info("First-touch admin report: accepted=%d priced=%d", accepted, priced)


# Реєструємо джобу першого дотику тут — після визначення функції (scheduler
# уже запущений вище; APScheduler дозволяє додавати джоби на льоту).
scheduler.add_job(_send_first_touch_admin_report, "cron", hour=18, minute=0)  # 18:00 Kyiv


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


def _build_personal_stats_text(kommo_id: int, days: int, label: str) -> str:
    name = kommo.get_user_name(kommo_id)
    stats = kommo.get_manager_deal_stats(kommo_id, days)
    return (
        f"📊 <b>Моя статистика ({label})</b>\n"
        f"👤 {name}\n\n"
        f"📥 Взято від лідогена/реклами: <b>{stats['taken']}</b>\n"
        f"🟢 Успіх: <b>{stats['won']}</b>\n"
        f"🔴 Закрито не реалізовано: <b>{stats['lost']}</b>\n"
        f"📈 Конверсія (успіх/закрито угод): <b>{stats['conversion']}%</b>"
    )


_recent_tg_updates: deque = deque(maxlen=20)


@app.route("/recent-tg-updates", methods=["GET"])
def recent_tg_updates():
    """Read-only: останні 20 апдейтів від Telegram (для пошуку chat_id нової групи)."""
    return jsonify({"ok": True, "updates": list(_recent_tg_updates)})


@app.route("/tg-update", methods=["POST"])
def tg_update():
    """Telegram bot webhook — handles callback_query (button clicks) і приватні команди."""
    data = request.get_json(force=True, silent=True) or {}
    logger.info("TG update: %s", data)
    _recent_tg_updates.append(data)

    message = data.get("message")
    if message and message.get("chat", {}).get("type") == "private":
        text = (message.get("text") or "").strip()
        if text in ("/mystats", "/моястатистика", "/start"):
            notifier.send_personal_stats_buttons(message["chat"]["id"], message["message_id"])
        return jsonify({"ok": True})

    if message and message.get("chat", {}).get("id") == ELOGIST_SOURCE_CHAT_ID:
        text = message.get("text") or ""
        threading.Thread(target=_handle_elogist_message, args=(text,), daemon=True).start()
        return jsonify({"ok": True})

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
        notifier.send_stats_message(chat_id, text, message_id)
    elif cb_data == "stats_week":
        text = _build_stats_text(days=7, label="7 днів")
        notifier.send_stats_message(chat_id, text, message_id)
    elif cb_data == "stats_month":
        text = _build_stats_text(days=30, label="30 днів")
        notifier.send_stats_message(chat_id, text, message_id)
    elif cb_data.startswith("mystats_"):
        days = int(cb_data.split("_", 1)[1])
        label = {1: "сьогодні", 7: "7 днів", 30: "30 днів"}.get(days, f"{days} днів")
        username = callback.get("from", {}).get("username", "")
        kommo_id = notifier.get_kommo_id_by_username(username)
        if not kommo_id:
            notifier.send_dm_message(
                chat_id,
                "⚠️ Не знайшов вас у списку менеджерів за вашим Telegram-юзернеймом. "
                "Зверніться до адміністратора, щоб додати відповідність.",
                message_id,
            )
        else:
            text = _build_personal_stats_text(kommo_id, days, label)
            notifier.send_dm_message(chat_id, text, message_id)

    return jsonify({"ok": True})


_DASHBOARD_BASE_CSS = """
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; background: #f4f5f7; margin: 0; padding: 24px; color: #1f2430; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  .sub { color: #6b7280; margin-bottom: 24px; font-size: 14px; }
  .teams { display: flex; gap: 12px; margin-bottom: 24px; }
  .teams a { padding: 10px 18px; background: #fff; border-radius: 10px; text-decoration: none; color: #1f2430; font-weight: 600; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .teams a.active { background: #2563eb; color: #fff; }
  .day-group { margin-bottom: 28px; }
  .day-title { font-size: 15px; font-weight: 700; color: #374151; margin-bottom: 10px; padding-left: 4px; }
  .card { background: #fff; border-radius: 12px; padding: 16px 18px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.08); border-left: 5px solid #d1d5db; }
  .card.premature { border-left: 5px solid #dc2626; background: #fff5f5; }
  .card-top { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 8px; }
  .deal-name { font-weight: 700; font-size: 15px; }
  .manager { color: #2563eb; font-weight: 600; font-size: 13px; }
  .meta { display: flex; gap: 16px; flex-wrap: wrap; margin: 8px 0; font-size: 12.5px; color: #4b5563; }
  .meta span b { color: #1f2430; }
  .badge { display: inline-block; padding: 2px 9px; border-radius: 20px; font-size: 11.5px; font-weight: 700; }
  .badge.premature { background: #fee2e2; color: #b91c1c; }
  .badge.objective { background: #dcfce7; color: #166534; }
  .category { font-size: 12px; color: #6b7280; margin-top: 2px; }
  .ai-text { white-space: pre-wrap; font-size: 13px; line-height: 1.5; background: #f9fafb; border-radius: 8px; padding: 10px 12px; margin-top: 10px; }
  .feedback { margin-top: 12px; border-top: 1px solid #eee; padding-top: 10px; }
  .feedback textarea { width: 100%; min-height: 50px; border: 1px solid #e5e7eb; border-radius: 8px; padding: 8px; font-size: 13px; resize: vertical; }
  .feedback-row { display: flex; gap: 8px; margin-top: 6px; align-items: center; }
  .feedback select { border: 1px solid #e5e7eb; border-radius: 8px; padding: 6px 8px; font-size: 13px; }
  .feedback button { background: #2563eb; color: #fff; border: none; border-radius: 8px; padding: 7px 16px; font-size: 13px; font-weight: 600; cursor: pointer; }
  .saved-note { font-size: 12.5px; color: #166534; margin-top: 6px; }
  .empty { color: #9ca3af; padding: 40px; text-align: center; }
</style>
"""

_DASHBOARD_TEMPLATE = """
<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<title>Відділ якості — {{ team }}</title>
""" + _DASHBOARD_BASE_CSS + """
</head>
<body>
<h1>📋 Відділ якості — закриті угоди</h1>
<div class="sub">Останні {{ limit_days }} днів, групування по даті закриття</div>
<div class="teams">
  {% for t in teams %}
    <a href="{{ url_for('dashboard_team', team=t) }}" class="{{ 'active' if t == team else '' }}">{{ t }}</a>
  {% endfor %}
</div>

{% if not days %}
  <div class="empty">Немає закритих угод за цей період.</div>
{% endif %}

{% for day, deals in days %}
  <div class="day-group">
    <div class="day-title">📅 {{ day }} ({{ deals|length }} угод{{ 'а' if deals|length == 1 else '' }})</div>
    {% for d in deals %}
      <div class="card {{ 'premature' if d['Вердикт AI'] == 'ПЕРЕДЧАСНЕ' else '' }}">
        <div class="card-top">
          <div class="deal-name">{{ d['Назва'] or ('Угода #' + d['ID угоди']|string) }} <span style="color:#9ca3af;font-weight:400;">#{{ d['ID угоди'] }}</span></div>
          <div class="manager">{{ d['Менеджер'] }}</div>
        </div>
        <div class="meta">
          <span>Причина: <b>{{ d['Причина відмови'] or '—' }}</b></span>
          <span>Етап: <b>{{ d['Закрито з етапу'] or '—' }}</b></span>
          <span>Днів: <b>{{ d['Днів в роботі'] }}</b></span>
          <span>Дзвінків: <b>{{ d['Дзвінків'] }}</b></span>
          <span>Нотаток: <b>{{ d['Нотаток'] }}</b></span>
          <span>Сума: <b>{{ d['Сума (грн)'] }} грн</b></span>
        </div>
        {% if d['Вердикт AI'] %}
          <span class="badge {{ 'premature' if d['Вердикт AI'] == 'ПЕРЕДЧАСНЕ' else 'objective' }}">
            {{ '🔴 Закрито передчасно' if d['Вердикт AI'] == 'ПЕРЕДЧАСНЕ' else '🟢 Закриття об\\'єктивне' }}
          </span>
          {% if d['Категорія причини'] %}<div class="category">Категорія: {{ d['Категорія причини'] }}</div>{% endif %}
        {% endif %}
        {% if d['Рекомендація AI'] %}<div class="ai-text">{{ d['Рекомендація AI'] }}</div>{% endif %}

        <div class="feedback">
          <form method="post" action="{{ url_for('dashboard_comment', team=team) }}">
            <input type="hidden" name="row" value="{{ d['_row'] }}">
            <textarea name="comment" placeholder="Коментар тімліда...">{{ d['Коментар тімліда'] or '' }}</textarea>
            <div class="feedback-row">
              <select name="status">
                <option value="" {{ 'selected' if not d['Статус розбору'] else '' }}>Без статусу</option>
                <option value="Розглянуто" {{ 'selected' if d['Статус розбору'] == 'Розглянуто' else '' }}>✅ Розглянуто</option>
                <option value="Обговорено з менеджером" {{ 'selected' if d['Статус розбору'] == 'Обговорено з менеджером' else '' }}>🗣 Обговорено з менеджером</option>
                <option value="AI помилився" {{ 'selected' if d['Статус розбору'] == 'AI помилився' else '' }}>⚠️ AI помилився</option>
              </select>
              <button type="submit">Зберегти</button>
            </div>
            {% if d['Коментар тімліда'] %}<div class="saved-note">💾 Збережено</div>{% endif %}
          </form>
        </div>
      </div>
    {% endfor %}
  </div>
{% endfor %}
</body>
</html>
"""


@app.route("/dashboard", methods=["GET"])
def dashboard_index():
    teams = sorted(RNK_TEAMS)
    return redirect(url_for("dashboard_team", team=teams[0]))


@app.route("/dashboard/<team>", methods=["GET"])
def dashboard_team(team: str):
    teams = sorted(RNK_TEAMS)
    if team not in teams:
        return redirect(url_for("dashboard_team", team=teams[0]))

    deals = sheets.get_closed_deals_with_rows(team, limit_days=30)

    grouped: dict[str, list] = {}
    for d in deals:
        day = str(d.get("Дата", ""))[:10] or "Без дати"
        grouped.setdefault(day, []).append(d)
    days = sorted(grouped.items(), key=lambda kv: kv[0], reverse=True)

    return render_template_string(
        _DASHBOARD_TEMPLATE, team=team, teams=teams, days=days, limit_days=30
    )


@app.route("/dashboard/<team>/comment", methods=["POST"])
def dashboard_comment(team: str):
    row = int(request.form.get("row", 0))
    comment = request.form.get("comment", "").strip()
    status = request.form.get("status", "").strip()
    if row:
        sheets.update_teamlead_feedback(team, row, comment, status)
    return redirect(url_for("dashboard_team", team=team))


@app.route("/setup-tg-webhook", methods=["GET"])
def setup_tg_webhook():
    """Register Telegram bot webhook. Call once after deploy."""
    base_url = request.host_url.rstrip("/")
    result = notifier.set_webhook(f"{base_url}/tg-update")
    return jsonify(result)


@app.route("/refresh-plans", methods=["GET"])
def refresh_plans():
    """Ручне підтягування планів з таблиці (не чекаючи 06:00)."""
    return jsonify({"result": _refresh_plans_from_sheet(),
                    "managers": len(MANAGER_PLANS), "teams": len(TEAM_PLANS)})


@app.route("/seed-plans-sheet", methods=["GET"])
def seed_plans_sheet():
    """Одноразово створює аркуші «Плани менеджерів»/«Плани команд» у таблиці
    і заповнює їх поточними значеннями з коду. Потребує ?confirm=1."""
    if request.args.get("confirm") != "1":
        return jsonify({"error": "додай ?confirm=1 — аркуші буде перезаписано"}), 400
    manager_rows = [
        [str(uid), kommo.get_user_name(uid), MANAGER_TEAM.get(uid, ""), plan]
        for uid, plan in MANAGER_PLANS.items()
    ]
    team_rows = [[team, plan] for team, plan in TEAM_PLANS.items()]
    ok = sheets.seed_plans(manager_rows, team_rows)
    return jsonify({"ok": ok, "managers": len(manager_rows), "teams": len(team_rows)})


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


@app.route("/test-first-touch-threads", methods=["GET"])
def test_first_touch_threads():
    """Надсилає тестове повідомлення в гілки першого дотику обох команд —
    перевірка, що гілки 7689/14232 валідні й бот може писати."""
    res = {}
    for team in ("Михальчевська", "Безпам'ятний"):
        res[team] = notifier.send_to_first_touch(
            f"🧪 Тест: гілка першого дотику активна ({team}). Сюди приходитимуть "
            f"результати першого дотику по рекламі.", team
        )
    return jsonify({"ok": True, "sent": res})


@app.route("/debug-first-touch", methods=["GET"])
def debug_first_touch():
    """Діагностика першого дотику по ліду — показує, чому спрацювало/ні, БЕЗ
    надсилання в групу. ?lead_id=12345"""
    import traceback
    try:
        lead_id = int(request.args.get("lead_id", 0))
        if not lead_id:
            return jsonify({"ok": False, "error": "lead_id required"})
        lead = kommo.get_lead(lead_id)
        if not lead:
            return jsonify({"ok": False, "error": "lead not found"})
        resp_id = lead.get("responsible_user_id", 0)
        team = MANAGER_TEAM.get(resp_id, "")
        has_utm = kommo.has_utm_campaign(lead)
        notes = kommo.get_lead_notes(lead_id)
        call_notes = sorted(
            (n for n in notes if n.get("note_type") in (10, 11, "call_in", "call_out")),
            key=lambda n: n.get("created_at", 0),
        )
        calls_info = [{
            "note_type": n.get("note_type"),
            "duration": int((n.get("params") or {}).get("duration", 0) or 0),
            "has_link": bool((n.get("params") or {}).get("link") or (n.get("params") or {}).get("LINK")),
        } for n in call_notes]
        # Перший дотик — лише ВХІДНИЙ дзвінок (call_notes показує всі для діагностики).
        first = next((n for n in call_notes
                      if n.get("note_type") in (10, "call_in")
                      and int((n.get("params") or {}).get("duration", 0) or 0) >= FIRST_TOUCH_MIN_DURATION), None)
        out = {
            "ok": True, "lead_id": lead_id,
            "responsible_id": resp_id, "team": team,
            "team_ok": team in FIRST_TOUCH_TEAMS,
            "has_utm_campaign": has_utm,
            "groq_key_present": bool(transcriber.GROQ_API_KEY),
            "call_notes": calls_info,
            "first_qualifying_call": bool(first),
            "already_done": lead_id in _first_touch_done,
        }
        if first and has_utm and team in FIRST_TOUCH_TEAMS and request.args.get("transcribe"):
            params = first.get("params") or {}
            url = params.get("link", "") or params.get("LINK", "")
            transcript = transcriber.transcribe_call(url) if url else ""
            out["transcript_len"] = len(transcript)
            out["analysis"] = ai_analyzer.analyze_first_touch(transcript, lead.get("name", ""), "")
        return jsonify(out)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e), "traceback": traceback.format_exc()})


@app.route("/elogist-hook", methods=["GET", "POST"])
def elogist_hook():
    """Прямий веб-хук для заявок eLogist (замість Telegram-userbot). Лендинг/eLogist
    шле сюди дані заявки (JSON, form або query) → створюємо лід у кваліфікації на
    етапі «Дзвінки з сайту» з тегом eLogist. Захист — токен у URL (?token=...)."""
    if request.args.get("token") != ELOGIST_HOOK_TOKEN:
        return jsonify({"ok": False, "error": "forbidden"}), 403

    payload: dict = {}
    j = request.get_json(silent=True)
    if isinstance(j, dict):
        payload.update(j)
    payload.update(request.form.to_dict())
    payload.update({k: v for k, v in request.args.to_dict().items() if k != "token"})

    def pick(*keys):
        for want in keys:
            for k, v in payload.items():
                if k.lower() == want and str(v).strip():
                    return str(v).strip()
        return ""

    phone_raw = pick("phone", "tel", "telephone", "phone_number", "number",
                     "contact_phone", "телефон", "номер")
    blob = phone_raw or " ".join(str(v) for v in payload.values())
    m = ELOGIST_PHONE_RE.search(blob)
    if not m:
        return jsonify({"ok": False, "error": "no phone found", "received": payload})
    digits = re.sub(r"\D", "", m.group())
    if not digits.startswith("380"):
        digits = "380" + digits[-9:]
    phone = "+" + digits

    route = pick("route", "маршрут", "from_to", "напрямок", "name", "title")
    lead_id, status = _create_elogist_lead(phone, route)
    return jsonify({
        "ok": status in ("created", "duplicate"),
        "status": status, "lead_id": lead_id, "phone": phone,
    })


@app.route("/test-admin-stats", methods=["GET"])
def test_admin_stats():
    """Надсилає тестове повідомлення в адмінську групу першого дотику —
    щоб перевірити, що бот доданий і гілка валідна."""
    ok = notifier.send_to_admin_stats(
        "🧪 Тест: бот успішно пише в адмінську групу (зведення першого дотику "
        "приходитиме сюди о 18:00)."
    )
    return jsonify({
        "ok": ok,
        "chat_id": notifier.TG_CHAT_ID_ADMIN_STATS,
        "thread_id": notifier.TG_THREAD_ID_ADMIN_STATS,
    })


@app.route("/sheet-link", methods=["GET"])
def sheet_link():
    """Повертає посилання на основну Google-таблицю і пряме посилання на
    вкладку 'Дзвінки РНК' (де лежать транскрипти дзвінків)."""
    sheet_id = os.getenv("GOOGLE_SHEETS_ID", "") or os.getenv("SPREADSHEET_ID", "")
    if not sheet_id:
        return jsonify({"ok": False, "error": "GOOGLE_SHEETS_ID не заданий у env"})
    base = f"https://docs.google.com/spreadsheets/d/{sheet_id}"
    calls_url = base
    try:
        ws = sheets._get_or_create_worksheet("Дзвінки РНК", rows=5000, cols=8)
        if ws is not None:
            calls_url = f"{base}/edit#gid={ws.id}"
    except Exception as e:
        logger.error("sheet-link: %s", e)
    return jsonify({"ok": True, "spreadsheet": base, "calls_tab": calls_url})


@app.route("/first-touch-report", methods=["GET"])
def first_touch_report():
    """Звіт по першому дотику за N днів (дефолт 7) — читає аркуш «Перший дотик»
    у Google Sheets. Жодних запитів до Kommo API."""
    try:
        days = int(request.args.get("days", 7))
    except ValueError:
        days = 7
    days = max(1, min(days, 90))
    data = sheets.read_first_touch(days)
    if data is None:
        return jsonify({"ok": False, "error": "аркуш «Перший дотик» недоступний"})
    total = data["total"]
    priced = data["priced"]
    pct = round(100 * priced / total) if total else 0
    lines = [
        f"📊 Перший дотик по рекламі — за {days} дн.",
        f"Прийнято рекламних лідів (перший дотик): {total}",
        f"Озвучено ціну на першому дотику: {priced} ({pct}%)",
    ]
    for team, v in data["by_team"].items():
        tp = round(100 * v["price"] / v["acc"]) if v["acc"] else 0
        lines.append(f"• {team}: прийнято {v['acc']}, ціну озвучено {v['price']} ({tp}%)")
    return jsonify({"ok": True, "text": "\n".join(lines), **data})


@app.route("/test-tg", methods=["GET"])
def test_tg():
    result = notifier.test_bot()
    return jsonify(result)


@app.route("/tg-webhook-info", methods=["GET"])
def tg_webhook_info():
    return jsonify(notifier.get_webhook_info())


@app.route("/check-webhook-health", methods=["GET"])
def check_webhook_health_endpoint():
    """Manually trigger the webhook health check (normally runs every 20 min)."""
    webhooks = kommo.get_webhooks()
    hook = next((w for w in webhooks if w.get("destination") == WEBHOOK_URL), None)
    _check_webhook_health()
    return jsonify({"ok": True, "hook_before_check": hook})


@app.route("/recent-webhooks", methods=["GET"])
def recent_webhooks():
    """Read-only: inspect the last 30 raw webhook payloads received from Kommo.
    ?lead_id=12345 to filter to webhooks mentioning that lead id."""
    lead_id = request.args.get("lead_id", "")
    items = list(_recent_webhooks)
    if lead_id:
        items = [w for w in items if lead_id in json.dumps(w["data"], ensure_ascii=False)]
    return jsonify({"ok": True, "count": len(items), "webhooks": items})


@app.route("/test-team-route", methods=["GET"])
def test_team_route():
    """Send exactly ONE test message to a single team's tracking group/thread and
    return Telegram's raw response (to verify the bot can reach that chat).
    ?team=Яцик"""
    import requests as _rq
    team = request.args.get("team", "")
    route = notifier._RNK_TEAM_ROUTES.get(team) or notifier._RPK_TEAM_ROUTES.get(team)
    if not route:
        return jsonify({"ok": False, "error": f"no route for team '{team}'"})
    chat_id = route["chat_id"]
    thread_id = route.get("tracking_thread")
    try:
        resp = _rq.post(
            f"https://api.telegram.org/bot{notifier.TG_TOKEN}/sendMessage",
            json={
                "chat_id": chat_id,
                "message_thread_id": int(thread_id),
                "text": f"🔧 Тест маршруту трекінгу — {team}",
            },
            timeout=10,
        )
        return jsonify({"ok": True, "team": team, "chat_id": chat_id, "thread_id": thread_id, "response": resp.json()})
    except Exception as e:
        return jsonify({"ok": False, "team": team, "chat_id": chat_id, "thread_id": thread_id, "error": str(e)})


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


@app.route("/test-call-analysis", methods=["GET"])
def test_call_analysis():
    """Manually run the RNK call-analysis pipeline for a specific lead/note (debug)."""
    import traceback
    try:
        lead_id = int(request.args.get("lead_id", 0))
        note_id = int(request.args.get("note_id", 0))
        if not lead_id or not note_id:
            return jsonify({"ok": False, "error": "lead_id and note_id required"})

        lead = kommo.get_lead(lead_id)
        if not lead:
            return jsonify({"ok": False, "error": "lead not found"})

        responsible_id = lead.get("responsible_user_id", 0)
        manager_name = kommo.get_user_name(responsible_id) if responsible_id else "—"

        call_note = kommo.get_note(lead_id, note_id)
        params = call_note.get("params") or {}
        duration = int(params.get("duration", 0) or 0)
        record_url = params.get("link", "") or params.get("LINK", "")
        call_type = "вхідний" if call_note.get("note_type") in (10, "call_in") else "вихідний"

        _process_rnk_deal_call(lead_id, lead.get("name", f"Угода #{lead_id}"), manager_name, call_type, duration, record_url)
        return jsonify({"ok": True, "duration": duration, "record_url": record_url, "manager": manager_name})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e), "traceback": traceback.format_exc()})


@app.route("/debug-closed-verdict", methods=["GET"])
def debug_closed_verdict():
    """Безпечна діагностика: проганяє AI-оцінку закритої угоди й повертає сирий
    текст + розпізнаний вердикт, БЕЗ надсилання в Telegram. ?lead_id=12345"""
    import traceback
    try:
        lead_id = int(request.args.get("lead_id", 0))
        if not lead_id:
            return jsonify({"ok": False, "error": "lead_id required"})
        lead = kommo.get_lead(lead_id)
        if not lead:
            return jsonify({"ok": False, "error": "lead not found"})
        responsible_id = lead.get("responsible_user_id", 0)
        details = kommo.get_lead_details(lead_id)
        manager_name = kommo.get_user_name(responsible_id) if responsible_id else "—"
        team = MANAGER_TEAM.get(responsible_id, "")
        amount = int(lead.get("price", 0))
        recommendation = ai_analyzer.analyze_closed_deal({
            **details, "manager": manager_name, "amount": amount
        })
        closure_match = re.search(r"CLOSURE:\s*(ПЕРЕДЧАСНЕ|ОБ['ʼ’]?ЄКТИВНЕ)\s*-?\s*(.*)", recommendation)
        verdict = ""
        if closure_match:
            verdict = "ПЕРЕДЧАСНЕ" if "ПЕРЕДЧАСНЕ" in closure_match.group(1) else "ОБ'ЄКТИВНЕ"
        return jsonify({
            "ok": True, "lead_id": lead_id, "team": team, "is_rnk": team in RNK_TEAMS,
            "verdict": verdict, "raw_recommendation": recommendation,
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e), "traceback": traceback.format_exc()})


@app.route("/test-closed-deal", methods=["GET"])
def test_closed_deal():
    """Manually run the closed-not-realized AI review pipeline for a specific lead (debug).
    ?lead_id=12345"""
    import traceback
    try:
        lead_id = int(request.args.get("lead_id", 0))
        if not lead_id:
            return jsonify({"ok": False, "error": "lead_id required"})

        lead = kommo.get_lead(lead_id)
        if not lead:
            return jsonify({"ok": False, "error": "lead not found"})

        responsible_id = lead.get("responsible_user_id", 0)
        _handle_closed_not_realized(lead_id, responsible_id)
        return jsonify({"ok": True, "lead_id": lead_id, "responsible_id": responsible_id})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e), "traceback": traceback.format_exc()})


@app.route("/test-ai", methods=["GET"])
def test_ai():
    """Перевіряє напряму, чому ai_analyzer повертає пусто (ключ/квота/помилка API)."""
    import traceback
    import requests as _rq
    try:
        key_present = bool(ai_analyzer.ANTHROPIC_API_KEY)
        if not key_present:
            return jsonify({"ok": False, "error": "ANTHROPIC_API_KEY not set on Render"})

        resp = _rq.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": ai_analyzer.ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": ai_analyzer.MODEL,
                "max_tokens": 50,
                "messages": [{"role": "user", "content": "Скажи 'тест ок' українською."}],
            },
            timeout=30,
        )
        data = resp.json()
        return jsonify({"ok": resp.ok, "status_code": resp.status_code, "response": data, "key_present": key_present})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e), "traceback": traceback.format_exc()})


@app.route("/check-logged", methods=["GET"])
def check_logged():
    """Read-only check: was this lead already logged in its team's РНК sheet?
    ?lead_id=12345"""
    import traceback
    try:
        lead_id = int(request.args.get("lead_id", 0))
        if not lead_id:
            return jsonify({"ok": False, "error": "lead_id required"})
        lead = kommo.get_lead(lead_id)
        if not lead:
            return jsonify({"ok": False, "error": "lead not found"})
        responsible_id = lead.get("responsible_user_id", 0)
        team = MANAGER_TEAM.get(responsible_id, "")
        if team not in RNK_TEAMS:
            return jsonify({"ok": True, "lead_id": lead_id, "team": team, "logged": None,
                             "note": "not an RNK team — closed deals aren't logged to a РНК sheet for this manager"})
        ws = sheets._get_or_create_worksheet(sheets._team_sheet_name(team), rows=2000, cols=15)
        records = ws.get_all_records() if ws else []
        row = next((r for r in records if str(r.get("ID угоди", "")) == str(lead_id)), None)
        return jsonify({
            "ok": True, "lead_id": lead_id, "team": team,
            "logged": row is not None,
            "row": row,
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e), "traceback": traceback.format_exc()})


@app.route("/test-ai-deal", methods=["GET"])
def test_ai_deal():
    """Прогонить analyze_closed_deal() для реального ліда і повертає сирий текст відповіді AI."""
    import traceback
    try:
        lead_id = int(request.args.get("lead_id", 0))
        if not lead_id:
            return jsonify({"ok": False, "error": "lead_id required"})

        details = kommo.get_lead_details(lead_id)
        lead = kommo.get_lead(lead_id)
        responsible_id = lead.get("responsible_user_id", 0) if lead else 0
        manager_name = kommo.get_user_name(responsible_id) if responsible_id else "—"
        amount = int(lead.get("price", 0)) if lead else 0

        deal_payload = {**details, "manager": manager_name, "amount": amount}
        recommendation = ai_analyzer.analyze_closed_deal(deal_payload)

        calls_analysis = _analyze_rnk_closed_deal_calls(lead_id, details["name"], manager_name)

        return jsonify({
            "ok": True,
            "lead_id": lead_id,
            "deal_payload": deal_payload,
            "analyze_closed_deal_result": recommendation,
            "analyze_closed_deal_len": len(recommendation),
            "calls_analysis_result": calls_analysis,
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e), "traceback": traceback.format_exc()})


@app.route("/dedupe-closed-deals", methods=["GET"])
def dedupe_closed_deals():
    """Видаляє дублікати рядків для одного lead_id у вкладці 'РНК <команда>',
    залишаючи рядок з найбільш повним AI-аналізом. ?team=Команда"""
    import traceback
    try:
        team = request.args.get("team", "")
        if not team:
            return jsonify({"ok": False, "error": "team required"})

        ws = sheets._get_or_create_worksheet(sheets._team_sheet_name(team), rows=2000, cols=15)
        if not ws:
            return jsonify({"ok": False, "error": "worksheet not found"})

        records = ws.get_all_records()
        by_lead: dict[str, list[int]] = {}
        for i, r in enumerate(records, start=2):
            lead_id = str(r.get("ID угоди", ""))
            by_lead.setdefault(lead_id, []).append(i)

        rows_to_delete = []
        for lead_id, rows in by_lead.items():
            if len(rows) <= 1:
                continue
            best_row = max(rows, key=lambda r: len(str(records[r - 2].get("Рекомендація AI", ""))))
            rows_to_delete.extend(r for r in rows if r != best_row)

        dry_run = request.args.get("dry_run", "") == "1"
        if dry_run:
            return jsonify({
                "ok": True, "team": team, "total_rows": len(records),
                "duplicate_groups": {k: v for k, v in by_lead.items() if len(v) > 1},
                "rows_that_would_be_deleted": sorted(rows_to_delete, reverse=True),
            })

        if rows_to_delete:
            # Один пакетний запит замість N окремих delete_rows — щоб не вибивати
            # ліміт записів/хв у Google Sheets API на великій кількості дублікатів.
            requests_body = [
                {
                    "deleteDimension": {
                        "range": {
                            "sheetId": ws.id,
                            "dimension": "ROWS",
                            "startIndex": row - 1,
                            "endIndex": row,
                        }
                    }
                }
                for row in sorted(rows_to_delete, reverse=True)
            ]
            ws.spreadsheet.batch_update({"requests": requests_body})

        return jsonify({"ok": True, "team": team, "deleted_rows": sorted(rows_to_delete, reverse=True)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e), "traceback": traceback.format_exc()})


AD_SPEND_SPREADSHEET_ID = "1krromIuWfmyCR5BAup6kuVnCGaYdK3sA2AJt5Ksn3V0"


@app.route("/debug-ad-spend-sheet", methods=["GET"])
def debug_ad_spend_sheet():
    """Тимчасовий дебаг: показує вкладки таблиці витрат на рекламу і сирі рядки
    обраної вкладки (?tab=...&rows=50), щоб розпарсити структуру помісячних блоків."""
    sh = sheets._get_external_sheet(AD_SPEND_SPREADSHEET_ID)
    if not sh:
        return jsonify({"ok": False, "error": "cannot open spreadsheet (check service account access)"})
    tab = request.args.get("tab")
    if not tab:
        return jsonify({"ok": True, "worksheets": [ws.title for ws in sh.worksheets()]})
    try:
        ws = sh.worksheet(tab)
        n = int(request.args.get("rows", 50))
        values = ws.get_all_values()[:n]
        return jsonify({"ok": True, "tab": tab, "rows": values})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})


@app.route("/debug-service-account-email", methods=["GET"])
def debug_service_account_email():
    """Показує лише client_email сервісного акаунта Google (без приватного ключа) —
    щоб дати йому доступ 'Viewer' до нової Google-таблиці з витратами на рекламу."""
    sa_json = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON", "")
    if not sa_json:
        return jsonify({"ok": False, "error": "GOOGLE_SERVICE_ACCOUNT_JSON not set"})
    try:
        data = json.loads(sa_json)
        return jsonify({"ok": True, "client_email": data.get("client_email", "")})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})


@app.route("/debug-ad-campaign-fields", methods=["GET"])
def debug_ad_campaign_fields():
    """Тимчасовий дебаг: показує сирі custom_fields_values для лідів з кампанією, що
    збігається з ?name=... (для пошуку, з якого саме поля береться значення)."""
    name = request.args.get("name", "")
    days = int(request.args.get("days", 7))
    from datetime import datetime, timezone, timedelta
    since = int((datetime.now(timezone.utc) - timedelta(days=days)).timestamp())
    until = int(datetime.now(timezone.utc).timestamp())
    matches = []
    page = 1
    while True:
        resp = kommo.requests.get(
            f"{kommo.KOMMO_BASE}/api/v4/leads",
            headers=kommo.HEADERS,
            params={
                "filter[created_at][from]": since,
                "filter[created_at][to]": until,
                "with": "custom_fields",
                "limit": 250,
                "page": page,
            },
            timeout=15,
        )
        if not resp.ok:
            break
        batch = resp.json().get("_embedded", {}).get("leads", [])
        for lead in batch:
            if kommo.get_campaign_name(lead) == name:
                relevant = [
                    cf for cf in (lead.get("custom_fields_values") or [])
                    if cf.get("field_id") in kommo.AD_CAMPAIGN_FIELD_IDS
                ]
                matches.append({"lead_id": lead.get("id"), "fields": relevant})
                if len(matches) >= 5:
                    break
        if len(matches) >= 5 or len(batch) < 250:
            break
        page += 1
    return jsonify({"ok": True, "matches": matches})


@app.route("/test-new-lead", methods=["GET"])
def test_new_lead():
    """Manually run _handle_new_lead for a specific lead (debug РПК tracking issue).
    ?lead_id=12345"""
    import traceback
    try:
        lead_id = int(request.args.get("lead_id", 0))
        if not lead_id:
            return jsonify({"ok": False, "error": "lead_id required"})
        lead = kommo.get_lead(lead_id)
        if not lead:
            return jsonify({"ok": False, "error": "lead not found"})
        responsible_id = lead.get("responsible_user_id", 0)
        team = MANAGER_TEAM.get(responsible_id, "")
        is_working = _is_working_hours()
        _handle_new_lead(lead_id, responsible_id)
        return jsonify({
            "ok": True, "lead_id": lead_id, "responsible_id": responsible_id,
            "team": team, "is_working_hours": is_working,
            "pipeline_id": lead.get("pipeline_id"), "status_id": lead.get("status_id"),
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e), "traceback": traceback.format_exc()})


@app.route("/test-non-target", methods=["GET"])
def test_non_target():
    """Manually run the non-target lead verification pipeline for a specific lead (debug).
    ?lead_id=12345"""
    import traceback
    try:
        lead_id = int(request.args.get("lead_id", 0))
        if not lead_id:
            return jsonify({"ok": False, "error": "lead_id required"})

        lead = kommo.get_lead(lead_id)
        if not lead:
            return jsonify({"ok": False, "error": "lead not found"})

        responsible_id = lead.get("responsible_user_id", 0)
        _check_non_target_lead(lead_id, responsible_id)
        return jsonify({"ok": True, "lead_id": lead_id, "responsible_id": responsible_id})
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

        CLOSED_STATUS_ID = 143

        # Kommo закриті угоди — окремий ендпоінт без pipeline_id
        leads = []
        try:
            import requests as req
            token = os.getenv("KOMMO_TOKEN", "")
            base = os.getenv("KOMMO_BASE", "https://utsercice.kommo.com")
            headers = {"Authorization": f"Bearer {token}"}
            page = 1
            while True:
                resp = req.get(f"{base}/api/v4/leads", headers=headers, params={
                    "filter[statuses][0][pipeline_id]": 8921928,
                    "filter[statuses][0][status_id]": CLOSED_STATUS_ID,
                    "filter[closed_at][from]": day_start,
                    "filter[closed_at][to]": day_end,
                    "with": "custom_fields",
                    "limit": 250, "page": page,
                }, timeout=15)
                batch = resp.json().get("_embedded", {}).get("leads", []) if resp.ok else []
                leads.extend(batch)
                if len(batch) < 250:
                    break
                page += 1
        except Exception as ex:
            return jsonify({"ok": False, "error": f"kommo fetch: {ex}"})

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

            skip_ai = request.args.get("skip_ai") == "1"
            ai_rec = "" if skip_ai else ai_analyzer.analyze_closed_deal({
                **details, "manager": manager_name, "amount": amount
            })
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
                "ai_recommendation": ai_rec,
            }
            sheets.log_closed_deal(deal_data)
            processed += 1

        return jsonify({"ok": True, "date": day.strftime("%Y-%m-%d"), "processed": processed})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e), "traceback": traceback.format_exc()})


@app.route("/ringostat-webhook", methods=["POST"])
def ringostat_webhook():
    """Receives call data from Ringostat after each call."""
    data = request.get_json(silent=True) or {}
    logger.info("Ringostat webhook: %s", data)

    cdr_id = data.get("cdr_id", "")
    call_type = data.get("call_type", "")
    sip = data.get("connected_with", "") or data.get("sip", "")
    duration = data.get("duration", 0)
    record_url = data.get("record", "")
    calldate = data.get("calldate", "")
    src_num = data.get("src_num", "")
    dst_num = data.get("dst_num", "")

    duration_sec = int(duration) if str(duration).isdigit() else 0
    call_type_label = {"in": "Вхідний", "out": "Вихідний", "transitin": "Транзит"}.get(call_type, call_type)

    if duration_sec == 0:
        manager_id = _sip_to_manager_id(sip)
        if manager_id:
            manager_name = kommo.get_user_name(manager_id)
            tg_tag = notifier.get_manager_tag(manager_id)
            manager_line = f"👤 {manager_name}{tg_tag}"
        else:
            manager_line = f"👤 SIP: <code>{sip}</code>" if sip else "👤 Невідомо"
        msg = (
            f"🚫 <b>Пропущений дзвінок</b>\n"
            f"{manager_line}\n"
            f"📲 {call_type_label}\n"
            f"☎️ {src_num or dst_num or '—'}\n"
            f"🗓 {calldate}"
        )
        _route_tracking_message(manager_id, msg)
        return jsonify({"ok": True, "missed": True})

    if duration_sec < 10:
        return jsonify({"ok": True, "skipped": "too short"})

    # Шукаємо менеджера по SIP — якщо не знайдено, показуємо sip як є
    manager_id = _sip_to_manager_id(sip)
    if manager_id:
        manager_name = kommo.get_user_name(manager_id)
        tg_tag = notifier.get_manager_tag(manager_id)
        team = MANAGER_TEAM.get(manager_id, "")
        manager_line = f"👤 {manager_name}{tg_tag}"
    else:
        team = ""
        manager_line = f"👤 SIP: <code>{sip}</code>"

    msg = (
        f"📞 <b>Дзвінок завершено</b>\n"
        f"{manager_line}\n"
        f"📲 {call_type_label} | ⏱ <b>{duration_sec // 60}хв {duration_sec % 60}с</b>\n"
        f"🗓 {calldate}"
    )
    if record_url:
        msg += f"\n🎙 <a href='{record_url}'>Запис дзвінка</a>"

    notifier.send_to_team_tracking(msg, team)
    return jsonify({"ok": True})


def _sip_to_manager_id(sip: str) -> int:
    """Map Ringostat SIP account to Kommo manager ID."""
    return SIP_MAP.get(sip, 0)


if __name__ == "__main__":
    app.run(debug=False)
