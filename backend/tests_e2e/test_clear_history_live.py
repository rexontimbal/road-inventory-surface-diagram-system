"""Live browser test for the owner-only UX around Clear History and Share:
both must be VISIBLE but DISABLED (with an explanatory tooltip) for an
Editor/Viewer instead of silently doing nothing or vanishing, and Clear
History must still work for the actual owner -- empty state + success toast,
no reload. Same RUN_E2E=1 gating/conventions as test_notification_badge_live.py
(see that file's module docstring for why this isn't in backend/tests/).

Run manually with both dev servers up:
    RUN_E2E=1 pytest backend/tests_e2e/test_clear_history_live.py -v
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
from app.models import User, UploadLogEntry, WorkspaceShare


def _api(method, path, token, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        API + path, method=method, data=data,
        headers={"Content-Type": "application/json", "Cookie": f"session={token}"},
    )
    with urllib.request.urlopen(req) as resp:
        return resp.status, json.loads(resp.read().decode())


@pytest.fixture
def owner_and_editor():
    now = datetime.now(timezone.utc).isoformat()
    db = SessionLocal()
    owner = User(
        google_id="e2e-clear-owner", name="E2E Clear Owner", email="e2e-clear-owner@example.com",
        created_at=now, last_login_at=now,
    )
    editor = User(
        google_id="e2e-clear-editor", name="E2E Clear Editor", email="e2e-clear-editor@example.com",
        created_at=now, last_login_at=now,
    )
    db.add_all([owner, editor])
    db.commit()
    owner_id, editor_id = owner.id, editor.id
    yield owner_id, editor_id
    cleanup_db = SessionLocal()
    cleanup_db.query(WorkspaceShare).filter(
        (WorkspaceShare.owner_user_id.in_([owner_id, editor_id])) | (WorkspaceShare.user_id.in_([owner_id, editor_id]))
    ).delete(synchronize_session=False)
    cleanup_db.query(UploadLogEntry).filter(UploadLogEntry.user_id.in_([owner_id, editor_id])).delete(synchronize_session=False)
    cleanup_db.query(User).filter(User.id.in_([owner_id, editor_id])).delete(synchronize_session=False)
    cleanup_db.commit()


def test_editor_sees_disabled_share_and_clear_history_with_tooltip(owner_and_editor):
    owner_id, editor_id = owner_and_editor
    token_owner = create_session_token(owner_id)
    token_editor = create_session_token(editor_id)

    status, _ = _api("POST", "/api/workspace/shares", token_owner, {"email": "e2e-clear-editor@example.com", "role": "editor"})
    assert status == 200

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True)
        context = browser.new_context(viewport={"width": 1366, "height": 900})
        page = context.new_page()
        context.add_cookies(
            [{"name": "session", "value": token_editor, "domain": "localhost", "path": "/", "httpOnly": True, "secure": False, "sameSite": "Lax"}]
        )
        page.goto(FRONTEND)
        page.wait_for_timeout(1200)

        page.locator(".user-menu-trigger").click()
        page.wait_for_timeout(300)
        page.locator(".user-menu-workspace-item", has_text="E2E Clear Owner").click()
        page.wait_for_timeout(1000)

        share_btn = page.locator(".header-share-btn")
        assert share_btn.count() == 1, "Share button should stay visible (not hidden) for an Editor"
        assert share_btn.is_disabled()
        assert share_btn.get_attribute("title") == "Only the owner can do this."

        page.locator('button[aria-label="Upload history"]').click()
        page.wait_for_timeout(500)
        clear_btn = page.locator(".history-header-btn-clear")
        assert clear_btn.is_disabled()
        assert clear_btn.get_attribute("title") == "Only the owner can clear the history."

        browser.close()


def test_owner_clears_history_with_empty_state_and_success_toast(owner_and_editor):
    owner_id, _editor_id = owner_and_editor
    token_owner = create_session_token(owner_id)

    # Give the owner something to clear.
    status, _ = _api("POST", "/api/workspace/shares", token_owner, {"email": "someone-else@example.com", "role": "viewer"})
    assert status == 200

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True)
        context = browser.new_context(viewport={"width": 1366, "height": 900})
        page = context.new_page()
        context.add_cookies(
            [{"name": "session", "value": token_owner, "domain": "localhost", "path": "/", "httpOnly": True, "secure": False, "sameSite": "Lax"}]
        )
        page.goto(FRONTEND)
        page.wait_for_timeout(1200)
        for b in page.locator(".toast-close, .header-toast .toast-close").all():
            b.click()
        page.wait_for_timeout(300)

        share_btn = page.locator(".header-share-btn")
        assert not share_btn.is_disabled()

        page.locator('button[aria-label="Upload history"]').click()
        page.wait_for_timeout(500)
        clear_btn = page.locator(".history-header-btn-clear")
        assert not clear_btn.is_disabled()
        clear_btn.click()
        page.wait_for_timeout(300)
        page.locator("button", has_text="Clear history").last.click()  # confirm in the danger modal
        page.wait_for_timeout(1000)

        assert page.locator(".history-empty").count() > 0, "list did not show the empty state right after clearing, without a reload"

        toast = page.locator(".header-toast, .toast-stack .toast")
        assert toast.count() == 1
        assert "cleared" in toast.first.inner_text().lower()

        browser.close()
