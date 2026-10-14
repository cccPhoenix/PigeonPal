"""Offline credential-storage checks using only invented test credentials."""

from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

from cryptography.fernet import Fernet

from scripts.local_auth.vault import CredentialVault, Credentials, VaultError


class CredentialVaultTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name) / "auth"
        self.vault = CredentialVault(self.directory)

    def test_empty_reads_do_not_create_files_and_repr_is_redacted(self):
        self.assertIsNone(self.vault.read())
        self.assertFalse(self.vault.exists())
        self.assertFalse(self.directory.exists())
        rendered = repr(Credentials("fictional-account", "fictional-secret"))
        self.assertNotIn("fictional-account", rendered)
        self.assertNotIn("fictional-secret", rendered)

    def test_ciphertext_roundtrip_restart_and_portable_copy(self):
        self.vault.save("fictional-account", "invented-password-测试")
        self.assertTrue(self.vault.exists())
        self.assertEqual(self.vault.read(), Credentials("fictional-account", "invented-password-测试"))
        env = self.vault.env_path.read_bytes()
        self.assertNotIn(b"fictional-account", env)
        self.assertNotIn(b"invented-password", env)
        self.assertEqual(
            {line.partition(b"=")[0] for line in env.splitlines()},
            {b"VERSION", b"ZJU_CREDENTIALS_ENCRYPTED"},
        )
        self.assertNotIn(self.vault.key_path.read_bytes().strip(), env)
        self.assertEqual(CredentialVault(self.directory).read(), self.vault.read())
        destination = Path(self.temporary.name) / "another-computer" / "auth"
        shutil.copytree(self.directory, destination)
        self.assertEqual(CredentialVault(destination).read(), self.vault.read())

    def test_damaged_or_missing_key_and_ciphertext_cannot_be_overwritten(self):
        self.vault.save("fictional-account", "fictional-secret")
        valid_env = self.vault.env_path.read_bytes()
        valid_key = self.vault.key_path.read_bytes()
        for damage, code in (
            ("missing_key", "credential_key_missing"),
            ("malformed_key", "credential_key_invalid"),
            ("wrong_key", "credential_decrypt_failed"),
            ("damaged_env", "credential_file_invalid"),
            ("damaged_ciphertext", "credential_decrypt_failed"),
            ("unknown_schema", "credential_schema_unsupported"),
        ):
            with self.subTest(damage=damage):
                self.vault.env_path.write_bytes(valid_env)
                self.vault.key_path.write_bytes(valid_key)
                if damage == "missing_key":
                    self.vault.key_path.unlink()
                elif damage == "malformed_key":
                    self.vault.key_path.write_bytes(b"not-a-key")
                elif damage == "wrong_key":
                    self.vault.key_path.write_bytes(Fernet.generate_key())
                elif damage == "damaged_env":
                    self.vault.env_path.write_bytes(b"broken")
                elif damage == "damaged_ciphertext":
                    self.vault.env_path.write_bytes(b"VERSION=1\nZJU_CREDENTIALS_ENCRYPTED=damaged\n")
                else:
                    self.vault.env_path.write_bytes(valid_env.replace(b"VERSION=1", b"VERSION=99"))
                before_env = self.vault.env_path.read_bytes()
                before_key = self.vault.key_path.read_bytes() if self.vault.key_path.exists() else None
                with self.assertRaises(VaultError) as caught:
                    self.vault.read()
                self.assertEqual(str(caught.exception), code)
                self.assertEqual(caught.exception.code, code)
                with self.assertRaises(VaultError):
                    self.vault.save("new-fictional-account", "new-fictional-secret")
                self.assertEqual(self.vault.env_path.read_bytes(), before_env)
                self.assertEqual(self.vault.key_path.read_bytes() if self.vault.key_path.exists() else None, before_key)

    def test_failed_replace_preserves_previous_binding_and_cleans_temp(self):
        self.vault.save("old-fictional-account", "old-fictional-secret")
        old_env = self.vault.env_path.read_bytes()
        old_key = self.vault.key_path.read_bytes()
        with patch("scripts.local_auth.vault.os.replace", side_effect=OSError("invented filesystem error")):
            with self.assertRaisesRegex(VaultError, "^credential_write_failed$"):
                self.vault.save("new-fictional-account", "new-fictional-secret")
        self.assertEqual(self.vault.env_path.read_bytes(), old_env)
        self.assertEqual(self.vault.key_path.read_bytes(), old_key)
        self.assertEqual(self.vault.read(), Credentials("old-fictional-account", "old-fictional-secret"))
        self.assertEqual(list(self.directory.glob("*.tmp")), [])

    def test_failed_initial_save_leaves_reusable_key_without_binding(self):
        import scripts.local_auth.vault as vault_module
        original = vault_module.os.replace

        def fail_env(source, target):
            if Path(target) == self.vault.env_path:
                raise OSError("invented interrupted save")
            return original(source, target)

        with patch.object(vault_module.os, "replace", side_effect=fail_env):
            with self.assertRaisesRegex(VaultError, "^credential_write_failed$"):
                self.vault.save("fictional-account", "fictional-secret")
        self.assertFalse(self.vault.exists())
        self.assertIsNone(self.vault.read())
        key = self.vault.key_path.read_bytes()
        self.vault.save("fictional-account", "fictional-secret")
        self.assertEqual(self.vault.key_path.read_bytes(), key)

    def test_invalid_input_never_changes_existing_binding(self):
        self.vault.save("fictional-account", "fictional-secret")
        original = self.vault.env_path.read_bytes()
        for username, password in ((" ", "secret"), ("account", ""), (None, "secret"), ("account", None)):
            with self.subTest(username=username, password=password):
                with self.assertRaisesRegex(VaultError, "^credential_input_invalid$"):
                    self.vault.save(username, password)
                self.assertEqual(self.vault.env_path.read_bytes(), original)

    def test_clear_removes_only_fixed_credential_files_and_is_idempotent(self):
        self.vault.save("fictional-account", "fictional-secret")
        unrelated = self.directory / "notices.json"
        unrelated.write_text("[]", encoding="utf-8")
        self.vault.clear()
        self.vault.clear()
        self.assertFalse(self.vault.exists())
        self.assertIsNone(self.vault.read())
        self.assertFalse(self.vault.key_path.exists())
        self.assertEqual(unrelated.read_text("utf-8"), "[]")


if __name__ == "__main__":
    unittest.main()
