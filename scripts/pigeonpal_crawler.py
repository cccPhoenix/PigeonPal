"""Local file-backed notice crawler. No third-party packages are required."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import sys
import tempfile

from crawlers.engine import CrawlEngine
from crawlers.sources import SOURCES
from crawlers.storage import NoticeStore, StorageError


def default_data_dir() -> Path:
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
        return base / "PigeonPal" / "data"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "PigeonPal" / "data"
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "pigeonpal" / "data"


@contextmanager
def single_writer(path: Path):
    """OS-held lock is released on exit/crash; the file is portable, not a PID."""
    path.parent.mkdir(parents=True, exist_ok=True)
    lock = path.open("a+b")
    locked = False
    try:
        lock.seek(0, os.SEEK_END)
        if lock.tell() == 0:
            lock.write(b"0")
            lock.flush()
        lock.seek(0)
        try:
            if sys.platform == "win32":
                import msvcrt
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            locked = True
        except OSError:
            raise StorageError("crawler_already_running") from None
        yield
    finally:
        if locked:
            lock.seek(0)
            if sys.platform == "win32":
                import msvcrt
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
        lock.close()


def export_json(path: Path, rows: list[dict]):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=path.name + ".", suffix=".tmp", delete=False) as stream:
            temporary = Path(stream.name)
            json.dump({"schemaVersion": 1, "items": rows}, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--data-dir", type=Path, default=default_data_dir(),
                        help="portable data directory (place before the command)")
    commands = result.add_subparsers(dest="command", required=True)
    run = commands.add_parser("run", help="run the crawler, checking each site every five minutes")
    run.add_argument("--once", action="store_true", help="one due round only; backoff is still respected")
    run.add_argument("--source", choices=["all", *SOURCES], default="all")
    run.add_argument("--detail-limit", type=int, choices=range(4), default=3)
    commands.add_parser("status", help="show source and queue status, without article content")
    export = commands.add_parser("export", help="export locally stored notices to a JSON file")
    export.add_argument("--source", choices=["all", *SOURCES], default="all")
    export.add_argument("--output", type=Path, required=True)
    return result


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    directory = args.data_dir.expanduser().resolve()
    state_file = directory / "crawler-state.json"
    store = None
    engine = None
    try:
        if args.command == "run":
            with single_writer(directory / "crawler.lock"):
                # Load after acquiring the lock, not from a stale pre-lock copy.
                store = NoticeStore(state_file)
                sources = list(SOURCES) if args.source == "all" else [args.source]
                engine = CrawlEngine(store, sources, args.detail_limit,
                                     report=lambda text: print(text, flush=True))
                if args.once:
                    results = engine.run_once()
                    return 1 if any(row["state"] in {"backoff", "partial"} for row in results) else 0
                engine.run_forever()
        elif args.command == "status":
            store = NoticeStore(state_file)
            print(json.dumps(store.status(), ensure_ascii=False, indent=2))
        else:
            store = NoticeStore(state_file)
            output = args.output.expanduser().resolve()
            # An export must never overwrite crawler state, backup or lock.
            if output in {state_file, state_file.with_suffix(state_file.suffix + ".bak"), directory / "crawler.lock"}:
                raise StorageError("reserved_export_path")
            rows = store.export_items(None if args.source == "all" else args.source)
            export_json(output, rows)
            print(f"Exported {len(rows)} notices to a local JSON file.")
        return 0
    except KeyboardInterrupt:
        print("Crawler stopped; collected notices and pending queue are saved.", flush=True)
        return 0
    except StorageError as error:
        print(f"Crawler storage: {error}", file=sys.stderr)
        return 2
    except OSError:
        print("Crawler filesystem error; check data directory permissions.", file=sys.stderr)
        return 2
    except Exception:
        # Credential-bearing values from future providers must not enter a
        # traceback. Unexpected failures stop the process rather than loop.
        print("Crawler stopped: unexpected_error.", file=sys.stderr)
        return 2
    finally:
        if engine is not None:
            try:
                engine.close()
            except Exception:
                print("Crawler cleanup: cleanup_error.", file=sys.stderr)
        if store is not None:
            store.close()


if __name__ == "__main__":
    raise SystemExit(main())
