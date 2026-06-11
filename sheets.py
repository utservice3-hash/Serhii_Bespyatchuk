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
    15380780: "Шаврова",  # Ворошилова Вікторія Петрівна
    15391908: "Шаврова",  # Коваль Катерина Олегівна
    15414956: "Шаврова",  # Гаркушина Юлія Олексіївна (Покушина)

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
