"""Offline tests: no network, no audio - they exercise the joining logic.

Run with:  python -m pytest tests -q     (or: python tests/test_pipeline.py)
"""

import sys
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from kommo_client import KommoClient, attach_phones
from phones import match_key, to_e164_ua
from ringostat_client import Call, RingostatClient, index_by_phone
from transcribe import CLIENT, MANAGER, Segment, Transcript, roles_for_channels


class FakeResponse:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status_code = status
        self.ok = status < 400
        self.text = str(payload)

    def json(self):
        return self._payload


def lead_page(leads, has_next=False):
    return FakeResponse({
        "_embedded": {"leads": leads},
        "_links": {"next": {"href": "..."}} if has_next else {},
    })


class TestPhones(unittest.TestCase):
    def test_all_formats_share_one_key(self):
        variants = ["+38 (067) 123-45-67", "0671234567", "380671234567",
                    "80671234567", "+380671234567"]
        keys = {match_key(v) for v in variants}
        self.assertEqual(keys, {"671234567"})

    def test_short_extensions_do_not_produce_keys(self):
        self.assertEqual(match_key("101"), "")

    def test_e164(self):
        self.assertEqual(to_e164_ua("067 123 45 67"), "+380671234567")


class TestKommoLeadSelection(unittest.TestCase):
    def setUp(self):
        self.client = KommoClient("acme", "token", rate_limit_per_sec=0)

    def test_only_won_leads_in_target_pipeline_survive(self):
        raw = [
            {"id": 1, "name": "won-right-pipeline", "status_id": 142,
             "pipeline_id": 7, "closed_at": 100,
             "_embedded": {"contacts": [{"id": 11}]}},
            {"id": 2, "name": "lost", "status_id": 143, "pipeline_id": 7,
             "closed_at": 100, "_embedded": {"contacts": [{"id": 12}]}},
            {"id": 3, "name": "won-other-pipeline", "status_id": 142,
             "pipeline_id": 9, "closed_at": 100,
             "_embedded": {"contacts": [{"id": 13}]}},
        ]
        with patch.object(self.client.session, "get", return_value=lead_page(raw)):
            leads = self.client.won_leads(0, 999, pipeline_ids=[7])
        self.assertEqual([l.id for l in leads], [1])

    def test_pagination_follows_next_link(self):
        pages = [
            lead_page([{"id": i, "status_id": 142, "pipeline_id": 7,
                        "closed_at": 1, "_embedded": {"contacts": []}}
                       for i in range(1, 4)], has_next=True),
            lead_page([{"id": 4, "status_id": 142, "pipeline_id": 7,
                        "closed_at": 1, "_embedded": {"contacts": []}}]),
        ]
        with patch.object(self.client.session, "get", side_effect=pages):
            leads = self.client.won_leads(0, 999, pipeline_ids=[7])
        self.assertEqual([l.id for l in leads], [1, 2, 3, 4])

    def test_204_means_no_results(self):
        with patch.object(self.client.session, "get",
                          return_value=FakeResponse(None, status=204)):
            self.assertEqual(self.client.won_leads(0, 999), [])

    def test_phones_are_read_from_contacts(self):
        contacts = FakeResponse({"_embedded": {"contacts": [
            {"id": 11, "custom_fields_values": [
                {"field_code": "PHONE",
                 "values": [{"value": "067 123 45 67"}, {"value": "+380501112233"}]},
                {"field_code": "EMAIL", "values": [{"value": "a@b.c"}]},
            ]}]}, "_links": {}})
        from kommo_client import Lead
        leads = [Lead(id=1, name="x", price=0, pipeline_id=7, status_id=142,
                      responsible_user_id=0, created_at=0, closed_at=0,
                      contact_ids=[11])]
        with patch.object(self.client.session, "get", return_value=contacts):
            attach_phones(self.client, leads)
        self.assertEqual(leads[0].phones, ["+380671234567", "+380501112233"])
        self.assertEqual(leads[0].match_keys, ["671234567", "501112233"])


def make_call(cid, date_str, caller, callee, direction, duration=60,
              recording="http://rec/x.mp3"):
    return Call(id=cid, date=date_str, caller=caller, callee=callee,
                direction=direction, duration=duration,
                recording_url=recording, employee="", raw={})


class TestCallSelection(unittest.TestCase):
    def test_client_number_depends_on_direction(self):
        out = make_call("1", "d", "+380440001122", "+380671234567", "out")
        inb = make_call("2", "d", "+380671234567", "+380440001122", "in")
        self.assertEqual(out.client_number, "+380671234567")
        self.assertEqual(inb.client_number, "+380671234567")

    def test_keeps_five_most_recent_per_number(self):
        calls = [make_call(str(i), f"2026-08-{i:02d} 10:00",
                           "+380440001122", "+380671234567", "out")
                 for i in range(1, 9)]
        buckets = index_by_phone(iter(calls), {"671234567"},
                                 per_number=5, min_duration=15)
        dates = [c.date for c in buckets["671234567"]]
        self.assertEqual(len(dates), 5)
        self.assertEqual(dates, sorted(dates, reverse=True))
        self.assertTrue(dates[0].startswith("2026-08-08"))

    def test_drops_short_unrecorded_and_unrelated_calls(self):
        calls = [
            make_call("short", "2026-08-01", "+380440001122", "+380671234567",
                      "out", duration=4),
            make_call("norec", "2026-08-02", "+380440001122", "+380671234567",
                      "out", recording=""),
            make_call("other", "2026-08-03", "+380440001122", "+380509998877",
                      "out"),
            make_call("good", "2026-08-04", "+380440001122", "+380671234567",
                      "out"),
        ]
        buckets = index_by_phone(iter(calls), {"671234567"},
                                 per_number=5, min_duration=15)
        self.assertEqual([c.id for c in buckets["671234567"]], ["good"])


class TestRoleAssignment(unittest.TestCase):
    def test_direction_decides_which_channel_is_the_manager(self):
        self.assertEqual(roles_for_channels("out"), (MANAGER, CLIENT))
        self.assertEqual(roles_for_channels("in"), (CLIENT, MANAGER))

    def test_override_pins_the_mapping(self):
        self.assertEqual(roles_for_channels("in", "ch0_manager"), (MANAGER, CLIENT))
        self.assertEqual(roles_for_channels("out", "ch0_client"), (CLIENT, MANAGER))

    def test_channels_merge_into_one_chronological_dialogue(self):
        left = [Segment(0.0, 3.0, MANAGER, "Добрий день"),
                Segment(7.0, 9.0, MANAGER, "Записав")]
        right = [Segment(3.5, 6.5, CLIENT, "Вітаю"),
                 Segment(9.5, 11.0, CLIENT, "Дякую")]
        merged = Transcript(sorted(left + right, key=lambda s: s.start),
                            "uk", "high")
        self.assertEqual(
            merged.as_text().splitlines(),
            ["[00:00] Менеджер: Добрий день",
             "[00:03] Клієнт: Вітаю",
             "[00:07] Менеджер: Записав",
             "[00:09] Клієнт: Дякую"])

    def test_roundtrip_through_cache_keeps_roles(self):
        original = Transcript([Segment(0.0, 1.0, MANAGER, "а"),
                               Segment(1.0, 2.0, CLIENT, "б")], "uk", "high")
        data = original.to_dict()
        restored = Transcript(
            segments=[Segment(**s) for s in data["segments"]],
            language=data["language"], role_confidence=data["role_confidence"])
        self.assertEqual(restored.as_text(), original.as_text())


if __name__ == "__main__":
    unittest.main(verbosity=2)
