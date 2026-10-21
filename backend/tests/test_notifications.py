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


def _fake_google_verify(sub, email, name):
    def fn(token):
        return {"sub": sub, "email": email, "name": name, "picture": None}

    return fn


def test_pending_invite_then_first_sign_in_counts_as_one_unseen(client, make_user, as_user, monkeypatch):
    """The share row is created (and already correctly unseen) BEFORE the
    invited person has ever signed in -- POST /api/auth/google's activation
    only sets user_id on that row, so it must still read as a brand new
    notification the moment they do. This was never actually broken (see
    the sibling test below for the real regression), but it's the scenario
    from the bug report and worth locking in directly."""
    owner = make_user("Owner-Pending", "owner-pending-notif@example.com")

    with as_user(owner):
        share_res = client.post(
            "/api/workspace/shares", json={"email": "newperson-pending-notif@example.com", "role": "viewer"}
        )
    assert share_res.json()["pending"] is True

    monkeypatch.setattr(
        "app.routers.auth.verify_google_id_token",
        _fake_google_verify("google-id-pending-notif", "newperson-pending-notif@example.com", "New Person"),
    )
    signin_res = client.post("/api/auth/google", json={"id_token": "fake-token"})
    assert signin_res.status_code == 200
    new_user_id = signin_res.json()["user"]["id"]

    client.cookies.set("session", create_session_token(new_user_id))
    notif = client.get("/api/workspace/notifications").json()
    assert notif["new_count"] == 1
    assert notif["items"][0]["last_change"] == "shared"
    assert notif["items"][0]["is_new"] is True


def test_signing_in_as_a_different_account_does_not_leak_the_previous_ones_notifications(
    client, make_user, as_user, monkeypatch
):
    """THE regression: two real Google accounts signed into the same
    browser, one after another, without the second one ever touching the
    avatar dropdown. account_a switches into owner's shared workspace
    (via POST /switch, the one call that marks a share seen) -- then
    account_b signs in fresh. account_b's own still-unseen share from the
    SAME owner must not have been silently marked seen along the way.

    POST /api/auth/google must also clear any active_workspace cookie left
    behind by whoever was signed in before -- otherwise account_b's very
    first /workspace/context read resolves into account_a's last-viewed
    workspace by cookie alone, before account_b has done anything at all."""
    owner = make_user("Owner-Leak", "owner-leak-notif@example.com")
    account_a = make_user("Account-A-Leak", "a-leak-notif@example.com")

    with as_user(owner):
        client.post("/api/workspace/shares", json={"email": "a-leak-notif@example.com", "role": "editor"})
        share_b_res = client.post(
            "/api/workspace/shares", json={"email": "b-leak-notif@example.com", "role": "viewer"}
        )
    share_b_id = share_b_res.json()["id"]

    # Account A signs in (real session cookie) and explicitly switches into
    # the owner's workspace -- the one action that's actually supposed to
    # mark THEIR OWN share seen, and that leaves an active_workspace cookie
    # sitting in the (shared, in a real browser) cookie jar.
    client.cookies.set("session", create_session_token(account_a.user_id))
    switch_res = client.post("/api/workspace/switch", json={"owner_user_id": owner.user_id})
    assert switch_res.status_code == 200

    # Account B signs in next, in the same cookie jar (this TestClient
    # instance), WITHOUT ever calling /switch or /notifications/seen.
    monkeypatch.setattr(
        "app.routers.auth.verify_google_id_token",
        _fake_google_verify("google-id-b-leak-notif", "b-leak-notif@example.com", "Account B"),
    )
    signin_res = client.post("/api/auth/google", json={"id_token": "fake-token"})
    assert signin_res.status_code == 200
    account_b_id = signin_res.json()["user"]["id"]

    # The stale active_workspace cookie from A must be gone -- B's context
    # should read "own", not silently resolve into owner's workspace.
    context_res = client.get("/api/workspace/context").json()
    assert context_res["mode"] == "own"

    # And B's own share notification must still be unseen.
    notif = client.get("/api/workspace/notifications").json()
    assert notif["new_count"] == 1
    item = next(i for i in notif["items"] if i["share_id"] == share_b_id)
    assert item["is_new"] is True


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


def test_fetching_notifications_repeatedly_never_marks_them_seen(client, make_user, as_user):
    """Regression guard: GET /notifications (the 60s poll + the avatar badge)
    must be a pure read -- only POST /notifications/seen is allowed to touch
    seen_at. A toast fired off the SAME poll response must not have any way
    to mark things seen just by having been shown; only closing the avatar
    dropdown or switching into the workspace does that, both of which hit
    the seen endpoints directly rather than piggybacking on this one."""
    owner = make_user("Owner-N7", "owner-notif7@example.com")
    recipient = make_user("Recipient-N7", "recipient-notif7@example.com")

    with as_user(owner):
        share_res = client.post(
            "/api/workspace/shares", json={"email": "recipient-notif7@example.com", "role": "viewer"}
        )
    share_id = share_res.json()["id"]

    _login_as(client, recipient)
    for _ in range(5):
        notif = client.get("/api/workspace/notifications").json()
        assert notif["new_count"] == 1
        item = next(i for i in notif["items"] if i["share_id"] == share_id)
        assert item["is_new"] is True

    # The explicit mark-seen endpoint still finds exactly one row to mark --
    # proof none of the 5 GETs above already cleared it some other way.
    seen_res = client.post("/api/workspace/notifications/seen", json={}).json()
    assert seen_res["marked"] == 1


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
