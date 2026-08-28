#!/usr/bin/env python3
"""End-to-end pipeline: Kommo won leads -> Ringostat calls -> role-tagged text.

    python src/run_pipeline.py                 # full run
    python src/run_pipeline.py --dry-run       # stages 1-2 only, no audio
    python src/run_pipeline.py --limit 5       # smoke-test on five calls

Every transcript is cached under ``OUT_DIR/cache``; re-running skips work that
already succeeded, so an interrupted run resumes instead of starting over.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from config import Config, load_dotenv
from export import (CallRecord, write_csv, write_summary, write_transcript_file,
                    write_xlsx)
from kommo_client import KommoClient, attach_phones
from ringostat_client import Call, RingostatClient, index_by_phone
from transcribe import Transcript, Segment, WhisperEngine, transcribe_call

log = logging.getLogger("pipeline")


def _ts(unix: int) -> str:
    if not unix:
        return ""
    return datetime.fromtimestamp(unix, tz=timezone.utc).strftime("%Y-%m-%d %H:%M")


def _cache_path(root: Path, call: Call) -> Path:
    return root / "cache" / f"{call.id}.json"


def _load_cached(path: Path) -> Transcript | None:
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return Transcript(
            segments=[Segment(**s) for s in data["segments"]],
            language=data.get("language", ""),
            role_confidence=data.get("role_confidence", ""),
            note=data.get("note", ""),
        )
    except Exception as exc:
        log.warning("ignoring corrupt cache %s (%s)", path.name, exc)
        return None


def _save_cached(path: Path, transcript: Transcript) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(transcript.to_dict(), ensure_ascii=False),
                    encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true",
                        help="fetch deals and match calls, but do not download "
                             "or transcribe audio")
    parser.add_argument("--limit", type=int, default=0,
                        help="transcribe at most N calls (smoke test)")
    parser.add_argument("--download-workers", type=int, default=4)
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S")

    load_dotenv()
    cfg = Config.from_env()
    missing = cfg.missing()
    if missing:
        log.error("Missing required settings: %s", ", ".join(missing))
        log.error("Copy .env.example to .env, fill it in, then re-run.")
        return 2

    date_from, date_to = cfg.window()
    unix_from, unix_to = cfg.window_unix()
    log.info("window: %s .. %s", date_from, date_to)

    # -- stage 1: won lead-gen deals from Kommo ------------------------------
    kommo = KommoClient(cfg.kommo_subdomain, cfg.kommo_token)
    try:
        users = kommo.users()
    except Exception as exc:
        log.warning("could not load users (%s) - manager column will be blank", exc)
        users = {}

    manager_ids, manager_names = cfg.split_managers()
    if manager_names:
        manager_ids += kommo.resolve_managers(manager_names)
    if manager_ids:
        log.info("lead-gen managers: %s",
                 ", ".join(f"{users.get(i, '?')} ({i})" for i in manager_ids))
    else:
        log.warning("KOMMO_MANAGERS is empty - taking won deals from ALL "
                    "managers. Set it to restrict the export to lead-gen.")

    leads = kommo.won_leads(unix_from, unix_to, cfg.kommo_pipeline_ids, manager_ids)
    if not leads:
        log.error("No won deals found. Check KOMMO_MANAGERS, "
                  "KOMMO_PIPELINE_IDS and the date window.")
        return 1
    attach_phones(kommo, leads)

    # phone key -> the most recently closed deal carrying that number
    lead_by_key: dict[str, object] = {}
    for lead in sorted(leads, key=lambda l: l.closed_at):
        for key in lead.match_keys:
            lead_by_key[key] = lead
    wanted = set(lead_by_key)
    log.info("stage 1: %d won deals, %d distinct phone numbers",
             len(leads), len(wanted))
    if len(leads) < 200:
        log.warning("only %d won deals in the window - the brief expects 200+. "
                    "Widen MONTHS_BACK or re-check KOMMO_MANAGERS.", len(leads))

    # -- stage 2: matching calls from Ringostat ------------------------------
    ringostat = RingostatClient(cfg.ringostat_key, cfg.ringostat_base)
    buckets = index_by_phone(ringostat.iter_calls(date_from, date_to),
                             wanted, cfg.calls_per_deal, cfg.min_call_seconds)
    jobs: list[tuple[object, Call]] = [
        (lead_by_key[key], call) for key, calls in buckets.items() for call in calls]
    log.info("stage 2: %d calls with recordings across %d deals",
             len(jobs), len({id(l) for l, _ in jobs}))

    stats = {
        "window": [str(date_from), str(date_to)],
        "managers": [users.get(i, str(i)) for i in manager_ids],
        "deals_won": len(leads),
        "deals_with_phone": sum(1 for l in leads if l.phones),
        "phone_numbers": len(wanted),
        "numbers_matched_in_ringostat": len(buckets),
        "calls_selected": len(jobs),
    }

    if args.dry_run:
        log.info("dry run - stopping before audio. %s", json.dumps(stats, ensure_ascii=False))
        cfg.out_dir.mkdir(parents=True, exist_ok=True)
        (cfg.out_dir / "dry_run.json").write_text(
            json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")
        return 0

    if args.limit:
        jobs = jobs[:args.limit]
        log.info("--limit: transcribing only %d calls", len(jobs))

    # -- stage 3: download ---------------------------------------------------
    audio_dir = cfg.out_dir / "audio"
    def _fetch(job):
        lead, call = job
        suffix = Path(call.recording_url.split("?")[0]).suffix or ".mp3"
        return job, ringostat.download_recording(call, audio_dir / f"{call.id}{suffix}")

    downloaded: list[tuple[tuple, Path]] = []
    with ThreadPoolExecutor(max_workers=args.download_workers) as pool:
        for job, path in pool.map(_fetch, jobs):
            if path:
                downloaded.append((job, path))
            else:
                log.warning("no audio for call %s", job[1].id)
    log.info("stage 3: %d/%d recordings downloaded", len(downloaded), len(jobs))

    # -- stage 4: transcribe -------------------------------------------------
    engine = None
    work = cfg.out_dir / "work"
    records: list[CallRecord] = []
    for i, ((lead, call), audio) in enumerate(downloaded, start=1):
        cache = _cache_path(cfg.out_dir, call)
        transcript = _load_cached(cache)
        if transcript is None:
            if engine is None:      # load the model only if there is work to do
                engine = WhisperEngine(cfg.whisper_model, cfg.whisper_device,
                                       language=cfg.whisper_language)
            log.info("[%d/%d] transcribing call %s (%ss)",
                     i, len(downloaded), call.id, call.duration)
            try:
                transcript = transcribe_call(audio, engine, call.direction, work,
                                             cfg.channel_role_mode, cfg.hf_token)
            except Exception as exc:
                log.error("transcription failed for %s: %s", call.id, exc)
                continue
            _save_cached(cache, transcript)
        else:
            log.debug("[%d/%d] cache hit for %s", i, len(downloaded), call.id)

        rec = CallRecord(
            deal_id=lead.id,
            deal_name=lead.name,
            deal_closed_at=_ts(lead.closed_at),
            manager=users.get(lead.responsible_user_id, ""),
            phone=call.client_number,
            call_date=call.date,
            direction=call.direction,
            duration_sec=call.duration,
            recording_url=call.recording_url,
            transcript=transcript,
        )
        write_transcript_file(rec, cfg.out_dir)
        records.append(rec)

    # -- stage 5: deliverables ----------------------------------------------
    records.sort(key=lambda r: (r.deal_id, r.call_date))
    write_csv(records, cfg.out_dir)
    write_xlsx(records, cfg.out_dir)
    summary = write_summary(records, cfg.out_dir, stats)
    log.info("done: %s", summary.read_text(encoding="utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
