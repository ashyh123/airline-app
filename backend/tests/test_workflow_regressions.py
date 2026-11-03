"""Regression scenarios for the website review, through production HTTP only."""

from datetime import datetime, timedelta, timezone
import unittest

import test_dispatch_http as harness


ACTIVE = {"PENDING", "IN_PROGRESS", "AWAITING_REVIEW"}


def tearDownModule() -> None:
    harness.tearDownModule()


class WorkflowRegressionTests(harness.HTTPScenario):
    @staticmethod
    def flight(data: dict, identifier: str) -> dict:
        return next(flight for flight in data["flights"] if flight["id"] == identifier)

    @staticmethod
    def task(data: dict, identifier: str) -> dict:
        return next(task for task in data["tasks"] if task["id"] == identifier)

    def task_driver(self, data: dict, task: dict) -> str:
        driver = next(p for p in data["personnel"] if p["vehicle_id"] == task["vehicle_id"])
        return self.login(driver["username"], "driver123")

    def assert_consistent_active_resources(self, data: dict) -> None:
        active = [task for task in data["tasks"] if task["state"] in ACTIVE]
        self.assertEqual(len(active), len({task["flight_id"] for task in active}))
        for vehicle in data["vehicles"]:
            occupied = [task for task in active if task["vehicle_id"] == vehicle["id"]]
            self.assertLessEqual(len(occupied), 1)
            if vehicle["status"] == "RESERVED":
                self.assertTrue(occupied, "An unoccupied vehicle must not remain reserved")
            if vehicle["status"] == "MAINTENANCE":
                self.assertFalse(occupied, "A maintenance vehicle cannot retain executable work")

    def test_zero_short_and_excess_cannot_silently_complete(self) -> None:
        before = self.overview()
        task = self.task(before, "t-seeded")
        vehicle = self.vehicle(before, task["vehicle_id"])
        token = self.login("driver03", "driver123")
        for amount in (0, 100, task["fuel_needed"] + 1):
            with self.subTest(amount=amount):
                self.request("POST", "/tasks/t-seeded/progress", {
                    "state": "COMPLETED", "fuelLoaded": amount,
                }, auth=token, status=422)
        unchanged = self.overview()
        self.assertEqual(self.task(unchanged, task["id"])["state"], "IN_PROGRESS")
        self.assertEqual(self.vehicle(unchanged, vehicle["id"])["fuel_level"], vehicle["fuel_level"])
        completed = self.request("POST", "/tasks/t-seeded/progress", {
            "state": "COMPLETED", "fuelLoaded": task["fuel_needed"],
        }, auth=token)["overview"]
        remaining = vehicle["fuel_level"] - task["fuel_needed"]
        self.assertEqual(self.vehicle(completed, vehicle["id"])["fuel_level"], remaining)
        self.assertEqual(self.flight(completed, task["flight_id"])["status"], "COMPLETED")
        arrived = self.post("/events", {
            "eventId": "arrival-after-completion", "flightId": task["flight_id"], "type": "ARRIVED",
        })["overview"]
        self.assertEqual(self.flight(arrived, task["flight_id"])["status"], "COMPLETED")
        self.assertFalse(any(t["flight_id"] == task["flight_id"] and t["state"] in ACTIVE for t in arrived["tasks"]))
        self.request("POST", "/tasks/t-seeded/progress", {
            "state": "COMPLETED", "fuelLoaded": task["fuel_needed"],
        }, auth=token, status=422)
        self.assertEqual(self.vehicle(self.overview(), vehicle["id"])["fuel_level"], remaining)
        harness.EVIDENCE["completion_quantity_and_retry"] = {
            "zero_short_excess_rejected": True, "exact_quantity_completed": True,
            "repeat_did_not_deduct_twice": True, "arrival_cannot_reopen_completed_flight": True,
        }

    def test_partial_fuel_waits_for_dispatcher_and_only_remaining_is_replanned(self) -> None:
        before = self.overview()
        task = self.task(before, "t-seeded")
        token = self.login("driver03", "driver123")
        supplied = 100
        remaining = task["fuel_needed"] - supplied
        payload = {"state": "AWAITING_REVIEW", "fuelLoaded": supplied, "reason": "加注中断等待调度确认"}
        for invalid_reason in ("", None):
            self.request("POST", "/tasks/t-seeded/progress", {**payload, "reason": invalid_reason}, auth=token, status=422)
        held = self.request("POST", "/tasks/t-seeded/progress", payload, auth=token)["overview"]
        report = self.task(held, task["id"])
        self.assertEqual(report["state"], "AWAITING_REVIEW")
        self.assertEqual(report["fuel_loaded"], supplied)
        self.assertEqual(report["remaining_fuel"], remaining)
        self.assertEqual(report["fuel_needed"], task["fuel_needed"])
        self.assertEqual(self.flight(held, task["flight_id"])["status"], "AWAITING_REVIEW")
        self.assertEqual(self.vehicle(held, task["vehicle_id"])["status"], "RESERVED")
        fuel_after = self.vehicle(before, task["vehicle_id"])["fuel_level"] - supplied
        self.assertEqual(self.vehicle(held, task["vehicle_id"])["fuel_level"], fuel_after)
        delayed = self.post("/events", {
            "eventId": "delay-during-review", "flightId": task["flight_id"], "type": "DELAYED",
        })["overview"]
        self.assertEqual(self.flight(delayed, task["flight_id"])["status"], "AWAITING_REVIEW")
        self.assertEqual([t["id"] for t in delayed["tasks"] if t["flight_id"] == task["flight_id"] and t["state"] in ACTIVE], [task["id"]])
        self.assertEqual(self.vehicle(delayed, task["vehicle_id"])["fuel_level"], fuel_after)
        for event_type in ("CANCELLED", "DEPARTING"):
            self.post("/events", {
                "eventId": f"blocked-{event_type}", "flightId": task["flight_id"], "type": event_type,
            }, status=422)
        review_alert = next(a for a in delayed["alerts"] if a["type"] == "PARTIAL_FUEL_REVIEW" and a["related_id"] == task["id"])
        acknowledged = self.post(f"/alerts/{review_alert['id']}/resolve", {"resolution": "已确认差额，保留现场待调度"})["overview"]
        self.assertTrue(any(a["id"] == review_alert["id"] and a["resolved"] == 0 for a in acknowledged["alerts"]))
        self.request("POST", "/tasks/t-seeded/progress", payload, auth=token, status=422)
        optimized = self.optimize()
        self.assertEqual([t["id"] for t in optimized["tasks"] if t["flight_id"] == task["flight_id"] and t["state"] in ACTIVE], [task["id"]])
        self.request("POST", "/tasks/t-seeded/followup", {"reason": "安排剩余需求保障"}, auth=token, status=403)
        for invalid_reason in ("", None):
            self.post("/tasks/t-seeded/followup", {"reason": invalid_reason}, status=422)
        planned = self.post("/tasks/t-seeded/followup", {"reason": "安排剩余需求保障"})["overview"]
        historical = self.task(planned, task["id"])
        self.assertEqual(historical["state"], "PARTIAL")
        self.assertEqual(historical["fuel_needed"], task["fuel_needed"])
        self.assertEqual(historical["fuel_loaded"], supplied)
        self.assertEqual(self.vehicle(planned, task["vehicle_id"])["fuel_level"], fuel_after)
        self.assertFalse(any(a["id"] == review_alert["id"] for a in planned["alerts"]))
        self.assertTrue(any(a["id"] == review_alert["id"] and a["resolved"] == 1 for a in planned["recentResolutions"]))
        replacement = self.pending(planned, task["flight_id"])
        self.assertEqual(replacement["fuel_needed"], remaining)
        replacement_token = self.task_driver(planned, replacement)
        self.request("POST", f"/tasks/{replacement['id']}/progress", {"state": "IN_PROGRESS"}, auth=replacement_token)
        finished = self.request("POST", f"/tasks/{replacement['id']}/progress", {
            "state": "COMPLETED", "fuelLoaded": remaining,
        }, auth=replacement_token)["overview"]
        self.assertEqual(self.flight(finished, task["flight_id"])["status"], "COMPLETED")
        self.assertEqual(sum(t["fuel_loaded"] for t in finished["tasks"] if t["flight_id"] == task["flight_id"]), task["fuel_needed"])
        self.post("/tasks/t-seeded/followup", {"reason": "重复确认不应再派单"}, status=422)
        self.assert_consistent_active_resources(self.overview())
        harness.EVIDENCE["partial_confirmation_lifecycle"] = {
            "reported": supplied, "remaining": remaining, "held_until_dispatcher": True,
            "original_demand_preserved": True, "only_remaining_replanned": True,
            "total_delivered_matches_demand": True, "duplicates_rejected": True,
            "delay_event_preserves_dispatcher_review": True,
            "cancellation_cannot_bypass_review": True, "review_alert_resolved_only_after_followup": True,
            "non_text_reasons_rejected": True,
        }

    def test_task_and_flight_cancellation_release_unoccupied_resources(self) -> None:
        initial = self.optimize()
        original = self.pending(initial)
        token = self.task_driver(initial, original)
        after = self.request("POST", f"/tasks/{original['id']}/progress", {"state": "CANCELLED"}, auth=token)["overview"]
        self.assertFalse(any(t["id"] == original["id"] and t["state"] in ACTIVE for t in after["tasks"]))
        self.assert_consistent_active_resources(after)
        replanned = self.optimize()
        replacement = self.pending(replanned, original["flight_id"])
        self.assertNotEqual(replacement["id"], original["id"])
        event = {"eventId": "cancel-once", "flightId": original["flight_id"], "type": "CANCELLED"}
        cancelled = self.post("/events", event)["overview"]
        self.assertEqual(self.flight(cancelled, original["flight_id"])["status"], "CANCELLED")
        self.assertFalse(any(t["flight_id"] == original["flight_id"] and t["state"] in ACTIVE for t in cancelled["tasks"]))
        self.assert_consistent_active_resources(cancelled)
        self.assertTrue(self.post("/events", event)["duplicate"])
        again = self.optimize()
        self.assertEqual(self.flight(again, original["flight_id"])["status"], "CANCELLED")
        self.assert_consistent_active_resources(again)
        harness.EVIDENCE["cancellation_resources"] = {
            "task_cancel_replans": True, "flight_cancel_stays_cancelled": True,
            "no_orphan_reservation": True, "duplicate_event_ignored": True,
        }

    def test_replaced_exception_cannot_reopen_on_maintenance_vehicle(self) -> None:
        token = self.login("driver03", "driver123")
        after = self.request("POST", "/tasks/t-seeded/progress", {
            "state": "EXCEPTION", "reason": "车辆泵故障需要替换保障",
        }, auth=token)["overview"]
        self.assertEqual(self.vehicle(after, "v3")["status"], "MAINTENANCE")
        self.pending(after, "f3")
        self.request("POST", "/tasks/t-seeded/progress", {"state": "PENDING"}, auth=token, status=422)
        current = self.overview()
        self.assertEqual(len([t for t in current["tasks"] if t["flight_id"] == "f3" and t["state"] in ACTIVE]), 1)
        self.assert_consistent_active_resources(current)
        workspace = self.request("GET", "/driver/tasks", auth=token)
        self.assertFalse(any(t["id"] == "t-seeded" for t in workspace["tasks"]))
        harness.EVIDENCE["exception_terminal_guard"] = {"replacement_created": True, "old_task_reopen_rejected": True, "one_active_task": True}

    def test_import_preview_and_apply_share_active_task_and_time_validation(self) -> None:
        before = self.overview()
        existing = self.flight(before, "f3")
        future = (datetime.now(timezone.utc) + timedelta(hours=4)).isoformat()
        entries = [
            {"flightNo": existing["flight_no"], "gate": existing["gate"], "departureAt": existing["departure_at"], "fuelNeeded": 20000, "priority": 3},
            {"flightNo": "TIMEBAD", "gate": "A01", "departureAt": "tomorrow-ish", "fuelNeeded": 1000, "priority": 2},
            {"flightNo": "GATEBAD", "gate": None, "departureAt": future, "fuelNeeded": 1000, "priority": 2},
            {"flightNo": "VALID01", "gate": "A02", "departureAt": future, "fuelNeeded": 1000, "priority": 2},
        ]
        self.post("/flights/f3", {"fuelNeeded": 20000}, status=422)
        preview = self.post("/admin/flights/import", {"flights": entries, "preview": True})
        self.assertEqual(preview["imported"], 0)
        self.assertEqual([row["action"] for row in preview["rows"]], ["REJECT", "REJECT", "REJECT", "CREATE"])
        self.assertEqual([row["row"] for row in preview["rows"]], [1, 2, 3, 4])
        self.assertTrue(all(row.get("error") for row in preview["rows"] if row["action"] == "REJECT"))
        unchanged = self.overview()
        self.assertEqual(len(unchanged["flights"]), len(before["flights"]))
        self.assertEqual(self.flight(unchanged, "f3")["fuel_needed"], existing["fuel_needed"])
        applied = self.post("/admin/flights/import", {"flights": entries})
        self.assertEqual(applied["imported"], 1)
        self.assertEqual(len(applied["rejected"]), 3)
        after = self.overview()
        self.assertEqual(len(after["flights"]), len(before["flights"]) + 1)
        self.assertNotIn("TIMEBAD", {f["flight_no"] for f in after["flights"]})
        self.assertNotIn("GATEBAD", {f["flight_no"] for f in after["flights"]})
        self.assertEqual(self.task(after, "t-seeded")["fuel_needed"], existing["fuel_needed"])
        harness.EVIDENCE["import_validation"] = {"preview_writes": 0, "invalid_rows_rejected": 3, "valid_rows_applied": 1, "active_demand_preserved": True}

    def test_impossible_arrival_is_flagged_and_fake_on_time_rate_is_absent(self) -> None:
        departure = datetime.now(timezone.utc) + timedelta(minutes=1)
        self.post("/admin/flights/import", {"flights": [{
            "flightNo": "DUE001", "gate": "D30", "departureAt": departure.isoformat(),
            "fuelNeeded": 1000, "priority": 3, "x": 29, "y": 29,
        }]})
        after = self.optimize()
        flight = next(f for f in after["flights"] if f["flight_no"] == "DUE001")
        task = self.pending(after, flight["id"])
        self.assertGreater(task["eta_minutes"], 1)
        self.assertTrue(task["timeRisk"])
        self.assertGreater(datetime.fromisoformat(task["estimatedCompletionAt"]), departure)
        self.assertTrue(any(a["related_id"] == flight["id"] and a["type"] != "NO_ELIGIBLE_VEHICLE" for a in after["alerts"]))
        self.assertIsNone(after["stats"]["onTimeRate"])
        alert = next(a for a in after["alerts"] if a["related_id"] == flight["id"] and a["type"] == "TIME_WINDOW")
        postponed = self.post(f"/flights/{flight['id']}", {
            "departureAt": (datetime.now(timezone.utc) + timedelta(hours=8)).isoformat(),
        })["overview"]
        self.assertIsNone(self.task(postponed, task["id"])["timeRisk"])
        self.assertFalse(any(a["id"] == alert["id"] for a in postponed["alerts"]))
        self.assertTrue(any(a["id"] == alert["id"] and a["resolved"] == 1 for a in postponed["recentResolutions"]))
        self.assertFalse(any(a["type"] == "TIME_WINDOW" and a["related_id"] == flight["id"] for a in self.optimize()["alerts"]))
        harness.EVIDENCE["deadline_visibility"] = {
            "impossible_arrival_flagged": True, "time_alert_created": True, "on_time_rate": None,
            "postponement_reassesses_and_resolves_time_risk": True,
        }

    def test_acknowledging_shortage_preserves_risk_until_resource_is_assigned(self) -> None:
        data = self.optimize()
        target = next(a for a in data["alerts"] if a["type"] == "NO_ELIGIBLE_VEHICLE" and a["related_id"] == "f5")
        self.post(f"/alerts/{target['id']}/resolve", {"resolution": None}, status=422)
        acknowledged = self.post(f"/alerts/{target['id']}/resolve", {"resolution": "已确认短缺，等待前序任务释放车辆"})["overview"]
        retained = next(a for a in acknowledged["alerts"] if a["id"] == target["id"])
        self.assertEqual(retained["resolved"], 0)
        self.assertEqual(retained["status"], "ACKNOWLEDGED")
        self.assertTrue(retained["acknowledged_at"])
        repeated = self.optimize()
        matching = [a for a in repeated["alerts"] if a["type"] == target["type"] and a["related_id"] == target["related_id"]]
        self.assertEqual([a["id"] for a in matching], [target["id"]])
        first = self.pending(repeated, "f2")
        token = self.task_driver(repeated, first)
        self.request("POST", f"/tasks/{first['id']}/progress", {"state": "IN_PROGRESS"}, auth=token)
        solved = self.request("POST", f"/tasks/{first['id']}/progress", {
            "state": "COMPLETED", "fuelLoaded": first["fuel_needed"],
        }, auth=token)["overview"]
        self.pending(solved, "f5")
        self.assertFalse(any(a["id"] == target["id"] for a in solved["alerts"]))
        resolution = next(a for a in solved["recentResolutions"] if a["id"] == target["id"])
        self.assertEqual(resolution["resolved"], 1)
        harness.EVIDENCE["risk_acknowledgement"] = {"acknowledged_not_resolved": True, "same_id_on_recheck": True, "actual_assignment_resolves": True}


class AccountRegressionTests(harness.HTTPScenario):
    def create_account(self, suffix: str, role: str = "DISPATCHER") -> tuple[dict, str]:
        password = "ReviewInitial123"
        created = self.request("POST", "/admin/personnel", {
            "role": role, "empNo": "R" + suffix, "name": "回归人员" + suffix,
            "username": "review_" + suffix, "password": password,
        }, auth=self.admin)["personnel"]
        return created, password

    def test_personnel_create_edit_and_list_omit_credential_fields(self) -> None:
        person, _ = self.create_account("privacy", "DRIVER")
        self.assertFalse(any(field in person for field in ("password", "password_hash")))
        updated = self.request("POST", f"/admin/personnel/{person['id']}/profile", {
            "name": "更新后的人员", "phone": "13800000000",
        }, auth=self.admin)["personnel"]
        self.assertFalse(any(field in updated for field in ("password", "password_hash")))
        self.assertEqual(updated["display_name"], "更新后的人员")
        listed = self.request("GET", "/admin/personnel", auth=self.admin)["personnel"]
        self.assertFalse(any(field in row for row in listed for field in ("password", "password_hash")))
        harness.EVIDENCE["personnel_response_privacy"] = {"create_edit_list_exclude_credentials": True, "profile_change_preserved": True}

    def test_first_password_change_blocks_business_and_rotates_all_sessions(self) -> None:
        person, password = self.create_account("firstchange")
        first = self.request("POST", "/auth/login", {"username": person["username"], "password": password})["user"]
        second = self.login(person["username"], password)
        self.assertTrue(first["must_change"])
        denied = self.request("GET", "/overview", auth=first["token"], status=403)
        self.assertEqual(denied["code"], "PASSWORD_CHANGE_REQUIRED")
        resting = self.create_driver("firstguard", standby=False)
        self.request("POST", f"/dispatch/personnel/{resting}/status", {"status": "STANDBY"}, auth=first["token"], status=403)
        self.assertEqual(self.person(self.overview(), resting)["work_status"], "RESTING")
        self.request("POST", "/auth/change-password", {"oldPassword": password, "newPassword": password}, auth=first["token"], status=422)
        self.request("POST", "/auth/change-password", {"oldPassword": "Incorrect123", "newPassword": "ReviewChanged123"}, auth=first["token"], status=422)
        changed = self.request("POST", "/auth/change-password", {"oldPassword": password, "newPassword": "ReviewChanged123"}, auth=first["token"])["user"]
        self.assertFalse(changed["must_change"])
        self.assertTrue(bool(changed.get("token")) and changed["token"] not in {first["token"], second})
        for token in (first["token"], second):
            self.request("GET", "/overview", auth=token, status=401)
        self.request("GET", "/overview", auth=changed["token"])
        self.request("POST", "/auth/login", {"username": person["username"], "password": password}, status=422)
        self.login(person["username"], "ReviewChanged123")
        harness.EVIDENCE["first_password_and_rotation"] = {"business_read_write_blocked": True, "unchanged_password_rejected": True, "old_sessions_revoked": 2, "fresh_session_usable": True, "must_change": False}

    def test_logout_revokes_only_current_session_and_is_repeatable(self) -> None:
        other = self.login("driver01", "driver123")
        self.request("GET", "/driver/tasks", auth=self.driver)
        self.request("POST", "/auth/logout", {}, auth=self.driver)
        self.request("GET", "/driver/tasks", auth=self.driver, status=401)
        self.request("GET", "/driver/tasks", auth=other)
        self.request("POST", "/auth/logout", {}, auth=self.driver)
        self.request("POST", "/auth/logout", {}, auth=None)
        self.request("GET", "/driver/tasks", auth=other)
        harness.EVIDENCE["logout_revocation"] = {"current_revoked": True, "other_session_preserved": True, "repeat_safe": True}

    def test_reset_and_disable_keep_role_and_work_ownership_guards(self) -> None:
        person, initial = self.create_account("reset", "DRIVER")
        token = self.login(person["username"], initial)
        changed = self.request("POST", "/auth/change-password", {"oldPassword": initial, "newPassword": "UpdatedDriver123"}, auth=token)["user"]
        reset = self.request("POST", f"/admin/personnel/{person['id']}/reset-password", {}, auth=self.admin)
        self.request("GET", "/driver/tasks", auth=changed["token"], status=401)
        reset_user = self.request("POST", "/auth/login", {"username": person["username"], "password": reset["password"]})["user"]
        self.assertTrue(reset_user["must_change"])
        self.request("GET", "/driver/tasks", auth=reset_user["token"], status=403)
        self.request("POST", f"/admin/personnel/{person['id']}/disable", {}, auth=self.admin)
        self.request("GET", "/driver/tasks", auth=reset_user["token"], status=401)
        self.request("POST", "/admin/personnel/driver-v3/disable", {}, auth=self.admin, status=422)
        self.request("GET", "/admin/personnel", auth=self.driver, status=403)
        self.request("POST", "/dispatch/optimize", {}, auth=self.admin, status=403)
        self.request("POST", "/tasks/t-seeded/progress", {"state": "COMPLETED", "fuelLoaded": 8400}, auth=self.driver, status=403)
        harness.EVIDENCE["preserved_permission_guards"] = {"reset_revokes": True, "reset_requires_change": True, "disable_revokes": True, "active_worker_protected": True, "role_and_task_ownership_protected": True}


if __name__ == "__main__":
    unittest.main(verbosity=2)
