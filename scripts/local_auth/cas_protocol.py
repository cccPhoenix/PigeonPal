"""Pure ZJUAM form protocol, ported from the working reference client.

Source: https://github.com/EviterLesRoses2/vibe-learning-in-zju/blob/
5215e54f533abec04c1c4bb4ecf608b017e48ebf/zju-mcp.mjs#L137-L177
Ports ``modpow``/``encryptPassword`` and the five-field URLSearchParams body
inside ``postCasForm``. Network, redirect handling and success detection are
deliberately supplied by our caller. No credentials or sessions are stored here.
"""

from __future__ import annotations

import json
import re
from urllib.parse import quote_plus


def _invalid() -> ValueError:
    # Never include a supplied value or JSON exception in an error message.
    return ValueError("invalid_cas_page")


def _text(value: str, maximum: int) -> str:
    if not isinstance(value, str) or len(value) > maximum or not value:
        raise _invalid()
    try:
        value.encode("utf-8")
    except UnicodeError:
        raise _invalid() from None
    return value


def encrypt_password(password: str, modulus_hex: str, exponent_hex: str) -> str:
    """Match the reference's UTF-8 integer, raw RSA, lowercase unpadded hex.

    This is the campus form's protocol; it is not an RSA encryption API for
    other uses. In particular, adding standard RSA padding would change it.
    """
    password = _text(password, 1024)
    if not isinstance(modulus_hex, str) or not re.fullmatch(r"[0-9a-fA-F]{1,2048}", modulus_hex):
        raise _invalid()
    if not isinstance(exponent_hex, str) or not re.fullmatch(r"[0-9a-fA-F]{1,16}", exponent_hex):
        raise _invalid()
    modulus, exponent = int(modulus_hex, 16), int(exponent_hex, 16)
    if modulus < 256 or exponent < 3:
        raise _invalid()
    message = int.from_bytes(password.encode("utf-8"), "big")
    return format(pow(message, exponent, modulus), "x")


def _form_component(value: str) -> str:
    # URLSearchParams uses application/x-www-form-urlencoded: '~' is escaped
    # and '*' is literal, unlike urllib.parse.urlencode's defaults.
    return quote_plus(value, safe="*", encoding="utf-8", errors="strict").replace("~", "%7E")


def build_submission(username: str, password: str, execution: str, public_key_text: str) -> bytes:
    """Build exactly the reference's ordered five-field CAS form body."""
    username = _text(username, 256)
    execution = _text(execution, 8192)
    public_key_text = _text(public_key_text, 16384)
    try:
        public = json.loads(public_key_text)
        if not isinstance(public, dict):
            raise _invalid()
        encrypted = encrypt_password(password, public["modulus"], public["exponent"])
    except (KeyError, TypeError, ValueError, RecursionError):
        raise _invalid() from None
    fields = (
        ("username", username),
        ("password", encrypted),
        ("authcode", ""),
        ("execution", execution),
        ("_eventId", "submit"),
    )
    return "&".join(f"{name}={_form_component(value)}" for name, value in fields).encode("ascii")
