"""Read data/leadgen_deals.csv - the deal universe built from the reports."""

from __future__ import annotations

import csv
import logging
from datetime import date
from pathlib import Path

log = logging.getLogger(__name__)


def load(path: Path, lead_gens: list[str] | None = None,
         report_from: date | None = None) -> dict[int, str]:
    """Return ``{lead_id: lead_gen}`` for the deals worth looking up.

    ``report_from`` prunes by the date the report logged the deal.  It is a
    coarse pre-filter that keeps the Kommo lookup small; whether a deal is
    actually won, and when it closed, is decided by Kommo itself afterwards.
    A deal quoted shortly before the window can still close inside it, so the
    pre-filter is deliberately looser than the final window.
    """
    if not path.exists():
        raise FileNotFoundError(
            f"{path} not found. Build it first:\n"
            "  python src/build_lead_index.py <drive-export>.txt ...")

    wanted = {g.strip().casefold() for g in (lead_gens or [])}
    out: dict[int, str] = {}
    skipped_gen = skipped_date = 0

    with open(path, encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            gen = row["lead_gen"]
            if wanted and gen.casefold() not in wanted:
                skipped_gen += 1
                continue
            if report_from and row["report_date"]:
                try:
                    if date.fromisoformat(row["report_date"]) < report_from:
                        skipped_date += 1
                        continue
                except ValueError:
                    pass
            out[int(row["lead_id"])] = gen

    log.info("lead index: %d candidate deals (%d dropped by lead-gen, "
             "%d by report date)", len(out), skipped_gen, skipped_date)
    return out


def lead_gens_in(path: Path) -> list[str]:
    with open(path, encoding="utf-8") as fh:
        return sorted({row["lead_gen"] for row in csv.DictReader(fh)})
