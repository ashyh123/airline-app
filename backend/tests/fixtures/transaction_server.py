"""Run the production HTTP server with controlled SQLite commit faults for tests."""

import os
from pathlib import Path
import sqlite3
import sys
import time


sys.path.insert(0, str(Path.cwd()))
from app import server


control_dir = Path(os.environ["DISPATCH_DB"]).parent
original_connect = sqlite3.connect


class ControlledConnection(sqlite3.Connection):
    def __exit__(self, exc_type, exc_value, traceback):
        control = control_dir / "commit-control"
        if exc_type is not None or not self.in_transaction or not control.exists():
            return super().__exit__(exc_type, exc_value, traceback)
        mode = control.read_text(encoding="utf-8")
        control.unlink()
        (control_dir / "commit-entered").touch()
        if mode == "fail":
            # The deferred constraint fails at the real SQLite commit, which must roll back.
            self.execute("CREATE TEMP TABLE commit_parent (id INTEGER PRIMARY KEY)")
            self.execute("""CREATE TEMP TABLE commit_child (
                parent_id INTEGER REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED
            )""")
            self.execute("INSERT INTO commit_child VALUES (1)")
            try:
                return super().__exit__(exc_type, exc_value, traceback)
            finally:
                (control_dir / "commit-finished").touch()
        if mode != "delay":
            raise RuntimeError("Unknown commit fault")
        deadline = time.monotonic() + 4
        while not (control_dir / "commit-release").exists():
            if time.monotonic() >= deadline:
                self.rollback()
                raise sqlite3.OperationalError("commit barrier timed out")
            time.sleep(0.005)
        result = super().__exit__(exc_type, exc_value, traceback)
        (control_dir / "commit-finished").touch()
        return result


def controlled_connect(*args, **kwargs):
    kwargs["factory"] = ControlledConnection
    return original_connect(*args, **kwargs)


sqlite3.connect = controlled_connect
server.main()
