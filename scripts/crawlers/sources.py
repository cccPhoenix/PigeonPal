"""Site adapters and shared metadata/attachment validation."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
import re
from typing import Callable
from urllib.parse import urlsplit

from yunfeng_html import parse_article as yunfeng_article, parse_list as yunfeng_list
from itc_html import parse_article as itc_article, parse_list as itc_list

from .http import CrawlFailure, has_sensitive_query, notice_url


@dataclass(frozen=True)
class Source:
    id: str
    url: str
    host: str
    requires_auth: bool
    parse_list: Callable
    parse_article: Callable


SOURCES = {
    "yunfeng": Source("yunfeng", "https://yunfeng.zju.edu.cn/on/53544/list.psp",
                      "yunfeng.zju.edu.cn", False, yunfeng_list, yunfeng_article),
    "itc": Source("itc", "https://itc.zju.edu.cn/90618/list.psp",
                  "itc.zju.edu.cn", True, itc_list, itc_article),
}


def clean_list(source: Source, items: list[dict]) -> list[dict]:
    cleaned = []
    seen = set()
    for item in items:
        item_id = item.get("id", "")
        title = " ".join(item.get("title", "").split())
        published = item.get("publishedAt", "")
        if not re.fullmatch(re.escape(source.id) + r":[A-Za-z0-9_-]+", item_id) or not title:
            raise CrawlFailure("invalid_list_metadata")
        try:
            if published or source.id != "itc":
                if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", published):
                    raise ValueError
                date.fromisoformat(published)
        except (TypeError, ValueError):
            raise CrawlFailure("invalid_list_date") from None
        url = notice_url(item.get("url", ""), source.host)
        if item_id in seen:
            continue
        seen.add(item_id)
        cleaned.append({"id": item_id, "title": title, "publishedAt": published, "url": url})
    if not cleaned:
        raise CrawlFailure("empty_notice_list")
    return cleaned


def clean_detail(detail: dict) -> dict:
    title = " ".join(detail.get("title", "").split())
    content = detail.get("content", "").strip()
    if not title or not content:
        raise CrawlFailure("empty_article_body")
    published = detail.get("publishedAt", "")
    if published:
        try:
            date.fromisoformat(published)
        except (TypeError, ValueError):
            raise CrawlFailure("invalid_article_date") from None
    attachments = []
    seen = set()
    flags = list(detail.get("qualityFlags", []))
    for attachment in detail.get("attachments", []):
        url = attachment.get("url", "")
        try:
            parsed = urlsplit(url)
            safe = (
                parsed.scheme in {"http", "https"} and parsed.hostname
                and not parsed.username and not parsed.password
                and not has_sensitive_query(url) and ";jsessionid=" not in parsed.path.lower()
            )
        except ValueError:
            safe = False
        if not safe:
            flags.append("attachment_link_redacted")
            continue
        if url not in seen:
            attachments.append({"name": attachment.get("name", ""), "url": url})
            seen.add(url)
    return {
        "title": title, "content": content, "publishedAt": published,
        "publisher": detail.get("publisher", ""), "attachments": attachments,
        "qualityFlags": sorted(set(flags)),
    }
