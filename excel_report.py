import io
import logging
from datetime import datetime, timezone

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter

logger = logging.getLogger(__name__)

HEADER_FILL = PatternFill(start_color="2F5597", end_color="2F5597", fill_type="solid")
HEADER_FONT = Font(color="FFFFFF", bold=True)


def _style_header(ws, row: int = 1):
    for cell in ws[row]:
        cell.fill = HEADER_FILL
        cell.font = HEADER_FONT
        cell.alignment = Alignment(horizontal="center", vertical="center")


def _autosize(ws):
    for col_cells in ws.columns:
        length = max((len(str(c.value)) for c in col_cells if c.value is not None), default=8)
        ws.column_dimensions[get_column_letter(col_cells[0].column)].width = min(length + 2, 45)


def _fmt_ts(ts) -> str:
    if not ts:
        return ""
    try:
        return datetime.fromtimestamp(int(ts), tz=timezone.utc).strftime("%Y-%m-%d %H:%M")
    except Exception:
        return ""


def build_ad_report_excel(report: dict, days: int) -> bytes:
    """
    Будує xlsx із двома листами:
    - "Зведення по кампаніях" — агреговані метрики по кожній рекламній кампанії
    - "Деталізація угод" — повний список угод, що прийшли з реклами за період
    """
    wb = Workbook()

    summary_ws = wb.active
    summary_ws.title = "Зведення по кампаніях"
    summary_headers = [
        "Кампанія", "Всього угод", "Успіх", "Закрито не реалізовано",
        "В роботі", "Конверсія %",
    ]
    summary_ws.append(summary_headers)
    _style_header(summary_ws)

    campaigns = report.get("campaigns", {})
    for name, c in sorted(campaigns.items(), key=lambda x: x[1]["total"], reverse=True):
        summary_ws.append([
            name, c["total"], c["won"], c["lost"], c["in_progress"], c["conversion"],
        ])
    summary_ws.freeze_panes = "A2"
    _autosize(summary_ws)

    detail_ws = wb.create_sheet("Деталізація угод")
    detail_headers = [
        "ID угоди", "Назва угоди", "Кампанія", "Менеджер", "Статус",
        "Сума (грн)", "Дата створення", "Дата закриття",
    ]
    detail_ws.append(detail_headers)
    _style_header(detail_ws)

    for lead in report.get("leads", []):
        detail_ws.append([
            lead["lead_id"], lead["name"], lead["campaign"], lead["manager_name"],
            lead["status_label"], lead["amount"],
            _fmt_ts(lead["created_at"]), _fmt_ts(lead["closed_at"]),
        ])
    detail_ws.freeze_panes = "A2"
    detail_ws.auto_filter.ref = detail_ws.dimensions
    _autosize(detail_ws)

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf.read()
