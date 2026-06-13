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

PEREVOZY_PIPELINE_ID = 8921932  # Перевозки (Продажі повний цикл)
CLOSED_NOT_REALIZED = 143        # ЗАКРИТО І НЕ РЕАЛІЗОВАНО

# Етапи з нерозібраними заявками (без відповідального)
UNASSIGNED_STATUSES = {
    69693648: "Неразобранное",
    69693656: "Дзвінки",
    69693660: "Дзвінки з сайту",
    69716160: "Дзвінок по пропущеному (реклама)",
}
ADMIN_USER_ID = 904923  # Admin — означає немає реального відповідального

# Всі керівники для тегу в нерозібраних заявках
ALL_SUPERVISORS = "@dmytro_yatsyk @Logist_dmytruk @Andry_UTS @darina_mx @lillly_aaa"

# In-memory: lead_id -> {arrived_at, status_name, lead_name, last_reminded_count}
unassigned: dict[int, dict] = {}

# Менеджери команд Дарини і Андрія
DARINA_ANDRIY_TEAMS = {
    # Команда Михальчевської
    12782896, 13461608, 13803600, 14083284, 14431884,
    14926076, 15227544, 15227596, 15279220, 12812476,
    # Команда Безпам'ятного
    12644448, 13689696, 11293904, 15192136, 15354656,
    15354672, 15355168, 15380780, 15391908,
}

# Етапи з яких повторна передача НЕ викликає сповіщення
SKIP_FROM_STATUSES = {
    69693652,  # Лід взятий у роботу
    69693656,  # Дзвінки
    69693660,  # Дзвінки з сайту
    70419108,  # Дзвінки на мобільні
}

# Керівник для кожного менеджера: {manager_id: supervisor_tg}
SUPERVISOR_MAP = {
    # Команда Яцика (керівник @dmytro_yatsyk)
    2013613:  "@dmytro_yatsyk",   # Антипенко Олег
    7347414:  "@dmytro_yatsyk",   # Свіржевський Артем
    10022700: "@dmytro_yatsyk",   # Мокляк Олександр
    11739992: "@dmytro_yatsyk",   # Хомік Вікторія
    12163420: "@dmytro_yatsyk",   # Семенюк Дмитро

    # Команда Дмитрука (керівник @Logist_dmytruk)
    7863771:  "@Logist_dmytruk",  # Возович Антон
    11295244: "@Logist_dmytruk",  # Самохвалов Сергій
    11338832: "@Logist_dmytruk",  # Федоровський Іван

    # Команда Безпам'ятного (керівник @Andry_UTS)
    13689696: "@Andry_UTS",       # Чукін Євген
    11293904: "@Andry_UTS",       # Крицька Діана
    15192136: "@Andry_UTS",       # Палій Тарас
    15354656: "@Andry_UTS",       # Шендера Анастасія
    15354672: "@Andry_UTS",       # Борівець Олеся
    15355168: "@Andry_UTS",       # Голоміна Олександра
    15380780: "@Andry_UTS",       # Ворошилова Вікторія
    15391908: "@Andry_UTS",       # Коваль Катерина

    # Команда Михальчевської (керівник @darina_mx)
    13461608: "@darina_mx",       # Андрусенко Богдана
    13803600: "@darina_mx",       # Цалко Олександр
    14083284: "@darina_mx",       # Гофман Іван
    14431884: "@darina_mx",       # Янчевський Едуард
    14926076: "@darina_mx",       # Панасюк Святослав
    15227544: "@darina_mx",       # Герелевич Аліна
    15227596: "@darina_mx",       # Пехньо Ксенія
    15279220: "@darina_mx",       # Сугак Денис
    12812476: "@darina_mx",       # Сердюк Ярослав

    # Команда Шаврової (керівник @lillly_aaa)
    15040472: "@lillly_aaa",      # Мацалак Андрій
    15200560: "@lillly_aaa",      # Сенів Тетяна
    15380676: "@lillly_aaa",      # Братейко Ірина
    15414956: "@lillly_aaa",      # Гаркушина Юлія

    # Тендерний відділ (керівник @dmytro_yatsyk)
    15317728: "@dmytro_yatsyk",   # Денисенко Микита
    15336060: "@dmytro_yatsyk",   # Дьяков Денис
    7181916:  "@dmytro_yatsyk",   # Шевчук Назар
}


def _is_working_hours() -> bool:
    """Пн–Пт, 09:00–18:30 за Києвом (UTC+3)."""
    now_kyiv = datetime.now(timezone.utc) + timedelta(hours=3)
    if now_kyiv.weekday() >= 5:  # субота=5, неділя=6
        return False
    h, m = now_kyiv.hour, now_kyiv.minute
    return (h > 9 or (h == 9 and m >= 0)) and (h < 18 or (h == 18 and m <= 30))


def _check_overdue_leads():
    """Runs every 5 min — reminds about leads not called within 20 min, then every 20 min until taken.
    Only sends between 09:00 and 18:30 Kyiv time, Mon–Fri."""
    if not _is_working_hours():
        return

    for lead_id, info in list(pending.items()):
        age_min = (now - info["transferred_at"]).total_seconds() / 60
        if age_min < REMINDER_MINUTES:
            continue

        # Fire every 20 min: at 20, 40, 60, 80... minutes
        reminder_count = int(age_min // REMINDER_MINUTES)
        last_reminded = info.get("last_reminded_count", 0)
        if reminder_count <= last_reminded:
            continue

        responsible_id = info.get("responsible_id", 0)
        manager_name = info.get("manager", kommo.get_user_name(responsible_id))
        tg_tag = notifier.get_manager_tag(responsible_id)
        supervisor_tag = SUPERVISOR_MAP.get(responsible_id, "")
        lead_name = info.get("lead_name", f"Лід #{lead_id}")
        kommo_url = f"https://utsercice.kommo.com/leads/detail/{lead_id}"

        sup_part = f" {supervisor_tag}" if supervisor_tag else ""
        msg = (
            f"🚨 <b>Лід не опрацьований {age_min:.0f} хв!</b>\n"
            f"👤 Менеджер: <b>{manager_name}</b>{tg_tag}{sup_part}\n"
            f"🏷 Назва: {lead_name}\n"
            f"❓ Чому не опрацьований лід?\n"
            f"🔗 <a href='{kommo_url}'>Відкрити лід #{lead_id}</a>"
        )
        notifier.send_message(msg)
        pending[lead_id]["last_reminded_count"] = reminder_count
        logger.info("Reminder #%d sent for lead %s (%.0f min)", reminder_count, lead_id, age_min)


def _scan_unassigned_leads():
    """Scans Kommo API for unassigned leads in Кваліфікація and adds new ones to queue."""
    now = datetime.now(timezone.utc)
    for status_id, status_name in UNASSIGNED_STATUSES.items():
        try:
            leads = kommo.get_pipeline_leads(QUAL_PIPELINE_ID, status_id=status_id)
            for lead in leads:
                lid = lead.get("id")
                uid = lead.get("responsible_user_id", 0)
                if not lid or (uid and uid != ADMIN_USER_ID):
                    continue
                if lid in unassigned:
                    continue
                lead_name = lead.get("name", f"Лід #{lid}")
                unassigned[lid] = {
                    "arrived_at": now,
                    "status_name": status_name,
                    "lead_name": lead_name,
                    "last_reminded_count": 0,
                }
                logger.info("Scan found unassigned lead %s in %s", lid, status_name)
        except Exception as e:
            logger.error("_scan_unassigned_leads: %s", e)


def _check_unassigned_leads():
    """Runs every 15 min — scans CRM for unassigned leads, then sends reminders."""
    if not _is_working_hours():
        return

    _scan_unassigned_leads()

    now = datetime.now(timezone.utc)
    for lead_id, info in list(unassigned.items()):
        age_min = (now - info["arrived_at"]).total_seconds() / 60
        if age_min < 15:
            continue

        reminder_count = int(age_min // 15)
        if reminder_count <= info.get("last_reminded_count", 0):
            continue

        kommo_url = f"https://utsercice.kommo.com/leads/detail/{lead_id}"
        msg = (
            f"📬 <b>Нерозібрана заявка!</b>\n"
            f"🏷 Назва: {info['lead_name']}\n"
            f"📍 Етап: {info['status_name']}\n"
            f"⏱ Очікує: <b>{age_min:.0f} хв</b>\n"
            f"👥 {ALL_SUPERVISORS}\n"
            f"🔗 <a href='{kommo_url}'>Відкрити лід #{lead_id}</a>"
        )
        notifier.send_to_rnk(msg)
        unassigned[lead_id]["last_reminded_count"] = reminder_count
        logger.info("Unassigned reminder for lead %s (%.0f min)", lead_id, age_min)


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
scheduler.add_job(_check_unassigned_leads, "interval", minutes=15)
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
    if note and note["note_type"] in ("10", "11", "call_in", "call_out"):
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

    # Нерозібрані заявки — лід отримав реального відповідального → прибираємо з черги
    if lead_id in unassigned and responsible_id and responsible_id != ADMIN_USER_ID:
        unassigned.pop(lead_id, None)
        logger.info("Lead %s assigned — removed from unassigned queue", lead_id)

    if pipeline_id == PEREVOZY_PIPELINE_ID:
        if status_id == CLOSED_NOT_REALIZED and responsible_id in DARINA_ANDRIY_TEAMS:
            _handle_closed_not_realized(lead_id, responsible_id)
        return jsonify({"ok": True})

    if pipeline_id != QUAL_PIPELINE_ID:
        return jsonify({"ok": True})

    # Нерозібрана заявка — лід без відповідального в одному з цих етапів
    if status_id in UNASSIGNED_STATUSES and (not responsible_id or responsible_id == ADMIN_USER_ID):
        _handle_unassigned(lead_id, status_id)

    if status_id == NEW_FROM_LIDOGEN:
        if old_status_id in SKIP_FROM_STATUSES:
            logger.info("Skipped lead %s — came from excluded status %s", lead_id, old_status_id)
        else:
            _handle_new_lead(lead_id, responsible_id)

    elif status_id == TAKEN_TO_WORK:
        is_lidogen = lead_id in pending
        _handle_taken(lead_id, responsible_id)
        if not is_lidogen:
            _handle_rnk_event(lead_id, responsible_id, "🟢 Лід взятий у роботу")

    elif status_id == 69693656:  # Дзвінки
        _handle_rnk_event(lead_id, responsible_id, "📞 Дзвінки")

    elif status_id == 69693660:  # Дзвінки з сайту
        _handle_rnk_event(lead_id, responsible_id, "🌐 Дзвінки з сайту")

    return jsonify({"ok": True})


def _handle_unassigned(lead_id: int, status_id: int):
    now = datetime.now(timezone.utc)
    if lead_id in unassigned:
        return  # вже в черзі

    lead = kommo.get_lead(lead_id)
    lead_name = lead.get("name", f"Лід #{lead_id}") if lead else f"Лід #{lead_id}"
    source = kommo.get_lead_source(lead) if lead else ""
    status_name = UNASSIGNED_STATUSES.get(status_id, "—")
    kommo_url = f"https://utsercice.kommo.com/leads/detail/{lead_id}"

    source_line = f"\n🌐 Джерело: {source}" if source else ""
    msg = (
        f"📬 <b>Нерозібрана заявка!</b>\n"
        f"🏷 Назва: {lead_name}\n"
        f"📍 Етап: {status_name}{source_line}\n"
        f"⏱ Щойно надійшла\n"
        f"👥 {ALL_SUPERVISORS}\n"
        f"🔗 <a href='{kommo_url}'>Відкрити лід #{lead_id}</a>"
    )
    notifier.send_to_rnk(msg)

    unassigned[lead_id] = {
        "arrived_at": now,
        "status_name": status_name,
        "lead_name": lead_name,
        "last_reminded_count": 0,
    }
    logger.info("Unassigned lead %s in status %s", lead_id, status_name)


def _handle_closed_not_realized(lead_id: int, responsible_id: int):
    details = kommo.get_lead_details(lead_id)
    manager_name = kommo.get_user_name(responsible_id) if responsible_id else "—"
    tg_tag = notifier.get_manager_tag(responsible_id)
    supervisor_tag = SUPERVISOR_MAP.get(responsible_id, "")
    kommo_url = f"https://utsercice.kommo.com/leads/detail/{lead_id}"

    sup_part = f" {supervisor_tag}" if supervisor_tag else ""
    days = f"{details['days_in_work']} дн." if details["days_in_work"] is not None else "—"
    reason = details["reject_reason"] or "не вказана"
    last_status = details["last_status"] or "—"
    notes = details["notes_count"]
    calls = details["calls_count"]

    activity = "✅ Була активність" if (notes > 0 or calls > 0) else "🚫 Активності не було"

    msg = (
        f"❌ <b>Закрито і не реалізовано</b>\n"
        f"👤 Менеджер: <b>{manager_name}</b>{tg_tag}{sup_part}\n"
        f"🏷 Назва: {details['name']}\n"
        f"📋 Причина: {reason}\n"
        f"🔀 Закрито з етапу: {last_status}\n"
        f"📞 Дзвінків: <b>{calls}</b> | Нотаток: <b>{notes}</b>\n"
        f"📅 Днів в роботі: <b>{days}</b>\n"
        f"{activity}\n"
        f"🔗 <a href='{kommo_url}'>Відкрити угоду #{lead_id}</a>"
    )
    notifier.send_to_rnk(msg)
    logger.info("Closed not realized: lead %s by %s", lead_id, manager_name)


def _handle_rnk_event(lead_id: int, responsible_id: int, label: str):
    lead = kommo.get_lead(lead_id)
    lead_name = lead.get("name", f"Лід #{lead_id}") if lead else f"Лід #{lead_id}"
    manager_name = kommo.get_user_name(responsible_id) if responsible_id else "—"
    tg_tag = notifier.get_manager_tag(responsible_id)
    kommo_url = f"https://utsercice.kommo.com/leads/detail/{lead_id}"
    msg = (
        f"{label}\n"
        f"👤 Менеджер: <b>{manager_name}</b>{tg_tag}\n"
        f"🏷 Назва: {lead_name}\n"
        f"🔗 <a href='{kommo_url}'>Відкрити лід #{lead_id}</a>"
    )
    notifier.send_to_rnk(msg)
    logger.info("RNK event: %s lead %s by %s", label, lead_id, manager_name)


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

    source = kommo.get_lead_source(lead) if lead else ""
    kommo_url = f"https://utsercice.kommo.com/leads/detail/{lead_id}"
    tg_tag = notifier.get_manager_tag(responsible_id)
    source_line = f"\n🌐 Джерело: {source}" if source else ""
    msg = (
        f"📥 <b>Нова заявка від лідогенератора</b>\n"
        f"👤 Менеджер: <b>{manager_name}</b>{tg_tag}\n"
        f"🏷 Назва: {lead_name}{source_line}\n"
        f"🔗 <a href='{kommo_url}'>Відкрити лід #{lead_id}</a>"
    )
    if _is_working_hours():
        notifier.send_message(msg, with_stats_buttons=True)
    sheets.append_transfer(lead_id, lead_name, manager_name, now, manager_id=responsible_id)
    logger.info("New lead: %s → %s", lead_id, manager_name)


def _handle_taken(lead_id: int, responsible_id: int):
    now = datetime.now(timezone.utc)
    info = pending.get(lead_id)
    manager_name = kommo.get_user_name(responsible_id) if responsible_id else "—"
    tg_tag = notifier.get_manager_tag(responsible_id)

    if info:
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
        sheets.update_first_call(lead_id, now)
        pending.pop(lead_id, None)
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
