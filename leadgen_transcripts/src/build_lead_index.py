#!/usr/bin/env python3
"""Turn the lead-gen report spreadsheets into data/leadgen_deals.csv.

    python src/build_lead_index.py exports/*.txt

Each input is a Google Drive connector export of one report
(``{"fileContent": "..."}``).  The output is the authoritative mapping of
Kommo deal id -> lead-gen -> report date, which the pipeline uses as its deal
universe.  Re-run it whenever the reports gain a new month.
"""

from __future__ import annotations

import csv
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from leadgen_sheets import merge, parse_export_file

OUT = Path(__file__).resolve().parent.parent / "data" / "leadgen_deals.csv"


def main(paths: list[str]) -> int:
    if not paths:
        print(__doc__)
        return 2

    batches = []
    for raw in paths:
        path = Path(raw)
        deals = parse_export_file(path)
        title = json.loads(path.read_text(encoding="utf-8")).get("title", path.stem)
        print(f"{path.name}: {len(deals)} deals ({title})")
        batches.append(deals)

    deals = merge(batches)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "w", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(["lead_id", "lead_gen", "report_date", "source"])
        for deal in deals:
            writer.writerow([deal.lead_id, deal.lead_gen, deal.report_date,
                             deal.source])

    counts = Counter(d.lead_gen for d in deals)
    dates = [d.report_date for d in deals if d.report_date]
    print(f"\n{len(deals)} distinct deals, {len(counts)} lead-gens, "
          f"{min(dates)} .. {max(dates)}")
    print(f"written to {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
