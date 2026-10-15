"""Parse public Qiushi College notices without fetching linked resources."""

from __future__ import annotations

from datetime import date
from hashlib import sha256
import re
from urllib.parse import unquote, urlsplit, urlunsplit

from crawlers.http import has_sensitive_query
from yunfeng_html import (
    _ATTACHMENT_SUFFIXES, _Node, _body_text, _class_nodes, _compact,
    _http_url, _text, _tree, _walk,
)


_ARTICLE_RE = re.compile(r"/c\d+a(\d+)/(?:page\.(?:htm|html|psp))$", re.I)
_DATE_RE = re.compile(r"(?<!\d)(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})(?:日)?(?!\d)")


def _calendar_date(value: str, *, required: bool = True) -> str:
    values = set()
    for year, month, day in _DATE_RE.findall(value):
        try:
            values.add(date(int(year), int(month), int(day)).isoformat())
        except ValueError:
            raise ValueError("Public notice publication date is invalid") from None
    if not values and not required:
        return ""
    if len(values) != 1:
        raise ValueError("Public notice publication date is missing or ambiguous")
    return values.pop()


def _safe_public_link(href: str, base_url: str) -> str | None:
    """Keep public HTTP(S) links, rejecting credentials and authentication URLs."""
    try:
        if not href.strip() or "#" in href or any(ord(c) < 32 for c in href):
            return None
        url = _http_url(href, base_url)
        if url is None:
            return None
        parsed = urlsplit(url)
        path = unquote(parsed.path).lower()
        if (parsed.port not in {None, 80 if parsed.scheme == "http" else 443} or ";" in path
                or has_sensitive_query(url) or parsed.hostname == "zjuam.zju.edu.cn"
                or "/cas/" in path):
            return None
        return url
    except ValueError:
        return None


def _attachment_path(path: str) -> bool:
    path = unquote(path).lower()
    return "/_upload/article/files/" in path or any(path.endswith(suffix) for suffix in _ATTACHMENT_SUFFIXES)


def _listed_notice(source: str, href: str, base_url: str, title: str, published_at: str) -> dict:
    """Retain special rows as metadata instead of following arbitrary links."""
    url = _safe_public_link(href, base_url)
    flags = []
    fetchable = False
    article_id = None
    if url is None:
        # Do not hash or persist the unsafe URL: it may contain a live ticket.
        url = base_url
        flags.append("unsafe_link_redacted")
        identity = f"{title}\n{published_at}"
    else:
        parsed = urlsplit(url)
        same_host = parsed.hostname == urlsplit(base_url).hostname
        match = _ARTICLE_RE.search(parsed.path)
        if same_host and match:
            scheme = parsed.scheme if source == "qsxy" else "https"
            url = urlunsplit((scheme, parsed.hostname or "", parsed.path, "", ""))
            article_id = match.group(1)
            fetchable = True
        else:
            if not same_host:
                flags.append("external_link")
            if _attachment_path(parsed.path):
                flags.append("attachment_only")
            elif same_host:
                flags.append("unsupported_link")
        identity = url
    item_id = f"{source}:{article_id}" if article_id else f"{source}:link_{sha256(identity.encode('utf-8')).hexdigest()[:16]}"
    result = {"id": item_id, "title": title, "url": url, "publishedAt": published_at}
    if not fetchable:
        result.update(fetchable=False, qualityFlags=flags)
    return result


def _article_detail(root: _Node, base_url: str, title: str, published_at: str, publisher: str) -> dict:
    """Reuse the shared text renderer and only collect attachment references."""
    bodies = _class_nodes(root, "wp_articlecontent")
    if len(bodies) != 1:
        raise ValueError("Public notice article body is missing or ambiguous")
    body = bodies[0]
    content = _body_text(body)
    flags = []
    images = []
    image_nodes = [node for node in _walk(body) if node.tag == "img" and node.attrs.get("src")]
    for node in image_nodes:
        url = _safe_public_link(node.attrs["src"], base_url)
        if url is None:
            flags.append("image_link_redacted")
        elif url not in images:
            images.append(url)
    attachments = []
    seen = set()
    for anchor in _walk(body):
        if anchor.tag != "a" or not anchor.attrs.get("href"):
            continue
        href = anchor.attrs["href"]
        try:
            if not _attachment_path(urlsplit(href).path):
                continue
        except ValueError:
            continue
        url = _safe_public_link(href, base_url)
        if url is None:
            flags.append("attachment_link_redacted")
            continue
        if url in seen:
            continue
        path = unquote(urlsplit(url).path)
        name = _compact(_text(anchor)) or _compact(anchor.attrs.get("title", "")) or path.rsplit("/", 1)[-1]
        attachments.append({"name": name, "url": url})
        seen.add(url)
    if not content:
        if image_nodes:
            flags.append("image_only")
        elif attachments:
            flags.append("attachment_only")
        else:
            raise ValueError("Public notice article body is empty")
    return {"title": title, "publishedAt": published_at, "publisher": publisher,
            "content": content, "attachments": attachments, "images": images,
            "qualityFlags": sorted(set(flags))}


def parse_list(html: str, base_url: str) -> list[dict]:
    """Read only the primary notice window, preserving its order and deduplicating."""
    root = _tree(html)
    containers = [node for node in _walk(root) if node.attrs.get("id") == "wp_news_w6"]
    if len(containers) != 1:
        raise ValueError("Qiushi notice list container is missing or ambiguous")
    items, seen = [], set()
    for row in _walk(containers[0]):
        if row.tag != "li" or not row.has_class("news"):
            continue
        anchors = [node for title in _class_nodes(row, "news_title") for node in _walk(title)
                   if node.tag == "a" and "href" in node.attrs]
        if not anchors:
            raise ValueError("Qiushi notice title link is missing")
        anchor = anchors[0]
        title = _compact(anchor.attrs.get("title", "")) or _compact(_text(anchor))
        if not title:
            raise ValueError("Qiushi notice title is empty")
        published = _calendar_date(" ".join(_text(node) for node in _class_nodes(row, "news_meta")))
        item = _listed_notice("qsxy", anchor.attrs["href"], base_url, title, published)
        if item["id"] not in seen:
            items.append(item)
            seen.add(item["id"])
    if not items:
        raise ValueError("Qiushi notice list contains no notices")
    return items


def parse_article(html: str, base_url: str) -> dict:
    root = _tree(html)
    title = next((_compact(_text(node)) for node in _class_nodes(root, "arti_title") if _compact(_text(node))), "")
    if not title:
        raise ValueError("Qiushi article title is missing")
    published = _calendar_date(" ".join(_text(node) for node in _class_nodes(root, "arti_update")), required=False)
    publisher = next((_compact(_text(node)) for node in _class_nodes(root, "arti_publisher") if _compact(_text(node))), "")
    publisher = re.sub(r"^(?:发布者|作者|编辑)\s*[:：]\s*", "", publisher)
    return _article_detail(root, base_url, title, published, publisher)
