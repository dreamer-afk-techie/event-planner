#!/usr/bin/env python3
"""Local event app for dance performance planning."""

from __future__ import annotations

import json
import re
import secrets
import threading
from datetime import datetime, timezone
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


APP_ROOT = Path(__file__).resolve().parent
PUBLIC_ROOT = APP_ROOT / "public"
DATA_DIR = APP_ROOT / "data"
STORE_PATH = DATA_DIR / "store.json"
HOST = "127.0.0.1"
PORT = 8010
MAX_ENTRIES = 10_000
MAX_BODY_BYTES = 64_000
MAX_TEXT = 160
MAX_NOTES = 500
INSTAGRAM_HOSTS = {"instagram.com", "www.instagram.com"}
store_lock = threading.Lock()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def empty_store() -> dict[str, object]:
    return {
        "events": [],
        "performances": [],
        "practiceLogs": [],
        "createdAt": utc_now(),
        "updatedAt": utc_now(),
    }


def ensure_store() -> None:
    DATA_DIR.mkdir(exist_ok=True)
    if not STORE_PATH.exists():
        write_store(empty_store())


def read_store() -> dict[str, object]:
    ensure_store()
    with STORE_PATH.open("r", encoding="utf-8") as store_file:
        return migrate_store(json.load(store_file))


def write_store(store: dict[str, object]) -> None:
    DATA_DIR.mkdir(exist_ok=True)
    store["updatedAt"] = utc_now()
    temporary = STORE_PATH.with_suffix(".tmp")
    temporary.write_text(json.dumps(store, indent=2) + "\n", encoding="utf-8")
    temporary.replace(STORE_PATH)


def clean_text(value: object, limit: int = MAX_TEXT) -> str:
    text = str(value or "").strip()
    text = re.sub(r"\s+", " ", text)
    return text[:limit]


def migrate_store(store: dict[str, object]) -> dict[str, object]:
    if "events" in store and isinstance(store.get("events"), list):
        return store

    legacy_event = store.get("event") if isinstance(store.get("event"), dict) else {}
    performances = store.get("performances", [])
    practice_logs = store.get("practiceLogs", [])
    event_id = clean_text(legacy_event.get("id") if legacy_event else "", 40) or "main-event"
    event = {
        "id": event_id,
        "name": clean_text(legacy_event.get("name") if legacy_event else "", 80) or "Event Planner",
        "eventDate": clean_text(legacy_event.get("eventDate") if legacy_event else "", 20),
        "practiceGoalPerPerson": legacy_event.get("practiceGoalPerPerson", 5) if legacy_event else 5,
        "createdAt": store.get("createdAt", utc_now()),
        "updatedAt": store.get("updatedAt", utc_now()),
    }
    for item in performances if isinstance(performances, list) else []:
        item.setdefault("eventId", event_id)
    for item in practice_logs if isinstance(practice_logs, list) else []:
        item.setdefault("eventId", event_id)
    store.pop("event", None)
    store["events"] = [event] if performances or practice_logs or legacy_event else []
    return store


def validate_instagram_url(value: object) -> str:
    url = str(value or "").strip()
    parsed = urlparse(url)
    host = parsed.netloc.lower()
    allowed_hosts = {*INSTAGRAM_HOSTS, "youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"}
    if parsed.scheme != "https" or host not in allowed_hosts:
        raise ValueError("Use a public Instagram or YouTube https:// link.")
    if not parsed.path or parsed.path == "/":
        raise ValueError("The link must point to an Instagram or YouTube reference.")
    return url[:500]


def normalize_name(value: object) -> str:
    name = clean_text(value, 60)
    if not name:
        raise ValueError("Name is required.")
    return name


def get_events(store: dict[str, object]) -> list[dict[str, object]]:
    events = store.setdefault("events", [])
    if not isinstance(events, list):
        raise ValueError("Store is corrupted.")
    return events


def find_event(store: dict[str, object], event_id: str) -> dict[str, object] | None:
    for event in get_events(store):
        if event.get("id") == event_id:
            return event
    return None


def find_performance(store: dict[str, object], performance_id: str, event_id: str | None = None) -> dict[str, object] | None:
    performances = store.get("performances", [])
    if not isinstance(performances, list):
        return None
    for performance in performances:
        if performance.get("id") == performance_id and (event_id is None or performance.get("eventId") == event_id):
            return performance
    return None


def public_state(store: dict[str, object], csrf_token: str, event_id: str = "") -> dict[str, object]:
    events = get_events(store)
    all_performances = list(store.get("performances", []))
    all_practice_logs = list(store.get("practiceLogs", []))
    event = find_event(store, event_id) if event_id else None
    performances = [item for item in all_performances if event and item.get("eventId") == event.get("id")]
    practice_logs = [item for item in all_practice_logs if event and item.get("eventId") == event.get("id")]
    finalized = [item for item in performances if item.get("finalized")]
    pending = [item for item in performances if not item.get("finalized")]
    total_votes = sum(len(item.get("votes", [])) for item in performances)
    practiced_people = {log.get("person") for log in practice_logs if log.get("person")}
    summaries = []
    for item in events:
        item_id = item.get("id")
        event_performances = [performance for performance in all_performances if performance.get("eventId") == item_id]
        event_logs = [log for log in all_practice_logs if log.get("eventId") == item_id]
        summaries.append(
            {
                "id": item_id,
                "name": item.get("name", "Untitled Event"),
                "eventDate": item.get("eventDate", ""),
                "practiceGoalPerPerson": item.get("practiceGoalPerPerson", 5),
                "entries": len(event_performances),
                "finalized": len([performance for performance in event_performances if performance.get("finalized")]),
                "practiceLogs": len(event_logs),
                "updatedAt": item.get("updatedAt", item.get("createdAt", "")),
            }
        )

    return {
        "csrfToken": csrf_token,
        "events": sorted(summaries, key=lambda item: item.get("updatedAt", ""), reverse=True),
        "event": event,
        "metrics": {
            "entries": len(performances),
            "pending": len(pending),
            "finalized": len(finalized),
            "votes": total_votes,
            "practiceLogs": len(practice_logs),
            "homePracticedPeople": len(practiced_people),
        },
        "performances": sorted(
            performances,
            key=lambda item: (not item.get("finalized"), -len(item.get("votes", [])), item.get("createdAt", "")),
        ),
        "practiceLogs": sorted(practice_logs, key=lambda item: item.get("createdAt", ""), reverse=True)[:80],
    }


class DanceHandler(SimpleHTTPRequestHandler):
    server_version = "DanceParty/1.0"

    def __init__(self, *args: object, **kwargs: object) -> None:
        self.csrf_cookie_to_set: str | None = None
        super().__init__(*args, directory=str(PUBLIC_ROOT), **kwargs)

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; "
            "connect-src 'self' https://*.supabase.co; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        )
        super().end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/state":
            query = parse_qs(parsed.query)
            event_id = clean_text(query.get("eventId", [""])[0], 40)
            self.write_json(HTTPStatus.OK, public_state(read_store(), self.get_csrf_token(), event_id))
            return
        if parsed.path == "/":
            self.path = "/index.html"
        super().do_GET()

    def do_POST(self) -> None:
        routes = {
            "/api/events": self.create_event,
            "/api/event": self.update_event,
            "/api/performances": self.add_performance,
            "/api/performance": self.edit_performance,
            "/api/reorder": self.reorder_performances,
            "/api/delete-performance": self.delete_performance,
            "/api/dancer-group": self.update_dancer_group,
            "/api/vote": self.vote,
            "/api/finalize": self.finalize_performance,
            "/api/practice": self.log_practice,
        }
        handler = routes.get(self.path)
        if not handler:
            self.write_json(HTTPStatus.NOT_FOUND, {"error": "Unknown endpoint."})
            return

        if not self.valid_origin() or not self.valid_csrf():
            self.write_json(HTTPStatus.FORBIDDEN, {"error": "Security check failed. Reload and try again."})
            return

        try:
            payload = self.read_json_body()
            with store_lock:
                store = read_store()
                result = handler(store, payload)
                write_store(store)
            self.write_json(HTTPStatus.OK, result)
        except ValueError as exc:
            self.write_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})

    def create_event(self, store: dict[str, object], payload: dict[str, object]) -> dict[str, object]:
        events = get_events(store)
        event = {
            "id": secrets.token_urlsafe(10),
            "name": clean_text(payload.get("name"), 80) or "New Event",
            "eventDate": clean_text(payload.get("eventDate"), 20),
            "practiceGoalPerPerson": max(1, min(100, int(payload.get("practiceGoalPerPerson") or 5))),
            "createdAt": utc_now(),
            "updatedAt": utc_now(),
        }
        events.append(event)
        return {"ok": True, "event": event}

    def update_event(self, store: dict[str, object], payload: dict[str, object]) -> dict[str, object]:
        event = find_event(store, clean_text(payload.get("eventId"), 40))
        if not event:
            raise ValueError("Event not found.")
        event["name"] = clean_text(payload.get("name"), 80) or "Event Planner"
        event["eventDate"] = clean_text(payload.get("eventDate"), 20)
        event["practiceGoalPerPerson"] = max(1, min(100, int(payload.get("practiceGoalPerPerson") or 5)))
        return {"ok": True}

    def add_performance(self, store: dict[str, object], payload: dict[str, object]) -> dict[str, object]:
        event_id = clean_text(payload.get("eventId"), 40)
        if not find_event(store, event_id):
            raise ValueError("Event not found.")
        performances = store.setdefault("performances", [])
        if not isinstance(performances, list):
            raise ValueError("Store is corrupted.")
        if len(performances) >= MAX_ENTRIES:
            raise ValueError("The performance list is full.")

        title = clean_text(payload.get("title"), 100)
        dance_style = clean_text(payload.get("danceStyle"), 80)
        instagram_url = validate_instagram_url(payload.get("instagramUrl"))
        added_by = normalize_name(payload.get("addedBy"))
        notes = clean_text(payload.get("notes"), MAX_NOTES)
        if not title or not dance_style:
            raise ValueError("Title and dance style are required.")

        performance = {
            "id": secrets.token_urlsafe(12),
            "eventId": event_id,
            "title": title,
            "danceStyle": dance_style,
            "dancerGroup": "",
            "displayOrder": int(datetime.now(timezone.utc).timestamp() * 1000),
            "instagramUrl": instagram_url,
            "addedBy": added_by,
            "notes": notes,
            "votes": [],
            "finalized": False,
            "createdAt": utc_now(),
        }
        performances.append(performance)
        return {"ok": True, "performance": performance}

    def update_dancer_group(self, store: dict[str, object], payload: dict[str, object]) -> dict[str, object]:
        event_id = clean_text(payload.get("eventId"), 40)
        performance = find_performance(store, clean_text(payload.get("performanceId"), 40), event_id)
        dancer_group = clean_text(payload.get("dancerGroup"), 40)
        if not performance:
            raise ValueError("Performance not found.")
        if dancer_group and not re.fullmatch(r"[A-Za-z ]+", dancer_group):
            raise ValueError("Who will dance may contain letters and spaces only.")
        performance["dancerGroup"] = dancer_group
        return {"ok": True}

    def edit_performance(self, store: dict[str, object], payload: dict[str, object]) -> dict[str, object]:
        event_id = clean_text(payload.get("eventId"), 40)
        performance = find_performance(store, clean_text(payload.get("performanceId"), 40), event_id)
        if not performance:
            raise ValueError("Performance not found.")
        title = clean_text(payload.get("title"), 100)
        dance_style = clean_text(payload.get("danceStyle"), 80)
        if not title or not dance_style:
            raise ValueError("Title and dance style are required.")
        performance.update({
            "title": title,
            "danceStyle": dance_style,
            "instagramUrl": validate_instagram_url(payload.get("instagramUrl")),
            "addedBy": normalize_name(payload.get("addedBy")),
            "notes": clean_text(payload.get("notes"), MAX_NOTES),
        })
        return {"ok": True}

    def reorder_performances(self, store: dict[str, object], payload: dict[str, object]) -> dict[str, object]:
        event_id = clean_text(payload.get("eventId"), 40)
        updates = payload.get("updates", [])
        if not isinstance(updates, list) or len(updates) != 2:
            raise ValueError("Two performances are required to change their order.")
        for update in updates:
            if not isinstance(update, dict):
                raise ValueError("Invalid order update.")
            performance = find_performance(store, clean_text(update.get("performanceId"), 40), event_id)
            if not performance:
                raise ValueError("Performance not found.")
            try:
                performance["displayOrder"] = int(update.get("displayOrder"))
            except (TypeError, ValueError):
                raise ValueError("Invalid performance order.") from None
        return {"ok": True}

    def delete_performance(self, store: dict[str, object], payload: dict[str, object]) -> dict[str, object]:
        event_id = clean_text(payload.get("eventId"), 40)
        performance_id = clean_text(payload.get("performanceId"), 40)
        performances = store.get("performances", [])
        if not isinstance(performances, list):
            raise ValueError("Store is corrupted.")
        for index, performance in enumerate(performances):
            if performance.get("id") == performance_id and performance.get("eventId") == event_id:
                performances.pop(index)
                return {"ok": True}
        raise ValueError("Performance not found.")

    def vote(self, store: dict[str, object], payload: dict[str, object]) -> dict[str, object]:
        event_id = clean_text(payload.get("eventId"), 40)
        performance = find_performance(store, clean_text(payload.get("performanceId"), 40), event_id)
        voter = normalize_name(payload.get("voter"))
        if not performance:
            raise ValueError("Performance not found.")
        votes = performance.setdefault("votes", [])
        if voter not in votes:
            votes.append(voter)
        return {"ok": True, "votes": len(votes)}

    def finalize_performance(self, store: dict[str, object], payload: dict[str, object]) -> dict[str, object]:
        event_id = clean_text(payload.get("eventId"), 40)
        performance = find_performance(store, clean_text(payload.get("performanceId"), 40), event_id)
        finalizer = normalize_name(payload.get("finalizer"))
        if not performance:
            raise ValueError("Performance not found.")
        performance["finalized"] = True
        performance["finalizedBy"] = finalizer
        performance["finalizedAt"] = utc_now()
        return {"ok": True}

    def log_practice(self, store: dict[str, object], payload: dict[str, object]) -> dict[str, object]:
        event_id = clean_text(payload.get("eventId"), 40)
        if not find_event(store, event_id):
            raise ValueError("Event not found.")
        practice_logs = store.setdefault("practiceLogs", [])
        if not isinstance(practice_logs, list):
            raise ValueError("Store is corrupted.")
        person = normalize_name(payload.get("person"))
        performance_id = clean_text(payload.get("performanceId"), 40)
        minutes = max(1, min(600, int(payload.get("minutes") or 20)))
        practiced_at_home = bool(payload.get("practicedAtHome"))
        notes = clean_text(payload.get("notes"), 180)
        if performance_id and not find_performance(store, performance_id, event_id):
            raise ValueError("Performance not found.")
        practice_logs.append(
            {
                "id": secrets.token_urlsafe(12),
                "eventId": event_id,
                "person": person,
                "performanceId": performance_id,
                "minutes": minutes,
                "practicedAtHome": practiced_at_home,
                "notes": notes,
                "createdAt": utc_now(),
            }
        )
        return {"ok": True}

    def read_json_body(self) -> dict[str, object]:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_BODY_BYTES:
            raise ValueError("Invalid request size.")
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise ValueError("Invalid JSON.") from exc
        if not isinstance(payload, dict):
            raise ValueError("JSON object expected.")
        return payload

    def get_csrf_token(self) -> str:
        cookie = SimpleCookie(self.headers.get("Cookie"))
        token = cookie.get("dance_csrf")
        if token and re.fullmatch(r"[A-Za-z0-9_-]{32,64}", token.value):
            return token.value
        token_value = secrets.token_urlsafe(32)
        self.csrf_cookie_to_set = f"dance_csrf={token_value}; HttpOnly; SameSite=Strict; Path=/"
        return token_value

    def valid_origin(self) -> bool:
        origin = self.headers.get("Origin")
        if not origin:
            return True
        return origin == f"http://{HOST}:{PORT}"

    def valid_csrf(self) -> bool:
        cookie = SimpleCookie(self.headers.get("Cookie"))
        cookie_token = cookie.get("dance_csrf")
        header_token = self.headers.get("X-CSRF-Token")
        return bool(cookie_token and header_token and secrets.compare_digest(cookie_token.value, header_token))

    def write_json(self, status: HTTPStatus, payload: dict[str, object]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if self.csrf_cookie_to_set:
            self.send_header("Set-Cookie", self.csrf_cookie_to_set)
        self.end_headers()
        self.wfile.write(body)


def main() -> int:
    ensure_store()
    server = ThreadingHTTPServer((HOST, PORT), DanceHandler)
    print(f"Event Planner app running at http://{HOST}:{PORT}/")
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
