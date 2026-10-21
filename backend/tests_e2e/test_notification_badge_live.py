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


@pytest.fixture
def owner_and_pending_invite():
    """A share to an email with no User row yet (a pending invite) --
    activation (setting user_id once that email signs in) is simulated at
    the DB level the same way POST /api/auth/google's own activation query
    does, since real Google OAuth can't be driven from here."""
    now = datetime.now(timezone.utc).isoformat()
    db = SessionLocal()
    owner = User(
        google_id="e2e-pending-owner", name="E2E Pending Owner", email="e2e-pending-owner@example.com",
        created_at=now, last_login_at=now,
    )
    db.add(owner)
    db.commit()
    owner_id = owner.id
    yield owner_id
    cleanup_db = SessionLocal()
    cleanup_db.query(WorkspaceShare).filter(WorkspaceShare.owner_user_id == owner_id).delete(synchronize_session=False)
    cleanup_db.query(User).filter(User.id == owner_id).delete(synchronize_session=False)
    cleanup_db.commit()


def test_badge_visible_on_first_load_after_a_pending_invite_is_activated(owner_and_pending_invite):
    owner_id = owner_and_pending_invite
    token_owner = create_session_token(owner_id)

    status, body = _api(
        "POST", "/api/workspace/shares", token_owner, {"email": "e2e-pending-recipient@example.com", "role": "viewer"}
    )
    assert status == 200
    assert body["pending"] is True
    share_id = body["id"]

    now = datetime.now(timezone.utc).isoformat()
    db = SessionLocal()
    recipient = User(
        google_id="e2e-pending-recipient", name="E2E Pending Recipient", email="e2e-pending-recipient@example.com",
        created_at=now, last_login_at=now,
    )
    db.add(recipient)
    db.commit()
    recipient_id = recipient.id
    row = db.query(WorkspaceShare).filter(WorkspaceShare.id == share_id).first()
    row.user_id = recipient_id
    db.commit()
    db.close()

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(channel="chrome", headless=True)
            context = browser.new_context(viewport={"width": 1366, "height": 900})
            page = context.new_page()
            context.add_cookies(
                [{
                    "name": "session", "value": create_session_token(recipient_id), "domain": "localhost",
                    "path": "/", "httpOnly": True, "secure": False, "sameSite": "Lax",
                }]
            )
            # First-ever page load for this just-activated account.
            page.goto(FRONTEND)
            page.wait_for_timeout(1500)

            badge = page.locator(".user-menu-badge")
            assert badge.count() == 1, "badge did not appear for a newly-activated pending invite"
            assert badge.inner_text() == "1"

            browser.close()
    finally:
        db2 = SessionLocal()
        # The share row (owned by owner_and_pending_invite's owner) must go
        # first -- it FK-references this recipient via user_id.
        db2.query(WorkspaceShare).filter(WorkspaceShare.id == share_id).delete(synchronize_session=False)
        db2.query(User).filter(User.id == recipient_id).delete(synchronize_session=False)
        db2.commit()


def test_account_switch_in_the_same_browser_does_not_leak_notification_state(two_temp_users):
    """THE regression, reproduced through the actual browser rather than
    direct API calls: account A signs in, switches into the owner's shared
    workspace (the one action that legitimately marks THEIR share seen) --
    then, in the SAME browser (same localStorage/cookies), a second,
    unrelated account also shared by that owner loads the app for the
    first time, never touching the dropdown or switcher itself. Their
    badge must still show -- nothing about account A's session should have
    touched account B's notification state."""
    owner_id, account_a_id = two_temp_users
    token_owner = create_session_token(owner_id)
    token_a = create_session_token(account_a_id)

    now = datetime.now(timezone.utc).isoformat()
    db = SessionLocal()
    account_b = User(
        google_id="e2e-leak-b", name="E2E Leak Account B", email="e2e-leak-b@example.com",
        created_at=now, last_login_at=now,
    )
    db.add(account_b)
    db.commit()
    account_b_id = account_b.id
    db.close()
    token_b = create_session_token(account_b_id)

    try:
        _api("POST", "/api/workspace/shares", token_owner, {"email": "e2e-badge-recipient@example.com", "role": "editor"})
        status, body = _api("POST", "/api/workspace/shares", token_owner, {"email": "e2e-leak-b@example.com", "role": "viewer"})
        share_b_id = body["id"]

        with sync_playwright() as p:
            browser = p.chromium.launch(channel="chrome", headless=True)
            context = browser.new_context(viewport={"width": 1366, "height": 900})
            page = context.new_page()

            context.add_cookies(
                [{"name": "session", "value": token_a, "domain": "localhost", "path": "/", "httpOnly": True, "secure": False, "sameSite": "Lax"}]
            )
            page.goto(FRONTEND)
            page.wait_for_timeout(1200)
            page.locator(".user-menu-trigger").click()
            page.wait_for_timeout(300)
            page.locator(".user-menu-workspace-item", has_text="E2E Badge Owner").click()
            page.wait_for_timeout(800)

            # Same browser context (same localStorage/cookies) -- account B
            # signs in next WITHOUT the app's own "Sign out" ever running,
            # same as picking a different account from Google's chooser.
            # (Injecting the session cookie directly, same as every other
            # test here, since real Google OAuth can't be driven from this
            # suite -- that means this specific swap bypasses POST
            # /api/auth/google's own active_workspace-cookie clearing, so
            # it isn't what exercises THAT half of the fix; see backend/
            # tests/test_notifications.py's TestClient-based equivalent for
            # that. What this live run DOES prove end-to-end is the part
            # that actually produced the reported symptom: the frontend's
            # localStorage-driven mount-time restore is scoped per account,
            # so it can't silently mark B's own share seen using A's saved
            # choice.)
            context.add_cookies(
                [{"name": "session", "value": token_b, "domain": "localhost", "path": "/", "httpOnly": True, "secure": False, "sameSite": "Lax"}]
            )
            page.goto(FRONTEND)
            page.wait_for_timeout(1500)

            badge = page.locator(".user-menu-badge")
            assert badge.count() == 1, "account B's badge was cleared by account A's leftover session state"
            assert badge.inner_text() == "1"

            browser.close()
    finally:
        db2 = SessionLocal()
        db2.query(WorkspaceShare).filter(
            (WorkspaceShare.owner_user_id == account_b_id) | (WorkspaceShare.user_id == account_b_id)
        ).delete(synchronize_session=False)
        db2.query(User).filter(User.id == account_b_id).delete(synchronize_session=False)
        db2.commit()


def test_role_change_shows_badge_and_toast_within_15s_while_on_my_data(two_temp_users):
    """B is on "My data" (never switched into the shared workspace) when A
    changes their role -- the live poll (15s, tab stays visible/focused the
    whole time) must pick it up without a reload, both the badge and the
    exact toast wording the role-change case uses."""
    owner_id, recipient_id = two_temp_users
    token_owner = create_session_token(owner_id)
    token_recipient = create_session_token(recipient_id)

    status, body = _api(
        "POST", "/api/workspace/shares", token_owner, {"email": "e2e-badge-recipient@example.com", "role": "editor"}
    )
    assert status == 200
    share_id = body["id"]

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True)
        context = browser.new_context(viewport={"width": 1366, "height": 900})
        page = context.new_page()
        context.add_cookies(
            [{"name": "session", "value": token_recipient, "domain": "localhost", "path": "/", "httpOnly": True, "secure": False, "sameSite": "Lax"}]
        )
        page.goto(FRONTEND)
        page.wait_for_timeout(1200)

        # B marks the initial share seen (dropdown open/close) and stays on
        # "My data" -- so the only thing that should bring the badge back
        # is the live poll noticing the role change below.
        page.locator(".user-menu-trigger").click()
        page.wait_for_timeout(300)
        page.locator("body").click(position={"x": 5, "y": 5})
        page.wait_for_timeout(500)
        assert page.locator(".user-menu-badge").count() == 0

        status, body = _api("PATCH", f"/api/workspace/shares/{share_id}", token_owner, {"role": "viewer"})
        assert status == 200

        page.wait_for_timeout(17000)  # > the 15s poll interval

        badge = page.locator(".user-menu-badge")
        assert badge.count() == 1, "badge did not reappear within 15s of a role change"
        assert badge.inner_text() == "1"

        toast = page.locator(".header-toast, .toast-stack .toast")
        assert toast.count() == 1, "role-change toast did not appear within 15s"
        assert "changed to Viewer" in toast.first.inner_text()

        browser.close()


def test_viewing_workspace_updates_role_live_on_role_change(two_temp_users):
    """B is actively VIEWING the owner's shared workspace (switched into it
    via the dropdown) when A changes their role -- the banner text and the
    role-gated controls (e.g. the upload button) must update live from the
    same poll that refreshes workspaceContext, with no reload and without
    the poll itself re-marking anything or calling /switch again."""
    owner_id, recipient_id = two_temp_users
    token_owner = create_session_token(owner_id)
    token_recipient = create_session_token(recipient_id)

    status, body = _api(
        "POST", "/api/workspace/shares", token_owner, {"email": "e2e-badge-recipient@example.com", "role": "viewer"}
    )
    assert status == 200
    share_id = body["id"]

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True)
        context = browser.new_context(viewport={"width": 1366, "height": 900})
        page = context.new_page()
        context.add_cookies(
            [{"name": "session", "value": token_recipient, "domain": "localhost", "path": "/", "httpOnly": True, "secure": False, "sameSite": "Lax"}]
        )
        page.goto(FRONTEND)
        page.wait_for_timeout(1200)

        page.locator(".user-menu-trigger").click()
        page.wait_for_timeout(300)
        page.locator(".user-menu-workspace-item", has_text="E2E Badge Owner").click()
        page.wait_for_timeout(1000)

        banner_before = page.locator(".workspace-banner-text").inner_text()
        assert "View only" in banner_before
        upload_before = page.locator("button", has_text="Choose Excel File")
        assert upload_before.is_disabled()

        status, body = _api("PATCH", f"/api/workspace/shares/{share_id}", token_owner, {"role": "editor"})
        assert status == 200

        page.wait_for_timeout(17000)

        banner_after = page.locator(".workspace-banner-text").inner_text()
        assert "Editor" in banner_after, "banner did not pick up the new role live"
        upload_after = page.locator("button", has_text="Choose Excel File")
        assert not upload_after.is_disabled(), "edit controls did not unlock live after the role change"

        browser.close()
