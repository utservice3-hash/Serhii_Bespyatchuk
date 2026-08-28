"""Configuration, read from environment variables (see .env.example)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path


def load_dotenv(path: Path | None = None) -> None:
    """Load KEY=VALUE lines from a .env file, without overriding real env vars."""
    path = path or Path(__file__).resolve().parent.parent / ".env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def _int_list(raw: str | None) -> list[int]:
    if not raw:
        return []
    return [int(x) for x in raw.replace(";", ",").split(",") if x.strip()]


def _str_list(raw: str | None) -> list[str]:
    if not raw:
        return []
    return [x.strip() for x in raw.replace(";", ",").split(",") if x.strip()]


@dataclass
class Config:
    # --- Kommo -------------------------------------------------------------
    kommo_subdomain: str = ""
    kommo_token: str = ""
    kommo_pipeline_ids: list[int] = field(default_factory=list)
    # Lead-gen managers: numeric user ids and/or names, mixed freely.
    # Only used when no deal index is available (LEAD_INDEX below takes over).
    kommo_managers: list[str] = field(default_factory=list)
    # CSV produced by build_lead_index.py - the authoritative deal universe.
    lead_index: Path = Path("data/leadgen_deals.csv")
    # Restrict to these lead-gens; blank = every lead-gen in the index.
    lead_gens: list[str] = field(default_factory=list)

    # --- Ringostat ---------------------------------------------------------
    ringostat_key: str = ""
    ringostat_base: str = "https://api.ringostat.net"

    # --- selection ---------------------------------------------------------
    months_back: int = 3
    calls_per_deal: int = 5
    min_call_seconds: int = 15      # skip rings/voicemail with no conversation

    # --- transcription -----------------------------------------------------
    whisper_model: str = "large-v3"
    whisper_device: str = "auto"
    whisper_language: str | None = None      # None = autodetect (uk/ru mix)
    channel_role_mode: str = "auto"          # auto | ch0_manager | ch0_client
    hf_token: str | None = None              # enables mono diarisation fallback

    # --- output ------------------------------------------------------------
    out_dir: Path = Path("output")

    @classmethod
    def from_env(cls) -> "Config":
        return cls(
            kommo_subdomain=os.getenv("KOMMO_SUBDOMAIN", ""),
            kommo_token=os.getenv("KOMMO_ACCESS_TOKEN", ""),
            kommo_pipeline_ids=_int_list(os.getenv("KOMMO_PIPELINE_IDS")),
            kommo_managers=_str_list(os.getenv("KOMMO_MANAGERS")),
            lead_index=Path(os.getenv("LEAD_INDEX", "data/leadgen_deals.csv")),
            lead_gens=_str_list(os.getenv("LEAD_GENS")),
            ringostat_key=os.getenv("RINGOSTAT_AUTH_KEY", ""),
            ringostat_base=os.getenv("RINGOSTAT_BASE_URL", "https://api.ringostat.net"),
            months_back=int(os.getenv("MONTHS_BACK", "3")),
            calls_per_deal=int(os.getenv("CALLS_PER_DEAL", "5")),
            min_call_seconds=int(os.getenv("MIN_CALL_SECONDS", "15")),
            whisper_model=os.getenv("WHISPER_MODEL", "large-v3"),
            whisper_device=os.getenv("WHISPER_DEVICE", "auto"),
            whisper_language=os.getenv("WHISPER_LANGUAGE") or None,
            channel_role_mode=os.getenv("CHANNEL_ROLE_MODE", "auto"),
            hf_token=os.getenv("HUGGINGFACE_TOKEN") or None,
            out_dir=Path(os.getenv("OUT_DIR", "output")),
        )

    # --- derived -----------------------------------------------------------

    def window(self) -> tuple[date, date]:
        """The [from, to] date window, ``months_back`` months up to today."""
        today = datetime.now(timezone.utc).date()
        start = today - timedelta(days=31 * self.months_back)
        return start, today

    def window_unix(self) -> tuple[int, int]:
        start, end = self.window()
        to_ts = lambda d: int(datetime(d.year, d.month, d.day,
                                       tzinfo=timezone.utc).timestamp())
        return to_ts(start), to_ts(end) + 86399

    def split_managers(self) -> tuple[list[int], list[str]]:
        """Separate the manager list into numeric ids and names to resolve."""
        ids = [int(m) for m in self.kommo_managers if m.isdigit()]
        names = [m for m in self.kommo_managers if not m.isdigit()]
        return ids, names

    def missing(self) -> list[str]:
        """Names of required settings that are still empty."""
        required = {
            "KOMMO_SUBDOMAIN": self.kommo_subdomain,
            "KOMMO_ACCESS_TOKEN": self.kommo_token,
            "RINGOSTAT_AUTH_KEY": self.ringostat_key,
        }
        return [name for name, value in required.items() if not value]
