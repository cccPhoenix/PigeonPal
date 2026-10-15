"""Focused offline checks for encrypted API catalogs; no real keys or network."""

import json
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from local_auth.vault import CredentialVault, VaultError
from local_service import LocalBackend
from notice_ai.config import AISettings
from notice_ai.schema import AIError


class AISettingsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name) / "ai"
        self.settings = AISettings(self.directory)

    def add(self, name="日常使用", key="invented-key-primary-1234", **kwargs):
        return self.settings.add({"name": name, "apiKey": key, **kwargs})

    def assert_error(self, code, operation):
        with self.assertRaises(AIError) as caught:
            operation()
        self.assertEqual(caught.exception.code, code)

    def test_empty_read_has_no_side_effect_and_first_profile_activates(self):
        self.assertFalse(self.directory.exists())
        self.assertFalse(self.settings.config.configured)
        added = self.add()
        self.assertEqual(added["activeProfileId"], added["createdProfileId"])
        self.assertEqual(self.settings.config.api_key, "invented-key-primary-1234")

    def test_adding_another_profile_keeps_selection_and_redacts_keys(self):
        first = self.add()
        second = self.add("备用", "invented-key-backup-5678")
        self.assertEqual(second["activeProfileId"], first["activeProfileId"])
        public = json.dumps(second, ensure_ascii=False)
        self.assertNotIn("invented-key-primary-1234", public)
        self.assertNotIn("invented-key-backup-5678", public)
        self.assertEqual(second["profiles"][1]["keyHint"], "•••• 5678")
        self.assertNotIn(b"invented-key", self.settings.vault.env_path.read_bytes())

    def test_selection_and_preferences_survive_restart(self):
        self.add()
        second = self.add("备用", "invented-key-backup-5678", model="alternate-model")
        self.settings.save({"automatic": False, "allowProtected": False})
        self.settings.select(second["createdProfileId"])
        restored = AISettings(self.directory)
        self.assertEqual(restored.config.api_key, "invented-key-backup-5678")
        self.assertEqual(restored.config.model, "alternate-model")
        self.assertFalse(restored.config.automatic)
        self.assertFalse(restored.config.allow_protected)

    def test_legacy_key_migrates_without_rewriting_on_read(self):
        vault = CredentialVault(self.directory)
        vault.save("deepseek-api", json.dumps({"apiKey": "invented-legacy-key-9876", "model": "legacy-model", "automatic": False}))
        original = vault.env_path.read_bytes()
        self.settings = AISettings(self.directory)
        self.assertEqual(vault.env_path.read_bytes(), original)
        self.assertEqual(self.settings.snapshot()["profiles"][0]["name"], "原有 DeepSeek 配置")
        self.add("新的备用", "invented-backup-key-1234")
        restored = AISettings(self.directory)
        self.assertEqual(len(restored.snapshot()["profiles"]), 2)
        self.assertEqual(restored.config.api_key, "invented-legacy-key-9876")
        self.assertFalse(restored.config.automatic)

    def test_checking_inactive_profile_does_not_select_it(self):
        first = self.add()
        second = self.add("备用", "invented-key-backup-5678")
        identity, config = self.settings.check_target(second["createdProfileId"])
        checked = self.settings.mark_verified(identity, config)
        self.assertEqual(checked["activeProfileId"], first["activeProfileId"])
        self.assertIsNotNone(checked["profiles"][1]["verifiedAt"])
        self.assertIsNotNone(AISettings(self.directory).snapshot()["profiles"][1]["verifiedAt"])
        self.settings.mark_verified(identity, config, success=False)
        self.assertIsNone(self.settings.snapshot()["profiles"][1]["verifiedAt"])

    def test_edit_can_keep_key_and_replacement_invalidates_verification(self):
        identity = self.add()["createdProfileId"]
        _, config = self.settings.check_target(identity)
        self.settings.mark_verified(identity, config)
        renamed = self.settings.update({"id": identity, "name": "新的名字", "apiKey": ""})
        self.assertIsNotNone(renamed["profiles"][0]["verifiedAt"])
        self.settings.update({"id": identity, "apiKey": "invented-replacement-5678"})
        self.assertIsNone(self.settings.snapshot()["profiles"][0]["verifiedAt"])
        self.assert_error("ai_configuration_changed", lambda: self.settings.mark_verified(identity, config))

    def test_deleting_active_profile_pauses_until_explicit_selection(self):
        first = self.add()["createdProfileId"]
        second = self.add("备用", "invented-key-backup-5678")["createdProfileId"]
        self.settings.delete(first)
        self.assertFalse(self.settings.config.configured)
        self.assertIsNone(AISettings(self.directory).snapshot()["activeProfileId"])
        self.add("第三份", "invented-third-key-9876")
        self.assertIsNone(self.settings.snapshot()["activeProfileId"])
        self.settings.select(second)
        self.assertTrue(self.settings.config.configured)

    def test_duplicate_configuration_and_missing_selection_are_rejected(self):
        self.add()
        self.assert_error("ai_profile_duplicate", self.add)
        self.assert_error("ai_profile_not_found", lambda: self.settings.select("missing"))
        self.add("同一个 Key 的不同模型", model="different-model")
        self.assertEqual(len(self.settings.snapshot()["profiles"]), 2)

    def test_failed_write_preserves_both_disk_and_active_profile(self):
        first = self.add()
        second = self.add("备用", "invented-key-backup-5678")
        original = self.settings.vault.env_path.read_bytes()
        with patch.object(self.settings.vault, "save", side_effect=VaultError("credential_write_failed")):
            self.assert_error("ai_settings_write_failed", lambda: self.settings.select(second["createdProfileId"]))
        self.assertEqual(self.settings.snapshot()["activeProfileId"], first["activeProfileId"])
        self.assertEqual(self.settings.vault.env_path.read_bytes(), original)

    def test_catalog_supports_bounded_multiple_long_keys(self):
        for index in range(20):
            self.add(f"配置 {index}", "invented-" + str(index) + "x" * 2800)
        self.assertGreater(self.settings.vault.env_path.stat().st_size, 65536)
        self.assertEqual(len(AISettings(self.directory).snapshot()["profiles"]), 20)
        self.assert_error("ai_profiles_full", self.add)
        with self.assertRaises(VaultError):
            CredentialVault(Path(self.temporary.name) / "campus").save("fictional-account", "x" * 4097)

    def test_damaged_catalog_requires_clear_instead_of_overwrite(self):
        self.settings.vault.save("deepseek-api", '{"schemaVersion": 99}')
        self.settings = AISettings(self.directory)
        original = self.settings.vault.env_path.read_bytes()
        self.assertEqual(self.settings.snapshot()["error"], "ai_settings_unavailable")
        self.assert_error("ai_settings_unavailable", self.add)
        self.assertEqual(self.settings.vault.env_path.read_bytes(), original)
        self.settings.clear()
        self.assertTrue(self.add()["configured"])

    def test_legacy_save_endpoint_edits_active_profile_and_preferences(self):
        created = self.settings.save({"apiKey": "invented-key-primary-1234"})
        self.settings.save({"apiKey": "", "model": "updated-model", "automaticDeadlines": False})
        self.assertEqual(self.settings.snapshot()["activeProfileId"], created["activeProfileId"])
        self.assertEqual(self.settings.config.model, "updated-model")
        self.assertFalse(self.settings.config.automatic_deadlines)

    def backend(self):
        backend = LocalBackend.__new__(LocalBackend)
        backend.ai_settings = self.settings
        backend.ai_settings_lock = threading.RLock()
        backend.ai = SimpleNamespace(config=self.settings.config, reconcile_deadlines=Mock())
        backend.ai.configure = Mock(side_effect=lambda config: setattr(backend.ai, "config", config))
        return backend

    def test_backend_applies_selection_but_not_inactive_catalog_edits(self):
        self.add()
        backend = self.backend()
        second = backend.change_ai(self.settings.add, {"name": "备用", "apiKey": "invented-backup-5678"})["createdProfileId"]
        backend.change_ai(self.settings.update, {"id": second, "name": "备用（已改名）"})
        backend.ai.configure.assert_not_called()
        backend.change_ai(self.settings.select, second)
        self.assertEqual(backend.ai.config.api_key, "invented-backup-5678")
        backend.ai.configure.assert_called_once()
        backend.change_ai(self.settings.delete, second)
        self.assertFalse(backend.ai.config.configured)

    def test_backend_check_failure_clears_stale_verification_without_switch(self):
        first = self.add()["createdProfileId"]
        second = self.add("备用", "invented-backup-5678")["createdProfileId"]
        backend = self.backend()
        with patch("local_service.ModelClient.check_connection", return_value={"ok": True}):
            result = backend.check_ai(second)
        self.assertIsNotNone(result["settings"]["profiles"][1]["verifiedAt"])
        with patch("local_service.ModelClient.check_connection", side_effect=AIError("ai_auth_failed")):
            self.assert_error("ai_auth_failed", lambda: backend.check_ai(second))
        self.assertEqual(self.settings.snapshot()["activeProfileId"], first)
        self.assertIsNone(self.settings.snapshot()["profiles"][1]["verifiedAt"])
        backend.ai.configure.assert_not_called()


if __name__ == "__main__":
    unittest.main()
