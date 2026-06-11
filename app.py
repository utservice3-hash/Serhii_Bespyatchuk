import os
import logging
from datetime import datetime, timezone, timedelta
from flask import Flask, request, jsonify
from apscheduler.schedulers.background import BackgroundScheduler

import kommo
import notifier
import sheets

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

app = Flask(__name__)

QUAL_PIPELINE_ID = 8921928
NEW_FROM_LIDOGEN = 69716164   # "НОВА ЗАЯВКА ВІД ЛІДОГЕНЕРАТОРА"
TAKEN_TO_WORK = 69693652      # "Лід взятий у роботу"
REMINDER_MINUTES = 20

# Етапи з яких повторна передача НЕ викликає сповіщення
SKIP_FROM_STATUSES = {
    69693652,  # Лід взятий у роботу
    69693656,  # Дзвінки
    69693660,  # Дзвінки з сайту
}

# Керівник для конкретних менеджерів: {manager_id: supervisor_tg}
SUPERVISOR_MAP = {
    2013613: "@dmytro_yatsyk",   # Антипенко Олег
    7347414: "@dmytro_yatsyk",   # Свіржевський Артем
    10022700: "@dmytro_yatsyk",  # Мокляк Олександр
    11739992: "@dmytro_yatsyk",  # Хомік Вікторія
}


def _check_overdue_leads():
    """Runs every 5 min — reminds about leads not called within 20 min."""
    now = datetime.now(timezone.utc)
    for lead_id, info in list(pending.items()):
        if info.get("reminded"):
            continue
        age_min = (now - info["transferred_at"]).total_seconds() / 60
        if age_min < REMINDER_MINUTES:
            continue

        responsible_id = info.get("responsible_id", 0)
        manager_tag = notifier.get_manager_tag(responsible_id) or f"ID {responsible_id}"
        supervisor_tag = SUPERVISOR_MAP.get(responsible_id, "")
        lead_name = info.get("lead_name", f"Лід #{lead_id}")
        kommo_url = f"https://utsercice.kommo.com/leads/detail/{lead_id}"

        sup_part = f" {supervisor_tag}" if supervisor_tag else ""
        msg = (
            f"⚠️ <b>Ліd не опрацьований {REMINDER_MINUTES} хв!</b>\n"
            f"👤 Менеджер: {manager_tag}{sup_part}\n"
            f"🏷 Назва: {lead_name}\n"
            f"⏱ Пройшло: <b>{age_min:.0f} хв</b>\n"
            f"🔗 <a href='{kommo_url}'>Відкрити лід #{lead_id}</a>"
        )
        notifier.send_message(msg)
        pending[lead_id]["reminded"] = True
        logger.info("Reminder sent for lead %s (%.0f min)", lead_id, age_min)


def _write_daily_snapshot():
    """Runs at 21:55 UTC (≈ 23:55 Kyiv) — saves daily stats to Google Sheets."""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    cutoff = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)

    # Aggregate from in-memory stats log
    counts: dict[int, int] = {}
    for entry in _stats_log:
        if entry["ts"] >= cutoff:
            uid = entry["manager_id"]
            counts[uid] = counts.get(uid, 0) + 1

    if not counts:
        return

    stats = []
    for uid, cnt in sorted(counts.items(), key=lambda x: x[1], reverse=True):
        stats.append({
            "manager": kommo.get_user_name(uid),
            "team": sheets.get_team(uid),
            "count": cnt,
        })
    sheets.write_daily_snapshot(today, stats)
    logger.info("Daily snapshot written: %d managers", len(stats))


scheduler = BackgroundScheduler(timezone="UTC")
scheduler.add_job(_check_overdue_leads, "interval", minutes=5)
scheduler.add_job(_write_daily_snapshot, "cron", hour=21, minute=55)
scheduler.start()
sheets.ensure_headers()

# In-memory: lead_id -> {transferred_at, manager, lead_name}
pending: dict[int, dict] = {}

# Stats log: list of {ts: datetime, manager_id: int}
_stats_log: list[dict] = []


def _parse_status(data: dict) -> dict | None:
    """Extract status change info. Returns dict with id/status_id/pipeline_id/responsible_user_id."""
    # JSON format
    if isinstance(data.get("leads"), dict):
        items = data["leads"].get("status", []) or data["leads"].get("add", [])
        if items and isinstance(items, list):
            return items[0]

    # Form-encoded format
    lead_id = data.get("leads[status][0][id]") or data.get("leads[add][0][id]")
    if lead_id:
        return {
            "id": int(lead_id),
            "status_id": int(data.get("leads[status][0][status_id]", 0)),
            "old_status_id": int(data.get("leads[status][0][old_status_id]", 0)),
            "pipeline_id": int(data.get("leads[status][0][pipeline_id]", 0)),
            "responsible_user_id": int(data.get("leads[status][0][responsible_user_id]", 0)),
        }
    return None


def _parse_responsible(data: dict) -> dict | None:
    """Extract responsible change event (Отв-й сделки изменен)."""
    lead_id = data.get("leads[responsible][0][id]")
    responsible_id = data.get("leads[responsible][0][responsible_user_id]")
    pipeline_id = data.get("leads[responsible][0][pipeline_id]")
    status_id = data.get("leads[responsible][0][status_id]")
    if lead_id:
        return {
            "id": int(lead_id),
            "responsible_user_id": int(responsible_id) if responsible_id else 0,
            "pipeline_id": int(pipeline_id) if pipeline_id else 0,
            "status_id": int(status_id) if status_id else 0,
        }
    return None


def _parse_note(data: dict) -> dict | None:
    """Extract call note info (note_type 10=call_in, 11=call_out)."""
    note_type = data.get("leads[note][0][note_type]")
    lead_id = data.get("leads[note][0][element_id]")
    user_id = data.get("leads[note][0][main_user_id]")
    if note_type and lead_id:
        return {
            "note_type": str(note_type),
            "lead_id": int(lead_id),
            "responsible_user_id": int(user_id) if user_id else 0,
        }
    return None


@app.route("/webhook", methods=["POST"])
def webhook():
    content_type = request.content_type or ""
    if "application/json" in content_type:
        data = request.get_json(force=True, silent=True) or {}
    else:
        data = request.form.to_dict()

    logger.info("Webhook received: %s", data)

    # ── Call note (Ringostat) ──────────────────────────────────────
    note = _parse_note(data)
    if note and note["note_type"] in ("10", "11"):
        _handle_call(note)
        return jsonify({"ok": True})

    # ── Responsible changed ───────────────────────────────────────
    resp_change = _parse_responsible(data)
    if resp_change:
        if (resp_change["pipeline_id"] == QUAL_PIPELINE_ID and
                resp_change["status_id"] == NEW_FROM_LIDOGEN):
            # Перевіряємо чи ліd не з "робочих" етапів
            lead = kommo.get_lead(resp_change["id"])
            old_status = lead.get("old_status_id", 0) if lead else 0
            if old_status not in SKIP_FROM_STATUSES:
                _handle_new_lead(resp_change["id"], resp_change["responsible_user_id"])
            else:
                logger.info("Skipped lead %s — came from excluded status %s", resp_change["id"], old_status)
        return jsonify({"ok": True})

    # ── Status change ─────────────────────────────────────────────
    item = _parse_status(data)
    if not item:
        logger.warning("Could not parse webhook payload")
        return jsonify({"ok": True})

    lead_id = int(item.get("id", 0))
    status_id = int(item.get("status_id", 0))
    old_status_id = int(item.get("old_status_id", 0))
    pipeline_id = int(item.get("pipeline_id", 0))
    responsible_id = int(item.get("responsible_user_id", 0))

    if pipeline_id != QUAL_PIPELINE_ID:
        return jsonify({"ok": True})

    if status_id == NEW_FROM_LIDOGEN:
        if old_status_id in SKIP_FROM_STATUSES:
            logger.info("Skipped lead %s — came from excluded status %s", lead_id, old_status_id)
        else:
            _handle_new_lead(lead_id, responsible_id)

    elif status_id == TAKEN_TO_WORK:
        _handle_taken(lead_id, responsible_id)

    return jsonify({"ok": True})


def _handle_new_lead(lead_id: int, responsible_id: int):
    lead = kommo.get_lead(lead_id)
    lead_name = lead.get("name", f"Лід #{lead_id}") if lead else f"Лід #{lead_id}"
    manager_name = kommo.get_user_name(responsible_id) if responsible_id else "—"
    now = datetime.now(timezone.utc)

    pending[lead_id] = {
        "transferred_at": now,
        "manager": manager_name,
        "lead_name": lead_name,
        "responsible_id": responsible_id,
        "reminded": False,
    }
    if responsible_id:
        _stats_log.append({"ts": now, "manager_id": responsible_id})

    kommo_url = f"https://utsercice.kommo.com/leads/detail/{lead_id}"
    tg_tag = notifier.get_manager_tag(responsible_id)
    msg = (
        f"📥 <b>Нова заявка від лідогенератора</b>\n"
        f"👤 Менеджер: <b>{manager_name}</b>{tg_tag}\n"
        f"🏷 Назва: {lead_name}\n"
        f"🔗 <a href='{kommo_url}'>Відкрити лід #{lead_id}</a>"
    )
    notifier.send_message(msg, with_stats_buttons=True)
    sheets.append_transfer(lead_id, lead_name, manager_name, now, manager_id=responsible_id)
    logger.info("New lead: %s → %s", lead_id, manager_name)


def _handle_taken(lead_id: int, responsible_id: int):
    now = datetime.now(timezone.utc)
    info = pending.get(lead_id)
    manager_name = kommo.get_user_name(responsible_id) if responsible_id else "—"
    tg_tag = notifier.get_manager_tag(responsible_id)

    if info:
        delta_min = (now - info["transferred_at"]).total_seconds() / 60
        lead_name = info["lead_name"]
        msg = (
            f"✅ <b>Лід взятий у роботу</b>\n"
            f"👤 Менеджер: <b>{manager_name}</b>{tg_tag}\n"
            f"🏷 Назва: {lead_name}\n"
            f"⏱ Час реакції: <b>{delta_min:.0f} хв</b>"
        )
    else:
        lead = kommo.get_lead(lead_id)
        lead_name = lead.get("name", f"Лід #{lead_id}") if lead else f"Лід #{lead_id}"
        msg = (
            f"✅ <b>Лід взятий у роботу</b>\n"
            f"👤 Менеджер: <b>{manager_name}</b>{tg_tag}\n"
            f"🏷 Назва: {lead_name}"
        )

    notifier.send_message(msg)
    sheets.update_taken(lead_id, now)
    logger.info("Taken to work: lead %s by %s", lead_id, manager_name)


def _handle_call(note: dict):
    lead_id = note["lead_id"]
    responsible_id = note["responsible_user_id"]
    note_type = note["note_type"]
    now = datetime.now(timezone.utc)

    info = pending.get(lead_id)
    manager_name = kommo.get_user_name(responsible_id) if responsible_id else "—"
    tg_tag = notifier.get_manager_tag(responsible_id)
    call_type = "вхідний" if note_type == "10" else "вихідний"

    if info:
        delta_min = (now - info["transferred_at"]).total_seconds() / 60
        lead_name = info["lead_name"]
        msg = (
            f"📞 <b>Перший дзвінок ({call_type})</b>\n"
            f"👤 Менеджер: <b>{manager_name}</b>{tg_tag}\n"
            f"🏷 Назва: {lead_name}\n"
            f"⏱ Від передачі: <b>{delta_min:.0f} хв</b>"
        )
        sheets.update_first_call(lead_id, now)
        pending.pop(lead_id, None)
    else:
        lead = kommo.get_lead(lead_id)
        lead_name = lead.get("name", f"Лід #{lead_id}") if lead else f"Лід #{lead_id}"
        msg = (
            f"📞 <b>Дзвінок ({call_type})</b>\n"
            f"👤 Менеджер: <b>{manager_name}</b>{tg_tag}\n"
            f"🏷 Назва: {lead_name}"
        )

    notifier.send_message(msg)
    logger.info("Call note: lead %s type %s by %s", lead_id, note_type, manager_name)


def _build_stats_text(days: int, label: str) -> str:
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    counts: dict[int, int] = {}
    for entry in _stats_log:
        if entry["ts"] >= cutoff:
            uid = entry["manager_id"]
            counts[uid] = counts.get(uid, 0) + 1

    if not counts:
        return f"📊 <b>Статистика ({label})</b>\nДаних немає"

    lines = [f"📊 <b>Статистика лідів від лідогенератора ({label})</b>\n"]
    sorted_counts = sorted(counts.items(), key=lambda x: x[1], reverse=True)
    for i, (uid, cnt) in enumerate(sorted_counts, 1):
        name = kommo.get_user_name(uid)
        tag = notifier.get_manager_tag(uid)
        lines.append(f"{i}. {name}{tag} — <b>{cnt}</b> лід{'ів' if cnt > 4 else 'и' if cnt > 1 else ''}")

    return "\n".join(lines)


@app.route("/tg-update", methods=["POST"])
def tg_update():
    """Telegram bot webhook — handles callback_query (button clicks)."""
    data = request.get_json(force=True, silent=True) or {}
    logger.info("TG update: %s", data)

    callback = data.get("callback_query")
    if not callback:
        return jsonify({"ok": True})

    cb_id = callback["id"]
    cb_data = callback.get("data", "")
    chat_id = callback["message"]["chat"]["id"]
    message_id = callback["message"]["message_id"]

    notifier.answer_callback(cb_id)

    if cb_data == "stats_today":
        text = _build_stats_text(days=1, label="сьогодні")
    elif cb_data == "stats_week":
        text = _build_stats_text(days=7, label="7 днів")
    elif cb_data == "stats_month":
        text = _build_stats_text(days=30, label="30 днів")
    else:
        return jsonify({"ok": True})

    notifier.send_stats_message(chat_id, text, message_id)
    return jsonify({"ok": True})


@app.route("/setup-tg-webhook", methods=["GET"])
def setup_tg_webhook():
    """Register Telegram bot webhook. Call once after deploy."""
    base_url = request.host_url.rstrip("/")
    result = notifier.set_webhook(f"{base_url}/tg-update")
    return jsonify(result)


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


@app.route("/test-tg", methods=["GET"])
def test_tg():
    result = notifier.test_bot()
    return jsonify(result)


@app.route("/daily", methods=["GET"])
def daily():
    msg = f"📊 <b>Щоденний звіт</b> за {datetime.now(timezone.utc).strftime('%d.%m.%Y')}\nОчікує обробки: {len(pending)} лідів"
    sent = notifier.send_message(msg)
    return jsonify({"ok": sent, "pending": len(pending)})


if __name__ == "__main__":
    app.run(debug=False)
