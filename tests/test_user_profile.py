"""User-profile persistence and privacy checks; all files are synthetic."""

from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from notice_ai.schema import AIError
from notice_ai.user_profile import UserProfileStore


class UserProfileTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "portable" / "user-profile.json"
        self.store = UserProfileStore(self.path)

    def assert_code(self, code, function, *args, **kwargs):
        with self.assertRaises(AIError) as raised:
            function(*args, **kwargs)
        self.assertEqual(raised.exception.code, code)
        self.assertEqual(str(raised.exception), code)
        return raised.exception

    def test_reading_empty_profile_creates_no_files(self):
        snapshot = self.store.snapshot()
        self.assertEqual(snapshot["version"], 0)
        self.assertIsNone(snapshot["updatedAt"])
        self.assertIsNone(snapshot["grade"])
        self.assertEqual(set(snapshot["facts"]), {"degree", "admissionYear", "college", "major"})
        self.assertFalse(self.store.needs_personalization())
        self.assertEqual(self.store.model_context(), {"version": 0, "facts": {},
                                                     "preferences": {"interests": [], "avoid": []}})
        self.assertFalse(self.path.parent.exists())

    def test_confirmed_facts_and_open_preferences_round_trip(self):
        snapshot = self.store.update({
            "facts": {"degree": {"value": "undergraduate"}, "college": {"value": "  求是 学院  "},
                      "major": {"value": "信息技术", "confirmed": False}},
            "preferences": {"interests": ["奖学金机会", "志愿时长", "奖学金机会"]},
            "expectedVersion": 0,
        }, source="chat")
        self.assertEqual(snapshot["version"], 1)
        self.assertEqual(snapshot["facts"]["college"]["value"], "求是 学院")
        self.assertTrue(snapshot["facts"]["degree"]["confirmed"])
        self.assertEqual(snapshot["facts"]["degree"]["source"], "chat")
        self.assertEqual(snapshot["preferences"]["interests"], ["奖学金机会", "志愿时长"])
        self.assertEqual(UserProfileStore(self.path).snapshot(), snapshot)
        self.assertNotIn("grade", json.loads(self.path.read_text(encoding="utf-8")))
        self.assertTrue(self.store.needs_personalization())
        self.assertEqual(self.store.model_context()["facts"], {"degree": "undergraduate", "college": "求是 学院"})

    def test_model_context_and_snapshot_cannot_mutate_stored_profile(self):
        self.store.update({"preferences": {"interests": ["奖学金"]}})
        self.store.snapshot()["preferences"]["interests"].append("坏值")
        self.store.model_context()["preferences"]["interests"].clear()
        self.assertEqual(self.store.snapshot()["preferences"]["interests"], ["奖学金"])

    def test_student_number_only_adds_unconfirmed_year(self):
        student_number = "3250999999"
        snapshot = self.store.update({"studentNumber": student_number})
        self.assertEqual(snapshot["facts"]["admissionYear"]["value"], 2025)
        self.assertFalse(snapshot["facts"]["admissionYear"]["confirmed"])
        self.assertEqual(snapshot["facts"]["admissionYear"]["source"], "student_number")
        self.assertIsNone(snapshot["facts"]["degree"]["value"])
        self.assertEqual(self.store.model_context()["facts"], {})
        self.assertFalse(self.store.needs_personalization())
        for value in (snapshot, self.store.model_context(), json.loads(self.path.read_text(encoding="utf-8")),
                      json.loads(self.store.backup_path.read_text(encoding="utf-8"))):
            encoded = json.dumps(value)
            self.assertNotIn(student_number, encoded)
            self.assertNotIn("studentNumber", encoded)
        self.store.update({"facts": {"admissionYear": {"value": 2025}}})
        self.assertEqual(self.store.model_context()["facts"], {"admissionYear": 2025})

    def test_student_inference_does_not_replace_confirmed_year(self):
        self.store.update({"facts": {"admissionYear": {"value": 2024}}})
        snapshot = self.store.update({"studentNumber": "326"})
        self.assertEqual(snapshot["facts"]["admissionYear"]["value"], 2024)
        explicit = self.store.update({"studentNumber": "326", "facts": {"admissionYear": {"value": 2023}}})
        self.assertEqual(explicit["facts"]["admissionYear"]["value"], 2023)

    def test_grade_advances_at_september_boundary_in_school_timezone(self):
        self.store.update({"facts": {"admissionYear": {"value": 2025}}})
        zone = timezone(timedelta(hours=8))
        with patch("notice_ai.user_profile._now", return_value=datetime(2026, 8, 31, 23, 59, tzinfo=zone)):
            self.assertEqual(self.store.snapshot()["grade"], 1)
        with patch("notice_ai.user_profile._now", return_value=datetime(2026, 9, 1, tzinfo=zone)):
            self.assertEqual(self.store.snapshot()["grade"], 2)
        with patch("notice_ai.user_profile._now", return_value=datetime(2025, 8, 1, tzinfo=zone)):
            self.assertIsNone(self.store.snapshot()["grade"])

    def test_unknown_facts_do_not_become_confirmed(self):
        self.store.update({"facts": {"college": {"value": "信息学院"}}})
        snapshot = self.store.update({"facts": {"college": {"value": None, "confirmed": True}}})
        self.assertIsNone(snapshot["facts"]["college"]["value"])
        self.assertFalse(snapshot["facts"]["college"]["confirmed"])
        self.assertFalse(self.store.needs_personalization())

    def test_partial_preferences_preserve_other_list_and_noop_keeps_revision(self):
        first = self.store.update({"preferences": {"interests": ["志愿活动"], "avoid": ["活动回顾"]}})
        second = self.store.update({"preferences": {"interests": ["奖学金"]}})
        self.assertEqual(second["preferences"], {"interests": ["奖学金"], "avoid": ["活动回顾"]})
        self.assertEqual(second["version"], first["version"] + 1)
        self.assertEqual(self.store.update({"preferences": {"interests": ["奖学金"]}}), second)

    def test_expected_version_checks_updates_across_store_instances(self):
        other = UserProfileStore(self.path)
        self.store.update({"preferences": {"interests": ["竞赛"]}, "expectedVersion": 0})
        error = self.assert_code("profile_version_conflict", other.update,
                                 {"preferences": {"avoid": ["新闻"]}, "expectedVersion": 0})
        self.assertEqual(error.status, 409)
        self.assert_code("profile_version_conflict", other.clear, expected_version=0)
        self.assertEqual(other.snapshot()["version"], 1)

    def test_rejects_unknown_fields_invalid_types_and_sensitive_values_without_writes(self):
        bad = [
            {"password": "do-not-store"}, {"facts": {"account": {"value": "not-allowed"}}},
            {"facts": {"degree": {"value": "本科"}}},
            {"facts": {"admissionYear": {"value": True}}},
            {"facts": {"admissionYear": {"value": 1949}}},
            {"facts": {"college": {"value": "学院", "source": "forged"}}},
            {"facts": {"college": {"value": "学院", "confirmed": "yes"}}},
            {"facts": {"major": {"value": "a" * 121}}},
            {"preferences": {"interests": ["a"] * 13}},
            {"preferences": {"avoid": "新闻"}}, {"preferences": {"interests": [""]}},
            {"preferences": {"interests": ["sk-syntheticsecret12345"]}},
            {"preferences": {"interests": ["密码是不可保存"]}},
            {"preferences": {"interests": ["学号：3250999999"]}},
            {"preferences": {"interests": ["person@example.test"]}},
            {"preferences": {"interests": ["13800000000"]}},
            {"preferences": {"interests": ["line\nreturn"]}},
            {"preferences": {"interests": ["hidden\u202etext"]}},
            {"studentNumber": 3250999999}, {"studentNumber": "4251234567"},
            {"expectedVersion": True}, {"expectedVersion": -1},
        ]
        for value in bad:
            with self.subTest(value=list(value)):
                self.assert_code("profile_invalid", self.store.update, value)
        self.assert_code("profile_invalid", self.store.update, {}, source="cookie=secret")
        self.assertFalse(self.path.parent.exists())

    def test_primary_corruption_reads_backup_but_blocks_writes_and_model_context(self):
        first = self.store.update({"preferences": {"interests": ["旧偏好"]}})
        self.store.update({"preferences": {"interests": ["新偏好"]}})
        broken = b'{"broken":'
        self.path.write_bytes(broken)
        restored = UserProfileStore(self.path)
        snapshot = restored.snapshot()
        self.assertEqual(snapshot["storageError"], "profile_storage_error")
        self.assertEqual(snapshot["preferences"], first["preferences"])
        self.assert_code("profile_storage_error", restored.update, {"preferences": {"interests": ["覆盖"]}})
        self.assert_code("profile_storage_error", restored.model_context)
        self.assertFalse(restored.needs_personalization())
        self.assertEqual(self.path.read_bytes(), broken)

    def test_both_damaged_files_require_explicit_clear_and_leave_no_old_backup(self):
        self.store.update({"preferences": {"interests": ["画像旧值"]}})
        self.path.write_text("broken", encoding="utf-8")
        self.store.backup_path.write_text("broken backup", encoding="utf-8")
        self.assert_code("profile_storage_error", self.store.snapshot)
        self.assertFalse(self.store.needs_personalization())
        recovered = self.store.clear()
        self.assertEqual(recovered["version"], 2)
        self.assertNotIn("storageError", recovered)
        self.assertEqual(recovered["preferences"], {"interests": [], "avoid": []})
        self.assertEqual(self.path.read_bytes(), self.store.backup_path.read_bytes())
        self.assertNotIn("画像旧值", self.store.backup_path.read_text(encoding="utf-8"))

    def test_clear_success_removes_facts_preferences_from_primary_and_backup(self):
        self.store.update({"facts": {"college": {"value": "测试学院"}},
                           "preferences": {"interests": ["测试兴趣"]}})
        snapshot = self.store.clear(expected_version=1)
        self.assertEqual(snapshot["version"], 2)
        for path in (self.path, self.store.backup_path):
            content = path.read_text(encoding="utf-8")
            self.assertNotIn("测试学院", content)
            self.assertNotIn("测试兴趣", content)
        self.assertFalse(self.store.needs_personalization())

    def test_atomic_write_failure_leaves_previous_primary_intact(self):
        first = self.store.update({"preferences": {"interests": ["原有值"]}})
        old = self.path.read_bytes()
        with patch("notice_ai.user_profile.os.replace", side_effect=OSError("synthetic sensitive path")):
            self.assert_code("profile_storage_error", self.store.update, {"preferences": {"avoid": ["新闻"]}})
        self.assertEqual(self.path.read_bytes(), old)
        self.assertEqual(self.store.snapshot(), first)
        self.assertEqual(sorted(path.name for path in self.path.parent.iterdir()),
                         ["user-profile.json", "user-profile.json.bak"])

    def test_invalid_persisted_schema_and_duplicate_keys_are_not_overwritten(self):
        self.path.parent.mkdir(parents=True)
        for content in ('{"schemaVersion":1,"schemaVersion":2}', '{"value":NaN}', '[]', '"x"', "{" * 2000):
            with self.subTest(content=content[:20]):
                self.path.write_text(content, encoding="utf-8")
                broken = UserProfileStore(self.path)
                self.assert_code("profile_storage_error", broken.snapshot)
                self.assert_code("profile_storage_error", broken.update, {})
                self.assertEqual(self.path.read_text(encoding="utf-8"), content)


if __name__ == "__main__":
    unittest.main()
