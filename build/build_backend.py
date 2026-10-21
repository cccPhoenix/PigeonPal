"""Build a backend for the current OS; run on Windows for Windows installers."""
from pathlib import Path
import subprocess
import sys
ROOT=Path(__file__).resolve().parents[1]
if __name__=='__main__':
    subprocess.run([sys.executable,'-m','PyInstaller','--noconfirm','--clean','--distpath',str(ROOT/'build/backend-dist'),'--workpath',str(ROOT/'build/pyinstaller'),str(ROOT/'build/backend.spec')],check=True,cwd=ROOT)
