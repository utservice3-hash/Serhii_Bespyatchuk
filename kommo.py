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
    Count leads received from lidogen per manager for the last N days.
    Uses events API to find status changes to NEW_FROM_LIDOGEN.
    Returns {responsible_user_id: count}
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
                    "filter[type]": "lead_status_changed",
                    "filter[created_at][from]": since,
                    "limit": 250,
                    "page": page,
                },
                timeout=15,
            )
            if not resp.ok:
                break
            events = resp.json().get("_embedded", {}).get("events", [])
            if not events:
                break

            for e in events:
                after = e.get("value_after", [{}])
                if isinstance(after, list):
                    after = after[0] if after else {}
                if after.get("lead_status", {}).get("id") == NEW_FROM_LIDOGEN:
                    uid = e.get("created_by") or e.get("entity", {}).get("responsible_user_id")
                    if uid:
                        counts[int(uid)] = counts.get(int(uid), 0) + 1

            if len(events) < 250:
                break
            page += 1
            if page > 10:
                break
    except Exception as ex:
        logger.error("get_lidogen_stats: %s", ex)

    return counts
