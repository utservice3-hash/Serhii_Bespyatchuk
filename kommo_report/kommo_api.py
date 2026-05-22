import requests
from config import KOMMO_TOKEN, BASE_URL, PIPELINE_ID, STATUS_ID


def get_headers() -> dict:
    if not KOMMO_TOKEN:
        raise ValueError("KOMMO_TOKEN не встановлено. Перевірте .env файл.")
    return {'Authorization': f'Bearer {KOMMO_TOKEN}'}


def fetch_leads(start_ts: int, end_ts: int) -> list:
    """Вивантажує всі закриті угоди зі статусом STATUS_ID за вказаний діапазон дат."""
    headers = get_headers()
    all_leads = []
    page = 1

    while True:
        params = {
            'filter[pipeline_id]': PIPELINE_ID,
            'filter[statuses][0][pipeline_id]': PIPELINE_ID,
            'filter[statuses][0][status_id]': STATUS_ID,
            'filter[closed_at][from]': start_ts,
            'filter[closed_at][to]': end_ts,
            'with': 'contacts,loss_reason',
            'limit': 250,
            'page': page,
        }

        r = requests.get(f'{BASE_URL}/leads', headers=headers, params=params, timeout=30)
        r.raise_for_status()

        data = r.json()
        batch = data.get('_embedded', {}).get('leads', [])
        if not batch:
            break

        all_leads.extend(batch)
        page += 1

    return all_leads
