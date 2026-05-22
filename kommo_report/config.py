import os
from dotenv import load_dotenv

load_dotenv()

KOMMO_TOKEN = os.getenv('KOMMO_TOKEN')
BASE_URL = 'https://utsercice.kommo.com/api/v4'
PIPELINE_ID = 8921932
STATUS_ID = 142  # Успішно реалізовано
FIELD_ID_RESPONSIBLE = None  # <-- замінити після Кроку 0 (python find_field_id.py)
CRM_LINK = (
    'https://utsercice.kommo.com/leads/pipeline/8921932/'
    '?filter_date_switch=closed'
    '&filter[date_preset]=current_month'
    '&filter[pipe][8921932][0]=142&useFilter=y'
)
OUTPUT_FILE = 'report.html'
