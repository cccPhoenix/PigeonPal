"""Bounded cold-start check on empty data, with a stack-only diagnostic on timeout."""
import json
import queue
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

if __name__ == '__main__':
    with tempfile.TemporaryDirectory(prefix='pigeonpal-source-check-') as directory:
        folder = Path(directory)
        # faulthandler prints code locations only; the child uses fresh synthetic
        # directories and cannot read a developer or runner's saved credentials.
        source = """import faulthandler, runpy, sys
faulthandler.dump_traceback_later(12)
sys.path.insert(0, sys.argv.pop(1))
runpy.run_path(sys.argv.pop(1), run_name='__main__')
"""
        with (folder / 'diagnostic.txt').open('w+') as diagnostic:
            child = subprocess.Popen([sys.executable, '-c', source, str(ROOT / 'scripts'),
                str(ROOT / 'scripts' / 'desktop_service.py'), '--offline',
                '--data-dir', str(folder / 'data'), '--auth-dir', str(folder / 'auth')],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=diagnostic, text=True)
            try:
                ready = queue.Queue()
                threading.Thread(target=lambda: ready.put(child.stdout.readline()), daemon=True).start()
                value = json.loads(ready.get(timeout=20))
                assert value['type'] == 'ready' and value['url'].startswith('http://127.0.0.1:')
                child.stdin.close()
                assert child.wait(timeout=20) == 0
            except Exception:
                child.kill(); child.wait(timeout=10)
                diagnostic.seek(0)
                print(diagnostic.read(), file=sys.stderr)
                raise
            finally:
                if child.poll() is None:
                    child.kill(); child.wait(timeout=10)
                child.stdout.close()
    print('Source backend: cold start, ready handshake and parent-pipe shutdown passed.')
