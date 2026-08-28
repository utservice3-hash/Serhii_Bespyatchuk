"""Minimal Kommo (amoCRM v4) client: won leads + their contact phone numbers."""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any, Iterator

import requests

from phones import match_key, to_e164_ua

log = logging.getLogger(__name__)

WON_STATUS_ID = 142      # system status "Closed - won", present in every pipeline
LOST_STATUS_ID = 143     # system status "Closed - lost"
PAGE_LIMIT = 250         # API maximum
CONTACT_BATCH = 50       # ids per contacts request


@dataclass
class Lead:
    id: int
    name: str
    price: int
    pipeline_id: int
    status_id: int
    responsible_user_id: int
    created_at: int
    closed_at: int
    contact_ids: list[int] = field(default_factory=list)
    phones: list[str] = field(default_factory=list)

    @property
    def match_keys(self) -> list[str]:
        seen: list[str] = []
        for p in self.phones:
            k = match_key(p)
            if k and k not in seen:
                seen.append(k)
        return seen


class KommoError(RuntimeError):
    pass


class KommoClient:
    """Thin wrapper over the Kommo REST API.

    Authentication uses a long-lived access token
    (Kommo UI: Settings -> Integrations -> your integration -> long-lived token).
    """

    def __init__(self, subdomain: str, access_token: str,
                 timeout: int = 30, rate_limit_per_sec: float = 5.0):
        if not subdomain or not access_token:
            raise KommoError("KOMMO_SUBDOMAIN and KOMMO_ACCESS_TOKEN are required")
        host = subdomain if "." in subdomain else f"{subdomain}.kommo.com"
        self.base = f"https://{host}"
        self.timeout = timeout
        self._min_interval = 1.0 / rate_limit_per_sec if rate_limit_per_sec else 0.0
        self._last_call = 0.0
        self.session = requests.Session()
        self.session.headers.update({
            "Authorization": f"Bearer {access_token}",
            "Accept": "application/json",
            "User-Agent": "leadgen-transcripts/1.0",
        })

    # ---------------------------------------------------------------- transport

    def _throttle(self) -> None:
        # Kommo caps requests per second per account; stay comfortably under it.
        wait = self._min_interval - (time.monotonic() - self._last_call)
        if wait > 0:
            time.sleep(wait)
        self._last_call = time.monotonic()

    def _get(self, path: str, params: dict[str, Any] | None = None) -> dict | None:
        url = f"{self.base}{path}"
        for attempt in range(5):
            self._throttle()
            resp = self.session.get(url, params=params, timeout=self.timeout)
            if resp.status_code == 204:
                return None                      # Kommo's "no results"
            if resp.status_code == 429 or resp.status_code >= 500:
                backoff = 2 ** attempt
                log.warning("Kommo %s on %s, retrying in %ss", resp.status_code, path, backoff)
                time.sleep(backoff)
                continue
            if resp.status_code == 401:
                raise KommoError("Kommo rejected the token (401). Check KOMMO_ACCESS_TOKEN.")
            if not resp.ok:
                raise KommoError(f"Kommo {resp.status_code} on {path}: {resp.text[:400]}")
            return resp.json()
        raise KommoError(f"Kommo kept failing on {path} after 5 attempts")

    def _paginate(self, path: str, params: dict[str, Any], entity: str) -> Iterator[dict]:
        page = 1
        while True:
            body = self._get(path, {**params, "page": page, "limit": PAGE_LIMIT})
            if not body:
                return
            items = body.get("_embedded", {}).get(entity, [])
            if not items:
                return
            yield from items
            if "next" not in body.get("_links", {}):
                return
            page += 1

    # ------------------------------------------------------------------ queries

    def won_leads(self, closed_from: int, closed_to: int,
                  pipeline_ids: list[int] | None = None,
                  responsible_user_ids: list[int] | None = None) -> list[Lead]:
        """Leads that reached "Closed - won" with ``closed_at`` inside the window.

        Optionally narrowed to given pipelines and/or responsible managers -
        which is how lead-gen deals are identified when they share a pipeline
        with everything else.

        Filters are sent server-side and then re-checked client-side, because
        accounts differ in which filter combinations the API honours; the
        client-side pass guarantees the result set regardless.
        """
        params: dict[str, Any] = {
            "with": "contacts",
            "filter[closed_at][from]": closed_from,
            "filter[closed_at][to]": closed_to,
        }
        if pipeline_ids:
            for i, pid in enumerate(pipeline_ids):
                params[f"filter[statuses][{i}][pipeline_id]"] = pid
                params[f"filter[statuses][{i}][status_id]"] = WON_STATUS_ID
        else:
            params["filter[statuses][0][status_id]"] = WON_STATUS_ID
        for i, uid in enumerate(responsible_user_ids or []):
            params[f"filter[responsible_user_id][{i}]"] = uid

        wanted = set(pipeline_ids or [])
        managers = set(responsible_user_ids or [])
        leads: list[Lead] = []
        for raw in self._paginate("/api/v4/leads", params, "leads"):
            if raw.get("status_id") != WON_STATUS_ID:
                continue
            if wanted and raw.get("pipeline_id") not in wanted:
                continue
            if managers and raw.get("responsible_user_id") not in managers:
                continue
            contacts = raw.get("_embedded", {}).get("contacts", [])
            leads.append(Lead(
                id=raw["id"],
                name=raw.get("name") or "",
                price=raw.get("price") or 0,
                pipeline_id=raw.get("pipeline_id") or 0,
                status_id=raw.get("status_id") or 0,
                responsible_user_id=raw.get("responsible_user_id") or 0,
                created_at=raw.get("created_at") or 0,
                closed_at=raw.get("closed_at") or 0,
                contact_ids=[c["id"] for c in contacts if c.get("id")],
            ))
        log.info("Kommo: %d won leads in window", len(leads))
        return leads

    def resolve_managers(self, names: list[str]) -> list[int]:
        """Turn manager names from config into user ids.

        Matching is case-insensitive and substring-based so "Олег" finds
        "Олег Коваленко". Ambiguous or unknown names raise rather than
        silently narrowing the export to the wrong people.
        """
        if not names:
            return []
        users = self.users()
        resolved: list[int] = []
        for name in names:
            needle = name.strip().casefold()
            hits = [uid for uid, full in users.items()
                    if needle in full.casefold()]
            if not hits:
                raise KommoError(
                    f"No Kommo user matches {name!r}. "
                    "Run `python src/discover.py users` to see the list.")
            if len(hits) > 1:
                options = ", ".join(f"{users[h]} (id={h})" for h in hits)
                raise KommoError(
                    f"{name!r} matches several users: {options}. "
                    "Use the exact name or the numeric id in KOMMO_MANAGERS.")
            resolved.append(hits[0])
        log.info("Kommo: lead-gen managers resolved to ids %s", resolved)
        return resolved

    def contact_phones(self, contact_ids: list[int]) -> dict[int, list[str]]:
        """Map contact id -> phone numbers, read from the PHONE custom field."""
        out: dict[int, list[str]] = {}
        unique = sorted({c for c in contact_ids if c})
        for start in range(0, len(unique), CONTACT_BATCH):
            batch = unique[start:start + CONTACT_BATCH]
            params: dict[str, Any] = {}
            for i, cid in enumerate(batch):
                params[f"filter[id][{i}]"] = cid
            for raw in self._paginate("/api/v4/contacts", params, "contacts"):
                out[raw["id"]] = _phones_from_custom_fields(raw)
        return out

    def users(self) -> dict[int, str]:
        """Map responsible_user_id -> display name, for the manager column."""
        out: dict[int, str] = {}
        for raw in self._paginate("/api/v4/users", {}, "users"):
            out[raw["id"]] = raw.get("name") or raw.get("email") or str(raw["id"])
        return out

    def pipelines(self) -> list[dict]:
        """All pipelines with their ids and names - used by ``discover.py``."""
        body = self._get("/api/v4/leads/pipelines")
        if not body:
            return []
        return body.get("_embedded", {}).get("pipelines", [])


def _phones_from_custom_fields(entity: dict) -> list[str]:
    phones: list[str] = []
    for cf in entity.get("custom_fields_values") or []:
        if cf.get("field_code") != "PHONE":
            continue
        for value in cf.get("values") or []:
            normalised = to_e164_ua(value.get("value"))
            if normalised and normalised not in phones:
                phones.append(normalised)
    return phones


def attach_phones(client: KommoClient, leads: list[Lead]) -> list[Lead]:
    """Populate ``lead.phones`` for every lead, in one batched pass."""
    all_ids = [cid for lead in leads for cid in lead.contact_ids]
    phone_map = client.contact_phones(all_ids)
    for lead in leads:
        seen: list[str] = []
        for cid in lead.contact_ids:
            for p in phone_map.get(cid, []):
                if p not in seen:
                    seen.append(p)
        lead.phones = seen
    with_phone = sum(1 for l in leads if l.phones)
    log.info("Kommo: %d/%d leads have at least one phone", with_phone, len(leads))
    return leads
