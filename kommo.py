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
