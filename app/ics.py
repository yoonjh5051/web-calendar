"""ICS (iCalendar) import/export.

All times are stored as naive local times in APP_TZ (default Asia/Seoul).
All-day events store inclusive end dates (ICS uses exclusive DTEND).
"""
import os
import re
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from icalendar import Calendar, Event
from icalendar.prop import vRecur

APP_TZ = ZoneInfo(os.environ.get("APP_TZ", "Asia/Seoul"))


def _local(value):
    """Convert an ICS date/datetime into a naive local datetime, or keep a date."""
    if isinstance(value, datetime):
        if value.tzinfo is not None:
            value = value.astimezone(APP_TZ).replace(tzinfo=None)
        return value
    return value  # date


def _fmt(value, all_day: bool) -> str:
    if all_day:
        if isinstance(value, datetime):
            value = value.date()
        return value.strftime("%Y-%m-%d")
    if not isinstance(value, datetime):
        value = datetime.combine(value, datetime.min.time())
    return value.strftime("%Y-%m-%dT%H:%M")


def _text(comp, key) -> str:
    v = comp.get(key)
    return str(v).strip() if v is not None else ""


def _until_fixer(all_day: bool):
    def fix(m):
        raw = m.group(1)
        if "T" in raw:
            dt = datetime.strptime(raw[:15], "%Y%m%dT%H%M%S")
            if raw.endswith("Z"):
                dt = dt.replace(tzinfo=timezone.utc).astimezone(APP_TZ).replace(tzinfo=None)
            return "UNTIL=" + (dt.strftime("%Y%m%d") + "T235959" if all_day else dt.strftime("%Y%m%dT%H%M%S"))
        return "UNTIL=" + raw + "T235959"
    return fix


def _normalize_rrule(rrule: str, all_day: bool) -> str:
    # dateutil rejects UTC UNTIL with a naive DTSTART, so convert UNTIL to naive local time.
    return re.sub(r"UNTIL=([0-9TZ]+)", _until_fixer(all_day), rrule)


def _dates_of(prop):
    if prop is None:
        return []
    props = prop if isinstance(prop, list) else [prop]
    out = []
    for p in props:
        for d in getattr(p, "dts", []):
            out.append(_local(d.dt))
    return out


def parse_ics(raw: bytes):
    """Return (calendar_name, [event dicts])."""
    cal = Calendar.from_ical(raw)
    name = _text(cal, "X-WR-CALNAME")

    masters: dict[str, dict] = {}
    overrides: list[tuple[str, str, dict]] = []
    events: list[dict] = []

    for comp in cal.walk("VEVENT"):
        if comp.get("DTSTART") is None:
            continue
        if _text(comp, "STATUS").upper() == "CANCELLED":
            continue
        start = _local(comp.decoded("DTSTART"))
        all_day = not isinstance(start, datetime)

        if comp.get("DTEND") is not None:
            end = _local(comp.decoded("DTEND"))
        elif comp.get("DURATION") is not None:
            end = start + comp.decoded("DURATION")
        else:
            end = start + timedelta(days=1) if all_day else start

        if all_day:
            if isinstance(end, datetime):
                end = end.date()
            end = end - timedelta(days=1)  # exclusive -> inclusive
            if end < start:
                end = start
        else:
            if not isinstance(end, datetime):
                end = datetime.combine(end, datetime.min.time())
            if end < start:
                end = start

        rrule = None
        rr = comp.get("RRULE")
        if rr is not None:
            if isinstance(rr, list):
                rr = rr[0]
            rrule = _normalize_rrule(rr.to_ical().decode(), all_day)

        uid = _text(comp, "UID") or None
        ev = {
            "uid": uid,
            "title": _text(comp, "SUMMARY") or "(제목 없음)",
            "all_day": all_day,
            "start": _fmt(start, all_day),
            "end": _fmt(end, all_day),
            "location": _text(comp, "LOCATION"),
            "memo": _text(comp, "DESCRIPTION"),
            "rrule": rrule,
            "exdates": [_fmt(d, all_day) for d in _dates_of(comp.get("EXDATE"))] if rrule else [],
        }

        recid = comp.get("RECURRENCE-ID")
        if recid is not None and uid:
            rid = _fmt(_local(recid.dt), all_day)
            ev["uid"] = f"{uid}#{rid}"
            ev["rrule"] = None
            ev["exdates"] = []
            overrides.append((uid, rid, ev))
        elif uid:
            masters[uid] = ev
        events.append(ev)

    # A modified occurrence replaces the generated one from its series.
    for uid, rid, _ in overrides:
        master = masters.get(uid)
        if master and master["rrule"] and rid not in master["exdates"]:
            master["exdates"].append(rid)

    return name, events


def _until_to_utc(m):
    local = datetime.strptime(m.group(1), "%Y%m%dT%H%M%S").replace(tzinfo=APP_TZ)
    return "UNTIL=" + local.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def export_ics(title: str, rows: list[dict]) -> bytes:
    import json

    cal = Calendar()
    cal.add("PRODID", "-//self-hosted calendar//KO")
    cal.add("VERSION", "2.0")
    cal.add("X-WR-CALNAME", title)
    cal.add("X-WR-TIMEZONE", str(APP_TZ))
    for r in rows:
        ev = Event()
        uid = re.sub(r"^sub\d+:", "", r["uid"] or f"event-{r['id']}@calendar")
        if "#" in uid:  # modified occurrence of an imported series
            uid, rid = uid.split("#", 1)
            if len(rid) == 10:
                ev.add("RECURRENCE-ID", date.fromisoformat(rid))
            else:
                ev.add("RECURRENCE-ID", datetime.fromisoformat(rid).replace(tzinfo=APP_TZ))
        ev.add("UID", uid)
        ev.add("SUMMARY", r["title"])
        if r["all_day"]:
            s = date.fromisoformat(r["start"])
            e = date.fromisoformat(r["end"]) + timedelta(days=1)
            ev.add("DTSTART", s)
            ev.add("DTEND", e)
        else:
            s = datetime.fromisoformat(r["start"]).replace(tzinfo=APP_TZ)
            e = datetime.fromisoformat(r["end"]).replace(tzinfo=APP_TZ)
            ev.add("DTSTART", s)
            ev.add("DTEND", e)
        if r["location"]:
            ev.add("LOCATION", r["location"])
        if r["memo"]:
            ev.add("DESCRIPTION", r["memo"])
        if r["rrule"]:
            rule = r["rrule"].removeprefix("RRULE:")
            if r["all_day"]:
                rule = re.sub(r"UNTIL=(\d{8})T\d{6}Z?", r"UNTIL=\1", rule)
            else:
                rule = re.sub(r"UNTIL=(\d{8}T\d{6})(?!Z)", _until_to_utc, rule)
            ev.add("RRULE", vRecur.from_ical(rule))
            for ex in json.loads(r["exdates"] or "[]"):
                if r["all_day"]:
                    ev.add("EXDATE", date.fromisoformat(ex))
                else:
                    ev.add("EXDATE", datetime.fromisoformat(ex).replace(tzinfo=APP_TZ))
        ev.add("DTSTAMP", datetime.now(timezone.utc))
        cal.add_component(ev)
    return cal.to_ical()

