import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from notice_ai.client import ModelClient
from notice_ai.config import AIConfig
from notice_ai.recommendation import RecommendationService, model_profile, validate_recommendation
from notice_ai.schema import AIError


class Profiles:
    def __init__(self):
        self.value = {"version": 1, "facts": {
            "degree": {"value": "undergraduate", "confirmed": True},
            "admissionYear": {"value": 2025, "confirmed": True},
        }, "preferences": {"interests": ["志愿服务"], "avoid": ["篮球"]}}

    def snapshot(self):
        return copy.deepcopy(self.value)

    def model_context(self):
        result = self.snapshot()
        result["facts"] = {key: fact["value"] for key, fact in result["facts"].items() if fact.get("confirmed")}
        return result


def notice(content="报名仅限研究生。"):
    return {"id": "yunfeng:1", "sourceId": "yunfeng", "title": "测试报名通知", "publishedAt": "2026-10-20",
            "state": "complete", "content": content, "attachments": [], "qualityFlags": []}


def raw(field="degree", values=None, evidence="仅限研究生", decision="not_applicable"):
    return {"decision": decision, "priority": 20, "reason": "受众与已确认的学历不符。",
            "eligibility": {"complete": True, "exclusive": True, "hasExceptions": False, "attachmentDependent": False,
                            "conditions": [{"field": field, "allowedValues": values or ["postgraduate"], "evidence": evidence}]}}


def analysis():
    return {"summary": "校园活动开放报名", "category": "activity", "noticeType": "文体活动", "participation": "自愿参加",
            "benefits": "原文未说明具体参与收益", "eventTime": "原文未说明", "deadlineText": "原文未说明",
            "eventAt": None, "eventEnd": None, "deadlineAt": None, "location": None, "audience": ["研究生"], "todos": [], "notes": []}


class RecommendationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "recommendations.json"
        self.profiles = Profiles()
        self.now = 1000
        self.service = RecommendationService(self.profiles, self.path, clock=lambda: self.now)

    def save(self, item=None, value=None):
        return self.service.save_result(item or notice(), "fp1", value or raw(), self.profiles.value["version"])

    def test_confirmed_explicit_degree_mismatch_hides_push_not_source(self):
        item = notice()
        original = copy.deepcopy(item)
        result = self.save(item)
        self.assertEqual((result["decision"], result["allowPush"]), ("not_applicable", False))
        self.assertEqual(result["evidence"], ["仅限研究生"])
        self.assertEqual(item, original)

    def test_confirmed_explicit_admission_year_mismatch(self):
        result = self.save(notice("报名仅限2026级本科生。"), raw("admissionYear", [2026], "仅限2026级本科生"))
        self.assertFalse(result["allowPush"])

    def test_unknown_or_unconfirmed_fact_never_excludes(self):
        for facts in ({}, {"degree": {"value": "undergraduate", "confirmed": False}}):
            with self.subTest(facts=facts):
                self.profiles.value["facts"] = facts
                self.profiles.value["version"] += 1
                self.assertTrue(self.save()["allowPush"])

    def test_each_incomplete_eligibility_flag_retains(self):
        for field, value in (("complete", False), ("exclusive", False), ("hasExceptions", True), ("attachmentDependent", True)):
            with self.subTest(field=field):
                data = raw()
                data["eligibility"][field] = value
                self.service.items = {}
                result = self.save(value=data)
                self.assertEqual((result["decision"], result["allowPush"]), ("uncertain", True))

    def test_exceptions_preference_and_no_exclusive_phrase_retain(self):
        for text, quote in (("原则上仅限研究生，特殊情况可申请。", "仅限研究生"),
                            ("篮球活动面向研究生。", "面向研究生"),
                            ("本次活动不再仅限研究生。", "仅限研究生"),
                            ("本次活动仅限研究生或本科生。", "仅限研究生"),
                            ("本次活动仅限研究生或其他学生。", "仅限研究生")):
            with self.subTest(text=text):
                self.service.items = {}
                self.assertTrue(self.save(notice(text), raw(evidence=quote))["allowPush"])
        preference = raw(decision="not_applicable")
        preference["eligibility"]["conditions"] = []
        self.service.items = {}
        result = self.save(notice("全校篮球活动开放报名。"), preference)
        self.assertTrue(result["allowPush"])
        self.assertEqual(result["priority"], 20)

    def test_fabricated_quote_or_allowed_values_cannot_hide(self):
        for data in (raw(evidence="仅限硕士研究生"), raw(values=["doctor"]), raw("admissionYear", [2026], "仅限研究生")):
            self.service.items = {}
            self.assertTrue(self.save(value=data)["allowPush"])

    def test_different_opportunities_cannot_combine_degree_and_year_exclusions(self):
        data = raw()
        data["eligibility"]["conditions"].append({"field": "admissionYear", "allowedValues": [2025], "evidence": "仅限2025级"})
        result = self.save(notice("甲项目报名仅限研究生。乙项目报名仅限2025级。"), data)
        self.assertTrue(result["allowPush"])

    def test_multiple_opportunities_keep_any_matching_alternative(self):
        data = raw()
        data["eligibility"]["conditions"].append({"field": "degree", "allowedValues": ["undergraduate"], "evidence": "仅限本科生"})
        result = self.save(notice("甲奖学金报名仅限研究生。乙奖学金报名仅限本科生。"), data)
        self.assertTrue(result["allowPush"])

    def test_graduate_subtypes_and_unknown_general_graduate(self):
        self.profiles.value["facts"]["degree"]["value"] = "master"
        self.assertTrue(self.save()["allowPush"])
        self.profiles.value["version"] += 1
        self.profiles.value["facts"]["degree"]["value"] = "postgraduate"
        self.service.items = {}
        self.assertTrue(self.save(notice("报名仅限博士生。"), raw(values=["doctor"], evidence="仅限博士生"))["allowPush"])

    def test_partial_body_flags_or_year_range_retains(self):
        item = notice()
        item["qualityFlags"] = ["content_truncated"]
        self.assertTrue(self.save(item)["allowPush"])
        self.service.items = {}
        item = notice("报名仅限2023级至2026级本科生。")
        self.assertTrue(self.save(item, raw("admissionYear", [2023, 2026], "仅限2023级至2026级本科生"))["allowPush"])

    def test_benign_flags_do_not_block_evidenced_exclusion(self):
        item = notice()
        item["qualityFlags"] = ["has_attachments", "publication_date_missing"]
        self.assertFalse(self.save(item)["allowPush"])

    def test_broken_profile_fails_open_without_call_loop_or_losing_keep(self):
        self.save()
        self.service.override("yunfeng:1", "keep")
        def broken():
            raise AIError("profile_storage_error", 503)
        self.profiles.model_context = broken
        result = self.service.view(notice(), "fp1")
        self.assertEqual((result["state"], result["allowPush"], result["decision"]), ("failed", True, "recommended"))
        self.assertFalse(self.service.needs_assessment(notice(), "fp1"))
        self.assertTrue(self.service.fail(notice(), "fp1", "ai_timeout")["allowPush"])

    def test_profile_change_immediately_invalidates_old_hide_and_reuses_eligibility(self):
        self.assertFalse(self.save()["allowPush"])
        self.profiles.value["version"] += 1
        result = self.service.view(notice(), "fp1")
        self.assertEqual((result["state"], result["allowPush"]), ("pending", True))
        self.assertTrue(self.service.needs_assessment(notice(), "fp1"))
        payload = self.service.assessment_input(notice(), analysis(), "fp1")
        self.assertIn("eligibility", payload)
        self.assertNotIn("notice", payload)
        stale = self.service.save_result(notice(), "fp1", raw(), 1)
        self.assertEqual(stale["state"], "pending")

    def test_new_fingerprint_needs_body_and_never_uses_old_conclusion(self):
        self.save()
        self.assertTrue(self.service.view(notice(), "fp2")["allowPush"])
        payload = self.service.assessment_input(notice(), analysis(), "fp2")
        self.assertIn("notice", payload)
        self.assertNotIn("eligibility", payload)

    def test_failure_and_invalid_raw_clear_previous_hide_and_bound_retries(self):
        self.save()
        self.assertTrue(self.service.fail(notice(), "fp1", "ai_timeout")["allowPush"])
        self.assertFalse(self.service.needs_assessment(notice(), "fp1"))
        self.now += 60
        self.assertTrue(self.service.needs_assessment(notice(), "fp1"))
        self.service.fail(notice(), "fp1", RuntimeError("private detail"))
        self.now += 120
        self.service.fail(notice(), "fp1", "ai_timeout")
        self.now += 10000
        self.assertFalse(self.service.needs_assessment(notice(), "fp1"))
        self.assertNotIn("private detail", self.path.read_text(encoding="utf-8"))
        result = self.service.save_result(notice(), "fp1", {}, 1)
        self.assertEqual((result["state"], result["allowPush"]), ("failed", True))

    def test_restart_override_and_restore(self):
        self.save()
        self.service.override("yunfeng:1", "keep")
        restored = RecommendationService(self.profiles, self.path)
        self.assertEqual(restored.view(notice(), "fp1")["decision"], "recommended")
        self.assertFalse(restored.needs_assessment(notice(), "fp1"))
        restored.override("yunfeng:1", "auto")
        self.assertFalse(restored.view(notice(), "fp1")["allowPush"])

    def test_corrupt_cache_fails_open_without_provider_loop(self):
        self.path.write_text("{broken", encoding="utf-8")
        restored = RecommendationService(self.profiles, self.path)
        result = restored.view(notice(), "fp1")
        self.assertEqual((result["state"], result["allowPush"]), ("failed", True))
        self.assertFalse(restored.needs_assessment(notice(), "fp1"))

    def test_no_profile_keeps_all_and_does_not_request(self):
        self.profiles.value.update(facts={}, preferences={"interests": [], "avoid": []})
        self.assertTrue(self.service.view(notice(), "fp1")["allowPush"])
        self.assertFalse(self.service.needs_assessment(notice(), "fp1"))

    def test_homework_always_local_and_accepted(self):
        item = notice()
        item["sourceId"] = "xzzd"
        self.assertTrue(self.service.save_result(item, "fp1", raw(), 1)["allowPush"])
        self.assertFalse(self.service.needs_assessment(item, "fp1"))
        with self.assertRaises(AIError) as error:
            self.service.assessment_input(item, analysis(), "fp1")
        self.assertEqual(error.exception.code, "local_only_source")
        self.assertFalse(self.path.exists())

    def test_minimum_projection_excludes_account_and_unconfirmed_fields(self):
        self.profiles.value["account"] = "private-account"
        self.profiles.value["facts"]["studentId"] = {"value": "3261234567", "confirmed": True}
        self.profiles.value["facts"]["college"] = {"value": "未确认学院", "confirmed": False}
        payload = self.service.assessment_input(notice(), analysis(), "fp1")
        serialized = json.dumps(payload, ensure_ascii=False)
        self.assertNotIn("private-account", serialized)
        self.assertNotIn("3261234567", serialized)
        self.assertNotIn("未确认学院", serialized)
        self.assertEqual(payload["profile"]["facts"]["admissionYear"], 2025)

    def test_invalid_recommendation_shapes_rejected_without_type_errors(self):
        for key in ("decision", "priority", "eligibility"):
            value = raw()
            value[key] = {}
            with self.assertRaises(AIError):
                validate_recommendation(value)


class PersonalizedClientTests(unittest.TestCase):
    def setUp(self):
        self.requests = []
        self.reply = {"analysis": analysis(), "recommendation": raw()}
        def transport(request, timeout):
            self.requests.append(json.loads(request.data.decode("utf-8")))
            return {"choices": [{"finish_reason": "stop", "message": {"content": json.dumps(self.reply, ensure_ascii=False)}}]}
        self.client = ModelClient(AIConfig(api_key="synthetic-test-key"), transport=transport)

    def test_combined_one_request_profile_projection_and_bad_recommendation_independent(self):
        self.reply["recommendation"] = None
        context = {"version": 2, "facts": {"degree": "undergraduate", "studentId": "private-student"},
                   "preferences": {"interests": ["志愿服务"], "avoid": []}, "password": "private-password"}
        result = self.client.analyze_personalized({"content": "报名公告"}, context)
        self.assertEqual(result["analysis"]["summary"], "校园活动开放报名")
        self.assertEqual(result["recommendation"], {})
        self.assertEqual(len(self.requests), 1)
        user = json.loads(self.requests[0]["messages"][-1]["content"])
        self.assertNotIn("studentId", user["profile"]["facts"])
        self.assertNotIn("private-password", json.dumps(self.requests))

    def test_reassessment_reuses_eligibility_no_article_or_unknown_root_fields(self):
        self.reply = raw(decision="uncertain")
        result = self.client.assess_relevance({"profile": Profiles().model_context(), "analysis": analysis(),
                                                "eligibility": raw()["eligibility"], "account": "private-account"})
        self.assertEqual(result["decision"], "uncertain")
        user = json.loads(self.requests[0]["messages"][-1]["content"])
        self.assertNotIn("notice", user)
        self.assertNotIn("account", user)


if __name__ == "__main__":
    unittest.main()
