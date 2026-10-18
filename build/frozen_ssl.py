"""PyInstaller runtime hook: keep TLS trust independent of build-machine Python."""
import os
from pathlib import Path
import sys
bundle=Path(sys._MEIPASS)/'certificates'/'cacert.pem'
# Respect an explicit existing custom trust file, otherwise use shipped Mozilla roots.
if not Path(os.environ.get('SSL_CERT_FILE','')).is_file():
    os.environ['SSL_CERT_FILE']=str(bundle)
