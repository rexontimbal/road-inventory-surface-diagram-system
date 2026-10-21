"""Covers Google-Sheets-style sharing: role enforcement on the backend
(Viewer can't write, Editor can't manage sharing), access revocation taking
effect immediately (not just on the next explicit switch), and a pending
invite (shared with an email that hasn't signed in yet) activating on that
email's first real sign-in."""

from app.auth import create_session_token
from app.scope import Scope


def test_viewer_can_read_but_not_write(client, make_user, as_user, upload_fixture_as, shared_scope):
    owner = make_user("Owner", "owner-viewer-test@example.com")
    viewer_user = make_user("Viewer Person", "viewer-test@example.com")
    result = upload_fixture_as(owner)
    section_id = result["imported"][0]["section_id"]

    viewer_scope = shared_scope(owner, viewer_user, "viewer")
    with as_user(viewer_scope):
        # Read access works fully.
        res = client.get("/api/roads")
        assert res.status_code == 200
        assert len(res.json()) > 0

        detail_res = client.get(f"/api/roads/{section_id}")
        assert detail_res.status_code == 200

        segments_res = client.get("/api/roads/segments", params={"page": 1, "page_size": 1})
        segment_id = segments_res.json()["records"][0]["id"]

        # Every write path is blocked with a 403, not a silent no-op or 404.
        upload_res = client.post(
            "/api/roads/upload/preview", files={"file": ("x.xlsx", b"not a real file", "application/octet-stream")}
        )
        assert upload_res.status_code == 403
        assert upload_res.json()["detail"] == "View-only access"

        edit_res = client.patch(f"/api/roads/segments/{segment_id}", json={"num_lanes": 4})
        assert edit_res.status_code == 403

        delete_res = client.delete(f"/api/roads/{section_id}")
        assert delete_res.status_code == 403

        clear_log_res = client.delete("/api/roads/upload-log")
        assert clear_log_res.status_code == 403


def test_editor_can_write_but_not_manage_sharing(client, make_user, as_user, upload_fixture_as, shared_scope):
    owner = make_user("Owner2", "owner-editor-test@example.com")
    editor_user = make_user("Editor Person", "editor-test@example.com")
    upload_fixture_as(owner)

    editor_scope = shared_scope(owner, editor_user, "editor")
    with as_user(editor_scope):
        # Editor CAN write (upload/edit/delete/backup-restore)...
        delete_res = client.delete("/api/roads/NOT_A_REAL_SECTION")
        assert delete_res.status_code == 404  # scoped query ran (not blocked at 403) -- just no such section

        # ...but can't manage sharing, even on the workspace they're editing.
        share_res = client.post("/api/workspace/shares", json={"email": "someone@example.com", "role": "viewer"})
        assert share_res.status_code == 403
        assert share_res.json()["detail"] == "Only the workspace owner can do this"

        clear_log_res = client.delete("/api/roads/upload-log")
        assert clear_log_res.status_code == 403  # owner-only, even for an editor


def test_removed_user_loses_access_immediately(client, make_user, as_user):
    owner = make_user("Owner3", "owner-remove-test@example.com")
    collaborator = make_user("Collaborator", "collab-remove-test@example.com")

    with as_user(owner):
        share_res = client.post(
            "/api/workspace/shares", json={"email": "collab-remove-test@example.com", "role": "editor"}
        )
    assert share_res.status_code == 200
    share_id = share_res.json()["id"]
    assert share_res.json()["pending"] is False  # collaborator already has a User row via make_user

    # Collaborator switches into the owner's workspace with a REAL session
    # cookie (not the as_user override) -- this exercises get_scope's real
    # cookie + WorkspaceShare lookup, not a bypassed Scope.
    client.cookies.set("session", create_session_token(collaborator.user_id))
    switch_res = client.post("/api/workspace/switch", json={"owner_user_id": owner.user_id})
    assert switch_res.status_code == 200

    context_res = client.get("/api/workspace/context")
    assert context_res.status_code == 200
    assert context_res.json()["mode"] == "shared"
    assert context_res.json()["role"] == "editor"

    # Owner revokes access.
    with as_user(owner):
        del_res = client.delete(f"/api/workspace/shares/{share_id}")
    assert del_res.status_code == 200

    # Collaborator's active_workspace cookie is UNCHANGED (still points at
    # owner) -- but get_scope re-checks the grant on every request, not a
    # cached role, so access is gone on the very next request without the
    # collaborator needing to switch back explicitly.
    client.cookies.set("session", create_session_token(collaborator.user_id))
    context_after = client.get("/api/workspace/context")
    assert context_after.status_code == 200
    assert context_after.json()["mode"] == "own"

    roads_after = client.get("/api/roads")
    assert roads_after.status_code == 200
    assert roads_after.json() == []  # back to their own (empty) workspace, not an error


def test_pending_invite_activates_on_first_sign_in(client, make_user, as_user, monkeypatch):
    owner = make_user("Owner4", "owner-pending-test@example.com")

    with as_user(owner):
        share_res = client.post(
            "/api/workspace/shares", json={"email": "newperson-pending-test@example.com", "role": "viewer"}
        )
    assert share_res.status_code == 200
    assert share_res.json()["pending"] is True
    share_id = share_res.json()["id"]

    def fake_verify_google_id_token(token):
        return {
            "sub": "google-id-newperson-pending-test",
            "email": "newperson-pending-test@example.com",
            "name": "New Person",
            "picture": None,
        }

    monkeypatch.setattr("app.routers.auth.verify_google_id_token", fake_verify_google_id_token)
    signin_res = client.post("/api/auth/google", json={"id_token": "fake-token-not-checked"})
    assert signin_res.status_code == 200
    new_user_id = signin_res.json()["user"]["id"]

    with as_user(owner):
        shares_res = client.get("/api/workspace/shares")
    person = next(p for p in shares_res.json()["people"] if p["id"] == share_id)
    assert person["pending"] is False
    assert person["name"] == "New Person"

    # The now-activated grant works for real, through the same cookie-based
    # switch flow as any other established collaborator.
    switch_res = client.post("/api/workspace/switch", json={"owner_user_id": owner.user_id})
    assert switch_res.status_code == 200
    context_res = client.get("/api/workspace/context")
    assert context_res.json()["mode"] == "shared"
    assert context_res.json()["role"] == "viewer"
    assert new_user_id == signin_res.json()["user"]["id"]


def test_editor_can_edit_segment_in_shared_workspace(client, make_user, as_user, upload_fixture_as, shared_scope):
    """Regression test for a real bug found while testing sharing: edit_segment's
    response omitted length_m/irregular_km_post (both required on
    SegmentRecord), so EVERY inline edit 500'd -- for the owner too, not just
    an Editor, but this is exactly the path real Editor testing caught it on.
    Also confirms the result lands in the OWNER's workspace while being
    attributed to the EDITOR in the "by" fields, per owner_kwargs(scope) +
    user_kwargs(scope)."""
    owner = make_user("Owner5", "owner-edit-test@example.com")
    editor_user = make_user("Editor Person 2", "editor-edit-test@example.com")
    upload_fixture_as(owner)

    editor_scope = shared_scope(owner, editor_user, "editor")
    with as_user(editor_scope):
        segs = client.get("/api/roads/segments", params={"page": 1, "page_size": 1})
        segment_id = segs.json()["records"][0]["id"]

        res = client.patch(f"/api/roads/segments/{segment_id}", json={"num_lanes": 5})
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["segment"]["num_lanes"] == 5
        # The fields that were missing before the fix -- asserting on them
        # directly so this test fails loudly if they regress again.
        assert "length_m" in body["segment"]
        assert "irregular_km_post" in body["segment"]

    with as_user(owner):
        log = client.get("/api/roads/upload-log", params={"page": 1, "page_size": 5})
        entry = log.json()["entries"][0]
        assert entry["kind"] == "edit"
        assert entry["actor_name"] == "Editor Person 2"
        assert entry["actor_email"] == "editor-edit-test@example.com"

        segs_after = client.get("/api/roads/segments", params={"page": 1, "page_size": 1})
        assert segs_after.json()["records"][0]["num_lanes"] == 5


def test_editor_can_perform_every_write_route_in_shared_workspace(
    client, make_user, as_user, upload_fixture_as, shared_scope
):
    """Covers the rest of the Editor write surface in one pass: delete
    section, and backup restore (preview + commit) -- upload and inline edit
    are covered by their own dedicated tests above/elsewhere. Each assertion
    checks both that it succeeded AND that the resulting upload-log entry
    (read back as the owner) attributes the action to the Editor."""
    owner = make_user("Owner6", "owner-allwrites-test@example.com")
    editor_user = make_user("Editor Person 3", "editor-allwrites-test@example.com")
    result = upload_fixture_as(owner)
    section_id = result["imported"][0]["section_id"]

    editor_scope = shared_scope(owner, editor_user, "editor")

    # --- Backup restore (preview + commit), merge mode ---
    with as_user(owner):
        backup = client.get("/api/backup/export").json()

    with as_user(editor_scope):
        preview_res = client.post("/api/backup/restore/preview", json={"backup": backup})
        assert preview_res.status_code == 200, preview_res.text
        token = preview_res.json()["token"]

        commit_res = client.post(
            "/api/backup/restore/commit", json={"token": token, "mode": "merge", "decisions": {}}
        )
        assert commit_res.status_code == 200, commit_res.text

    with as_user(owner):
        log = client.get("/api/roads/upload-log", params={"page": 1, "page_size": 5})
        restore_entry = next(e for e in log.json()["entries"] if e["kind"] == "restore")
        assert restore_entry["actor_name"] == "Editor Person 3"

    # --- Delete section ---
    with as_user(editor_scope):
        del_res = client.delete(f"/api/roads/{section_id}")
        assert del_res.status_code == 200, del_res.text

    with as_user(owner):
        detail_res = client.get(f"/api/roads/{section_id}")
        assert detail_res.status_code == 404  # actually gone from the owner's workspace

        log = client.get("/api/roads/upload-log", params={"page": 1, "page_size": 5})
        delete_entry = next(e for e in log.json()["entries"] if e["kind"] == "delete")
        assert delete_entry["actor_name"] == "Editor Person 3"


def test_switching_to_a_workspace_never_shared_falls_back(client, make_user, as_user):
    """A forged/stale active_workspace cookie naming a workspace this user
    was never granted access to must not leak it -- get_scope silently
    falls back to the caller's own workspace rather than erroring or (far
    worse) honoring the cookie."""
    stranger_owner = make_user("Stranger", "stranger-test@example.com")
    caller = make_user("Caller", "caller-test@example.com")

    client.cookies.set("session", create_session_token(caller.user_id))
    client.cookies.set("active_workspace", str(stranger_owner.user_id))

    res = client.get("/api/workspace/context")
    assert res.status_code == 200
    assert res.json()["mode"] == "own"

    roads_res = client.get("/api/roads")
    assert roads_res.status_code == 200
    assert roads_res.json() == []
