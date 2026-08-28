#!/usr/bin/env python3
"""Inspect the two accounts before committing to a full run.

    python src/discover.py pipelines   # Kommo pipeline ids + names, won-deal counts
    python src/discover.py ringostat   # dump one raw call row + field mapping

The Ringostat dump matters: the public docs are not reachable from every
network, so ``FIELD_CANDIDATES`` in ringostat_client.py is a best guess.  This
command shows which keys the API actually returns and which ones the mapper
picked, so you can correct it in one place if anything is off.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from config import Config, load_dotenv
from kommo_client import KommoClient, WON_STATUS_ID
from ringostat_client import FIELD_CANDIDATES, RingostatClient, _extract_rows, _pick


def show_pipelines(cfg: Config) -> None:
    client = KommoClient(cfg.kommo_subdomain, cfg.kommo_token)
    unix_from, unix_to = cfg.window_unix()
    print(f"Won deals between {cfg.window()[0]} and {cfg.window()[1]}\n")
    print(f"{'id':<10} {'name':<34} {'won in window':>13}")
    print("-" * 60)
    total = 0
    for pipeline in client.pipelines():
        leads = client.won_leads(unix_from, unix_to, [pipeline["id"]])
        total += len(leads)
        print(f"{pipeline['id']:<10} {pipeline.get('name','')[:33]:<34} {len(leads):>13}")
    print("-" * 60)
    print(f"{'TOTAL':<45} {total:>13}")
    print("\nPut the lead-gen pipeline id(s) into KOMMO_PIPELINE_IDS.")


def show_ringostat(cfg: Config) -> None:
    client = RingostatClient(cfg.ringostat_key, cfg.ringostat_base)
    date_from, date_to = cfg.window()
    body = client.raw_page(date_from, date_to, limit=3)
    rows = _extract_rows(body)
    if not rows:
        print("No rows returned. Raw payload:")
        print(json.dumps(body, ensure_ascii=False, indent=2)[:2000])
        return

    sample = rows[0]
    print("Keys the API returned:")
    print("  " + ", ".join(sorted(sample)))
    print("\nHow the mapper resolved them:")
    for logical in FIELD_CANDIDATES:
        value = _pick(sample, logical)
        matched = next((k for k in FIELD_CANDIDATES[logical] if k in sample), None)
        status = f"{matched}" if matched else "NOT FOUND - add the right key"
        print(f"  {logical:<12} <- {status:<24} value={value!r}")
    print("\nFull first row:")
    print(json.dumps(sample, ensure_ascii=False, indent=2)[:2000])


def main() -> int:
    load_dotenv()
    cfg = Config.from_env()
    what = sys.argv[1] if len(sys.argv) > 1 else ""
    if what == "pipelines":
        show_pipelines(cfg)
    elif what == "ringostat":
        show_ringostat(cfg)
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
