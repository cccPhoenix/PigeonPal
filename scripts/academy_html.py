"""Parse the public WebPlus notice sections for the two academy sites."""

from datetime import date
import re
from urllib.parse import urlsplit

from yunfeng_html import _class_nodes, _compact, _http_url, _text, _tree, _walk, parse_article


_ARTICLE = re.compile(r"/c\d+a(\d+)(?:/|$)")
_DATE = re.compile(r"(?<!\d)(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})(?:日)?(?!\d)")


def _entries(container):
    return [node for node in _walk(container) if node.tag in {"li", "tr"}
            and _class_nodes(node, "news_title")]


def _notice_container(root, window):
    matches = [node for node in _walk(root) if node.attrs.get("id") == window]
    if len(matches) != 1:
        raise ValueError("Academy notice section is missing or ambiguous")
    return matches[0]


def _parse_list(html, base_url, source_id, window):
    container = _notice_container(_tree(html), window)
    items, seen = [], set()
    for entry in _entries(container):
        links = {}
        for title in _class_nodes(entry, "news_title"):
            for anchor in _walk(title):
                if anchor.tag != "a" or not anchor.attrs.get("href"):
                    continue
                url = _http_url(anchor.attrs["href"], base_url, same_host=True)
                match = _ARTICLE.search(urlsplit(url).path) if url else None
                if match:
                    links[match[1]] = (anchor, url)
        # External announcements link out from both sites. Leave them on the
        # original site rather than enqueueing an unsupported third-party host.
        if not links:
            continue
        if len(links) != 1:
            raise ValueError("Academy notice title link is ambiguous")
        article_id, (anchor, url) = next(iter(links.items()))
        title = _compact(anchor.attrs.get("title", "")) or _compact(_text(anchor))
        metas = _class_nodes(entry, "news_meta")
        date_text = " ".join(_text(node) for node in metas)
        raw_dates = _DATE.findall(date_text)
        dates = {date(int(year), int(month), int(day)).isoformat() for year, month, day in raw_dates}
        if not title or len(dates) != 1:
            raise ValueError("Academy notice title or publication date is missing or ambiguous")
        if article_id in seen:
            continue
        seen.add(article_id)
        items.append({"id": f"{source_id}:{article_id}", "title": title, "url": url,
                      "publishedAt": next(iter(dates))})
    if not items:
        raise ValueError("Academy notice list is empty")
    return items


def parse_lantian_list(html, base_url):
    # Verified homepage: w51 is notifications, w53 is comprehensive news;
    # the latter repeats many of the same notices among other stories.
    return _parse_list(html, base_url, "lantian", "wp_news_w51")


def parse_danyang_list(html, base_url):
    # The latest-notice column linked from the homepage; its list uses full
    # dates, unlike the homepage's split-date w32 and separate public w33.
    return _parse_list(html, base_url, "danyang", "wp_news_w6")
