"""Transport error mapping for the DeepSeek REST adapter."""

from http.client import IncompleteRead
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from urllib.request import Request

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from notice_ai.client import send_json
from notice_ai.schema import AIError


class TruncatedResponse:
    def read(self, limit):
        raise IncompleteRead(b"private-model-body", 10)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class FakeOpener:
    def open(self, request, timeout=None):
        return TruncatedResponse()


class AIClientTransportTests(unittest.TestCase):
    def test_truncated_response_is_a_retryable_network_failure(self):
        with patch("notice_ai.client.build_opener", return_value=FakeOpener()):
            with self.assertRaises(AIError) as raised:
                send_json(Request("https://api.example.invalid/chat/completions"), 5)
        self.assertEqual(raised.exception.code, "ai_network_error")
        self.assertTrue(raised.exception.retryable)
        self.assertNotIn("private-model-body", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
