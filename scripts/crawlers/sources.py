"""Site adapters and shared metadata/attachment validation."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
import re
from typing import Callable
from urllib.parse import unquote, urlsplit

from yunfeng_html import parse_article as yunfeng_article, parse_list as yunfeng_list
from itc_html import parse_article as itc_article, parse_list as itc_list
from qsxy_html import parse_article as qsxy_article, parse_list as qsxy_list
from bksy_html import parse_article as bksy_article, parse_list as bksy_list
from academy_html import parse_article as academy_article, parse_danyang_list, parse_lantian_list

from .http import CrawlFailure, has_sensitive_query, notice_url
from .homework_contract import homework_url, normalize_homework


@dataclass(frozen=True)
class Source:
    id: str
    url: str
    host: str
    requires_auth: bool
    parse_list: Callable
    parse_article: Callable
    title: str = ""
    allow_http: bool = False
    kind: str = "notice"
    allow_ai: bool = True


SOURCES = {
    "yunfeng": Source("yunfeng", "https://yunfeng.zju.edu.cn/on/53544/list.psp",
                      "yunfeng.zju.edu.cn", False, yunfeng_list, yunfeng_article,
                      title="云峰学园·通知公告"),
    "danyang": Source("danyang", "https://dqxy.zju.edu.cn/51432/list.htm", "dqxy.zju.edu.cn", False,
                      parse_danyang_list, academy_article, title="丹阳青溪学园·最新通知"),
    "lantian": Source("lantian", "http://lantian.zju.edu.cn/ltoffice/main.htm", "lantian.zju.edu.cn", False,
                      parse_lantian_list, academy_article, title="蓝田学园·通知公告", allow_http=True),
    "itc": Source("itc", "https://itc.zju.edu.cn/90618/list.psp",
                  "itc.zju.edu.cn", True, itc_list, itc_article,
                  title="信息技术中心·通知公告"),
    "qsxy": Source("qsxy", "http://qsxy.zju.edu.cn/30845/list.psp",
                   "qsxy.zju.edu.cn", False, qsxy_list, qsxy_article,
                   title="求是学院·重要通知", allow_http=True),
    "bksy": Source("bksy", "https://bksy.zju.edu.cn/28418/list.htm",
                   "bksy.zju.edu.cn", False, bksy_list, bksy_article,
                   title="本科生院·通知公告"),
    "xzzd": Source("xzzd", "https://courses.zju.edu.cn/login", "courses.zju.edu.cn",
                   True, None, None, title="学在浙大·作业", kind="homework", allow_ai=False),
}


def _quality_flags(values) -> list[str]:
    if not isinstance(values, (list, tuple)):
        return []
    return sorted({value for value in values if isinstance(value, str)
                   and re.fullmatch(r"[a-z][a-z0-9_]{0,63}", value)})


def _safe_metadata_url(url: str) -> bool:
    """A reference may be external; it is never a permission to fetch it."""
    if not isinstance(url, str) or any(char.isspace() or ord(char) < 32 for char in url):
        return False
    try:
        parsed = urlsplit(url)
        return bool(
            parsed.scheme in {"http", "https"} and parsed.hostname
            and parsed.username is None and parsed.password is None
            and parsed.port in {None, 80 if parsed.scheme == "http" else 443}
            and "#" not in url and not has_sensitive_query(url)
            and ";" not in unquote(parsed.path)
        )
    except ValueError:
        return False


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
            if published or source.id not in {"itc", "qsxy", "bksy", "xzzd"}:
                if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", published):
                    raise ValueError
                date.fromisoformat(published)
        except (TypeError, ValueError):
            raise CrawlFailure("invalid_list_date") from None
        if "fetchable" in item and not isinstance(item["fetchable"], bool):
            raise CrawlFailure("invalid_list_metadata")
        flags = _quality_flags(item.get("qualityFlags", []))
        if source.id in {"qsxy", "bksy"} and not published:
            flags.append("publication_date_missing")
        if source.kind == "homework":
            try:
                url = homework_url(item.get("url", ""))
                homework = normalize_homework(item.get("homework"))
                if item_id != "xzzd:" + homework["activityId"]:
                    raise ValueError("invalid_homework_metadata")
            except ValueError:
                raise CrawlFailure("invalid_list_metadata") from None
        elif item.get("fetchable") is False:
            url = item.get("url", "")
            if source.id not in {"qsxy", "bksy"} or not _safe_metadata_url(url):
                raise CrawlFailure("invalid_notice_url")
        else:
            url = notice_url(item.get("url", ""), source.host, allow_http=source.allow_http)
        if item_id in seen:
            continue
        seen.add(item_id)
        result = {"id": item_id, "title": title, "publishedAt": published, "url": url}
        if source.kind == "homework":
            result["homework"] = homework
        if "fetchable" in item:
            result["fetchable"] = item["fetchable"]
        if flags:
            result["qualityFlags"] = sorted(set(flags))
        cleaned.append(result)
    if not cleaned and source.kind != "homework":
        raise CrawlFailure("empty_notice_list")
    return cleaned


def clean_detail(detail: dict, *, allow_empty: bool = False) -> dict:
    title = " ".join(detail.get("title", "").split())
    content = detail.get("content", "").strip()
    flags = _quality_flags(detail.get("qualityFlags", []))
    if not content and not allow_empty:
        if "image_only" in flags:
            raise CrawlFailure("image_only_article")
        if "attachment_only" in flags:
            raise CrawlFailure("attachment_only_article")
    if not title or (not content and not allow_empty):
        raise CrawlFailure("empty_article_body")
    published = detail.get("publishedAt", "")
    if published:
        try:
            date.fromisoformat(published)
        except (TypeError, ValueError):
            raise CrawlFailure("invalid_article_date") from None
    attachments = []
    seen = set()
    for attachment in detail.get("attachments", []):
        url = attachment.get("url", "")
        if not _safe_metadata_url(url):
            flags.append("attachment_link_redacted")
            continue
        if url not in seen:
            attachments.append({"name": attachment.get("name", ""), "url": url})
            seen.add(url)
    result = {
        "title": title, "content": content, "publishedAt": published,
        "publisher": detail.get("publisher", ""), "attachments": attachments,
        "qualityFlags": sorted(set(flags)),
    }
    if allow_empty:
        try:
            result["homework"] = normalize_homework(detail.get("homework"))
        except ValueError:
            raise CrawlFailure("invalid_homework_metadata") from None
    if "images" in detail:
        images = []
        seen_images = set()
        for image in detail.get("images") or []:
            url = image.get("url", "") if isinstance(image, dict) else image
            if not _safe_metadata_url(url):
                flags.append("image_link_redacted")
                continue
            if url not in seen_images:
                images.append(url)
                seen_images.add(url)
        result["images"] = images
        result["qualityFlags"] = sorted(set(flags))
    return result
