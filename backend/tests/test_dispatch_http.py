"""Behavioral dispatch tests against the real HTTP server and SQLite store."""

from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


BACKEND = Path(__file__).resolve().parents[1]
RUN_DIR = Path(os.environ.get("DISPATCH_TEST_OUTPUT_DIR") or tempfile.mkdtemp(prefix="airline-http-tests-"))
EVIDENCE: dict[str, object] = {}


def tearDownModule() -> None:
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    (RUN_DIR / "result-manifest.json").write_text(
        json.dumps(EVIDENCE, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(f"\nHTTP scenario evidence: {RUN_DIR / 'result-manifest.json'}")


class HTTPScenario(unittest.TestCase):
    def server_command(self) -> list[str]:
        return [sys.executable, "-m", "app.server"]

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="airline-test-db-")
        self.addCleanup(self.tmp.cleanup)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        self.base = f"http://127.0.0.1:{port}/api"
        self.server_log = open(Path(self.tmp.name) / "server.log", "w+")
        self.addCleanup(self.server_log.close)
        self.process = subprocess.Popen(
            self.server_command(), cwd=BACKEND,
            env={**os.environ, "HOST": "127.0.0.1", "PORT": str(port),
                 "DISPATCH_DB": str(Path(self.tmp.name) / "dispatch.db")},
            stdout=self.server_log, stderr=subprocess.STDOUT,
        )
        self.addCleanup(self.stop_server)
        deadline = time.monotonic() + 15
        while True:
            try:
                self.request("GET", "/health", auth=None)
                break
            except (URLError, ConnectionError):
                if self.process.poll() is not None or time.monotonic() >= deadline:
                    self.server_log.seek(0)
                    self.fail(f"Production server did not start: {self.server_log.read()}")
                time.sleep(0.03)
        self.dispatch = self.login("dispatch01", "dispatch123")
        self.admin = self.login("admin01", "admin123")
        self.driver = self.login("driver01", "driver123")

    def stop_server(self) -> None:
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        self.server_log.seek(0)
        log = self.server_log.read()
        if "Traceback" in log:
            RUN_DIR.mkdir(parents=True, exist_ok=True)
            (RUN_DIR / f"{self._testMethodName}.log").write_text(log, encoding="utf-8")

    def request(self, method: str, path: str, payload: dict | None = None,
                auth: str | None = None, status: int = 200) -> dict:
        headers = {"Content-Type": "application/json"}
        if auth:
            headers["Authorization"] = f"Bearer {auth}"
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        request = Request(self.base + path, data=body, headers=headers, method=method)
        try:
            with urlopen(request, timeout=5) as response:
                actual_status, raw = response.status, response.read()
        except HTTPError as error:
            with error:
                actual_status, raw = error.code, error.read()
        result = json.loads(raw)
        self.assertEqual(actual_status, status, f"{method} {path}: unexpected HTTP status")
        return result

    def login(self, username: str, password: str) -> str:
        return self.request("POST", "/auth/login", {"username": username, "password": password})["user"]["token"]

    def get(self, path: str, status: int = 200) -> dict:
        return self.request("GET", path, auth=self.dispatch, status=status)

    def post(self, path: str, payload: dict | None = None, status: int = 200) -> dict:
        return self.request("POST", path, payload or {}, auth=self.dispatch, status=status)

    def overview(self) -> dict:
        return self.get("/overview")

    @staticmethod
    def vehicle(data: dict, identifier: str) -> dict:
        return next(vehicle for vehicle in data["vehicles"] if vehicle["id"] == identifier)

    @staticmethod
    def person(data: dict, identifier: str) -> dict:
        return next(person for person in data["personnel"] if person["id"] == identifier)

    def optimize(self) -> dict:
        return self.post("/dispatch/optimize")["overview"]

    def pending(self, data: dict, flight_id: str = "f1") -> dict:
        return next(task for task in data["tasks"] if task["flight_id"] == flight_id and task["state"] == "PENDING")

    def fill_unbound_truck(self) -> dict:
        # Stock-only fixture for candidate tests; real refuelling has its own HTTP lifecycle test.
        with sqlite3.connect(Path(self.tmp.name) / "dispatch.db") as db:
            db.execute("UPDATE vehicles SET fuel_level=capacity WHERE id='v4'")
        return self.overview()

    def create_driver(self, suffix: str, standby: bool = True, enabled: bool = True) -> str:
        created = self.request("POST", "/admin/personnel", {
            "role": "DRIVER", "empNo": f"T{suffix}", "name": f"测试{suffix}",
            "username": f"test_{suffix}", "password": "TestDriver123",
        }, auth=self.admin)
        identifier = created["personnel"]["id"]
        if standby:
            self.post(f"/dispatch/personnel/{identifier}/status", {"status": "STANDBY"})
        if not enabled:
            self.request("POST", f"/admin/personnel/{identifier}/disable", {}, auth=self.admin)
        return identifier

    def candidates(self, task: dict) -> list[dict]:
        response = self.get(f"/tasks/{task['id']}/candidates")
        self.assertEqual(response["locationMode"], "SCHEMATIC")
        return response["candidates"]

    def override(self, task: dict, candidate: dict, status: int = 200) -> dict:
        return self.post(f"/tasks/{task['id']}/override", {
            "vehicleId": candidate["vehicleId"], "driverId": candidate["driverId"],
            "dispatchOrder": task["dispatch_order"] or 1,
        }, status=status)


class DispatchHTTPTests(HTTPScenario):
    def test_refuel_is_a_two_step_dispatch_not_instant_fuel(self) -> None:
        for flight in ['f1', 'f2', 'f4', 'f5']:
            self.post('/events', {'eventId': 'cancel-'+flight, 'flightId': flight, 'type': 'CANCELLED'})
        vehicle = self.vehicle(self.overview(), 'v1')
        sent = self.post('/vehicles/v1/refuel', {'action': 'start'})['overview']
        self.assertEqual(self.vehicle(sent, 'v1')['status'], 'REFUELLING')
        self.assertEqual(self.vehicle(sent, 'v1')['fuel_level'], vehicle['fuel_level'])
        self.optimize()
        self.assertFalse(any(t['vehicle_id']=='v1' and t['state'] in {'PENDING','IN_PROGRESS'} for t in self.overview()['tasks']))
        response = self.request('POST', '/vehicles/v1/refuel', {'action':'complete'}, auth=self.driver)
        self.assertNotIn('overview', response)
        done = self.overview()
        completed = self.vehicle(done, 'v1')
        self.assertEqual(completed['fuel_level'], completed['capacity'])
        self.assertEqual(completed['status'], 'AVAILABLE')
        self.assertEqual((completed['x'],completed['y']), (done['refuelPoint']['x'],done['refuelPoint']['y']))
        EVIDENCE['refuel_lifecycle'] = {'dispatcher_start':True, 'driver_complete':True, 'fuel_unchanged_until_completion':True}

    def test_refuel_rejects_wrong_role_invalid_state_and_active_work(self) -> None:
        self.request('POST','/vehicles/v1/refuel',{'action':'start'},auth=self.driver,status=403)
        self.post('/vehicles/v1/refuel',{'action':'complete'},status=403)
        self.request('POST','/vehicles/v1/refuel',{'action':'complete'},auth=self.driver,status=422)
        self.post('/vehicles/v4/refuel',{'action':'start'},status=422)
        self.post('/vehicles/v3/refuel',{'action':'start'},status=422)
        self.post('/vehicles/v1/refuel',{'action':'start'})
        self.post('/vehicles/v1/refuel',{'action':'start'},status=422)
        other = self.login('driver02','driver123')
        self.request('POST','/vehicles/v1/refuel',{'action':'complete'},auth=other,status=403)
        self.post('/dispatch/personnel/driver-v1/status',{'status':'STANDBY','reason':'测试交班'},status=422)
        self.request('POST','/admin/personnel/driver-v1/disable',{},auth=self.admin,status=422)
        self.request('POST','/vehicles/v1/refuel',{'action':'complete'},auth=self.driver)
        self.request('POST','/vehicles/v1/refuel',{'action':'complete'},auth=self.driver,status=422)
        EVIDENCE['refuel_guards'] = {'dispatcher_complete':403,'other_driver':403,'unbind_while_refuelling':422,'unbound_start':422}

    def test_candidates_filter_constraints_and_sort_schematic_journeys(self) -> None:
        standby = self.create_driver("standby")
        resting = self.create_driver("resting", standby=False)
        disabled = self.create_driver("disabled", enabled=False)
        data = self.optimize()
        task = self.pending(data)
        before_fill = self.candidates(task)
        self.assertNotIn("v4", {c["vehicleId"] for c in before_fill})
        data = self.fill_unbound_truck()
        options = self.candidates(task)
        self.assertTrue(options)
        distances = [c["distance"] for c in options]
        self.assertEqual(distances, sorted(distances))
        flight = next(f for f in data["flights"] if f["id"] == task["flight_id"])
        busy_elsewhere = {t["vehicle_id"] for t in data["tasks"] if t["id"] != task["id"] and t["state"] in {"PENDING", "IN_PROGRESS"}}
        for candidate in options:
            self.assertNotIn(candidate["vehicleId"], busy_elsewhere | {"v5"})
            self.assertNotIn(candidate["driverId"], {resting, disabled})
            self.assertGreaterEqual(candidate["fuelLevel"], task["fuel_needed"])
            vehicle = self.vehicle(data, candidate["vehicleId"])
            driver = self.person(data, candidate["driverId"])
            person_position = driver["location"]
            person_journey = abs(person_position["x"] - vehicle["x"]) + abs(person_position["y"] - vehicle["y"])
            truck_journey = abs(vehicle["x"] - flight["x"]) + abs(vehicle["y"] - flight["y"])
            self.assertEqual(candidate["driverDistance"], person_journey)
            self.assertEqual(candidate["distance"], person_journey + truck_journey)
        self.assertTrue(any(c["driverId"] == standby for c in options))
        self.request("GET", f"/tasks/{task['id']}/candidates", auth=self.driver, status=403)
        EVIDENCE["candidate_constraints"] = {"insufficient_fuel_excluded": True, "busy_and_maintenance_excluded": True,
                                             "resting_and_disabled_excluded": True, "standby_supported": True,
                                             "total_journey_sorted": True, "locationMode": "SCHEMATIC"}

    def test_pending_assignment_keeps_last_position_until_work_starts(self) -> None:
        before = self.overview()
        data = self.optimize()
        task = self.pending(data)
        assigned = self.vehicle(data, task["vehicle_id"])
        previous = self.vehicle(before, task["vehicle_id"])
        self.assertEqual((assigned["x"], assigned["y"]), (previous["x"], previous["y"]))
        person = next(p for p in data["personnel"] if p["vehicle_id"] == task["vehicle_id"])
        token = self.login(person["username"], "driver123")
        self.request("POST", f"/tasks/{task['id']}/progress", {"state": "IN_PROGRESS"}, auth=token)
        after = self.overview()
        vehicle = self.vehicle(after, task["vehicle_id"])
        flight = next(f for f in after["flights"] if f["id"] == task["flight_id"])
        self.assertEqual((vehicle["x"], vehicle["y"]), (flight["x"], flight["y"]))
        EVIDENCE["position_lifecycle"] = {"pending_keeps_position": True, "start_moves_to_flight": True}

    def test_current_driver_changes_truck_atomically_and_old_truck_is_released(self) -> None:
        data = self.optimize()
        task = self.pending(data)
        original_vehicle = task["vehicle_id"]
        original_driver = next(p for p in data["personnel"] if p["vehicle_id"] == original_vehicle)["id"]
        self.fill_unbound_truck()
        chosen = next(c for c in self.candidates(task) if c["vehicleId"] == "v4" and c["driverId"] == original_driver)
        after = self.override(task, chosen)["overview"]
        transferred = self.pending(after)
        self.assertEqual(transferred["vehicle_id"], "v4")
        self.assertTrue(transferred["locked"])
        self.assertEqual(transferred["eta_minutes"], chosen["etaMinutes"])
        self.assertEqual(self.person(after, original_driver)["vehicle_id"], "v4")
        self.assertEqual(self.vehicle(after, original_vehicle)["status"], "AVAILABLE")
        self.assertEqual(self.vehicle(after, original_vehicle)["driver"], "")
        person = self.person(after, original_driver)
        driver_token = self.login(person["username"], "driver123")
        workspace = self.request("GET", "/driver/tasks", auth=driver_token)
        self.assertEqual(workspace["driver"]["vehicle"]["id"], "v4")
        self.assertIn(task["id"], {item["id"] for item in workspace["tasks"]})
        EVIDENCE["driver_changes_truck"] = {"pending_transferred": True, "locked": True, "eta_updated": True,
                                             "old_truck_released": True, "driver_workspace_uses_new_truck": True}

    def test_standby_person_can_replace_driver_on_same_pending_truck(self) -> None:
        standby = self.create_driver("replacement")
        data = self.optimize()
        task = self.pending(data)
        previous_person = next(p for p in data["personnel"] if p["vehicle_id"] == task["vehicle_id"])
        previous = previous_person["id"]
        old_driver_token = self.login(previous_person["username"], "driver123")
        chosen = next(c for c in self.candidates(task) if c["vehicleId"] == task["vehicle_id"] and c["driverId"] == standby)
        after = self.override(task, chosen)["overview"]
        self.assertEqual(self.person(after, standby)["work_status"], "ON_DUTY")
        self.assertEqual(self.person(after, standby)["vehicle_id"], task["vehicle_id"])
        self.assertEqual(self.person(after, previous)["work_status"], "STANDBY")
        self.assertIsNone(self.person(after, previous)["vehicle_id"])
        self.assertEqual(self.pending(after)["assigned_driver"], self.person(after, standby)["display_name"])
        first_login = self.request("POST", "/auth/login", {
            "username": "test_replacement", "password": "TestDriver123",
        })["user"]
        self.assertTrue(first_login["must_change"])
        self.request("POST", "/auth/change-password", {
            "oldPassword": "TestDriver123", "newPassword": "ChangedDriver123",
        }, auth=first_login["token"])
        fresh_login = self.request("POST", "/auth/login", {
            "username": "test_replacement", "password": "ChangedDriver123",
        })["user"]
        self.assertFalse(fresh_login["must_change"])
        new_workspace = self.request("GET", "/driver/tasks", auth=fresh_login["token"])
        self.assertIn(task["id"], {item["id"] for item in new_workspace["tasks"]})
        self.assertEqual(new_workspace["driver"]["vehicle"]["id"], task["vehicle_id"])
        old_workspace = self.request("GET", "/driver/tasks", auth=old_driver_token)
        self.assertNotIn(task["id"], {item["id"] for item in old_workspace["tasks"]})
        self.assertIsNone(old_workspace["driver"]["vehicle"])
        self.request("POST", f"/tasks/{task['id']}/progress", {"state": "IN_PROGRESS"}, auth=old_driver_token, status=403)
        EVIDENCE["replace_driver"] = {"standby_called": True, "old_driver_released": True,
                                      "task_driver_updated": True, "new_driver_first_login_password_changed": True,
                                      "new_driver_sees_task": True, "old_driver_cannot_see_task": True,
                                      "old_driver_progress_rejected": 403}

    def test_standby_person_and_unbound_truck_can_take_pending_task(self) -> None:
        standby = self.create_driver("newpair")
        self.optimize()
        data = self.fill_unbound_truck()
        task = self.pending(data)
        chosen = next(c for c in self.candidates(task) if c["vehicleId"] == "v4" and c["driverId"] == standby)
        after = self.override(task, chosen)["overview"]
        self.assertEqual(self.pending(after)["vehicle_id"], "v4")
        self.assertEqual(self.person(after, standby)["vehicle_id"], "v4")
        self.assertEqual(self.person(after, standby)["work_status"], "ON_DUTY")
        self.assertEqual(self.vehicle(after, task["vehicle_id"])["status"], "AVAILABLE")
        EVIDENCE["temporary_pair_assignment"] = {"standby_called": True, "task_transferred": True, "old_truck_released": True}

    def test_expired_candidate_is_revalidated_without_partial_binding(self) -> None:
        standby = self.create_driver("stale")
        data = self.optimize()
        task = self.pending(data)
        self.fill_unbound_truck()
        chosen = next(c for c in self.candidates(task) if c["vehicleId"] == "v4" and c["driverId"] == standby)
        self.post("/vehicles/v4/refuel", {"action": "start"}, status=422)
        blocker = self.create_driver("blocker")
        self.post(f"/dispatch/personnel/{blocker}/call", {"vehicleId": "v4"})
        self.override(task, chosen, status=422)
        after = self.overview()
        self.assertEqual(self.pending(after)["vehicle_id"], task["vehicle_id"])
        self.assertEqual(self.person(after, standby)["work_status"], "STANDBY")
        self.assertIsNone(self.person(after, standby)["vehicle_id"])
        self.assertEqual(self.person(after, blocker)["vehicle_id"], "v4")
        EVIDENCE["expired_candidate"] = {"rejected": 422, "original_task_unchanged": True, "no_partial_binding": True}

    def test_in_progress_task_cannot_be_reassigned(self) -> None:
        data = self.overview()
        task = next(task for task in data["tasks"] if task["state"] == "IN_PROGRESS")
        self.get(f"/tasks/{task['id']}/candidates", status=422)
        self.post(f"/tasks/{task['id']}/override", {
            "vehicleId": "v1", "driverId": "driver-v1", "dispatchOrder": 1,
        }, status=422)
        after = self.overview()
        original = next(t for t in after["tasks"] if t["id"] == task["id"])
        self.assertEqual(original["state"], "IN_PROGRESS")
        self.assertEqual(original["vehicle_id"], task["vehicle_id"])
        EVIDENCE["in_progress_handover_guard"] = {"candidate_and_save_rejected": 422, "active_task_unchanged": True}

    def test_personnel_truck_change_rejects_low_fuel_then_transfers_pending_work(self) -> None:
        data = self.optimize()
        task = self.pending(data)
        person = next(p for p in data["personnel"] if p["vehicle_id"] == task["vehicle_id"])
        endpoint = f"/dispatch/personnel/{person['id']}/vehicle"
        self.post(endpoint, {"vehicleId": "v4"}, status=422)
        unchanged = self.overview()
        self.assertEqual(self.pending(unchanged)["vehicle_id"], task["vehicle_id"])
        self.assertEqual(self.person(unchanged, person["id"])["vehicle_id"], task["vehicle_id"])
        self.fill_unbound_truck()
        after = self.post(endpoint, {"vehicleId": "v4"})["overview"]
        self.assertEqual(self.pending(after)["vehicle_id"], "v4")
        self.assertTrue(self.pending(after)["locked"])
        self.assertEqual(self.person(after, person["id"])["vehicle_id"], "v4")
        self.assertEqual(self.vehicle(after, task["vehicle_id"])["status"], "AVAILABLE")
        self.post("/dispatch/personnel/driver-v3/vehicle", {"vehicleId": task["vehicle_id"]}, status=422)
        EVIDENCE["personnel_truck_change"] = {"insufficient_fuel_rejected": 422, "pending_transferred": True,
                                               "old_truck_released": True, "in_progress_rejected": 422}

    def test_concurrent_assignments_cannot_claim_same_person_and_truck(self) -> None:
        standby = self.create_driver("race")
        self.optimize()
        data = self.fill_unbound_truck()
        tasks = [t for t in data["tasks"] if t["state"] == "PENDING"]
        self.assertEqual(len(tasks), 2)
        choices = [next(c for c in self.candidates(task) if c["vehicleId"] == "v4" and c["driverId"] == standby) for task in tasks]
        gate = threading.Barrier(2)

        def submit(item: tuple[dict, dict]) -> int:
            task, candidate = item
            request = Request(self.base + f"/tasks/{task['id']}/override", method="POST",
                              headers={"Content-Type": "application/json", "Authorization": f"Bearer {self.dispatch}"},
                              data=json.dumps({"vehicleId": candidate["vehicleId"], "driverId": candidate["driverId"],
                                               "dispatchOrder": task["dispatch_order"] or 1}).encode())
            gate.wait(timeout=5)
            try:
                with urlopen(request, timeout=5) as response:
                    response.read()
                    return response.status
            except HTTPError as error:
                with error:
                    error.read()
                    return error.code

        with ThreadPoolExecutor(max_workers=2) as executor:
            statuses = list(executor.map(submit, zip(tasks, choices)))
        self.assertEqual(sorted(statuses), [200, 422])
        after = self.overview()
        assigned = [t for t in after["tasks"] if t["vehicle_id"] == "v4" and t["state"] in {"PENDING", "IN_PROGRESS"}]
        self.assertEqual(len(assigned), 1)
        self.assertEqual(self.person(after, standby)["vehicle_id"], "v4")
        self.assertEqual(len([p for p in after["personnel"] if p["vehicle_id"] == "v4"]), 1)
        self.assertEqual(len([t for t in after["tasks"] if t["state"] in {"PENDING", "IN_PROGRESS"}]), 3)
        EVIDENCE["concurrent_resource_claim"] = {"responses": [200, 422], "one_active_task_on_target": True,
                                                 "one_person_binding": True, "no_task_lost": True}

    def test_safety_fuel_threshold_blocks_dispatch_even_for_small_flight(self) -> None:
        data = self.optimize()
        for expected_flight in ("f2", "f5"):
            task = next(t for t in data["tasks"] if t["flight_id"] == expected_flight and t["state"] == "PENDING")
            self.assertEqual(task["vehicle_id"], "v1")
            self.request("POST", f"/tasks/{task['id']}/progress", {"state": "IN_PROGRESS"}, auth=self.driver)
            data = self.request("POST", f"/tasks/{task['id']}/progress", {
                "state": "COMPLETED", "fuelLoaded": task["fuel_needed"],
            }, auth=self.driver)["overview"]
        vehicle = self.vehicle(data, "v1")
        self.assertEqual(vehicle["fuel_level"], 3000)
        self.assertLess(vehicle["fuel_level"] * 5, vehicle["capacity"])
        self.post("/admin/flights/import", {"flights": [{
            "flightNo": "TEST100", "gate": "A01", "departureAt": (datetime.now(timezone.utc) + timedelta(hours=4)).isoformat(),
            "fuelNeeded": 1000, "priority": 3, "x": 3, "y": 6,
        }]})
        data = self.optimize()
        tiny = next(f for f in data["flights"] if f["flight_no"] == "TEST100")
        self.assertFalse(any(t["flight_id"] == tiny["id"] and t["state"] in {"PENDING", "IN_PROGRESS"} for t in data["tasks"]))
        self.assertTrue(any(a["type"] == "VEHICLE_LOW_FUEL" and a["related_id"] == "v1" for a in data["alerts"]))
        self.post("/dispatch/personnel/driver-v1/status", {"status": "STANDBY", "reason": "补油候命"})
        self.post("/dispatch/personnel/driver-v1/call", {"vehicleId": "v1"})
        self.assertFalse(any(t['flight_id']==tiny['id'] and t['state']=='PENDING' for t in self.optimize()['tasks']))
        self.post('/vehicles/v1/refuel', {'action':'start'})
        self.request('POST','/vehicles/v1/refuel',{'action':'complete'},auth=self.driver)
        EVIDENCE["safety_threshold"] = {"enough_for_small_flight_but_below_twenty_percent": True,
                                         "automatic_dispatch_blocked": True, "low_fuel_alert": True,
                                         "binding_for_refuel_allowed_but_dispatch_blocked": True}


if __name__ == "__main__":
    unittest.main(verbosity=2)
