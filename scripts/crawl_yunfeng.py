"""One manual, low-frequency Yunfeng notice crawl (Python standard library only)."""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from yunfeng_html import parse_article, parse_list


SOURCE_URL = "https://yunfeng.zju.edu.cn/on/53544/list.psp"
ALLOWED_HOST = "yunfeng.zju.edu.cn"
DETAIL_LIMIT = 3
MIN_DELAY = 15
MAX_DELAY = 30
MAX_HTML_BYTES = 1024 * 1024
SHANGHAI = timezone(timedelta(hours=8))
ROOT = Path(__file__).resolve().parent.parent


def timestamp() -> str:
    return datetime.now(SHANGHAI).isoformat(timespec="seconds")


class CrawlError(RuntimeError):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Automatic redirects would skip the per-request delay.
        return None


class SlowClient:
    def __init__(self):
        self.opener = build_opener(NoRedirect())
        self.last_finished = None
        self.requests = []

    def _wait(self):
        if self.last_finished is None:
            return
        delay = random.uniform(MIN_DELAY, MAX_DELAY)
        remaining = delay - (time.monotonic() - self.last_finished)
        if remaining > 0:
            print(f"Waiting {remaining:.1f}s before the next request.", flush=True)
            time.sleep(remaining)

    def _request(self, url: str):
        parsed = urlsplit(url)
        if parsed.scheme != "https" or parsed.hostname != ALLOWED_HOST:
            raise CrawlError(f"URL outside the approved HTTPS site: {url}")
        self._wait()
        entry = {"url": url, "startedAt": timestamp()}
        self.requests.append(entry)
        request = Request(
            url,
            headers={
                "User-Agent": "PigeonPal/0.2 (local read-only notice fetcher)",
                "Accept": "text/html,application/xhtml+xml",
            },
            method="GET",
        )
        print(f"GET {url}", flush=True)
        try:
            try:
                response = self.opener.open(request, timeout=30)
            except HTTPError as error:
                response = error
            with response:
                status = response.status
                entry["status"] = status
                if 300 <= status < 400:
                    location = response.headers.get("Location")
                    if not location:
                        raise CrawlError(f"Redirect without a Location header: {url}")
                    return None, location
                if status != 200:
                    raise CrawlError(f"HTTP {status}; stopped this run without retrying: {url}")
                content_type = response.headers.get_content_type()
                if content_type not in {"text/html", "application/xhtml+xml"}:
                    raise CrawlError(f"Expected an HTML page, got {content_type}: {url}")
                body = response.read(MAX_HTML_BYTES + 1)
                if len(body) > MAX_HTML_BYTES:
                    raise CrawlError(f"Page exceeded the 1 MiB HTML limit: {url}")
                encoding = response.headers.get_content_charset() or "utf-8"
                html = body.decode(encoding, errors="replace")
                if "该信息仅允许校内地址访问" in html or "您当前ip并非校内地址" in html:
                    raise CrawlError(f"The site returned a campus-network restriction page: {url}")
                entry["bytes"] = len(body)
                return html, None
        except (URLError, TimeoutError, OSError) as error:
            entry["error"] = str(error)
            raise CrawlError(f"Request failed; stopped this run without retrying: {error}") from error
        finally:
            self.last_finished = time.monotonic()
            entry["finishedAt"] = timestamp()

    def html(self, url: str):
        current = url
        for _ in range(5):
            html, location = self._request(current)
            if location is None:
                return html, current
            target = urlsplit(urljoin(current, location))
            if target.hostname != ALLOWED_HOST or target.scheme not in {"http", "https"}:
                raise CrawlError(f"Redirect outside the approved site: {location}")
            # Reconnaissance confirmed that the .psp destination supports HTTPS.
            # Preserve its path/query, avoiding the server's HTTP downgrade.
            current = urlunsplit(target._replace(scheme="https", fragment=""))
        raise CrawlError("Too many redirects; stopped this run.")


def save_json(path: Path, value: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def crawl(output: Path) -> dict:
    client = SlowClient()
    result = {
        "source": "yunfeng",
        "sourceUrl": SOURCE_URL,
        "startedAt": timestamp(),
        "status": "running",
        "limits": {
            "listPages": 1,
            "articleDetails": DETAIL_LIMIT,
            "concurrency": 1,
            "requestIntervalSeconds": [MIN_DELAY, MAX_DELAY],
            "downloadAttachments": False,
        },
        "items": [],
        "requests": client.requests,
    }
    try:
        html, final_url = client.html(SOURCE_URL)
        items = parse_list(html, final_url)
        for item in items:
            item["contentFetched"] = False
        result["items"] = items
        print(f"Found {len(items)} notices on the first page.", flush=True)
        selected = sorted(
            range(len(items)), key=lambda index: items[index]["publishedAt"], reverse=True
        )[:DETAIL_LIMIT]
        for number, index in enumerate(selected, 1):
            item = items[index]
            original_url = item["url"]
            html, final_url = client.html(original_url)
            detail = parse_article(html, final_url)
            item.update(detail)
            item.update({"originalUrl": original_url, "url": final_url, "contentFetched": True})
            print(
                f"Article {number}/{len(selected)}: {item['title']} "
                f"({len(item['content'])} characters, {len(item['attachments'])} attachment links).",
                flush=True,
            )
        result["status"] = "complete"
        result["summary"] = {
            "listItems": len(items),
            "articlesFetched": sum(item["contentFetched"] for item in items),
            "attachmentLinks": sum(len(item.get("attachments", [])) for item in items),
            "requests": len(client.requests),
        }
    except (CrawlError, ValueError) as error:
        result["status"] = "stopped"
        result["error"] = str(error)
        print(f"Stopped: {error}", file=sys.stderr, flush=True)
    except KeyboardInterrupt:
        result["status"] = "interrupted"
        result["error"] = "Interrupted; preserved any results collected so far."
    finally:
        result["finishedAt"] = timestamp()
        save_json(output, result)
        print(f"Saved {output}", flush=True)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "data" / "yunfeng-notices.json")
    args = parser.parse_args()
    result = crawl(args.output.resolve())
    return 0 if result["status"] == "complete" else 1


if __name__ == "__main__":
    raise SystemExit(main())
