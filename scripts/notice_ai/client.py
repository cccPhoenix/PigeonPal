"""DeepSeek REST adapter. No school cookies or redirect-following opener."""

from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from http.client import HTTPException
import json
import socket
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .schema import AIError, RESULT_SCHEMA, SYSTEM_PROMPT, decode_json, validate_result
from .recommendation import RECOMMENDATION_SCHEMA, RELEVANCE_PROMPT, model_profile


def _json_object(content):
    try:
        if not isinstance(content, str) or len(content) > 100_000:
            raise ValueError
        def unique_pairs(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError
                result[key] = value
            return result
        def reject_constant(value):
            raise ValueError
        value = json.loads(content, object_pairs_hook=unique_pairs, parse_constant=reject_constant)
        if not isinstance(value, dict):
            raise ValueError
        return value
    except (TypeError, ValueError):
        raise AIError("ai_result_invalid") from None


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


def send_json(request, timeout):
    try:
        with build_opener(NoRedirect()).open(request, timeout=timeout) as response:
            data = response.read(1_048_577)
            if len(data) > 1_048_576:
                raise AIError("ai_response_too_large")
            return json.loads(data.decode("utf-8"))
    except HTTPError as error:
        status, wait = error.code, 0
        try:
            value = error.headers.get("Retry-After", "0")
            try:
                wait = int(value)
            except ValueError:
                wait = int((parsedate_to_datetime(value) - datetime.now(timezone.utc)).total_seconds())
        except (AttributeError, TypeError, ValueError, OverflowError):
            pass
        finally:
            error.close()
        if status in {401, 403}:
            raise AIError("ai_auth_failed", 503) from None
        if status == 429:
            raise AIError("ai_rate_limited", 503, True, max(60, min(wait, 86400))) from None
        if 500 <= status < 600:
            raise AIError("ai_upstream_unavailable", 503, True) from None
        raise AIError("ai_request_rejected") from None
    except (TimeoutError, socket.timeout):
        raise AIError("ai_timeout", 504, True) from None
    except (HTTPException, URLError, OSError):
        # Truncated upstream bodies raise IncompleteRead (HTTPException), not URLError.
        raise AIError("ai_network_error", 503, True) from None
    except (UnicodeError, ValueError):
        raise AIError("ai_response_invalid") from None


class ModelClient:
    def __init__(self, config, transport=send_json):
        self.config, self.transport = config, transport

    def analyze(self, notice_input):
        message = self.complete([
            {"role": "system", "content": SYSTEM_PROMPT + "\nJSON schema: " + json.dumps(RESULT_SCHEMA, ensure_ascii=False)},
            {"role": "user", "content": json.dumps(notice_input, ensure_ascii=False)},
        ], json_mode=True)
        return decode_json(message.get("content"))

    def analyze_personalized(self, notice_input, profile_input):
        """One request extracts the article and evaluates its minimum profile.

        An invalid recommendation must not discard an otherwise valid summary;
        RecommendationService validates that independent part after caching it.
        """
        schema = {"type": "object", "required": ["analysis", "recommendation"],
                  "properties": {"analysis": RESULT_SCHEMA, "recommendation": RECOMMENDATION_SCHEMA}}
        prompt = SYSTEM_PROMPT + "\n" + RELEVANCE_PROMPT + "\n输出对象必须包含 analysis 和 recommendation。\nJSON schema: " + json.dumps(schema, ensure_ascii=False)
        message = self.complete([
            {"role": "system", "content": prompt},
            {"role": "user", "content": json.dumps({"notice": notice_input, "profile": model_profile(profile_input)}, ensure_ascii=False)},
        ], json_mode=True)
        value = _json_object(message.get("content"))
        analysis = validate_result(value.get("analysis"))
        raw = value.get("recommendation")
        return {"analysis": analysis, "recommendation": raw if isinstance(raw, dict) else {}}

    def assess_relevance(self, assessment_input):
        value = {key: assessment_input[key] for key in ("analysis", "eligibility", "notice") if key in assessment_input}
        value["profile"] = model_profile(assessment_input.get("profile"))
        message = self.complete([
            {"role": "system", "content": RELEVANCE_PROMPT + "\nJSON schema: " + json.dumps(RECOMMENDATION_SCHEMA, ensure_ascii=False)},
            {"role": "user", "content": json.dumps(value, ensure_ascii=False)},
        ], json_mode=True)
        return _json_object(message.get("content"))

    def complete(self, messages, *, json_mode=False, tools=None):
        config = self.config
        if not config.configured:
            raise AIError(config.error or "ai_not_configured", 503)
        payload = {"model": config.model, "messages": messages, "max_tokens": 4096,
                   "stream": False, "thinking": {"type": "disabled"}}
        if json_mode:
            payload["response_format"] = {"type": "json_object"}
        if tools:
            payload["tools"], payload["tool_choice"] = tools, "auto"
        headers = {"Content-Type": "application/json", "Accept": "application/json",
                   "Authorization": f"Bearer {config.api_key}"}
        request = Request(config.base_url + "/chat/completions", json.dumps(payload, ensure_ascii=False).encode("utf-8"), headers, method="POST")
        response = self.transport(request, config.timeout)
        try:
            choice = response["choices"][0]
            if choice.get("finish_reason") not in {"stop", "tool_calls"}:
                raise AIError("ai_output_incomplete")
            message = choice["message"]
            if message.get("refusal"):
                raise AIError("ai_refused")
            if not isinstance(message.get("content"), (str, type(None))):
                raise AIError("ai_response_invalid")
            return message
        except (AttributeError, KeyError, IndexError, TypeError):
            raise AIError("ai_response_invalid") from None

    def check_connection(self):
        if not self.config.configured:
            raise AIError("ai_not_configured", 503)
        response = self.transport(Request(self.config.base_url + "/models", headers={
            "Authorization": f"Bearer {self.config.api_key}", "Accept": "application/json",
        }), 20)
        try:
            if self.config.model not in {row["id"] for row in response["data"]}:
                raise AIError("ai_model_unavailable", 400)
        except (KeyError, TypeError):
            raise AIError("ai_response_invalid") from None
        return {"ok": True, "model": self.config.model}
