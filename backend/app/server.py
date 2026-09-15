"""Airport fuel-truck dispatch API.

The service deliberately keeps the integration boundary small: A-OCS sends
flight events to /api/events and the dispatcher/driver clients use JSON APIs.
The default scheduler is a deterministic, explainable greedy heuristic.  The
``Scheduler`` class is the seam where an OR-Tools VRPTW implementation can be
plugged in for a production deployment.
"""

from __future__ import annotations

import json
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]
DATABASE = Path(os.getenv("DISPATCH_DB", ROOT / "dispatch.db"))
EVENT_TYPES = {"ARRIVED", "DELAYED", "CANCELLED", "DEPARTING"}
TASK_TRANSITIONS = {
    "PENDING": {"IN_PROGRESS", "CANCELLED"},
    "IN_PROGRESS": {"COMPLETED", "EXCEPTION"},
    "EXCEPTION": {"PENDING", "CANCELLED"},
}


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect() -> sqlite3.Connection:
    connection = sqlite3.connect(DATABASE)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


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
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
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
  vehicle_id TEXT REFERENCES vehicles(id)
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
        alert_columns = {row["name"] for row in db.execute("PRAGMA table_info(alerts)")}
        if "resolution" not in alert_columns:
            db.execute("ALTER TABLE alerts ADD COLUMN resolution TEXT")
        if "resolved_at" not in alert_columns:
            db.execute("ALTER TABLE alerts ADD COLUMN resolved_at TEXT")
        if not db.execute("SELECT COUNT(*) FROM flights").fetchone()[0]:
            flights = [
                ("f1", "CA1832", "B12", "2026-09-14T09:45:00+00:00", 7200, 3, "WAITING", 12, 8),
                ("f2", "MU5216", "A06", "2026-09-14T10:05:00+00:00", 5200, 2, "WAITING", 5, 11),
                ("f3", "CZ3148", "C18", "2026-09-14T10:20:00+00:00", 8400, 3, "WAITING", 19, 6),
                ("f4", "HO1179", "D03", "2026-09-14T10:40:00+00:00", 4300, 1, "PLANNED", 23, 16),
                ("f5", "3U8921", "A11", "2026-09-14T11:00:00+00:00", 6100, 2, "WAITING", 7, 4),
            ]
            vehicles = [
                ("v1", "JF-01", "李昊", 14300, 18000, "AVAILABLE", 3, 6, now()),
                ("v2", "JF-03", "周敏", 9800, 14000, "AVAILABLE", 16, 12, now()),
                ("v3", "JF-05", "陈跃", 12100, 16000, "WORKING", 10, 10, now()),
                ("v4", "JF-08", "王超", 3900, 12000, "AVAILABLE", 21, 4, now()),
                ("v5", "JF-12", "刘倩", 15400, 18000, "MAINTENANCE", 2, 19, now()),
            ]
            db.executemany("INSERT INTO flights VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", flights)
            db.executemany("INSERT INTO vehicles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", vehicles)
            db.execute(
                """INSERT INTO tasks
                   (id, flight_id, vehicle_id, state, locked, eta_minutes, dispatch_order, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                ("t-seeded", "f3", "v3", "IN_PROGRESS", 0, 8, 0, now(), now()),
            )
        db.executemany(
            "INSERT OR IGNORE INTO users (id, username, password, display_name, role, vehicle_id) VALUES (?, ?, ?, ?, ?, ?)",
            [
                ("dispatcher", "dispatch01", "dispatch123", "张宁", "DISPATCHER", None),
                ("admin", "admin01", "admin123", "系统管理员", "ADMIN", None),
                ("driver-v1", "driver01", "driver123", "李昊", "DRIVER", "v1"),
                ("driver-v2", "driver02", "driver123", "周敏", "DRIVER", "v2"),
                ("driver-v3", "driver03", "driver123", "陈跃", "DRIVER", "v3"),
            ],
        )
        db.executemany(
            "UPDATE users SET username=?, password=? WHERE id=?",
            [
                ("dispatch01", "dispatch123", "dispatcher"), ("admin01", "admin123", "admin"),
                ("driver01", "driver123", "driver-v1"), ("driver02", "driver123", "driver-v2"),
                ("driver03", "driver123", "driver-v3"),
            ],
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


class Scheduler:
    """Constraint-aware, deterministic fallback scheduler.

    Scoring favours higher-priority flights, then nearby vehicles.  Eligibility
    enforces the two safety constraints defined in the SRS: enough fuel for the
    job and an operational vehicle.  Manual locks are never changed.
    """

    @staticmethod
    def optimize(db: sqlite3.Connection) -> dict:
        waiting = rows(
            db,
            """SELECT f.* FROM flights f
               WHERE f.status = 'WAITING' AND NOT EXISTS
               (SELECT 1 FROM tasks t WHERE t.flight_id=f.id AND t.state IN ('PENDING','IN_PROGRESS'))
               ORDER BY f.priority DESC, f.departure_at ASC""",
        )
        fleet = rows(db, "SELECT * FROM vehicles WHERE status = 'AVAILABLE' ORDER BY code")
        assignments, risks = [], []
        for flight in waiting:
            eligible = [vehicle for vehicle in fleet if vehicle["fuel_level"] >= flight["fuel_needed"]]
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
                   (id, flight_id, vehicle_id, state, locked, eta_minutes, dispatch_order, created_at, updated_at)
                   VALUES (?, ?, ?, 'PENDING', 0, ?, ?, ?, ?)""",
                (task_id, flight["id"], vehicle["id"], eta, next_order, now(), now()),
            )
            db.execute("UPDATE flights SET status='ASSIGNED' WHERE id=?", (flight["id"],))
            db.execute(
                "UPDATE vehicles SET status='RESERVED', x=?, y=?, updated_at=? WHERE id=?",
                (flight["x"], flight["y"], now(), vehicle["id"]),
            )
            fleet = [item for item in fleet if item["id"] != vehicle["id"]]
            assignments.append({"taskId": task_id, "flight": flight["flight_no"], "vehicle": vehicle["code"], "etaMinutes": eta})
        return {"assignments": assignments, "risks": risks}


def overview(db: sqlite3.Connection) -> dict:
    active = rows(
        db,
        """SELECT t.id, t.state, t.locked, t.eta_minutes, t.dispatch_order, t.updated_at,
                  f.id flight_id, f.flight_no, f.gate, f.departure_at, f.fuel_needed, f.priority,
                  v.id vehicle_id, v.code vehicle_code, v.driver
           FROM tasks t JOIN flights f ON f.id=t.flight_id
           LEFT JOIN vehicles v ON v.id=t.vehicle_id
           WHERE t.state != 'CANCELLED'
           ORDER BY CASE WHEN t.state='PENDING' THEN 0 ELSE 1 END,
                    CASE WHEN t.dispatch_order=0 THEN 999999 ELSE t.dispatch_order END,
                    f.priority DESC, f.departure_at ASC""",
    )
    vehicles = rows(db, "SELECT * FROM vehicles ORDER BY code")
    flights = rows(db, "SELECT * FROM flights ORDER BY departure_at")
    alerts = rows(db, "SELECT * FROM alerts WHERE resolved=0 ORDER BY created_at DESC LIMIT 10")
    broadcasts = rows(db, "SELECT * FROM broadcasts ORDER BY created_at DESC LIMIT 12")
    stats = {
        "waiting": sum(f["status"] == "WAITING" for f in flights),
        "activeTasks": sum(t["state"] in {"PENDING", "IN_PROGRESS"} for t in active),
        "availableVehicles": sum(v["status"] == "AVAILABLE" for v in vehicles),
        "criticalAlerts": sum(a["level"] == "CRITICAL" for a in alerts),
        "vehicleUtilization": round(100 * sum(v["status"] in {"RESERVED", "WORKING"} for v in vehicles) / max(1, len(vehicles))),
        "onTimeRate": 96.4,
    }
    recent_resolutions = rows(
        db,
        """SELECT * FROM alerts WHERE resolved=1 AND resolved_at IS NOT NULL
           ORDER BY resolved_at DESC LIMIT 5""",
    )
    return {
        "stats": stats, "tasks": active, "vehicles": vehicles, "flights": flights,
        "alerts": alerts, "broadcasts": broadcasts, "recentResolutions": recent_resolutions,
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "FuelDispatch/0.1"

    def log_message(self, format: str, *args: object) -> None:
        return

    def _send(self, payload: object, status: HTTPStatus = HTTPStatus.OK) -> None:
        data = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
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
                if path == "/api/driver/tasks":
                    user = self._authorize(db, "DRIVER")
                    self._send({"tasks": self._driver_tasks(db, user["vehicle_id"])})
                    return
                if path == "/api/admin/flights":
                    self._authorize(db, "ADMIN")
                    self._send({"flights": rows(db, "SELECT * FROM flights ORDER BY departure_at")})
                    return
            self._send({"error": "未找到资源"}, HTTPStatus.NOT_FOUND)
        except PermissionError as exc:
            self._send({"error": str(exc)}, HTTPStatus.FORBIDDEN)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        try:
            payload = self._body()
            with connect() as db:
                if path == "/api/auth/login":
                    self._login(db, payload)
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
                    self._authorize(db, "DISPATCHER")
                    self._override(db, path.split("/")[3], payload)
                    return
                if path.startswith("/api/alerts/") and path.endswith("/resolve"):
                    self._authorize(db, "DISPATCHER")
                    self._resolve_alert(db, path.split("/")[3], payload)
                    return
                if path == "/api/admin/flights/import":
                    self._authorize(db, "ADMIN")
                    self._import_flights(db, payload)
                    return
                if path == "/api/admin/broadcasts":
                    user = self._authorize(db, "ADMIN")
                    self._create_broadcast(db, payload, user)
                    return
            self._send({"error": "未找到资源"}, HTTPStatus.NOT_FOUND)
        except ValueError as exc:
            self._send({"error": str(exc)}, HTTPStatus.UNPROCESSABLE_ENTITY)
        except PermissionError as exc:
            self._send({"error": str(exc)}, HTTPStatus.FORBIDDEN)
        except sqlite3.Error:
            self._send({"error": "数据处理失败，请稍后重试"}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def _authorize(self, db: sqlite3.Connection, *roles: str) -> sqlite3.Row:
        authorization = self.headers.get("Authorization", "")
        token = authorization.removeprefix("Bearer ").strip()
        user = db.execute(
            "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?",
            (token,),
        ).fetchone()
        if not token or not user or user["role"] not in roles:
            raise PermissionError("当前角色无权执行此操作，请重新登录。")
        return user

    def _login(self, db: sqlite3.Connection, payload: dict) -> None:
        username, password = str(payload.get("username", "")).strip(), payload.get("password")
        user = db.execute("SELECT * FROM users WHERE username=? AND password=?", (username, password)).fetchone()
        if not user:
            raise ValueError("账号或密码错误")
        token = str(uuid.uuid4())
        db.execute("INSERT INTO sessions VALUES (?, ?, ?)", (token, user["id"], now()))
        self._send({"user": self._public_user(user, token), "message": "登录成功"})

    @staticmethod
    def _public_user(user: sqlite3.Row, token: str | None = None) -> dict:
        return {
            "id": user["id"], "username": user["username"], "display_name": user["display_name"],
            "role": user["role"], "vehicle_id": user["vehicle_id"], **({"token": token} if token else {}),
        }

    def _driver_tasks(self, db: sqlite3.Connection, vehicle_id: str) -> list[dict]:
        return rows(
            db,
            """SELECT t.id, t.state, t.eta_minutes, t.updated_at, f.flight_no, f.gate,
                      f.fuel_needed, f.priority, v.code vehicle_code
               FROM tasks t JOIN flights f ON f.id=t.flight_id JOIN vehicles v ON v.id=t.vehicle_id
               WHERE t.vehicle_id=? AND t.state NOT IN ('COMPLETED','CANCELLED')
               ORDER BY f.priority DESC, f.departure_at ASC""",
            (vehicle_id,),
        )

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
        db.execute("INSERT INTO received_events VALUES (?, ?)", (event_id, now()))
        statuses = {"ARRIVED": "WAITING", "DELAYED": "WAITING", "CANCELLED": "CANCELLED", "DEPARTING": "DEPARTING"}
        db.execute("UPDATE flights SET status=? WHERE id=?", (statuses[event_type], flight_id))
        if event_type == "CANCELLED":
            db.execute("UPDATE tasks SET state='CANCELLED', updated_at=? WHERE flight_id=? AND state='PENDING'", (now(), flight_id))
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
        task = db.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        if not task:
            raise ValueError("工单不存在")
        if task["vehicle_id"] != user["vehicle_id"]:
            raise PermissionError("只能更新分配给自己的工单")
        if state not in TASK_TRANSITIONS.get(task["state"], set()):
            raise ValueError(f"不允许从 {task['state']} 变更为 {state}")
        if state == "EXCEPTION" and not reason.strip():
            raise ValueError("异常上报必须填写原因")
        db.execute("UPDATE tasks SET state=?, updated_at=? WHERE id=?", (state, now(), task_id))
        if state in {"COMPLETED", "EXCEPTION"}:
            vehicle_status = "AVAILABLE" if state == "COMPLETED" else "MAINTENANCE"
            db.execute("UPDATE vehicles SET status=?, updated_at=? WHERE id=?", (vehicle_status, now(), task["vehicle_id"]))
            db.execute("UPDATE flights SET status=? WHERE id=(SELECT flight_id FROM tasks WHERE id=?)", ("COMPLETED" if state == "COMPLETED" else "WAITING", task_id))
            if state == "EXCEPTION":
                message = f"工单异常：{reason}"
                if alert(db, "CRITICAL", "VEHICLE_EXCEPTION", message, task_id):
                    flight = db.execute("SELECT flight_no FROM flights WHERE id=?", (task["flight_id"],)).fetchone()
                    broadcast(db, "CRITICAL", "加油车现场异常", f"{flight['flight_no']} 保障任务异常：{reason}", task["flight_id"])
        elif state == "IN_PROGRESS":
            db.execute("UPDATE vehicles SET status='WORKING', updated_at=? WHERE id=?", (now(), task["vehicle_id"]))
        result = Scheduler.optimize(db)
        self._send({"message": "工单进度已更新", **result, "overview": overview(db)})

    def _override(self, db: sqlite3.Connection, task_id: str, payload: dict) -> None:
        vehicle_id = payload.get("vehicleId")
        eta_minutes = payload.get("etaMinutes")
        dispatch_order = payload.get("dispatchOrder")
        task = db.execute("SELECT t.*, f.fuel_needed, f.flight_no FROM tasks t JOIN flights f ON f.id=t.flight_id WHERE t.id=?", (task_id,)).fetchone()
        vehicle = db.execute("SELECT * FROM vehicles WHERE id=?", (vehicle_id,)).fetchone()
        if not task or not vehicle:
            raise ValueError("工单或车辆不存在")
        if vehicle["status"] not in {"AVAILABLE", "RESERVED"}:
            raise ValueError("该车辆当前不可改派")
        if vehicle["fuel_level"] < task["fuel_needed"]:
            raise ValueError("该车辆油量不足，无法改派")
        try:
            eta = int(eta_minutes)
            requested_order = int(dispatch_order)
        except (TypeError, ValueError) as exc:
            raise ValueError("预计到达时间和执行顺序必须为数字") from exc
        if not 1 <= eta <= 180:
            raise ValueError("预计到达时间应在 1 至 180 分钟之间")
        if requested_order < 1:
            raise ValueError("执行顺序必须从 1 开始")
        db.execute(
            "UPDATE tasks SET vehicle_id=?, eta_minutes=?, locked=1, updated_at=? WHERE id=?",
            (vehicle_id, eta, now(), task_id),
        )
        self._resequence_tasks(db, task_id, requested_order)
        db.execute("UPDATE vehicles SET status='RESERVED', updated_at=? WHERE id=?", (now(), vehicle_id))
        self._send({"message": "人工微调已生效并锁定，智能调度不会覆盖此工单", "overview": overview(db)})

    def _alert_recommendations(self, db: sqlite3.Connection, alert_id: str) -> dict:
        alert_item = db.execute("SELECT * FROM alerts WHERE id=? AND resolved=0", (alert_id,)).fetchone()
        if not alert_item:
            raise ValueError("风险预警不存在或已处置")
        flight = None
        if alert_item["type"] == "NO_ELIGIBLE_VEHICLE":
            flight = db.execute("SELECT * FROM flights WHERE id=?", (alert_item["related_id"],)).fetchone()
        elif alert_item["type"] == "VEHICLE_EXCEPTION":
            flight = db.execute(
                "SELECT f.* FROM tasks t JOIN flights f ON f.id=t.flight_id WHERE t.id=?",
                (alert_item["related_id"],),
            ).fetchone()
        candidates = []
        if flight:
            candidate_rows = rows(
                db,
                """SELECT * FROM vehicles WHERE fuel_level >= ? AND status != 'MAINTENANCE'
                   ORDER BY CASE status WHEN 'AVAILABLE' THEN 0 WHEN 'RESERVED' THEN 1 ELSE 2 END,
                            fuel_level DESC""",
                (flight["fuel_needed"],),
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

    def _resolve_alert(self, db: sqlite3.Connection, alert_id: str, payload: dict) -> None:
        resolution = str(payload.get("resolution", "")).strip()
        if len(resolution) < 4:
            raise ValueError("请填写至少 4 个字的处置说明，便于交接班追溯")
        result = db.execute(
            """UPDATE alerts SET resolved=1, resolution=?, resolved_at=?
               WHERE id=? AND resolved=0""",
            (resolution, now(), alert_id),
        )
        if not result.rowcount:
            raise ValueError("风险预警不存在或已处置")
        self._send({"message": "风险已完成处置并归档，可在交接班记录中追溯", "overview": overview(db)})

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

    def _import_flights(self, db: sqlite3.Connection, payload: dict) -> None:
        flights = payload.get("flights")
        if not isinstance(flights, list) or not flights:
            raise ValueError("请至少提供一条航班数据")
        imported, rejected = 0, []
        for item in flights:
            try:
                flight_no = str(item["flightNo"]).strip().upper()
                gate = str(item["gate"]).strip().upper()
                departure_at = str(item["departureAt"]).strip()
                fuel_needed, priority = int(item["fuelNeeded"]), int(item.get("priority", 1))
                x, y = int(item.get("x", 10)), int(item.get("y", 10))
                if not flight_no or not gate or fuel_needed <= 0 or priority not in {1, 2, 3}:
                    raise ValueError("字段值不合法")
                existing = db.execute("SELECT id FROM flights WHERE flight_no=?", (flight_no,)).fetchone()
                if existing:
                    db.execute(
                        "UPDATE flights SET gate=?, departure_at=?, fuel_needed=?, priority=?, x=?, y=? WHERE id=?",
                        (gate, departure_at, fuel_needed, priority, x, y, existing["id"]),
                    )
                else:
                    db.execute(
                        "INSERT INTO flights VALUES (?, ?, ?, ?, ?, ?, 'PLANNED', ?, ?)",
                        (f"import-{uuid.uuid4()}", flight_no, gate, departure_at, fuel_needed, priority, x, y),
                    )
                imported += 1
            except (KeyError, TypeError, ValueError):
                rejected.append(item.get("flightNo", "未命名航班") if isinstance(item, dict) else "格式错误行")
        broadcast(
            db, "INFO", "航班计划已导入",
            f"已导入或更新 {imported} 条航班计划{f'，其中 {len(rejected)} 条数据格式异常' if rejected else ''}。",
            source="ADMIN_IMPORT",
        )
        self._send({"message": f"已导入或更新 {imported} 条航班数据", "imported": imported, "rejected": rejected, "flights": rows(db, "SELECT * FROM flights ORDER BY departure_at")})

    def _create_broadcast(self, db: sqlite3.Connection, payload: dict, user: sqlite3.Row) -> None:
        title = str(payload.get("title", "")).strip()
        content = str(payload.get("content", "")).strip()
        level = str(payload.get("level", "INFO")).upper()
        flight_id = payload.get("flightId") or None
        if not 2 <= len(title) <= 40 or not 4 <= len(content) <= 300:
            raise ValueError("播报标题需为 2 至 40 个字，内容需为 4 至 300 个字")
        if level not in {"INFO", "WARNING", "CRITICAL"}:
            raise ValueError("播报级别不合法")
        if flight_id and not db.execute("SELECT 1 FROM flights WHERE id=?", (flight_id,)).fetchone():
            raise ValueError("关联航班不存在")
        broadcast(db, level, title, content, flight_id, f"ADMIN:{user['display_name']}")
        self._send({"message": "现场情况已发送至调度员运行通知", "overview": overview(db)})


def main() -> None:
    init_db()
    host, port = os.getenv("HOST", "127.0.0.1"), int(os.getenv("PORT", "8080"))
    print(f"Fuel Dispatch API listening at http://{host}:{port}")
    ThreadingHTTPServer((host, port), Handler).serve_forever()


if __name__ == "__main__":
    main()
