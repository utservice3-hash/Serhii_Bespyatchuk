import requests
import csv
import time

TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIsImp0aSI6IjUzYjhhZjg4MmQ4MjA2YThkNzg3Yjk5NGM0MWNhZmQzNzAwYjU2MTcwY2RiZjM0ZjQyODQ4ZDYyMTkyMmQ2NGEzNzIzZGI2Mzg2YmM3MWJhIn0.eyJhdWQiOiJjZTcwMWRmMC01NGQzLTQ5MzAtOWU0OS0yOWYwMmEyYTNhYmUiLCJqdGkiOiI1M2I4YWY4ODJkODIwNmE4ZDc4N2I5OTRjNDFjYWZkMzcwMGI1NjE3MGNkYmYzNGY0Mjg0OGQ2MjE5MjJkNjRhMzcyM2RiNjM4NmJjNzFiYSIsImlhdCI6MTc3OTgxMDYwMCwibmJmIjoxNzc5ODEwNjAwLCJleHAiOjE4NTEyOTI4MDAsInN1YiI6IjkwNDkyMyIsImdyYW50X3R5cGUiOiIiLCJhY2NvdW50X2lkIjoxMDg0Nzc5MSwiYmFzZV9kb21haW4iOiJrb21tby5jb20iLCJ2ZXJzaW9uIjoyLCJzY29wZXMiOlsicHVzaF9ub3RpZmljYXRpb25zIiwiZmlsZXMiLCJjcm0iLCJmaWxlc19kZWxldGUiLCJub3RpZmljYXRpb25zIl0sImhhc2hfdXVpZCI6IjIzODQxODNlLTFkMTctNGU1Yy04OWQ3LWE2NGRiM2ExZGM4OCIsImFwaV9kb21haW4iOiJhcGktZy5rb21tby5jb20ifQ.mtWsJqfTmXolBGiHQyuBIKkksGWOYsNZvgpvsJEW5C-wsLMHKjnQFcI_jX7iECeIuEPwXrc-VX7eIBTls6D94blbfnbj_DzTCed-PW4VgJsIHsqkMFKoM1ElgY3kYNbjKdDtyQ3CcX-8o-5aZxXyAz7ZEXe-laoDxIq2HpuCE8AeDRrteGwFHigMPOsMXjbJtrPttfvycdSZdNhkeaNuvbJPnJvNjQb5RUuoDALPMV2wlW3dHj6R48cTwKEZ9-6XrjvmDdHQ5lHa2vYTRqG6-mb5c6Cp6UKj0TFY4zfzx4jTLP5c89RxxgZ5_vFl6_rFIU8XCx7KFqati9Phx9QgpA"

BASE_URL = "https://api-g.kommo.com/api/v4"
HEADERS = {"Authorization": f"Bearer {TOKEN}"}


def fetch_all(endpoint, params=None):
    items = []
    page = 1
    if params is None:
        params = {}
    while True:
        params["page"] = page
        params["limit"] = 250
        resp = requests.get(f"{BASE_URL}/{endpoint}", headers=HEADERS, params=params)
        if resp.status_code == 204 or resp.status_code == 404:
            break
        if resp.status_code != 200:
            print(f"Помилка {resp.status_code}: {resp.text}")
            break
        data = resp.json()
        embedded = data.get("_embedded", {})
        key = list(embedded.keys())[0] if embedded else None
        if not key:
            break
        batch = embedded[key]
        items.extend(batch)
        print(f"  Отримано {len(items)} записів...")
        if len(batch) < 250:
            break
        page += 1
        time.sleep(0.3)
    return items


def get_custom_field_value(fields, field_name):
    for f in fields:
        if f.get("field_name", "").lower() == field_name.lower():
            vals = f.get("values", [])
            if vals:
                return vals[0].get("value", "")
    return ""


def export_contacts():
    print("Вивантаження контактів...")
    contacts = fetch_all("contacts", {"with": "custom_fields_values,companies"})
    print(f"Всього контактів: {len(contacts)}")

    with open("contacts_export.csv", "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.writer(f)
        writer.writerow(["ID", "Ім'я", "Телефон", "Email", "Компанія", "Відповідальний", "Дата створення"])
        for c in contacts:
            name = c.get("name", "")
            cid = c.get("id", "")
            responsible = c.get("responsible_user_id", "")
            created = c.get("created_at", "")
            import datetime
            if created:
                created = datetime.datetime.fromtimestamp(created).strftime("%Y-%m-%d %H:%M")

            custom = c.get("custom_fields_values") or []
            phone = get_custom_field_value(custom, "Телефон")
            if not phone:
                phone = get_custom_field_value(custom, "Phone")
            email = get_custom_field_value(custom, "Email")

            companies = c.get("_embedded", {}).get("companies", [])
            company_name = companies[0].get("name", "") if companies else ""

            writer.writerow([cid, name, phone, email, company_name, responsible, created])

    print("Збережено: contacts_export.csv")


def export_companies():
    print("Вивантаження компаній...")
    companies = fetch_all("companies", {"with": "custom_fields_values"})
    print(f"Всього компаній: {len(companies)}")

    with open("companies_export.csv", "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.writer(f)
        writer.writerow(["ID", "Назва компанії", "Телефон", "Email", "Відповідальний", "Дата створення"])
        for c in companies:
            cid = c.get("id", "")
            name = c.get("name", "")
            responsible = c.get("responsible_user_id", "")
            created = c.get("created_at", "")
            import datetime
            if created:
                created = datetime.datetime.fromtimestamp(created).strftime("%Y-%m-%d %H:%M")

            custom = c.get("custom_fields_values") or []
            phone = get_custom_field_value(custom, "Телефон")
            if not phone:
                phone = get_custom_field_value(custom, "Phone")
            email = get_custom_field_value(custom, "Email")

            writer.writerow([cid, name, phone, email, responsible, created])

    print("Збережено: companies_export.csv")


if __name__ == "__main__":
    export_contacts()
    print()
    export_companies()
    print("\nГотово! Файли збережено в поточній папці.")
