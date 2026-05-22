"""
Крок 0: знайти ID кастомного поля «Исходный ответственный».
Запустити один раз: python find_field_id.py
Записати знайдений ID у config.py → FIELD_ID_RESPONSIBLE.
"""
import requests
from config import KOMMO_TOKEN, BASE_URL


def main():
    if not KOMMO_TOKEN:
        print("Помилка: змінна KOMMO_TOKEN не встановлена у .env")
        return

    headers = {'Authorization': f'Bearer {KOMMO_TOKEN}'}
    r = requests.get(f'{BASE_URL}/leads/custom_fields', headers=headers)
    r.raise_for_status()

    fields = r.json().get('_embedded', {}).get('custom_fields', [])
    print(f"Знайдено {len(fields)} кастомних полів угод:\n")

    for f in fields:
        name = f.get('name', '')
        if 'ответственный' in name.lower() or 'відповідальн' in name.lower():
            print(f"  >>> ЗНАЙДЕНО: id={f['id']}  name='{name}'")
        else:
            print(f"  id={f['id']}  name='{name}'")

    print("\nЗапишіть ID потрібного поля у config.py → FIELD_ID_RESPONSIBLE")


if __name__ == '__main__':
    main()
