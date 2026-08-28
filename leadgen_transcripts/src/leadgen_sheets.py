"""Parse the daily lead-gen report spreadsheets into a list of Kommo deals.

These sheets are the business's own definition of "a lead-gen deal": each
report is owned by a team lead, every column is one lead-gen, every row group
is a date, and every cell holds a direct Kommo deal link.  Reading them gives
an exact deal-id universe attributed to a named lead-gen - far more precise
than inferring lead-gen work from a CRM filter.

Layout (as exported to markdown by the Drive connector)::

    | Сердюк Ярослав | Шевчук Мирослава |     <- header: column -> lead-gen
    | [merged] 06.02.2026 | [merged] ...  |    <- date row, repeated per column
    | .../leads/detail/61512525 | .../61768893 |  <- one deal per cell

A sheet restates the header whenever a new month block begins, so the column
mapping is re-read as it changes rather than assumed once.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

LEAD_URL = re.compile(r"kommo\.com/leads/detail/(\d+)")
DATE_CELL = re.compile(r"(\d{2})\.(\d{2})\.(\d{4})")
PERSON = re.compile(r"^[А-ЯІЇЄҐA-Z][а-яіїєґa-z'’]+(?:\s+[А-ЯІЇЄҐA-Z][а-яіїєґa-z'’]+)+$")
SUBDOMAIN = re.compile(r"https://([a-z0-9-]+)\.kommo\.com")


@dataclass(frozen=True)
class SheetDeal:
    lead_id: int
    lead_gen: str
    report_date: str      # ISO date the deal was logged under
    source: str           # which report file it came from


def _cells(line: str) -> list[str]:
    if not line.startswith("|"):
        return []
    return [c.strip() for c in line.strip().strip("|").split("|")]


def _is_separator(cells: list[str]) -> bool:
    return bool(cells) and all(set(c) <= {":", "-", " "} and c for c in cells)


def parse_sheet(text: str, source: str = "") -> list[SheetDeal]:
    """Extract every (deal, lead-gen, date) triple from one exported sheet."""
    columns: dict[int, str] = {}
    current_date = ""
    deals: dict[int, SheetDeal] = {}

    for line in text.split("\n"):
        cells = _cells(line)
        if not cells or _is_separator(cells):
            continue

        # A row of person names redefines the column -> lead-gen mapping.
        names = {i: c for i, c in enumerate(cells) if PERSON.match(c)}
        if names and not LEAD_URL.search(line):
            columns = names
            continue

        # A date row sets the date for the deals that follow.
        if not LEAD_URL.search(line):
            found = DATE_CELL.search(line)
            if found:
                day, month, year = found.groups()
                current_date = f"{year}-{month}-{day}"
            continue

        for i, cell in enumerate(cells):
            hit = LEAD_URL.search(cell)
            if not hit:
                continue
            lead_id = int(hit.group(1))
            # Keep the first attribution seen; a deal repeated later in the
            # report is the same deal, not a second one.
            deals.setdefault(lead_id, SheetDeal(
                lead_id=lead_id,
                lead_gen=columns.get(i, "(unattributed)"),
                report_date=current_date,
                source=source,
            ))
    return list(deals.values())


def parse_export_file(path: Path) -> list[SheetDeal]:
    """Parse a Drive connector export saved as ``{"fileContent": "..."}``."""
    payload = json.loads(path.read_text(encoding="utf-8"))
    return parse_sheet(payload["fileContent"], source=path.stem)


def detect_subdomain(text: str) -> str | None:
    found = SUBDOMAIN.findall(text)
    return found[0] if found else None


def merge(batches: list[list[SheetDeal]]) -> list[SheetDeal]:
    """Combine several reports, keeping one record per deal id."""
    out: dict[int, SheetDeal] = {}
    for batch in batches:
        for deal in batch:
            existing = out.get(deal.lead_id)
            # Prefer an attributed record over an unattributed duplicate.
            if existing is None or (existing.lead_gen == "(unattributed)"
                                    and deal.lead_gen != "(unattributed)"):
                out[deal.lead_id] = deal
    return sorted(out.values(), key=lambda d: d.lead_id)
