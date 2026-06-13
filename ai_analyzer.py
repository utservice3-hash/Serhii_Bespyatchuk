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

    prompt = f"""Ти досвідчений керівник відділу продажу логістичної компанії.
Проаналізуй закриту угоду та дай коротку конкретну рекомендацію тімліду — що потрібно обговорити з менеджером.

Дані угоди:
- Менеджер: {deal.get('manager', '—')}
- Назва: {deal.get('name', '—')}
- Причина відмови: {deal.get('reject_reason') or 'не вказана'}
- Закрито з етапу: {deal.get('last_status') or '—'}
- Днів в роботі: {deal.get('days_in_work') or '—'}
- Дзвінків: {deal.get('calls_count', 0)}
- Нотаток: {deal.get('notes_count', 0)}
- Сума угоди: {deal.get('amount', 0):,} грн

Дай відповідь в 2-3 реченнях українською. Будь конкретним: що пішло не так і що тімліду сказати менеджеру."""

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
            logger.error("Claude API error: %s", data)
            return ""
    except Exception as e:
        logger.error("analyze_closed_deal: %s", e)
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
