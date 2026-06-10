import os
import logging
from datetime import datetime, timezone
from flask import Flask, request, jsonify

import kommo
import notifier
import sheets

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

app = Flask(__name__)

# Kommo pipeline/status IDs
QUAL_PIPELINE_ID = 8921928
NEW_FROM_LIDOGEN = 69716164   # "НОВА ЗАЯВКА ВІД ЛІДОГЕНЕРАТОРА"
TAKEN_TO_WORK = 69693652      # "Лід взятий у роботу"

# In-memory: lead_id -> {transferred_at, manager, lead_name}
pending: dict[int, dict] = {}


def _parse_webhook(data: dict) -> dict | None:
    """
    Kommo sends webhooks in two formats:
    1. JSON:  {"leads": {"status": [{"id": ..., "status_id": ..., "pipeline_id": ..., "responsible_user_id": ...}]}}
    2. Form:  leads[status][0][id], leads[status][0][status_id], ...
    Returns normalised dict or None.
    """
    # JSON format
    if "leads" in data:
        items = data["leads"].get("status", [])
        if items:
            return items[0]
        items = data["leads"].get("add", [])
        if items:
            return items[0]

    # Form-encoded format (already parsed by Flask into flat dict)
    lead_id = (
        data.get("leads[status][0][id]")
        or data.get("leads[add][0][id]")
    )
    if lead_id:
        return {
            "id": int(lead_id),
            "status_id": int(data.get("leads[status][0][status_id]", 0)),
            "pipeline_id": int(data.get("leads[status][0][pipeline_id]", 0)),
            "responsible_user_id": int(data.get("leads[status][0][responsible_user_id]", 0)),
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

    item = _parse_webhook(data)
    if not item:
        logger.warning("Could not parse webhook payload")
        return jsonify({"ok": True})

    lead_id = int(item.get("id", 0))
    status_id = int(item.get("status_id", 0))
    pipeline_id = int(item.get("pipeline_id", 0))
    responsible_id = int(item.get("responsible_user_id", 0))

    if pipeline_id != QUAL_PIPELINE_ID:
        return jsonify({"ok": True})

    # ── Stage 1: lead arrived in Кваліфікація → НОВА ЗАЯВКА ВІД ЛІДОГЕНЕРАТОРА
    if status_id == NEW_FROM_LIDOGEN:
        lead = kommo.get_lead(lead_id)
        lead_name = lead.get("name", f"Ліd #{lead_id}") if lead else f"Ліd #{lead_id}"
        manager_name = kommo.get_user_name(responsible_id) if responsible_id else "—"

        now = datetime.now(timezone.utc)
        pending[lead_id] = {
            "transferred_at": now,
            "manager": manager_name,
            "lead_name": lead_name,
        }

        kommo_url = f"https://utsercice.kommo.com/leads/detail/{lead_id}"
        msg = (
            f"📥 <b>Нова заявка від лідогенератора</b>\n"
            f"👤 Менеджер: <b>{manager_name}</b>\n"
            f"🏷 Назва: {lead_name}\n"
            f"🔗 <a href='{kommo_url}'>Відкрити ліd #{lead_id}</a>"
        )
        notifier.send_message(msg)
        sheets.append_transfer(lead_id, lead_name, manager_name, now)
        logger.info("Stage 1 processed: lead %s → %s", lead_id, manager_name)

    # ── Stage 2: manager took the lead to work
    elif status_id == TAKEN_TO_WORK:
        now = datetime.now(timezone.utc)
        info = pending.get(lead_id)
        manager_name = kommo.get_user_name(responsible_id) if responsible_id else "—"

        if info:
            delta_min = (now - info["transferred_at"]).total_seconds() / 60
            lead_name = info["lead_name"]
            msg = (
                f"✅ <b>Ліd взятий у роботу</b>\n"
                f"👤 Менеджер: <b>{manager_name}</b>\n"
                f"🏷 Назва: {lead_name}\n"
                f"⏱ Час реакції: <b>{delta_min:.0f} хв</b>"
            )
        else:
            lead = kommo.get_lead(lead_id)
            lead_name = lead.get("name", f"Ліd #{lead_id}") if lead else f"Ліd #{lead_id}"
            msg = (
                f"✅ <b>Ліd взятий у роботу</b>\n"
                f"👤 Менеджер: <b>{manager_name}</b>\n"
                f"🏷 Назва: {lead_name}"
            )

        notifier.send_message(msg)
        sheets.update_taken(lead_id, now)
        logger.info("Stage 2 processed: lead %s taken by %s", lead_id, manager_name)

    return jsonify({"ok": True})


@app.route("/webhook/note", methods=["POST"])
def webhook_note():
    """Kommo note webhook for Ringostat call events."""
    content_type = request.content_type or ""
    if "application/json" in content_type:
        data = request.get_json(force=True, silent=True) or {}
    else:
        data = request.form.to_dict()

    logger.info("Note webhook: %s", data)

    # note[add][0][note_type] == 10 (call_in) or 11 (call_out)
    note_type = data.get("note[add][0][note_type]") or (
        data.get("notes", {}).get("add", [{}])[0].get("note_type") if "notes" in data else None
    )
    lead_id_raw = data.get("note[add][0][element_id]") or (
        data.get("notes", {}).get("add", [{}])[0].get("element_id") if "notes" in data else None
    )

    if note_type in ("10", "11", 10, 11) and lead_id_raw:
        lead_id = int(lead_id_raw)
        info = pending.get(lead_id)
        if info:
            now = datetime.now(timezone.utc)
            delta_min = (now - info["transferred_at"]).total_seconds() / 60
            manager_name = info["manager"]
            lead_name = info["lead_name"]
            call_type = "вхідний" if str(note_type) == "10" else "вихідний"
            msg = (
                f"📞 <b>Перший дзвінок ({call_type})</b>\n"
                f"👤 Менеджер: <b>{manager_name}</b>\n"
                f"🏷 Назва: {lead_name}\n"
                f"⏱ Від передачі: <b>{delta_min:.0f} хв</b>"
            )
            notifier.send_message(msg)
            sheets.update_first_call(lead_id, now)
            pending.pop(lead_id, None)

    return jsonify({"ok": True})


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


@app.route("/test-tg", methods=["GET"])
def test_tg():
    """Quick endpoint to verify Telegram config without touching Kommo."""
    result = notifier.test_bot()
    return jsonify(result)


@app.route("/daily", methods=["GET"])
def daily():
    """Trigger daily summary (called by UptimeRobot cron at 08:00)."""
    # Minimal implementation – extend as needed
    msg = f"📊 <b>Щоденний звіт</b> за {datetime.now(timezone.utc).strftime('%d.%m.%Y')}\nОчікує обробки: {len(pending)} лідів"
    sent = notifier.send_message(msg)
    return jsonify({"ok": sent, "pending": len(pending)})


if __name__ == "__main__":
    app.run(debug=False)
