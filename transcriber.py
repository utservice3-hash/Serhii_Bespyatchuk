import os
import logging
import requests

logger = logging.getLogger(__name__)

GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL = "whisper-large-v3-turbo"


def transcribe_call(record_url: str) -> str:
    """Завантажує запис дзвінка і розшифровує через Groq Whisper. Повертає текст або ''."""
    if not GROQ_API_KEY or not record_url:
        return ""
    try:
        audio_resp = requests.get(record_url, timeout=30)
        if not audio_resp.ok:
            logger.error("transcribe_call: failed to download record %s", record_url)
            return ""

        resp = requests.post(
            "https://api.groq.com/openai/v1/audio/transcriptions",
            headers={"Authorization": f"Bearer {GROQ_API_KEY}"},
            files={"file": ("call.mp3", audio_resp.content)},
            data={"model": GROQ_MODEL, "language": "uk"},
            timeout=60,
        )
        if resp.ok:
            return resp.json().get("text", "").strip()
        logger.error("Groq transcription error: %s", resp.text)
        return ""
    except Exception as e:
        logger.error("transcribe_call exception: %s", e)
        return ""
