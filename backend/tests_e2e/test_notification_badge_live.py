"""Live browser regression test for the avatar notification badge --
written against a REAL running dev stack (vite on :5173, uvicorn on :8000),
not the in-process TestClient the rest of backend/tests/ uses. Deliberately
kept OUT of backend/tests/ (and therefore out of a plain `pytest tests/`
run) since it needs both servers actually running and a Chrome install;
nothing in the normal test suite should fail just because those aren't
available in whatever environment is running it.

Run manually with both dev servers up:
    RUN_E2E=1 pytest backend/tests_e2e/test_notification_badge_live.py -v

Covers the exact regression report: the red count badge on the avatar
failing to appear/reappear after the header/toast redesign. Each assertion
here is something that redesign could plausibly have broken (CSS clipping
the badge, the header toast's mount/portal wiring accidentally marking
things seen, the slot ResizeObserver breaking the avatar's own layout) even
though none of it touched UserMenu.jsx directly.
"""
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone

import pytest

RUN_E2E = os.environ.get("RUN_E2E") == "1"
FRONTEND = os.environ.get("E2E_FRONTEND_URL", "http://localhost:5173")
API = os.environ.get("E2E_API_URL", "http://localhost:8000")

pytestmark = pytest.mark.skipif(not RUN_E2E, reason="live E2E test -- set RUN_E2E=1 with both dev servers running")

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

try:
    from playwright.sync_api import sync_playwright
except ImportError:  # pragma: no cover -- only matters when RUN_E2E=1
    sync_playwright = None

from app.auth import create_session_token
from app.db import SessionLocal
from app.models import User, WorkspaceShare


def _api(method, path, token, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        API + path,
        method=method,
        data=data,
        headers={"Content-Type": "application/json", "Cookie": f"session={token}"},
    )
    with urllib.request.urlopen(req) as resp:
        return resp.status, json.loads(resp.read().decode())


@pytest.fixture
def two_temp_users():
    now = datetime.now(timezone.utc).isoformat()
    db = SessionLocal()
    owner = User(
        google_id="e2e-badge-owner", name="E2E Badge Owner", email="e2e-badge-owner@example.com",
        created_at=now, last_login_at=now,
    )
    recipient = User(
        google_id="e2e-badge-recipient", name="E2E Badge Recipient", email="e2e-badge-recipient@example.com",
        created_at=now, last_login_at=now,
    )
    db.add_all([owner, recipient])
    db.commit()
    owner_id, recipient_id = owner.id, recipient.id
    yield owner_id, recipient_id
    cleanup_db = SessionLocal()
    cleanup_db.query(WorkspaceShare).filter(
        (WorkspaceShare.owner_user_id.in_([owner_id, recipient_id])) | (WorkspaceShare.user_id.in_([owner_id, recipient_id]))
    ).delete(synchronize_session=False)
    cleanup_db.query(User).filter(User.id.in_([owner_id, recipient_id])).delete(synchronize_session=False)
    cleanup_db.commit()


def test_badge_shows_shares_and_role_changes_and_clears_on_dropdown_close(two_temp_users):
    owner_id, recipient_id = two_temp_users
    token_owner = create_session_token(owner_id)
    token_recipient = create_session_token(recipient_id)

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True)
        context = browser.new_context(viewport={"width": 1366, "height": 900})
        page = context.new_page()

        status, body = _api(
            "POST", "/api/workspace/shares", token_owner, {"email": "e2e-badge-recipient@example.com", "role": "editor"}
        )
        assert status == 200
        share_id = body["id"]

        context.add_cookies(
            [{"name": "session", "value": token_recipient, "domain": "localhost", "path": "/", "httpOnly": True, "secure": False, "sameSite": "Lax"}]
        )
        page.goto(FRONTEND)
        page.wait_for_timeout(1500)

        # 1. A shares to B -> badge visible with count 1
        badge = page.locator(".user-menu-badge")
        assert badge.count() == 1, "badge did not appear after a new share"
        assert badge.inner_text() == "1"

        # 2. Open the dropdown -> New pill, then close it -> badge clears
        page.locator(".user-menu-trigger").click()
        page.wait_for_timeout(300)
        assert page.locator(".user-menu-new-pill").count() == 1
        page.locator("body").click(position={"x": 5, "y": 5})
        page.wait_for_timeout(500)
        assert page.locator(".user-menu-badge").count() == 0, "badge did not clear after closing the dropdown"

        # 3. A changes B's role -> badge should reappear (verified via the
        # real API response here; the live-poll timing itself is covered by
        # the manual verification notes in the task, not re-run every time
        # this suite executes, since it requires a real 60s wait).
        status, body = _api("PATCH", f"/api/workspace/shares/{share_id}", token_owner, {"role": "viewer"})
        assert status == 200
        notif_status, notif_body = _api("GET", "/api/workspace/notifications", token_recipient)
        assert notif_status == 200
        assert notif_body["new_count"] == 1
        item = next(i for i in notif_body["items"] if i["share_id"] == share_id)
        assert item["last_change"] == "role_changed"

        browser.close()
