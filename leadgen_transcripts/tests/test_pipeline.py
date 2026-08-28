"""Offline tests: no network, no audio - they exercise the joining logic.

Run with:  python -m pytest tests -q     (or: python tests/test_pipeline.py)
"""

import sys
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from config import Config
from kommo_client import KommoClient, KommoError, attach_phones
from phones import match_key, to_e164_ua
from leadgen_sheets import detect_subdomain, merge, parse_sheet
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

    def test_only_lead_gen_managers_survive(self):
        raw = [
            {"id": 1, "status_id": 142, "pipeline_id": 7, "closed_at": 1,
             "responsible_user_id": 501, "_embedded": {"contacts": []}},
            {"id": 2, "status_id": 142, "pipeline_id": 7, "closed_at": 1,
             "responsible_user_id": 999, "_embedded": {"contacts": []}},
            {"id": 3, "status_id": 142, "pipeline_id": 7, "closed_at": 1,
             "responsible_user_id": 502, "_embedded": {"contacts": []}},
        ]
        with patch.object(self.client.session, "get", return_value=lead_page(raw)):
            leads = self.client.won_leads(0, 999, responsible_user_ids=[501, 502])
        self.assertEqual([l.id for l in leads], [1, 3])

    def test_manager_names_resolve_to_ids(self):
        users = FakeResponse({"_embedded": {"users": [
            {"id": 501, "name": "Олег Коваленко"},
            {"id": 502, "name": "Ірина Мельник"},
            {"id": 999, "name": "Богдан Сидоренко"},
        ]}, "_links": {}})
        with patch.object(self.client.session, "get", return_value=users):
            self.assertEqual(
                self.client.resolve_managers(["олег", "Ірина Мельник"]),
                [501, 502])

    def test_unknown_manager_name_is_an_error_not_a_silent_skip(self):
        users = FakeResponse({"_embedded": {"users": [
            {"id": 501, "name": "Олег Коваленко"}]}, "_links": {}})
        with patch.object(self.client.session, "get", return_value=users):
            with self.assertRaises(KommoError):
                self.client.resolve_managers(["Не Існує"])

    def test_ambiguous_manager_name_is_an_error(self):
        users = FakeResponse({"_embedded": {"users": [
            {"id": 501, "name": "Олег Коваленко"},
            {"id": 502, "name": "Олег Шевченко"}]}, "_links": {}})
        with patch.object(self.client.session, "get", return_value=users):
            with self.assertRaises(KommoError):
                self.client.resolve_managers(["Олег"])

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


SHEET = """|  |  |  |
| :-: | :-: | :-: |
| Сердюк Ярослав | Шевчук Мирослава |  |
| \\[merged\\] 06.02.2026 | \\[merged\\] 06.02.2026 | \\[merged\\] 06.02.2026 |
| https://utsercice.kommo.com/leads/detail/61512525 | https://utsercice.kommo.com/leads/detail/61768893 |  |
| https://utsercice.kommo.com/leads/detail/61774673 |  |  |
| \\[merged\\] 09.02.2026 | \\[merged\\] 09.02.2026 | \\[merged\\] 09.02.2026 |
| https://utsercice.kommo.com/leads/detail/61781539 | https://utsercice.kommo.com/leads/detail/61780853 |  |
| Ніколаєнко Анастасія | Єресько Олександр |  |
| \\[merged\\] 03.03.2026 | \\[merged\\] 03.03.2026 | \\[merged\\] 03.03.2026 |
| https://utsercice.kommo.com/leads/detail/61999001 | https://utsercice.kommo.com/leads/detail/61999002 |  |
"""


class TestLeadGenSheets(unittest.TestCase):
    def setUp(self):
        self.deals = {d.lead_id: d for d in parse_sheet(SHEET, "report")}

    def test_deals_are_attributed_to_their_column_owner(self):
        self.assertEqual(self.deals[61512525].lead_gen, "Сердюк Ярослав")
        self.assertEqual(self.deals[61768893].lead_gen, "Шевчук Мирослава")
        self.assertEqual(self.deals[61774673].lead_gen, "Сердюк Ярослав")

    def test_date_rows_carry_down_to_the_deals_below_them(self):
        self.assertEqual(self.deals[61512525].report_date, "2026-02-06")
        self.assertEqual(self.deals[61774673].report_date, "2026-02-06")
        self.assertEqual(self.deals[61781539].report_date, "2026-02-09")

    def test_a_later_header_remaps_the_columns(self):
        # A new month block re-declares who owns each column.
        self.assertEqual(self.deals[61999001].lead_gen, "Ніколаєнко Анастасія")
        self.assertEqual(self.deals[61999002].lead_gen, "Єресько Олександр")
        self.assertEqual(self.deals[61999001].report_date, "2026-03-03")

    def test_subdomain_is_read_from_the_links(self):
        self.assertEqual(detect_subdomain(SHEET), "utsercice")

    def test_a_deal_listed_twice_is_counted_once(self):
        twice = SHEET + ("| https://utsercice.kommo.com/leads/detail/61512525 "
                         "|  |  |\n")
        ids = [d.lead_id for d in parse_sheet(twice)]
        self.assertEqual(len(ids), len(set(ids)))

    def test_merge_prefers_an_attributed_record(self):
        from leadgen_sheets import SheetDeal
        blind = [SheetDeal(1, "(unattributed)", "2026-01-01", "dashboard")]
        named = [SheetDeal(1, "Крупник Аліна", "2026-01-01", "report")]
        self.assertEqual(merge([blind, named])[0].lead_gen, "Крупник Аліна")
        self.assertEqual(merge([named, blind])[0].lead_gen, "Крупник Аліна")


class TestLeadsById(unittest.TestCase):
    def setUp(self):
        self.client = KommoClient("acme", "token", rate_limit_per_sec=0)

    def _raw(self, lead_id, status, closed_at):
        return {"id": lead_id, "name": f"deal-{lead_id}", "status_id": status,
                "pipeline_id": 7, "closed_at": closed_at,
                "responsible_user_id": 1, "_embedded": {"contacts": []}}

    def test_keeps_only_won_deals_closed_inside_the_window(self):
        raw = [
            self._raw(1, 142, 500),    # won, inside
            self._raw(2, 143, 500),    # lost
            self._raw(3, 142, 50),     # won but closed before the window
            self._raw(4, 142, 5000),   # won but closed after the window
            self._raw(5, 142, 900),    # won, inside
        ]
        with patch.object(self.client.session, "get", return_value=lead_page(raw)):
            leads = self.client.leads_by_id([1, 2, 3, 4, 5], won_only=True,
                                            closed_from=100, closed_to=1000)
        self.assertEqual([l.id for l in leads], [1, 5])

    def test_ids_missing_from_kommo_are_simply_absent(self):
        with patch.object(self.client.session, "get",
                          return_value=lead_page([self._raw(1, 142, 500)])):
            leads = self.client.leads_by_id([1, 2, 3], won_only=True)
        self.assertEqual([l.id for l in leads], [1])


class TestConfig(unittest.TestCase):
    def test_managers_split_into_ids_and_names(self):
        cfg = Config(kommo_managers=["123", "Олег Коваленко", "456"])
        self.assertEqual(cfg.split_managers(), ([123, 456], ["Олег Коваленко"]))


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
