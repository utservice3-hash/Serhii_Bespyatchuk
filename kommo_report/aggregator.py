import datetime
from collections import defaultdict
from config import FIELD_ID_RESPONSIBLE


def _get_responsible(lead: dict) -> str:
    for cf in lead.get('custom_fields_values') or []:
        if cf['field_id'] == FIELD_ID_RESPONSIBLE:
            vals = cf.get('values') or []
            if vals:
                return vals[0].get('value', 'Не вказано')
    return 'Не вказано'


def _get_budget(lead: dict) -> int:
    return lead.get('price') or 0


def _fmt_date(ts) -> str:
    if not ts:
        return '—'
    try:
        return datetime.datetime.fromtimestamp(int(ts)).strftime('%d.%m.%Y')
    except Exception:
        return '—'


def aggregate(leads: list) -> list:
    """
    Повертає список кортежів (manager_name, stats), відсортованих за total (спадання).
    stats = {'count': int, 'total': int, 'deals': list[dict]}
    """
    agg = defaultdict(lambda: {'count': 0, 'total': 0, 'deals': []})

    for lead in leads:
        manager = _get_responsible(lead)
        budget = _get_budget(lead)
        agg[manager]['count'] += 1
        agg[manager]['total'] += budget
        agg[manager]['deals'].append({
            'id': lead['id'],
            'name': lead.get('name', ''),
            'budget': budget,
            'closed_at': _fmt_date(lead.get('closed_at')),
        })

    return sorted(agg.items(), key=lambda x: x[1]['total'], reverse=True)
