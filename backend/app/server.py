"""Airport fuel-truck dispatch API.

The service deliberately keeps the integration boundary small: A-OCS sends
flight events to /api/events and the dispatcher/driver clients use JSON APIs.
The default scheduler is a deterministic, explainable greedy heuristic.  The
``Scheduler`` class is the seam where an OR-Tools VRPTW implementation can be
plugged in for a production deployment.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parents[1]
DATABASE = Path(os.getenv("DISPATCH_DB", ROOT / "dispatch.db"))
EVENT_TYPES = {"ARRIVED", "DELAYED", "CANCELLED", "DEPARTING"}
TASK_TRANSITIONS = {
    "PENDING": {"IN_PROGRESS", "CANCELLED"},
    "IN_PROGRESS": {"COMPLETED", "EXCEPTION", "AWAITING_REVIEW"},
}


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect() -> sqlite3.Connection:
    connection = sqlite3.connect(DATABASE)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


WORK_STATUSES = {"ON_DUTY": "值班", "STANDBY": "休闲", "RESTING": "休息"}
PASSWORD_ITERATIONS = 120_000
LOW_FUEL_RATIO = 0.2
REFUEL_POINT = {"name": "西侧补油点", "x": 1, "y": 17}
STANDBY_POINT = {"name": "人员候命区", "x": 3, "y": 17}
SERVICE_MINUTES = 18
DEPARTURE_BUFFER_MINUTES = 0


class AccessError(PermissionError):
    def __init__(self, message: str, code: str, status: HTTPStatus = HTTPStatus.FORBIDDEN):
        super().__init__(message)
        self.code = code
        self.status = status


def hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PASSWORD_ITERATIONS)
    return f"pbkdf2${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str | None) -> bool:
    if not stored:
        return False
    try:
        _, salt_hex, digest_hex = stored.split("$")
        candidate = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), PASSWORD_ITERATIONS)
        return hmac.compare_digest(candidate.hex(), digest_hex)
    except (ValueError, AttributeError):
        return False


def generate_password() -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789"
    return "Fuel@" + "".join(secrets.choice(alphabet) for _ in range(6))


def check_password_strength(password: str) -> None:
    if not 8 <= len(password) <= 64:
        raise ValueError("密码长度应为 8 至 64 位")
    if not re.search(r"[A-Za-z]", password) or not re.search(r"\d", password):
        raise ValueError("密码需同时包含字母和数字")


def log_operation(
    db: sqlite3.Connection, actor: sqlite3.Row | dict | None, action: str,
    target_type: str = "", target_id: str = "", target_name: str = "",
    before: str = "", after: str = "", reason: str = "", result: str = "成功",
) -> None:
    actor_id = actor["id"] if actor else ""
    actor_name = actor["display_name"] if actor else "系统"
    db.execute(
        """INSERT INTO operation_logs
           (id, actor_id, actor_name, action, target_type, target_id, target_name,
            before_state, after_state, reason, result, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (str(uuid.uuid4()), actor_id, actor_name, action, target_type, target_id, target_name,
         before, after, reason, result, now()),
    )


SCHEMA = """
CREATE TABLE IF NOT EXISTS flights (
  id TEXT PRIMARY KEY, flight_no TEXT NOT NULL, gate TEXT NOT NULL,
  departure_at TEXT NOT NULL, fuel_needed INTEGER NOT NULL,
  priority INTEGER NOT NULL, status TEXT NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS vehicles (
  id TEXT PRIMARY KEY, code TEXT NOT NULL, driver TEXT NOT NULL,
  fuel_level INTEGER NOT NULL, capacity INTEGER NOT NULL, status TEXT NOT NULL,
  x INTEGER NOT NULL, y INTEGER NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, flight_id TEXT NOT NULL REFERENCES flights(id),
  vehicle_id TEXT REFERENCES vehicles(id), state TEXT NOT NULL, locked INTEGER NOT NULL DEFAULT 0,
  eta_minutes INTEGER, dispatch_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, assigned_driver TEXT
);
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY, level TEXT NOT NULL, type TEXT NOT NULL, message TEXT NOT NULL,
  related_id TEXT, resolved INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
  resolution TEXT, resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS received_events (
  id TEXT PRIMARY KEY, received_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS broadcasts (
  id TEXT PRIMARY KEY, level TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
  flight_id TEXT REFERENCES flights(id), source TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
  display_name TEXT NOT NULL, role TEXT NOT NULL,
  vehicle_id TEXT REFERENCES vehicles(id),
  emp_no TEXT, phone TEXT, account_status TEXT NOT NULL DEFAULT 'ENABLED',
  work_status TEXT, password_hash TEXT, must_change INTEGER NOT NULL DEFAULT 0,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS operation_logs (
  id TEXT PRIMARY KEY, actor_id TEXT, actor_name TEXT, action TEXT NOT NULL,
  target_type TEXT, target_id TEXT, target_name TEXT,
  before_state TEXT, after_state TEXT, reason TEXT, result TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
"""


def init_db() -> None:
    with connect() as db:
        db.executescript(SCHEMA)
        # Lightweight migration for databases created by the earlier prototype.
        existing_columns = {row["name"] for row in db.execute("PRAGMA table_info(users)")}
        if "username" not in existing_columns:
            db.execute("ALTER TABLE users ADD COLUMN username TEXT")
        if "password" not in existing_columns:
            db.execute("ALTER TABLE users ADD COLUMN password TEXT")
        task_columns = {row["name"] for row in db.execute("PRAGMA table_info(tasks)")}
        if "dispatch_order" not in task_columns:
            db.execute("ALTER TABLE tasks ADD COLUMN dispatch_order INTEGER NOT NULL DEFAULT 0")
        if "assigned_driver" not in task_columns:
            db.execute("ALTER TABLE tasks ADD COLUMN assigned_driver TEXT")
            db.execute(
                "UPDATE tasks SET assigned_driver="
                "(SELECT driver FROM vehicles WHERE vehicles.id = tasks.vehicle_id) "
                "WHERE assigned_driver IS NULL"
            )
        for column, definition in {
            "fuel_requested": "INTEGER",
            "fuel_loaded": "INTEGER",
            "reason": "TEXT",
        }.items():
            if column not in task_columns:
                db.execute(f"ALTER TABLE tasks ADD COLUMN {column} {definition}")
        db.execute("UPDATE tasks SET fuel_requested=(SELECT fuel_needed FROM flights WHERE id=tasks.flight_id) WHERE fuel_requested IS NULL")
        flight_columns = {row["name"] for row in db.execute("PRAGMA table_info(flights)")}
        if "fuel_delivered" not in flight_columns:
            db.execute("ALTER TABLE flights ADD COLUMN fuel_delivered INTEGER NOT NULL DEFAULT 0")
        alert_columns = {row["name"] for row in db.execute("PRAGMA table_info(alerts)")}
        if "resolution" not in alert_columns:
            db.execute("ALTER TABLE alerts ADD COLUMN resolution TEXT")
        if "resolved_at" not in alert_columns:
            db.execute("ALTER TABLE alerts ADD COLUMN resolved_at TEXT")
        for column in ("acknowledged_at", "acknowledged_by", "acknowledged_note"):
            if column not in alert_columns:
                db.execute(f"ALTER TABLE alerts ADD COLUMN {column} TEXT")
        # Personnel & account management columns (FR-01/FR-02).
        user_columns = {row["name"] for row in db.execute("PRAGMA table_info(users)")}
        for column, ddl in {
            "emp_no": "ALTER TABLE users ADD COLUMN emp_no TEXT",
            "phone": "ALTER TABLE users ADD COLUMN phone TEXT",
            "account_status": "ALTER TABLE users ADD COLUMN account_status TEXT NOT NULL DEFAULT 'ENABLED'",
            "work_status": "ALTER TABLE users ADD COLUMN work_status TEXT",
            "password_hash": "ALTER TABLE users ADD COLUMN password_hash TEXT",
            "must_change": "ALTER TABLE users ADD COLUMN must_change INTEGER NOT NULL DEFAULT 0",
            "created_at": "ALTER TABLE users ADD COLUMN created_at TEXT",
        }.items():
            if column not in user_columns:
                db.execute(ddl)
        db.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_vehicle "
            "ON users(vehicle_id) WHERE vehicle_id IS NOT NULL"
        )
        # Migrate legacy plaintext passwords into PBKDF2 hashes (FR-02.4).
        for item in db.execute("SELECT id, password, password_hash FROM users"):
            if not item["password_hash"]:
                db.execute(
                    "UPDATE users SET password_hash=? WHERE id=?",
                    (hash_password(item["password"]), item["id"]),
                )
        db.execute("UPDATE users SET created_at=? WHERE created_at IS NULL", (now(),))
        if not db.execute("SELECT COUNT(*) FROM flights").fetchone()[0]:
            demo_start = datetime.now(timezone.utc) + timedelta(hours=2)
            flights = [
                ("f1", "CA1832", "B12", demo_start.isoformat(), 7200, 3, "WAITING", 12, 8),
                ("f2", "MU5216", "A06", (demo_start + timedelta(minutes=20)).isoformat(), 5200, 2, "WAITING", 5, 11),
                ("f3", "CZ3148", "C18", (demo_start + timedelta(minutes=35)).isoformat(), 8400, 3, "ASSIGNED", 19, 6),
                ("f4", "HO1179", "D03", (demo_start + timedelta(minutes=55)).isoformat(), 4300, 1, "PLANNED", 23, 16),
                ("f5", "3U8921", "A11", (demo_start + timedelta(minutes=75)).isoformat(), 6100, 2, "WAITING", 7, 4),
            ]
            vehicles = [
                ("v1", "JF-01", "李昊", 14300, 18000, "AVAILABLE", 3, 6, now()),
                ("v2", "JF-03", "周敏", 9800, 14000, "AVAILABLE", 16, 12, now()),
                ("v3", "JF-05", "陈跃", 12100, 16000, "WORKING", 10, 10, now()),
                ("v4", "JF-08", "王超", 3900, 12000, "AVAILABLE", 21, 4, now()),
                ("v5", "JF-12", "刘倩", 15400, 18000, "MAINTENANCE", 2, 19, now()),
            ]
            db.executemany("INSERT INTO flights (id,flight_no,gate,departure_at,fuel_needed,priority,status,x,y) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", flights)
            db.executemany("INSERT INTO vehicles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", vehicles)
            db.execute(
                """INSERT INTO tasks
                   (id, flight_id, vehicle_id, state, locked, eta_minutes, dispatch_order, created_at, updated_at, fuel_requested)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                ("t-seeded", "f3", "v3", "IN_PROGRESS", 0, 8, 0, now(), now(), 8400),
            )
        seeded_users = [
            ("dispatcher", "dispatch01", "dispatch123", "张宁", "DISPATCHER", None, "D001", None),
            ("admin", "admin01", "admin123", "系统管理员", "ADMIN", None, "A001", None),
            ("driver-v1", "driver01", "driver123", "李昊", "DRIVER", "v1", "V001", "ON_DUTY"),
            ("driver-v2", "driver02", "driver123", "周敏", "DRIVER", "v2", "V002", "ON_DUTY"),
            ("driver-v3", "driver03", "driver123", "陈跃", "DRIVER", "v3", "V003", "ON_DUTY"),
        ]
        db.executemany(
            """INSERT OR IGNORE INTO users
               (id, username, password, display_name, role, vehicle_id, emp_no, phone,
                account_status, work_status, password_hash, must_change, created_at)
               VALUES (?, ?, '', ?, ?, ?, ?, NULL, 'ENABLED', ?, ?, 0, ?)""",
            [(uid, uname, name, role, veh, emp, work, hash_password(pwd), now())
             for uid, uname, pwd, name, role, veh, emp, work in seeded_users],
        )
        db.executemany(
            "UPDATE users SET username=?, password=? WHERE id=?",
            [
                ("dispatch01", "dispatch123", "dispatcher"), ("admin01", "admin123", "admin"),
                ("driver01", "driver123", "driver-v1"), ("driver02", "driver123", "driver-v2"),
                ("driver03", "driver123", "driver-v3"),
            ],
        )
        # Backfill personnel metadata for databases created before this feature.
        db.executemany(
            "UPDATE users SET emp_no=?, work_status=? WHERE id=? AND emp_no IS NULL",
            [(emp, work, uid) for uid, _u, _p, _n, _r, _v, emp, work in seeded_users],
        )
        for driver_user, name in (("driver-v1", "李昊"), ("driver-v2", "周敏"), ("driver-v3", "陈跃")):
            db.execute(
                "UPDATE vehicles SET driver=? WHERE id=(SELECT vehicle_id FROM users WHERE id=?) AND (driver IS NULL OR driver='')",
                (name, driver_user),
            )
        # Give pre-existing prototype tasks an initial visible queue order once.
        # Later restarts preserve all manually adjusted orders.
        pending = rows(
            db,
            """SELECT t.id, t.dispatch_order FROM tasks t JOIN flights f ON f.id=t.flight_id
               WHERE t.state='PENDING' ORDER BY f.priority DESC, f.departure_at ASC""",
        )
        if pending and not any(item["dispatch_order"] for item in pending):
            for position, item in enumerate(pending, start=1):
                db.execute("UPDATE tasks SET dispatch_order=? WHERE id=?", (position, item["id"]))


def rows(db: sqlite3.Connection, sql: str, params: tuple = ()) -> list[dict]:
    return [dict(row) for row in db.execute(sql, params).fetchall()]


def broadcast(
    db: sqlite3.Connection, level: str, title: str, content: str,
    flight_id: str | None = None, source: str = "SYSTEM",
) -> None:
    db.execute(
        """INSERT INTO broadcasts (id, level, title, content, flight_id, source, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (str(uuid.uuid4()), level, title, content, flight_id, source, now()),
    )


def check_low_fuel(db: sqlite3.Connection, vehicle_id: str) -> None:
    """Surface a refuelling alert once per vehicle while it stays below the threshold."""
    vehicle = db.execute("SELECT * FROM vehicles WHERE id=?", (vehicle_id,)).fetchone()
    if not vehicle or vehicle["fuel_level"] * 5 >= vehicle["capacity"]:
        return
    level = "CRITICAL" if vehicle["fuel_level"] == 0 else "WARNING"
    message = (
        f"{vehicle['code']} 剩余油量 {vehicle['fuel_level']:,} L，低于安全阈值"
        f"（容量的 {int(LOW_FUEL_RATIO * 100)}%），已暂停自动派工，请安排补油"
    )
    if alert(db, level, "VEHICLE_LOW_FUEL", message, vehicle["id"]):
        broadcast(db, level, "加油车油量告警", message)


def alert(db: sqlite3.Connection, level: str, kind: str, message: str, related_id: str | None = None) -> bool:
    existing = db.execute(
        "SELECT 1 FROM alerts WHERE type=? AND related_id IS ? AND resolved=0 LIMIT 1",
        (kind, related_id),
    ).fetchone()
    if existing:
        return False
    db.execute(
        """INSERT INTO alerts (id, level, type, message, related_id, resolved, created_at)
           VALUES (?, ?, ?, ?, ?, 0, ?)""",
        (str(uuid.uuid4()), level, kind, message, related_id, now()),
    )
    return True


def time_assessment(flight: dict | sqlite3.Row, eta: int = 0, state: str = "PENDING") -> dict:
    estimated = datetime.now(timezone.utc) + timedelta(minutes=(0 if state == "IN_PROGRESS" else eta) + SERVICE_MINUTES)
    try:
        departure = datetime.fromisoformat(flight["departure_at"])
        if departure.tzinfo is None:
            raise ValueError("missing timezone")
        deadline = departure - timedelta(minutes=DEPARTURE_BUFFER_MINUTES)
        risk = "预计无法在保障截止时间前完成，请调度确认" if estimated > deadline else None
        return {"timeRisk": risk, "estimatedCompletionAt": estimated.isoformat(timespec="seconds"),
                "deadlineAt": deadline.isoformat(timespec="seconds"), "serviceMinutes": SERVICE_MINUTES}
    except (TypeError, ValueError):
        return {"timeRisk": "离港时间无效，请先修正航班计划", "estimatedCompletionAt": None,
                "deadlineAt": None, "serviceMinutes": SERVICE_MINUTES}


def release_vehicle(db: sqlite3.Connection, vehicle_id: str | None) -> None:
    db.execute(
        """UPDATE vehicles SET status='AVAILABLE', updated_at=? WHERE id=? AND status IN ('RESERVED','WORKING')
           AND NOT EXISTS (SELECT 1 FROM tasks WHERE vehicle_id=? AND state IN ('PENDING','IN_PROGRESS','AWAITING_REVIEW'))""",
        (now(), vehicle_id, vehicle_id),
    )


def reconcile_alerts(db: sqlite3.Connection) -> None:
    for item in rows(db, "SELECT * FROM alerts WHERE resolved=0"):
        kind, identifier = item["type"], item["related_id"]
        resolved = False
        if kind == "NO_ELIGIBLE_VEHICLE":
            flight = db.execute("SELECT status FROM flights WHERE id=?", (identifier,)).fetchone()
            resolved = flight is None or flight["status"] in {"COMPLETED", "CANCELLED", "DEPARTING"} or bool(db.execute(
                "SELECT 1 FROM tasks WHERE flight_id=? AND state IN ('PENDING','IN_PROGRESS')", (identifier,)
            ).fetchone())
        elif kind == "VEHICLE_LOW_FUEL":
            vehicle = db.execute("SELECT fuel_level,capacity FROM vehicles WHERE id=?", (identifier,)).fetchone()
            resolved = vehicle is not None and vehicle["fuel_level"] * 5 >= vehicle["capacity"]
        elif kind == "PARTIAL_FUEL_REVIEW":
            task = db.execute("SELECT state FROM tasks WHERE id=?", (identifier,)).fetchone()
            resolved = task is not None and task["state"] != "AWAITING_REVIEW"
        elif kind == "VEHICLE_EXCEPTION":
            vehicle = db.execute("SELECT v.status FROM tasks t JOIN vehicles v ON v.id=t.vehicle_id WHERE t.id=?", (identifier,)).fetchone()
            resolved = vehicle is not None and vehicle["status"] != "MAINTENANCE"
        elif kind == "TIME_WINDOW":
            task = db.execute(
                """SELECT t.state,t.eta_minutes,f.departure_at FROM tasks t JOIN flights f ON f.id=t.flight_id
                   WHERE t.flight_id=? AND t.state IN ('PENDING','IN_PROGRESS') LIMIT 1""", (identifier,),
            ).fetchone()
            flight = db.execute("SELECT status FROM flights WHERE id=?", (identifier,)).fetchone()
            resolved = flight is None or flight["status"] in {"COMPLETED", "CANCELLED", "DEPARTING"}
            if task:
                resolved = not time_assessment(task, task["eta_minutes"] or 0, task["state"])["timeRisk"]
        if resolved:
            db.execute("UPDATE alerts SET resolved=1,resolution='系统复核：关联风险条件已解除',resolved_at=? WHERE id=?", (now(), item["id"]))


def update_time_alerts(db: sqlite3.Connection) -> None:
    for task in rows(db, """SELECT t.state,t.eta_minutes,f.* FROM tasks t JOIN flights f ON f.id=t.flight_id
                            WHERE t.state IN ('PENDING','IN_PROGRESS')"""):
        assessment = time_assessment(task, task["eta_minutes"] or 0, task["state"])
        if assessment["timeRisk"]:
            alert(db, "CRITICAL", "TIME_WINDOW", f"{task['flight_no']} {assessment['timeRisk']}（作业估计 {SERVICE_MINUTES} 分钟）", task["id"])
    reconcile_alerts(db)


class Scheduler:
    """Constraint-aware, deterministic fallback scheduler.

    Scoring favours higher-priority flights, then nearby vehicles.  Eligibility
    enforces the two safety constraints defined in the SRS: enough fuel for the
    job and an operational vehicle.  Manual locks are never changed.
    """

    @staticmethod
    def optimize(db: sqlite3.Connection) -> dict:
        # PLANNED flights (e.g. just imported) are part of the dispatch queue;
        # only a flight with an active task is excluded.
        waiting = rows(
            db,
            """SELECT f.*, f.fuel_needed-f.fuel_delivered fuel_remaining FROM flights f
               WHERE f.status IN ('PLANNED','WAITING') AND NOT EXISTS
               (SELECT 1 FROM tasks t WHERE t.flight_id=f.id AND t.state IN ('PENDING','IN_PROGRESS','AWAITING_REVIEW'))
               ORDER BY f.priority DESC, f.departure_at ASC""",
        )
        fleet = rows(
            db,
            """SELECT v.*, u.id driver_user_id, u.display_name driver_name, u.emp_no driver_emp_no
               FROM vehicles v JOIN users u ON u.vehicle_id = v.id
               WHERE v.status = 'AVAILABLE' AND u.role = 'DRIVER'
                 AND u.work_status = 'ON_DUTY' AND u.account_status = 'ENABLED'
                 AND v.fuel_level * 5 >= v.capacity
                 AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.vehicle_id=v.id
                                 AND t.state IN ('PENDING','IN_PROGRESS','AWAITING_REVIEW'))
               ORDER BY v.code""",
        )
        assignments, risks = [], []
        for flight in waiting:
            if flight["fuel_remaining"] <= 0:
                continue
            try:
                departure = datetime.fromisoformat(flight["departure_at"])
                if departure.tzinfo is None or departure <= datetime.now(timezone.utc):
                    continue
            except (TypeError, ValueError):
                continue
            eligible = [vehicle for vehicle in fleet if vehicle["fuel_level"] >= flight["fuel_remaining"]]
            if not eligible:
                message = f"{flight['flight_no']} 无满足油量约束的可用加油车，需人工处置"
                if alert(db, "CRITICAL", "NO_ELIGIBLE_VEHICLE", message, flight["id"]):
                    broadcast(db, "CRITICAL", "保障资源告警", message, flight["id"])
                risks.append(message)
                continue
            vehicle = min(
                eligible,
                key=lambda item: abs(item["x"] - flight["x"]) + abs(item["y"] - flight["y"]),
            )
            distance = abs(vehicle["x"] - flight["x"]) + abs(vehicle["y"] - flight["y"])
            eta = max(4, distance * 2 + 3)
            task_id = str(uuid.uuid4())
            next_order = db.execute(
                "SELECT COALESCE(MAX(dispatch_order), 0) + 1 FROM tasks WHERE state='PENDING'"
            ).fetchone()[0]
            db.execute(
                """INSERT INTO tasks
                   (id, flight_id, vehicle_id, state, locked, eta_minutes, dispatch_order, created_at, updated_at, assigned_driver, fuel_requested)
                   VALUES (?, ?, ?, 'PENDING', 0, ?, ?, ?, ?, ?, ?)""",
                (task_id, flight["id"], vehicle["id"], eta, next_order, now(), now(), vehicle["driver_name"], flight["fuel_remaining"]),
            )
            db.execute("UPDATE flights SET status='ASSIGNED' WHERE id=?", (flight["id"],))
            db.execute(
                """UPDATE alerts SET resolved=1, resolution='已分配满足油量约束的人员与车辆', resolved_at=?
                   WHERE type='NO_ELIGIBLE_VEHICLE' AND related_id=? AND resolved=0""",
                (now(), flight["id"]),
            )
            db.execute(
                "UPDATE vehicles SET status='RESERVED', updated_at=? WHERE id=?",
                (now(), vehicle["id"]),
            )
            fleet = [item for item in fleet if item["id"] != vehicle["id"]]
            assignments.append({"taskId": task_id, "flight": flight["flight_no"], "vehicle": vehicle["code"], "etaMinutes": eta})
        # Idle vehicles left below the safety threshold surface as alerts so the
        # dispatcher can arrange refuelling instead of silently losing capacity.
        for vehicle in rows(db, "SELECT id FROM vehicles WHERE status='AVAILABLE' AND fuel_level * 5 < capacity"):
            check_low_fuel(db, vehicle["id"])
        update_time_alerts(db)
        return {"assignments": assignments, "risks": risks}


def overview(db: sqlite3.Connection) -> dict:
    active = rows(
        db,
        """SELECT t.id, t.state, t.locked, t.eta_minutes, t.dispatch_order, t.updated_at, t.assigned_driver,
                  t.fuel_loaded,t.reason,COALESCE(t.fuel_requested,f.fuel_needed) fuel_needed,
                  f.fuel_needed-f.fuel_delivered remaining_fuel,
                  f.id flight_id, f.flight_no, f.gate, f.departure_at, f.priority,
                  v.id vehicle_id, v.code vehicle_code, COALESCE(t.assigned_driver, v.driver) driver
           FROM tasks t JOIN flights f ON f.id=t.flight_id
           LEFT JOIN vehicles v ON v.id=t.vehicle_id
           WHERE t.state != 'CANCELLED'
           ORDER BY CASE WHEN t.state='PENDING' THEN 0 ELSE 1 END,
                    CASE WHEN t.dispatch_order=0 THEN 999999 ELSE t.dispatch_order END,
                    f.priority DESC, f.departure_at ASC""",
    )
    for task in active:
        task.update(time_assessment(task, task["eta_minutes"] or 0, task["state"]) if task["state"] in {"PENDING", "IN_PROGRESS"}
                    else {"timeRisk": None, "estimatedCompletionAt": None})
        if task["state"] == "COMPLETED" and task["fuel_loaded"] is None:
            task["remaining_fuel"] = None
    vehicles = rows(db, "SELECT * FROM vehicles ORDER BY code")
    flights = rows(db, "SELECT *,fuel_needed-fuel_delivered fuel_remaining FROM flights ORDER BY departure_at")
    active_flights = {task["flight_id"] for task in active if task["state"] in {"PENDING", "IN_PROGRESS", "AWAITING_REVIEW"}}
    for flight in flights:
        if flight["status"] == "COMPLETED" and db.execute(
            "SELECT 1 FROM tasks WHERE flight_id=? AND state='COMPLETED' AND fuel_loaded IS NULL", (flight["id"],)
        ).fetchone():
            flight["fuel_remaining"] = None
        try:
            departure = datetime.fromisoformat(flight["departure_at"])
            flight["archived"] = flight["status"] in {"COMPLETED", "CANCELLED", "DEPARTING"} or (
                departure.tzinfo is not None and departure < datetime.now(timezone.utc) and flight["id"] not in active_flights
            )
        except (TypeError, ValueError):
            flight["archived"] = False
    alerts = rows(db, "SELECT * FROM alerts WHERE resolved=0 ORDER BY created_at DESC LIMIT 10")
    for item in alerts:
        item["status"] = "ACKNOWLEDGED" if item["acknowledged_at"] else "OPEN"
    broadcasts = rows(db, "SELECT * FROM broadcasts ORDER BY created_at DESC LIMIT 12")
    stats = {
        "waiting": sum(f["status"] in {"PLANNED", "WAITING"} and not f["archived"] for f in flights),
        "activeTasks": sum(t["state"] in {"PENDING", "IN_PROGRESS", "AWAITING_REVIEW"} for t in active),
        "availableVehicles": sum(v["status"] == "AVAILABLE" for v in vehicles),
        "criticalAlerts": sum(a["level"] == "CRITICAL" for a in alerts),
        "vehicleUtilization": round(100 * sum(v["status"] in {"RESERVED", "WORKING"} for v in vehicles) / max(1, len(vehicles))),
        "onTimeRate": None,
    }
    recent_resolutions = rows(
        db,
        """SELECT * FROM alerts WHERE resolved=1 AND resolved_at IS NOT NULL
           ORDER BY resolved_at DESC LIMIT 5""",
    )
    personnel = rows(
        db,
        """SELECT u.id, u.emp_no, u.username, u.display_name, u.role, u.work_status,
                  u.account_status, u.vehicle_id, u.phone, u.created_at,
                  v.code vehicle_code, v.status vehicle_status, v.x vehicle_x, v.y vehicle_y
           FROM users u LEFT JOIN vehicles v ON v.id = u.vehicle_id
           WHERE u.role IN ('DISPATCHER', 'DRIVER') AND u.account_status = 'ENABLED'
           ORDER BY CASE u.role WHEN 'DISPATCHER' THEN 0 ELSE 1 END, u.emp_no""",
    )
    for member in personnel:
        member["current_task"] = None
        if member["role"] == "DRIVER":
            member["location"] = (
                {"name": f"随车 {member['vehicle_code']}", "x": member["vehicle_x"], "y": member["vehicle_y"]}
                if member["vehicle_id"] else dict(STANDBY_POINT)
            )
        if member["role"] == "DRIVER" and member["vehicle_id"]:
            current_task = db.execute(
                """SELECT t.state, f.flight_no, f.gate FROM tasks t JOIN flights f ON f.id = t.flight_id
                   WHERE t.vehicle_id = ? AND t.state IN ('PENDING', 'IN_PROGRESS', 'AWAITING_REVIEW')
                   ORDER BY CASE t.state WHEN 'IN_PROGRESS' THEN 0 ELSE 1 END,
                            CASE WHEN t.dispatch_order = 0 THEN 999999 ELSE t.dispatch_order END
                   LIMIT 1""",
                (member["vehicle_id"],),
            ).fetchone()
            member["current_task"] = dict(current_task) if current_task else None
    personnel_counts = {
        "onDuty": sum(p["role"] == "DRIVER" and p["work_status"] == "ON_DUTY" for p in personnel),
        "standby": sum(p["role"] == "DRIVER" and p["work_status"] == "STANDBY" for p in personnel),
        "resting": sum(p["role"] == "DRIVER" and p["work_status"] == "RESTING" for p in personnel),
    }
    return {
        "stats": stats, "tasks": active, "vehicles": vehicles, "flights": flights,
        "alerts": alerts, "broadcasts": broadcasts, "recentResolutions": recent_resolutions,
        "personnel": personnel, "personnelCounts": personnel_counts,
        "refuelPoint": REFUEL_POINT, "standbyPoint": STANDBY_POINT, "locationMode": "SCHEMATIC",
        "timeModel": {"serviceMinutes": SERVICE_MINUTES, "departureBufferMinutes": DEPARTURE_BUFFER_MINUTES, "mode": "SCHEMATIC"},
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "FuelDispatch/0.1"

    def log_message(self, format: str, *args: object) -> None:
        return

    def _send(self, payload: object, status: HTTPStatus = HTTPStatus.OK) -> None:
        data = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
        if getattr(self, "_buffer_response", False):
            self._pending_response = (data, status)
            return
        self._write_response(data, status)

    def _write_response(self, data: bytes, status: HTTPStatus) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Idempotency-Key, Authorization")
        self.end_headers()
        self.wfile.write(data)

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        try:
            return json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError as exc:
            raise ValueError("请求体必须是 JSON") from exc

    def do_OPTIONS(self) -> None:
        self._send({"ok": True})

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        try:
            if path == "/api/health":
                self._send({"status": "ok", "time": now(), "scheduler": "greedy-v1"})
                return
            with connect() as db:
                if path == "/api/overview":
                    self._authorize(db, "DISPATCHER", "ADMIN")
                    self._send(overview(db))
                    return
                if path.startswith("/api/alerts/") and path.endswith("/recommendations"):
                    self._authorize(db, "DISPATCHER")
                    self._send(self._alert_recommendations(db, path.split("/")[3]))
                    return
                if path.startswith("/api/tasks/") and path.endswith("/candidates"):
                    self._authorize(db, "DISPATCHER")
                    self._send(self._task_candidates(db, path.split("/")[3]))
                    return
                if path == "/api/driver/tasks":
                    user = self._authorize(db, "DRIVER")
                    self._send(self._driver_tasks(db, user))
                    return
                if path == "/api/admin/flights":
                    self._authorize(db, "DISPATCHER")
                    self._send({"flights": rows(db, "SELECT * FROM flights ORDER BY departure_at")})
                    return
                if path == "/api/admin/personnel":
                    self._authorize(db, "ADMIN")
                    params = parse_qs(urlparse(self.path).query)
                    self._send({"personnel": self._list_personnel(db, params)})
                    return
            self._send({"error": "未找到资源"}, HTTPStatus.NOT_FOUND)
        except PermissionError as exc:
            self._send({"error": str(exc), "code": getattr(exc, "code", "FORBIDDEN")},
                       getattr(exc, "status", HTTPStatus.FORBIDDEN))
        except ValueError as exc:
            self._send({"error": str(exc)}, HTTPStatus.UNPROCESSABLE_ENTITY)

    def do_POST(self) -> None:
        self._pending_response = None
        self._buffer_response = True
        try:
            self._handle_post()
            response = self._pending_response
        finally:
            self._buffer_response = False
            self._pending_response = None
        if response is not None:
            self._write_response(*response)

    def _handle_post(self) -> None:
        path = urlparse(self.path).path
        try:
            payload = self._body()
            with connect() as db:
                # Keep resource checks and their writes in one serial transaction.
                db.execute("BEGIN IMMEDIATE")
                if path == "/api/auth/login":
                    self._login(db, payload)
                    return
                if path == "/api/auth/logout":
                    token = self.headers.get("Authorization", "").removeprefix("Bearer ").strip()
                    db.execute("DELETE FROM sessions WHERE token=?", (token,))
                    self._send({"message": "已退出登录"})
                    return
                if path == "/api/dispatch/optimize":
                    self._authorize(db, "DISPATCHER")
                    result = Scheduler.optimize(db)
                    if result["assignments"]:
                        broadcast(db, "INFO", "智能调度方案已更新", f"已为 {len(result['assignments'])} 个航班生成或更新保障安排。")
                    self._send({"message": "调度方案已生成", **result, "overview": overview(db)})
                    return
                if path == "/api/events":
                    self._authorize(db, "DISPATCHER", "ADMIN")
                    self._event(db, payload)
                    return
                if path.startswith("/api/tasks/") and path.endswith("/progress"):
                    self._progress(db, path.split("/")[3], payload, self._authorize(db, "DRIVER"))
                    return
                if path.startswith("/api/tasks/") and path.endswith("/override"):
                    actor = self._authorize(db, "DISPATCHER")
                    self._override(db, path.split("/")[3], payload, actor)
                    return
                if path.startswith("/api/tasks/") and path.endswith("/followup"):
                    actor = self._authorize(db, "DISPATCHER")
                    self._confirm_followup(db, path.split("/")[3], payload, actor)
                    return
                if path.startswith("/api/alerts/") and path.endswith("/resolve"):
                    actor = self._authorize(db, "DISPATCHER")
                    self._resolve_alert(db, path.split("/")[3], payload, actor)
                    return
                if path.startswith("/api/vehicles/") and path.endswith("/refuel"):
                    dispatcher = self._authorize(db, "DISPATCHER")
                    self._refuel_vehicle(db, path.split("/")[3], payload, dispatcher)
                    return
                if path == "/api/admin/flights/import":
                    self._authorize(db, "DISPATCHER")
                    self._import_flights(db, payload)
                    return
                if path.startswith("/api/flights/") and path.count("/") == 3:
                    dispatcher = self._authorize(db, "DISPATCHER")
                    self._update_flight(db, path.split("/")[3], payload, dispatcher)
                    return
                if path == "/api/auth/change-password":
                    user = self._authorize(db, "DISPATCHER", "DRIVER", "ADMIN")
                    self._change_password(db, payload, user)
                    return
                if path == "/api/admin/personnel":
                    user = self._authorize(db, "ADMIN")
                    self._create_personnel(db, payload, user)
                    return
                if path.startswith("/api/admin/personnel/"):
                    user = self._authorize(db, "ADMIN")
                    parts = path.split("/")
                    person_id = parts[4]
                    action = parts[5] if len(parts) > 5 else ""
                    if action == "reset-password":
                        self._reset_password(db, person_id, user)
                    elif action == "disable":
                        self._set_account_status(db, person_id, False, user)
                    elif action == "enable":
                        self._set_account_status(db, person_id, True, user)
                    elif action == "profile":
                        self._update_personnel(db, person_id, payload, user)
                    else:
                        self._send({"error": "未找到资源"}, HTTPStatus.NOT_FOUND)
                    return
                if path.startswith("/api/dispatch/personnel/"):
                    actor = self._authorize(db, "DISPATCHER")
                    parts = path.split("/")
                    person_id = parts[4]
                    action = parts[5] if len(parts) > 5 else ""
                    if action == "status":
                        self._set_work_status(db, person_id, payload, actor)
                    elif action == "call":
                        self._call_driver(db, person_id, payload, actor)
                    elif action == "vehicle":
                        self._rebind_driver_vehicle(db, person_id, payload, actor)
                    else:
                        self._send({"error": "未找到资源"}, HTTPStatus.NOT_FOUND)
                    return
            self._send({"error": "未找到资源"}, HTTPStatus.NOT_FOUND)
        except ValueError as exc:
            self._send({"error": str(exc)}, HTTPStatus.UNPROCESSABLE_ENTITY)
        except PermissionError as exc:
            self._send({"error": str(exc), "code": getattr(exc, "code", "FORBIDDEN")},
                       getattr(exc, "status", HTTPStatus.FORBIDDEN))
        except sqlite3.Error:
            self._send({"error": "数据处理失败，请稍后重试"}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def _authorize(self, db: sqlite3.Connection, *roles: str) -> sqlite3.Row:
        authorization = self.headers.get("Authorization", "")
        token = authorization.removeprefix("Bearer ").strip()
        user = db.execute(
            "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?",
            (token,),
        ).fetchone()
        if not token or not user:
            raise AccessError("登录已失效，请重新登录。", "SESSION_EXPIRED", HTTPStatus.UNAUTHORIZED)
        if user["account_status"] != "ENABLED":
            raise AccessError("账号已被停用，请联系系统管理员。", "SESSION_EXPIRED", HTTPStatus.UNAUTHORIZED)
        if user["must_change"] and urlparse(self.path).path != "/api/auth/change-password":
            raise AccessError("请先修改初始密码，再使用工作台。", "PASSWORD_CHANGE_REQUIRED")
        if user["role"] not in roles:
            raise PermissionError("当前角色无权执行此操作。")
        return user

    def _login(self, db: sqlite3.Connection, payload: dict) -> None:
        username, password = str(payload.get("username", "")).strip(), payload.get("password")
        user = db.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
        if not user or not verify_password(str(password or ""), user["password_hash"]):
            raise ValueError("账号或密码错误")
        if user["account_status"] != "ENABLED":
            raise ValueError("账号已被停用，请联系系统管理员")
        token = str(uuid.uuid4())
        db.execute("INSERT INTO sessions VALUES (?, ?, ?)", (token, user["id"], now()))
        self._send({"user": self._public_user(user, token), "message": "登录成功"})

    def _change_password(self, db: sqlite3.Connection, payload: dict, user: sqlite3.Row) -> None:
        old_password = str(payload.get("oldPassword", ""))
        new_password = str(payload.get("newPassword", ""))
        fresh = db.execute("SELECT * FROM users WHERE id=?", (user["id"],)).fetchone()
        if not verify_password(old_password, fresh["password_hash"]):
            raise ValueError("当前密码不正确")
        if old_password == new_password:
            raise ValueError("新密码必须与当前密码不同")
        check_password_strength(new_password)
        db.execute(
            "UPDATE users SET password_hash=?, must_change=0 WHERE id=?",
            (hash_password(new_password), user["id"]),
        )
        db.execute("DELETE FROM sessions WHERE user_id=?", (user["id"],))
        token = str(uuid.uuid4())
        db.execute("INSERT INTO sessions VALUES (?, ?, ?)", (token, user["id"], now()))
        log_operation(db, fresh, "修改密码", "人员账号", fresh["id"], fresh["display_name"])
        updated = db.execute("SELECT * FROM users WHERE id=?", (user["id"],)).fetchone()
        self._send({"message": "密码已更新，其他登录会话已退出", "user": self._public_user(updated, token)})

    @staticmethod
    def _public_user(user: sqlite3.Row, token: str | None = None) -> dict:
        return {
            "id": user["id"], "username": user["username"], "display_name": user["display_name"],
            "role": user["role"], "vehicle_id": user["vehicle_id"], "emp_no": user["emp_no"],
            "work_status": user["work_status"], "must_change": bool(user["must_change"]),
            **({"token": token} if token else {}),
        }

    def _driver_tasks(self, db: sqlite3.Connection, user: sqlite3.Row) -> dict:
        vehicle = None
        if user["vehicle_id"]:
            vehicle = db.execute("SELECT * FROM vehicles WHERE id=?", (user["vehicle_id"],)).fetchone()
        eligible = (
            user["account_status"] == "ENABLED"
            and user["work_status"] == "ON_DUTY"
            and vehicle is not None
        )
        tasks = rows(
            db,
            """SELECT t.id, t.state, t.eta_minutes, t.dispatch_order, t.updated_at,
                      t.fuel_loaded,t.reason,COALESCE(t.fuel_requested,f.fuel_needed) fuel_needed,
                      f.fuel_needed-f.fuel_delivered remaining_fuel,
                      f.flight_no, f.gate, f.priority,f.departure_at,
                      v.code vehicle_code, v.fuel_level, v.capacity
               FROM tasks t JOIN flights f ON f.id=t.flight_id JOIN vehicles v ON v.id=t.vehicle_id
               WHERE t.vehicle_id=? AND t.state IN ('PENDING','IN_PROGRESS','AWAITING_REVIEW')
               ORDER BY CASE WHEN t.state='IN_PROGRESS' THEN 0 ELSE 1 END,
                        CASE WHEN t.dispatch_order=0 THEN 999999 ELSE t.dispatch_order END,
                        f.priority DESC, f.departure_at ASC""",
            (user["vehicle_id"],),
        ) if eligible else []
        for task in tasks:
            task.update(time_assessment(task, task["eta_minutes"] or 0, task["state"]) if task["state"] != "AWAITING_REVIEW"
                        else {"timeRisk": None, "estimatedCompletionAt": None})
        return {
            "tasks": tasks,
            "driver": {
                "work_status": user["work_status"],
                "account_status": user["account_status"],
                "vehicle": dict(vehicle) if vehicle else None,
                "eligible": eligible,
            },
        }

    def _event(self, db: sqlite3.Connection, payload: dict) -> None:
        event_id = payload.get("eventId") or self.headers.get("Idempotency-Key")
        flight_id, event_type = payload.get("flightId"), payload.get("type")
        if not event_id or not flight_id or event_type not in EVENT_TYPES:
            raise ValueError("事件需包含 eventId、flightId，以及合法的 type")
        if db.execute("SELECT 1 FROM received_events WHERE id=?", (event_id,)).fetchone():
            self._send({"message": "重复事件已忽略", "duplicate": True})
            return
        flight = db.execute("SELECT * FROM flights WHERE id=?", (flight_id,)).fetchone()
        if not flight:
            raise ValueError("航班不存在")
        if event_type in {"CANCELLED", "DEPARTING"} and db.execute(
            "SELECT 1 FROM tasks WHERE flight_id=? AND state IN ('IN_PROGRESS','AWAITING_REVIEW')", (flight_id,)
        ).fetchone():
            raise ValueError("航班仍有作业中或差额待确认工单，请先完成现场交接")
        db.execute("INSERT INTO received_events VALUES (?, ?)", (event_id, now()))
        statuses = {"ARRIVED": "WAITING", "DELAYED": "WAITING", "CANCELLED": "CANCELLED", "DEPARTING": "DEPARTING"}
        if event_type in {"CANCELLED", "DEPARTING"} or flight["status"] in {"PLANNED", "WAITING"}:
            db.execute("UPDATE flights SET status=? WHERE id=?", (statuses[event_type], flight_id))
        if event_type in {"CANCELLED", "DEPARTING"}:
            cancelled = rows(db, "SELECT vehicle_id FROM tasks WHERE flight_id=? AND state='PENDING'", (flight_id,))
            db.execute("UPDATE tasks SET state='CANCELLED', updated_at=? WHERE flight_id=? AND state='PENDING'", (now(), flight_id))
            for item in cancelled:
                release_vehicle(db, item["vehicle_id"])
        broadcast_messages = {
            "ARRIVED": ("INFO", "航班已到位", f"{flight['flight_no']} 已到达 {flight['gate']} 机位，系统正在评估保障安排。"),
            "DELAYED": ("WARNING", "航班计划发生延误", f"{flight['flight_no']} 的运行计划已更新为延误，请核对保障时序。"),
            "CANCELLED": ("WARNING", "航班已取消", f"{flight['flight_no']} 已取消，相关待执行保障工单已撤销。"),
            "DEPARTING": ("INFO", "航班进入离港阶段", f"{flight['flight_no']} 正在离港，请确认保障状态已闭环。"),
        }
        level, title, content = broadcast_messages[event_type]
        broadcast(db, level, title, content, flight_id)
        result = Scheduler.optimize(db)
        self._send({"message": "航班事件已接收并完成增量重调度", **result, "overview": overview(db)})

    def _progress(self, db: sqlite3.Connection, task_id: str, payload: dict, user: sqlite3.Row) -> None:
        state, reason = payload.get("state"), payload.get("reason", "")
        if not isinstance(reason, str):
            raise ValueError("原因必须填写为文本")
        reason = reason.strip()
        task = db.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        if not task:
            raise ValueError("工单不存在")
        if task["vehicle_id"] != user["vehicle_id"]:
            raise PermissionError("只能更新分配给自己的工单")
        if user["account_status"] != "ENABLED" or user["work_status"] != "ON_DUTY":
            raise PermissionError("当前账号状态不允许操作工单，请联系调度人员或系统管理员")
        if state not in TASK_TRANSITIONS.get(task["state"], set()):
            raise ValueError(f"不允许从 {task['state']} 变更为 {state}")
        if state == "EXCEPTION" and not reason:
            raise ValueError("异常上报必须填写原因")
        flight = db.execute("SELECT * FROM flights WHERE id=?", (task["flight_id"],)).fetchone()
        vehicle = db.execute("SELECT * FROM vehicles WHERE id=?", (task["vehicle_id"],)).fetchone()
        if state == "IN_PROGRESS" and vehicle["status"] not in {"RESERVED", "AVAILABLE"}:
            raise ValueError("车辆当前不能开始作业，请联系调度人员")
        fuel_loaded = 0
        if state in {"COMPLETED", "AWAITING_REVIEW"}:
            raw_fuel = payload.get("fuelLoaded")
            if isinstance(raw_fuel, bool) or not isinstance(raw_fuel, (str, int)) or not str(raw_fuel).isdigit():
                raise ValueError("必须提交非负整数的本次实际加注量")
            fuel_loaded = int(raw_fuel)
            required = task["fuel_requested"] if task["fuel_requested"] is not None else flight["fuel_needed"] - flight["fuel_delivered"]
            if not 0 <= fuel_loaded <= min(vehicle["fuel_level"], required):
                raise ValueError("实际加注量不可超过车辆当前油量或本次计划量")
            if state == "COMPLETED" and (fuel_loaded <= 0 or fuel_loaded != required):
                raise ValueError("实际量未达到本次计划量，请记录差额并提交调度确认")
            if state == "AWAITING_REVIEW" and (fuel_loaded >= required or len(reason) < 4):
                raise ValueError("差额上报须少于计划量，并填写至少 4 个字的原因")
            db.execute("UPDATE vehicles SET fuel_level=fuel_level-?,updated_at=? WHERE id=?", (fuel_loaded, now(), vehicle["id"]))
            db.execute("UPDATE flights SET fuel_delivered=fuel_delivered+? WHERE id=?", (fuel_loaded, flight["id"]))
            db.execute("UPDATE tasks SET fuel_loaded=?,reason=? WHERE id=?", (fuel_loaded, reason or None, task_id))
        db.execute("UPDATE tasks SET state=?, reason=?, updated_at=? WHERE id=?", (state, reason or None, now(), task_id))
        if state == "AWAITING_REVIEW":
            db.execute("UPDATE vehicles SET status='RESERVED',updated_at=? WHERE id=?", (now(), vehicle["id"]))
            db.execute("UPDATE flights SET status='AWAITING_REVIEW' WHERE id=?", (flight["id"],))
            remaining = flight["fuel_needed"] - flight["fuel_delivered"] - fuel_loaded
            message = f"{flight['flight_no']} 本次加注 {fuel_loaded:,} L，剩余 {remaining:,} L，需调度确认后续保障"
            alert(db, "CRITICAL", "PARTIAL_FUEL_REVIEW", message, task_id)
            broadcast(db, "WARNING", "加注差额待确认", message, flight["id"])
        elif state == "COMPLETED":
            db.execute("UPDATE flights SET status='COMPLETED' WHERE id=?", (flight["id"],))
            release_vehicle(db, vehicle["id"])
            check_low_fuel(db, vehicle["id"])
        elif state == "EXCEPTION":
            db.execute("UPDATE vehicles SET status='MAINTENANCE',updated_at=? WHERE id=?", (now(), vehicle["id"]))
            db.execute("UPDATE flights SET status='WAITING' WHERE id=?", (flight["id"],))
            message = f"工单异常：{reason}"
            if alert(db, "CRITICAL", "VEHICLE_EXCEPTION", message, task_id):
                broadcast(db, "CRITICAL", "加油车现场异常", f"{flight['flight_no']} 保障任务异常：{reason}", flight["id"])
        elif state == "CANCELLED":
            release_vehicle(db, vehicle["id"])
            if flight["status"] not in {"CANCELLED", "DEPARTING", "COMPLETED"}:
                db.execute("UPDATE flights SET status='WAITING' WHERE id=?", (flight["id"],))
        elif state == "IN_PROGRESS":
            db.execute(
                "UPDATE vehicles SET status='WORKING', x=?, y=?, updated_at=? WHERE id=?",
                (flight["x"], flight["y"], now(), task["vehicle_id"]),
            )
        log_operation(db, user, "更新工单进度", "工单", task_id, flight["flight_no"],
                      before=task["state"], after=f"{state} 实际加注={fuel_loaded} L", reason=reason)
        result = Scheduler.optimize(db)
        message = "已记录实际加注量和差额，车辆保持预留，等待调度确认" if state == "AWAITING_REVIEW" else "工单进度已更新"
        self._send({"message": message, **result, "overview": overview(db)})

    def _confirm_followup(self, db: sqlite3.Connection, task_id: str, payload: dict, actor: sqlite3.Row) -> None:
        reason = payload.get("reason", "")
        if not isinstance(reason, str):
            raise ValueError("后续保障说明必须填写为文本")
        reason = reason.strip()
        if len(reason) < 4:
            raise ValueError("请填写至少 4 个字的后续保障说明")
        task = db.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        if not task or task["state"] != "AWAITING_REVIEW":
            raise ValueError("只有差额待确认工单可以确认后续保障")
        db.execute("UPDATE tasks SET state='PARTIAL',updated_at=? WHERE id=?", (now(), task_id))
        db.execute("UPDATE flights SET status='WAITING' WHERE id=?", (task["flight_id"],))
        release_vehicle(db, task["vehicle_id"])
        check_low_fuel(db, task["vehicle_id"])
        log_operation(db, actor, "确认差额后续保障", "工单", task_id, task_id,
                      before="AWAITING_REVIEW", after="PARTIAL 原车释放，按剩余需油量重新调度", reason=reason)
        result = Scheduler.optimize(db)
        self._send({"message": "差额已确认，原车已释放，系统已按剩余需油量重新评估保障", **result, "overview": overview(db)})

    def _task_candidates(self, db: sqlite3.Connection, task_id: str) -> dict:
        task = db.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        if not task or task["state"] != "PENDING":
            raise ValueError("只有待执行工单可以临时分配或更换人员车辆")
        flight = dict(db.execute("SELECT * FROM flights WHERE id=?", (task["flight_id"],)).fetchone())
        flight["fuel_remaining"] = max(0, flight["fuel_needed"] - flight["fuel_delivered"])
        flight["fuel_needed"] = task["fuel_requested"] if task["fuel_requested"] is not None else flight["fuel_needed"] - flight["fuel_delivered"]
        vehicles = rows(db, "SELECT * FROM vehicles ORDER BY code")
        vehicle_by_id = {vehicle["id"]: vehicle for vehicle in vehicles}
        people = rows(db, "SELECT id, display_name, role, account_status, work_status, vehicle_id FROM users")
        owners = {person["vehicle_id"]: person for person in people if person["vehicle_id"]}
        occupied = {
            item["vehicle_id"] for item in rows(
                db, "SELECT vehicle_id FROM tasks WHERE state IN ('PENDING','IN_PROGRESS','AWAITING_REVIEW') AND id != ?", (task_id,),
            )
        }
        drivers = [
            person for person in people
            if person["role"] == "DRIVER" and person["account_status"] == "ENABLED"
            and person["work_status"] in {"ON_DUTY", "STANDBY"}
            and person["vehicle_id"] not in occupied
        ]
        current_driver = owners.get(task["vehicle_id"])
        candidates, excluded = [], []
        for vehicle in vehicles:
            current_vehicle = vehicle["id"] == task["vehicle_id"]
            reasons = []
            if vehicle["status"] != "AVAILABLE" and not (current_vehicle and vehicle["status"] == "RESERVED"):
                reasons.append({"REFUELLING": "车辆正在补油", "MAINTENANCE": "车辆正在维修", "WORKING": "车辆正在作业", "RESERVED": "车辆已被其他任务预留"}.get(vehicle["status"], "车辆当前不可用"))
            if vehicle["id"] in occupied:
                reasons.append("已有其他活动工单或差额待确认工单")
            if vehicle["fuel_level"] < flight["fuel_needed"]:
                reasons.append(f"油量不足，尚缺 {flight['fuel_needed'] - vehicle['fuel_level']:,} L")
            if vehicle["fuel_level"] * 5 < vehicle["capacity"]:
                reasons.append("油量低于容量 20% 的安全阈值")
            if reasons:
                excluded.append({"vehicleId": vehicle["id"], "vehicleCode": vehicle["code"], "reasons": reasons})
                continue
            owner = owners.get(vehicle["id"])
            before_count = len(candidates)
            for driver in drivers:
                same_driver = owner is not None and driver["id"] == owner["id"]
                if owner and not same_driver and not (current_vehicle and driver["work_status"] == "STANDBY"):
                    continue
                if driver["work_status"] == "STANDBY" and driver["vehicle_id"]:
                    continue
                position = vehicle_by_id.get(driver["vehicle_id"], STANDBY_POINT)
                driver_distance = abs(position["x"] - vehicle["x"]) + abs(position["y"] - vehicle["y"])
                distance = driver_distance + abs(vehicle["x"] - flight["x"]) + abs(vehicle["y"] - flight["y"])
                if same_driver and current_vehicle:
                    mode, recommendation = "KEEP", "保留当前人员与车辆"
                elif current_vehicle and owner:
                    mode, recommendation = "REPLACE_DRIVER", "临时调用候命人员，接替当前车辆司机"
                elif driver["work_status"] == "STANDBY":
                    mode, recommendation = "CALL", "临时调用候命人员并安排车辆"
                elif current_driver and driver["id"] == current_driver["id"]:
                    mode, recommendation = "CHANGE_VEHICLE", "原人员更换车辆，待执行工单随车转移"
                else:
                    mode, recommendation = "ASSIGN", "分配空闲值班人员与车辆"
                eta = max(4, distance * 2 + 3)
                candidates.append({
                    "vehicleId": vehicle["id"], "vehicleCode": vehicle["code"],
                    "driverId": driver["id"], "driverName": driver["display_name"],
                    "driverWorkStatus": driver["work_status"], "fuelLevel": vehicle["fuel_level"],
                    "capacity": vehicle["capacity"], "x": vehicle["x"], "y": vehicle["y"],
                    "distance": distance, "driverDistance": driver_distance,
                    "etaMinutes": eta, "temporaryCall": driver["work_status"] == "STANDBY",
                    "mode": mode, "recommendation": recommendation,
                    **time_assessment(flight, eta),
                })
            if len(candidates) == before_count:
                excluded.append({"vehicleId": vehicle["id"], "vehicleCode": vehicle["code"],
                                 "reasons": ["绑定人员不在可调度状态或正在执行其他工单" if owner else "没有可调用的空闲值班或候命人员"]})
        candidates.sort(key=lambda item: (item["distance"], item["temporaryCall"], item["vehicleCode"], item["driverId"]))
        return {"taskId": task_id, "flight": flight, "candidates": candidates, "excluded": excluded, "locationMode": "SCHEMATIC"}

    def _override(self, db: sqlite3.Connection, task_id: str, payload: dict, actor: sqlite3.Row) -> None:
        try:
            requested_order = int(payload.get("dispatchOrder"))
        except (TypeError, ValueError) as exc:
            raise ValueError("执行顺序必须为数字") from exc
        if requested_order < 1:
            raise ValueError("执行顺序必须从 1 开始")
        choice = next((
            item for item in self._task_candidates(db, task_id)["candidates"]
            if item["vehicleId"] == payload.get("vehicleId") and item["driverId"] == payload.get("driverId")
        ), None)
        if not choice:
            raise ValueError("人员或车辆已不可分配，请刷新候选；需满足油量、安全阈值及无任务冲突约束")
        task = db.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        old_vehicle = db.execute("SELECT * FROM vehicles WHERE id=?", (task["vehicle_id"],)).fetchone()
        old_driver = db.execute("SELECT * FROM users WHERE vehicle_id=?", (task["vehicle_id"],)).fetchone()
        driver = db.execute("SELECT * FROM users WHERE id=?", (choice["driverId"],)).fetchone()
        if old_driver and old_driver["id"] != driver["id"]:
            db.execute("UPDATE users SET vehicle_id=NULL, work_status='STANDBY' WHERE id=?", (old_driver["id"],))
            db.execute("UPDATE vehicles SET driver='', updated_at=? WHERE id=?", (now(), old_driver["vehicle_id"]))
        if driver["vehicle_id"] and driver["vehicle_id"] != choice["vehicleId"]:
            self._unbind_vehicle(db, driver)
        db.execute("UPDATE users SET vehicle_id=?, work_status='ON_DUTY' WHERE id=?", (choice["vehicleId"], driver["id"]))
        db.execute(
            "UPDATE vehicles SET driver=?, status='RESERVED', updated_at=? WHERE id=?",
            (driver["display_name"], now(), choice["vehicleId"]),
        )
        db.execute(
            "UPDATE tasks SET vehicle_id=?, locked=1, eta_minutes=?, updated_at=?, assigned_driver=? WHERE id=?",
            (choice["vehicleId"], choice["etaMinutes"], now(), driver["display_name"], task_id),
        )
        if old_vehicle and old_vehicle["id"] != choice["vehicleId"]:
            db.execute(
                """UPDATE vehicles SET status='AVAILABLE', updated_at=? WHERE id=? AND status='RESERVED'
                   AND NOT EXISTS (SELECT 1 FROM tasks WHERE vehicle_id=? AND state IN ('PENDING','IN_PROGRESS','AWAITING_REVIEW'))""",
                (now(), old_vehicle["id"], old_vehicle["id"]),
            )
        self._resequence_tasks(db, task_id, requested_order)
        update_time_alerts(db)
        log_operation(
            db, actor, "临时分配工单", "工单", task_id, task_id,
            before=f"车辆={old_vehicle['code'] if old_vehicle else '无'} 人员={task['assigned_driver'] or '无'}",
            after=f"车辆={choice['vehicleCode']} 人员={driver['display_name']} 顺序={requested_order} 锁定=是",
        )
        self._send({"message": "人员、车辆和待执行工单已完成分配并锁定", "overview": overview(db)})

    def _alert_recommendations(self, db: sqlite3.Connection, alert_id: str) -> dict:
        alert_item = db.execute("SELECT * FROM alerts WHERE id=? AND resolved=0", (alert_id,)).fetchone()
        if not alert_item:
            raise ValueError("风险预警不存在或已处置")
        if alert_item["type"] == "VEHICLE_LOW_FUEL":
            vehicle = db.execute("SELECT * FROM vehicles WHERE id=?", (alert_item["related_id"],)).fetchone()
            return {
                "alert": dict(alert_item),
                "vehicle": dict(vehicle) if vehicle else None,
                "candidates": [],
                "suggestion": "请先安排空闲车辆前往西侧补油点，待现场确认补油完成后恢复油量；有活动工单时须先完成交接。",
            }
        flight = None
        if alert_item["type"] in {"NO_ELIGIBLE_VEHICLE", "TIME_WINDOW"}:
            flight = db.execute("SELECT * FROM flights WHERE id=?", (alert_item["related_id"],)).fetchone()
        elif alert_item["type"] in {"VEHICLE_EXCEPTION", "PARTIAL_FUEL_REVIEW"}:
            flight = db.execute(
                "SELECT f.* FROM tasks t JOIN flights f ON f.id=t.flight_id WHERE t.id=?",
                (alert_item["related_id"],),
            ).fetchone()
        candidates = []
        if flight:
            candidate_rows = rows(
                db,
                """SELECT v.* FROM vehicles v
                   JOIN users u ON u.vehicle_id = v.id
                   WHERE v.fuel_level >= ? AND v.status != 'MAINTENANCE'
                     AND u.work_status = 'ON_DUTY' AND u.account_status = 'ENABLED'
                   ORDER BY CASE v.status WHEN 'AVAILABLE' THEN 0 WHEN 'RESERVED' THEN 1 ELSE 2 END,
                            v.fuel_level DESC""",
                (max(0, flight["fuel_needed"] - flight["fuel_delivered"]),),
            )
            for vehicle in candidate_rows:
                if vehicle["status"] == "AVAILABLE":
                    recommendation = "可立即派出，建议人工改派后锁定工单"
                elif vehicle["status"] == "RESERVED":
                    recommendation = "已预留给其他任务，需评估其当前工单后协调改派"
                else:
                    recommendation = "正在作业，需等待完成或安排替代资源"
                candidates.append({**vehicle, "recommendation": recommendation})
        return {
            "alert": dict(alert_item),
            "flight": dict(flight) if flight else None,
            "candidates": candidates,
        }

    def _resolve_alert(self, db: sqlite3.Connection, alert_id: str, payload: dict, actor: sqlite3.Row) -> None:
        resolution = payload.get("resolution", "")
        if not isinstance(resolution, str):
            raise ValueError("处置说明必须填写为文本")
        resolution = resolution.strip()
        if len(resolution) < 4:
            raise ValueError("请填写至少 4 个字的处置说明，便于交接班追溯")
        result = db.execute(
            """UPDATE alerts SET acknowledged_note=?, acknowledged_at=?, acknowledged_by=?
               WHERE id=? AND resolved=0""",
            (resolution, now(), actor["display_name"], alert_id),
        )
        if not result.rowcount:
            raise ValueError("风险预警不存在或已处置")
        log_operation(db, actor, "确认风险并记录", "预警", alert_id, alert_id, after="ACKNOWLEDGED", reason=resolution)
        self._send({"message": "已确认并记录风险，约束尚未解除；系统将持续跟踪", "overview": overview(db)})

    def _refuel_vehicle(self, db: sqlite3.Connection, vehicle_id: str, payload: dict, dispatcher: sqlite3.Row) -> None:
        vehicle = db.execute("SELECT * FROM vehicles WHERE id=?", (vehicle_id,)).fetchone()
        if not vehicle:
            raise ValueError("车辆不存在")
        action = payload.get("action")
        if action not in {"start", "complete"}:
            raise ValueError("补油操作必须为 start 或 complete")
        active = self._active_vehicle_tasks(db, vehicle_id, "PENDING", "IN_PROGRESS", "AWAITING_REVIEW")
        if active:
            raise ValueError("该车辆名下有待执行或作业中工单，完成作业后才能补油")
        before = f"状态={vehicle['status']} 油量={vehicle['fuel_level']:,}/{vehicle['capacity']:,} L"
        if action == "start":
            if vehicle["status"] != "AVAILABLE":
                raise ValueError("只有空闲可用车辆可以安排补油")
            if vehicle["fuel_level"] >= vehicle["capacity"]:
                raise ValueError("该车辆已满油，无需安排补油")
            db.execute("UPDATE vehicles SET status='REFUELLING', updated_at=? WHERE id=?", (now(), vehicle_id))
            log_operation(db, dispatcher, "安排补油", "加油车", vehicle_id, vehicle["code"],
                          before=before, after=f"状态=REFUELLING 目的地={REFUEL_POINT['name']} 油量未变")
            self._send({"message": f"已安排 {vehicle['code']} 前往{REFUEL_POINT['name']}，请在现场补油完成后确认", "overview": overview(db)})
            return
        if vehicle["status"] != "REFUELLING":
            raise ValueError("只有已安排补油的车辆可以确认补油完成")
        db.execute(
            "UPDATE vehicles SET fuel_level=capacity, status='AVAILABLE', x=?, y=?, updated_at=? WHERE id=?",
            (REFUEL_POINT["x"], REFUEL_POINT["y"], now(), vehicle_id),
        )
        db.execute(
            """UPDATE alerts SET resolved=1, resolution='现场已确认补油完成，车辆恢复满容', resolved_at=?
               WHERE type='VEHICLE_LOW_FUEL' AND related_id=? AND resolved=0""",
            (now(), vehicle_id),
        )
        log_operation(db, dispatcher, "确认补油完成", "加油车", vehicle_id, vehicle["code"],
                      before=before, after=f"状态=AVAILABLE 油量={vehicle['capacity']:,}/{vehicle['capacity']:,} L 位置={REFUEL_POINT['name']}")
        broadcast(db, "INFO", "加油车已完成补油", f"{vehicle['code']} 已在{REFUEL_POINT['name']}完成补油并重新参与调度。")
        result = Scheduler.optimize(db)
        self._send({"message": f"{vehicle['code']} 补油完成，已重新评估调度安排", **result, "overview": overview(db)})

    @staticmethod
    def _resequence_tasks(db: sqlite3.Connection, task_id: str, requested_order: int) -> None:
        """Move one pending job within the dispatcher-visible execution queue."""
        pending = rows(
            db,
            """SELECT id FROM tasks WHERE state='PENDING'
               ORDER BY CASE WHEN dispatch_order=0 THEN 1 ELSE 0 END, dispatch_order, created_at""",
        )
        task_ids = [item["id"] for item in pending]
        if task_id not in task_ids:
            return
        task_ids.remove(task_id)
        task_ids.insert(min(requested_order - 1, len(task_ids)), task_id)
        for position, item_id in enumerate(task_ids, start=1):
            db.execute("UPDATE tasks SET dispatch_order=? WHERE id=?", (position, item_id))

    @staticmethod
    def _validated_flight(db: sqlite3.Connection, payload: dict, existing: sqlite3.Row | None = None) -> dict:
        if not isinstance(payload, dict):
            raise ValueError("航班数据必须为对象")
        old = dict(existing) if existing else {}
        if any(not isinstance(payload.get(source, old.get(key, "")), str)
               for source, key in (("flightNo", "flight_no"), ("gate", "gate"), ("departureAt", "departure_at"))):
            raise ValueError("航班号、机位与离港时间必须为文本且不能为空")
        values = {
            "flight_no": str(payload.get("flightNo", old.get("flight_no", ""))).strip().upper(),
            "gate": str(payload.get("gate", old.get("gate", ""))).strip().upper(),
            "departure_at": str(payload.get("departureAt", old.get("departure_at", ""))).strip(),
        }
        for key, source, default in (("fuel_needed", "fuelNeeded", 0), ("priority", "priority", 1), ("x", "x", 10), ("y", "y", 10)):
            raw = payload.get(source, old.get(key, default))
            if isinstance(raw, bool) or not isinstance(raw, (int, str)) or not re.fullmatch(r"-?[0-9]+", str(raw)):
                raise ValueError("需油量、优先级与机位坐标必须为整数")
            values[key] = int(raw)
        if not values["flight_no"] or not values["gate"] or values["fuel_needed"] <= 0 or values["priority"] not in {1, 2, 3}:
            raise ValueError("航班号、机位不能为空，需油量须为正数，优先级须为 1 至 3")
        try:
            departure = datetime.fromisoformat(values["departure_at"])
            if departure.tzinfo is None:
                raise ValueError("missing timezone")
            values["departure_at"] = departure.astimezone(timezone.utc).isoformat(timespec="seconds")
        except ValueError:
            raise ValueError("时间格式应为带时区的 ISO 8601，例如 2026-11-03T08:00:00+08:00")
        if existing and values["fuel_needed"] != existing["fuel_needed"]:
            active = db.execute(
                "SELECT 1 FROM tasks WHERE flight_id=? AND state IN ('PENDING','IN_PROGRESS','AWAITING_REVIEW')", (existing["id"],)
            ).fetchone()
            if active or existing["fuel_delivered"]:
                raise ValueError("航班已有活动工单或实际加注记录，需油量不可直接修改，请先由调度处理保障差额")
        return values

    @staticmethod
    def _write_flight(db: sqlite3.Connection, values: dict, existing_id: str | None) -> None:
        fields = (values["gate"], values["departure_at"], values["fuel_needed"], values["priority"], values["x"], values["y"])
        if existing_id:
            db.execute("UPDATE flights SET gate=?,departure_at=?,fuel_needed=?,priority=?,x=?,y=? WHERE id=?", (*fields, existing_id))
        else:
            db.execute(
                """INSERT INTO flights (id,flight_no,gate,departure_at,fuel_needed,priority,x,y,status)
                   VALUES (?,?,?,?,?,?,?,?,'PLANNED')""", (f"import-{uuid.uuid4()}", values["flight_no"], *fields),
            )

    def _import_flights(self, db: sqlite3.Connection, payload: dict) -> None:
        flights = payload.get("flights")
        if not isinstance(flights, list) or not flights:
            raise ValueError("请至少提供一条航班数据")
        preview = payload.get("preview") is True
        imported, report, seen = 0, [], set()
        for row_number, item in enumerate(flights, start=1):
            flight_no = str(item.get("flightNo", "")).strip().upper() if isinstance(item, dict) else ""
            result = {"row": row_number, "flightNo": flight_no or "未命名航班", "action": "REJECT", "error": None}
            try:
                if not isinstance(item, dict) or any(key not in item for key in ("flightNo", "gate", "departureAt", "fuelNeeded")):
                    raise ValueError("缺少 flightNo、gate、departureAt 或 fuelNeeded 必填列")
                if flight_no in seen:
                    raise ValueError("同一文件中航班号重复，请合并后再导入")
                seen.add(flight_no)
                existing = db.execute("SELECT * FROM flights WHERE flight_no=?", (flight_no,)).fetchone()
                values = self._validated_flight(db, item, existing)
                result["action"] = "UPDATE" if existing else "CREATE"
                if not preview:
                    self._write_flight(db, values, existing["id"] if existing else None)
                    imported += 1
            except (TypeError, ValueError) as error:
                result["error"] = str(error)
            report.append(result)
        rejected = [item for item in report if item["error"]]
        valid = len(report) - len(rejected)
        if not preview:
            broadcast(db, "INFO", "航班计划已导入", f"已导入或更新 {imported} 条，拒绝 {len(rejected)} 条。")
            update_time_alerts(db)
        self._send({"message": f"预览：{valid} 条有效，{len(rejected)} 条拒绝" if preview else f"已导入或更新 {imported} 条，拒绝 {len(rejected)} 条",
                    "preview": preview, "rows": report, "valid": valid, "imported": imported, "rejected": rejected,
                    "overview": overview(db)})

    def _update_flight(self, db: sqlite3.Connection, flight_id: str, payload: dict, actor: sqlite3.Row) -> None:
        flight = db.execute("SELECT * FROM flights WHERE id=?", (flight_id,)).fetchone()
        if not flight:
            raise ValueError("航班不存在")
        values = self._validated_flight(db, payload, flight)
        before = f"机位={flight['gate']} 离港={flight['departure_at']} 需油={flight['fuel_needed']:,}L 优先级={flight['priority']}"
        self._write_flight(db, values, flight_id)
        after = f"机位={values['gate']} 离港={values['departure_at']} 需油={values['fuel_needed']:,}L 优先级={values['priority']}"
        log_operation(db, actor, "调整航班计划", "航班", flight_id, flight["flight_no"], before=before, after=after)
        broadcast(db, "INFO", "航班计划已调整", f"{flight['flight_no']} 的计划已更新：机位 {values['gate']}，离港 {values['departure_at']}。", flight_id)
        update_time_alerts(db)
        self._send({"message": f"{flight['flight_no']} 航班计划已更新", "overview": overview(db)})

    # ---------------- 人员与账号管理（FR-01 / FR-02，仅系统管理员） ----------------

    def _list_personnel(self, db: sqlite3.Connection, params: dict) -> list[dict]:
        conditions, args = ["u.role IN ('DISPATCHER', 'DRIVER')"], []
        role = params.get("role", [""])[0]
        if role in {"DISPATCHER", "DRIVER"}:
            conditions.append("u.role=?"); args.append(role)
        status = params.get("status", [""])[0]
        if status in {"ENABLED", "DISABLED"}:
            conditions.append("u.account_status=?"); args.append(status)
        work = params.get("work", [""])[0]
        if work in WORK_STATUSES:
            conditions.append("u.work_status=?"); args.append(work)
        keyword = params.get("q", [""])[0].strip()
        if keyword:
            conditions.append("(u.emp_no LIKE ? OR u.display_name LIKE ? OR u.username LIKE ?)")
            args.extend([f"%{keyword}%"] * 3)
        return rows(
            db,
            f"""SELECT u.id, u.emp_no, u.username, u.display_name, u.role, u.phone,
                       u.account_status, u.work_status, u.created_at, u.vehicle_id,
                       v.code vehicle_code, v.status vehicle_status
                FROM users u LEFT JOIN vehicles v ON v.id = u.vehicle_id
                WHERE {" AND ".join(conditions)}
                ORDER BY CASE u.role WHEN 'DISPATCHER' THEN 0 ELSE 1 END, u.emp_no""",
            tuple(args),
        )

    def _personnel_target(self, db: sqlite3.Connection, person_id: str) -> sqlite3.Row:
        target = db.execute("SELECT * FROM users WHERE id=?", (person_id,)).fetchone()
        if not target or target["role"] not in {"DISPATCHER", "DRIVER"}:
            raise ValueError("人员不存在")
        return target

    @staticmethod
    def _public_personnel(person: sqlite3.Row) -> dict:
        fields = ("id", "username", "display_name", "role", "emp_no", "phone",
                  "account_status", "work_status", "vehicle_id", "created_at")
        return {field: person[field] for field in fields}

    def _create_personnel(self, db: sqlite3.Connection, payload: dict, admin: sqlite3.Row) -> None:
        role = str(payload.get("role", "")).upper()
        emp_no = str(payload.get("empNo", "")).strip()
        name = str(payload.get("name", "")).strip()
        username = str(payload.get("username", "")).strip()
        password = str(payload.get("password", ""))
        phone = str(payload.get("phone", "")).strip()
        if role not in {"DISPATCHER", "DRIVER"}:
            raise ValueError("角色必须为调度人员或加油人员")
        if not re.fullmatch(r"[A-Za-z0-9_-]{2,20}", emp_no):
            raise ValueError("工号应为 2 至 20 位字母、数字、下划线或短横线")
        if not re.fullmatch(r"[A-Za-z0-9_]{3,20}", username):
            raise ValueError("登录账号应为 3 至 20 位字母、数字或下划线")
        if not 2 <= len(name) <= 20:
            raise ValueError("姓名应为 2 至 20 个字")
        check_password_strength(password)
        if db.execute("SELECT 1 FROM users WHERE username=?", (username,)).fetchone():
            raise ValueError("登录账号已存在")
        if db.execute("SELECT 1 FROM users WHERE emp_no=?", (emp_no,)).fetchone():
            raise ValueError("工号已存在")
        person_id = f"user-{uuid.uuid4()}"
        db.execute(
            """INSERT INTO users
               (id, username, password, display_name, role, vehicle_id, emp_no, phone,
                account_status, work_status, password_hash, must_change, created_at)
               VALUES (?, ?, '', ?, ?, NULL, ?, ?, 'ENABLED', ?, ?, 1, ?)""",
            (person_id, username, name, role, emp_no, phone or None,
             "RESTING" if role == "DRIVER" else None, hash_password(password), now()),
        )
        role_label = "调度人员" if role == "DISPATCHER" else "加油人员"
        log_operation(db, admin, "创建人员账号", "人员账号", person_id, name,
                      after=f"角色={role_label} 工号={emp_no} 账号={username}")
        self._send({
            "message": f"已创建{role_label}账号 {username}，初始密码仅本次显示，请交付本人并提醒首次登录修改",
            "personnel": self._public_personnel(self._personnel_target(db, person_id)),
        })

    def _update_personnel(self, db: sqlite3.Connection, person_id: str, payload: dict, admin: sqlite3.Row) -> None:
        target = self._personnel_target(db, person_id)
        name = str(payload.get("name", target["display_name"])).strip()
        phone = str(payload.get("phone", target["phone"] or "")).strip()
        if not 2 <= len(name) <= 20:
            raise ValueError("姓名应为 2 至 20 个字")
        db.execute("UPDATE users SET display_name=?, phone=? WHERE id=?", (name, phone or None, person_id))
        log_operation(db, admin, "修改人员资料", "人员账号", person_id, name,
                      before=target["display_name"], after=name)
        self._send({"message": "人员资料已更新", "personnel": self._public_personnel(self._personnel_target(db, person_id))})

    def _reset_password(self, db: sqlite3.Connection, person_id: str, admin: sqlite3.Row) -> None:
        target = self._personnel_target(db, person_id)
        new_password = generate_password()
        db.execute("UPDATE users SET password_hash=?, must_change=1 WHERE id=?", (hash_password(new_password), person_id))
        db.execute("DELETE FROM sessions WHERE user_id=?", (person_id,))
        log_operation(db, admin, "重置密码", "人员账号", person_id, target["display_name"])
        self._send({"message": "密码已重置，新密码仅本次显示，请交付本人并提醒首次登录修改", "password": new_password})

    def _active_vehicle_tasks(self, db: sqlite3.Connection, vehicle_id: str | None, *states: str) -> list[dict]:
        if not vehicle_id or not states:
            return []
        placeholders = ",".join("?" for _ in states)
        return rows(db, f"SELECT id, state FROM tasks WHERE vehicle_id=? AND state IN ({placeholders})", (vehicle_id, *states))

    def _set_account_status(self, db: sqlite3.Connection, person_id: str, enabled: bool, admin: sqlite3.Row) -> None:
        target = self._personnel_target(db, person_id)
        if not enabled and person_id == admin["id"]:
            raise ValueError("不能停用当前登录的管理员账号")
        if enabled:
            if target["account_status"] == "ENABLED":
                self._send({"message": "账号已处于启用状态"}); return
            db.execute("UPDATE users SET account_status='ENABLED' WHERE id=?", (person_id,))
            log_operation(db, admin, "启用账号", "人员账号", person_id, target["display_name"])
            self._send({"message": "账号已启用", "overview": overview(db)}); return
        if target["account_status"] == "DISABLED":
            self._send({"message": "账号已处于停用状态"}); return
        active = self._active_vehicle_tasks(db, target["vehicle_id"], "PENDING", "IN_PROGRESS", "AWAITING_REVIEW")
        if active:
            raise ValueError("该人员名下有待执行或作业中工单，请先由调度人员完成交接后再停用")
        before = f"账号=ENABLED 状态={WORK_STATUSES.get(target['work_status']) or '无'} 车辆={target['vehicle_id'] or '无'}"
        if target["vehicle_id"]:
            db.execute("UPDATE vehicles SET driver='', updated_at=? WHERE id=?", (now(), target["vehicle_id"]))
        db.execute(
            "UPDATE users SET account_status='DISABLED', work_status='RESTING', vehicle_id=NULL WHERE id=?",
            (person_id,),
        )
        db.execute("DELETE FROM sessions WHERE user_id=?", (person_id,))
        log_operation(db, admin, "停用账号", "人员账号", person_id, target["display_name"],
                      before=before, after="账号=DISABLED 状态=休息 车辆=无")
        self._send({"message": "账号已停用，已有会话立即失效", "overview": overview(db)})

    # ---------------- 可调度队伍与临时调用（FR-04 / FR-05，仅调度人员） ----------------

    def _driver_target(self, db: sqlite3.Connection, person_id: str) -> sqlite3.Row:
        target = self._personnel_target(db, person_id)
        if target["role"] != "DRIVER":
            raise ValueError("只能操作加油人员")
        if target["account_status"] != "ENABLED":
            raise ValueError("该人员账号已停用")
        return target

    def _bound_vehicle_code(self, db: sqlite3.Connection, vehicle_id: str | None) -> str:
        if not vehicle_id:
            return "无"
        row = db.execute("SELECT code FROM vehicles WHERE id=?", (vehicle_id,)).fetchone()
        return row["code"] if row else "无"

    def _unbind_vehicle(self, db: sqlite3.Connection, driver: sqlite3.Row) -> None:
        if not driver["vehicle_id"]:
            return
        db.execute("UPDATE users SET vehicle_id=NULL WHERE id=?", (driver["id"],))
        db.execute("UPDATE vehicles SET driver='', updated_at=? WHERE id=?", (now(), driver["vehicle_id"]))

    def _free_vehicle(self, db: sqlite3.Connection, vehicle_id: str | None) -> sqlite3.Row:
        if not vehicle_id:
            raise ValueError("请选择要绑定的加油车")
        vehicle = db.execute("SELECT * FROM vehicles WHERE id=?", (vehicle_id,)).fetchone()
        if not vehicle:
            raise ValueError("加油车不存在")
        if vehicle["status"] != "AVAILABLE":
            raise ValueError(f"车辆 {vehicle['code']} 当前不可用")
        if self._active_vehicle_tasks(db, vehicle["id"], "PENDING", "IN_PROGRESS", "AWAITING_REVIEW"):
            raise ValueError(f"车辆 {vehicle['code']} 已有待执行或作业中工单")
        occupied = db.execute(
            "SELECT display_name FROM users WHERE vehicle_id=? AND account_status='ENABLED'", (vehicle_id,)
        ).fetchone()
        if occupied:
            raise ValueError(f"车辆 {vehicle['code']} 已被 {occupied['display_name']} 占用")
        return vehicle

    def _set_work_status(self, db: sqlite3.Connection, person_id: str, payload: dict, actor: sqlite3.Row) -> None:
        target_status = str(payload.get("status", "")).upper()
        reason = payload.get("reason", "")
        if not isinstance(reason, str):
            raise ValueError("状态变更原因必须填写为文本")
        reason = reason.strip()
        if target_status not in WORK_STATUSES:
            raise ValueError("工作状态必须为值班、休闲或休息")
        driver = self._driver_target(db, person_id)
        current = driver["work_status"]
        before = f"状态={WORK_STATUSES.get(current) or '无'} 车辆={self._bound_vehicle_code(db, driver['vehicle_id'])}"
        if current == target_status:
            self._send({"message": f"人员已处于{WORK_STATUSES[target_status]}状态", "overview": overview(db)}); return
        if target_status == "ON_DUTY":
            raise ValueError("转为值班必须通过临时调用并绑定车辆")
        active = self._active_vehicle_tasks(db, driver["vehicle_id"], "PENDING", "IN_PROGRESS", "AWAITING_REVIEW")
        if active:
            raise ValueError("该人员名下有待执行或作业中工单，请先完成作业、改派或按异常流程处理")
        if target_status == "RESTING" and len(reason) < 2:
            raise ValueError("请填写状态变更原因（如交班、请假、临时离岗）")
        if current == "ON_DUTY" and target_status == "STANDBY" and len(reason) < 2:
            raise ValueError("请填写设为休闲的原因")
        self._unbind_vehicle(db, driver)
        db.execute("UPDATE users SET work_status=? WHERE id=?", (target_status, person_id))
        log_operation(db, actor, "调整工作状态", "加油人员", person_id, driver["display_name"],
                      before=before, after=f"状态={WORK_STATUSES[target_status]} 车辆=无", reason=reason)
        self._send({"message": f"{driver['display_name']} 已调整为{WORK_STATUSES[target_status]}", "overview": overview(db)})

    def _call_driver(self, db: sqlite3.Connection, person_id: str, payload: dict, actor: sqlite3.Row) -> None:
        driver = self._driver_target(db, person_id)
        if driver["work_status"] == "ON_DUTY":
            raise ValueError("该人员已在值班并负责车辆，如需派工请使用工单微调")
        if driver["work_status"] == "RESTING":
            raise ValueError("休息人员不能临时调用，请先将人员调整为休闲候命")
        vehicle = self._free_vehicle(db, payload.get("vehicleId"))
        if vehicle["fuel_level"] * 5 < vehicle["capacity"]:
            raise ValueError("该车辆油量低于安全阈值，请先安排补油后再临时调用")
        try:
            db.execute(
                "UPDATE users SET vehicle_id=?, work_status='ON_DUTY' WHERE id=?",
                (vehicle["id"], person_id),
            )
        except sqlite3.IntegrityError as exc:
            raise ValueError(f"车辆 {vehicle['code']} 刚被其他值班人员占用，请重新选择") from exc
        db.execute("UPDATE vehicles SET driver=?, updated_at=? WHERE id=?", (driver["display_name"], now(), vehicle["id"]))
        log_operation(db, actor, "临时调用", "加油人员", person_id, driver["display_name"],
                      before="状态=休闲 车辆=无", after=f"状态=值班 车辆={vehicle['code']}")
        self._send({"message": f"已临时调用 {driver['display_name']}，绑定车辆 {vehicle['code']} 并转为值班", "overview": overview(db)})

    def _rebind_driver_vehicle(self, db: sqlite3.Connection, person_id: str, payload: dict, actor: sqlite3.Row) -> None:
        driver = self._driver_target(db, person_id)
        if driver["work_status"] != "ON_DUTY":
            raise ValueError("只有值班人员可以更换车辆")
        active = self._active_vehicle_tasks(db, driver["vehicle_id"], "PENDING", "IN_PROGRESS", "AWAITING_REVIEW")
        if any(task["state"] in {"IN_PROGRESS", "AWAITING_REVIEW"} for task in active):
            raise ValueError("该人员正在作业，请先完成作业或按异常流程处理后再更换车辆")
        new_vehicle = self._free_vehicle(db, payload.get("vehicleId"))
        pending = rows(
            db, """SELECT t.id, f.x, f.y, COALESCE(t.fuel_requested,f.fuel_needed) fuel_needed FROM tasks t JOIN flights f ON f.id=t.flight_id
                    WHERE t.vehicle_id=? AND t.state='PENDING'""", (driver["vehicle_id"],),
        )
        if new_vehicle["fuel_level"] < sum(task["fuel_needed"] for task in pending) or new_vehicle["fuel_level"] * 5 < new_vehicle["capacity"]:
            raise ValueError("新车辆油量不足以承接全部待执行工单，或低于安全阈值，请先安排补油")
        old_vehicle = db.execute("SELECT * FROM vehicles WHERE id=?", (driver["vehicle_id"],)).fetchone()
        old_code = self._bound_vehicle_code(db, driver["vehicle_id"])
        position = old_vehicle if old_vehicle else STANDBY_POINT
        driver_distance = abs(position["x"] - new_vehicle["x"]) + abs(position["y"] - new_vehicle["y"])
        self._unbind_vehicle(db, driver)
        try:
            db.execute("UPDATE users SET vehicle_id=? WHERE id=?", (new_vehicle["id"], person_id))
        except sqlite3.IntegrityError as exc:
            raise ValueError(f"车辆 {new_vehicle['code']} 刚被其他值班人员占用，请重新选择") from exc
        for task in pending:
            distance = driver_distance + abs(new_vehicle["x"] - task["x"]) + abs(new_vehicle["y"] - task["y"])
            db.execute(
                "UPDATE tasks SET vehicle_id=?, locked=1, eta_minutes=?, assigned_driver=?, updated_at=? WHERE id=?",
                (new_vehicle["id"], max(4, distance * 2 + 3), driver["display_name"], now(), task["id"]),
            )
        db.execute(
            "UPDATE vehicles SET driver=?, status=?, updated_at=? WHERE id=?",
            (driver["display_name"], "RESERVED" if pending else "AVAILABLE", now(), new_vehicle["id"]),
        )
        if old_vehicle:
            db.execute(
                "UPDATE vehicles SET status='AVAILABLE', updated_at=? WHERE id=? AND status='RESERVED'",
                (now(), old_vehicle["id"]),
            )
        update_time_alerts(db)
        log_operation(db, actor, "更换车辆", "加油人员", person_id, driver["display_name"],
                      before=f"车辆={old_code}", after=f"车辆={new_vehicle['code']} 已转移待执行工单={len(pending)}")
        self._send({"message": f"已将 {driver['display_name']} 更换至 {new_vehicle['code']}，同步转移 {len(pending)} 项待执行工单", "overview": overview(db)})


def main() -> None:
    init_db()
    host, port = os.getenv("HOST", "127.0.0.1"), int(os.getenv("PORT", "8080"))
    print(f"Fuel Dispatch API listening at http://{host}:{port}")
    ThreadingHTTPServer((host, port), Handler).serve_forever()


if __name__ == "__main__":
    main()
