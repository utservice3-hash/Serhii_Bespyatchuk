import os
import time
import requests
import logging

logger = logging.getLogger(__name__)

KOMMO_TOKEN = os.getenv("KOMMO_TOKEN", "")
KOMMO_BASE = os.getenv("KOMMO_BASE", "https://utsercice.kommo.com")

HEADERS = {"Authorization": f"Bearer {KOMMO_TOKEN}"}

_user_cache: dict[int, str] = {}


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


def get_lead(lead_id: int) -> dict | None:
    try:
        resp = requests.get(
            f"{KOMMO_BASE}/api/v4/leads/{lead_id}",
            headers=HEADERS,
            timeout=10,
        )
        if resp.ok:
            return resp.json()
    except Exception as e:
        logger.error("get_lead(%s): %s", lead_id, e)
    return None


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


def get_pipeline_leads(pipeline_id: int, status_id: int | None = None, page: int = 1) -> list:
    params: dict = {"filter[pipeline_id]": pipeline_id, "limit": 250, "page": page}
    if status_id:
        params["filter[status_id]"] = status_id
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


def get_lidogen_stats(days: int = 1) -> dict[int, int]:
    """
    Count leads where lidogen changed responsible_user in NEW_FROM_LIDOGEN status
    for the last N days. Uses events API filtering lead_responsible_changed events.
    Returns {new_responsible_user_id: count}
    """
    from datetime import datetime, timezone, timedelta
    NEW_FROM_LIDOGEN = 69716164
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
                    "filter[type]": "lead_responsible_changed",
                    "filter[entity]": "lead",
                    "filter[created_at][from]": since,
                    "limit": 100,
                    "page": page,
                },
                timeout=15,
            )
            if not resp.ok:
                logger.error("get_lidogen_stats events API: %s %s", resp.status_code, resp.text[:200])
                break
            events = resp.json().get("_embedded", {}).get("events", [])
            if not events:
                break

            for event in events:
                entity = event.get("entity_type")
                if entity != "lead":
                    continue
                lead_id = event.get("entity_id")
                if not lead_id:
                    continue

                # Check if the lead is in QUAL_PIPELINE and NEW_FROM_LIDOGEN status
                lead = get_lead(lead_id)
                if not lead:
                    continue
                if lead.get("pipeline_id") != QUAL_PIPELINE_ID:
                    continue
                if lead.get("status_id") != NEW_FROM_LIDOGEN:
                    continue

                # new responsible is in value_after
                value_after = event.get("value_after", [])
                if isinstance(value_after, list):
                    for v in value_after:
                        uid = v.get("responsible_user", {}).get("id") if isinstance(v, dict) else None
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
