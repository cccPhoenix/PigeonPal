"""Offline protocol parity; the reference module is never loaded or executed."""

import json
from pathlib import Path
import shutil
import subprocess
import sys
import unittest
from urllib.parse import parse_qsl

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from local_auth.cas_protocol import build_submission, encrypt_password


PUBLIC = {"modulus": "e" + "f" * 255, "exponent": "10001"}
PUBLIC_TEXT = json.dumps(PUBLIC)


class CasProtocolTests(unittest.TestCase):
    def test_raw_rsa_known_value_and_utf8(self):
        self.assertEqual(encrypt_password("A", "ca1", "11"), "ae6")
        self.assertEqual(encrypt_password("校园密钥🔑", "ca1", "11"), "1e2")

    def test_exact_order_escaping_and_no_plaintext_password(self):
        body = build_submission("user +~*学", "fixture-password🔑", "e1s1&=+~* /", PUBLIC_TEXT)
        self.assertTrue(body.startswith(b"username=user+%2B%7E*%E5%AD%A6&password="))
        self.assertTrue(body.endswith(b"&authcode=&execution=e1s1%26%3D%2B%7E*+%2F&_eventId=submit"))
        self.assertEqual([name for name, value in parse_qsl(body.decode(), keep_blank_values=True)],
                         ["username", "password", "authcode", "execution", "_eventId"])
        self.assertNotIn(b"fixture-password", body)

    def test_invalid_public_keys_are_fixed_errors(self):
        for public in ("not-json", "[]", "null", "{}", "[" * 1100 + "0" + "]" * 1100,
                       "{\"modulus\":\"secret-invalid-key\",\"exponent\":\"3\"}",
                       json.dumps({"modulus": "f" * 2049, "exponent": "3"}),
                       json.dumps({"modulus": "ca1", "exponent": "1"}),
                       json.dumps({"modulus": 123, "exponent": "3"}),
                       json.dumps({"modulus": "ca1", "exponent": "f" * 17})):
            with self.subTest(public_type=type(public).__name__):
                with self.assertRaisesRegex(ValueError, "^invalid_cas_page$"):
                    build_submission("fixture-user", "fixture-password", "fixture-execution", public)

    def test_invalid_fields_are_fixed_errors(self):
        for username, password, execution in (("", "password", "e1"), ("x" * 257, "password", "e1"),
                                               ("user", "", "e1"), ("user", "x" * 1025, "e1"),
                                               ("user", "password", ""), ("user", "password", "x" * 8193),
                                               ("user", "\ud800", "e1")):
            with self.subTest(lengths=(len(username), len(password), len(execution))):
                with self.assertRaisesRegex(ValueError, "^invalid_cas_page$"):
                    build_submission(username, password, execution, PUBLIC_TEXT)

    def test_reference_javascript_parity_with_only_extracted_functions(self):
        node = shutil.which("node")
        reference = Path(__file__).resolve().parents[2] / "vibe-learning-in-zju" / "zju-mcp.mjs"
        if not node or not reference.is_file():
            self.skipTest("Node and the sibling reference source are needed for parity")
        source = reference.read_text(encoding="utf-8")
        rsa_start = source.index("function modpow(")
        rsa_end = source.index("// 提交一次", rsa_start)
        post_start = source.index("async function postCasForm(")
        post_end = source.index("/* -----------------------------------", post_start)
        extracted = source[rsa_start:rsa_end] + source[post_start:post_end]
        fixtures = [
            {"username": "fixture-user", "password": "fixture-password", "execution": "e1s1"},
            {"username": "user +~*学", "password": "校园密钥🔑", "execution": "e1s1&=+~* /"},
            {"username": " user ", "password": "space password", "execution": "token"},
            {"username": "fixture-user", "password": "   ", "execution": "token"},
        ]
        # Only pure functions and postCasForm are extracted. Its request() is
        # replaced with a closed fake; no module initialization, env or fetch.
        runner = r"""
const vm = require('node:vm');
let input = ''; process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', async () => {
  const {source, fixtures, publicKey} = JSON.parse(input);
  const results = [];
  for (const fixture of fixtures) {
    let body;
    const sandbox = {
      Buffer, URL, URLSearchParams,
      ZJUAM: 'https://zjuam.zju.edu.cn',
      ZJU_USER: fixture.username, ZJU_PASS: fixture.password,
      request: async (_jar, url, options = {}) => {
        if (url === 'https://zjuam.zju.edu.cn/cas/v2/getPubKey')
          return {res: {json: async () => publicKey}};
        if (options.method !== 'POST') throw Error('Unexpected fixture request');
        body = options.body;
        return {res: {}, finalUrl: 'https://fixture.invalid/success'};
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox);
    sandbox.fixtureExecution = fixture.execution;
    // A simple fixture element isolates the original form builder from HTML
    // entity parsing, which is separately handled by the production caller.
    await vm.runInContext(`postCasForm({}, '<form id="fm1" action="/cas/login"><input name="execution" value="' + fixtureExecution + '"></form>', 'https://zjuam.zju.edu.cn/cas/login')`, sandbox);
    results.push({body, encrypted: sandbox.encryptPassword(fixture.password, publicKey.modulus, publicKey.exponent)});
  }
  process.stdout.write(JSON.stringify(results));
});
"""
        process = subprocess.run([node, "-e", runner], input=json.dumps({"source": extracted, "fixtures": fixtures, "publicKey": PUBLIC}),
                                 text=True, encoding="utf-8", capture_output=True, timeout=15, check=True)
        for fixture, expected in zip(fixtures, json.loads(process.stdout), strict=True):
            self.assertEqual(build_submission(fixture["username"], fixture["password"], fixture["execution"], PUBLIC_TEXT).decode("ascii"), expected["body"])
            self.assertEqual(encrypt_password(fixture["password"], PUBLIC["modulus"], PUBLIC["exponent"]), expected["encrypted"])


if __name__ == "__main__":
    unittest.main()
