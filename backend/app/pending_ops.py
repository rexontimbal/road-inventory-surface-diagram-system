"""DB-backed preview -> commit token store, shared by the restore-from-backup
and Excel-upload-commit flows (app/routers/backup.py, app/routers/roads.py).

Replaces the old pattern of keeping the preview's parsed payload in a plain
Python dict (`_PENDING_RESTORES`/`_PENDING_UPLOADS`) for two reasons:

1. Render's free tier can sleep/restart the app between a user previewing a
   restore and clicking Confirm a few seconds later -- an in-process dict
   doesn't survive that, a `pending_operations` row does.
2. A commit request that lands while an EARLIER commit of the exact same
   token is still running (an impatient double-click, or the user retrying
   after a confusing "expired" error) must never start a second, duplicate
   write. The old dict popped the token the instant the first request
   started, so a second request always saw it as gone and failed with
   "session expired" -- even though the first request was still correctly
   in progress and would succeed seconds later. `claim()` below makes the
   pending -> running transition an atomic, single-row UPDATE: the
   database's own row locking is the mutex, not anything held in this
   process's memory, so it's correct even across multiple worker processes
   (not something this app runs today, but nothing here assumes otherwise).
"""

import json
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import update
from sqlalchemy.orm import Session

from app.db import SessionLocal
from app.models import PendingOperation
from app.scope import Scope, owner_kwargs

# How long a freshly-created token stays claimable before it's considered
# abandoned (closed tab, user never clicked Confirm) -- matches the "~30 min"
# the user asked for, comfortably above how long anyone plausibly leaves a
# restore/upload confirmation screen open.
DEFAULT_TTL_SECONDS = 30 * 60
# How long a DONE/ERROR row is kept around after completing, purely so a
# genuinely-duplicate commit request (one that arrives after the first
# already finished) can still replay its result instead of a generic
# "not found" -- not meant to be a long-term result cache.
RESULT_RETENTION_SECONDS = 30 * 60
# How long a second request will wait, polling, for a commit it did NOT
# win the claim for to finish -- bounded well under the ~120s the frontend
# itself is allowed to wait (see RestoreBackupModal/UploadConflictModal),
# so a request that times out here still has room to report something
# meaningful rather than the browser's own fetch just hanging indefinitely.
POLL_TIMEOUT_SECONDS = 100
POLL_INTERVAL_SECONDS = 0.4


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def create_pending(db: Session, kind: str, scope: Scope, payload: dict, ttl_seconds: int = DEFAULT_TTL_SECONDS) -> str:
    """Stores `payload` (already-plain-JSON-able dict) under a fresh token
    and returns it. Called from the *_preview endpoints."""
    token = str(uuid.uuid4())
    now = _now()
    ok = owner_kwargs(scope)
    db.add(
        PendingOperation(
            token=token,
            kind=kind,
            owner_type=ok["owner_type"],
            owner_id=ok["owner_id"],
            payload_json=json.dumps(payload),
            status="pending",
            created_at=_iso(now),
            expires_at=_iso(now + timedelta(seconds=ttl_seconds)),
        )
    )
    db.commit()
    return token


def prune_expired(db: Session) -> None:
    """Deletes tokens nobody ever confirmed (still 'pending' past their TTL)
    and the result of tokens that finished a while ago (past
    RESULT_RETENTION_SECONDS) -- called opportunistically from the preview
    and commit endpoints rather than a separate background job, same
    pattern the old in-memory `_prune_pending_*` helpers used."""
    now_iso = _iso(_now())
    db.query(PendingOperation).filter(
        PendingOperation.status == "pending", PendingOperation.expires_at < now_iso
    ).delete(synchronize_session=False)
    retention_cutoff = _iso(_now() - timedelta(seconds=RESULT_RETENTION_SECONDS))
    db.query(PendingOperation).filter(
        PendingOperation.status.in_(["done", "error"]), PendingOperation.created_at < retention_cutoff
    ).delete(synchronize_session=False)
    db.commit()


@dataclass
class ClaimOutcome:
    # "claimed"   -- caller now owns this token; do the work, then call mark_done/mark_error.
    # "done"      -- already completed by an earlier request; `result` is that request's result.
    # "error"     -- an earlier attempt failed; `error_detail` is that failure's message.
    # "wait"      -- another request is actively running this token right now.
    # "not_found" -- unknown or expired token.
    status: str
    payload: dict | None = None
    result: dict | None = None
    error_detail: str | None = None


def claim(db: Session, token: str, kind: str) -> ClaimOutcome:
    """Atomically claims `token` for processing if it's still 'pending', or
    reports its current state otherwise. The UPDATE ... WHERE status='pending'
    IS the concurrency guard (see module docstring) -- exactly one caller can
    ever observe rowcount==1 for a given token, no matter how many requests
    race on it."""
    updated = db.execute(
        update(PendingOperation)
        .where(PendingOperation.token == token, PendingOperation.kind == kind, PendingOperation.status == "pending")
        .values(status="running")
    )
    db.commit()
    if updated.rowcount == 1:
        row = db.query(PendingOperation).filter_by(token=token).first()
        return ClaimOutcome(status="claimed", payload=json.loads(row.payload_json))

    row = db.query(PendingOperation).filter_by(token=token, kind=kind).first()
    if row is None:
        return ClaimOutcome(status="not_found")
    if row.status == "done":
        return ClaimOutcome(status="done", result=json.loads(row.result_json))
    if row.status == "error":
        return ClaimOutcome(status="error", error_detail=row.error_detail)
    return ClaimOutcome(status="wait")


def wait_for_result(
    token: str, timeout_s: float = POLL_TIMEOUT_SECONDS, interval_s: float = POLL_INTERVAL_SECONDS
) -> ClaimOutcome:
    """Polls (via brand-new short-lived sessions, so each read sees the
    latest COMMITTED state from whichever request is actually doing the
    work) until `token` leaves 'running', or `timeout_s` elapses. Runs
    inside a sync endpoint handler, which FastAPI already executes in a
    thread-pool thread -- blocking here does not block the event loop."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        time.sleep(interval_s)
        with SessionLocal() as s:
            row = s.query(PendingOperation).filter_by(token=token).first()
        if row is None:
            return ClaimOutcome(status="not_found")
        if row.status == "done":
            return ClaimOutcome(status="done", result=json.loads(row.result_json))
        if row.status == "error":
            return ClaimOutcome(status="error", error_detail=row.error_detail)
    return ClaimOutcome(status="wait")


def mark_done(db: Session, token: str, result: dict) -> None:
    db.query(PendingOperation).filter_by(token=token).update(
        {"status": "done", "result_json": json.dumps(result), "completed_at": _iso(_now())},
        synchronize_session=False,
    )
    db.commit()


def mark_error(db: Session, token: str, detail: str) -> None:
    db.query(PendingOperation).filter_by(token=token).update(
        {"status": "error", "error_detail": detail, "completed_at": _iso(_now())},
        synchronize_session=False,
    )
    db.commit()


def get_payload(db: Session, token: str, kind: str) -> dict | None:
    """Read-only lookup (no status change) -- used by cancel/discard flows
    that just need the pending payload for logging and don't want to affect
    a concurrently-running claim."""
    row = db.query(PendingOperation).filter_by(token=token, kind=kind).first()
    return json.loads(row.payload_json) if row is not None else None


def discard(db: Session, token: str) -> None:
    """Removes a token outright -- used when the user cancels before ever
    confirming. A no-op if it's already gone (expired, or a stale double
    call), same as the old in-memory dict's .pop(token, None)."""
    db.query(PendingOperation).filter_by(token=token).delete(synchronize_session=False)
    db.commit()
