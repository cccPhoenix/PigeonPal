"""Synthetic fixtures only: authenticated ITC acceptance is deferred."""

from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from itc_html import AuthenticationRequired, parse_article, parse_list


BASE = "https://itc.zju.edu.cn/90618/list.psp"


def row(article_id="42", *, href=None, published="2026-10-14"):
    href = href or f"/2026/1014/c90618a{article_id}/page.htm"
    return f'<li class="news"><span class="news_title"><a href="{href}" title="完整通知标题">短标题</a></span><span class="news_meta">{published}</span></li>'


class ItcHtmlTests(unittest.TestCase):
    def test_window6_scopes_deduplicates_and_uses_full_title(self):
        for wrapper in ('id="wp_news_w6"', 'frag="窗口6"', 'id="window6"'):
            with self.subTest(wrapper=wrapper):
                html = f'<aside><ul>{row("99")}</ul></aside><div {wrapper}><ul>{row()}{row()}{row(href="https://evil.example/c90618a55/page.htm")}</ul><div id="wp_paging_w6"></div></div>'
                self.assertEqual(parse_list(html, BASE), [{"id": "itc:42", "title": "完整通知标题", "url": "https://itc.zju.edu.cn/2026/1014/c90618a42/page.htm", "publishedAt": "2026-10-14"}])

    def test_pager_finds_nearest_list_ancestor_and_upgrades_http(self):
        html = f'<main><aside><ul>{row("99")}</ul></aside><section><ul>{row(href="http://itc.zju.edu.cn/c90618a42/page.psp?ticket=secret#fragment")}</ul><div id="wp_paging_w6"><span>分页</span></div></section></main>'
        self.assertEqual(parse_list(html, BASE)[0]["url"], "https://itc.zju.edu.cn/c90618a42/page.psp")

    def test_unknown_ambiguous_empty_and_invalid_layouts_fail_privately(self):
        fixtures = [
            f'<body><ul>{row()}</ul></body>',
            f'<main><ul>{row()}</ul><aside><ul>{row("99")}</ul></aside><div id="wp_paging_w6"></div></main>',
            '<div id="wp_news_w6"><ul></ul></div>',
            f'<div id="wp_news_w6"><ul>{row(published="2026-02-30")}</ul></div>',
            f'<div id="wp_news_w6"><ul>{row(href="https://itc.zju.edu.cn.evil.example/c90618a42/page.htm")}</ul></div>',
            f'<div id="wp_news_w6"><ul>{row()}</ul></div><div id="wp_news_w6"><ul>{row("99")}</ul></div>',
        ]
        for html in fixtures:
            with self.subTest(html=html):
                with self.assertRaises(ValueError) as caught:
                    parse_list(html, BASE)
                self.assertNotIn("完整通知标题", str(caught.exception))
                self.assertNotIn("https://", str(caught.exception))

    def test_login_response_is_rejected_by_both_parsers(self):
        login = '<form><input name="username"><input name="password" type="password"></form>'
        for parser in (parse_list, parse_article):
            with self.assertRaisesRegex(AuthenticationRequired, "authentication page"):
                parser(login, BASE)

    def test_article_preserves_body_structure_and_filters_attachments(self):
        html = '<h1 class="arti_title">系统维护</h1><span class="arti_update">2026-10-14</span><span class="arti_publisher">发布者：信息技术中心</span><div class="wp_articlecontent"><p>第一段<script>secret()</script></p><p>第二段</p><table><tr><td>时间</td><td>地点</td></tr></table><a href="http://itc.zju.edu.cn/_upload/article/files/info.pdf">附件</a><a href="https://evil.example/tracker.pdf">站外</a></div><footer>页脚</footer>'
        result = parse_article(html, BASE)
        self.assertEqual(result["title"], "系统维护")
        self.assertEqual(result["publisher"], "信息技术中心")
        self.assertEqual(result["publishedAt"], "2026-10-14")
        self.assertIn("第一段\n\n第二段", result["content"])
        self.assertIn("时间\t地点", result["content"])
        self.assertNotIn("secret()", result["content"])
        self.assertNotIn("页脚", result["content"])
        self.assertEqual(result["attachments"], [{"name": "附件", "url": "https://itc.zju.edu.cn/_upload/article/files/info.pdf"}])

    def test_missing_empty_or_ambiguous_article_body_fails(self):
        for body in ("", '<div class="wp_articlecontent"><script>noise</script></div>', '<div class="wp_articlecontent">一</div><div class="wp_articlecontent">二</div>'):
            with self.assertRaises(ValueError):
                parse_article(f'<h1 class="arti_title">标题</h1>{body}', BASE)


if __name__ == "__main__":
    unittest.main()
