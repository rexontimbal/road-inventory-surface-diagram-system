import csv
import io
import json
from datetime import datetime, timedelta, timezone

from app.models import UploadLogEntry
from app.schemas import LogRoadDetail, UploadLogOut, UploadLogPage
from app.scope import apply_scope

_DATE_RANGE_DAYS = {"today": 1, "7d": 7, "30d": 30}


def _segment_signature(seg):
    return (seg.start_m, seg.end_m, seg.num_lanes, seg.surface_type, seg.shoulder_left, seg.shoulder_right)


def compare_segments(existing_segments, new_rows, existing_name: str, new_name: str):
    """Compares an existing road's stored segments against a freshly parsed
    plan's rows to tell "nothing actually changed" (UP_TO_DATE) apart from a
    real replace, without altering the replace/keep decision itself -- this
    only affects what gets logged. Returns (is_up_to_date, change_summary)."""
    name_changed = existing_name.strip() != new_name.strip()
    existing_sigs = [_segment_signature(s) for s in existing_segments]
    new_sigs = [_segment_signature(r) for r in new_rows]

    if existing_sigs == new_sigs and not name_changed:
        return True, None

    if existing_sigs == new_sigs:
        return False, f'Road name changed: "{existing_name}" → "{new_name}"'

    if len(existing_sigs) != len(new_sigs):
        diff = len(new_sigs) - len(existing_sigs)
        word = "added" if diff > 0 else "removed"
        summary = f"{abs(diff)} segment{'s' if abs(diff) != 1 else ''} {word} ({len(existing_sigs)} → {len(new_sigs)})"
    else:
        changed = sum(1 for a, b in zip(existing_sigs, new_sigs) if a != b)
        summary = f"{changed} segment{'s' if changed != 1 else ''} changed"
    if name_changed:
        summary += f'; road name changed: "{existing_name}" → "{new_name}"'
    return False, summary


def write_log_entry(
    db,
    *,
    kind: str,
    status: str,
    file_name: str | None = None,
    file_size: int | None = None,
    total_rows: int | None = None,
    error_message: str | None = None,
    details: list[dict] | None = None,
    owner_type: str = "workspace",
    owner_id: str = "",
    user_id: int | None = None,
    actor_name: str | None = None,
    actor_email: str | None = None,
    actor_avatar_url: str | None = None,
) -> UploadLogEntry:
    """Adds a log row to the session -- caller commits it as part of the
    same transaction as the data change it describes. owner_type/owner_id
    default to the shared workspace so every pre-existing call site (and
    any test that doesn't care about scoping) keeps working unchanged;
    real callers pass **owner_kwargs(scope), **user_kwargs(scope)."""
    details = details or []
    counts = {
        "added": 0,
        "replaced": 0,
        "kept_existing": 0,
        "up_to_date": 0,
        "rejected": 0,
        "deleted": 0,
        "edited": 0,
    }
    for d in details:
        if d["action"] in counts:
            counts[d["action"]] += 1

    entry = UploadLogEntry(
        timestamp=datetime.now(timezone.utc).isoformat(),
        kind=kind,
        status=status,
        file_name=file_name,
        file_size=file_size,
        total_rows=total_rows,
        error_message=error_message,
        added_count=counts["added"],
        replaced_count=counts["replaced"],
        kept_count=counts["kept_existing"],
        up_to_date_count=counts["up_to_date"],
        rejected_count=counts["rejected"],
        deleted_count=counts["deleted"],
        edited_count=counts["edited"],
        details_json=json.dumps(details),
        owner_type=owner_type,
        owner_id=owner_id,
        user_id=user_id,
        actor_name=actor_name,
        actor_email=actor_email,
        actor_avatar_url=actor_avatar_url,
    )
    db.add(entry)
    return entry


def _normalize_detail(d: dict) -> dict:
    """Log entries written before the road_id -> section_id rename stored
    their detail dicts with the old key -- translate on read so historical
    log entries keep displaying instead of failing LogRoadDetail validation."""
    if "section_id" not in d and "road_id" in d:
        d = {**d, "section_id": d["road_id"]}
    return d


def entry_to_out(entry: UploadLogEntry) -> UploadLogOut:
    details = [_normalize_detail(d) for d in json.loads(entry.details_json or "[]")]
    return UploadLogOut(
        id=entry.id,
        timestamp=entry.timestamp,
        kind=entry.kind,
        status=entry.status,
        file_name=entry.file_name,
        file_size=entry.file_size,
        total_rows=entry.total_rows,
        error_message=entry.error_message,
        added_count=entry.added_count,
        replaced_count=entry.replaced_count,
        kept_count=entry.kept_count,
        up_to_date_count=entry.up_to_date_count,
        rejected_count=entry.rejected_count,
        deleted_count=entry.deleted_count,
        edited_count=entry.edited_count,
        details=[LogRoadDetail(**d) for d in details],
        is_guest_action=entry.owner_type == "guest",
        user_id=entry.user_id,
        actor_name=entry.actor_name,
        actor_email=entry.actor_email,
        actor_avatar_url=entry.actor_avatar_url,
    )


def _matches_filters(
    entry: UploadLogEntry, search: str | None, action: str | None, by_user: str | None, current_user_id: int | None
) -> bool:
    details = json.loads(entry.details_json or "[]")
    if action and action != "all":
        if entry.kind == "delete":
            entry_actions = {"deleted"}
        elif entry.kind == "restore":
            entry_actions = {"restored"} | {d["action"] for d in details}
        else:
            entry_actions = {d["action"] for d in details}
        if action not in entry_actions:
            return False
    if by_user and by_user != "all":
        if by_user == "me":
            if current_user_id is None or entry.user_id != current_user_id:
                return False
        elif str(entry.user_id or "") != by_user:
            return False
    if search:
        s = search.strip().lower()
        if s:
            haystack = [entry.file_name or ""] + [
                v
                for d in details
                for v in (
                    d.get("section_id") or d.get("road_id", ""),
                    d.get("road_name", ""),
                    d.get("change_summary") or "",
                )
            ]
            if not any(s in h.lower() for h in haystack):
                return False
    return True


def _filtered_entries(db, *, scope, search, action, date_range, by_user=None):
    query = apply_scope(db.query(UploadLogEntry), UploadLogEntry, scope).order_by(UploadLogEntry.timestamp.desc())
    days = _DATE_RANGE_DAYS.get(date_range) if date_range else None
    if days:
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        # timestamp is stored as ISO-8601 text; lexical comparison matches
        # chronological order for a fixed-width ISO format.
        query = query.filter(UploadLogEntry.timestamp >= cutoff.isoformat())
    return [e for e in query.all() if _matches_filters(e, search, action, by_user, scope.user_id)]


def query_log(db, *, scope, search=None, action=None, date_range=None, by_user=None, page=1, page_size=10) -> UploadLogPage:
    filtered = _filtered_entries(db, scope=scope, search=search, action=action, date_range=date_range, by_user=by_user)
    total_records = len(filtered)
    total_pages = max(1, (total_records + page_size - 1) // page_size)
    start = (page - 1) * page_size
    page_rows = filtered[start : start + page_size]
    return UploadLogPage(
        page=page,
        page_size=page_size,
        total_pages=total_pages,
        total_records=total_records,
        entries=[entry_to_out(e) for e in page_rows],
    )


def list_log_users(db, *, scope) -> list[dict]:
    """Distinct {user_id, name} pairs that actually appear in this scope's
    log, for the "BY" filter dropdown -- keeps the list short and relevant
    instead of every account that's ever signed in."""
    rows = (
        apply_scope(db.query(UploadLogEntry.user_id, UploadLogEntry.actor_name), UploadLogEntry, scope)
        .filter(UploadLogEntry.user_id.isnot(None))
        .distinct()
        .all()
    )
    seen = {}
    for user_id, name in rows:
        seen[user_id] = name
    return [{"user_id": uid, "name": name} for uid, name in sorted(seen.items(), key=lambda kv: (kv[1] or "").lower())]


def export_log_csv(db, *, scope, search=None, action=None, date_range=None, by_user=None) -> str:
    filtered = _filtered_entries(db, scope=scope, search=search, action=action, date_range=date_range, by_user=by_user)

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(
        [
            "Timestamp",
            "Kind",
            "Status",
            "File",
            "By",
            "By Email",
            "Section ID",
            "Road Name",
            "Action",
            "Segments",
            "Change Summary",
            "Rejection Reasons",
        ]
    )
    for entry in filtered:
        details = json.loads(entry.details_json or "[]")
        rows = details or [{}]
        by_name = entry.actor_name or ("Guest" if entry.owner_type == "guest" else "Unknown")
        for d in rows:
            writer.writerow(
                [
                    entry.timestamp,
                    entry.kind,
                    entry.status,
                    entry.file_name or "",
                    by_name,
                    entry.actor_email or "",
                    d.get("section_id") or d.get("road_id", ""),
                    d.get("road_name", ""),
                    d.get("action", ""),
                    d.get("segment_count", ""),
                    d.get("change_summary") or "",
                    "; ".join(d.get("rejection_reasons") or []),
                ]
            )
    return buffer.getvalue()
