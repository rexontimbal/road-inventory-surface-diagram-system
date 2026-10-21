"""Proves each signed-in account's workspace is private: uploading data as
one user must never be visible to -- or editable/deletable by -- a
different signed-in user, across every route that reads or writes
scope-owned data. See conftest.py's `as_user`/`make_user` docstrings for how
"signed in as X" is simulated without a real OAuth round trip."""


def test_upload_by_a_is_invisible_to_b(client, make_user, as_user, upload_fixture_as):
    user_a = make_user("Alice", "alice@example.com")
    user_b = make_user("Bob", "bob@example.com")

    result = upload_fixture_as(user_a)
    assert len(result["imported"]) > 0
    section_id = result["imported"][0]["section_id"]

    with as_user(user_a):
        res = client.get("/api/roads")
        assert res.status_code == 200
        a_section_ids = {r["section_id"] for r in res.json()}
        assert section_id in a_section_ids

    with as_user(user_b):
        res = client.get("/api/roads")
        assert res.status_code == 200
        assert res.json() == []


def test_b_cannot_read_a_road_detail_by_id(client, make_user, as_user, upload_fixture_as):
    user_a = make_user("Alice", "alice2@example.com")
    user_b = make_user("Bob", "bob2@example.com")
    result = upload_fixture_as(user_a)
    section_id = result["imported"][0]["section_id"]

    with as_user(user_a):
        res = client.get(f"/api/roads/{section_id}")
        assert res.status_code == 200

    # Guessing/knowing A's exact section_id must not leak A's road to B --
    # apply_scope filters it out of B's query entirely, so this 404s exactly
    # like a section_id that doesn't exist anywhere.
    with as_user(user_b):
        res = client.get(f"/api/roads/{section_id}")
        assert res.status_code == 404


def test_b_cannot_delete_a_road(client, make_user, as_user, upload_fixture_as):
    user_a = make_user("Alice", "alice3@example.com")
    user_b = make_user("Bob", "bob3@example.com")
    result = upload_fixture_as(user_a)
    section_id = result["imported"][0]["section_id"]

    with as_user(user_b):
        res = client.delete(f"/api/roads/{section_id}")
        assert res.status_code == 404

    # Still there, untouched, from A's own point of view.
    with as_user(user_a):
        res = client.get(f"/api/roads/{section_id}")
        assert res.status_code == 200


def test_b_segments_summary_and_lane_counts_unaffected_by_a(client, make_user, as_user, upload_fixture_as):
    user_a = make_user("Alice", "alice4@example.com")
    user_b = make_user("Bob", "bob4@example.com")
    upload_fixture_as(user_a)

    with as_user(user_b):
        segs = client.get("/api/roads/segments", params={"page": 1, "page_size": 10})
        assert segs.status_code == 200
        assert segs.json()["total_records"] == 0

        summary = client.get("/api/roads/summary")
        assert summary.status_code == 200
        assert summary.json()["roads"] == []

        lanes = client.get("/api/roads/lane-counts")
        assert lanes.status_code == 200
        assert lanes.json()["lanes"] == []


def test_b_upload_log_does_not_show_a_uploads(client, make_user, as_user, upload_fixture_as):
    user_a = make_user("Alice", "alice5@example.com")
    user_b = make_user("Bob", "bob5@example.com")
    upload_fixture_as(user_a)

    with as_user(user_a):
        log_a = client.get("/api/roads/upload-log", params={"page": 1, "page_size": 10})
        assert log_a.status_code == 200
        assert log_a.json()["total_records"] >= 1

    with as_user(user_b):
        log_b = client.get("/api/roads/upload-log", params={"page": 1, "page_size": 10})
        assert log_b.status_code == 200
        assert log_b.json()["total_records"] == 0


def test_guest_and_signed_in_user_are_also_isolated(client, make_user, as_user, upload_fixture_as):
    """Not just user-vs-user -- a signed-in account must never see a
    guest's sandbox either, confirming the existing guest isolation still
    holds now that owner_type for real accounts is 'user' instead of the
    old shared 'workspace' value."""
    from app.scope import Scope

    user_a = make_user("Alice", "alice6@example.com")
    guest_scope = Scope(owner_type="guest", owner_id="fake-guest-id-123", is_guest=True)

    upload_fixture_as(guest_scope)

    with as_user(user_a):
        res = client.get("/api/roads")
        assert res.status_code == 200
        assert res.json() == []
