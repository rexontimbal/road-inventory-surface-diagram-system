"""Covers the restore/upload reliability fix for the Render + Neon bug
report: a slow commit (large inserts over the network) racing a second
request for the same preview token used to pop its single-use slot
immediately and report "session expired" even though the first request
was quietly still succeeding. The fix replaces the in-process
`_PENDING_RESTORES`/`_PENDING_UPLOADS` dicts with a DB-backed
`pending_operations` table (app/pending_ops.py) whose pending -> running ->
done transitions are the concurrency guard, so:

- the token survives a process restart (it was never only in memory), and
- a second commit for an already-claimed/already-done token replays the
  real result instead of erroring.
"""

import threading
import time

from app.db import SessionLocal
from app.models import PendingOperation


def test_restore_commit_twice_same_token_is_idempotent(client, make_user, as_user, upload_fixture_as):
    source_owner = make_user("Owner-RestoreSrc", "owner-restoresrc-test@example.com")
    upload_fixture_as(source_owner)
    target_owner = make_user("Owner-RestoreIdem", "owner-restoreidem-test@example.com")

    with as_user(source_owner):
        backup = client.get("/api/backup/export").json()

    with as_user(target_owner):
        preview_res = client.post("/api/backup/restore/preview", json={"backup": backup})
        assert preview_res.status_code == 200, preview_res.text
        token = preview_res.json()["token"]

        first = client.post("/api/backup/restore/commit", json={"token": token, "mode": "merge", "decisions": {}})
        assert first.status_code == 200, first.text
        first_body = first.json()
        assert first_body["added"] > 0
        count_after_first = len(client.get("/api/roads").json())

        # Same token, second request -- must replay the exact same result,
        # not "session expired", and must not insert anything a second time.
        second = client.post("/api/backup/restore/commit", json={"token": token, "mode": "merge", "decisions": {}})
        assert second.status_code == 200, second.text
        assert second.json() == first_body

        count_after_second = len(client.get("/api/roads").json())
        assert count_after_second == count_after_first


def test_upload_commit_twice_same_token_is_idempotent(client, make_user, as_user):
    from pathlib import Path

    owner = make_user("Owner-UploadIdem", "owner-uploadidem-test@example.com")
    fixture = Path(__file__).resolve().parent / "fixtures" / "dpwh_sample.xlsx"

    with as_user(owner):
        with fixture.open("rb") as fh:
            preview_res = client.post(
                "/api/roads/upload/preview",
                files={"file": ("dpwh_sample.xlsx", fh, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
            )
        assert preview_res.status_code == 200, preview_res.text
        token = preview_res.json()["token"]

        first = client.post("/api/roads/upload/commit", json={"token": token, "decisions": {}})
        assert first.status_code == 200, first.text
        first_body = first.json()
        count_after_first = len(client.get("/api/roads").json())

        second = client.post("/api/roads/upload/commit", json={"token": token, "decisions": {}})
        assert second.status_code == 200, second.text
        assert second.json() == first_body

        count_after_second = len(client.get("/api/roads").json())
        assert count_after_second == count_after_first


def test_restore_pending_session_is_in_the_database_not_memory(client, make_user, as_user, upload_fixture_as):
    """The core of the fix: a brand-new SessionLocal(), entirely outside the
    request that created the token, can read it straight from the table --
    proving it survives independently of any process-local state (what a
    Render free-tier sleep/restart would otherwise wipe)."""
    owner = make_user("Owner-RestoreDB", "owner-restoredb-test@example.com")
    upload_fixture_as(owner)

    with as_user(owner):
        backup = client.get("/api/backup/export").json()
        preview_res = client.post("/api/backup/restore/preview", json={"backup": backup})
        token = preview_res.json()["token"]

    with SessionLocal() as db:
        row = db.query(PendingOperation).filter_by(token=token, kind="restore").first()
        assert row is not None
        assert row.status == "pending"
        assert row.payload_json  # the full backup payload is really there, not just a reference

    # ... and the commit endpoint still works afterward, reading nothing
    # but that row -- equivalent to the app having restarted in between.
    with as_user(owner):
        commit_res = client.post(
            "/api/backup/restore/commit", json={"token": token, "mode": "replace_all", "decisions": {}}
        )
        assert commit_res.status_code == 200, commit_res.text


def test_claim_wait_path_replays_result_instead_of_expiring():
    """Unit-level test of pending_ops.claim()/wait_for_result()'s "wait"
    branch -- what the restore/upload commit routes fall into when a second
    request arrives for a token an earlier request already claimed. This is
    the exact mechanism that stops a double-click (or a user retrying after
    the old "session expired" error) from ever seeing anything but the real
    result, instead of racing the single-use token pop the old in-memory
    dict did."""
    from app import pending_ops
    from app.scope import Scope

    db = SessionLocal()
    try:
        scope = Scope(owner_type="guest", owner_id="pending-ops-test-guest", is_guest=True)
        token = pending_ops.create_pending(db, "restore", scope, {"hello": "world"})

        first_claim = pending_ops.claim(db, token, "restore")
        assert first_claim.status == "claimed"
        assert first_claim.payload == {"hello": "world"}

        # A second request for the SAME token while the first is still
        # "running" must never see it as missing/expired.
        second_claim = pending_ops.claim(db, token, "restore")
        assert second_claim.status == "wait"

        canned_result = {"added": 42, "replaced": 0, "kept": 0, "total_roads": 42}

        def finish_later():
            time.sleep(0.3)
            with SessionLocal() as s:
                pending_ops.mark_done(s, token, canned_result)

        t = threading.Thread(target=finish_later)
        t.start()
        outcome = pending_ops.wait_for_result(token, timeout_s=5, interval_s=0.05)
        t.join()

        assert outcome.status == "done"
        assert outcome.result == canned_result
    finally:
        db.close()


def test_pending_operation_prune_removes_only_expired_pending_rows():
    from datetime import datetime, timedelta, timezone

    from app import pending_ops
    from app.scope import Scope

    db = SessionLocal()
    try:
        scope = Scope(owner_type="guest", owner_id="pending-ops-prune-guest", is_guest=True)
        fresh_token = pending_ops.create_pending(db, "restore", scope, {"a": 1})
        stale_token = pending_ops.create_pending(db, "restore", scope, {"b": 2})

        # Backdate the stale one's expiry as if it had been sitting
        # unconfirmed for far longer than its TTL.
        stale_row = db.query(PendingOperation).filter_by(token=stale_token).first()
        stale_row.expires_at = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        db.commit()

        pending_ops.prune_expired(db)

        assert db.query(PendingOperation).filter_by(token=fresh_token).first() is not None
        assert db.query(PendingOperation).filter_by(token=stale_token).first() is None
    finally:
        db.close()
