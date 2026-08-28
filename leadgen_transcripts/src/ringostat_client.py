"""Ringostat call-log client: fetch the call journal and download recordings.

The Ringostat documentation is not reachable from this sandbox, so the response
parser is deliberately tolerant: for every logical field we try a list of
candidate key names and take the first that is present.  ``FIELD_CANDIDATES``
is the single place to adjust once you have seen a real response - run
``python src/discover.py ringostat`` to dump one.
"""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any, Iterator

import requests

from phones import digits, is_internal, match_key, to_e164_ua

log = logging.getLogger(__name__)

DEFAULT_BASE = "https://api.ringostat.net"
PAGE_LIMIT = 1000

# logical name -> candidate keys in the API response, in priority order
FIELD_CANDIDATES: dict[str, tuple[str, ...]] = {
    "id":         ("id", "call_id", "uniqueid", "unique_id"),
    "date":       ("calldate", "call_date", "date", "datetime", "start_time"),
    "caller":     ("caller", "caller_number", "from", "src", "source_number"),
    "callee":     ("destination", "callee", "to", "dst", "destination_number"),
    "direction":  ("call_type", "direction", "type"),
    "duration":   ("billsec", "talk_time", "duration", "call_duration"),
    "recording":  ("recording", "record", "record_url", "recording_url",
                   "call_record", "audio"),
    "employee":   ("employee", "manager", "operator", "user_name",
                   "employee_name", "substitution"),
    "disposition": ("disposition", "status", "call_status"),
}

INBOUND_HINTS = ("in", "incoming", "inbound", "input")
OUTBOUND_HINTS = ("out", "outgoing", "outbound", "output")


@dataclass
class Call:
    id: str
    date: str
    caller: str
    callee: str
    direction: str          # "in" | "out" | "unknown"
    duration: int           # talk seconds
    recording_url: str
    employee: str
    raw: dict

    @property
    def client_number(self) -> str:
        """The external party - the client, whichever leg they were on."""
        if self.direction == "out":
            return self.callee
        if self.direction == "in":
            return self.caller
        # Unknown direction: the external-looking number is the client.
        for candidate in (self.caller, self.callee):
            if candidate and not is_internal(candidate):
                return candidate
        return self.caller or self.callee

    @property
    def match_key(self) -> str:
        return match_key(self.client_number)


class RingostatError(RuntimeError):
    pass


def _pick(raw: dict, logical: str) -> Any:
    for key in FIELD_CANDIDATES[logical]:
        if key in raw and raw[key] not in (None, ""):
            return raw[key]
    return None


def _normalise_direction(value: Any) -> str:
    text = str(value or "").strip().lower()
    if any(h in text for h in INBOUND_HINTS):
        return "in"
    if any(h in text for h in OUTBOUND_HINTS):
        return "out"
    return "unknown"


def _as_int(value: Any) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return 0


def _extract_rows(body: Any) -> list[dict]:
    """Find the list of call dicts regardless of how the payload wraps it."""
    if isinstance(body, list):
        return [r for r in body if isinstance(r, dict)]
    if not isinstance(body, dict):
        return []
    for key in ("data", "calls", "items", "results", "report", "rows"):
        value = body.get(key)
        if isinstance(value, list):
            return [r for r in value if isinstance(r, dict)]
        if isinstance(value, dict):
            nested = _extract_rows(value)
            if nested:
                return nested
    return []


class RingostatClient:
    def __init__(self, auth_key: str, base_url: str = DEFAULT_BASE,
                 timeout: int = 60, rate_limit_per_sec: float = 2.0):
        if not auth_key:
            raise RingostatError("RINGOSTAT_AUTH_KEY is required")
        self.base = base_url.rstrip("/")
        self.auth_key = auth_key
        self.timeout = timeout
        self._min_interval = 1.0 / rate_limit_per_sec if rate_limit_per_sec else 0.0
        self._last_call = 0.0
        self.session = requests.Session()
        self.session.headers.update({
            "Auth-key": auth_key,
            "Accept": "application/json",
            "User-Agent": "leadgen-transcripts/1.0",
        })

    def _throttle(self) -> None:
        wait = self._min_interval - (time.monotonic() - self._last_call)
        if wait > 0:
            time.sleep(wait)
        self._last_call = time.monotonic()

    def _get(self, path: str, params: dict[str, Any]) -> Any:
        url = f"{self.base}{path}"
        for attempt in range(5):
            self._throttle()
            resp = self.session.get(url, params=params, timeout=self.timeout)
            if resp.status_code == 429 or resp.status_code >= 500:
                backoff = 2 ** attempt
                log.warning("Ringostat %s on %s, retrying in %ss",
                            resp.status_code, path, backoff)
                time.sleep(backoff)
                continue
            if resp.status_code in (401, 403):
                raise RingostatError(
                    "Ringostat rejected the key (%s). Check RINGOSTAT_AUTH_KEY."
                    % resp.status_code)
            if not resp.ok:
                raise RingostatError(
                    f"Ringostat {resp.status_code} on {path}: {resp.text[:400]}")
            return resp.json()
        raise RingostatError(f"Ringostat kept failing on {path} after 5 attempts")

    def raw_page(self, date_from: date, date_to: date, limit: int = 5,
                 offset: int = 0) -> Any:
        """One unparsed page - used by ``discover.py`` to inspect the schema."""
        return self._get("/calls/list", {
            "from": date_from.isoformat(),
            "to": date_to.isoformat(),
            "limit": limit,
            "offset": offset,
        })

    def iter_calls(self, date_from: date, date_to: date) -> Iterator[Call]:
        """Stream the whole call journal for the window, page by page."""
        offset = 0
        while True:
            body = self._get("/calls/list", {
                "from": date_from.isoformat(),
                "to": date_to.isoformat(),
                "limit": PAGE_LIMIT,
                "offset": offset,
            })
            rows = _extract_rows(body)
            if not rows:
                return
            for raw in rows:
                yield Call(
                    id=str(_pick(raw, "id") or f"{offset}-{id(raw)}"),
                    date=str(_pick(raw, "date") or ""),
                    caller=to_e164_ua(_pick(raw, "caller")) or str(_pick(raw, "caller") or ""),
                    callee=to_e164_ua(_pick(raw, "callee")) or str(_pick(raw, "callee") or ""),
                    direction=_normalise_direction(_pick(raw, "direction")),
                    duration=_as_int(_pick(raw, "duration")),
                    recording_url=str(_pick(raw, "recording") or ""),
                    employee=str(_pick(raw, "employee") or ""),
                    raw=raw,
                )
            if len(rows) < PAGE_LIMIT:
                return
            offset += PAGE_LIMIT

    def download_recording(self, call: Call, dest: Path) -> Path | None:
        """Download one recording. Returns the path, or None if unavailable."""
        if not call.recording_url:
            return None
        if dest.exists() and dest.stat().st_size > 0:
            return dest                                  # resume: already fetched
        dest.parent.mkdir(parents=True, exist_ok=True)
        url = call.recording_url
        if url.startswith("/"):
            url = f"{self.base}{url}"
        for attempt in range(4):
            try:
                self._throttle()
                with self.session.get(url, timeout=self.timeout, stream=True) as resp:
                    if resp.status_code == 404:
                        log.warning("recording gone for call %s", call.id)
                        return None
                    resp.raise_for_status()
                    tmp = dest.with_suffix(dest.suffix + ".part")
                    with open(tmp, "wb") as fh:
                        for chunk in resp.iter_content(65536):
                            fh.write(chunk)
                    os.replace(tmp, dest)
                return dest
            except requests.RequestException as exc:
                log.warning("download failed for %s (%s), attempt %d",
                            call.id, exc, attempt + 1)
                time.sleep(2 ** attempt)
        return None


def index_by_phone(calls: Iterator[Call], wanted: set[str],
                   per_number: int, min_duration: int) -> dict[str, list[Call]]:
    """Group calls by client phone key, keeping the ``per_number`` most recent.

    Only keys present in ``wanted`` are retained, so the whole journal is
    scanned once and irrelevant traffic is dropped as it streams past.
    """
    buckets: dict[str, list[Call]] = {}
    scanned = 0
    for call in calls:
        scanned += 1
        key = call.match_key
        if not key or key not in wanted:
            continue
        if call.duration < min_duration:
            continue          # unanswered / hung up before anyone spoke
        if not call.recording_url:
            continue
        buckets.setdefault(key, []).append(call)

    for key, items in buckets.items():
        items.sort(key=lambda c: c.date, reverse=True)
        buckets[key] = items[:per_number]

    kept = sum(len(v) for v in buckets.values())
    log.info("Ringostat: scanned %d calls, matched %d numbers, kept %d recordings",
             scanned, len(buckets), kept)
    return buckets
