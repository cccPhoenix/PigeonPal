"""Build a backend for the current OS; run on Windows for Windows installers."""
from pathlib import Path
import struct
import subprocess
import sys
ROOT=Path(__file__).resolve().parents[1]
if __name__=='__main__':
    image=(ROOT/'images/icon_256.png').read_bytes()
    # ICO supports PNG-encoded 256px entries; preserve the existing app icon.
    (ROOT/'build/icon.ico').write_bytes(struct.pack('<HHH',0,1,1)+struct.pack('<BBBBHHII',0,0,0,0,1,32,len(image),22)+image)
    subprocess.run([sys.executable,'-m','PyInstaller','--noconfirm','--clean','--distpath',str(ROOT/'build/backend-dist'),'--workpath',str(ROOT/'build/pyinstaller'),str(ROOT/'build/backend.spec')],check=True,cwd=ROOT)
