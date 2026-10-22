"""Live browser test for "Delete all data": upload -> delete one District ->
delete all -> re-upload works without a page reload. Same RUN_E2E=1 gating
as the other suites in this directory (see test_notification_badge_live.py's
module docstring for why this isn't in backend/tests/).

Run manually with both dev servers up:
    RUN_E2E=1 pytest backend/tests_e2e/test_delete_all_data_live.py -v
"""
import os
import sys
from datetime import datetime, timezone

import pytest

RUN_E2E = os.environ.get("RUN_E2E") == "1"
FRONTEND = os.environ.get("E2E_FRONTEND_URL", "http://localhost:5173")

pytestmark = pytest.mark.skipif(not RUN_E2E, reason="live E2E test -- set RUN_E2E=1 with both dev servers running")

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

try:
    from playwright.sync_api import sync_playwright
except ImportError:  # pragma: no cover -- only matters when RUN_E2E=1
    sync_playwright = None

from app.auth import create_session_token
from app.db import SessionLocal
from app.models import Road, User

FIXTURE = os.path.join(os.path.dirname(__file__), "..", "tests", "fixtures", "dpwh_sample.xlsx")


@pytest.fixture
def temp_owner():
    now = datetime.now(timezone.utc).isoformat()
    db = SessionLocal()
    owner = User(
        google_id="e2e-delall-owner", name="E2E DelAll Owner", email="e2e-delall-owner@example.com",
        created_at=now, last_login_at=now,
    )
    db.add(owner)
    db.commit()
    owner_id = owner.id
    yield owner_id
    cleanup_db = SessionLocal()
    cleanup_db.query(Road).filter(Road.owner_type == "user", Road.owner_id == str(owner_id)).delete(synchronize_session=False)
    cleanup_db.query(User).filter(User.id == owner_id).delete(synchronize_session=False)
    cleanup_db.commit()


def test_upload_delete_district_delete_all_then_reupload(temp_owner):
    token = create_session_token(temp_owner)

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True)
        context = browser.new_context(viewport={"width": 1366, "height": 900}, accept_downloads=True)
        page = context.new_page()
        context.add_cookies(
            [{"name": "session", "value": token, "domain": "localhost", "path": "/", "httpOnly": True, "secure": False, "sameSite": "Lax"}]
        )
        page.goto(FRONTEND)
        page.wait_for_timeout(1200)
        for b in page.locator(".toast-close, .header-toast .toast-close").all():
            b.click()
        page.wait_for_timeout(300)

        with page.expect_file_chooser() as fc_info:
            page.locator("button", has_text="Choose Excel File").click()
        fc_info.value.set_files(FIXTURE)
        page.wait_for_timeout(1500)
        for b in page.locator(".toast-close, .header-toast .toast-close").all():
            b.click()
        page.wait_for_timeout(300)

        assert page.locator("button", has_text="Delete all data").count() == 1

        # --- Delete one District ---
        page.locator("button", has_text="Delete all data").click()
        page.wait_for_timeout(600)
        page.locator(".delete-all-scope-option", has_text="Only one District").click()
        page.wait_for_timeout(300)
        page.locator(".delete-all-checkbox-row input").uncheck()  # skip the download for speed
        confirm_input = page.locator(".delete-all-confirm-input")
        confirm_btn = page.locator("button", has_text="Delete permanently")
        assert confirm_btn.is_disabled()
        confirm_input.fill("DELETE")
        assert not confirm_btn.is_disabled()
        confirm_btn.click()
        page.wait_for_timeout(1000)

        toast = page.locator(".header-toast, .toast-stack .toast")
        assert toast.count() == 1
        assert "deleted from" in toast.first.inner_text()

        # --- Delete everything that's left ---
        page.locator("button", has_text="Delete all data").click()
        page.wait_for_timeout(600)
        page.locator(".delete-all-checkbox-row input").uncheck()
        page.locator(".delete-all-confirm-input").fill("DELETE")
        page.wait_for_timeout(200)
        page.locator("button", has_text="Delete permanently").click()
        page.wait_for_timeout(1000)

        assert page.locator("text=No road data yet").count() > 0
        assert page.locator("button", has_text="Delete all data").count() == 0, "trigger should hide once there's no data left"

        # --- Re-upload right away, no reload ---
        with page.expect_file_chooser() as fc_info2:
            page.locator("button", has_text="Choose Excel File").click()
        fc_info2.value.set_files(FIXTURE)
        page.wait_for_timeout(1500)
        assert page.locator("text=No road data yet").count() == 0, "re-upload after Delete All did not take effect without a reload"

        browser.close()
