import os
import logging
import requests

logger = logging.getLogger(__name__)

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
MODEL = "claude-haiku-4-5-20251001"


def analyze_closed_deal(deal: dict) -> str:
    """
    Аналізує профіль закритої угоди і повертає рекомендацію для тімліда.
    deal = {name, manager, days_in_work, reject_reason, last_status, notes_count, calls_count, amount}
    """
    if not ANTHROPIC_API_KEY:
        logger.error("ANTHROPIC_API_KEY not set")
        return ""

    prompt = f"""КВП логістики. Оціни угоду (1-5 балів) та дай пораду тімліду.
Менеджер: {deal.get('manager','—')} | Причина: {deal.get('reject_reason') or '—'} | Етап: {deal.get('last_status') or '—'} | Днів: {deal.get('days_in_work') or '—'} | Дзвінків: {deal.get('calls_count',0)} | Нотаток: {deal.get('notes_count',0)} | Сума: {deal.get('amount',0):,}грн

СПОЧАТКУ ОБОВ'ЯЗКОВО рядки (саме на початку відповіді, без markdown):
"CLOSURE: ПЕРЕДЧАСНЕ - <конкретно що менеджер не зробив і де саме дотиснути клієнта, 1-2 речення>"
або "CLOSURE: ОБ'ЄКТИВНЕ - <чому закриття виправдане, 1 речення>"
"CATEGORY: <одна категорія: Не дотиснуто заперечення / Повільна реакція / Забув передзвонити / Об'єктивна відмова / Замало спроб контакту / Інше>"
"NEXTSTEP: <якщо ПЕРЕДЧАСНЕ — конкретна наступна дія менеджеру: що і коли зробити, яке заперечення й як саме відпрацювати, 1-2 речення; якщо ОБ'ЄКТИВНЕ — постав прочерк>"

ПОТІМ оцінка по критеріях: 1.Активність 2.Швидкість 3.Заперечення 4.Наполегливість 5.CRM
Формат: "1/5:коментар" для кожного. В кінці: "→ тімліду: ..." (1 речення).
Не використовуй markdown (зірочки, рішітки). Українська."""

    try:
        resp = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": MODEL,
                "max_tokens": 500,
                "messages": [{"role": "user", "content": prompt}],
            },
            timeout=30,
        )
        data = resp.json()
        if resp.ok:
            return data["content"][0]["text"].strip()
        else:
            logger.error("Claude API error: %s", data)
            return ""
    except Exception as e:
        logger.error("analyze_closed_deal: %s", e)
        return ""



def analyze_deal_calls(calls: list[dict], manager: str, lead_name: str = "") -> str:
    """Аналізує всю історію дзвінків по угоді (накопичену), а не лише один дзвінок."""
    if not ANTHROPIC_API_KEY or not calls:
        return ""

    history = ""
    for i, c in enumerate(calls, 1):
        transcript = (c.get("Транскрипт") or "")[:1500]
        history += (
            f"\n--- Дзвінок {i} ({c.get('Дата','')}, {c.get('Тип','')}, {c.get('Тривалість (с)','?')}с) ---\n{transcript}"
        )

    prompt = f"""КВП логістики. Угода: {lead_name or '—'} | Менеджер: {manager or '—'}.
Історія всіх дзвінків по угоді ({len(calls)} шт.):{history}

СПОЧАТКУ окремим рядком ОБОВ'ЯЗКОВО (на початку відповіді): "RISK: ТАК - <короткий привід тривоги в 1 речення>" або "RISK: НІ".
Важливо про оцінку ризику: укладання угоди в логістиці зазвичай вимагає 2-3+ дзвінків — це нормальний робочий процес, а не проблема. Не позначай ризиком ситуації, коли:
- менеджер сам домовився передзвонити пізніше (наступного дня/після уточнення) і ще не минув час для повторного дзвінка
- клієнт просто взяв час подумати без негативних сигналів
- це лише 1-2 дзвінок і немає явної відмови чи скарги
Позначай RISK: ТАК лише якщо є явний негативний сигнал: клієнт прямо відмовляється, скаржиться, каже що обрав конкурента/іншого перевізника, або з останнього дзвінка минуло вже багато часу (видно з дат дзвінків) без жодного повторного контакту з боку менеджера, хоча обіцяв передзвонити.

ПОТІМ дай зведену оцінку (2-3 короткі речення): як менеджер веде клієнта по всій історії спілкування, головні заперечення клієнта, чи прогрес у переговорах, що варто покращити.
Не використовуй markdown (зірочки, рішітки) — лише звичайний текст. Українська."""

    try:
        resp = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": MODEL,
                "max_tokens": 500,
                "messages": [{"role": "user", "content": prompt}],
            },
            timeout=30,
        )
        data = resp.json()
        if resp.ok:
            return data["content"][0]["text"].strip()
        else:
            logger.error("Claude API deal calls analysis error: %s", data)
            return ""
    except Exception as e:
        logger.error("analyze_deal_calls: %s", e)
        return ""


def analyze_first_touch(transcript: str, lead_name: str = "", manager: str = "") -> dict:
    """Оцінює ПЕРШИЙ дзвінок з рекламним клієнтом: чи розмова про перевезення,
    чи менеджер озвучив ціну (вартість перевезення) і чи відпрацював заперечення.
    Повертає {"about_transport": bool, "price_voiced": bool,
    "objections_handled": bool, "summary": str}."""
    empty = {"about_transport": False, "price_voiced": False, "objections_handled": False, "summary": ""}
    if not ANTHROPIC_API_KEY or not transcript:
        return dict(empty)

    prompt = f"""КВП логістики. Це ПЕРШИЙ дзвінок з клієнтом, що прийшов з реклами.
Угода: {lead_name or '—'} | Менеджер: {manager or '—'}.
Розшифровка дзвінка:
{transcript[:3000]}

Оціни строго за змістом розмови:
0) Чи розмова взагалі про вантажне ПЕРЕВЕЗЕННЯ (логістику, доставку вантажу)? Якщо це спам, помилковий номер, не про перевезення — TRANSPORT: НІ.
1) Чи менеджер озвучив клієнту ЦІНУ/вартість перевезення (конкретну суму, ставку або вилку цін)?
2) Чи відпрацював заперечення клієнта (сумніви щодо ціни, термінів, надійності тощо)? Якщо заперечень не було взагалі — вважай це як "НЕ БУЛО".

Відповідь рівно у форматі (без markdown):
TRANSPORT: ТАК або НІ
PRICE: ТАК або НІ
OBJECTIONS: ТАК або НІ або НЕ БУЛО
SUMMARY: <1-2 речення: що добре, що варто покращити в першому дотику>
Українська."""

    try:
        resp = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": MODEL,
                "max_tokens": 320,
                "messages": [{"role": "user", "content": prompt}],
            },
            timeout=30,
        )
        data = resp.json()
        if not resp.ok:
            logger.error("Claude API analyze_first_touch error: %s", data)
            return dict(empty)
        text = data["content"][0]["text"].strip()
        up = text.upper()
        import re as _re
        about_transport = bool(_re.search(r"TRANSPORT:\s*ТАК", up))
        price_voiced = bool(_re.search(r"PRICE:\s*ТАК", up))
        objections_handled = bool(_re.search(r"OBJECTIONS:\s*ТАК", up))
        sm = _re.search(r"SUMMARY:\s*(.+)", text, _re.DOTALL)
        summary = sm.group(1).strip() if sm else text
        return {
            "about_transport": about_transport,
            "price_voiced": price_voiced,
            "objections_handled": objections_handled,
            "summary": summary,
        }
    except Exception as e:
        logger.error("analyze_first_touch: %s", e)
        return dict(empty)


def check_target_lead(transcripts: list[str], lead_name: str = "", manager_note: str = "") -> dict:
    """
    Перевіряє, чи лід, закритий як 'Не цільові', дійсно нецільовий, чи клієнту
    потрібне вантажне перевезення (помилково закрито).
    Повертає {"is_target": bool, "reason": str}.
    """
    if not ANTHROPIC_API_KEY or not transcripts:
        return {"is_target": False, "reason": ""}

    calls_text = "\n\n".join(f"--- Дзвінок {i+1} ---\n{t[:1500]}" for i, t in enumerate(transcripts) if t)
    if not calls_text:
        return {"is_target": False, "reason": ""}

    note_block = (
        f"\nПримітка менеджера про причину закриття: \"{manager_note}\"\n"
        if manager_note else ""
    )

    prompt = f"""КВП логістики. Угода: {lead_name or '—'} закрита менеджером як "Не цільові" (нецільовий лід).
Розшифровки дзвінків:
{calls_text}
{note_block}
Перевір за змістом розмови: клієнту дійсно потрібне вантажне перевезення (нецільовий = неправильно закрито) чи це справді нецільове звернення (не про перевезення, спам, помилковий номер, не клієнт)?

Якщо менеджер вписав примітку з конкретною й правдоподібною причиною закриття (наприклад: клієнт сам має транспорт, вже скористався іншим перевізником, дзвінок не по темі перевезень, помилковий номер, дублікат заявки) — і ця причина узгоджується зі змістом дзвінків, довіряй цій причині та вважай лід дійсно нецільовим (TARGET: НІ), навіть якщо в розмові згадувалось перевезення. Повертай лід (TARGET: ТАК) лише тоді, коли дзвінки явно показують, що клієнту дійсно потрібне вантажне перевезення, а причина закриття не пояснена або не відповідає змісту розмови.

Відповідь рівно у форматі (без markdown):
TARGET: ТАК - <1 речення чому потрібне перевезення>
або
TARGET: НІ - <1 речення чому нецільовий>
Українська."""

    try:
        resp = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": MODEL,
                "max_tokens": 200,
                "messages": [{"role": "user", "content": prompt}],
            },
            timeout=30,
        )
        data = resp.json()
        if not resp.ok:
            logger.error("Claude API check_target_lead error: %s", data)
            return {"is_target": False, "reason": ""}
        text = data["content"][0]["text"].strip()
        is_target = text.upper().startswith("TARGET: ТАК") or "TARGET: ТАК" in text.upper()
        reason = text.split("-", 1)[1].strip() if "-" in text else text
        return {"is_target": is_target, "reason": reason}
    except Exception as e:
        logger.error("check_target_lead: %s", e)
        return {"is_target": False, "reason": ""}


def analyze_team_deals(team: str, deals: list[dict]) -> str:
    """
    Аналізує всі відмови команди за день і дає зведену рекомендацію тімліду.
    """
    if not ANTHROPIC_API_KEY or not deals:
        return ""

    deals_text = ""
    for d in deals:
        deals_text += (
            f"\n• {d.get('manager')}: \"{d.get('name')}\" | "
            f"причина: {d.get('reject_reason') or 'не вказана'} | "
            f"етап: {d.get('last_status') or '—'} | "
            f"днів: {d.get('days_in_work') or '?'} | "
            f"дзвінків: {d.get('calls_count', 0)}"
        )

    prompt = f"""Ти досвідчений керівник відділу продажу логістичної компанії.
Проаналізуй відмови команди {team} за сьогодні і дай тімліду зведені рекомендації.

Відмови ({len(deals)} угод):{deals_text}

Відповідь структуруй так:
1. Головна проблема команди сьогодні (1 речення)
2. Що обговорити на летючці (2-3 конкретних пункти)
3. Кому персонально приділити увагу і чому

Відповідай українською, коротко і по суті."""

    try:
        resp = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": MODEL,
                "max_tokens": 500,
                "messages": [{"role": "user", "content": prompt}],
            },
            timeout=30,
        )
        data = resp.json()
        if resp.ok:
            return data["content"][0]["text"].strip()
        else:
            logger.error("Claude API team analysis error: %s", data)
            return ""
    except Exception as e:
        logger.error("analyze_team_deals: %s", e)
        return ""
