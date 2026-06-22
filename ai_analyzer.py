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
Критерії: 1.Активність 2.Швидкість 3.Заперечення 4.Наполегливість 5.CRM
Формат: "1/5:коментар" для кожного. Потім: "→ тімліду: ..." (1 речення). Українська."""

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
                "max_tokens": 250,
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
            f"\n--- Дзвінок {i} ({c.get('Тип','')}, {c.get('Тривалість (с)','?')}с) ---\n{transcript}"
        )

    prompt = f"""КВП логістики. Угода: {lead_name or '—'} | Менеджер: {manager or '—'}.
Історія всіх дзвінків по угоді ({len(calls)} шт.):{history}

Дай зведену оцінку (3-4 речення): як менеджер веде клієнта по всій історії спілкування, головні заперечення клієнта, чи прогрес у переговорах, що варто покращити. Українська."""

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
                "max_tokens": 300,
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
