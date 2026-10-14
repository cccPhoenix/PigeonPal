"""Parse ITC WebPlus pages without making network requests.

The authenticated template still needs live acceptance when an auth provider is
connected. Until then, unknown or ambiguous layouts fail explicitly.
"""

from __future__ import annotations

from datetime import date
from hashlib import sha256
import re
from urllib.parse import unquote, urlsplit, urlunsplit

from yunfeng_html import (
    _ATTACHMENT_SUFFIXES, _DATE_RE, _Node, _body_text, _class_nodes,
    _compact, _http_url, _text, _tree, _walk,
)


_ARTICLE_RE = re.compile(r"/c\d+a(\d+)(?:/|$)")
_GROUP_TAGS = {"ul", "ol", "tbody", "table"}


class AuthenticationRequired(ValueError):
    """A protected page returned an authentication form instead of content."""


def _calendar_date(text: str, *, required: bool) -> str:
    matches = list(dict.fromkeys(_DATE_RE.findall(text)))
    if not matches and not required:
        return ""
    if len(matches) != 1:
        raise ValueError("ITC publication date is missing or ambiguous")
    try:
        return date.fromisoformat(matches[0]).isoformat()
    except ValueError:
        raise ValueError("ITC publication date is invalid") from None


def _https_url(href: str, base_url: str) -> str | None:
    try:
        url = _http_url(href, base_url, same_host=True)
        if url is None:
            return None
        parsed = urlsplit(url)
        if parsed.port not in {None, 80, 443}:
            return None
    except ValueError:
        return None
    # WebPlus HTTP links work over HTTPS; fragments and query strings are not
    # needed for these static article/attachment paths and may carry tickets.
    return urlunsplit(("https", parsed.hostname or "", parsed.path, "", ""))


def _notice_url(href: str, base_url: str) -> str | None:
    url = _https_url(href, base_url)
    if url is None or _ARTICLE_RE.search(urlsplit(url).path) is None:
        return None
    return url


def _article_id(url: str) -> str:
    match = _ARTICLE_RE.search(urlsplit(url).path)
    value = match.group(1) if match else sha256(url.encode("utf-8")).hexdigest()[:16]
    return f"itc:{value}"


def _reject_login(root: _Node) -> None:
    inputs = [node for node in _walk(root) if node.tag == "input"]
    password = any(node.attrs.get("type", "").lower() == "password" for node in inputs)
    identity = any(node.attrs.get("name", "").lower() in {"username", "user", "identity"} for node in inputs)
    if password and identity:
        raise AuthenticationRequired("ITC authentication page returned instead of content")


def _parents(root: _Node) -> dict[int, _Node]:
    parents = {}
    for parent in _walk(root):
        for child in parent.children:
            if isinstance(child, _Node):
                parents[id(child)] = parent
    return parents


def _rows(container: _Node) -> list[_Node]:
    candidates = [
        node for node in _walk(container)
        if (node.has_class("news") or node.tag in {"li", "tr"})
        and _class_nodes(node, "news_title") and _class_nodes(node, "news_meta")
    ]
    candidate_ids = {id(node) for node in candidates}
    return [
        node for node in candidates
        if not any(id(child) in candidate_ids for child in _walk(node) if child is not node)
    ]


def _single_group(rows: list[_Node], container: _Node, parents: dict[int, _Node]) -> bool:
    groups = set()
    for row in rows:
        current = parents.get(id(row))
        direct_parent = current
        while current is not None and current is not container and current.tag not in _GROUP_TAGS:
            current = parents.get(id(current))
        groups.add(id(current if current is not None and current.tag in _GROUP_TAGS else direct_parent))
    return len(groups) == 1


def _list_container(root: _Node, parents: dict[int, _Node]) -> _Node:
    nodes = list(_walk(root))
    explicit = [node for node in nodes if node.attrs.get("id") == "wp_news_w6"]
    if len(explicit) > 1:
        raise ValueError("ITC window 6 notice container is ambiguous")
    if explicit:
        return explicit[0]
    windows = [
        node for node in nodes
        if node.attrs.get("frag", "").strip().lower() in {"窗口6", "window6"}
        or node.attrs.get("id", "").lower() == "window6"
    ]
    if len(windows) > 1:
        raise ValueError("ITC window 6 notice container is ambiguous")
    if windows:
        return windows[0]
    pagers = [node for node in nodes if node.attrs.get("id") == "wp_paging_w6"]
    if len(pagers) != 1:
        raise ValueError("ITC window 6 notice container was not found")
    current = parents.get(id(pagers[0]))
    while current is not None:
        rows = _rows(current)
        if rows:
            if current.tag in {"root", "html", "body"} or not _single_group(rows, current, parents):
                raise ValueError("ITC window 6 notice container is ambiguous")
            return current
        current = parents.get(id(current))
    raise ValueError("ITC window 6 notice rows were not found")


def parse_list(html: str, base_url: str) -> list[dict]:
    """Return dated article rows from window 6, excluding other page lists."""
    root = _tree(html)
    _reject_login(root)
    parents = _parents(root)
    container = _list_container(root, parents)
    rows = _rows(container)
    if rows and not _single_group(rows, container, parents):
        raise ValueError("ITC window 6 notice rows are ambiguous")
    items = []
    seen = set()
    for row in rows:
        anchors = [
            node for title in _class_nodes(row, "news_title") for node in _walk(title)
            if node.tag == "a" and node.attrs.get("href")
        ]
        if len(anchors) != 1:
            raise ValueError("ITC notice title link is missing or ambiguous")
        anchor = anchors[0]
        url = _notice_url(anchor.attrs["href"], base_url)
        if url is None:
            continue
        title = _compact(anchor.attrs.get("title", "")) or _compact(_text(anchor))
        if not title:
            raise ValueError("ITC notice title is empty")
        published_at = _calendar_date(" ".join(_text(node) for node in _class_nodes(row, "news_meta")), required=True)
        item_id = _article_id(url)
        if item_id in seen:
            continue
        seen.add(item_id)
        items.append({"id": item_id, "title": title, "url": url, "publishedAt": published_at})
    if not items:
        raise ValueError("ITC notice list contained no valid same-host dated articles")
    return items


def parse_article(html: str, base_url: str) -> dict:
    """Return WebPlus article text and same-host HTTPS attachment references."""
    root = _tree(html)
    _reject_login(root)
    titles = list(dict.fromkeys(_compact(_text(node)) for node in _class_nodes(root, "arti_title") if _compact(_text(node))))
    if len(titles) != 1:
        raise ValueError("ITC article title is missing or ambiguous")
    bodies = _class_nodes(root, "wp_articlecontent")
    if len(bodies) != 1:
        raise ValueError("ITC article body is missing or ambiguous")
    content = _body_text(bodies[0])
    if not content:
        raise ValueError("ITC article body is empty")
    published_at = _calendar_date(" ".join(_text(node) for node in _class_nodes(root, "arti_update")), required=False)
    publishers = _class_nodes(root, "arti_publisher")
    publisher = _compact(_text(publishers[0])) if publishers else ""
    publisher = re.sub(r"^发布者\s*[:：]\s*", "", publisher)
    attachments = []
    seen = set()
    for anchor in _walk(bodies[0]):
        if anchor.tag != "a" or not anchor.attrs.get("href"):
            continue
        url = _https_url(anchor.attrs["href"], base_url)
        if url is None or url in seen:
            continue
        path = unquote(urlsplit(url).path)
        if "/_upload/article/files/" not in path.lower() and not any(path.lower().endswith(suffix) for suffix in _ATTACHMENT_SUFFIXES):
            continue
        name = _compact(_text(anchor)) or _compact(anchor.attrs.get("title", "")) or path.rsplit("/", 1)[-1]
        attachments.append({"name": name, "url": url})
        seen.add(url)
    return {"title": titles[0], "publishedAt": published_at, "publisher": publisher, "content": content, "attachments": attachments}
