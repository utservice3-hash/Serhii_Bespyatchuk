import os
import time
import requests
import logging

logger = logging.getLogger(__name__)

KOMMO_TOKEN = os.getenv("KOMMO_TOKEN", "")
KOMMO_BASE = os.getenv("KOMMO_BASE", "https://utsercice.kommo.com")

HEADERS = {"Authorization": f"Bearer {KOMMO_TOKEN}"}

_user_cache: dict[int, str] = {}


def get_webhooks() -> list[dict]:
    try:
        resp = requests.get(f"{KOMMO_BASE}/api/v4/webhooks", headers=HEADERS, timeout=10)
        if resp.ok:
            return resp.json().get("_embedded", {}).get("webhooks", [])
    except Exception as e:
        logger.error("get_webhooks exception: %s", e)
    return []


def reenable_webhook(destination: str, settings: list[str]) -> bool:
    """Kommo has no PATCH for webhooks — Kommo auto-disables a webhook after repeated
    delivery failures, and the only way to clear that flag is to delete and recreate
    the subscription."""
    try:
        requests.delete(
            f"{KOMMO_BASE}/api/v4/webhooks", headers=HEADERS,
            json={"destination": destination}, timeout=10,
        )
        resp = requests.post(
            f"{KOMMO_BASE}/api/v4/webhooks", headers=HEADERS,
            json={"destination": destination, "settings": settings}, timeout=10,
        )
        return resp.status_code == 201
    except Exception as e:
        logger.error("reenable_webhook exception: %s", e)
        return False


def get_user_name(user_id: int) -> str:
    if user_id in _user_cache:
        return _user_cache[user_id]
    try:
        resp = requests.get(
            f"{KOMMO_BASE}/api/v4/users/{user_id}",
            headers=HEADERS,
            timeout=10,
        )
        if resp.ok:
            data = resp.json()
            name = data.get("name") or data.get("login", f"ID {user_id}")
            _user_cache[user_id] = name
            return name
    except Exception as e:
        logger.error("get_user_name(%s): %s", user_id, e)
    return f"ID {user_id}"


SOURCE_FIELD_ID = 2098035    # "Источник клиента"
REJECT_REASON_FIELD_ID = 2097265  # "Причина отказа"
# Угода вважається "по таргету", якщо заповнене будь-яке з цих полів —
# різні рекламні канали пишуть кампанію в різні поля (Facebook -> utm_campaign,
# Google Ads -> ADV_CAMP/TRAF_SRC).
AD_CAMPAIGN_FIELD_IDS = (
    481997,   # utm_campaign
    2098331,  # ADV_CAMP
    2098327,  # TRAF_SRC
)

# Назви етапів воронки Перевозки
PEREVOZY_STATUSES = {
    69693664: "Incoming leads",
    69693668: "Взято на прорахунок",
    69693672: "Пропозицію зроблено",
    69716252: "Відкладений запит",
    69693676: "Умови узгоджені",
    69716256: "Документи підписані",
    69716260: "Контроль перед завантаженням",
    100274340: "Виставлення рахунку",
    69716300: "Авто працює",
    98470988: "Перевезення завершено",
    69716304: "Дзвінок після розвантаження",
    69716312: "Очікуємо оплату",
    69716460: "Оплата отримана",
    142: "Успішна угода",
    143: "Закрито і не реалізовано",
}


def get_lead(lead_id: int) -> dict | None:
    try:
        resp = requests.get(
            f"{KOMMO_BASE}/api/v4/leads/{lead_id}",
            headers=HEADERS,
            params={"with": "custom_fields"},
            timeout=10,
        )
        if resp.ok:
            return resp.json()
    except Exception as e:
        logger.error("get_lead(%s): %s", lead_id, e)
    return None


def get_lead_details(lead_id: int) -> dict:
    """
    Returns enriched lead info for closed-not-realized notification:
    name, created_at, reject_reason, last_status_name, notes_count, calls_count
    """
    from datetime import datetime, timezone

    result = {
        "name": f"Угода #{lead_id}",
        "days_in_work": None,
        "reject_reason": "",
        "last_status": "",
        "notes_count": 0,
        "calls_count": 0,
    }

    # Lead basic info + custom fields
    try:
        resp = requests.get(
            f"{KOMMO_BASE}/api/v4/leads/{lead_id}",
            headers=HEADERS,
            params={"with": "custom_fields"},
            timeout=10,
        )
        if resp.ok:
            lead = resp.json()
            result["name"] = lead.get("name", result["name"])
            created_at = lead.get("created_at", 0)
            if created_at:
                days = (datetime.now(timezone.utc).timestamp() - created_at) / 86400
                result["days_in_work"] = int(days)
            old_status_id = lead.get("status_id", 0)
            result["last_status"] = PEREVOZY_STATUSES.get(old_status_id, "")

            for cf in lead.get("custom_fields_values") or []:
                if cf.get("field_id") == REJECT_REASON_FIELD_ID:
                    vals = cf.get("values") or []
                    if vals:
                        result["reject_reason"] = vals[0].get("value", "")
    except Exception as e:
        logger.error("get_lead_details lead: %s", e)

    # Notes + calls count
    try:
        resp = requests.get(
            f"{KOMMO_BASE}/api/v4/leads/{lead_id}/notes",
            headers=HEADERS,
            params={"limit": 100},
            timeout=10,
        )
        if resp.ok:
            notes = resp.json().get("_embedded", {}).get("notes", [])
            calls = [n for n in notes if n.get("note_type") in (10, 11, "call_in", "call_out")]
            result["notes_count"] = len(notes)
            result["calls_count"] = len(calls)
    except Exception as e:
        logger.error("get_lead_details notes: %s", e)

    return result


MINUS_DEAL_FIELD_ID = 2098529   # "Мінусова угода" — значення "Мінус"
FICTIVE_KEYWORD = "ФІКТИВНИЙ"


def is_minus_deal(lead: dict) -> bool:
    """Повертає True якщо угода мінусова (поле 2098529 = 'Мінус' або назва містить МІНУС)."""
    name = (lead.get("name") or "").upper()
    if FICTIVE_KEYWORD in name:
        return False  # фіктивні — окрема логіка, не мінус
    for cf in lead.get("custom_fields_values") or []:
        if cf.get("field_id") == MINUS_DEAL_FIELD_ID:
            vals = cf.get("values") or []
            if vals and str(vals[0].get("value", "")).strip():
                return True
    return "МІНУС" in name


def is_fictive_deal(lead: dict) -> bool:
    """Повертає True якщо угода фіктивна."""
    return FICTIVE_KEYWORD in (lead.get("name") or "").upper()


def has_utm_campaign(lead: dict) -> bool:
    """Перевіряє, чи угода прийшла по таргету (заповнене одне з полів рекламної кампанії)."""
    for cf in lead.get("custom_fields_values") or []:
        if cf.get("field_id") in AD_CAMPAIGN_FIELD_IDS:
            vals = cf.get("values") or []
            if vals and str(vals[0].get("value", "")).strip():
                return True
    return False


def get_lead_source(lead: dict) -> str:
    """Extract 'Источник клиента' value from lead custom fields."""
    for cf in lead.get("custom_fields_values") or []:
        if cf.get("field_id") == SOURCE_FIELD_ID:
            values = cf.get("values") or []
            if values:
                return values[0].get("value", "")
    return ""


def get_lead_events(lead_id: int, limit: int = 50) -> list:
    try:
        resp = requests.get(
            f"{KOMMO_BASE}/api/v4/events",
            headers=HEADERS,
            params={
                "filter[entity][0][id]": lead_id,
                "filter[entity][0][type]": "lead",
                "limit": limit,
            },
            timeout=10,
        )
        if resp.ok:
            data = resp.json()
            return data.get("_embedded", {}).get("events", [])
    except Exception as e:
        logger.error("get_lead_events(%s): %s", lead_id, e)
    return []


def get_lead_notes(lead_id: int) -> list:
    try:
        resp = requests.get(
            f"{KOMMO_BASE}/api/v4/leads/{lead_id}/notes",
            headers=HEADERS,
            params={"limit": 50},
            timeout=10,
        )
        if resp.ok:
            data = resp.json()
            return data.get("_embedded", {}).get("notes", [])
    except Exception as e:
        logger.error("get_lead_notes(%s): %s", lead_id, e)
    return []


def update_lead_status(lead_id: int, status_id: int) -> bool:
    """Переводить лід на вказаний етап (в межах тієї ж воронки)."""
    try:
        resp = requests.patch(
            f"{KOMMO_BASE}/api/v4/leads/{lead_id}",
            headers=HEADERS,
            json={"status_id": status_id},
            timeout=10,
        )
        return resp.ok
    except Exception as e:
        logger.error("update_lead_status(%s, %s): %s", lead_id, status_id, e)
        return False


def get_note(lead_id: int, note_id: int) -> dict:
    """Повертає конкретну нотатку ліда (для точного зіставлення з вебхуком)."""
    try:
        resp = requests.get(
            f"{KOMMO_BASE}/api/v4/leads/{lead_id}/notes/{note_id}",
            headers=HEADERS,
            timeout=10,
        )
        if resp.ok:
            return resp.json()
    except Exception as e:
        logger.error("get_note(%s, %s): %s", lead_id, note_id, e)
    return {}


def get_latest_call_note(lead_id: int) -> dict:
    """Повертає параметри останньої дзвінкової нотатки ліда: duration, link, phone."""
    notes = get_lead_notes(lead_id)
    calls = [n for n in notes if n.get("note_type") in (10, 11, "call_in", "call_out")]
    if not calls:
        return {}
    latest = max(calls, key=lambda n: n.get("created_at", 0))
    params = latest.get("params") or {}
    return {
        "duration": int(params.get("duration", 0) or 0),
        "link": params.get("link", "") or params.get("LINK", ""),
        "phone": params.get("phone", "") or params.get("PHONE", ""),
        "created_at": latest.get("created_at", 0),
    }


def get_pipeline_leads(pipeline_id: int, status_id: int | None = None, page: int = 1, with_custom_fields: bool = False, closed_at_from: int | None = None) -> list:
    params: dict = {"limit": 250, "page": page}
    if status_id:
        params["filter[statuses][0][pipeline_id]"] = pipeline_id
        params["filter[statuses][0][status_id]"] = status_id
    else:
        params["filter[pipeline_id]"] = pipeline_id
    if with_custom_fields:
        params["with"] = "custom_fields"
    if closed_at_from:
        params["filter[closed_at][from]"] = closed_at_from
    try:
        resp = requests.get(
            f"{KOMMO_BASE}/api/v4/leads",
            headers=HEADERS,
            params=params,
            timeout=15,
        )
        if resp.ok:
            data = resp.json()
            return data.get("_embedded", {}).get("leads", [])
    except Exception as e:
        logger.error("get_pipeline_leads: %s", e)
    return []


WON_STATUS_ID = 142
CLOSED_NOT_REALIZED_STATUS_ID = 143
PEREVOZY_PIPELINE_ID = 8921932
QUAL_PIPELINE_ID = 8921928
NON_TARGET_STATUS_ID = 143  # "Не цільові" — те саме числове status_id, але в іншому pipeline


def get_manager_deal_stats(user_id: int, days: int) -> dict:
    """
    Особиста статистика менеджера за period: скільки лідів отримав від лідогена,
    скільки угод виграно/закрито-нереалізовано (Перевозки), і конверсія %.
    """
    from datetime import datetime, timezone, timedelta

    since = int((datetime.now(timezone.utc) - timedelta(days=days)).timestamp())

    def _count_status(status_id: int) -> int:
        total = 0
        page = 1
        while True:
            try:
                resp = requests.get(
                    f"{KOMMO_BASE}/api/v4/leads",
                    headers=HEADERS,
                    params={
                        "filter[statuses][0][pipeline_id]": PEREVOZY_PIPELINE_ID,
                        "filter[statuses][0][status_id]": status_id,
                        "filter[responsible_user_id][0]": user_id,
                        "filter[closed_at][from]": since,
                        "limit": 250,
                        "page": page,
                    },
                    timeout=15,
                )
                if not resp.ok:
                    break
                leads = resp.json().get("_embedded", {}).get("leads", [])
            except Exception as e:
                logger.error("get_manager_deal_stats(%s, status=%s): %s", user_id, status_id, e)
                break
            total += len(leads)
            if len(leads) < 250:
                break
            page += 1
        return total

    won = _count_status(WON_STATUS_ID)
    lost = _count_status(CLOSED_NOT_REALIZED_STATUS_ID)
    taken = get_lidogen_stats(days).get(user_id, 0)
    closed_total = won + lost
    conversion = round(won / closed_total * 100, 1) if closed_total else 0.0

    return {
        "taken": taken,
        "won": won,
        "lost": lost,
        "conversion": conversion,
    }


def get_campaign_name(lead: dict) -> str:
    """
    Назва рекламної кампанії ліда. Перевіряє поля-кандидати у фіксованому
    порядку пріоритету (utm_campaign -> ADV_CAMP -> TRAF_SRC), а не в тому
    порядку, в якому вони прийшли з Kommo API — інакше менш інформативне
    поле (наприклад TRAF_SRC з доменом-реферером типу "chatgpt.com") може
    випадково перекрити заповнений utm_campaign.
    """
    by_field_id = {
        cf.get("field_id"): cf
        for cf in (lead.get("custom_fields_values") or [])
    }
    for field_id in AD_CAMPAIGN_FIELD_IDS:
        cf = by_field_id.get(field_id)
        if not cf:
            continue
        vals = cf.get("values") or []
        if vals:
            value = str(vals[0].get("value", "")).strip()
            if value:
                return value
    return ""


def get_weekly_ad_campaign_report(days: int = 7) -> dict:
    """
    Зведення по угодах, що прийшли з реклами (заповнене поле кампанії) за
    останні `days` днів: скільки прийшло, скільки з них нецільові, по кожній
    кампанії — скільки угод, скільки виграно, закрито не реалізовано,
    нецільових, конверсія.

    status_id в Kommo унікальний лише в межах pipeline — те саме число 143
    означає "Закрито не реалізовано" в pipeline "Перевозки" і "Не цільові" в
    pipeline "Кваліфікація", тож класифікація статусу враховує pipeline_id.
    """
    from datetime import datetime, timezone, timedelta

    since = int((datetime.now(timezone.utc) - timedelta(days=days)).timestamp())
    until = int(datetime.now(timezone.utc).timestamp())

    leads = []
    page = 1
    while True:
        try:
            resp = requests.get(
                f"{KOMMO_BASE}/api/v4/leads",
                headers=HEADERS,
                params={
                    "filter[created_at][from]": since,
                    "filter[created_at][to]": until,
                    "with": "custom_fields",
                    "limit": 250,
                    "page": page,
                },
                timeout=15,
            )
            if not resp.ok:
                logger.error("get_weekly_ad_campaign_report: %s %s", resp.status_code, resp.text[:200])
                break
            batch = resp.json().get("_embedded", {}).get("leads", [])
        except Exception as e:
            logger.error("get_weekly_ad_campaign_report: %s", e)
            break
        leads.extend(batch)
        if len(batch) < 250:
            break
        page += 1
        if page > 40:
            break

    def _classify(pipeline_id, status_id):
        if pipeline_id == PEREVOZY_PIPELINE_ID and status_id == WON_STATUS_ID:
            return "won", "Успіх"
        if pipeline_id == PEREVOZY_PIPELINE_ID and status_id == CLOSED_NOT_REALIZED_STATUS_ID:
            return "lost", "Закрито не реалізовано"
        if pipeline_id == QUAL_PIPELINE_ID and status_id == NON_TARGET_STATUS_ID:
            return "non_target", "Не цільові"
        return "in_progress", "В роботі"

    campaigns: dict[str, dict] = {}
    leads_detail: list[dict] = []
    total = 0
    non_target_total = 0
    for lead in leads:
        campaign = get_campaign_name(lead)
        if not campaign:
            continue
        total += 1
        c = campaigns.setdefault(
            campaign, {"total": 0, "won": 0, "lost": 0, "non_target": 0, "in_progress": 0}
        )
        c["total"] += 1
        status_id = lead.get("status_id", 0)
        pipeline_id = lead.get("pipeline_id", 0)
        bucket, status_label = _classify(pipeline_id, status_id)
        c[bucket] += 1
        if bucket == "non_target":
            non_target_total += 1

        responsible_id = lead.get("responsible_user_id", 0)
        leads_detail.append({
            "lead_id": lead.get("id"),
            "name": lead.get("name") or "",
            "campaign": campaign,
            "manager_id": responsible_id,
            "manager_name": get_user_name(responsible_id) if responsible_id else "—",
            "status_id": status_id,
            "status_label": status_label,
            "amount": lead.get("price", 0) or 0,
            "created_at": lead.get("created_at", 0),
            "closed_at": lead.get("closed_at", 0),
        })

    for c in campaigns.values():
        closed = c["won"] + c["lost"]
        c["conversion"] = round(c["won"] / closed * 100, 1) if closed else 0.0

    return {
        "total": total,
        "non_target_total": non_target_total,
        "campaigns": campaigns,
        "leads": leads_detail,
    }


def get_lidogen_stats(days: int = 1) -> dict[int, int]:
    """
    Count leads transferred by lidogen per manager for the last N days.
    Logic: find lead_responsible_changed events where the lead was freshly created
    in QUAL_PIPELINE (i.e. created_at >= since), meaning lidogen created it and
    then changed the responsible to a real manager.
    Returns {new_responsible_user_id: count}
    """
    from datetime import datetime, timezone, timedelta
    QUAL_PIPELINE_ID = 8921928

    since = int((datetime.now(timezone.utc) - timedelta(days=days)).timestamp())
    counts: dict[int, int] = {}

    try:
        page = 1
        while True:
            resp = requests.get(
                f"{KOMMO_BASE}/api/v4/events",
                headers=HEADERS,
                params={
                    "filter[type][]": "lead_responsible_changed",
                    "filter[created_at][from]": since,
                    "limit": 100,
                    "page": page,
                },
                timeout=15,
            )
            if not resp.ok:
                logger.error("get_lidogen_stats events: %s %s", resp.status_code, resp.text[:200])
                break

            events = resp.json().get("_embedded", {}).get("events", [])
            if not events:
                break

            for event in events:
                if event.get("entity_type") != "lead":
                    continue
                lead_id = event.get("entity_id")
                if not lead_id:
                    continue

                lead = get_lead(lead_id)
                if not lead:
                    continue
                # Only count leads in qual pipeline that were created within the period
                # (i.e. freshly created by lidogen, not old leads being re-assigned)
                if lead.get("pipeline_id") != QUAL_PIPELINE_ID:
                    continue
                if lead.get("created_at", 0) < since:
                    continue

                # Extract new responsible from value_after
                value_after = event.get("value_after") or []
                for v in value_after:
                    uid = (v.get("responsible_user") or {}).get("id")
                    if uid:
                        counts[int(uid)] = counts.get(int(uid), 0) + 1
                        break

            if len(events) < 100:
                break
            page += 1
            if page > 20:
                break
    except Exception as ex:
        logger.error("get_lidogen_stats: %s", ex)

    return counts
