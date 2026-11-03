"""HTTP success must describe a committed transaction, including logout revocation."""

from concurrent.futures import ThreadPoolExecutor, TimeoutError
from pathlib import Path
import sys
import time

import test_dispatch_http as harness


def tearDownModule() -> None:
    harness.tearDownModule()


class TransactionHTTPTests(harness.HTTPScenario):
    def server_command(self) -> list[str]:
        return [sys.executable, str(Path(__file__).parent / "fixtures" / "transaction_server.py")]

    def marker(self, name: str) -> Path:
        return Path(self.tmp.name) / name

    def await_marker(self, name: str) -> None:
        deadline = time.monotonic() + 3
        while not self.marker(name).exists():
            if time.monotonic() >= deadline:
                self.fail(f"Controlled transaction did not reach {name}")
            time.sleep(0.005)

    def test_logout_success_is_not_sent_until_revocation_commits(self) -> None:
        self.marker("commit-control").write_text("delay", encoding="utf-8")
        success_before_commit = False
        with ThreadPoolExecutor(max_workers=1) as pool:
            logout = pool.submit(self.request, "POST", "/auth/logout", {}, auth=self.driver)
            try:
                self.await_marker("commit-entered")
                try:
                    logout.result(timeout=0.25)
                    success_before_commit = True
                except TimeoutError:
                    pass
                # While the writer is held, another HTTP request still sees the old session.
                self.request("GET", "/driver/tasks", auth=self.driver)
            finally:
                self.marker("commit-release").touch()
            logout.result(timeout=3)
        self.await_marker("commit-finished")
        self.request("GET", "/driver/tasks", auth=self.driver, status=401)
        self.assertFalse(success_before_commit, "Logout success reached the client before session revocation committed")
        harness.EVIDENCE["logout_commit_visibility"] = {
            "commit_was_held": True, "success_blocked_until_commit": True,
            "session_rejected_after_success": True,
        }

    def test_commit_failure_returns_error_without_persisting_the_write(self) -> None:
        original = next(f for f in self.overview()["flights"] if f["id"] == "f1")
        self.marker("commit-control").write_text("fail", encoding="utf-8")
        response_checked = False
        with self.subTest(check="failure_response"):
            self.post("/flights/f1", {"gate": "B99"}, status=500)
            response_checked = True
        self.await_marker("commit-finished")
        current = next(f for f in self.overview()["flights"] if f["id"] == "f1")
        self.assertEqual(current["gate"], original["gate"])
        self.assertEqual(current["fuel_needed"], original["fuel_needed"])
        if response_checked:
            harness.EVIDENCE["commit_failure_response"] = {
                "commit_failed": True, "response_status": 500, "flight_unchanged": True,
            }
