import os
import json
import logging
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

SPREADSHEET_ID = os.getenv("GOOGLE_SHEETS_ID", "") or os.getenv("SPREADSHEET_ID", "")
SERVICE_ACCOUNT_JSON = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON", "")

# Команди: {kommo_user_id: "Назва команди"}
TEAM_MAP: dict[int, str] = {
    # Команда Яцика
    3379102: "Яцик",    # Яцик Дмитро (тімлід)
    2013613: "Яцик",    # Антипенко Олег
    7347414: "Яцик",    # Свіржевський Артем
    10022700: "Яцик",   # Мокляк Олександр
    11739992: "Яцик",   # Хомік Вікторія
    12163420: "Яцик",   # Семенюк Дмитро

    # Команда Дмитрука
    6062482: "Дмитрук",  # Дмитрук Василь (тімлід)
    7863771: "Дмитрук",  # Возович Антон
    11295244: "Дмитрук", # Самохвалов Сергій
    11338832: "Дмитрук", # Федоровський Іван

    # Команда Шаврової
    12066792: "Шаврова",  # Шаврова Лілія (тімлід)
    15040472: "Шаврова",  # Мацалак Андрій Васильович
    15200560: "Шаврова",  # Сенів Тетяна Олександрівна
    15380676: "Шаврова",  # Братейко Ірина Романівна
    15414956: "Шаврова",  # Гаркушина Юлія Олексіївна

    # Команда Михальчевської
    12782896: "Михальчевська",  # Михальчевська Дарина (тімлід)
    13461608: "Михальчевська",  # Андрусенко Богдана
    13803600: "Михальчевська",  # Цалко Олександр
    14083284: "Михальчевська",  # Гофман Іван
    14431884: "Михальчевська",  # Янчевський Едуард
    14926076: "Михальчевська",  # Панасюк Святослав
    15227544: "Михальчевська",  # Герелевич Аліна Сергіївна
    15227596: "Михальчевська",  # Пехньо Ксенія Олександрівна
    15279220: "Михальчевська",  # Сугак Денис Олегович
    12812476: "Михальчевська",  # Сердюк Ярослав Миколайович

    # Команда Безпам'ятного
    12644448: "Безпам'ятний",  # Безпам'ятний Андрій (тімлід)
    11293904: "Безпам'ятний",  # Крицька Діана
    13689696: "Безпам'ятний",  # Чукін Євген
    15192136: "Безпам'ятний",  # Палій Тарас Зеновійович
    15354656: "Безпам'ятний",  # Шендера Анастасія Юріївна
    15354672: "Безпам'ятний",  # Борівець Олеся Михайлівна
    15355168: "Безпам'ятний",  # Голоміна Олександра Євгеніївна
    15380780: "Безпам'ятний",  # Ворошилова Вікторія Петрівна
    15391908: "Безпам'ятний",  # Коваль Катерина Олегівна
}


def get_team(user_id: int) -> str:
    return TEAM_MAP.get(user_id, "Інші")


_gc = None
_sheet = None


def _get_sheet():
    global _gc, _sheet
    if _sheet:
        return _sheet
    if not SERVICE_ACCOUNT_JSON or not SPREADSHEET_ID:
        logger.warning("Google Sheets not configured")
        return None
    try:
        import gspread
        from google.oauth2.service_account import Credentials

        creds_dict = json.loads(SERVICE_ACCOUNT_JSON)
        scopes = [
            "https://www.googleapis.com/auth/spreadsheets",
            "https://www.googleapis.com/auth/drive",
        ]
        creds = Credentials.from_service_account_info(creds_dict, scopes=scopes)
        _gc = gspread.authorize(creds)
        _sheet = _gc.open_by_key(SPREADSHEET_ID)
        return _sheet
    except Exception as e:
        logger.error("Google Sheets init error: %s", e)
        return None


def _get_or_create_worksheet(name: str, rows: int = 1000, cols: int = 20):
    sh = _get_sheet()
    if not sh:
        return None
    try:
        return sh.worksheet(name)
    except Exception:
        return sh.add_worksheet(title=name, rows=rows, cols=cols)


def ensure_headers():
    """Create headers on first run."""
    ws = _get_or_create_worksheet("Реєстр")
    if not ws:
        return
    try:
        if ws.cell(1, 1).value != "Lead ID":
            ws.insert_row([
                "Lead ID", "Назва ліда", "Менеджер", "Команда",
                "Час передачі", "Час взяття в роботу", "Перший дзвінок",
                "Час реакції (хв)", "Час до дзвінка (хв)"
            ], 1)
    except Exception as e:
        logger.error("ensure_headers: %s", e)


def append_transfer(lead_id: int, lead_name: str, manager: str, transferred_at: datetime, manager_id: int = 0):
    ws = _get_or_create_worksheet("Реєстр")
    if not ws:
        return
    try:
        team = get_team(manager_id) if manager_id else ""
        ws.append_row([
            lead_id,
            lead_name,
            manager,
            team,
            transferred_at.strftime("%Y-%m-%d %H:%M:%S"),
            "",  # taken_at
            "",  # first_call_at
            "",  # reaction_min
            "",  # call_min
        ])
        logger.info("sheets: appended transfer for lead %s (team: %s)", lead_id, team)
    except Exception as e:
        logger.error("sheets append_transfer: %s", e)


def update_taken(lead_id: int, taken_at: datetime):
    ws = _get_or_create_worksheet("Реєстр")
    if not ws:
        return
    try:
        cell = ws.find(str(lead_id))
        if cell:
            row = cell.row
            transferred_val = ws.cell(row, 5).value
            if transferred_val:
                transferred_at = datetime.strptime(transferred_val, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
                delta = (taken_at - transferred_at).total_seconds() / 60
                ws.update_cell(row, 6, taken_at.strftime("%Y-%m-%d %H:%M:%S"))
                ws.update_cell(row, 8, round(delta, 1))
    except Exception as e:
        logger.error("sheets update_taken: %s", e)


def update_first_call(lead_id: int, call_at: datetime):
    ws = _get_or_create_worksheet("Реєстр")
    if not ws:
        return
    try:
        cell = ws.find(str(lead_id))
        if cell:
            row = cell.row
            transferred_val = ws.cell(row, 5).value
            if transferred_val:
                transferred_at = datetime.strptime(transferred_val, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
                delta = (call_at - transferred_at).total_seconds() / 60
                ws.update_cell(row, 7, call_at.strftime("%Y-%m-%d %H:%M:%S"))
                ws.update_cell(row, 9, round(delta, 1))
    except Exception as e:
        logger.error("sheets update_first_call: %s", e)


def append_call(lead_id: int, manager: str, call_type: str, duration: int, transcript: str, call_at: datetime) -> int:
    """Додає дзвінок до реєстру 'Дзвінки РНК' (накопичується по угоді). Повертає номер рядка."""
    ws = _get_or_create_worksheet("Дзвінки РНК", rows=5000, cols=8)
    if not ws:
        return 0
    try:
        if ws.cell(1, 1).value != "Lead ID":
            ws.insert_row(["Lead ID", "Дата", "Менеджер", "Тип", "Тривалість (с)", "Транскрипт", "AI-аналіз", "Ризик"], 1)
        ws.append_row([
            lead_id,
            call_at.strftime("%Y-%m-%d %H:%M:%S"),
            manager,
            call_type,
            duration,
            transcript,
            "",  # AI-аналіз
            "",  # Ризик
        ])
        logger.info("sheets: appended call for lead %s (%ss)", lead_id, duration)
        return len(ws.get_all_values())
    except Exception as e:
        logger.error("sheets append_call: %s", e)
        return 0


def update_call_analysis(row: int, analysis: str, risk: str) -> None:
    """Записує AI-аналіз і ризик у відповідний рядок реєстру 'Дзвінки РНК'."""
    if not row:
        return
    ws = _get_or_create_worksheet("Дзвінки РНК", rows=5000, cols=8)
    if not ws:
        return
    try:
        ws.update_cell(row, 7, analysis)
        ws.update_cell(row, 8, risk)
    except Exception as e:
        logger.error("sheets update_call_analysis: %s", e)


def get_calls_for_lead(lead_id: int) -> list[dict]:
    """Повертає всі дзвінки угоди (накопичені), найстаріший спочатку."""
    ws = _get_or_create_worksheet("Дзвінки РНК", rows=5000, cols=6)
    if not ws:
        return []
    try:
        records = ws.get_all_records()
        return [r for r in records if str(r.get("Lead ID", "")) == str(lead_id)]
    except Exception as e:
        logger.error("sheets get_calls_for_lead: %s", e)
        return []


def _team_sheet_name(team: str) -> str:
    return f"РНК {team}"


def log_closed_deal(deal: dict) -> None:
    """
    Записує закриту угоду РНК в реєстр відмов (окрема вкладка на кожну команду).
    deal = {lead_id, name, manager, team, reject_reason, last_status,
            days_in_work, calls_count, notes_count, amount, closed_at,
            ai_recommendation, verdict, category}
    Якщо verdict == "ПЕРЕДЧАСНЕ" — рядок підсвічується червоним для тімліда.
    """
    team = deal.get("team", "")
    sheet_name = _team_sheet_name(team)
    ws = _get_or_create_worksheet(sheet_name, rows=2000, cols=15)
    if not ws:
        return
    try:
        if ws.cell(1, 1).value != "Дата":
            ws.insert_row([
                "Дата", "ID угоди", "Назва", "Менеджер",
                "Причина відмови", "Закрито з етапу", "Днів в роботі",
                "Дзвінків", "Нотаток", "Сума (грн)", "Вердикт AI",
                "Категорія причини", "Рекомендація AI",
                "Коментар тімліда", "Статус розбору"
            ], 1)
        ws.insert_row([
            deal.get("closed_at", ""),
            deal.get("lead_id", ""),
            deal.get("name", ""),
            deal.get("manager", ""),
            deal.get("reject_reason", ""),
            deal.get("last_status", ""),
            deal.get("days_in_work", ""),
            deal.get("calls_count", 0),
            deal.get("notes_count", 0),
            deal.get("amount", 0),
            deal.get("verdict", ""),
            deal.get("category", ""),
            deal.get("ai_recommendation", ""),
            "",  # Коментар тімліда
            "",  # Статус розбору
        ], 2)
        if deal.get("verdict") == "ПЕРЕДЧАСНЕ":
            ws.format("A2:O2", {"backgroundColor": {"red": 0.96, "green": 0.78, "blue": 0.78}})
        logger.info("sheets: logged closed deal %s -> %s", deal.get("lead_id"), sheet_name)
    except Exception as e:
        logger.error("sheets log_closed_deal: %s", e)


def get_closed_deals_with_rows(team: str, limit_days: int = 30) -> list[dict]:
    """
    Повертає відмови команди для веб-дашборду, кожен запис із номером рядка ('_row')
    для подальшого запису коментаря тімліда. Обмежено останніми limit_days днями.
    """
    from datetime import datetime, timezone, timedelta
    ws = _get_or_create_worksheet(_team_sheet_name(team), rows=2000, cols=15)
    if not ws:
        return []
    try:
        records = ws.get_all_records()
        cutoff = (datetime.now(timezone.utc) - timedelta(days=limit_days)).strftime("%Y-%m-%d")
        result = []
        for i, r in enumerate(records, start=2):
            date_str = str(r.get("Дата", ""))
            if date_str and date_str[:10] < cutoff:
                continue
            r["_row"] = i
            result.append(r)
        result.reverse()  # найновіші спочатку
        return result
    except Exception as e:
        logger.error("sheets get_closed_deals_with_rows: %s", e)
        return []


def update_teamlead_feedback(team: str, row: int, comment: str, status: str) -> bool:
    """Записує коментар тімліда і статус розбору у відповідний рядок реєстру відмов."""
    ws = _get_or_create_worksheet(_team_sheet_name(team), rows=2000, cols=15)
    if not ws:
        return False
    try:
        ws.update_cell(row, 14, comment)
        ws.update_cell(row, 15, status)
        return True
    except Exception as e:
        logger.error("sheets update_teamlead_feedback: %s", e)
        return False


def get_today_closed_deals(team: str, cutoff_hour_utc: int = 14) -> list[dict]:
    """Повертає відмови команди з 00:00 до cutoff_hour_utc UTC поточного дня."""
    from datetime import datetime, timezone
    ws = _get_or_create_worksheet(_team_sheet_name(team), rows=2000, cols=13)
    if not ws:
        return []
    try:
        now = datetime.now(timezone.utc)
        day_start = now.strftime("%Y-%m-%d") + " 00:00"
        cutoff = now.replace(hour=cutoff_hour_utc, minute=0, second=0, microsecond=0).strftime("%Y-%m-%d %H:%M")
        records = ws.get_all_records()
        return [
            r for r in records
            if day_start <= str(r.get("Дата", "")) < cutoff
        ]
    except Exception as e:
        logger.error("sheets get_today_closed_deals: %s", e)
        return []


def write_daily_snapshot(date_str: str, stats: list[dict]):
    """
    Write daily snapshot to 'Щоденний звіт' sheet.
    stats = [{manager, team, count, avg_reaction_min}, ...]
    """
    ws = _get_or_create_worksheet("Щоденний звіт", rows=5000, cols=10)
    if not ws:
        return
    try:
        if ws.cell(1, 1).value != "Дата":
            ws.insert_row(["Дата", "Команда", "Менеджер", "Лідів", "Сер. реакція (хв)"], 1)
        rows = []
        for s in stats:
            rows.append([date_str, s["team"], s["manager"], s["count"], s.get("avg_reaction", "")])
        if rows:
            ws.append_rows(rows)
        logger.info("sheets: daily snapshot written for %s (%d rows)", date_str, len(rows))
    except Exception as e:
        logger.error("sheets write_daily_snapshot: %s", e)
