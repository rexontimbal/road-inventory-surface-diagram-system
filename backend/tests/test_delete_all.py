"""Covers "Delete all data" (optionally scoped to one District): owner-only,
scoped to the active workspace only, District-only delete leaves other
districts alone, and it writes one Upload History entry instead of touching
existing entries. Single-section DELETE /{section_id} is untouched and not
re-tested here (see test_sharing.py / existing coverage for that)."""


def test_owner_deletes_all_data(client, make_user, as_user, upload_fixture_as):
    owner = make_user("Owner-DelAll", "owner-delall-test@example.com")
    upload_fixture_as(owner)

    with as_user(owner):
        preview_res = client.get("/api/roads/delete-preview")
        assert preview_res.status_code == 200
        preview = preview_res.json()
        assert preview["total_sections"] > 0
        assert preview["total_segments"] > 0
        assert len(preview["districts"]) >= 2  # fixture spans DEO A/B/C(/D)

        before_log = client.get("/api/roads/upload-log", params={"page": 1, "page_size": 50}).json()
        before_count = before_log["total_records"]

        delete_res = client.delete("/api/roads")
        assert delete_res.status_code == 200
        body = delete_res.json()
        assert body["deleted_sections"] == preview["total_sections"]
        assert body["deleted_segments"] == preview["total_segments"]

        # Roads (and, via cascade, their segments) are gone.
        roads_res = client.get("/api/roads")
        assert roads_res.json() == []
        segments_res = client.get("/api/roads/segments", params={"page": 1, "page_size": 1})
        assert segments_res.json()["total_records"] == 0

        # Upload History is KEPT, with exactly one new entry describing it.
        after_log = client.get("/api/roads/upload-log", params={"page": 1, "page_size": 50}).json()
        assert after_log["total_records"] == before_count + 1
        newest = after_log["entries"][0]
        assert newest["kind"] == "delete"
        assert newest["details"][0]["section_id"] == "ALL"
        assert str(preview["total_sections"]) in newest["details"][0]["road_name"]


def test_owner_deletes_one_district_leaves_others(client, make_user, as_user, upload_fixture_as):
    owner = make_user("Owner-DelDist", "owner-deldist-test@example.com")
    upload_fixture_as(owner)

    with as_user(owner):
        preview_before = client.get("/api/roads/delete-preview").json()
        deo_a = next(d for d in preview_before["districts"] if d["deo"] == "DEO A")

        delete_res = client.delete("/api/roads", params={"district": "DEO A"})
        assert delete_res.status_code == 200
        body = delete_res.json()
        assert body["deleted_sections"] == deo_a["sections"]
        assert body["deleted_segments"] == deo_a["segments"]

        remaining = client.get("/api/roads").json()
        assert all(r["deo"] != "DEO A" for r in remaining)
        assert len(remaining) > 0  # other districts survive

        newest = client.get("/api/roads/upload-log", params={"page": 1, "page_size": 5}).json()["entries"][0]
        assert newest["details"][0]["section_id"] == "DISTRICT: DEO A"


def test_delete_all_is_owner_only(client, make_user, as_user, upload_fixture_as, shared_scope):
    owner = make_user("Owner-DelPerm", "owner-delperm-test@example.com")
    editor_user = make_user("Editor-DelPerm", "editor-delperm-test@example.com")
    viewer_user = make_user("Viewer-DelPerm", "viewer-delperm-test@example.com")
    upload_fixture_as(owner)

    editor_scope = shared_scope(owner, editor_user, "editor")
    with as_user(editor_scope):
        assert client.get("/api/roads/delete-preview").status_code == 403
        assert client.delete("/api/roads").status_code == 403

    viewer_scope = shared_scope(owner, viewer_user, "viewer")
    with as_user(viewer_scope):
        assert client.get("/api/roads/delete-preview").status_code == 403
        assert client.delete("/api/roads").status_code == 403

    # Nothing was touched by the blocked attempts.
    with as_user(owner):
        assert len(client.get("/api/roads").json()) > 0


def test_delete_all_never_touches_other_workspaces(client, make_user, as_user, upload_fixture_as):
    owner = make_user("Owner-DelIso", "owner-deliso-test@example.com")
    other_owner = make_user("Other-Owner-DelIso", "other-owner-deliso-test@example.com")
    upload_fixture_as(owner)
    upload_fixture_as(other_owner)

    with as_user(owner):
        client.delete("/api/roads")
        assert client.get("/api/roads").json() == []

    with as_user(other_owner):
        assert len(client.get("/api/roads").json()) > 0
