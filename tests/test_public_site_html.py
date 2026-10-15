"""Small offline fixtures for the two public WebPlus adapters."""

from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import bksy_html
import qsxy_html


QSXY = "http://qsxy.zju.edu.cn/30845/list.psp"
BKSY = "https://bksy.zju.edu.cn/28418/list.htm"


def qiushi_row(href="/2026/1013/c30845a42/page.htm", *, title="完整通知", date="2026-10-13"):
    return (f'<li class="news n1"><span class="news_title"><a href="{href}" title="{title}">显示标题</a></span>'
            f'<span class="news_meta">{date}</span></li>')


def undergrad_row(href="/2026/1013/c28418a42/page.htm", *, title="本科通知", date="2026-10-13", attr=""):
    return (f'<li class="right-list-item wow"><a href="{href}" {attr}>'
            f'<p><img src="/top.gif">{title}</p><div class="time"><span class="y">{date}</span></div></a></li>')


def undergrad_article(body, *, heading="h3", publisher=""):
    return (f'<aside><h2>导航标题</h2></aside><div class="article"><div class="article-title">'
            f'<{heading}>本科正文标题</{heading}><p><span class="time">时间：2026-10-13</span>'
            '<span class="arti_publisher_fbz">编辑姓名</span>'
            f'<span class="arti_publisher_zz">{publisher}</span></p></div>'
            f'<div class="article-content"><div class="wp_articlecontent">{body}</div></div></div>'
            '<footer>页脚内容</footer>')


class PublicListTests(unittest.TestCase):
    def test_qiushi_window_scope_title_fallback_and_column_independent_id(self):
        html = (f'<aside>{qiushi_row("/c30845a99/page.htm")}</aside><div id="wp_news_w6"><ul>'
                + qiushi_row() + qiushi_row("/2026/1013/c999a42/page.psp")
                + qiushi_row("/c999a43/page.htm", title="", date="2026年10月3日") + '</ul></div>')
        rows = qsxy_html.parse_list(html, QSXY)
        self.assertEqual([row["id"] for row in rows], ["qsxy:42", "qsxy:43"])
        self.assertEqual(rows[0]["title"], "完整通知")
        self.assertEqual(rows[0]["url"], "http://qsxy.zju.edu.cn/2026/1013/c30845a42/page.htm")
        self.assertEqual(rows[1]["title"], "显示标题")
        self.assertEqual(rows[1]["publishedAt"], "2026-10-03")

    def test_undergraduate_list_uses_title_paragraph_not_date_and_deduplicates(self):
        html = '<ul class="right-list">' + undergrad_row() + undergrad_row() + undergrad_row("http://bksy.zju.edu.cn/c999a43/page.psp", attr='title="完整本科标题"') + '</ul>'
        rows = bksy_html.parse_list(html, BKSY)
        self.assertEqual([row["id"] for row in rows], ["bksy:42", "bksy:43"])
        self.assertEqual(rows[0]["title"], "本科通知")
        self.assertEqual(rows[1]["title"], "完整本科标题")
        self.assertEqual(rows[1]["url"], "https://bksy.zju.edu.cn/c999a43/page.psp")

    def test_external_download_unsupported_and_unsafe_rows_remain_metadata_only(self):
        links = ["https://elsewhere.zju.edu.cn/c1a80/page.htm", "/_upload/article/files/form.docx", "/events/signup", "javascript:open('PRIVATE')", "/c1a99/page.htm?ticket=PRIVATE", "https://zjuam.zju.edu.cn/cas/login?service=PRIVATE"]
        for parser, base, wrapper, make_row in [
            (qsxy_html.parse_list, QSXY, '<div id="wp_news_w6"><ul>{}</ul></div>', qiushi_row),
            (bksy_html.parse_list, BKSY, '<ul class="right-list">{}</ul>', undergrad_row),
        ]:
            with self.subTest(base=base):
                rows = parser(wrapper.format(''.join(make_row(href, title=f"通知{i}") for i, href in enumerate(links))), base)
                self.assertEqual(len(rows), len(links))
                self.assertTrue(all(row["fetchable"] is False for row in rows))
                self.assertEqual(rows[0]["qualityFlags"], ["external_link"])
                self.assertEqual(rows[1]["qualityFlags"], ["attachment_only"])
                self.assertEqual(rows[2]["qualityFlags"], ["unsupported_link"])
                for row in rows[3:]:
                    self.assertEqual(row["url"], base)
                    self.assertEqual(row["qualityFlags"], ["unsafe_link_redacted"])
                self.assertNotIn("PRIVATE", repr(rows))
                self.assertEqual(rows, parser(wrapper.format(''.join(make_row(href, title=f"通知{i}") for i, href in enumerate(links))), base))

    def test_missing_or_invalid_date_and_ambiguous_container_fail_without_page_data(self):
        for parser, base, html in [
            (qsxy_html.parse_list, QSXY, '<div id="wp_news_w6"><ul>' + qiushi_row(date="2026-02-30") + '</ul></div>'),
            (bksy_html.parse_list, BKSY, '<ul class="right-list">' + undergrad_row(date="") + '</ul>'),
            (qsxy_html.parse_list, QSXY, '<div id="wp_news_w6"></div><div id="wp_news_w6"></div>'),
            (bksy_html.parse_list, BKSY, '<ul class="right-list"></ul><ul class="right-list"></ul>'),
        ]:
            with self.subTest(base=base, html=html), self.assertRaises(ValueError) as caught:
                parser(html, base)
            self.assertNotIn("http", str(caught.exception))
            self.assertNotIn("完整通知", str(caught.exception))

    def test_scheme_port_mismatches_and_fragment_tokens_are_redacted_before_storage(self):
        for parser, base, wrapper, make_row, wrong_site_url in [
            (qsxy_html.parse_list, QSXY, '<div id="wp_news_w6"><ul>{}</ul></div>', qiushi_row,
             "http://qsxy.zju.edu.cn:443/c1a42/page.htm"),
            (bksy_html.parse_list, BKSY, '<ul class="right-list">{}</ul>', undergrad_row,
             "https://bksy.zju.edu.cn:80/c1a42/page.htm"),
        ]:
            links = [wrong_site_url, "https://forms.example.edu:80/app", "http://forms.example.edu:443/app",
                     "/c1a42/page.htm#token=PRIVATE", "https://forms.example.edu/app#access_token=PRIVATE"]
            with self.subTest(base=base):
                rows = parser(wrapper.format(''.join(make_row(href, title=f"端口通知{i}") for i, href in enumerate(links))), base)
                self.assertEqual(len(rows), len(links))
                for row in rows:
                    self.assertIs(row["fetchable"], False)
                    self.assertEqual(row["url"], base)
                    self.assertEqual(row["qualityFlags"], ["unsafe_link_redacted"])
                self.assertNotIn("PRIVATE", repr(rows))


class PublicArticleTests(unittest.TestCase):
    def test_qiushi_first_nonempty_heading_body_structure_and_attachment_only_references(self):
        html = ('<h2 class="arti_title"></h2><h1 class="arti_title">求是正文</h1>'
                '<span class="arti_update">发布时间：2026-10-13</span><span class="arti_publisher">发布者：某编辑</span>'
                '<div class="wp_articlecontent"><p>第一段<script>tracking()</script></p><p>第二段</p>'
                '<table><tr><td>时间</td><td>地点</td></tr></table>'
                '<a href="/_upload/article/files/form.docx">报名表</a><a href="/_upload/article/files/form.docx">重复</a>'
                '<a href="https://elsewhere.zju.edu.cn/form.pdf">说明</a><a href="/form.docx?token=PRIVATE">隐藏链接</a></div>')
        detail = qsxy_html.parse_article(html, QSXY)
        self.assertEqual(detail["title"], "求是正文")
        self.assertEqual(detail["publisher"], "某编辑")
        self.assertEqual(detail["publishedAt"], "2026-10-13")
        self.assertIn("第一段\n\n第二段", detail["content"])
        self.assertIn("时间\t地点", detail["content"])
        self.assertNotIn("tracking()", detail["content"])
        self.assertEqual(len(detail["attachments"]), 2)
        self.assertEqual(detail["qualityFlags"], ["attachment_link_redacted"])
        self.assertNotIn("PRIVATE", repr(detail))

    def test_undergraduate_scoped_h2_h3_and_preferred_author(self):
        for heading in ("h2", "h3"):
            detail = bksy_html.parse_article(undergrad_article('<p>有效正文</p>', heading=heading, publisher="作者姓名"), BKSY)
            self.assertEqual(detail["title"], "本科正文标题")
            self.assertEqual(detail["publisher"], "作者姓名")
            self.assertEqual(detail["publishedAt"], "2026-10-13")
            self.assertEqual(detail["content"], "有效正文")
        self.assertEqual(bksy_html.parse_article(undergrad_article('<p>正文</p>'), BKSY)["publisher"], "编辑姓名")

    def test_four_docx_attachments_and_table_layout(self):
        body = '<table><tr><td>第一列</td><td>第二列</td></tr></table>' + ''.join(f'<p><a href="/_upload/article/files/file{i}.docx">附件{i}</a></p>' for i in range(4))
        detail = bksy_html.parse_article(undergrad_article(body), BKSY)
        self.assertEqual(len(detail["attachments"]), 4)
        self.assertEqual(detail["attachments"][3]["name"], "附件3")
        self.assertIn("第一列\t第二列", detail["content"])

    def test_image_only_is_flagged_without_inventing_body_text(self):
        detail = bksy_html.parse_article(undergrad_article('<p><img src="/_upload/image/poster.png"></p>'), BKSY)
        self.assertEqual(detail["content"], "")
        self.assertEqual(detail["images"], ["https://bksy.zju.edu.cn/_upload/image/poster.png"])
        self.assertEqual(detail["qualityFlags"], ["image_only"])
        detail = bksy_html.parse_article(undergrad_article('<a href="/form.docx"></a>'), BKSY)
        self.assertEqual(detail["content"], "")
        self.assertEqual(detail["qualityFlags"], ["attachment_only"])

    def test_unknown_empty_and_ambiguous_article_templates_fail(self):
        for html in ('<h2>孤立标题</h2><div class="wp_articlecontent">正文</div>', undergrad_article(''), undergrad_article('<script>noise</script>')):
            with self.assertRaises(ValueError):
                bksy_html.parse_article(html, BKSY)
        with self.assertRaises(ValueError):
            qsxy_html.parse_article('<h1 class="arti_title">标题</h1><div class="wp_articlecontent">一</div><div class="wp_articlecontent">二</div>', QSXY)


if __name__ == "__main__":
    unittest.main()
