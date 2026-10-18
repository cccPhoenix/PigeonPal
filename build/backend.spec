# Native PyInstaller build: bundle this project's backend and static UI, no user data.
from pathlib import Path
import certifi
root=Path(SPECPATH).parent
analysis=Analysis([str(root/'scripts/desktop_service.py')],pathex=[str(root/'scripts')],
                 binaries=[],datas=[(str(root/'web'),'web'),(certifi.where(),'certificates')],hiddenimports=[],hookspath=[],hooksconfig={},runtime_hooks=[str(root/'build/frozen_ssl.py')],excludes=['tkinter','unittest'],noarchive=False)
pyz=PYZ(analysis.pure)
exe=EXE(pyz,analysis.scripts,[],exclude_binaries=True,name='PigeonPalService',debug=False,bootloader_ignore_signals=False,strip=False,upx=False,console=True)
collection=COLLECT(exe,analysis.binaries,analysis.datas,strip=False,upx=False,name='PigeonPalService')
