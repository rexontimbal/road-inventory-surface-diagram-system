"""Covers share notifications: a new share counts as 1 unseen, marking it
seen (explicitly, or implicitly by switching into that workspace) clears it
to 0, and a later role change on an already-seen share flips it back to 1 --
plus the "access removed" one-shot report GET /workspace/context makes when
the workspace you were actively viewing stops being shared with you.

Every /api/workspace/* endpoint here other than /shares reads the signed-in
user straight off the real session cookie (_require_signed_in_user calls
get_current_user directly), bypassing the as_user fixture's get_scope
override entirely -- so these tests log in as the recipient/owner via real
create_session_token cookies, the same pattern test_sharing.py's switch/
context/pending-invite tests already use, rather than `with as_user(...)`."""

from app.auth import create_session_token


def _login_as(client, scope):
    client.cookies.set("session", create_session_token(scope.user_id))


def test_new_share_counts_as_one_unseen(client, make_user, as_user):
    owner = make_user("Owner-N1", "owner-notif1@example.com")
    recipient = make_user("Recipient-N1", "recipient-notif1@example.com")

    with as_user(owner):
        share_res = client.post(
            "/api/workspace/shares", json={"email": "recipient-notif1@example.com", "role": "viewer"}
        )
    assert share_res.status_code == 200
    share_id = share_res.json()["id"]

    _login_as(client, recipient)
    notif = client.get("/api/workspace/notifications").json()
    assert notif["new_count"] == 1
    item = next(i for i in notif["items"] if i["share_id"] == share_id)
    assert item["is_new"] is True
    assert item["last_change"] == "shared"
    assert item["role"] == "viewer"


def test_mark_seen_clears_the_count(client, make_user, as_user):
    owner = make_user("Owner-N2", "owner-notif2@example.com")
    recipient = make_user("Recipient-N2", "recipient-notif2@example.com")

    with as_user(owner):
        client.post("/api/workspace/shares", json={"email": "recipient-notif2@example.com", "role": "viewer"})

    _login_as(client, recipient)
    before = client.get("/api/workspace/notifications").json()
    assert before["new_count"] == 1

    seen_res = client.post("/api/workspace/notifications/seen", json={})
    assert seen_res.status_code == 200
    assert seen_res.json()["marked"] == 1

    after = client.get("/api/workspace/notifications").json()
    assert after["new_count"] == 0
    assert all(not i["is_new"] for i in after["items"])


def test_switching_into_a_shared_workspace_marks_it_seen(client, make_user, as_user):
    owner = make_user("Owner-N3", "owner-notif3@example.com")
    recipient = make_user("Recipient-N3", "recipient-notif3@example.com")

    with as_user(owner):
        client.post("/api/workspace/shares", json={"email": "recipient-notif3@example.com", "role": "editor"})

    _login_as(client, recipient)
    switch_res = client.post("/api/workspace/switch", json={"owner_user_id": owner.user_id})
    assert switch_res.status_code == 200

    notif = client.get("/api/workspace/notifications").json()
    assert notif["new_count"] == 0


def test_role_change_on_a_seen_share_makes_it_unseen_again(client, make_user, as_user):
    owner = make_user("Owner-N4", "owner-notif4@example.com")
    recipient = make_user("Recipient-N4", "recipient-notif4@example.com")

    with as_user(owner):
        share_res = client.post(
            "/api/workspace/shares", json={"email": "recipient-notif4@example.com", "role": "viewer"}
        )
    share_id = share_res.json()["id"]

    _login_as(client, recipient)
    client.post("/api/workspace/notifications/seen", json={})
    mid = client.get("/api/workspace/notifications").json()
    assert mid["new_count"] == 0

    with as_user(owner):
        role_res = client.patch(f"/api/workspace/shares/{share_id}", json={"role": "editor"})
        assert role_res.status_code == 200

    _login_as(client, recipient)
    after = client.get("/api/workspace/notifications").json()
    assert after["new_count"] == 1
    item = next(i for i in after["items"] if i["share_id"] == share_id)
    assert item["last_change"] == "role_changed"
    assert item["role"] == "editor"


def test_resharing_with_same_role_does_not_reset_an_already_seen_share(client, make_user, as_user):
    """Re-sharing with the SAME role (no actual change) shouldn't manufacture
    a fresh "new" event for something the recipient already saw and
    acknowledged -- only a genuine role change should."""
    owner = make_user("Owner-N5", "owner-notif5@example.com")
    recipient = make_user("Recipient-N5", "recipient-notif5@example.com")

    with as_user(owner):
        client.post("/api/workspace/shares", json={"email": "recipient-notif5@example.com", "role": "viewer"})

    _login_as(client, recipient)
    client.post("/api/workspace/notifications/seen", json={})

    with as_user(owner):
        # Same role, re-shared -- not a change.
        client.post("/api/workspace/shares", json={"email": "recipient-notif5@example.com", "role": "viewer"})

    _login_as(client, recipient)
    notif = client.get("/api/workspace/notifications").json()
    assert notif["new_count"] == 0


def test_access_removed_is_reported_once_by_context_and_clears_the_cookie(client, make_user, as_user):
    owner = make_user("Owner-N6", "owner-notif6@example.com")
    recipient = make_user("Recipient-N6", "recipient-notif6@example.com")

    with as_user(owner):
        share_res = client.post(
            "/api/workspace/shares", json={"email": "recipient-notif6@example.com", "role": "editor"}
        )
    share_id = share_res.json()["id"]

    _login_as(client, recipient)
    switch_res = client.post("/api/workspace/switch", json={"owner_user_id": owner.user_id})
    assert switch_res.status_code == 200

    with as_user(owner):
        del_res = client.delete(f"/api/workspace/shares/{share_id}")
        assert del_res.status_code == 200

    _login_as(client, recipient)
    ctx1 = client.get("/api/workspace/context").json()
    assert ctx1["mode"] == "own"
    assert ctx1["access_removed_owner_name"] == "Owner-N6"

    # Reported exactly once -- the cookie that triggered it was cleared by
    # the first call, so a second call has nothing left to report.
    ctx2 = client.get("/api/workspace/context").json()
    assert ctx2["access_removed_owner_name"] is None
