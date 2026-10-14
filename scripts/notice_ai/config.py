"""DeepSeek settings kept in an independent encrypted vault on this computer."""

from dataclasses import dataclass, field
import json
import re
import threading
from urllib.parse import urlsplit

from local_auth.vault import CredentialVault, VaultError
from .schema import AIError


@dataclass(frozen=True)
class AIConfig:
    provider: str = "deepseek"
    model: str = "deepseek-flash"
    api_key: str = field(default="", repr=False)
    base_url: str = "https://api.deepseek.com"
    timeout: int = 90
    automatic: bool = True
    allow_protected: bool = True
    automatic_deadlines: bool = True
    error: str | None = None

    @property
    def configured(self):
        return bool(self.api_key and not self.error)


def validate_settings(value, previous=None):
    if not isinstance(value, dict) or set(value) - {"apiKey", "model", "baseUrl", "automatic", "allowProtected", "automaticDeadlines"}:
        raise AIError("invalid_input", 400)
    previous = previous or AIConfig()
    key = value.get("apiKey", "")
    model = value.get("model", previous.model)
    url = value.get("baseUrl", previous.base_url)
    if not isinstance(key, str) or len(key) > 3000 or any(ord(char) < 32 or ord(char) > 126 for char in key):
        raise AIError("invalid_api_key", 400)
    key = key.strip() or previous.api_key
    if not isinstance(model, str) or not re.fullmatch(r"[A-Za-z0-9_.:/-]{1,128}", model):
        raise AIError("invalid_model", 400)
    if not isinstance(url, str) or len(url) > 500:
        raise AIError("invalid_api_url", 400)
    try:
        parsed = urlsplit(url.strip())
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
                or parsed.query or parsed.fragment or parsed.path.rstrip("/").endswith("/chat/completions")):
            raise ValueError
        parsed.port
    except ValueError:
        raise AIError("invalid_api_url", 400) from None
    flags = {}
    for name, default in (("automatic", previous.automatic), ("allowProtected", previous.allow_protected),
                          ("automaticDeadlines", previous.automatic_deadlines)):
        flags[name] = value.get(name, default)
        if type(flags[name]) is not bool:
            raise AIError("invalid_input", 400)
    return AIConfig(model=model, api_key=key, base_url=url.strip().rstrip("/"),
                    automatic=flags["automatic"], allow_protected=flags["allowProtected"],
                    automatic_deadlines=flags["automaticDeadlines"])


class AISettings:
    def __init__(self, directory):
        self.vault = CredentialVault(directory)
        self.lock = threading.RLock()
        self.config = AIConfig()
        try:
            saved = self.vault.read()
            if saved is not None:
                self.config = validate_settings(json.loads(saved.password))
        except (VaultError, ValueError, AIError):
            self.config = AIConfig(error="ai_settings_unavailable")

    def snapshot(self):
        with self.lock:
            config = self.config
            return {"provider": "deepseek", "model": config.model, "baseUrl": config.base_url,
                    "configured": config.configured, "hasKey": bool(config.api_key),
                    "automatic": config.automatic, "allowProtected": config.allow_protected,
                    "automaticDeadlines": config.automatic_deadlines, "error": config.error}

    def save(self, value):
        with self.lock:
            config = validate_settings(value, self.config)
            if not config.api_key:
                raise AIError("api_key_required", 400)
            payload = {"apiKey": config.api_key, "model": config.model, "baseUrl": config.base_url,
                       "automatic": config.automatic, "allowProtected": config.allow_protected,
                       "automaticDeadlines": config.automatic_deadlines}
            try:
                self.vault.save("deepseek-api", json.dumps(payload, ensure_ascii=False))
            except VaultError:
                raise AIError("ai_settings_write_failed", 503) from None
            self.config = config
            return self.snapshot()

    def clear(self):
        with self.lock:
            try:
                self.vault.clear()
            except VaultError:
                raise AIError("ai_settings_write_failed", 503) from None
            self.config = AIConfig()
            return self.snapshot()
