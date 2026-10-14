"""Parse Yunfeng notice pages without fetching any URLs.

These selectors are specific to the site's current WebPlus templates. A missing
list or article body is an error so template changes do not yield empty data.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from hashlib import sha256
from html.parser import HTMLParser
import re
from urllib.parse import unquote, urldefrag, urljoin, urlsplit


_VOID_TAGS = {
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
    "meta", "param", "source", "track", "wbr",
}
_IGNORED_TAGS = {"script", "style", "nav", "noscript", "template"}
_PARAGRAPH_TAGS = {
    "address", "article", "blockquote", "div", "dl", "dt", "dd", "fieldset",
    "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6", "p",
    "pre", "section", "ul", "ol", "table",
}
_ATTACHMENT_SUFFIXES = {
    ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".pdf", ".zip",
    ".rar", ".7z", ".tar", ".gz", ".txt", ".csv", ".rtf", ".odt",
    ".ods", ".odp",
}
_DATE_RE = re.compile(r"\b\d{4}-\d{2}-\d{2}\b")


@dataclass
class _Node:
    tag: str
    attrs: dict[str, str] = field(default_factory=dict)
    children: list[_Node | str] = field(default_factory=list)

    def has_class(self, name: str) -> bool:
        return name in self.attrs.get("class", "").split()


class _TreeParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = _Node("root")
        self.stack = [self.root]

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        # HTML commonly omits closing list/table tags; Word-generated content
        # also sometimes omits a paragraph close. Close only within that scope.
        implicit = {"li": {"li"}, "p": {"p"}, "tr": {"tr"}, "td": {"td", "th"}, "th": {"td", "th"}}
        stop_tags = {"li": {"ul", "ol"}, "tr": {"table"}, "td": {"tr"}, "th": {"tr"}}
        if tag in implicit:
            for index in range(len(self.stack) - 1, 0, -1):
                opened = self.stack[index].tag
                if opened in stop_tags.get(tag, set()):
                    break
                if opened in implicit[tag]:
                    del self.stack[index:]
                    break
        node = _Node(tag, {key: value or "" for key, value in attrs})
        self.stack[-1].children.append(node)
        if tag not in _VOID_TAGS:
            self.stack.append(node)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        if tag not in _VOID_TAGS:
            self.handle_endtag(tag)

    def handle_endtag(self, tag: str) -> None:
        if tag in _VOID_TAGS:
            return
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                return

    def handle_data(self, data: str) -> None:
        self.stack[-1].children.append(data)


def _tree(html: str) -> _Node:
    parser = _TreeParser()
    parser.feed(html)
    parser.close()
    return parser.root


def _walk(node: _Node):
    if node.tag in _IGNORED_TAGS:
        return
    yield node
    for child in node.children:
        if isinstance(child, _Node):
            yield from _walk(child)


def _class_nodes(node: _Node, name: str) -> list[_Node]:
    return [child for child in _walk(node) if child.has_class(name)]


def _text(node: _Node) -> str:
    if node.tag in _IGNORED_TAGS:
        return ""
    return "".join(child if isinstance(child, str) else _text(child) for child in node.children)


def _compact(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _http_url(href: str, base_url: str, same_host: bool = False) -> str | None:
    url = urldefrag(urljoin(base_url, href.strip()))[0]
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return None
    if parsed.username or parsed.password:
        return None
    if same_host and parsed.hostname.lower() != (urlsplit(base_url).hostname or "").lower():
        return None
    return url


def _article_id(url: str) -> str:
    match = re.search(r"/c\d+a(\d+)(?:/|$)", urlsplit(url).path)
    value = match.group(1) if match else sha256(url.encode("utf-8")).hexdigest()[:16]
    return f"yunfeng:{value}"


def parse_list(html: str, base_url: str) -> list[dict]:
    """Return the notice list's ordered, deduplicated metadata.

    Only ``#wp_news_w6 li.news`` is considered: the site's footer contains
    unrelated news lists. Article links must be HTTP(S) on the same hostname.
    """
    root = _tree(html)
    container = next((node for node in _walk(root) if node.attrs.get("id") == "wp_news_w6"), None)
    if container is None:
        raise ValueError("Yunfeng notice list container #wp_news_w6 was not found")
    items = []
    seen = set()
    for entry in _walk(container):
        if entry.tag != "li" or not entry.has_class("news"):
            continue
        title_nodes = _class_nodes(entry, "news_title")
        anchor = next((node for title in title_nodes for node in _walk(title) if node.tag == "a" and node.attrs.get("href")), None)
        if anchor is None:
            continue
        url = _http_url(anchor.attrs["href"], base_url, same_host=True)
        if url is None:
            continue
        title = _compact(anchor.attrs.get("title", "")) or _compact(_text(anchor))
        metas = _class_nodes(entry, "news_meta")
        date = _DATE_RE.search(" ".join(_text(node) for node in metas))
        if not title or date is None:
            raise ValueError(f"Yunfeng notice is missing its title or publication date: {url}")
        item_id = _article_id(url)
        if item_id in seen:
            continue
        seen.add(item_id)
        items.append({"id": item_id, "title": title, "url": url, "publishedAt": date.group(0)})
    if not items:
        raise ValueError("Yunfeng notice list contained no valid same-host notices")
    return items


def _body_text(node: _Node) -> str:
    fragments = []

    def render(current: _Node) -> None:
        if current.tag in _IGNORED_TAGS:
            return
        if current.tag in {"br", "hr"}:
            fragments.append("\n")
            return
        if current.tag in _PARAGRAPH_TAGS:
            fragments.append("\n\n")
        elif current.tag in {"td", "th"}:
            fragments.append("\t")
        for child in current.children:
            if isinstance(child, str):
                # Collapse HTML source whitespace before inserting structural
                # line breaks, preserving adjacent Chinese inline text.
                fragments.append(re.sub(r"\s+", " ", child))
            else:
                render(child)
        if current.tag in _PARAGRAPH_TAGS:
            fragments.append("\n\n")
        elif current.tag in {"li", "tr"}:
            fragments.append("\n")

    render(node)
    lines = []
    for line in "".join(fragments).split("\n"):
        cells = [re.sub(r"[^\S\t]+", " ", cell).strip() for cell in line.split("\t")]
        lines.append("\t".join(cells).strip("\t "))
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def parse_article(html: str, base_url: str) -> dict:
    """Return article metadata, readable body text, and attachment links.

    Attachment links are collected from the article body only; nothing is
    downloaded, including images, attached files, and external form links.
    """
    root = _tree(html)
    title = next((_compact(_text(node)) for node in _class_nodes(root, "arti_title") if _compact(_text(node))), "")
    if not title:
        raise ValueError("Yunfeng article has no nonempty .arti_title")
    body = next(iter(_class_nodes(root, "wp_articlecontent")), None)
    if body is None:
        raise ValueError("Yunfeng article body .wp_articlecontent was not found")
    content = _body_text(body)
    if not content:
        raise ValueError("Yunfeng article body is empty")
    metas = _class_nodes(root, "arti_update")
    date = _DATE_RE.search(" ".join(_text(node) for node in metas))
    publisher_nodes = _class_nodes(root, "arti_publisher")
    publisher = _compact(_text(publisher_nodes[0])) if publisher_nodes else ""
    publisher = re.sub(r"^发布者\s*[:：]\s*", "", publisher)
    attachments = []
    seen = set()
    for anchor in _walk(body):
        if anchor.tag != "a" or not anchor.attrs.get("href"):
            continue
        url = _http_url(anchor.attrs["href"], base_url)
        if url is None or url in seen:
            continue
        path = unquote(urlsplit(url).path)
        if "/_upload/article/files/" not in path.lower() and not any(path.lower().endswith(suffix) for suffix in _ATTACHMENT_SUFFIXES):
            continue
        name = _compact(_text(anchor)) or _compact(anchor.attrs.get("title", "")) or path.rsplit("/", 1)[-1]
        attachments.append({"name": name, "url": url})
        seen.add(url)
    return {
        "title": title,
        "publishedAt": date.group(0) if date else "",
        "publisher": publisher,
        "content": content,
        "attachments": attachments,
    }
