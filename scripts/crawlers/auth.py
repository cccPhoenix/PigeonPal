"""Authentication extension point. No login or credential persistence here.

The local site-session adapter provides an independent CookieJar per source.
The provider retains ownership, handles expiry, and must never expose
credentials through crawler arguments, configuration files, or logs.
"""

from __future__ import annotations

from dataclasses import dataclass
from http.cookiejar import CookieJar
from typing import Protocol


@dataclass
class AuthSession:
    """An already authenticated, in-memory, per-site cookie jar."""

    cookies: CookieJar
    last_request_monotonic: float | None = None


class AuthProvider(Protocol):
    def session_for(self, source_id: str) -> AuthSession | None:
        """Return a live session, or None when user authentication is needed."""
        ...

    def invalidate(self, source_id: str) -> None:
        """Discard an expired session; never retry a login from the crawler."""
        ...


class NoAuthProvider:
    def session_for(self, source_id: str) -> AuthSession | None:
        return None

    def invalidate(self, source_id: str) -> None:
        pass
