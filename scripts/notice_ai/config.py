"""DeepSeek settings kept in an independent encrypted vault on this computer."""

from dataclasses import dataclass, field
from datetime import datetime, timezone
import json
import re
import threading
import uuid
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
        self.vault = CredentialVault(directory, password_limit=131072)
        self.lock = threading.RLock()
        self._profiles = []
        self._active_id = None
        self._preferences = {"automatic": True, "allowProtected": True, "automaticDeadlines": True}
        self._error = None
        try:
            saved = self.vault.read()
            if saved is not None:
                self._load(json.loads(saved.password))
        except (VaultError, ValueError, TypeError, AIError):
            self._profiles, self._active_id = [], None
            self._error = "ai_settings_unavailable"

    def _load(self, value):
        if not isinstance(value, dict):
            raise ValueError
        if "schemaVersion" not in value:
            legacy = validate_settings(value)
            if not legacy.api_key:
                raise ValueError
            self._preferences = self._flags(legacy)
            self._profiles = [{"id": "api-legacy", "name": "原有 DeepSeek 配置", "apiKey": legacy.api_key,
                               "model": legacy.model, "baseUrl": legacy.base_url,
                               "createdAt": None, "verifiedAt": None}]
            self._active_id = "api-legacy"
            return
        if (set(value) != {"schemaVersion", "profiles", "activeProfileId", "preferences"}
                or type(value["schemaVersion"]) is not int or value["schemaVersion"] != 2
                or not isinstance(value["profiles"], list) or len(value["profiles"]) > 20
                or not isinstance(value["preferences"], dict) or set(value["preferences"]) != set(self._preferences)):
            raise ValueError
        preferences = self._flags(validate_settings(value["preferences"]))
        profiles, identities = [], set()
        for row in value["profiles"]:
            if (not isinstance(row, dict) or set(row) != {"id", "name", "apiKey", "model", "baseUrl", "createdAt", "verifiedAt"}
                    or not isinstance(row["id"], str) or not re.fullmatch(r"api-[a-z0-9-]{1,48}", row["id"])
                    or row["id"] in identities):
                raise ValueError
            profile = self._profile({key: row[key] for key in ("name", "apiKey", "model", "baseUrl")})
            for name in ("createdAt", "verifiedAt"):
                stamp = row[name]
                if stamp is not None:
                    if not isinstance(stamp, str) or len(stamp) > 40 or datetime.fromisoformat(stamp.replace("Z", "+00:00")).tzinfo is None:
                        raise ValueError
            profile.update(id=row["id"], createdAt=row["createdAt"], verifiedAt=row["verifiedAt"])
            profiles.append(profile)
            identities.add(row["id"])
        active = value["activeProfileId"]
        if active is not None and (not isinstance(active, str) or active not in identities):
            raise ValueError
        self._profiles, self._active_id, self._preferences = profiles, active, preferences

    @staticmethod
    def _flags(config):
        return {"automatic": config.automatic, "allowProtected": config.allow_protected,
                "automaticDeadlines": config.automatic_deadlines}

    @staticmethod
    def _profile(value, previous=None):
        if not isinstance(value, dict) or set(value) - {"name", "apiKey", "model", "baseUrl"}:
            raise AIError("invalid_input", 400)
        name = value.get("name", previous["name"] if previous else "DeepSeek")
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > 40 or any(ord(char) < 32 for char in name):
            raise AIError("invalid_profile_name", 400)
        old_config = validate_settings({key: previous[key] for key in ("apiKey", "model", "baseUrl")}) if previous else AIConfig()
        config = validate_settings({key: item for key, item in value.items() if key != "name"}, old_config)
        if not config.api_key:
            raise AIError("api_key_required", 400)
        row = {"id": "api-" + uuid.uuid4().hex, "name": name.strip(), "apiKey": config.api_key,
               "model": config.model, "baseUrl": config.base_url,
               "createdAt": datetime.now(timezone.utc).isoformat(timespec="seconds"), "verifiedAt": None}
        if previous:
            row.update(id=previous["id"], createdAt=previous["createdAt"])
            if all(row[key] == previous[key] for key in ("apiKey", "model", "baseUrl")):
                row["verifiedAt"] = previous["verifiedAt"]
        return row

    def _find(self, identity):
        if not isinstance(identity, str):
            raise AIError("invalid_input", 400)
        row = next((row for row in self._profiles if row["id"] == identity), None)
        if row is None:
            raise AIError("ai_profile_not_found", 404)
        return row

    @property
    def config(self):
        with self.lock:
            row = next((row for row in self._profiles if row["id"] == self._active_id), None)
            if self._error:
                return AIConfig(error=self._error)
            return validate_settings({**self._preferences, **({key: row[key] for key in ("apiKey", "model", "baseUrl")} if row else {})})

    def _commit(self, profiles, active_id, preferences):
        if self._error:
            raise AIError(self._error, 503)
        payload = {"schemaVersion": 2, "profiles": profiles, "activeProfileId": active_id, "preferences": preferences}
        try:
            self.vault.save("deepseek-api", json.dumps(payload, ensure_ascii=False))
        except VaultError:
            raise AIError("ai_settings_write_failed", 503) from None
        self._profiles, self._active_id, self._preferences = profiles, active_id, preferences

    def snapshot(self):
        with self.lock:
            config = self.config
            return {"provider": "deepseek", "model": config.model, "baseUrl": config.base_url,
                    "configured": config.configured, "hasKey": bool(config.api_key),
                    "automatic": config.automatic, "allowProtected": config.allow_protected,
                    "automaticDeadlines": config.automatic_deadlines, "error": config.error,
                    "activeProfileId": self._active_id,
                    "profiles": [{**{key: row[key] for key in ("id", "name", "model", "baseUrl", "createdAt", "verifiedAt")},
                                  "provider": "deepseek", "keyHint": "•••• " + row["apiKey"][-4:] if len(row["apiKey"]) >= 12 else "••••••••",
                                  "active": row["id"] == self._active_id} for row in self._profiles]}

    def add(self, value):
        with self.lock:
            if len(self._profiles) >= 20:
                raise AIError("ai_profiles_full", 400)
            row = self._profile(value)
            self._unique(row)
            active = self._active_id or (row["id"] if not self._profiles else None)
            self._commit([*self._profiles, row], active, dict(self._preferences))
            return {**self.snapshot(), "createdProfileId": row["id"]}

    def _unique(self, candidate):
        if any(row["id"] != candidate["id"] and all(row[key] == candidate[key] for key in ("apiKey", "model", "baseUrl")) for row in self._profiles):
            raise AIError("ai_profile_duplicate", 409)

    def update(self, value):
        with self.lock:
            if not isinstance(value, dict) or "id" not in value:
                raise AIError("invalid_input", 400)
            old = self._find(value["id"])
            row = self._profile({key: item for key, item in value.items() if key != "id"}, old)
            self._unique(row)
            self._commit([row if item["id"] == row["id"] else item for item in self._profiles], self._active_id, dict(self._preferences))
            return self.snapshot()

    def select(self, identity):
        with self.lock:
            self._find(identity)
            self._commit(list(self._profiles), identity, dict(self._preferences))
            return self.snapshot()

    def delete(self, identity):
        with self.lock:
            self._find(identity)
            self._commit([row for row in self._profiles if row["id"] != identity],
                         None if identity == self._active_id else self._active_id, dict(self._preferences))
            return self.snapshot()

    def check_target(self, identity=None):
        with self.lock:
            if self._error:
                raise AIError(self._error, 503)
            identity = identity if identity is not None else self._active_id
            if identity is None:
                raise AIError("ai_not_configured", 503)
            row = self._find(identity)
            return identity, validate_settings({key: row[key] for key in ("apiKey", "model", "baseUrl")})

    def mark_verified(self, identity, checked_config, *, success=True):
        with self.lock:
            row = self._find(identity)
            if (row["apiKey"], row["model"], row["baseUrl"]) != (checked_config.api_key, checked_config.model, checked_config.base_url):
                raise AIError("ai_configuration_changed", 409)
            updated = {**row, "verifiedAt": datetime.now(timezone.utc).isoformat(timespec="seconds") if success else None}
            self._commit([updated if item["id"] == identity else item for item in self._profiles], self._active_id, dict(self._preferences))
            return self.snapshot()

    def save(self, value):
        """Keep the existing active-profile endpoint, including preferences-only saves."""
        with self.lock:
            config = validate_settings(value, self.config)
            profiles, active = list(self._profiles), self._active_id
            if set(value) & {"apiKey", "model", "baseUrl"}:
                old = self._find(active) if active else None
                row = self._profile({key: getattr(config, attr) for key, attr in
                                     (("apiKey", "api_key"), ("model", "model"), ("baseUrl", "base_url"))}, old)
                self._unique(row)
                if old:
                    profiles = [row if item["id"] == active else item for item in profiles]
                else:
                    if len(profiles) >= 20:
                        raise AIError("ai_profiles_full", 400)
                    profiles.append(row)
                    active = row["id"]
            self._commit(profiles, active, self._flags(config))
            return self.snapshot()

    def clear(self):
        with self.lock:
            try:
                self.vault.clear()
            except VaultError:
                raise AIError("ai_settings_write_failed", 503) from None
            self._profiles, self._active_id, self._error = [], None, None
            self._preferences = self._flags(AIConfig())
            return self.snapshot()
