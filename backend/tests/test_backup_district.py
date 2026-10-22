"""Covers District-scoped backup (GET /api/backup/export?district=...) and
restoring a District backup's "Replace this District" mode -- the backup
contains only that District's sections, carries scope/district metadata,
400s on an empty District, and restoring with replace_all only ever wipes
that one District, never the rest of the workspace."""


def test_district_export_contains_only_that_district(client, make_user, as_user, upload_fixture_as):
    owner = make_user("Owner-BackupDist", "owner-backupdist-test@example.com")
    upload_fixture_as(owner)

    with as_user(owner):
        preview = client.get("/api/roads/delete-preview").json()
        deo_a = next(d for d in preview["districts"] if d["deo"] == "DEO A")

        res = client.get("/api/backup/export", params={"district": "DEO A"})
        assert res.status_code == 200, res.text
        backup = res.json()

        assert backup["scope"] == "district"
        assert backup["district"]["deo"] == "DEO A"
        assert backup["counts"]["roads"] == deo_a["sections"]
        assert backup["counts"]["segments"] == deo_a["segments"]
        assert backup["counts"]["logs"] == 0
        assert backup["upload_log"] == []
        assert len(backup["roads"]) == deo_a["sections"]
        assert all(r["deo"] == "DEO A" for r in backup["roads"])


def test_whole_workspace_export_is_unscoped(client, make_user, as_user, upload_fixture_as):
    owner = make_user("Owner-BackupAll", "owner-backupall-test@example.com")
    upload_fixture_as(owner)

    with as_user(owner):
        res = client.get("/api/backup/export")
        assert res.status_code == 200
        backup = res.json()
        assert backup["scope"] == "all"
        assert backup["district"] is None


def test_district_export_404s_on_empty_district(client, make_user, as_user, upload_fixture_as):
    owner = make_user("Owner-BackupEmptyDist", "owner-backupemptydist-test@example.com")
    upload_fixture_as(owner)

    with as_user(owner):
        res = client.get("/api/backup/export", params={"district": "No Such District"})
        assert res.status_code == 400
        assert "no data" in res.json()["detail"].lower()


def test_replace_this_district_leaves_other_districts_untouched(client, make_user, as_user, upload_fixture_as):
    owner = make_user("Owner-RestoreDist", "owner-restoredist-test@example.com")
    upload_fixture_as(owner)

    with as_user(owner):
        before = {r["section_id"]: r for r in client.get("/api/roads").json()}
        other_district_ids_before = {sid for sid, r in before.items() if r["deo"] != "DEO A"}
        assert other_district_ids_before  # fixture spans multiple districts

        backup = client.get("/api/backup/export", params={"district": "DEO A"}).json()

        preview_res = client.post("/api/backup/restore/preview", json={"backup": backup})
        assert preview_res.status_code == 200, preview_res.text
        token = preview_res.json()["token"]

        commit_res = client.post(
            "/api/backup/restore/commit", json={"token": token, "mode": "replace_all", "decisions": {}}
        )
        assert commit_res.status_code == 200, commit_res.text

        after = {r["section_id"]: r for r in client.get("/api/roads").json()}
        # Every non-DEO-A section from before the restore is still there, untouched.
        assert other_district_ids_before <= set(after.keys())
        # DEO A sections came back from the backup (same ids as the backup contained).
        deo_a_ids_in_backup = {r["section_id"] for r in backup["roads"]}
        assert deo_a_ids_in_backup <= set(after.keys())
        assert all(after[sid]["deo"] == "DEO A" for sid in deo_a_ids_in_backup)


def test_district_restore_merge_does_not_touch_other_districts(client, make_user, as_user, upload_fixture_as):
    owner = make_user("Owner-RestoreDistMerge", "owner-restoredistmerge-test@example.com")
    upload_fixture_as(owner)

    with as_user(owner):
        before = {r["section_id"]: r for r in client.get("/api/roads").json()}
        other_district_ids_before = {sid for sid, r in before.items() if r["deo"] != "DEO A"}

        backup = client.get("/api/backup/export", params={"district": "DEO A"}).json()
        preview_res = client.post("/api/backup/restore/preview", json={"backup": backup})
        token = preview_res.json()["token"]
        decisions = {d["section_id"]: "replace" for d in preview_res.json()["duplicates"]}

        commit_res = client.post(
            "/api/backup/restore/commit", json={"token": token, "mode": "merge", "decisions": decisions}
        )
        assert commit_res.status_code == 200, commit_res.text

        after = {r["section_id"]: r for r in client.get("/api/roads").json()}
        assert other_district_ids_before <= set(after.keys())
