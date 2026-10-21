"""Offline JSON storage, homework scheduler and local API integration checks."""

import copy
from http.cookiejar import CookieJar
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from crawlers.auth import AuthSession
from crawlers.engine import CrawlEngine
from crawlers.http import CrawlFailure
from crawlers.storage import NoticeStore
from local_service import LocalBackend


def activity(identifier=10, **extra):
    return {
        "id": identifier, "course_id": 1, "title": f"练习 {identifier}", "type": "homework",
        "end_time": "2026-10-20T15:59:59Z", "submitted": False, "is_closed": False,
        "data": {"description": "<p>完成第一章练习。</p>"}, **extra,
    }


class FakeAuth:
    def __init__(self, authenticated=True):
        self.session = AuthSession(CookieJar()) if authenticated else None
        self.invalidated = []

    def session_for(self, source_id):
        return self.session

    def invalidate(self, source_id):
        self.invalidated.append(source_id)
        self.session = None


class FakeClient:
    """Return small synthetic official API responses without opening a socket."""
    def __init__(self, activities=None, pages=None):
        rows = list(activities or [])
        self.request_count = 0
        self.last_finished = None
        self.paths = []
        self.todos = []
        self.courses = [{"id": 1, "name": "测试课程", "course_code": "TEST1"}]
        self.pages = pages or {1: {"homework_activities": rows, "pages": 1}}
        self.details = {str(row["id"]): copy.deepcopy(row) for response in self.pages.values()
                        for row in response["homework_activities"]}

    def json(self, path):
        self.request_count += 1
        self.paths.append(path)
        parsed = urlsplit(path)
        if parsed.path == "/api/todos":
            return {"todo_list": copy.deepcopy(self.todos)}
        if parsed.path == "/api/my-courses":
            return {"courses": copy.deepcopy(self.courses), "pages": 1}
        if parsed.path == "/api/courses/1/homework-activities":
            page = int(parse_qs(parsed.query)["page"][0])
            return copy.deepcopy(self.pages[page])
        if parsed.path.startswith("/api/activities/"):
            response = self.details[parsed.path.rsplit("/", 1)[-1]]
            if isinstance(response, Exception):
                raise response
            return copy.deepcopy(response)
        raise AssertionError("Unexpected API route")

    @property
    def detail_paths(self):
        return [path for path in self.paths if path.startswith("/api/activities/")]


class HomeworkIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "data" / "crawler-state.json"
        self.store = NoticeStore(self.path)
        self.addCleanup(self.store.close)
        self.now = 1000.0

    def engine(self, client, *, store=None, auth=None, detail_limit=3):
        result = CrawlEngine(store or self.store, ["xzzd"], detail_limit=detail_limit,
                             auth=auth or FakeAuth(), wall_time=lambda: self.now,
                             report=lambda value: None, client_factory=lambda *args, **kwargs: client)
        self.addCleanup(result.close)
        return result

    def restart_store(self):
        result = NoticeStore(self.path)
        self.addCleanup(result.close)
        return result

    def test_homework_metadata_and_real_body_persist_in_existing_json(self):
        client = FakeClient([activity()])
        result = self.engine(client).run_once()[0]
        self.assertEqual(result["state"], "ready")
        self.assertEqual(result["detailsFetched"], 1)
        self.assertEqual(result["requests"], 4)
        row = self.store.get_notice("xzzd:10")
        self.assertEqual(row["content"], "完成第一章练习。")
        self.assertEqual(row["state"], "complete")
        self.assertEqual(row["version"], 1)
        self.assertEqual(row["homework"]["courseId"], "1")
        self.assertEqual(row["homework"]["courseName"], "测试课程")
        self.assertEqual(row["homework"]["deadlineAt"], "2026-10-20T15:59:59Z")
        self.assertEqual(row["url"], "https://courses.zju.edu.cn/course/1/learning-activity#/10")
        self.assertTrue(self.path.is_file())
        self.assertEqual(self.restart_store().get_notice("xzzd:10"), row)
        self.assertEqual(len(list(self.path.parent.glob("crawler-state.json*"))), 2)

    def test_empty_homework_description_is_complete_without_fake_content(self):
        client = FakeClient([activity(data={})])
        result = self.engine(client).run_once()[0]
        self.assertEqual(result["state"], "ready")
        self.assertEqual(result["detailsFailed"], 0)
        row = self.restart_store().get_notice("xzzd:10")
        self.assertEqual(row["content"], "")
        self.assertEqual(row["state"], "complete")
        self.assertIn("homework_description_missing", row["qualityFlags"])
        self.assertNotIn("pending_body", row["qualityFlags"])
        self.assertNotIn("body_failed", row["qualityFlags"])
        self.assertEqual(row["homework"]["submissionStatus"], "not_submitted")

    def test_deadline_and_submission_changes_update_version_with_unchanged_description(self):
        client = FakeClient([activity()])
        engine = self.engine(client)
        engine.run_once()
        before = self.store.get_notice("xzzd:10")
        updated = activity(submitted=True, end_time="2026-10-21T15:59:59Z")
        client.pages[1]["homework_activities"] = [updated]
        client.details["10"] = updated
        self.now += 300
        result = engine.run_once()[0]
        after = self.store.get_notice("xzzd:10")
        self.assertEqual(result["metadataChanged"], 1)
        self.assertEqual(result["bodyChanged"], 1)
        self.assertEqual(after["content"], before["content"])
        self.assertEqual(after["homework"]["submissionStatus"], "submitted")
        self.assertEqual(after["homework"]["deadlineAt"], "2026-10-21T15:59:59Z")
        self.assertEqual(after["version"], before["version"] + 1)
        self.assertNotEqual(after["contentHash"], before["contentHash"])
        self.assertEqual(self.restart_store().get_notice("xzzd:10"), after)

    def test_checkpoint_survives_restart_and_resumes_homework_page(self):
        pages = {page: {"homework_activities": [activity(10 + page)], "pages": 4}
                 for page in range(1, 5)}
        first_client = FakeClient(pages=pages)
        self.engine(first_client, detail_limit=0).run_once()
        checkpoint = self.store.collector_state("xzzd")
        self.assertEqual(checkpoint["homeworkPages"]["1"], 3)
        self.assertEqual(checkpoint["coursePage"], 0)
        restarted = self.restart_store()
        self.assertEqual(restarted.collector_state("xzzd"), checkpoint)
        second_client = FakeClient(pages=pages)
        second_engine = self.engine(second_client, store=restarted, detail_limit=0)
        self.assertEqual(second_engine.run_once()[0]["state"], "not_due")
        self.assertEqual(second_client.paths, [])
        self.now += 300
        result = second_engine.run_once()[0]
        self.assertEqual(result["state"], "ready")
        self.assertEqual(result["listItems"], 4)
        self.assertFalse(any("my-courses" in path for path in second_client.paths))
        homework_paths = [path for path in second_client.paths if "homework-activities" in path]
        self.assertEqual([parse_qs(urlsplit(path).query)["page"] for path in homework_paths], [["3"], ["4"]])
        self.assertEqual({row["id"] for row in restarted.export_items("xzzd")},
                         {"xzzd:11", "xzzd:12", "xzzd:13", "xzzd:14"})

    def test_detail_limit_and_five_minute_cadence(self):
        client = FakeClient([activity(identifier) for identifier in range(10, 15)])
        engine = self.engine(client)
        first = engine.run_once()[0]
        self.assertEqual(first["detailsFetched"], 3)
        self.assertEqual(len(client.detail_paths), 3)
        status = self.store.status()["sources"][0]
        self.assertEqual(status["completeCount"], 3)
        self.assertEqual(status["pendingCount"], 2)
        calls = client.request_count
        self.now += 299
        self.assertEqual(engine.run_once()[0]["state"], "not_due")
        self.assertEqual(client.request_count, calls)
        self.now += 1
        second = engine.run_once()[0]
        self.assertEqual(second["detailsFetched"], 3)
        self.assertEqual(len(client.detail_paths), 6)
        self.assertEqual(self.store.status()["sources"][0]["completeCount"], 5)

    def test_complete_homework_refreshes_after_five_minutes_instead_of_daily(self):
        client = FakeClient([activity()])
        engine = self.engine(client)
        engine.run_once()
        version = self.store.get_notice("xzzd:10")["version"]
        client.details["10"] = activity(submitted=True)
        self.now += 300
        result = engine.run_once()[0]
        self.assertEqual(result["detailsFetched"], 1)
        self.assertEqual(self.store.get_notice("xzzd:10")["homework"]["submissionStatus"], "submitted")
        self.assertEqual(self.store.get_notice("xzzd:10")["version"], version + 1)

    def test_empty_result_is_ready_and_saves_checkpoint(self):
        client = FakeClient()
        client.courses = []
        result = self.engine(client).run_once()[0]
        self.assertEqual(result["state"], "ready")
        self.assertEqual(result["listItems"], 0)
        self.assertEqual(result["detailsFetched"], 0)
        self.assertEqual(self.store.export_items("xzzd"), [])
        self.assertEqual(self.restart_store().collector_state("xzzd")["coursesFetchedAt"], self.now)
        self.assertIsNone(self.store.status()["sources"][0]["lastError"])

    def test_denied_assignment_does_not_stop_other_details_or_invalidate_session(self):
        client = FakeClient([activity(identifier) for identifier in (10, 11, 12)])
        client.details["11"] = CrawlFailure("homework_access_denied", 3600)
        auth = FakeAuth()
        session = auth.session
        engine = self.engine(client, auth=auth)
        result = engine.run_once()[0]
        self.assertEqual(result["state"], "partial")
        self.assertEqual(result["detailsFetched"], 2)
        self.assertEqual(result["detailsFailed"], 1)
        self.assertEqual(client.detail_paths, ["/api/activities/10", "/api/activities/11", "/api/activities/12"])
        self.assertIs(auth.session, session)
        self.assertEqual(auth.invalidated, [])
        self.assertEqual(self.store.get_notice("xzzd:10")["state"], "complete")
        self.assertEqual(self.store.get_notice("xzzd:12")["state"], "complete")
        denied = self.store.get_notice("xzzd:11")
        self.assertEqual(denied["state"], "failed")
        self.assertEqual(denied["lastError"], "homework_access_denied")
        self.assertEqual(denied["failureCount"], 1)
        self.assertNotIn("xzzd:11", [row["id"] for row in self.store.detail_jobs("xzzd", self.now + 300)])

    def test_denied_list_backs_off_without_invalidating_site_session(self):
        class DeniedListClient(FakeClient):
            def json(self, path):
                self.request_count += 1
                self.paths.append(path)
                raise CrawlFailure("access_denied", 3600)

        client = DeniedListClient()
        auth = FakeAuth()
        session = auth.session
        engine = self.engine(client, auth=auth)
        result = engine.run_once()[0]
        self.assertEqual(result["state"], "backoff")
        self.assertEqual(result["requests"], 1)
        self.assertEqual(result["detailsFetched"], 0)
        self.assertIs(auth.session, session)
        self.assertEqual(auth.invalidated, [])
        self.assertEqual(self.store.status()["sources"][0]["lastError"], "access_denied")
        self.assertGreaterEqual(engine.runtimes["xzzd"].next_due, self.now + 3600)

    def test_true_authentication_failure_stops_details_and_invalidates_session(self):
        client = FakeClient([activity(identifier) for identifier in (10, 11, 12)])
        client.details["11"] = CrawlFailure("auth_required")
        auth = FakeAuth()
        result = self.engine(client, auth=auth).run_once()[0]
        self.assertEqual(result["state"], "auth_required")
        self.assertEqual(result["detailsFetched"], 1)
        self.assertEqual(client.detail_paths, ["/api/activities/10", "/api/activities/11"])
        self.assertIsNone(auth.session)
        self.assertEqual(auth.invalidated, ["xzzd"])

    def test_without_authentication_performs_no_json_request(self):
        client = FakeClient([activity()])
        result = self.engine(client, auth=FakeAuth(authenticated=False)).run_once()[0]
        self.assertEqual(result["state"], "auth_required")
        self.assertEqual(result["requests"], 0)
        self.assertEqual(client.paths, [])
        self.assertEqual(self.store.export_items("xzzd"), [])

    # Keep the synthetic deadline current regardless of the machine's date.
    @patch("crawlers.homework_selection.time.time", return_value=1000.0)
    def test_local_api_exposes_homework_and_revision_without_model_processing(self, _clock):
        root = Path(self.temp.name)
        backend = LocalBackend(root / "api-data", root / "empty-test-auth", start_worker=False)
        self.addCleanup(backend.close)
        engine = self.engine(FakeClient([activity()]), store=backend.store)
        engine.run_once()
        listing = backend.notices("xzzd")["items"][0]
        detail = backend.notice_detail("xzzd:10")
        self.assertEqual(listing["homework"], detail["homework"])
        self.assertEqual(detail["content"], "完成第一章练习。")
        self.assertEqual(listing["analysis"]["state"], "local_only")
        self.assertEqual(detail["analysis"]["state"], "local_only")
        self.assertFalse(backend.ai_settings.config.configured)
        homework = {**detail["homework"], "submissionStatus": "submitted"}
        self.now += 300
        backend.store.save_detail("xzzd", "xzzd:10", {**detail, "homework": homework}, detail["url"], self.now)
        self.assertEqual(backend.notices("xzzd")["items"], [])
        after = backend.notice_detail("xzzd:10")
        self.assertEqual(after["homework"]["submissionStatus"], "submitted")
        self.assertGreater(after["version"], listing["version"])
        self.assertIsNone(after["analysis"]["result"])


if __name__ == "__main__":
    unittest.main()
