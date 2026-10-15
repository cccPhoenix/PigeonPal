"""Portable, local credential storage; no platform account or unlock password.

The key intentionally lives beside the encrypted .env file. This prevents
accidental plaintext disclosure, but anyone who can read both files can decrypt
the credentials. The application must exclude the entire directory from Git,
exports and ordinary data backups.
"""

from dataclasses import dataclass
import json
import os
from pathlib import Path
import tempfile
import threading

from cryptography.fernet import Fernet, InvalidToken


_ERROR_CODES = frozenset({
    "credential_input_invalid",
    "credential_file_invalid",
    "credential_schema_unsupported",
    "credential_key_missing",
    "credential_key_invalid",
    "credential_decrypt_failed",
    "credential_read_failed",
    "credential_write_failed",
    "credential_clear_failed",
})
_MAX_ENV_BYTES = 65536
_MAX_KEY_BYTES = 128
_LOCKS: dict[str, threading.RLock] = {}
_LOCKS_GUARD = threading.Lock()


class VaultError(RuntimeError):
    """Only fixed codes may escape storage operations; never raw exceptions."""

    def __init__(self, code: str):
        self.code = code if code in _ERROR_CODES else "credential_read_failed"
        super().__init__(self.code)


@dataclass(frozen=True, repr=False)
class Credentials:
    username: str
    password: str

    def __repr__(self):
        return "Credentials(<redacted>)"


def _private_mode(path: Path, mode: int) -> None:
    # chmod is advisory on Windows. Do not bind storage to an OS user/keychain.
    try:
        os.chmod(path, mode)
    except OSError:
        pass


def _credentials(username: str, password: str, *, password_limit: int = 4096) -> Credentials:
    if (
        not isinstance(username, str)
        or not isinstance(password, str)
        or not username.strip()
        or not password
        or len(username) > 256
        or len(password) > password_limit
    ):
        raise VaultError("credential_input_invalid")
    return Credentials(username, password)


class CredentialVault:
    """One .env ciphertext and one .auth-key in a caller-selected directory."""

    def __init__(self, directory: Path, *, password_limit: int = 4096):
        if type(password_limit) is not int or not 1 <= password_limit <= 131072:
            raise ValueError("invalid_password_limit")
        # Campus credentials retain their original limits. The separate AI vault
        # can opt into a bounded larger encrypted configuration catalog.
        self.password_limit = password_limit
        self.env_limit = max(_MAX_ENV_BYTES, password_limit * 8)
        self.directory = Path(directory)
        self.env_path = self.directory / ".env"
        self.key_path = self.directory / ".auth-key"
        # Local server requests can use distinct instances without racing writes.
        # The server remains the sole process writing its authentication directory.
        identity = os.path.normcase(os.path.abspath(self.directory))
        with _LOCKS_GUARD:
            self._lock = _LOCKS.setdefault(identity, threading.RLock())

    def _check_directory(self, error: str) -> None:
        try:
            if self.directory.is_symlink():
                raise VaultError(error)
            if self.directory.exists() and not self.directory.is_dir():
                raise VaultError(error)
        except OSError:
            raise VaultError(error) from None

    def _read_file(self, path: Path, limit: int, invalid_code: str) -> bytes:
        try:
            if path.is_symlink() or not path.is_file():
                raise VaultError(invalid_code)
            with path.open("rb") as stream:
                contents = stream.read(limit + 1)
        except OSError:
            raise VaultError("credential_read_failed") from None
        if not contents or len(contents) > limit:
            raise VaultError(invalid_code)
        return contents

    def _fernet(self) -> Fernet:
        try:
            if not self.key_path.exists() and not self.key_path.is_symlink():
                raise VaultError("credential_key_missing")
            key = self._read_file(self.key_path, _MAX_KEY_BYTES, "credential_key_invalid")
            return Fernet(key.strip())
        except OSError:
            raise VaultError("credential_read_failed") from None
        except (ValueError, TypeError):
            raise VaultError("credential_key_invalid") from None

    def _read_unlocked(self) -> Credentials | None:
        self._check_directory("credential_read_failed")
        try:
            if not self.env_path.exists() and not self.env_path.is_symlink():
                return None
        except OSError:
            raise VaultError("credential_read_failed") from None
        raw = self._read_file(self.env_path, self.env_limit, "credential_file_invalid")
        try:
            values: dict[str, str] = {}
            for line in raw.decode("utf-8").splitlines():
                if not line.strip():
                    continue
                name, separator, value = line.partition("=")
                if not separator or name not in {"VERSION", "ZJU_CREDENTIALS_ENCRYPTED"} or name in values:
                    raise VaultError("credential_file_invalid")
                values[name] = value
            if set(values) != {"VERSION", "ZJU_CREDENTIALS_ENCRYPTED"}:
                raise VaultError("credential_file_invalid")
            if values["VERSION"] != "1":
                raise VaultError("credential_schema_unsupported")
            token = values["ZJU_CREDENTIALS_ENCRYPTED"].encode("ascii")
        except (UnicodeError, ValueError, TypeError):
            raise VaultError("credential_file_invalid") from None
        try:
            payload = self._fernet().decrypt(token)
        except (InvalidToken, ValueError, TypeError):
            raise VaultError("credential_decrypt_failed") from None
        try:
            decoded = json.loads(payload.decode("utf-8"))
            if not isinstance(decoded, dict) or set(decoded) != {"username", "password"}:
                raise VaultError("credential_file_invalid")
            return _credentials(decoded["username"], decoded["password"], password_limit=self.password_limit)
        except (UnicodeError, ValueError, TypeError, VaultError):
            raise VaultError("credential_file_invalid") from None

    def read(self) -> Credentials | None:
        """Read without creating files; damaged bindings must be fixed explicitly."""
        with self._lock:
            return self._read_unlocked()

    def exists(self) -> bool:
        """Whether a binding file is present, including one requiring repair."""
        with self._lock:
            self._check_directory("credential_read_failed")
            try:
                return self.env_path.exists() or self.env_path.is_symlink()
            except OSError:
                raise VaultError("credential_read_failed") from None

    def _atomic_write(self, path: Path, contents: bytes) -> None:
        temporary: Path | None = None
        descriptor: int | None = None
        try:
            descriptor, temporary_name = tempfile.mkstemp(
                prefix=f".{path.name}.", suffix=".tmp", dir=self.directory,
            )
            temporary = Path(temporary_name)
            _private_mode(temporary, 0o600)
            with os.fdopen(descriptor, "wb") as stream:
                descriptor = None
                stream.write(contents)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
            temporary = None
            _private_mode(path, 0o600)
            # Directory fsync makes rename durable where the OS supports it.
            if os.name != "nt":
                try:
                    directory_fd = os.open(self.directory, os.O_RDONLY)
                    try:
                        os.fsync(directory_fd)
                    finally:
                        os.close(directory_fd)
                except OSError:
                    pass
        except OSError:
            raise VaultError("credential_write_failed") from None
        finally:
            if descriptor is not None:
                try:
                    os.close(descriptor)
                except OSError:
                    pass
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass

    def save(self, username: str, password: str) -> None:
        """Replace ciphertext atomically, preserving the previous binding on error."""
        credentials = _credentials(username, password, password_limit=self.password_limit)
        with self._lock:
            # Do not silently overwrite an existing binding that cannot decrypt.
            self._read_unlocked()
            self._check_directory("credential_write_failed")
            try:
                self.directory.mkdir(parents=True, mode=0o700, exist_ok=True)
                _private_mode(self.directory, 0o700)
                if not self.key_path.exists() and not self.key_path.is_symlink():
                    self._atomic_write(self.key_path, Fernet.generate_key() + b"\n")
                fernet = self._fernet()
                payload = json.dumps(
                    {"username": credentials.username, "password": credentials.password},
                    ensure_ascii=False, separators=(",", ":"),
                ).encode("utf-8")
                token = fernet.encrypt(payload)
                contents = b"VERSION=1\nZJU_CREDENTIALS_ENCRYPTED=" + token + b"\n"
                self._atomic_write(self.env_path, contents)
            except (OSError, UnicodeError, ValueError, TypeError):
                raise VaultError("credential_write_failed") from None

    def clear(self) -> None:
        """Remove only the two fixed credential files, including damaged bindings."""
        with self._lock:
            self._check_directory("credential_clear_failed")
            try:
                # Keep the key if deleting ciphertext fails, so the binding survives.
                self.env_path.unlink(missing_ok=True)
                self.key_path.unlink(missing_ok=True)
            except OSError:
                raise VaultError("credential_clear_failed") from None
