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
    _ATTACHMENT_SUFFIXES, _Node, _body_text, _class_nodes,
    _compact, _http_url, _text, _tree, _walk,
)


_ARTICLE_RE = re.compile(r"/c\d+a(\d+)(?:/|$)")
_GROUP_TAGS = {"ul", "ol", "tbody", "table"}
_ITC_DATE_RE = re.compile(r"(?<!\d)(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})(?:日)?(?!\d)")


class AuthenticationRequired(ValueError):
    """A protected page returned an authentication form instead of content."""


def _calendar_date(text: str, *, required: bool) -> str:
    matches = []
    for year, month, day in _ITC_DATE_RE.findall(text):
        try:
            value = date(int(year), int(month), int(day)).isoformat()
        except ValueError:
            raise ValueError("ITC publication date is invalid") from None
        if value not in matches:
            matches.append(value)
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
    def article_links(node):
        return {child.attrs["href"] for child in _walk(node)
                if child.tag == "a" and child.attrs.get("href")
                and _ARTICLE_RE.search(urlsplit(child.attrs["href"]).path)}

    candidates = [
        node for node in _walk(container)
        if node.has_class("news") or node.tag in {"li", "tr", "div"}
        if (_class_nodes(node, "news_title") and _class_nodes(node, "news_meta"))
        or (len(article_links(node)) == 1 and _ITC_DATE_RE.search(_text(node)))
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
    # Window numbers belong to each site's template, not the article column.
    # Prefer the list associated with a WebPlus pager over header/footer lists.
    pagers = [node for node in nodes if re.fullmatch(r"wp_paging_w\d+", node.attrs.get("id", ""))]
    candidates = {}
    for pager in pagers:
        current = parents.get(id(pager))
        while current is not None and current.tag not in {"root", "html", "body"}:
            rows = _rows(current)
            if rows:
                if _single_group(rows, current, parents):
                    candidates[id(current)] = current
                break
            current = parents.get(id(current))
    if len(candidates) == 1:
        return next(iter(candidates.values()))
    if len(candidates) > 1:
        raise ValueError("ITC paginated notice list is ambiguous")
    # Some short columns do not render a pager. Accept one explicit news
    # window, but do not combine unrelated lists just to get non-empty output.
    explicit = [node for node in nodes
                if re.fullmatch(r"wp_news_w\d+", node.attrs.get("id", ""))
                and _rows(node) and _single_group(_rows(node), node, parents)]
    if len(explicit) == 1:
        return explicit[0]
    raise ValueError("ITC notice list container is missing or ambiguous")


def parse_list(html: str, base_url: str) -> list[dict]:
    """Return dated article rows from the main list, excluding other widgets."""
    root = _tree(html)
    _reject_login(root)
    parents = _parents(root)
    container = _list_container(root, parents)
    rows = _rows(container)
    if rows and not _single_group(rows, container, parents):
        raise ValueError("ITC notice rows are ambiguous")
    items = []
    seen = set()
    for row in rows:
        anchors = [
            node for title in _class_nodes(row, "news_title") for node in _walk(title)
            if node.tag == "a" and node.attrs.get("href")
        ]
        if not anchors:
            anchors = [node for node in _walk(row)
                       if node.tag == "a" and node.attrs.get("href")
                       and _notice_url(node.attrs["href"], base_url)
                       and (_compact(node.attrs.get("title", "")) or _compact(_text(node)))]
        # Templates can repeat a title link around an icon and the text.
        unique = {}
        for anchor in anchors:
            key = _notice_url(anchor.attrs["href"], base_url)
            if key is not None and (key not in unique or len(_text(anchor)) > len(_text(unique[key]))):
                unique[key] = anchor
        if anchors and not unique:
            continue
        anchors = list(unique.values())
        if len(anchors) != 1:
            raise ValueError("ITC notice title link is missing or ambiguous")
        anchor = anchors[0]
        url = _notice_url(anchor.attrs["href"], base_url)
        if url is None:
            continue
        title = _compact(anchor.attrs.get("title", "")) or _compact(_text(anchor))
        if not title:
            raise ValueError("ITC notice title is empty")
        metas = _class_nodes(row, "news_meta")
        published_at = _calendar_date(" ".join(_text(node) for node in metas) if metas else _text(row), required=False)
        item_id = _article_id(url)
        if item_id in seen:
            continue
        seen.add(item_id)
        items.append({"id": item_id, "title": title, "url": url, "publishedAt": published_at})
    if not items:
        raise ValueError("ITC notice list contained no valid same-host dated articles")
    return items


def list_diagnostics(html: str) -> dict[str, int]:
    """Only structural counts; no page text, identities, cookies or URLs."""
    root = _tree(html)
    nodes = list(_walk(root))
    return {
        "itcArticleLinks": sum(node.tag == "a" and bool(_ARTICLE_RE.search(
            urlsplit(node.attrs.get("href", "")).path)) for node in nodes),
        "itcDateCount": len(_ITC_DATE_RE.findall(_text(root))),
        "itcStructuredRows": len(_rows(root)),
        "itcPagerCount": sum(bool(re.fullmatch(r"wp_paging_w\d+", node.attrs.get("id", ""))) for node in nodes),
        "itcNewsWindowCount": sum(bool(re.fullmatch(r"wp_news_w\d+", node.attrs.get("id", ""))) for node in nodes),
    }


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
