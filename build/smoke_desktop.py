"""Launch the real packaged app with empty, isolated data and a bounded acceptance run."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

if __name__ == '__main__':
    exe = Path(sys.argv[1]).resolve()
    # Electron's Node compatibility env must never turn this into a Node-only run.
    env = {key: value for key, value in os.environ.items() if key != 'ELECTRON_RUN_AS_NODE'}
    child = subprocess.Popen([str(exe), '--self-check'], env=env,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    report_path = Path(tempfile.gettempdir()) / f'pigeonpal-self-check-{child.pid}.json'
    try:
        code = child.wait(timeout=75)
        report = json.loads(report_path.read_text())
        report.pop('temporaryDataDir', None)
        print(json.dumps(report, ensure_ascii=False))
        if len(sys.argv) > 2:
            Path(sys.argv[2]).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        assert code == 0 and report['ok'], 'Packaged application self-check failed'
        assert {'calendar-form-save', 'reload-persistence', 'view-navigation', 'offline-reminder-while-window-hidden'} <= set(report['checks'])
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=10)
        # Only the generated self-check directory is disposable, never user app data.
        for directory in Path(tempfile.gettempdir()).glob(f'pigeonpal-self-check-{child.pid}-*'):
            if directory.is_dir() and not directory.is_symlink():
                shutil.rmtree(directory, ignore_errors=True)
        report_path.unlink(missing_ok=True)
