import os
import re
import time
import threading
import requests as _requests_lib
import logging

logger = logging.getLogger(__name__)

# ── Глобальний ліміт запитів до Kommo: не більше 2/сек ──────────────────
# Kommo дозволяє до 7 запитів/сек і банить за перевищення. Бот шле запити
# з кількох тредів (вебхуки, скани, AI-аналіз), тому ліміт спільний на
# весь процес. Реалізація: сесія, яка перед КОЖНИМ запитом витримує
# мінімальний інтервал; всі виклики requests.get/post/... у цьому модулі
# йдуть через неї (ім'я requests нижче навмисно вказує на сесію).
try:
    _rps_env = float(os.getenv("KOMMO_MAX_RPS", "2"))
except ValueError:
    _rps_env = 2.0
# Жорстка стеля 2 запити/сек (ліміт Kommo — ~7/с на ВЕСЬ акаунт, лишаємо запас
# для UI / інших інтеграцій під тим самим токеном). env KOMMO_MAX_RPS може лише
# ЗНИЗИТИ частоту, але не підняти вище 2. Нижня межа 0.2, щоб не ділити на 0.
_RATE_LIMIT_RPS = max(0.2, min(2.0, _rps_env))
_BASE_INTERVAL = 1.0 / _RATE_LIMIT_RPS
# Адаптивний backoff: при 429/403 (rate limit / блок акаунта) інтервал між
# запитами росте ×2 до цієї стелі, при успіху плавно спадає назад до базового.
# Так під тиском бот сам різко зменшує частоту й НЕ «добиває» заблокований
# акаунт, але не морозить воркер надовго (макс. очікування на запит =
# _MAX_INTERVAL сек). /health Kommo не чіпає, тож health-check лишається швидким.
_MAX_INTERVAL = float(os.getenv("KOMMO_MAX_BACKOFF", "5"))
_rate_lock = threading.Lock()
_last_request_ts = 0.0
_current_interval = _BASE_INTERVAL

# 🔌 Kill-switch синхронізації з Kommo. За замовчуванням ВИМКНЕНО (SYNC_PAUSED
# = False) — бот працює нормально. Щоб МИТТЄВО зупинити всю синхронізацію без
# деплою, постав env KOMMO_SYNC_PAUSED=1: _ThrottledSession почне віддавати
# синтетичний 503 замість реальних запитів, і вся логіка побачить це як «немає
# даних» (get_lead→None, PATCH→False, get_pipeline_leads→[]) без винятків, а
# вебхуки Kommo прийматимуться з 200 без обробки (див. app.py webhook()).
SYNC_PAUSED = os.getenv("KOMMO_SYNC_PAUSED", "0") == "1"


def _paused_response():
    r = _requests_lib.models.Response()
    r.status_code = 503
    r._content = b'{"paused": true}'
    r.reason = "Kommo sync paused"
    return r


class _ThrottledSession(_requests_lib.Session):
    def request(self, *args, **kwargs):
        global _last_request_ts, _current_interval
        if SYNC_PAUSED:
            return _paused_response()
        with _rate_lock:
            wait = _last_request_ts + _current_interval - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            _last_request_ts = time.monotonic()
        resp = super().request(*args, **kwargs)
        if getattr(resp, "status_code", 0) in (429, 403):
            with _rate_lock:
                _current_interval = min(_MAX_INTERVAL, _current_interval * 2)
                slowed = _current_interval
            logger.warning(
                "Kommo API %s (rate limit / блок) — сповільнення до %.2f req/s",
                resp.status_code, 1.0 / slowed,
            )
        elif _current_interval > _BASE_INTERVAL:
            with _rate_lock:
                _current_interval = max(_BASE_INTERVAL, _current_interval * 0.9)
        return resp


requests = _ThrottledSession()

KOMMO_TOKEN = os.getenv("KOMMO_TOKEN", "")
KOMMO_BASE = os.getenv("KOMMO_BASE", "https://utsercice.kommo.com")

HEADERS = {"Authorization": f"Bearer {KOMMO_TOKEN}"}

_user_cache: dict[int, str] = {}

# Короткочасний кеш повних лідів (get_lead): повторні фетчі того самого ліда в
# межах одного логічного потоку (get_lead_details + get_lead, кілька хендлерів
# на один вебхук, скан+самозцілення) не б'ють Kommo API двічі. TTL короткий, а
# будь-який наш PATCH ліда одразу інвалідовує запис — щоб loop-protection за
# тегами й самозцілення черги бачили свіжий стан. 0 = кеш вимкнено (env).
_LEAD_CACHE_TTL = float(os.getenv("KOMMO_LEAD_CACHE_TTL", "30"))
_lead_cache: dict[int, tuple] = {}
_lead_cache_lock = threading.Lock()


def _invalidate_lead_cache(lead_id: int) -> None:
    with _lead_cache_lock:
        _lead_cache.pop(lead_id, None)


def get_webhooks() -> list[dict]:
    try:
        resp = requests.get(f"{KOMMO_BASE}/api/v4/webhooks", headers=HEADERS, timeout=10)
        if resp.ok:
            return resp.json().get("_embedded", {}).get("webhooks", [])
    except Exception as e:
        logger.error("get_webhooks exception: %s", e)
    return []


def reenable_webhook(destination: str, settings: list[str]) -> bool:
    """Kommo has no PATCH for webhooks — Kommo auto-disables a webhook after repeated
    delivery failures, and the only way to clear that flag is to delete and recreate
    the subscription."""
    try:
        requests.delete(
            f"{KOMMO_BASE}/api/v4/webhooks", headers=HEADERS,
            json={"destination": destination}, timeout=10,
        )
        resp = requests.post(
            f"{KOMMO_BASE}/api/v4/webhooks", headers=HEADERS,
            json={"destination": destination, "settings": settings}, timeout=10,
        )
        return resp.status_code == 201
    except Exception as e:
        logger.error("reenable_webhook exception: %s", e)
        return False


def get_user_name(user_id: int) -> str:
    if user_id in _user_cache:
        return _user_cache[user_id]
    try:
        resp = requests.get(
            f"{KOMMO_BASE}/api/v4/users/{user_id}",
            headers=HEADERS,
            timeout=10,
        )
        if resp.ok:
            data = resp.json()
            name = data.get("name") or data.get("login", f"ID {user_id}")
            _user_cache[user_id] = name
            return name
    except Exception as e:
        logger.error("get_user_name(%s): %s", user_id, e)
    return f"ID {user_id}"


SOURCE_FIELD_ID = 2098035    # "Источник клиента"
REJECT_REASON_FIELD_ID = 2097265  # "Причина отказа"
# Угода вважається "по таргету", якщо заповнене будь-яке з цих полів —
# різні рекламні канали пишуть кампанію в різні поля (Facebook -> utm_campaign,
# Google Ads -> ADV_CAMP/TRAF_SRC).
AD_CAMPAIGN_FIELD_IDS = (
    481997,   # utm_campaign
    2098331,  # ADV_CAMP
    2098327,  # TRAF_SRC
)

QUAL_PIPELINE_ID = 8921928
PEREVOZY_PIPELINE_ID = 8921932

# Назви етапів воронки Кваліфікація
QUAL_STATUSES = {
    69693648: "Неразобранное",
    69693652: "Лід взятий у роботу",
    69693656: "Дзвінки",
    69693660: "Дзвінки з сайту",
    69716160: "Дзвінок по пропущеному (реклама)",
    69716164: "НОВА ЗАЯВКА ВІД ЛІДОГЕНЕРАТОРА",
    69738660: "Реактивовано",
    70419108: "Дзвінки на мобільні",
    142: "КВАЛІФІКОВАНО / Успіх",
    143: "Не цільові",
}

# Назви етапів воронки Перевозки
PEREVOZY_STATUSES = {
    69693664: "Incoming leads",
    69693668: "Взято на прорахунок",
    69693672: "Пропозицію зроблено",
    69716252: "Відкладений запит",
    69693676: "Умови узгоджені",
    69716256: "Документи підписані",
    69716260: "Контроль перед завантаженням",
    100274340: "Виставлення рахунку",
    69716300: "Авто працює",
    98470988: "Перевезення завершено",
    69716304: "Дзвінок після розвантаження",
    69716312: "Очікуємо оплату",
    69716460: "Оплата отримана",
    142: "Успішна угода",
    143: "Закрито і не реалізовано",
}


def get_lead(lead_id: int, use_cache: bool = True) -> dict | None:
    if use_cache and _LEAD_CACHE_TTL > 0:
        with _lead_cache_lock:
            hit = _lead_cache.get(lead_id)
            if hit and (time.monotonic() - hit[0]) < _LEAD_CACHE_TTL:
                return hit[1]
    try:
        resp = requests.get(
            f"{KOMMO_BASE}/api/v4/leads/{lead_id}",
            headers=HEADERS,
            params={"with": "custom_fields"},
            timeout=10,
        )
        if resp.ok:
            data = resp.json()
            if _LEAD_CACHE_TTL > 0:
                with _lead_cache_lock:
                    _lead_cache[lead_id] = (time.monotonic(), data)
                    if len(_lead_cache) > 500:
                        cutoff = time.monotonic() - _LEAD_CACHE_TTL
                        for k in [k for k, (ts, _v) in _lead_cache.items() if ts < cutoff]:
                            _lead_cache.pop(k, None)
            return data
    except Exception as e:
        logger.error("get_lead(%s): %s", lead_id, e)
    return None


def get_lead_details(lead_id: int, old_status_id: int = 0, pipeline_id: int = 0) -> dict:
    """
    Returns enriched lead info for closed-not-realized notification:
    name, created_at, reject_reason, last_status_name, notes_count, calls_count.
    If old_status_id and pipeline_id are provided, uses them to find the previous status.
    Otherwise falls back to current status (for testing).
    """
    from datetime import datetime, timezone

    result = {
        "name": f"Угода #{lead_id}",
        "days_in_work": None,
        "reject_reason": "",
        "last_status": "",
        "notes_count": 0,
        "calls_count": 0,
    }

    # Lead basic info + custom fields — через get_lead (спільний кеш, не
    # окремий GET того самого ліда).
    try:
        lead = get_lead(lead_id)
        if lead:
            result["name"] = lead.get("name", result["name"])
            created_at = lead.get("created_at", 0)
            if created_at:
                days = (datetime.now(timezone.utc).timestamp() - created_at) / 86400
                result["days_in_work"] = int(days)

            if old_status_id and pipeline_id == PEREVOZY_PIPELINE_ID:
                result["last_status"] = PEREVOZY_STATUSES.get(old_status_id, "")
            elif old_status_id and pipeline_id == QUAL_PIPELINE_ID:
                result["last_status"] = QUAL_STATUSES.get(old_status_id, "")
            else:
                result["last_status"] = PEREVOZY_STATUSES.get(lead.get("status_id", 0), "")

            for cf in lead.get("custom_fields_values") or []:
                if cf.get("field_id") == REJECT_REASON_FIELD_ID:
                    vals = cf.get("values") or []
                    if vals:
                        result["reject_reason"] = vals[0].get("value", "")
    except Exception as e:
        logger.error("get_lead_details lead: %s", e)

    # Notes + calls count
    try:
        resp = requests.get(
            f"{KOMMO_BASE}/api/v4/leads/{lead_id}/notes",
            headers=HEADERS,
            params={"limit": 100},
            timeout=10,
        )
        if resp.ok:
            notes = resp.json().get("_embedded", {}).get("notes", [])
            calls = [n for n in notes if n.get("note_type") in (10, 11, "call_in", "call_out")]
            result["notes_count"] = len(notes)
            result["calls_count"] = len(calls)
    except Exception as e:
        logger.error("get_lead_details notes: %s", e)

    return result


MINUS_DEAL_FIELD_ID = 2098529   # "Мінусова угода" — значення "Мінус"
FICTIVE_KEYWORD = "ФІКТИВНИЙ"


def is_minus_deal(lead: dict) -> bool:
    """Повертає True якщо угода мінусова (поле 2098529 = 'Мінус' або назва містить МІНУС)."""
    name = (lead.get("name") or "").upper()
    if FICTIVE_KEYWORD in name:
        return False  # фіктивні — окрема логіка, не мінус
    for cf in lead.get("custom_fields_values") or []:
        if cf.get("field_id") == MINUS_DEAL_FIELD_ID:
            vals = cf.get("values") or []
            if vals and str(vals[0].get("value", "")).strip():
                return True
    return "МІНУС" in name


def is_fictive_deal(lead: dict) -> bool:
    """Повертає True якщо угода фіктивна."""
    return FICTIVE_KEYWORD in (lead.get("name") or "").upper()


def has_utm_campaign(lead: dict) -> bool:
    """Перевіряє, чи угода прийшла по таргету (заповнене одне з полів рекламної кампанії)."""
    for cf in lead.get("custom_fields_values") or []:
        if cf.get("field_id") in AD_CAMPAIGN_FIELD_IDS:
            vals = cf.get("values") or []
            if vals and str(vals[0].get("value", "")).strip():
                return True
    return False


REQUEST_TYPE_FIELD_ID = 2097965      # поле "Тип запиту"
CITY_TRANSPORT_ENUM_ID = 6345143     # значення "По місту"


def is_city_transport(lead: dict) -> bool:
    """True, якщо «Тип запиту» = «По місту». Такі угоди (перевезення по місту,
    без маржі) повністю ігноруються AI Відділом якості — без аналізу, повернення
    й сповіщень."""
    if not lead:
        return False
    for cf in lead.get("custom_fields_values") or []:
        if cf.get("field_id") == REQUEST_TYPE_FIELD_ID:
            for v in (cf.get("values") or []):
                if v.get("enum_id") == CITY_TRANSPORT_ENUM_ID:
                    return True
                if str(v.get("value", "")).strip().lower() == "по місту":
                    return True
    return False


def get_lead_source(lead: dict) -> str:
    """Extract 'Источник клиента' value from lead custom fields."""
    for cf in lead.get("custom_fields_values") or []:
        if cf.get("field_id") == SOURCE_FIELD_ID:
            values = cf.get("values") or []
            if values:
                return values[0].get("value", "")
    return ""


def get_reject_reason(lead: dict) -> str:
    """Повертає значення поля 'Причина отказа' з угоди (порожній рядок, якщо немає)."""
    for cf in lead.get("custom_fields_values") or []:
        if cf.get("field_id") == REJECT_REASON_FIELD_ID:
            values = cf.get("values") or []
            if values:
                return str(values[0].get("value", "") or "").strip()
    return ""


def get_lead_events(lead_id: int, limit: int = 50) -> list:
    try:
        resp = requests.get(
            f"{KOMMO_BASE}/api/v4/events",
            headers=HEADERS,
            params={
                "filter[entity][0][id]": lead_id,
                "filter[entity][0][type]": "lead",
                "limit": limit,
            },
            timeout=10,
        )
        if resp.ok:
            data = resp.json()
            return data.get("_embedded", {}).get("events", [])
    except Exception as e:
        logger.error("get_lead_events(%s): %s", lead_id, e)
    return []


def get_lead_notes(lead_id: int) -> list:
    try:
        resp = requests.get(
            f"{KOMMO_BASE}/api/v4/leads/{lead_id}/notes",
            headers=HEADERS,
            params={"limit": 50},
            timeout=10,
        )
        if resp.ok:
            data = resp.json()
            return data.get("_embedded", {}).get("notes", [])
    except Exception as e:
        logger.error("get_lead_notes(%s): %s", lead_id, e)
    return []


def update_lead_status(lead_id: int, status_id: int) -> bool:
    """Переводить лід на вказаний етап (в межах тієї ж воронки)."""
    try:
        resp = requests.patch(
            f"{KOMMO_BASE}/api/v4/leads/{lead_id}",
            headers=HEADERS,
            json={"status_id": status_id},
            timeout=10,
        )
        if resp.ok:
            _invalidate_lead_cache(lead_id)
        return resp.ok
    except Exception as e:
        logger.error("update_lead_status(%s, %s): %s", lead_id, status_id, e)
        return False


def move_lead_to(lead_id: int, pipeline_id: int, status_id: int, add_tag: str = "") -> bool:
    """Переводить лід в іншу воронку (pipeline_id) на вказаний етап (status_id),
    опційно додаючи тег БЕЗ видалення наявних. Одним PATCH-запитом."""
    try:
        lead = get_lead(lead_id)
        payload = {"pipeline_id": pipeline_id, "status_id": status_id}
        if lead is None:
            # GET впав (таймаут/5xx) — НЕ чіпаємо теги: _embedded.tags замінює
            # ВЕСЬ набір, тож із порожнім baseline ми б стерли всі наявні теги
            # клієнта. Переміщаємо без зміни тегів; тег додасться наступного разу.
            logger.warning("move_lead_to(%s): GET failed, moving without tag change", lead_id)
        else:
            existing = lead.get("_embedded", {}).get("tags") or []
            tags = [{"id": t["id"]} for t in existing if t.get("id")]
            if add_tag and not any(
                (t.get("name") or "").lower() == add_tag.lower() for t in existing
            ):
                tags.append({"name": add_tag})
            if tags:
                payload["_embedded"] = {"tags": tags}
        resp = requests.patch(
            f"{KOMMO_BASE}/api/v4/leads/{lead_id}",
            headers=HEADERS,
            json=payload,
            timeout=10,
        )
        if resp.ok:
            _invalidate_lead_cache(lead_id)
        else:
            logger.error("move_lead_to(%s→%s/%s): %s %s", lead_id, pipeline_id, status_id, resp.status_code, resp.text)
        return resp.ok
    except Exception as e:
        logger.error("move_lead_to(%s): %s", lead_id, e)
        return False


def add_note(lead_id: int, text: str) -> bool:
    """Додає текстову нотатку (note_type=common) до угоди."""
    if not text:
        return False
    try:
        resp = requests.post(
            f"{KOMMO_BASE}/api/v4/leads/{lead_id}/notes",
            headers=HEADERS,
            json=[{"note_type": "common", "params": {"text": text}}],
            timeout=10,
        )
        if not resp.ok:
            logger.error("add_note(%s): %s %s", lead_id, resp.status_code, resp.text)
        return resp.ok
    except Exception as e:
        logger.error("add_note(%s): %s", lead_id, e)
        return False


def get_lead_main_contact_id(lead_id: int) -> int:
    """ID головного контакту ліда (0, якщо немає). GET /leads/{id}?with=contacts.
    Той самий номер = той самий контакт, тож контакт — стабільний ключ для
    дедупу «перший дотик один раз на клієнта» через різні угоди."""
    try:
        resp = requests.get(
            f"{KOMMO_BASE}/api/v4/leads/{lead_id}",
            headers=HEADERS,
            params={"with": "contacts"},
            timeout=10,
        )
        if resp.ok:
            contacts = resp.json().get("_embedded", {}).get("contacts", []) or []
            if not contacts:
                return 0
            main = next((c for c in contacts if c.get("is_main")), contacts[0])
            return int(main.get("id", 0) or 0)
    except Exception as e:
        logger.error("get_lead_main_contact_id(%s): %s", lead_id, e)
    return 0


def contact_has_note_marker(contact_id: int, marker: str) -> bool:
    """Чи є серед нотаток контакту текстова нотатка з маркером (персистентний
    дедуп, що переживає рестарт і спільний для всіх угод контакту)."""
    try:
        resp = requests.get(
            f"{KOMMO_BASE}/api/v4/contacts/{contact_id}/notes",
            headers=HEADERS,
            params={"limit": 100},
            timeout=10,
        )
        if resp.ok:
            notes = resp.json().get("_embedded", {}).get("notes", []) or []
            for n in notes:
                if n.get("note_type") in (4, "common"):
                    if marker in ((n.get("params") or {}).get("text") or ""):
                        return True
    except Exception as e:
        logger.error("contact_has_note_marker(%s): %s", contact_id, e)
    return False


def add_contact_note(contact_id: int, text: str) -> bool:
    """Додає текстову нотатку (note_type=common) до контакту."""
    if not contact_id or not text:
        return False
    try:
        resp = requests.post(
            f"{KOMMO_BASE}/api/v4/contacts/{contact_id}/notes",
            headers=HEADERS,
            json=[{"note_type": "common", "params": {"text": text}}],
            timeout=10,
        )
        if not resp.ok:
            logger.error("add_contact_note(%s): %s %s", contact_id, resp.status_code, resp.text)
        return resp.ok
    except Exception as e:
        logger.error("add_contact_note(%s): %s", contact_id, e)
        return False


def get_note(lead_id: int, note_id: int) -> dict:
    """Повертає конкретну нотатку ліда (для точного зіставлення з вебхуком)."""
    try:
        resp = requests.get(
            f"{KOMMO_BASE}/api/v4/leads/{lead_id}/notes/{note_id}",
            headers=HEADERS,
            timeout=10,
        )
        if resp.ok:
            return resp.json()
    except Exception as e:
        logger.error("get_note(%s, %s): %s", lead_id, note_id, e)
    return {}


def get_latest_call_note(lead_id: int) -> dict:
    """Повертає параметри останньої дзвінкової нотатки ліда: duration, link, phone."""
    notes = get_lead_notes(lead_id)
    calls = [n for n in notes if n.get("note_type") in (10, 11, "call_in", "call_out")]
    if not calls:
        return {}
    latest = max(calls, key=lambda n: n.get("created_at", 0))
    params = latest.get("params") or {}
    return {
        "duration": int(params.get("duration", 0) or 0),
        "link": params.get("link", "") or params.get("LINK", ""),
        "phone": params.get("phone", "") or params.get("PHONE", ""),
        "created_at": latest.get("created_at", 0),
    }


def get_last_text_note(lead_id: int) -> str:
    """Повертає текст останньої текстової нотатки ліда (наприклад, причина закриття,
    яку менеджер вписав вручну) — порожній рядок, якщо такої нотатки немає."""
    notes = get_lead_notes(lead_id)
    text_notes = [n for n in notes if n.get("note_type") in (4, "common")]
    if not text_notes:
        return ""
    latest = max(text_notes, key=lambda n: n.get("created_at", 0))
    params = latest.get("params") or {}
    return (params.get("text") or "").strip()


def get_pipeline_leads(pipeline_id: int, status_id: int | None = None, page: int = 1, with_custom_fields: bool = False, closed_at_from: int | None = None) -> list:
    params: dict = {"limit": 250, "page": page}
    if status_id:
        params["filter[statuses][0][pipeline_id]"] = pipeline_id
        params["filter[statuses][0][status_id]"] = status_id
    else:
        params["filter[pipeline_id]"] = pipeline_id
    if with_custom_fields:
        params["with"] = "custom_fields"
    if closed_at_from:
        params["filter[closed_at][from]"] = closed_at_from
    try:
        resp = requests.get(
            f"{KOMMO_BASE}/api/v4/leads",
            headers=HEADERS,
            params=params,
            timeout=15,
        )
        if resp.ok:
            data = resp.json()
            return data.get("_embedded", {}).get("leads", [])
    except Exception as e:
        logger.error("get_pipeline_leads: %s", e)
    return []


WON_STATUS_ID = 142
CLOSED_NOT_REALIZED_STATUS_ID = 143
PEREVOZY_PIPELINE_ID = 8921932
QUAL_PIPELINE_ID = 8921928
NON_TARGET_STATUS_ID = 143  # "Не цільові" — те саме числове status_id, але в іншому pipeline


def get_manager_deal_stats(user_id: int, days: int) -> dict:
    """
    Особиста статистика менеджера за period: скільки лідів отримав від лідогена,
    скільки угод виграно/закрито-нереалізовано (Перевозки), і конверсія %.
    """
    from datetime import datetime, timezone, timedelta

    since = int((datetime.now(timezone.utc) - timedelta(days=days)).timestamp())

    def _count_status(status_id: int) -> int:
        total = 0
        page = 1
        while True:
            try:
                resp = requests.get(
                    f"{KOMMO_BASE}/api/v4/leads",
                    headers=HEADERS,
                    params={
                        "filter[statuses][0][pipeline_id]": PEREVOZY_PIPELINE_ID,
                        "filter[statuses][0][status_id]": status_id,
                        "filter[responsible_user_id][0]": user_id,
                        "filter[closed_at][from]": since,
                        "limit": 250,
                        "page": page,
                    },
                    timeout=15,
                )
                if not resp.ok:
                    break
                leads = resp.json().get("_embedded", {}).get("leads", [])
            except Exception as e:
                logger.error("get_manager_deal_stats(%s, status=%s): %s", user_id, status_id, e)
                break
            total += len(leads)
            if len(leads) < 250:
                break
            page += 1
        return total

    won = _count_status(WON_STATUS_ID)
    lost = _count_status(CLOSED_NOT_REALIZED_STATUS_ID)
    taken = get_lidogen_stats(days).get(user_id, 0)
    closed_total = won + lost
    conversion = round(won / closed_total * 100, 1) if closed_total else 0.0

    return {
        "taken": taken,
        "won": won,
        "lost": lost,
        "conversion": conversion,
    }


def get_campaign_name(lead: dict) -> str:
    """
    Назва рекламної кампанії ліда. Перевіряє поля-кандидати у фіксованому
    порядку пріоритету (utm_campaign -> ADV_CAMP -> TRAF_SRC), а не в тому
    порядку, в якому вони прийшли з Kommo API — інакше менш інформативне
    поле (наприклад TRAF_SRC з доменом-реферером типу "chatgpt.com") може
    випадково перекрити заповнений utm_campaign.
    """
    by_field_id = {
        cf.get("field_id"): cf
        for cf in (lead.get("custom_fields_values") or [])
    }
    for field_id in AD_CAMPAIGN_FIELD_IDS:
        cf = by_field_id.get(field_id)
        if not cf:
            continue
        vals = cf.get("values") or []
        if vals:
            value = str(vals[0].get("value", "")).strip()
            if value:
                return value
    return ""


def get_weekly_ad_campaign_report(days: int = 7, offset_days: int = 0) -> dict:
    """
    Зведення по угодах, що прийшли з реклами (заповнене поле кампанії) за
    період `days` днів, що закінчується `offset_days` днів тому (offset_days=0 —
    період закінчується зараз; offset_days=days дає попередній рівновеликий
    період — зручно для порівняння тиждень-до-тижня).

    status_id в Kommo унікальний лише в межах pipeline — те саме число 143
    означає "Закрито не реалізовано" в pipeline "Перевозки" і "Не цільові" в
    pipeline "Кваліфікація", тож класифікація статусу враховує pipeline_id.
    """
    from datetime import datetime, timezone, timedelta

    until_dt = datetime.now(timezone.utc) - timedelta(days=offset_days)
    since = int((until_dt - timedelta(days=days)).timestamp())
    until = int(until_dt.timestamp())

    leads = []
    page = 1
    while True:
        try:
            resp = requests.get(
                f"{KOMMO_BASE}/api/v4/leads",
                headers=HEADERS,
                params={
                    "filter[created_at][from]": since,
                    "filter[created_at][to]": until,
                    "with": "custom_fields,contacts",
                    "limit": 250,
                    "page": page,
                },
                timeout=15,
            )
            if not resp.ok:
                logger.error("get_weekly_ad_campaign_report: %s %s", resp.status_code, resp.text[:200])
                break
            batch = resp.json().get("_embedded", {}).get("leads", [])
        except Exception as e:
            logger.error("get_weekly_ad_campaign_report: %s", e)
            break
        leads.extend(batch)
        if len(batch) < 250:
            break
        page += 1
        if page > 40:
            break

    # Угода вважається фактично реалізованою (вантаж їде/доїхав) з етапу
    # "АВТО ПРАЦЮЄ" і далі по воронці Перевозки — виручка/маржа рахуються з
    # цього моменту, а не лише по формальному закриттю "Успіх".
    REVENUE_STATUS_IDS = {
        69716300,  # АВТО ПРАЦЮЄ
        98470988,  # Первезення завершено
        69716304,  # ДЗВІНОК ПІСЛЯ РОЗВАНТАЖЕННЯ - ВИСТАВЛЕНО РАХУНОК
        69716312,  # ОЧІКУЄМО ОПЛАТУ ЗАМ (ПЕРЕВІЗНИК ОПЛАЧЕНИЙ)
        69716460,  # ОПЛАТА ОТРИМАНА
        WON_STATUS_ID,  # УСПІШНА УГОДА
    }

    def _classify(pipeline_id, status_id):
        if pipeline_id == PEREVOZY_PIPELINE_ID and status_id == WON_STATUS_ID:
            return "won", "Успіх"
        if pipeline_id == PEREVOZY_PIPELINE_ID and status_id == CLOSED_NOT_REALIZED_STATUS_ID:
            return "lost", "Закрито не реалізовано"
        if pipeline_id == QUAL_PIPELINE_ID and status_id == NON_TARGET_STATUS_ID:
            return "non_target", "Не цільові"
        return "in_progress", "В роботі"

    campaigns: dict[str, dict] = {}
    leads_detail: list[dict] = []
    total = 0
    non_target_total = 0
    for lead in leads:
        campaign = get_campaign_name(lead)
        if not campaign:
            continue
        total += 1
        c = campaigns.setdefault(
            campaign, {"total": 0, "won": 0, "lost": 0, "non_target": 0, "in_progress": 0}
        )
        c["total"] += 1
        status_id = lead.get("status_id", 0)
        pipeline_id = lead.get("pipeline_id", 0)
        bucket, status_label = _classify(pipeline_id, status_id)
        c[bucket] += 1
        if bucket == "non_target":
            non_target_total += 1

        responsible_id = lead.get("responsible_user_id", 0)
        contacts = lead.get("_embedded", {}).get("contacts") or []
        contact_id = contacts[0]["id"] if contacts else 0
        leads_detail.append({
            "lead_id": lead.get("id"),
            "name": lead.get("name") or "",
            "campaign": campaign,
            "manager_id": responsible_id,
            "manager_name": get_user_name(responsible_id) if responsible_id else "—",
            "status_id": status_id,
            "status_label": status_label,
            "amount": lead.get("price", 0) or 0,
            "created_at": lead.get("created_at", 0),
            "closed_at": lead.get("closed_at", 0),
            "revenue_eligible": pipeline_id == PEREVOZY_PIPELINE_ID and status_id in REVENUE_STATUS_IDS,
            "contact_id": contact_id,
        })

    for c in campaigns.values():
        closed = c["won"] + c["lost"]
        c["conversion"] = round(c["won"] / closed * 100, 1) if closed else 0.0

    return {
        "total": total,
        "non_target_total": non_target_total,
        "campaigns": campaigns,
        "leads": leads_detail,
    }


def _count_contact_won_deals(contact_id: int) -> int:
    """Скільки всього виграних угод (Перевозки/Успіх) за весь час пов'язано з
    цим контактом — щоб визначити, чи клієнт із реклами зробив повторне
    замовлення (>=2), чи це його перше замовлення.

    `filter[contacts][0]=<id>` на /api/v4/leads на практиці ігнорується Kommo
    (перевірено: навіть вигаданий contact_id повертає однаковий результат),
    тому йдемо через /api/v4/contacts/{id}?with=leads, щоб отримати ID угод,
    пов'язаних саме з цим контактом, а потім запитуємо ці угоди пакетно через
    filter[id][] і рахуємо ті, що в потрібному пайплайні й статусі."""
    try:
        resp = requests.get(
            f"{KOMMO_BASE}/api/v4/contacts/{contact_id}",
            headers=HEADERS,
            params={"with": "leads"},
            timeout=15,
        )
        if not resp.ok:
            return 0
        lead_ids = [l["id"] for l in resp.json().get("_embedded", {}).get("leads", [])]
    except Exception as e:
        logger.error("_count_contact_won_deals(%s) contact lookup: %s", contact_id, e)
        return 0

    if not lead_ids:
        return 0

    won = 0
    for i in range(0, len(lead_ids), 250):
        chunk = lead_ids[i:i + 250]
        try:
            resp = requests.get(
                f"{KOMMO_BASE}/api/v4/leads",
                headers=HEADERS,
                params=[("filter[id][]", lid) for lid in chunk] + [("limit", 250)],
                timeout=15,
            )
            if not resp.ok:
                continue
            batch = resp.json().get("_embedded", {}).get("leads", [])
        except Exception as e:
            logger.error("_count_contact_won_deals(%s) leads lookup: %s", contact_id, e)
            continue
        won += sum(
            1 for lead in batch
            if lead.get("pipeline_id") == PEREVOZY_PIPELINE_ID and lead.get("status_id") == WON_STATUS_ID
        )
    return won


def get_repeat_customers(report: dict) -> dict:
    """
    Серед клієнтів, що прийшли з реклами і закрили угоду успіхом у цьому
    звіті, визначає скільки з них — повторні клієнти (вже мали виграну угоду
    раніше, тобто це не перше замовлення), а скільки — нові.

    Повертає {"repeat_count": int, "new_count": int,
              "repeat_customers": [{"lead_id", "name", "campaign", "manager_name", "total_orders"}]}.
    """
    won_ad_leads = [
        l for l in report.get("leads", [])
        if l.get("status_label") == "Успіх" and l.get("contact_id")
    ]
    seen_contacts: dict[int, dict] = {}
    for lead in won_ad_leads:
        seen_contacts.setdefault(lead["contact_id"], lead)

    repeat_customers = []
    new_count = 0
    for contact_id, lead in seen_contacts.items():
        total_orders = _count_contact_won_deals(contact_id)
        if total_orders >= 2:
            repeat_customers.append({
                "lead_id": lead["lead_id"],
                "name": lead["name"],
                "campaign": lead["campaign"],
                "manager_name": lead["manager_name"],
                "total_orders": total_orders,
            })
        else:
            new_count += 1

    return {
        "repeat_count": len(repeat_customers),
        "new_count": new_count,
        "repeat_customers": sorted(repeat_customers, key=lambda c: c["total_orders"], reverse=True),
    }


def get_campaign_trend(weeks: int = 12) -> list[dict]:
    """
    Потижнева динаміка по угодах з реклами за останні `weeks` тижнів — для
    графіка в звіті і порівняння тренду за останні ~3 місяці. Витрати/маржа
    сюди не входять, бо таблиця маркетингу дає лише накопичений підсумок
    поточного місяця, без історії по тижнях.

    Тягнемо кожен тиждень ОКРЕМИМ запитом (get_weekly_ad_campaign_report з
    offset_days), а не один великий запит на весь діапазон: Kommo повертає
    ліди в порядку зростання id (найстаріші першими), і при великому обсязі
    лідів за 3 місяці один запит впирається у ліміт пагінації (40 сторінок ×
    250 = 10 000 лідів) ще до того, як дістається до найновіших — це
    обрізало б саме останні, найважливіші тижні.

    Повертає список тижнів від найстарішого до найновішого:
    [{"week_start": "YYYY-MM-DD", "total": int, "won": int, "lost": int,
      "non_target": int, "conversion": float, "revenue": int}, ...]
    """
    from datetime import datetime, timezone, timedelta

    now = datetime.now(timezone.utc)
    trend = []
    for week_index in range(weeks - 1, -1, -1):
        offset_days = week_index * 7
        report = get_weekly_ad_campaign_report(days=7, offset_days=offset_days)
        won = sum(c["won"] for c in report["campaigns"].values())
        lost = sum(c["lost"] for c in report["campaigns"].values())
        revenue = sum(
            lead.get("amount", 0) or 0 for lead in report["leads"] if lead.get("revenue_eligible")
        )
        closed = won + lost
        week_start = (now - timedelta(days=offset_days + 7)).strftime("%Y-%m-%d")
        trend.append({
            "week_start": week_start,
            "total": report["total"],
            "won": won,
            "lost": lost,
            "non_target": report.get("non_target_total", 0),
            "conversion": round(won / closed * 100, 1) if closed else 0.0,
            "revenue": revenue,
        })
    return trend


def get_lidogen_stats(days: int = 1) -> dict[int, int]:
    """
    Count leads transferred by lidogen per manager for the last N days.
    Logic: find lead_responsible_changed events where the lead was freshly created
    in QUAL_PIPELINE (i.e. created_at >= since), meaning lidogen created it and
    then changed the responsible to a real manager.
    Returns {new_responsible_user_id: count}
    """
    from datetime import datetime, timezone, timedelta
    QUAL_PIPELINE_ID = 8921928

    since = int((datetime.now(timezone.utc) - timedelta(days=days)).timestamp())
    counts: dict[int, int] = {}

    try:
        page = 1
        while True:
            resp = requests.get(
                f"{KOMMO_BASE}/api/v4/events",
                headers=HEADERS,
                params={
                    "filter[type][]": "lead_responsible_changed",
                    "filter[created_at][from]": since,
                    "limit": 100,
                    "page": page,
                },
                timeout=15,
            )
            if not resp.ok:
                logger.error("get_lidogen_stats events: %s %s", resp.status_code, resp.text[:200])
                break

            events = resp.json().get("_embedded", {}).get("events", [])
            if not events:
                break

            for event in events:
                if event.get("entity_type") != "lead":
                    continue
                lead_id = event.get("entity_id")
                if not lead_id:
                    continue

                lead = get_lead(lead_id)
                if not lead:
                    continue
                # Only count leads in qual pipeline that were created within the period
                # (i.e. freshly created by lidogen, not old leads being re-assigned)
                if lead.get("pipeline_id") != QUAL_PIPELINE_ID:
                    continue
                if lead.get("created_at", 0) < since:
                    continue

                # Extract new responsible from value_after
                value_after = event.get("value_after") or []
                for v in value_after:
                    uid = (v.get("responsible_user") or {}).get("id")
                    if uid:
                        counts[int(uid)] = counts.get(int(uid), 0) + 1
                        break

            if len(events) < 100:
                break
            page += 1
            if page > 20:
                break
    except Exception as ex:
        logger.error("get_lidogen_stats: %s", ex)

    return counts


def _create_contact_with_phone(name: str, phone: str) -> int | None:
    """Створює контакт з телефоном. Kommo API не дозволяє створювати новий
    контакт inline всередині запиту на створення ліда (вимагає вже існуючий
    contact_id) — тому контакт створюється окремим запитом наперед."""
    try:
        resp = requests.post(
            f"{KOMMO_BASE}/api/v4/contacts",
            headers=HEADERS,
            json=[{
                "name": name,
                "custom_fields_values": [
                    {
                        "field_code": "PHONE",
                        "values": [{"value": phone, "enum_code": "WORK"}],
                    }
                ],
            }],
            timeout=15,
        )
        if not resp.ok:
            logger.error("_create_contact_with_phone: %s %s", resp.status_code, resp.text)
            return None
        contacts = resp.json().get("_embedded", {}).get("contacts", [])
        return contacts[0]["id"] if contacts else None
    except Exception as e:
        logger.error("_create_contact_with_phone: %s", e)
        return None


def find_recent_lead_by_phone(phone: str, hours: int = 24) -> int | None:
    """Шукає лід, створений за останні N годин, за телефоном контакту
    (повнотекстовий пошук Kommo по query). Потрібно для дедуплікації заявок,
    яка переживає рестарт сервісу (in-memory кеш при рестарті губиться).
    Повертає lead_id першого збігу або None."""
    digits = re.sub(r"\D", "", phone)[-9:]  # без коду країни — формат у CRM різний
    if len(digits) < 9:
        return None
    try:
        resp = requests.get(
            f"{KOMMO_BASE}/api/v4/leads",
            headers=HEADERS,
            params={"query": digits, "limit": 10},
            timeout=15,
        )
        if resp.status_code == 204 or not resp.ok:
            return None
        cutoff = time.time() - hours * 3600
        for lead in resp.json().get("_embedded", {}).get("leads", []):
            if lead.get("created_at", 0) >= cutoff:
                return lead["id"]
    except Exception as e:
        logger.error("find_recent_lead_by_phone(%s): %s", phone, e)
    return None


def create_lead_with_phone(
    name: str,
    phone: str,
    pipeline_id: int,
    status_id: int,
    tag_name: str = "",
) -> int | None:
    """Створює лід з прив'язаним контактом (телефон) і тегом (якщо вказано).
    Повертає lead_id або None, якщо створення не вдалось."""
    contact_id = _create_contact_with_phone(name, phone)
    if not contact_id:
        return None

    lead_payload = {
        "name": name,
        "pipeline_id": pipeline_id,
        "status_id": status_id,
        "_embedded": {"contacts": [{"id": contact_id}]},
    }
    if tag_name:
        lead_payload["_embedded"]["tags"] = [{"name": tag_name}]

    try:
        resp = requests.post(
            f"{KOMMO_BASE}/api/v4/leads",
            headers=HEADERS,
            json=[lead_payload],
            timeout=15,
        )
        if not resp.ok:
            logger.error("create_lead_with_phone: %s %s", resp.status_code, resp.text)
            return None
        leads = resp.json().get("_embedded", {}).get("leads", [])
        return leads[0]["id"] if leads else None
    except Exception as e:
        logger.error("create_lead_with_phone: %s", e)
        return None
