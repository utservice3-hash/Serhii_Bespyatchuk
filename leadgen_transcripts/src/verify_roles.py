#!/usr/bin/env python3
"""Confirm which stereo channel carries the manager - run this once, first.

    python src/verify_roles.py path/to/one_recording.mp3 --direction out

Transcribes each channel separately and prints them side by side, unlabelled.
Read the opening lines: the side that answers with the company greeting is the
manager.  If that is not the side the tool predicted, pin the mapping with
CHANNEL_ROLE_MODE=ch0_manager or ch0_client in .env.

Getting this right once is what makes every transcript's roles trustworthy.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from config import Config, load_dotenv
from transcribe import (WhisperEngine, channel_count, roles_for_channels,
                        split_channels)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("audio", type=Path)
    parser.add_argument("--direction", default="out", choices=["in", "out", "unknown"],
                        help="direction of this call, as Ringostat reports it")
    args = parser.parse_args()

    load_dotenv()
    cfg = Config.from_env()

    channels = channel_count(args.audio)
    print(f"file:     {args.audio}")
    print(f"channels: {channels}")
    if channels < 2:
        print("\nThis recording is MONO - channel splitting cannot separate the "
              "speakers.\nCheck whether Ringostat can be set to record in stereo; "
              "otherwise the pipeline\nfalls back to diarisation, which is less "
              "reliable.")
        return 1

    work = cfg.out_dir / "work"
    left, right = split_channels(args.audio, work)
    engine = WhisperEngine(cfg.whisper_model, cfg.whisper_device,
                           language=cfg.whisper_language)

    predicted = roles_for_channels(args.direction, cfg.channel_role_mode)
    for path, label, guess in ((left, "CHANNEL 0", predicted[0]),
                               (right, "CHANNEL 1", predicted[1])):
        segments, lang = engine.transcribe(path)
        print(f"\n===== {label}  (tool predicts: {guess}, lang={lang}) =====")
        for seg in segments[:8]:
            print(f"  [{int(seg.start)//60:02d}:{int(seg.start)%60:02d}] {seg.text.strip()}")
        if not segments:
            print("  (silence)")
        path.unlink(missing_ok=True)

    print("\nDoes the prediction match what you just read?")
    print("  yes -> leave CHANNEL_ROLE_MODE=auto")
    print("  no  -> set CHANNEL_ROLE_MODE=ch0_manager or ch0_client in .env")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
