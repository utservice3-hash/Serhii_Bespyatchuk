import os
import json
import logging
import re
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


_external_sheets_cache: dict[str, "object"] = {}


def _get_external_sheet(spreadsheet_id: str):
    """Відкриває довільну Google-таблицю за ID (не основну бот-таблицю), напр.
    таблицю з витратами на рекламу, яку веде маркетинг."""
    if spreadsheet_id in _external_sheets_cache:
        return _external_sheets_cache[spreadsheet_id]
    if not SERVICE_ACCOUNT_JSON:
        logger.warning("Google Sheets not configured (no service account)")
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
        gc = gspread.authorize(creds)
        sh = gc.open_by_key(spreadsheet_id)
        _external_sheets_cache[spreadsheet_id] = sh
        return sh
    except Exception as e:
        logger.error("_get_external_sheet(%s) error: %s", spreadsheet_id, e)
        return None


AD_SPEND_SPREADSHEET_ID = "1krromIuWfmyCR5BAup6kuVnCGaYdK3sA2AJt5Ksn3V0"
AD_SPEND_MONTH_TAB = "Campain_Month"


def normalize_campaign_name(name: str) -> str:
    """
    Зводить назву кампанії до спільного вигляду для зіставлення таблиці маркетингу
    (де додані суфікси типу " 11.01" / " 19/06") з utm_campaign з Kommo.
    """
    import re
    name = re.sub(r"\s+\d[\d./-]*\s*$", "", name or "").strip()
    name = re.sub(r"_+", "_", name.replace(" ", "_"))
    return name.lower()


def get_ad_spend_by_campaign(days: int = 7) -> dict[str, dict]:
    """
    Оцінка витрат на рекламу по кампаніях за останні `days` днів.
    Джерело — таблиця маркетингу (вкладка Campain_Month), яка дає накопичений
    підсумок з початку поточного місяця по кампанії. Тижнева оцінка =
    місячний підсумок / кількість днів, що минули в місяці * days
    (припускаючи рівномірний денний темп витрат).

    Повертає {normalize_campaign_name(назва): {"monthly_cost": float, "estimated_period_cost": float}}.
    """
    import re

    sh = _get_external_sheet(AD_SPEND_SPREADSHEET_ID)
    if not sh:
        return {}
    try:
        ws = sh.worksheet(AD_SPEND_MONTH_TAB)
        values = ws.get_all_values()
    except Exception as e:
        logger.error("get_ad_spend_by_campaign: %s", e)
        return {}

    now = datetime.now(timezone.utc)
    month_label = now.strftime("%B %Y")
    days_elapsed = max(now.day, 1)

    spend: dict[str, dict] = {}
    i = 0
    while i < len(values):
        if values[i] and (values[i][0] or "").strip() == month_label:
            i += 2  # skip month header row + metric header row
            while i < len(values):
                row = values[i]
                name = (row[0] or "").strip()
                if not name or name == "TOTAL":
                    break
                cost_str = re.sub(r"\s+", "", row[1] if len(row) > 1 else "") or "0"
                try:
                    monthly_cost = float(cost_str)
                except ValueError:
                    monthly_cost = 0.0
                period_cost = round(monthly_cost / days_elapsed * days, 2)
                spend[normalize_campaign_name(name)] = {
                    "monthly_cost": monthly_cost,
                    "estimated_period_cost": period_cost,
                }
                i += 1
            break
        i += 1
    else:
        logger.warning("get_ad_spend_by_campaign: month block '%s' not found", month_label)

    return spend


def _get_or_create_worksheet(name: str, rows: int = 1000, cols: int = 20):
    sh = _get_sheet()
    if not sh:
        return None
    try:
        return sh.worksheet(name)
    except Exception:
        return sh.add_worksheet(title=name, rows=rows, cols=cols)


# ── Плани менеджерів/команд з таблиці ─────────────────────────────────
# Щоб не хардкодити плани в коді щомісяця: бот читає їх з двох аркушів
# основної таблиці. Редагуєш таблицю — бот підхоплює сам (раз на день
# о 06:00 Київ, на старті сервісу, або одразу через GET /refresh-plans).
PLANS_MANAGER_WS = "Плани менеджерів"   # A: user_id | B: Менеджер | C: Команда | D: План
PLANS_TEAM_WS = "Плани команд"          # A: Команда | B: План


def _parse_amount(raw: str) -> int:
    digits = re.sub(r"[^\d]", "", raw or "")
    return int(digits) if digits else 0


def read_plans() -> tuple[dict[int, int], dict[int, str], dict[str, int]] | None:
    """Читає плани з аркушів. Повертає (manager_plans, manager_team,
    team_plans) або None, якщо таблиця недоступна чи аркуша ще немає
    (тоді лишаються значення, зашиті в коді)."""
    sh = _get_sheet()
    if not sh:
        return None
    try:
        ws = sh.worksheet(PLANS_MANAGER_WS)
    except Exception:
        return None  # аркуш ще не створено (див. /seed-plans-sheet)
    manager_plans: dict[int, int] = {}
    manager_team: dict[int, str] = {}
    try:
        for row in ws.get_all_values()[1:]:
            try:
                uid = int((row[0] or "").strip())
            except (ValueError, IndexError):
                continue  # порожній рядок / людина без акаунта в Kommo
            manager_plans[uid] = _parse_amount(row[3] if len(row) > 3 else "")
            if len(row) > 2 and row[2].strip():
                manager_team[uid] = row[2].strip()
    except Exception as e:
        logger.error("read_plans (менеджери): %s", e)
        return None
    team_plans: dict[str, int] = {}
    try:
        ws2 = sh.worksheet(PLANS_TEAM_WS)
        for row in ws2.get_all_values()[1:]:
            if row and row[0].strip():
                team_plans[row[0].strip()] = _parse_amount(row[1] if len(row) > 1 else "")
    except Exception as e:
        logger.error("read_plans (команди): %s", e)
    return manager_plans, manager_team, team_plans


def seed_plans(manager_rows: list[list], team_rows: list[list]) -> bool:
    """Одноразово створює аркуші планів і заповнює поточними значеннями
    з коду (далі таблицю веде людина, код більше не перезаписує)."""
    ws = _get_or_create_worksheet(PLANS_MANAGER_WS, rows=100, cols=6)
    ws2 = _get_or_create_worksheet(PLANS_TEAM_WS, rows=30, cols=4)
    if not ws or not ws2:
        return False
    try:
        ws.clear()
        ws.update([["user_id", "Менеджер", "Команда", "План (грн)"]] + manager_rows,
                  value_input_option="RAW")
        ws2.clear()
        ws2.update([["Команда", "План (грн)"]] + team_rows, value_input_option="RAW")
        return True
    except Exception as e:
        logger.error("seed_plans: %s", e)
        return False


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


FIRST_TOUCH_SHEET = "Перший дотик"


def append_first_touch(lead_id: int, manager: str, team: str, price_voiced: bool,
                       at: datetime, objections: bool = False,
                       about_transport: bool = True, has_transcript: bool = True) -> None:
    """Один проаналізований перший дотик = один рядок аркуша «Перший дотик».
    Персистентне джерело для звіту (щоб не сканувати Kommo API)."""
    ws = _get_or_create_worksheet(FIRST_TOUCH_SHEET, rows=5000, cols=8)
    if not ws:
        return
    try:
        if ws.cell(1, 1).value != "Дата":
            ws.insert_row([
                "Дата", "Час", "Менеджер", "Команда", "Lead ID",
                "Ціну озвучено", "Заперечення відпрацьовано", "Розмова про перевезення",
            ], 1)
        ws.append_row([
            at.strftime("%Y-%m-%d"),
            at.strftime("%H:%M:%S"),
            manager,
            team,
            lead_id,
            "так" if price_voiced else "ні",
            "так" if objections else "ні",
            "так" if about_transport else ("немає запису" if not has_transcript else "ні"),
        ])
        logger.info("sheets: appended first-touch lead %s (team %s, price=%s)", lead_id, team, price_voiced)
    except Exception as e:
        logger.error("sheets append_first_touch: %s", e)


def read_first_touch(days: int = 7) -> dict | None:
    """Агрегує аркуш «Перший дотик» за останні `days` днів (включно з сьогодні).
    Повертає {days, total, priced, by_team:{team:{acc,price}}} або None, якщо
    аркуш недоступний. Жодних запитів до Kommo — лише читання таблиці."""
    from datetime import datetime, timezone, timedelta
    ws = _get_or_create_worksheet(FIRST_TOUCH_SHEET, rows=5000, cols=8)
    if not ws:
        return None
    try:
        cutoff = (datetime.now(timezone.utc).date() - timedelta(days=days - 1)).isoformat()
        records = ws.get_all_records()
        total = 0
        priced = 0
        by_team: dict[str, dict[str, int]] = {}
        for r in records:
            d = str(r.get("Дата", "")).strip()
            if not d or d < cutoff:
                continue
            team = str(r.get("Команда", "") or "—")
            pv = str(r.get("Ціну озвучено", "")).strip().lower() in ("так", "1", "true", "✅", "yes")
            total += 1
            priced += 1 if pv else 0
            t = by_team.setdefault(team, {"acc": 0, "price": 0})
            t["acc"] += 1
            t["price"] += 1 if pv else 0
        return {"days": days, "total": total, "priced": priced, "by_team": by_team}
    except Exception as e:
        logger.error("sheets read_first_touch: %s", e)
        return None


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
    headers = [
        "Дата", "ID угоди", "Назва", "Менеджер",
        "Причина відмови", "Закрито з етапу", "Днів в роботі",
        "Дзвінків", "Нотаток", "Сума (грн)", "Вердикт AI",
        "Категорія причини", "Рекомендація AI",
        "Коментар тімліда", "Статус розбору"
    ]
    try:
        if ws.cell(1, 1).value != "Дата":
            ws.insert_row(headers, 1)
        elif ws.row_values(1) != headers:
            # Старий формат заголовків (до додавання колонок "Вердикт AI"/"Категорія
            # причини") — без цього дані з'їжджають на 2 колонки і AI-текст потрапляє
            # під заголовок "Статус розбору" замість "Рекомендація AI".
            ws.update("A1:O1", [headers])
        row_values = [
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
        ]

        # Якщо запис для цього lead_id вже існує (повторний webhook/тест) — оновлюємо
        # його замість додавання дубліката, зберігаючи коментар/статус тімліда.
        existing_row = None
        try:
            cell = ws.find(str(deal.get("lead_id", "")))
            if cell:
                existing_row = cell.row
        except Exception:
            existing_row = None

        if existing_row:
            ws.update(f"A{existing_row}:M{existing_row}", [row_values[:13]])
            target_row = existing_row
        else:
            ws.insert_row(row_values, 2)
            target_row = 2

        if deal.get("verdict") == "ПЕРЕДЧАСНЕ":
            ws.format(f"A{target_row}:O{target_row}", {"backgroundColor": {"red": 0.96, "green": 0.78, "blue": 0.78}})
        else:
            ws.format(f"A{target_row}:O{target_row}", {"backgroundColor": {"red": 1, "green": 1, "blue": 1}})
        logger.info("sheets: logged closed deal %s -> %s (row %s)", deal.get("lead_id"), sheet_name, target_row)
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
