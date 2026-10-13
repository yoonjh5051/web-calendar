import asyncio
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import time
import urllib.request
from contextlib import asynccontextmanager, contextmanager
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Optional

from dateutil.rrule import rrulestr
from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator
from starlette.middleware.sessions import SessionMiddleware

from ics import APP_TZ, export_ics, parse_ics

BASE_DIR = Path(__file__).parent
STATIC_DIR = BASE_DIR / "static"
DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "calendar.db"

ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
PUBLIC_VIEW = os.environ.get("PUBLIC_VIEW", "true").lower() in ("1", "true", "yes")
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "false").lower() in ("1", "true", "yes")
APP_TITLE = os.environ.get("APP_TITLE", "My Calendar")

if not ADMIN_PASSWORD:
    ADMIN_PASSWORD = secrets.token_urlsafe(12)
    print(f"[calendar] ADMIN_PASSWORD is not set. Temporary password for '{ADMIN_USERNAME}': {ADMIN_PASSWORD}", flush=True)


def load_secret_key() -> str:
    env = os.environ.get("SECRET_KEY")
    if env:
        return env
    path = DATA_DIR / ".secret_key"
    if path.exists():
        return path.read_text().strip()
    key = secrets.token_urlsafe(48)
    path.write_text(key)
    return key


# ---------------------------------------------------------------- database

SCHEMA = """
CREATE TABLE IF NOT EXISTS calendars (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    calendar_id INTEGER NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    all_day INTEGER NOT NULL DEFAULT 0,
    start TEXT NOT NULL,
    end TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT '',
    memo TEXT NOT NULL DEFAULT '',
    rrule TEXT,
    exdates TEXT NOT NULL DEFAULT '[]',
    uid TEXT UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_range ON events(start, end);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    calendar_id INTEGER NOT NULL UNIQUE REFERENCES calendars(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    interval_minutes INTEGER NOT NULL DEFAULT 60,
    last_attempt_at TEXT,
    last_synced_at TEXT,
    last_error TEXT,
    event_count INTEGER NOT NULL DEFAULT 0
);
"""


@contextmanager
def db():
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with db() as conn:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(SCHEMA)
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(events)")}
        if "color" not in cols:
            conn.execute("ALTER TABLE events ADD COLUMN color TEXT")


init_db()


def get_setting(key: str, default: str = "") -> str:
    with db() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(key: str, value: str):
    with db() as conn:
        conn.execute("INSERT INTO settings (key, value) VALUES (?, ?) "
                     "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, value))


def hide_past_enabled() -> bool:
    return get_setting("hide_past", "0") == "1"

# ---------------------------------------------------------------- app & auth

@asynccontextmanager
async def lifespan(_app):
    bootstrap_calendars()
    task = asyncio.create_task(subscription_loop())
    yield
    task.cancel()


app = FastAPI(title=APP_TITLE, docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
app.add_middleware(
    SessionMiddleware,
    secret_key=load_secret_key(),
    session_cookie="cal_session",
    max_age=60 * 60 * 24 * 30,
    same_site="lax",
    https_only=COOKIE_SECURE,
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

_failed: dict[str, list[float]] = {}
LOCK_WINDOW = 300
MAX_FAILS = 5


def is_authed(request: Request) -> bool:
    return request.session.get("user") == ADMIN_USERNAME


def require_auth(request: Request):
    if not is_authed(request):
        raise HTTPException(401, "로그인이 필요합니다.")


def require_view(request: Request):
    if not PUBLIC_VIEW and not is_authed(request):
        raise HTTPException(401, "로그인이 필요합니다.")


@app.get("/")
def index(request: Request):
    if not PUBLIC_VIEW and not is_authed(request):
        return RedirectResponse("/login", status_code=302)
    return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/login")
def login_page(request: Request):
    if is_authed(request):
        return RedirectResponse("/", status_code=302)
    return FileResponse(STATIC_DIR / "login.html", headers={"Cache-Control": "no-cache"})


class LoginBody(BaseModel):
    username: str
    password: str


@app.post("/api/login")
def login(body: LoginBody, request: Request):
    ip = request.client.host if request.client else "?"
    now = time.time()
    fails = [t for t in _failed.get(ip, []) if now - t < LOCK_WINDOW]
    if len(fails) >= MAX_FAILS:
        raise HTTPException(429, "로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.")
    ok_user = hmac.compare_digest(body.username.encode(), ADMIN_USERNAME.encode())
    ok_pass = hmac.compare_digest(body.password.encode(), ADMIN_PASSWORD.encode())
    if not (ok_user and ok_pass):
        fails.append(now)
        _failed[ip] = fails
        time.sleep(0.5)
        raise HTTPException(401, "아이디 또는 비밀번호가 올바르지 않습니다.")
    _failed.pop(ip, None)
    request.session.clear()
    request.session["user"] = ADMIN_USERNAME
    return {"ok": True}


@app.post("/api/logout")
def logout(request: Request):
    request.session.clear()
    return {"ok": True}


@app.get("/api/me")
def me(request: Request):
    return {"authenticated": is_authed(request), "title": APP_TITLE, "public_view": PUBLIC_VIEW,
            "hide_past": hide_past_enabled()}


class SettingsBody(BaseModel):
    hide_past: bool


@app.put("/api/settings", dependencies=[Depends(require_auth)])
def update_settings(body: SettingsBody):
    set_setting("hide_past", "1" if body.hide_past else "0")
    return {"hide_past": body.hide_past}


# ---------------------------------------------------------------- past-event masking (for visitors)

def should_mask(request: Request) -> bool:
    return not is_authed(request) and hide_past_enabled()


def today_str() -> str:
    return datetime.now(APP_TZ).date().isoformat()


def last_day(ev: dict) -> str:
    """Last calendar day an event occupies (a timed event ending at 00:00 doesn't count the next day)."""
    sd, ed = ev["start"][:10], ev["end"][:10]
    if not ev["all_day"] and ed > sd and ev["end"][11:16] == "00:00":
        ed = (date.fromisoformat(ed) - timedelta(days=1)).isoformat()
    return ed


def is_past(ev: dict, today: str) -> bool:
    return last_day(ev) < today


def mask(ev: dict) -> dict:
    """Keep only when it happened: no title, place, notes, or identifiers."""
    ev.update(title="", location="", memo="", uid=None, rrule=None, exdates=[], masked=True)
    return ev


# ---------------------------------------------------------------- calendars

class CalendarBody(BaseModel):
    name: str = Field(min_length=1, max_length=50)
    color: str = Field(pattern=r"^#[0-9A-Fa-f]{6}$")


@app.get("/api/calendars", dependencies=[Depends(require_view)])
def list_calendars(request: Request):
    authed = is_authed(request)
    with db() as conn:
        rows = conn.execute(
            "SELECT c.*, (SELECT COUNT(*) FROM events e WHERE e.calendar_id = c.id) AS event_count, "
            "s.id AS sub_id, s.url AS sub_url, s.interval_minutes AS sub_interval, "
            "s.last_synced_at AS sub_synced_at, s.last_error AS sub_error "
            "FROM calendars c LEFT JOIN subscriptions s ON s.calendar_id = c.id ORDER BY c.id"
        ).fetchall()
    out = []
    for r in rows:
        cal = {k: r[k] for k in ("id", "name", "color", "created_at", "event_count")}
        if r["sub_id"]:
            cal["subscription"] = {
                "id": r["sub_id"],
                "interval_minutes": r["sub_interval"],
                "last_synced_at": r["sub_synced_at"],
                "last_error": r["sub_error"],
            }
            if authed:  # feed URLs often embed a private token
                cal["subscription"]["url"] = r["sub_url"]
        else:
            cal["subscription"] = None
        out.append(cal)
    return out


@app.post("/api/calendars", dependencies=[Depends(require_auth)])
def create_calendar(body: CalendarBody):
    with db() as conn:
        cur = conn.execute("INSERT INTO calendars (name, color) VALUES (?, ?)", (body.name, body.color))
        return {"id": cur.lastrowid, "name": body.name, "color": body.color}


@app.put("/api/calendars/{cal_id}", dependencies=[Depends(require_auth)])
def update_calendar(cal_id: int, body: CalendarBody):
    with db() as conn:
        cur = conn.execute("UPDATE calendars SET name = ?, color = ? WHERE id = ?", (body.name, body.color, cal_id))
        if cur.rowcount == 0:
            raise HTTPException(404, "캘린더를 찾을 수 없습니다.")
    return {"ok": True}


@app.delete("/api/calendars/{cal_id}", dependencies=[Depends(require_auth)])
def delete_calendar(cal_id: int):
    with db() as conn:
        if conn.execute("SELECT COUNT(*) FROM calendars").fetchone()[0] <= 1:
            raise HTTPException(400, "마지막 캘린더는 삭제할 수 없습니다.")
        conn.execute("DELETE FROM calendars WHERE id = ?", (cal_id,))
    return {"ok": True}


# ---------------------------------------------------------------- events

def parse_point(value: str, all_day: bool) -> datetime:
    return datetime.fromisoformat(value + "T00:00" if all_day else value)


def fmt_point(value: datetime, all_day: bool) -> str:
    return value.strftime("%Y-%m-%d") if all_day else value.strftime("%Y-%m-%dT%H:%M")


class EventBody(BaseModel):
    calendar_id: int
    title: str = Field(min_length=1, max_length=200)
    all_day: bool = False
    start: str
    end: str
    location: str = Field(default="", max_length=300)
    memo: str = Field(default="", max_length=5000)
    rrule: Optional[str] = Field(default=None, max_length=500)
    color: Optional[str] = Field(default=None, pattern=r"^#[0-9A-Fa-f]{6}$")

    @field_validator("rrule")
    @classmethod
    def check_rrule(cls, v):
        if v in (None, ""):
            return None
        v = v.removeprefix("RRULE:")
        try:
            rrulestr(v, dtstart=datetime(2000, 1, 1))
        except Exception:
            raise ValueError("잘못된 반복 규칙입니다.")
        return v

    def normalized(self):
        try:
            s = parse_point(self.start[:10] if self.all_day else self.start[:16], self.all_day)
            e = parse_point(self.end[:10] if self.all_day else self.end[:16], self.all_day)
        except ValueError:
            raise HTTPException(422, "날짜 형식이 올바르지 않습니다.")
        if e < s:
            raise HTTPException(422, "종료 시간이 시작 시간보다 빠릅니다.")
        return fmt_point(s, self.all_day), fmt_point(e, self.all_day)


def row_to_event(row, calendars) -> dict:
    ev = dict(row)
    ev["all_day"] = bool(ev["all_day"])
    ev["exdates"] = json.loads(ev["exdates"] or "[]")
    cal = calendars.get(ev["calendar_id"])
    ev["event_color"] = ev.get("color")
    ev["color"] = ev.get("color") or (cal["color"] if cal else "#999999")
    ev["calendar_name"] = cal["name"] if cal else ""
    return ev


def expand(ev: dict, range_start: datetime, range_end: datetime) -> list[dict]:
    all_day = ev["all_day"]
    start = parse_point(ev["start"], all_day)
    end = parse_point(ev["end"], all_day)
    # all-day ends are inclusive dates; treat as end-of-day for overlap checks
    span = (end - start) + (timedelta(days=1) if all_day else timedelta(0))

    if not ev.get("rrule"):
        return [dict(ev, occurrence=ev["start"])]

    try:
        rs = rrulestr(ev["rrule"], dtstart=start, forceset=True)
        for ex in ev["exdates"]:
            try:
                rs.exdate(parse_point(ex, all_day))
            except ValueError:
                pass
        occs = rs.between(range_start - span, range_end, inc=True)[:1000]
    except Exception:
        occs = [start]

    out = []
    for occ in occs:
        occ_end_excl = occ + span
        if occ_end_excl <= range_start and not (span == timedelta(0) and occ == range_start):
            continue
        if occ >= range_end:
            continue
        occ_end = occ + (end - start)
        out.append(dict(
            ev,
            start=fmt_point(occ, all_day),
            end=fmt_point(occ_end, all_day),
            occurrence=fmt_point(occ, all_day),
        ))
    return out


@app.get("/api/events", dependencies=[Depends(require_view)])
def list_events(start: str, end: str, request: Request):
    try:
        rstart = datetime.fromisoformat(start[:10])
        rend = datetime.fromisoformat(end[:10])
    except ValueError:
        raise HTTPException(422, "start/end 는 YYYY-MM-DD 형식이어야 합니다.")
    with db() as conn:
        calendars = {r["id"]: dict(r) for r in conn.execute("SELECT * FROM calendars")}
        rows = conn.execute(
            "SELECT * FROM events WHERE "
            "(rrule IS NULL AND start < ? AND end >= ?) OR (rrule IS NOT NULL AND start < ?)",
            (end[:10], start[:10], end[:10]),
        ).fetchall()
    result = []
    for row in rows:
        result.extend(expand(row_to_event(row, calendars), rstart, rend))
    if should_mask(request):
        today = today_str()
        result = [mask(e) if is_past(e, today) else e for e in result]
    result.sort(key=lambda e: (e["start"], not e["all_day"], e["title"]))
    return result


@app.get("/api/search", dependencies=[Depends(require_view)])
def search_events(q: str, request: Request):
    q = q.strip()
    if not q:
        return []
    like = f"%{q}%"
    with db() as conn:
        calendars = {r["id"]: dict(r) for r in conn.execute("SELECT * FROM calendars")}
        rows = conn.execute(
            "SELECT * FROM events WHERE title LIKE ? OR location LIKE ? OR memo LIKE ? ORDER BY start DESC LIMIT 100",
            (like, like, like),
        ).fetchall()
    result = [row_to_event(r, calendars) for r in rows]
    if should_mask(request):
        today = today_str()
        result = [e for e in result if e["rrule"] or not is_past(e, today)]
    return result


@app.get("/api/events/{event_id}", dependencies=[Depends(require_view)])
def get_event(event_id: int, request: Request):
    with db() as conn:
        calendars = {r["id"]: dict(r) for r in conn.execute("SELECT * FROM calendars")}
        row = conn.execute("SELECT * FROM events WHERE id = ?", (event_id,)).fetchone()
    if not row:
        raise HTTPException(404, "일정을 찾을 수 없습니다.")
    ev = row_to_event(row, calendars)
    if should_mask(request) and not ev["rrule"] and is_past(ev, today_str()):
        mask(ev)
    return ev


def ensure_calendar(conn, cal_id: int):
    if not conn.execute("SELECT 1 FROM calendars WHERE id = ?", (cal_id,)).fetchone():
        raise HTTPException(422, "존재하지 않는 캘린더입니다.")
    if conn.execute("SELECT 1 FROM subscriptions WHERE calendar_id = ?", (cal_id,)).fetchone():
        raise HTTPException(400, "구독 캘린더의 일정은 원본에서만 수정할 수 있습니다.")


def ensure_event_writable(conn, event_id: int):
    row = conn.execute(
        "SELECT e.id, s.id AS sub FROM events e LEFT JOIN subscriptions s ON s.calendar_id = e.calendar_id "
        "WHERE e.id = ?", (event_id,)).fetchone()
    if not row:
        raise HTTPException(404, "일정을 찾을 수 없습니다.")
    if row["sub"]:
        raise HTTPException(400, "구독 캘린더의 일정은 원본에서만 수정할 수 있습니다.")


@app.post("/api/events", dependencies=[Depends(require_auth)])
def create_event(body: EventBody):
    s, e = body.normalized()
    with db() as conn:
        ensure_calendar(conn, body.calendar_id)
        cur = conn.execute(
            "INSERT INTO events (calendar_id, title, all_day, start, end, location, memo, rrule, color) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (body.calendar_id, body.title, int(body.all_day), s, e, body.location, body.memo, body.rrule, body.color),
        )
    return {"id": cur.lastrowid}


@app.put("/api/events/{event_id}", dependencies=[Depends(require_auth)])
def update_event(event_id: int, body: EventBody):
    s, e = body.normalized()
    with db() as conn:
        ensure_calendar(conn, body.calendar_id)
        ensure_event_writable(conn, event_id)
        old = conn.execute("SELECT all_day, rrule FROM events WHERE id = ?", (event_id,)).fetchone()
        if not old:
            raise HTTPException(404, "일정을 찾을 수 없습니다.")
        reset_ex = bool(old["all_day"]) != body.all_day or old["rrule"] != body.rrule
        conn.execute(
            "UPDATE events SET calendar_id=?, title=?, all_day=?, start=?, end=?, location=?, memo=?, rrule=?, color=?, "
            "exdates = CASE WHEN ? THEN '[]' ELSE exdates END, updated_at=datetime('now') WHERE id=?",
            (body.calendar_id, body.title, int(body.all_day), s, e, body.location, body.memo, body.rrule, body.color,
             int(reset_ex), event_id),
        )
    return {"ok": True}


@app.delete("/api/events/{event_id}", dependencies=[Depends(require_auth)])
def delete_event(event_id: int, occurrence: Optional[str] = None):
    """Delete the whole event, or only one occurrence of a recurring event."""
    with db() as conn:
        ensure_event_writable(conn, event_id)
        row = conn.execute("SELECT rrule, exdates FROM events WHERE id = ?", (event_id,)).fetchone()
        if not row:
            raise HTTPException(404, "일정을 찾을 수 없습니다.")
        if occurrence and row["rrule"]:
            ex = json.loads(row["exdates"] or "[]")
            if occurrence not in ex:
                ex.append(occurrence)
            conn.execute("UPDATE events SET exdates = ?, updated_at=datetime('now') WHERE id = ?",
                         (json.dumps(ex), event_id))
        else:
            conn.execute("DELETE FROM events WHERE id = ?", (event_id,))
    return {"ok": True}


# ---------------------------------------------------------------- ics

MAX_ICS_BYTES = 10 * 1024 * 1024


SEED_DIR = Path(os.environ.get("SEED_DIR", BASE_DIR / "seed"))


def bootstrap_calendars():
    """On a fresh database, import seed/*.ics (one calendar per file); otherwise create an empty calendar."""
    with db() as conn:
        if conn.execute("SELECT COUNT(*) FROM calendars").fetchone()[0] > 0:
            return
        seeded = 0
        for path in sorted(SEED_DIR.glob("*.ics")) if SEED_DIR.is_dir() else []:
            try:
                raw = path.read_bytes()
                cal_name, events = parse_ics(raw)
            except Exception as exc:
                print(f"[calendar] seed {path.name} skipped: {exc}", flush=True)
                continue
            m = re.search(rb"X-APPLE-CALENDAR-COLOR:(#[0-9A-Fa-f]{6})", raw)
            color = m.group(1).decode() if m else "#5B8DEF"
            cal_id = conn.execute("INSERT INTO calendars (name, color) VALUES (?, ?)",
                                  ((cal_name or path.stem)[:50], color)).lastrowid
            created, _ = upsert_events(conn, cal_id, events)
            seeded += 1
            print(f"[calendar] seeded '{cal_name or path.stem}' with {created} events from {path.name}", flush=True)
        if not seeded:
            conn.execute("INSERT INTO calendars (name, color) VALUES (?, ?)", ("내 캘린더", "#5B8DEF"))


def upsert_events(conn, cal_id: int, events: list[dict], uid_prefix: str = "") -> tuple[int, int]:
    created = updated = 0
    for ev in events:
        uid = uid_prefix + ev["uid"] if ev["uid"] else None
        exists = uid and conn.execute("SELECT id FROM events WHERE uid = ?", (uid,)).fetchone()
        values = (cal_id, ev["title"], int(ev["all_day"]), ev["start"], ev["end"], ev["location"],
                  ev["memo"], ev["rrule"], json.dumps(ev["exdates"]))
        if exists:
            conn.execute(
                "UPDATE events SET calendar_id=?, title=?, all_day=?, start=?, end=?, location=?, memo=?, "
                "rrule=?, exdates=?, updated_at=datetime('now') WHERE id=?",
                values + (exists["id"],),
            )
            updated += 1
        else:
            conn.execute(
                "INSERT INTO events (calendar_id, title, all_day, start, end, location, memo, rrule, exdates, uid) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                values + (uid,),
            )
            created += 1
    return created, updated


@app.post("/api/import", dependencies=[Depends(require_auth)])
async def import_ics(file: UploadFile = File(...), calendar_id: str = Form("new"), color: str = Form("#F5A623")):
    raw = await file.read(MAX_ICS_BYTES + 1)
    if len(raw) > MAX_ICS_BYTES:
        raise HTTPException(413, "파일이 너무 큽니다 (최대 10MB).")
    try:
        cal_name, events = parse_ics(raw)
    except Exception as exc:
        raise HTTPException(422, f"ICS 파일을 읽을 수 없습니다: {exc}")
    if not events:
        raise HTTPException(422, "가져올 일정이 없습니다.")

    with db() as conn:
        if calendar_id == "new":
            name = (cal_name or Path(file.filename or "가져온 캘린더").stem or "가져온 캘린더")[:50]
            if not re.fullmatch(r"#[0-9A-Fa-f]{6}", color):
                color = "#F5A623"
            # re-importing the same file reuses its calendar instead of creating a duplicate
            same = conn.execute(
                "SELECT id FROM calendars WHERE name = ? AND id NOT IN (SELECT calendar_id FROM subscriptions)",
                (name,)).fetchone()
            if same:
                cal_id = same["id"]
            else:
                cal_id = conn.execute("INSERT INTO calendars (name, color) VALUES (?, ?)", (name, color)).lastrowid
        else:
            try:
                cal_id = int(calendar_id)
            except ValueError:
                raise HTTPException(422, "잘못된 캘린더입니다.")
            ensure_calendar(conn, cal_id)

        created, updated = upsert_events(conn, cal_id, events)
    return {"created": created, "updated": updated, "calendar_id": cal_id}


# ---------------------------------------------------------------- subscriptions

SYNC_INTERVALS = (15, 30, 60, 180, 360, 720, 1440)


def normalize_feed_url(url: str) -> str:
    url = url.strip()
    if url.lower().startswith("webcal://"):
        url = "https://" + url[9:]
    if not re.match(r"^https?://[^\s/]+", url, re.I):
        raise HTTPException(422, "http(s):// 또는 webcal:// 주소를 입력하세요.")
    return url


def fetch_feed(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "SelfHostedCalendar/1.0", "Accept": "text/calendar, */*"})
    with urllib.request.urlopen(req, timeout=30) as res:
        data = res.read(MAX_ICS_BYTES + 1)
    if len(data) > MAX_ICS_BYTES:
        raise ValueError("피드가 너무 큽니다 (최대 10MB).")
    return data


def error_text(exc: Exception) -> str:
    return (str(getattr(exc, "reason", None) or exc) or exc.__class__.__name__)[:300]


def sync_subscription(sub_id: int) -> dict:
    """Download a feed and make its calendar mirror it exactly. Raises on failure (after recording the error)."""
    with db() as conn:
        sub = conn.execute("SELECT * FROM subscriptions WHERE id = ?", (sub_id,)).fetchone()
        if not sub:
            raise HTTPException(404, "구독을 찾을 수 없습니다.")
        conn.execute("UPDATE subscriptions SET last_attempt_at = datetime('now') WHERE id = ?", (sub_id,))
    try:
        _, events = parse_ics(fetch_feed(sub["url"]))
    except Exception as exc:
        with db() as conn:
            conn.execute("UPDATE subscriptions SET last_error = ? WHERE id = ?", (error_text(exc), sub_id))
        print(f"[calendar] subscription {sub_id} sync failed: {error_text(exc)}", flush=True)
        raise

    for ev in events:  # feeds without UIDs still need stable keys to avoid churn
        if not ev["uid"]:
            ev["uid"] = "nouid-" + hashlib.sha1(f'{ev["title"]}|{ev["start"]}|{ev["end"]}'.encode()).hexdigest()
    prefix = f"sub{sub_id}:"
    cal_id = sub["calendar_id"]
    with db() as conn:
        created, updated = upsert_events(conn, cal_id, events, prefix)
        keep = {prefix + ev["uid"] for ev in events}
        stale = [r["id"] for r in conn.execute("SELECT id, uid FROM events WHERE calendar_id = ?", (cal_id,))
                 if r["uid"] not in keep]
        conn.executemany("DELETE FROM events WHERE id = ?", [(i,) for i in stale])
        conn.execute(
            "UPDATE subscriptions SET last_synced_at = datetime('now'), last_error = NULL, event_count = ? WHERE id = ?",
            (len(keep), sub_id))
    return {"created": created, "updated": updated, "deleted": len(stale)}


async def subscription_loop():
    while True:
        try:
            with db() as conn:
                due = [r["id"] for r in conn.execute(
                    "SELECT id FROM subscriptions WHERE last_attempt_at IS NULL "
                    "OR datetime(last_attempt_at, '+' || interval_minutes || ' minutes') <= datetime('now')")]
            for sub_id in due:
                try:
                    await asyncio.to_thread(sync_subscription, sub_id)
                except Exception:
                    pass  # already recorded on the subscription
        except Exception as exc:
            print(f"[calendar] subscription loop error: {exc}", flush=True)
        await asyncio.sleep(60)


def check_interval(v: int) -> int:
    if v not in SYNC_INTERVALS:
        raise ValueError("지원하지 않는 동기화 주기입니다.")
    return v


class SubscriptionBody(BaseModel):
    url: str = Field(min_length=8, max_length=2000)
    name: Optional[str] = Field(default=None, max_length=50)
    color: str = Field(default="#4FB3E8", pattern=r"^#[0-9A-Fa-f]{6}$")
    interval_minutes: int = 60

    _interval = field_validator("interval_minutes")(check_interval)


class SubscriptionUpdate(BaseModel):
    url: str = Field(min_length=8, max_length=2000)
    interval_minutes: int

    _interval = field_validator("interval_minutes")(check_interval)


@app.post("/api/subscriptions", dependencies=[Depends(require_auth)])
async def create_subscription(body: SubscriptionBody):
    url = normalize_feed_url(body.url)
    try:
        cal_name, _ = parse_ics(await asyncio.to_thread(fetch_feed, url))
    except Exception as exc:
        raise HTTPException(422, f"ICS 주소를 불러올 수 없습니다: {error_text(exc)}")
    name = (body.name or "").strip() or cal_name or "구독 캘린더"
    with db() as conn:
        cal_id = conn.execute("INSERT INTO calendars (name, color) VALUES (?, ?)", (name[:50], body.color)).lastrowid
        sub_id = conn.execute(
            "INSERT INTO subscriptions (calendar_id, url, interval_minutes) VALUES (?, ?, ?)",
            (cal_id, url, body.interval_minutes)).lastrowid
    try:
        result = await asyncio.to_thread(sync_subscription, sub_id)
    except Exception as exc:
        raise HTTPException(502, f"구독은 추가됐지만 첫 동기화에 실패했습니다: {error_text(exc)}")
    return {"calendar_id": cal_id, "subscription_id": sub_id, **result}


@app.put("/api/subscriptions/{sub_id}", dependencies=[Depends(require_auth)])
def update_subscription(sub_id: int, body: SubscriptionUpdate):
    url = normalize_feed_url(body.url)
    with db() as conn:
        cur = conn.execute(
            "UPDATE subscriptions SET interval_minutes = ?, "
            "last_attempt_at = CASE WHEN url = ? THEN last_attempt_at ELSE NULL END, url = ? WHERE id = ?",
            (body.interval_minutes, url, url, sub_id))
        if cur.rowcount == 0:
            raise HTTPException(404, "구독을 찾을 수 없습니다.")
    return {"ok": True}


@app.post("/api/subscriptions/{sub_id}/sync", dependencies=[Depends(require_auth)])
async def sync_now(sub_id: int):
    try:
        return await asyncio.to_thread(sync_subscription, sub_id)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(502, f"동기화 실패: {error_text(exc)}")


@app.get("/api/export.ics", dependencies=[Depends(require_view)])
def export(request: Request, calendar_id: Optional[int] = None):
    with db() as conn:
        if calendar_id:
            rows = conn.execute("SELECT * FROM events WHERE calendar_id = ?", (calendar_id,)).fetchall()
        else:
            rows = conn.execute("SELECT * FROM events").fetchall()
    rows = [dict(r) for r in rows]
    if should_mask(request):
        today = today_str()
        for r in rows:
            if not r["rrule"] and is_past(r, today):
                r.update(title="일정", location="", memo="", uid=None)
    data = export_ics(APP_TITLE, rows)
    return Response(
        data,
        media_type="text/calendar; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="calendar.ics"'},
    )


@app.exception_handler(HTTPException)
async def http_error(request: Request, exc: HTTPException):
    return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)
