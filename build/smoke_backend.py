"""Frozen service acceptance on empty disposable data; never contact school or model."""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import time
from urllib.request import build_opener, ProxyHandler, Request

ROOT = Path(__file__).resolve().parents[1]

if __name__ == '__main__':
    exe = Path(sys.argv[1]).resolve()
    diagnostic = subprocess.run([str(exe), '--diagnostics'], env={**os.environ,
        'SSL_CERT_FILE': '/nonexistent/pigeonpal-certificate',
        'SSL_CERT_DIR': '/nonexistent/pigeonpal-certificates'}, capture_output=True, text=True, check=True, timeout=15)
    tls = json.loads(diagnostic.stdout)
    assert tls['usingBundledCA'] and tls['caCount'] > 100 and tls['tlsVerification'] and tls['tlsHostname'], tls
    with tempfile.TemporaryDirectory() as tmp:
        reminder_id = None
        for run in range(2):
            child = subprocess.Popen([str(exe), '--offline', '--data-dir', tmp+'/data', '--auth-dir', tmp+'/auth'],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
            try:
                handshake = queue.Queue()
                threading.Thread(target=lambda: handshake.put(child.stdout.readline()), daemon=True).start()
                url = json.loads(handshake.get(timeout=20))['url']
                opener = build_opener(ProxyHandler({}))
                with opener.open(url+'/api/bootstrap', timeout=10) as response:
                    token = json.load(response)['csrfToken']
                def api(path, body=None):
                    request = Request(url+path, data=json.dumps(body).encode() if body is not None else None,
                        headers={'X-PigeonPal-Token': token, 'Origin': url, 'Content-Type': 'application/json'})
                    with opener.open(request, timeout=10) as response:
                        return json.load(response)
                assert api('/api/auth/status')['bound'] is False
                assert api('/api/ai/settings')['configured'] is (run == 1)
                profile = api('/api/user-profile')
                if run == 0:
                    assert profile['version'] == 0 and api('/api/reminders')['reminders'] == []
                    api('/api/ai/settings', {'apiKey': 'sk-offline-build-acceptance-only', 'automatic': False})
                    # Exercise frozen cryptography save/decrypt without any model request.
                    assert api('/api/ai/settings')['configured'] is True
                    api('/api/user-profile', {'expectedVersion': 0, 'facts': {'degree': {'value': 'undergraduate', 'confirmed': True}}})
                    reminder_id = api('/api/reminders/create', {'title': '冻结后端验收', 'dueAt': int(time.time()*1000+60000), 'channelId': 'bot'})['reminder']['id']
                else:
                    assert profile['facts']['degree']['value'] == 'undergraduate'
                    assert api('/api/reminders')['reminders'][0]['id'] == reminder_id
                    api('/api/reminders/update', {'id': reminder_id, 'patch': {'dueAt': int(time.time()*1000+600)}})
                    deadline = time.monotonic()+6
                    while not any(row['reminderId'] == reminder_id for row in api('/api/events?after=0')['events']):
                        assert time.monotonic() < deadline, 'Offline reminder did not fire'
                        time.sleep(.1)
                assets = [path for path in (ROOT/'web').rglob('*') if path.is_file() and path.suffix in {'.js', '.css', '.html', '.png', '.svg', '.webp'}]
                def check_asset(path):
                    http = build_opener(ProxyHandler({}))
                    relative = path.relative_to(ROOT/'web').as_posix()
                    with http.open(url+'/'+relative, timeout=10) as response:
                        assert response.read() == path.read_bytes(), f'Bundled asset mismatch: {relative}'
                with ThreadPoolExecutor(max_workers=24) as pool:
                    list(pool.map(check_asset, assets))
                child.stdin.close()
                assert child.wait(timeout=20) == 0
            finally:
                if child.poll() is None:
                    child.kill(); child.wait()
                child.stdout.close()
    print(f'Frozen backend: bundled TLS; {len(assets)} current assets; empty account/settings; encrypted API settings/profile/reminder persistence; offline delivery; shutdown/restart passed.')
