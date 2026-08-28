"""Speech-to-text with speaker roles (manager vs client).

Role separation strategy, in order of reliability:

1. **Stereo channel split (preferred).**  Ringostat mixes each call leg into its
   own channel, so the two speakers are already physically separated.  We split
   the file with ffmpeg, transcribe each channel independently, tag every
   segment with the role that channel belongs to, and merge by timestamp.  This
   is deterministic - no diarisation model, no guessing, no cross-talk errors.

2. **Diarisation (fallback, mono files).**  If a recording turns out to be
   single-channel we fall back to pyannote speaker diarisation and map the two
   resulting speakers onto roles heuristically.  Calls handled this way are
   flagged ``role_confidence=low`` in the index so they can be spot-checked.

Which channel is the manager depends on call direction: the recording's first
channel is the *caller's* leg, so on an outbound call that is the manager and on
an inbound call that is the client.  That convention is the ``auto`` mode and it
must be confirmed against a real recording once - run ``verify_roles.py``.  If
the spot-check shows your account records the legs the other way round, pin the
mapping with ``CHANNEL_ROLE_MODE=ch0_manager`` or ``ch0_client``.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
from dataclasses import dataclass, asdict
from pathlib import Path

log = logging.getLogger(__name__)

MANAGER = "Менеджер"
CLIENT = "Клієнт"
UNKNOWN = "Невідомо"


@dataclass
class Segment:
    start: float
    end: float
    role: str
    text: str

    def stamp(self) -> str:
        m, s = divmod(int(self.start), 60)
        return f"{m:02d}:{s:02d}"


@dataclass
class Transcript:
    segments: list[Segment]
    language: str
    role_confidence: str        # "high" (stereo split) | "low" (diarised/mono)
    note: str = ""

    def as_text(self) -> str:
        return "\n".join(f"[{s.stamp()}] {s.role}: {s.text.strip()}"
                         for s in self.segments if s.text.strip())

    def to_dict(self) -> dict:
        return {
            "language": self.language,
            "role_confidence": self.role_confidence,
            "note": self.note,
            "segments": [asdict(s) for s in self.segments],
        }


# ------------------------------------------------------------------- ffmpeg io

def _require(binary: str) -> str:
    path = shutil.which(binary)
    if not path:
        raise RuntimeError(
            f"{binary} not found. Install ffmpeg (apt-get install -y ffmpeg) - "
            "it is required to split stereo recordings into per-speaker channels.")
    return path


def channel_count(audio: Path) -> int:
    out = subprocess.run(
        [_require("ffprobe"), "-v", "error", "-select_streams", "a:0",
         "-show_entries", "stream=channels", "-of", "json", str(audio)],
        capture_output=True, text=True, check=True).stdout
    try:
        return int(json.loads(out)["streams"][0]["channels"])
    except (KeyError, IndexError, ValueError):
        return 1


def split_channels(audio: Path, workdir: Path) -> tuple[Path, Path]:
    """Split a stereo file into two 16 kHz mono WAVs (left, right)."""
    workdir.mkdir(parents=True, exist_ok=True)
    left = workdir / f"{audio.stem}.ch0.wav"
    right = workdir / f"{audio.stem}.ch1.wav"
    subprocess.run(
        [_require("ffmpeg"), "-y", "-loglevel", "error", "-i", str(audio),
         "-filter_complex",
         "[0:a]channelsplit=channel_layout=stereo[l][r]",
         "-map", "[l]", "-ac", "1", "-ar", "16000", str(left),
         "-map", "[r]", "-ac", "1", "-ar", "16000", str(right)],
        check=True, capture_output=True)
    return left, right


def to_mono_wav(audio: Path, workdir: Path) -> Path:
    workdir.mkdir(parents=True, exist_ok=True)
    dest = workdir / f"{audio.stem}.mono.wav"
    subprocess.run(
        [_require("ffmpeg"), "-y", "-loglevel", "error", "-i", str(audio),
         "-ac", "1", "-ar", "16000", str(dest)],
        check=True, capture_output=True)
    return dest


# ------------------------------------------------------------------ stt engine

class WhisperEngine:
    """faster-whisper wrapper. Loads the model once and reuses it."""

    def __init__(self, model_size: str = "large-v3", device: str = "auto",
                 compute_type: str = "default", language: str | None = None):
        from faster_whisper import WhisperModel      # imported lazily
        if device == "auto":
            device = "cuda" if _has_cuda() else "cpu"
        if compute_type == "default":
            compute_type = "float16" if device == "cuda" else "int8"
        log.info("loading faster-whisper %s on %s (%s)", model_size, device, compute_type)
        self.model = WhisperModel(model_size, device=device, compute_type=compute_type)
        self.language = language

    def transcribe(self, wav: Path) -> tuple[list[Segment], str]:
        segments, info = self.model.transcribe(
            str(wav),
            language=self.language,          # None => autodetect (uk/ru mix)
            vad_filter=True,                 # drop the silence on the other leg
            vad_parameters={"min_silence_duration_ms": 500},
            beam_size=5,
            condition_on_previous_text=False,
        )
        out = [Segment(start=s.start, end=s.end, role="", text=s.text)
               for s in segments if s.text and s.text.strip()]
        return out, info.language


def _has_cuda() -> bool:
    try:
        import torch
        return bool(torch.cuda.is_available())
    except Exception:
        return False


# ------------------------------------------------------------------- role logic

def roles_for_channels(direction: str, mode: str = "auto") -> tuple[str, str]:
    """Return (role_of_channel_0, role_of_channel_1).

    Channel 0 carries the caller's leg, so the manager is on channel 0 for
    outbound calls and on channel 1 for inbound ones.
    """
    if mode == "ch0_manager":
        return MANAGER, CLIENT
    if mode == "ch0_client":
        return CLIENT, MANAGER
    if direction == "out":
        return MANAGER, CLIENT
    if direction == "in":
        return CLIENT, MANAGER
    return UNKNOWN, UNKNOWN


def transcribe_stereo(audio: Path, engine: WhisperEngine, direction: str,
                      workdir: Path, mode: str = "auto") -> Transcript:
    left, right = split_channels(audio, workdir)
    role_l, role_r = roles_for_channels(direction, mode)

    seg_l, lang_l = engine.transcribe(left)
    seg_r, lang_r = engine.transcribe(right)
    for s in seg_l:
        s.role = role_l
    for s in seg_r:
        s.role = role_r

    merged = sorted(seg_l + seg_r, key=lambda s: s.start)
    note = "" if role_l != UNKNOWN else (
        "Call direction unknown - channels kept separate but roles unlabelled.")
    confidence = "high" if role_l != UNKNOWN else "low"
    for tmp in (left, right):
        tmp.unlink(missing_ok=True)
    return Transcript(merged, lang_l or lang_r or "", confidence, note)


def transcribe_mono(audio: Path, engine: WhisperEngine, workdir: Path,
                    hf_token: str | None = None) -> Transcript:
    """Mono fallback: diarise if we can, otherwise transcribe without roles."""
    wav = to_mono_wav(audio, workdir)
    segments, lang = engine.transcribe(wav)

    turns = _diarise(wav, hf_token) if hf_token else []
    if turns:
        speakers = _assign_speakers(segments, turns)
        _map_speakers_to_roles(segments, speakers)
        note = ("Mono recording - roles inferred by diarisation, "
                "please spot-check.")
        confidence = "low"
    else:
        for s in segments:
            s.role = UNKNOWN
        note = ("Mono recording and no diarisation available - roles not "
                "separated. Set HUGGINGFACE_TOKEN to enable diarisation.")
        confidence = "none"
    wav.unlink(missing_ok=True)
    return Transcript(segments, lang, confidence, note)


def _diarise(wav: Path, hf_token: str) -> list[tuple[float, float, str]]:
    try:
        from pyannote.audio import Pipeline
        pipeline = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-3.1", use_auth_token=hf_token)
        annotation = pipeline(str(wav), num_speakers=2)
        return [(turn.start, turn.end, label)
                for turn, _, label in annotation.itertracks(yield_label=True)]
    except Exception as exc:
        log.warning("diarisation unavailable (%s)", exc)
        return []


def _assign_speakers(segments: list[Segment],
                     turns: list[tuple[float, float, str]]) -> dict[int, str]:
    """Label each segment with the diarisation speaker it overlaps most."""
    out: dict[int, str] = {}
    for i, seg in enumerate(segments):
        best, best_overlap = "", 0.0
        for start, end, label in turns:
            overlap = min(seg.end, end) - max(seg.start, start)
            if overlap > best_overlap:
                best, best_overlap = label, overlap
        out[i] = best
    return out


def _map_speakers_to_roles(segments: list[Segment], speakers: dict[int, str]) -> None:
    """Whoever speaks first on an answered call is treated as the manager."""
    order = [speakers[i] for i in range(len(segments)) if speakers.get(i)]
    if not order:
        for s in segments:
            s.role = UNKNOWN
        return
    manager_label = order[0]
    for i, seg in enumerate(segments):
        label = speakers.get(i)
        if not label:
            seg.role = UNKNOWN
        else:
            seg.role = MANAGER if label == manager_label else CLIENT


def transcribe_call(audio: Path, engine: WhisperEngine, direction: str,
                    workdir: Path, mode: str = "auto",
                    hf_token: str | None = None) -> Transcript:
    """Entry point: pick the stereo or mono path based on the actual file."""
    if channel_count(audio) >= 2:
        return transcribe_stereo(audio, engine, direction, workdir, mode)
    log.info("%s is mono - falling back to diarisation", audio.name)
    return transcribe_mono(audio, engine, workdir, hf_token)
