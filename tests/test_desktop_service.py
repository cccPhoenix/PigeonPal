"""Owned-process lifecycle on temporary data, never school traffic."""
from pathlib import Path
import json
import os
import subprocess
import sys
import tempfile
import unittest
from urllib.request import build_opener, ProxyHandler
ROOT=Path(__file__).resolve().parents[1]
class DesktopServiceTests(unittest.TestCase):
    def test_random_port_and_parent_pipe_eof_release_writer_locks(self):
        with tempfile.TemporaryDirectory() as tmp:
            command=[sys.executable,str(ROOT/'scripts/desktop_service.py'),'--data-dir',tmp+'/data','--auth-dir',tmp+'/auth','--offline']
            for _ in range(2):
                child=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
                try:
                    line=child.stdout.readline()
                    handshake=json.loads(line)
                    self.assertEqual(handshake['type'],'ready')
                    self.assertRegex(handshake['url'],r'^http://127\.0\.0\.1:\d+$')
                    with build_opener(ProxyHandler({})).open(handshake['url']+'/api/bootstrap',timeout=3) as response:
                        self.assertIn('csrfToken',json.load(response))
                    child.stdin.close()
                    self.assertEqual(child.wait(timeout=10),0)
                finally:
                    if child.poll() is None: child.kill(); child.wait()
                    child.stdout.close(); child.stderr.close()

    def test_offline_desktop_keeps_local_reminder_delivery_running(self):
        import time
        from urllib.request import Request
        with tempfile.TemporaryDirectory() as tmp:
            child=subprocess.Popen([sys.executable,str(ROOT/'scripts/desktop_service.py'),'--data-dir',tmp+'/data','--auth-dir',tmp+'/auth','--offline'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            try:
                url=json.loads(child.stdout.readline())['url'];http=build_opener(ProxyHandler({}))
                with http.open(url+'/api/bootstrap',timeout=3) as response:token=json.load(response)['csrfToken']
                body=json.dumps({'title':'离线验收提醒','dueAt':int(time.time()*1000+1000),'channelId':'bot'}).encode()
                with http.open(Request(url+'/api/reminders/create',data=body,headers={'Content-Type':'application/json','Origin':url,'X-PigeonPal-Token':token}),timeout=3) as response:json.load(response)
                delivered=False;deadline=time.monotonic()+4
                while time.monotonic()<deadline:
                    with http.open(Request(url+'/api/events?after=0',headers={'X-PigeonPal-Token':token}),timeout=3) as response:delivered=bool(json.load(response)['events'])
                    if delivered:break
                    time.sleep(.1)
                self.assertTrue(delivered)
            finally:
                child.stdin.close()
                if child.poll() is None:
                    try:child.wait(timeout=10)
                    except subprocess.TimeoutExpired:child.kill();child.wait()
                child.stdout.close();child.stderr.close()

    def test_privacy_safe_tls_diagnostics_need_no_account_or_data_directory(self):
        result=subprocess.run([sys.executable,str(ROOT/'scripts/desktop_service.py'),'--diagnostics'],capture_output=True,text=True,timeout=5)
        self.assertEqual(result.returncode,0)
        diagnostic=json.loads(result.stdout)
        self.assertTrue(diagnostic['tlsVerification'])
        self.assertTrue(diagnostic['tlsHostname'])
        self.assertGreater(diagnostic['caCount'],0)
        self.assertNotIn('username',diagnostic)
