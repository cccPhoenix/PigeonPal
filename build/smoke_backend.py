"""Run the frozen service with disposable data, verify HTTP + shutdown + lock release."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from urllib.request import build_opener, ProxyHandler, Request

if __name__=='__main__':
    exe=Path(sys.argv[1]).resolve()
    diagnostic=subprocess.run([str(exe),'--diagnostics'],env={**os.environ,'SSL_CERT_FILE':'/nonexistent/pigeonpal-certificate','SSL_CERT_DIR':'/nonexistent/pigeonpal-certificates'},capture_output=True,text=True,check=True,timeout=10)
    tls=json.loads(diagnostic.stdout)
    assert tls['usingBundledCA'] and tls['caCount']>100 and tls['tlsVerification'] and tls['tlsHostname'], tls
    with tempfile.TemporaryDirectory() as tmp:
        for _ in range(2):
            child=subprocess.Popen([str(exe),'--offline','--data-dir',tmp+'/data','--auth-dir',tmp+'/auth'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            try:
                ready=json.loads(child.stdout.readline())
                url=ready['url'];opener=build_opener(ProxyHandler({}))
                with opener.open(url+'/api/bootstrap',timeout=10) as response: token=json.load(response)['csrfToken']
                with opener.open(url+'/index.html',timeout=10) as response: assert b'PigeonPal' in response.read()
                request=Request(url+'/api/reminders',headers={'X-PigeonPal-Token':token})
                with opener.open(request,timeout=10) as response: assert json.load(response)['reminders']==[]
                child.stdin.close();assert child.wait(timeout=20)==0
            finally:
                if child.poll() is None:child.kill();child.wait()
                child.stdout.close();child.stderr.close()
    print('Frozen backend: UI/API/EOF shutdown/restart locks passed (offline disposable data).')
