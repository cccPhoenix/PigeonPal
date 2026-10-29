"""A portable, bounded local user profile, separate from authentication material.

Only confirmed facts enter model context. Student numbers are parsed in memory
and never become profile fields. A damaged primary file is never silently
replaced with its backup: the backup is available for inspection, while writes
remain blocked until the user explicitly clears the profile.
"""

from __future__ import annotations

import copy
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import tempfile
import threading
import unicodedata

from .schema import AIError


FACT_FIELDS = ("degree", "admissionYear", "college", "major")
DEGREES = ("undergraduate", "master", "doctor", "postgraduate", "staff", "other")
ACADEMIES = ("", "yunfeng", "danyang", "lantian")
MAX_PROFILE_BYTES = 65536
_LOCAL_ZONE = timezone(timedelta(hours=8))
_LOCKS = {}
_LOCKS_GUARD = threading.Lock()
_SECRET = re.compile(
    r"\bsk-[A-Za-z0-9_-]{8,}\b|\bBearer\s+[A-Za-z0-9._~+/-]{8,}"
    r"|(?:学号|账号|账户|密码|口令|cookie|authorization|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|sessionid)\s*(?:[:=：]|是|为)\s*\S+"
    r"|[A-Za-z0-9_.+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"
    r"|(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)"
    r"|(?<!\d)\d{17}[\dXx](?!\d)"
    r"|(?<!\d)3\d{7,19}(?!\d)", re.I,
)


def _now():
    return datetime.now(_LOCAL_ZONE)


def _stamp():
    return _now().astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _invalid():
    raise AIError("profile_invalid", 400)


def _text(value, limit):
    if (not isinstance(value, str) or len(value) > limit
            or any(unicodedata.category(char) in {"Cc", "Cf", "Cs"} for char in value)
            or _SECRET.search(value)):
        _invalid()
    return " ".join(value.split())


def _fact_value(field, value):
    if value is None or value == "":
        return None
    if field == "degree":
        if not isinstance(value, str) or value not in DEGREES:
            _invalid()
        return value
    if field == "admissionYear":
        if type(value) is not int or not 1950 <= value <= 2100:
            _invalid()
        return value
    return _text(value, 120) or None


def _academy(value):
    if not isinstance(value, str) or value not in ACADEMIES:
        _invalid()
    return value


def _preferences(value):
    if not isinstance(value, dict) or set(value) - {"interests", "avoid"}:
        _invalid()
    result = {}
    for name, entries in value.items():
        if not isinstance(entries, list) or len(entries) > 12:
            _invalid()
        clean = []
        for entry in entries:
            entry = _text(entry, 120)
            if not entry:
                _invalid()
            if entry not in clean:
                clean.append(entry)
        result[name] = clean
    return result


def _empty(version=0, updated_at=None):
    return {"schemaVersion": 1, "version": version, "updatedAt": updated_at, "academy": "",
            "facts": {name: {"value": None, "confirmed": False, "source": "", "updatedAt": None}
                      for name in FACT_FIELDS},
            "preferences": {"interests": [], "avoid": []}}


def _timestamp(value):
    if value is None:
        return
    if not isinstance(value, str) or len(value) > 40:
        _invalid()
    try:
        if datetime.fromisoformat(value.replace("Z", "+00:00")).tzinfo is None:
            _invalid()
    except (ValueError, OverflowError):
        _invalid()


def _source(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-z][a-z0-9_-]{0,31}", value):
        _invalid()
    return value


def _validate(value):
    required = {"schemaVersion", "version", "updatedAt", "facts", "preferences"}
    if (not isinstance(value, dict)
            or not required <= set(value) <= required | {"academy"}
            or type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1
            or type(value["version"]) is not int or not 0 <= value["version"] <= 9007199254740990
            or not isinstance(value["facts"], dict) or set(value["facts"]) != set(FACT_FIELDS)
            or not isinstance(value["preferences"], dict) or set(value["preferences"]) != {"interests", "avoid"}):
        _invalid()
    # Existing schema-1 profiles predate the optional local source preference.
    # Normalize in memory; reading never rewrites or discards the old file.
    value["academy"] = _academy(value.get("academy", ""))
    _timestamp(value["updatedAt"])
    for field, fact in value["facts"].items():
        if (not isinstance(fact, dict) or set(fact) != {"value", "confirmed", "source", "updatedAt"}
                or type(fact["confirmed"]) is not bool
                or fact["value"] is None and fact["confirmed"]):
            _invalid()
        normalized = _fact_value(field, fact["value"])
        if normalized != fact["value"]:
            _invalid()
        if fact["source"] != "":
            _source(fact["source"])
        _timestamp(fact["updatedAt"])
    if _preferences(value["preferences"]) != value["preferences"]:
        _invalid()
    return value


def _json_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate_profile_key")
        result[key] = value
    return result


def _bad_constant(_value):
    raise ValueError("invalid_profile_constant")


def _read(path):
    with path.open("rb") as handle:
        content = handle.read(MAX_PROFILE_BYTES + 1)
    if len(content) > MAX_PROFILE_BYTES:
        raise ValueError("profile_too_large")
    value = json.loads(content.decode("utf-8"), object_pairs_hook=_json_pairs, parse_constant=_bad_constant)
    return _validate(value)


def _encode(value):
    data = (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + "\n").encode("utf-8")
    if len(data) > MAX_PROFILE_BYTES:
        _invalid()
    return data


def _atomic_replace(path, data):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile("wb", dir=path.parent, prefix=f".{path.name}.", suffix=".tmp", delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        temporary = None
    finally:
        if temporary is not None:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass


class UserProfileStore:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.backup_path = self.path.with_name(self.path.name + ".bak")
        key = os.path.normcase(str(self.path.absolute()))
        with _LOCKS_GUARD:
            self.lock = _LOCKS.setdefault(key, threading.RLock())
        self._state = _empty()
        self._storage_error = False
        self._readable = True
        with self.lock:
            self._load()

    def _load(self):
        self._storage_error = False
        self._readable = True
        try:
            self._state = _read(self.path)
            return
        except FileNotFoundError:
            if not self.backup_path.exists():
                self._state = _empty()
                return
        except (OSError, UnicodeError, ValueError, TypeError, AIError, RecursionError):
            pass
        self._storage_error = True
        try:
            self._state = _read(self.backup_path)
        except (OSError, UnicodeError, ValueError, TypeError, AIError, RecursionError):
            # Preserve the last readable version so an explicit clear in this
            # process still advances its revision even after external damage.
            self._readable = False

    def _snapshot(self):
        if not self._readable:
            raise AIError("profile_storage_error", 503)
        result = copy.deepcopy(self._state)
        year = result["facts"]["admissionYear"]["value"]
        now = _now()
        academic_year = now.year if now.month >= 9 else now.year - 1
        result["grade"] = academic_year - year + 1 if year is not None and year <= academic_year else None
        if self._storage_error:
            result["storageError"] = "profile_storage_error"
        return result

    def snapshot(self):
        with self.lock:
            self._load()
            return self._snapshot()

    def _check_version(self, expected_version):
        if expected_version is not None:
            if type(expected_version) is not int or expected_version < 0:
                _invalid()
            if expected_version != self._state["version"]:
                raise AIError("profile_version_conflict", 409)

    def _write(self, value, *, clear=False):
        data = _encode(value)
        backup = data if clear else _encode(self._state)
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            _atomic_replace(self.backup_path, backup)
            _atomic_replace(self.path, data)
        except OSError:
            raise AIError("profile_storage_error", 503) from None
        self._state = value
        self._storage_error = False
        self._readable = True

    def update(self, patch, *, source="settings"):
        with self.lock:
            self._load()
            if self._storage_error:
                raise AIError("profile_storage_error", 503)
            if (not isinstance(patch, dict)
                    or set(patch) - {"facts", "preferences", "studentNumber", "expectedVersion", "academy"}):
                _invalid()
            _source(source)
            self._check_version(patch.get("expectedVersion"))
            facts_patch = patch.get("facts", {})
            if not isinstance(facts_patch, dict) or set(facts_patch) - set(FACT_FIELDS):
                _invalid()
            stamp = _stamp()
            new = copy.deepcopy(self._state)
            if "academy" in patch:
                new["academy"] = _academy(patch["academy"])
            if "studentNumber" in patch:
                number = patch["studentNumber"]
                if not isinstance(number, str) or not re.fullmatch(r"3\d{2,19}", number):
                    _invalid()
                year = 2000 + int(number[1:3])
                current = new["facts"]["admissionYear"]
                if "admissionYear" not in facts_patch and not current["confirmed"]:
                    if current["value"] != year:
                        new["facts"]["admissionYear"] = {"value": year, "confirmed": False,
                                                         "source": "student_number", "updatedAt": stamp}
            for field, fact in facts_patch.items():
                if (not isinstance(fact, dict) or not {"value"}.issubset(fact)
                        or set(fact) - {"value", "confirmed"} or type(fact.get("confirmed", True)) is not bool):
                    _invalid()
                value = _fact_value(field, fact["value"])
                confirmed = bool(fact.get("confirmed", True)) if value is not None else False
                old = new["facts"][field]
                if old["value"] != value or old["confirmed"] != confirmed:
                    new["facts"][field] = {"value": value, "confirmed": confirmed, "source": source, "updatedAt": stamp}
            new["preferences"].update(_preferences(patch.get("preferences", {})))
            if new == self._state:
                return self._snapshot()
            new["version"] += 1
            new["updatedAt"] = stamp
            _validate(new)
            self._write(new)
            return self._snapshot()

    def clear(self, expected_version=None):
        with self.lock:
            self._load()
            self._check_version(expected_version)
            new = _empty(self._state["version"] + 1, _stamp())
            _validate(new)
            self._write(new, clear=True)
            return self._snapshot()

    def model_context(self):
        with self.lock:
            self._load()
            if self._storage_error:
                raise AIError("profile_storage_error", 503)
            return {"version": self._state["version"],
                    "facts": {name: fact["value"] for name, fact in self._state["facts"].items()
                              if fact["confirmed"] and fact["value"] is not None},
                    "preferences": copy.deepcopy(self._state["preferences"])}

    def needs_personalization(self):
        with self.lock:
            self._load()
            if self._storage_error:
                return False
            return (any(fact["confirmed"] and fact["value"] is not None for fact in self._state["facts"].values())
                    or any(self._state["preferences"].values()))
