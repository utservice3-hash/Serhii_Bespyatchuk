import os
import json
import logging
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

SPREADSHEET_ID = os.getenv("SPREADSHEET_ID", "")
SERVICE_ACCOUNT_JSON = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON", "")

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


def append_transfer(lead_id: int, lead_name: str, manager: str, transferred_at: datetime):
    ws = _get_or_create_worksheet("Реєстр")
    if not ws:
        return
    try:
        ws.append_row([
            lead_id,
            lead_name,
            manager,
            transferred_at.strftime("%Y-%m-%d %H:%M:%S"),
            "",   # taken_at (filled later)
            "",   # first_call_at
            "",   # reaction_min
            "",   # call_min
        ])
        logger.info("sheets: appended transfer for lead %s", lead_id)
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
            transferred_val = ws.cell(row, 4).value
            if transferred_val:
                transferred_at = datetime.strptime(transferred_val, "%Y-%m-%d %H:%M:%S")
                transferred_at = transferred_at.replace(tzinfo=timezone.utc)
                delta = (taken_at - transferred_at).total_seconds() / 60
                ws.update_cell(row, 5, taken_at.strftime("%Y-%m-%d %H:%M:%S"))
                ws.update_cell(row, 7, round(delta, 1))
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
            transferred_val = ws.cell(row, 4).value
            if transferred_val:
                transferred_at = datetime.strptime(transferred_val, "%Y-%m-%d %H:%M:%S")
                transferred_at = transferred_at.replace(tzinfo=timezone.utc)
                delta = (call_at - transferred_at).total_seconds() / 60
                ws.update_cell(row, 6, call_at.strftime("%Y-%m-%d %H:%M:%S"))
                ws.update_cell(row, 8, round(delta, 1))
    except Exception as e:
        logger.error("sheets update_first_call: %s", e)
