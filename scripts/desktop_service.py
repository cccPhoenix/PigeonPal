"""Desktop-owned loopback service. Parent pipe EOF shuts down the child."""
import argparse
from contextlib import ExitStack, redirect_stdout
import json
from pathlib import Path
import sys
import threading

from local_service import LocalBackend, LocalServer, credential_directory, handler_for
from pigeonpal_crawler import single_writer


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir',type=Path)
    parser.add_argument('--auth-dir',type=Path)
    parser.add_argument('--offline',action='store_true',help='Serve saved local data without starting network workers')
    parser.add_argument('--diagnostics',action='store_true',help='Print TLS capability flags without credentials or data')
    args=parser.parse_args()
    if args.diagnostics:
        import ssl
        context=ssl.create_default_context()
        bundle=Path(getattr(sys,'_MEIPASS',''))/'certificates'/'cacert.pem'
        print(json.dumps({'tlsVerification':context.verify_mode==ssl.CERT_REQUIRED,'tlsHostname':context.check_hostname,
            'caCount':context.cert_store_stats()['x509_ca'],'usingBundledCA':bundle.is_file() and ssl.get_default_verify_paths().cafile==str(bundle)}))
        return 0
    if args.data_dir is None or args.auth_dir is None:
        parser.error('--data-dir and --auth-dir are required')
    # Reserve stdout for machine-readable startup; operational logs go to stderr.
    handshake=sys.stdout
    try:
        with redirect_stdout(sys.stderr), ExitStack() as stack:
            data=args.data_dir.expanduser().resolve()
            auth=credential_directory(args.auth_dir)
            server=LocalServer(('127.0.0.1',0),handler_for(None))
            stack.callback(server.server_close)
            stack.enter_context(single_writer(data/'crawler.lock'))
            stack.enter_context(single_writer(auth/'auth.lock'))
            backend=LocalBackend(data,auth,start_worker=not args.offline)
            if args.offline:
                backend.start_reminders()
            stack.callback(backend.close)
            server.RequestHandlerClass=handler_for(backend)
            def watch_parent():
                # The OS closes this inherited private pipe even if Electron is killed.
                sys.stdin.buffer.read(1)
                server.shutdown()
            threading.Thread(target=watch_parent,name='desktop-parent',daemon=True).start()
            handshake.write(json.dumps({'type':'ready','url':f'http://127.0.0.1:{server.server_port}'})+'\n')
            handshake.flush()
            server.serve_forever(poll_interval=0.2)
        return 0
    except Exception:
        print('desktop: local_start_failed',file=sys.stderr,flush=True)
        return 2

if __name__=='__main__':
    raise SystemExit(main())
