"""Parse the Undergraduate School's public list and article templates."""

from __future__ import annotations

from qsxy_html import _article_detail, _calendar_date, _listed_notice
from yunfeng_html import _Node, _class_nodes, _compact, _text, _tree, _walk


def _title_text(anchor: _Node) -> str:
    title = _compact(anchor.attrs.get("title", ""))
    if title:
        return title
    # The anchor includes both the title paragraph and a date block.
    title = next((_compact(_text(node)) for node in _walk(anchor)
                  if node.tag == "p" and _compact(_text(node))), "")
    if title:
        return title

    def without_date(node: _Node) -> str:
        if node.has_class("time") or node.has_class("y"):
            return ""
        return "".join(child if isinstance(child, str) else without_date(child) for child in node.children)

    return _compact(without_date(anchor))


def parse_list(html: str, base_url: str) -> list[dict]:
    root = _tree(html)
    containers = [node for node in _walk(root) if node.tag == "ul" and node.has_class("right-list")]
    if len(containers) != 1:
        raise ValueError("Undergraduate notice list container is missing or ambiguous")
    items, seen = [], set()
    for row in containers[0].children:
        if not isinstance(row, _Node) or row.tag != "li" or not row.has_class("right-list-item"):
            continue
        anchors = [node for node in row.children if isinstance(node, _Node) and node.tag == "a" and "href" in node.attrs]
        if len(anchors) != 1:
            raise ValueError("Undergraduate notice title link is missing or ambiguous")
        anchor = anchors[0]
        title = _title_text(anchor)
        if not title:
            raise ValueError("Undergraduate notice title is empty")
        dates = _class_nodes(anchor, "time") or _class_nodes(anchor, "y")
        published = _calendar_date(" ".join(_text(node) for node in dates))
        item = _listed_notice("bksy", anchor.attrs["href"], base_url, title, published)
        if item["id"] not in seen:
            items.append(item)
            seen.add(item["id"])
    if not items:
        raise ValueError("Undergraduate notice list contains no notices")
    return items


def parse_article(html: str, base_url: str) -> dict:
    root = _tree(html)
    # Restrict headings and metadata to the article, excluding navigation and footer.
    scopes = [node for node in _class_nodes(root, "article") if _class_nodes(node, "wp_articlecontent")]
    if len(scopes) != 1:
        raise ValueError("Undergraduate article container is missing or ambiguous")
    scope = scopes[0]
    headers = _class_nodes(scope, "article-title")
    if len(headers) != 1:
        raise ValueError("Undergraduate article heading is missing or ambiguous")
    header = headers[0]
    titles = list(dict.fromkeys(_compact(_text(node)) for node in _walk(header)
                               if node.tag in {"h1", "h2", "h3"} and _compact(_text(node))))
    if len(titles) != 1:
        raise ValueError("Undergraduate article title is missing or ambiguous")
    published = _calendar_date(" ".join(_text(node) for node in _class_nodes(header, "time")
                                       or _class_nodes(header, "arti_update")), required=False)
    publisher = ""
    for name in ("arti_publisher_zz", "arti_publisher_fbz", "arti_publisher"):
        publisher = next((_compact(_text(node)) for node in _class_nodes(header, name) if _compact(_text(node))), "")
        if publisher:
            break
    return _article_detail(scope, base_url, titles[0], published, publisher)
