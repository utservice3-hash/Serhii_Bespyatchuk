import calendar
import datetime
import os
import sys

from aggregator import aggregate
from html_builder import build_html
from kommo_api import fetch_leads
from config import OUTPUT_FILE, FIELD_ID_RESPONSIBLE


def main():
    if not FIELD_ID_RESPONSIBLE:
        print(
            "Помилка: FIELD_ID_RESPONSIBLE = None у config.py.\n"
            "Запустіть  python find_field_id.py  та запишіть ID поля."
        )
        sys.exit(1)

    today = datetime.date.today()
    first_day = datetime.date(today.year, today.month, 1)
    last_day = datetime.date(today.year, today.month, calendar.monthrange(today.year, today.month)[1])

    start_ts = int(datetime.datetime.combine(first_day, datetime.time.min).timestamp())
    end_ts = int(datetime.datetime.combine(last_day, datetime.time.max).timestamp())

    month_label = today.strftime('%B %Y')

    print(f"Вивантаження угод за {month_label}...")
    leads = fetch_leads(start_ts, end_ts)
    print(f"Отримано угод: {len(leads)}")

    rating = aggregate(leads)

    total_deals = sum(s['count'] for _, s in rating)
    total_budget = sum(s['total'] for _, s in rating)
    print(f"\nKPI:")
    print(f"  Менеджерів: {len(rating)}")
    print(f"  Угод: {total_deals}")
    print(f"  Сума: {total_budget:,.0f} ₴")
    print()

    for rank, (manager, stats) in enumerate(rating, start=1):
        pct = stats['total'] / total_budget * 100 if total_budget else 0
        print(f"  {rank:2}. {manager:<30} {stats['count']:3} угод  {stats['total']:>12,.0f} ₴  ({pct:.1f}%)")

    html = build_html(rating, month_label)

    output_path = os.path.join(os.path.dirname(__file__), OUTPUT_FILE)
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(html)

    print(f"\nЗвіт збережено: {output_path}")


if __name__ == '__main__':
    main()
