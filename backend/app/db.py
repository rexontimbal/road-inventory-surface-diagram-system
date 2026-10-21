import os

from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import declarative_base, sessionmaker

from app import config  # noqa: F401 -- loads backend/.env before the os.environ read below

DATA_DIR = config.BACKEND_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)


def _normalize_database_url(url: str) -> str:
    """Neon/Supabase/Render hand out a plain `postgres://` or `postgresql://`
    URL -- normalize it to the psycopg3 dialect SQLAlchemy needs asked for
    explicitly (`postgresql+psycopg://`), so DATABASE_URL can be pasted
    as-is from any of those dashboards without edits."""
    if url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://") :]
    if url.startswith("postgresql://") and "+psycopg" not in url:
        url = url.replace("postgresql://", "postgresql+psycopg://", 1)
    return url


_env_url = os.environ.get("DATABASE_URL")
if _env_url:
    DATABASE_URL = _normalize_database_url(_env_url)
    IS_SQLITE = False
else:
    # Local dev default -- unchanged from before DATABASE_URL existed.
    DATABASE_URL = f"sqlite:///{DATA_DIR / 'road_inventory.db'}"
    IS_SQLITE = True

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False} if IS_SQLITE else {})


@event.listens_for(engine, "connect")
def _set_sqlite_pragma(dbapi_connection, connection_record):
    if not IS_SQLITE:
        return
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.close()


SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def _migrate_roads_to_owner_scoped_schema(conn):
    """Road's primary key changes from road_id alone to
    (road_id, owner_type, owner_id) -- without that, a guest uploading the
    same sample file as the shared workspace (an entirely expected case)
    would collide on road_id instead of staying isolated. SQLite can't ALTER
    a primary key in place, so this rebuilds both tables from the current
    model metadata and copies every existing row over as owner_type=
    'workspace' (the existing data's new home, per Part 4's guest-mode
    design -- nothing existing becomes a guest's)."""
    from app.models import Road, RoadSegment, WORKSPACE_OWNER_ID  # local import -- avoids a load-order cycle

    conn.exec_driver_sql("ALTER TABLE roads RENAME TO roads_old")
    conn.exec_driver_sql("ALTER TABLE road_segments RENAME TO road_segments_old")
    # SQLite indexes (including the one backing a named UNIQUE constraint)
    # keep their own name through a table rename and live in the same
    # database-wide namespace as every other index -- without dropping
    # these, creating the new road_segments table below (same index/
    # constraint names) would fail with "index already exists".
    conn.exec_driver_sql("DROP INDEX IF EXISTS idx_segments_road_start")
    conn.exec_driver_sql("DROP INDEX IF EXISTS uq_road_seq")
    Road.__table__.create(conn)
    RoadSegment.__table__.create(conn)
    conn.exec_driver_sql(
        f"""
        INSERT INTO roads (road_id, owner_type, owner_id, road_name, updated_at,
                            uploaded_at, source_file, segment_count, total_length_m)
        SELECT road_id, 'workspace', '{WORKSPACE_OWNER_ID}', road_name, updated_at,
               uploaded_at, source_file, segment_count, total_length_m
        FROM roads_old
        """
    )
    conn.exec_driver_sql(
        f"""
        INSERT INTO road_segments (id, road_id, owner_type, owner_id, seq_no,
                                    start_station_raw, end_station_raw, start_m, end_m,
                                    num_lanes, surface_type, shoulder_left, shoulder_right,
                                    source_row_number)
        SELECT id, road_id, 'workspace', '{WORKSPACE_OWNER_ID}', seq_no,
               start_station_raw, end_station_raw, start_m, end_m,
               num_lanes, surface_type, shoulder_left, shoulder_right,
               source_row_number
        FROM road_segments_old
        """
    )
    conn.exec_driver_sql("DROP TABLE road_segments_old")
    conn.exec_driver_sql("DROP TABLE roads_old")


def _migrate_road_id_to_section_id(conn):
    """Road's primary key column is renamed road_id -> section_id, and both
    tables gain the new DPWH fields (classification/deo/ld on roads;
    start_text/end_text/length_m/irregular_km_post on road_segments,
    replacing start_station_raw/end_station_raw). The surface/shoulder CHECK
    constraints also change vocabulary (old: unpaved/paved/gravel/asphalt;
    new surface: concrete/asphalt/gravel; new shoulder: gravel/concrete/
    asphalt/earth/none) -- SQLite can't ALTER a CHECK constraint in place, so
    this rebuilds both tables from the current model metadata, same approach
    as _migrate_roads_to_owner_scoped_schema above.

    Existing rows keep their data: old surface/shoulder values are mapped
    onto the closest new vocabulary (paved->concrete, unpaved->earth/gravel)
    rather than dropped, since this is local dev/sample data predating the
    real DPWH format, not something we can ask DPWH to re-classify."""
    from app.models import Road, RoadSegment, WORKSPACE_OWNER_ID  # local import -- avoids a load-order cycle

    conn.exec_driver_sql("ALTER TABLE roads RENAME TO roads_old")
    conn.exec_driver_sql("ALTER TABLE road_segments RENAME TO road_segments_old")
    conn.exec_driver_sql("DROP INDEX IF EXISTS idx_segments_road_start")
    conn.exec_driver_sql("DROP INDEX IF EXISTS idx_segments_section_start")
    conn.exec_driver_sql("DROP INDEX IF EXISTS uq_road_seq")
    conn.exec_driver_sql("DROP INDEX IF EXISTS uq_section_seq")
    Road.__table__.create(conn)
    RoadSegment.__table__.create(conn)
    conn.exec_driver_sql(
        f"""
        INSERT INTO roads (section_id, owner_type, owner_id, road_name, classification, deo, ld,
                            updated_at, uploaded_at, source_file, segment_count, total_length_m)
        SELECT road_id, owner_type, owner_id, road_name, NULL, NULL, NULL,
               updated_at, uploaded_at, source_file, segment_count, total_length_m
        FROM roads_old
        """
    )
    conn.exec_driver_sql(
        f"""
        INSERT INTO road_segments (id, section_id, owner_type, owner_id, seq_no,
                                    start_text, end_text, start_m, end_m, length_m,
                                    irregular_km_post, num_lanes, surface_type,
                                    shoulder_left, shoulder_right, source_row_number)
        SELECT id, road_id, owner_type, owner_id, seq_no,
               start_station_raw, end_station_raw, start_m, end_m,
               MAX(end_m - start_m, 0), CASE WHEN end_m - start_m <= 0 THEN 1 ELSE 0 END,
               num_lanes,
               CASE surface_type WHEN 'paved' THEN 'concrete' WHEN 'unpaved' THEN 'gravel' ELSE surface_type END,
               CASE shoulder_left WHEN 'paved' THEN 'concrete' WHEN 'unpaved' THEN 'earth' ELSE shoulder_left END,
               CASE shoulder_right WHEN 'paved' THEN 'concrete' WHEN 'unpaved' THEN 'earth' ELSE shoulder_right END,
               source_row_number
        FROM road_segments_old
        """
    )
    conn.exec_driver_sql("DROP TABLE road_segments_old")
    conn.exec_driver_sql("DROP TABLE roads_old")


def _pg_table_columns(conn, table: str) -> set[str]:
    rows = conn.exec_driver_sql(
        "SELECT column_name FROM information_schema.columns WHERE table_name = %s",
        (table,),
    ).fetchall()
    return {row[0] for row in rows}


def _pg_constraint_names(conn, table: str, contype: str) -> list[str]:
    """contype: 'p' (primary key), 'f' (foreign key), 'u' (unique), 'c' (check).
    Looked up by catalog query rather than hardcoded -- a constraint
    SQLAlchemy/Postgres auto-named (no explicit `name=` in the old model)
    can't be relied on to have a predictable name across however this
    database was originally provisioned."""
    rows = conn.exec_driver_sql(
        "SELECT conname FROM pg_constraint WHERE conrelid = %s::regclass AND contype = %s",
        (table, contype),
    ).fetchall()
    return [row[0] for row in rows]


def _pg_migrate_roads_to_owner_scoped_schema(conn):
    """Postgres equivalent of _migrate_roads_to_owner_scoped_schema above --
    same end state (Road's primary key becomes (road_id, owner_type,
    owner_id)), but Postgres's ALTER TABLE is flexible enough to do this
    additively (add columns, swap the primary key, re-point road_segments'
    foreign key/unique/index at the new composite key) instead of SQLite's
    rename-rebuild-copy dance."""
    from app.models import WORKSPACE_OWNER_ID  # local import -- avoids a load-order cycle

    conn.exec_driver_sql("ALTER TABLE roads ADD COLUMN owner_type TEXT NOT NULL DEFAULT 'workspace'")
    conn.exec_driver_sql(f"ALTER TABLE roads ADD COLUMN owner_id TEXT NOT NULL DEFAULT '{WORKSPACE_OWNER_ID}'")
    for name in _pg_constraint_names(conn, "roads", "p"):
        conn.exec_driver_sql(f'ALTER TABLE roads DROP CONSTRAINT "{name}"')
    conn.exec_driver_sql("ALTER TABLE roads ADD PRIMARY KEY (road_id, owner_type, owner_id)")

    conn.exec_driver_sql("ALTER TABLE road_segments ADD COLUMN owner_type TEXT NOT NULL DEFAULT 'workspace'")
    conn.exec_driver_sql(
        f"ALTER TABLE road_segments ADD COLUMN owner_id TEXT NOT NULL DEFAULT '{WORKSPACE_OWNER_ID}'"
    )
    for name in _pg_constraint_names(conn, "road_segments", "f"):
        conn.exec_driver_sql(f'ALTER TABLE road_segments DROP CONSTRAINT "{name}"')
    conn.exec_driver_sql(
        "ALTER TABLE road_segments ADD CONSTRAINT road_segments_road_id_fkey "
        "FOREIGN KEY (road_id, owner_type, owner_id) REFERENCES roads (road_id, owner_type, owner_id) "
        "ON DELETE CASCADE"
    )
    for name in _pg_constraint_names(conn, "road_segments", "u"):
        conn.exec_driver_sql(f'ALTER TABLE road_segments DROP CONSTRAINT "{name}"')
    conn.exec_driver_sql(
        "ALTER TABLE road_segments ADD CONSTRAINT uq_road_seq UNIQUE (road_id, owner_type, owner_id, seq_no)"
    )
    conn.exec_driver_sql("DROP INDEX IF EXISTS idx_segments_road_start")
    conn.exec_driver_sql(
        "CREATE INDEX idx_segments_road_start ON road_segments (road_id, owner_type, owner_id, start_m)"
    )


def _pg_migrate_road_id_to_section_id(conn):
    """Postgres equivalent of _migrate_road_id_to_section_id above -- same
    end state, but Postgres's ALTER TABLE ... RENAME COLUMN works directly
    (it transparently updates every reference to that column -- primary key,
    foreign key, indexes all keep working under their existing names), so
    this is additive/renaming rather than SQLite's rename-rebuild-copy
    dance. The CHECK constraints on surface_type/shoulder_left/
    shoulder_right still can't be altered in place -- those are dropped and
    re-added with the new vocabulary, after remapping existing values so
    the new CHECK doesn't reject old rows (same mapping as SQLite: paved->
    concrete, unpaved->gravel/earth)."""
    from app.models import SHOULDER_TYPES, SURFACE_TYPES  # local import -- avoids a load-order cycle

    conn.exec_driver_sql("ALTER TABLE roads RENAME COLUMN road_id TO section_id")
    conn.exec_driver_sql("ALTER TABLE road_segments RENAME COLUMN road_id TO section_id")

    conn.exec_driver_sql("ALTER TABLE roads ADD COLUMN classification TEXT")
    conn.exec_driver_sql("ALTER TABLE roads ADD COLUMN deo TEXT")
    conn.exec_driver_sql("ALTER TABLE roads ADD COLUMN ld TEXT")
    conn.exec_driver_sql("ALTER TABLE roads ALTER COLUMN total_length_m TYPE DOUBLE PRECISION")

    conn.exec_driver_sql("ALTER TABLE road_segments RENAME COLUMN start_station_raw TO start_text")
    conn.exec_driver_sql("ALTER TABLE road_segments RENAME COLUMN end_station_raw TO end_text")
    # Widened from Integer -- DPWH offsets can be decimal (e.g. "K1271 +
    # 099.80"), which an Integer column would silently truncate.
    conn.exec_driver_sql("ALTER TABLE road_segments ALTER COLUMN start_m TYPE DOUBLE PRECISION")
    conn.exec_driver_sql("ALTER TABLE road_segments ALTER COLUMN end_m TYPE DOUBLE PRECISION")
    conn.exec_driver_sql("ALTER TABLE road_segments ADD COLUMN length_m DOUBLE PRECISION")
    conn.exec_driver_sql("ALTER TABLE road_segments ADD COLUMN irregular_km_post BOOLEAN")
    conn.exec_driver_sql(
        "UPDATE road_segments SET length_m = GREATEST(end_m - start_m, 0), "
        "irregular_km_post = (end_m - start_m) <= 0"
    )
    conn.exec_driver_sql("ALTER TABLE road_segments ALTER COLUMN length_m SET NOT NULL")
    conn.exec_driver_sql("ALTER TABLE road_segments ALTER COLUMN irregular_km_post SET NOT NULL")

    # Old CHECK constraints must come off BEFORE remapping the data below --
    # they still enforce the OLD vocabulary until dropped, so an UPDATE that
    # writes 'concrete'/'earth' would itself violate them.
    for name in _pg_constraint_names(conn, "road_segments", "c"):
        conn.exec_driver_sql(f'ALTER TABLE road_segments DROP CONSTRAINT "{name}"')

    conn.exec_driver_sql(
        "UPDATE road_segments SET surface_type = CASE surface_type "
        "WHEN 'paved' THEN 'concrete' WHEN 'unpaved' THEN 'gravel' ELSE surface_type END"
    )
    conn.exec_driver_sql(
        "UPDATE road_segments SET shoulder_left = CASE shoulder_left "
        "WHEN 'paved' THEN 'concrete' WHEN 'unpaved' THEN 'earth' ELSE shoulder_left END"
    )
    conn.exec_driver_sql(
        "UPDATE road_segments SET shoulder_right = CASE shoulder_right "
        "WHEN 'paved' THEN 'concrete' WHEN 'unpaved' THEN 'earth' ELSE shoulder_right END"
    )
    conn.exec_driver_sql(f"ALTER TABLE road_segments ADD CONSTRAINT ck_surface_type CHECK (surface_type IN {SURFACE_TYPES})")
    conn.exec_driver_sql(
        f"ALTER TABLE road_segments ADD CONSTRAINT ck_shoulder_left CHECK (shoulder_left IN {SHOULDER_TYPES})"
    )
    conn.exec_driver_sql(
        f"ALTER TABLE road_segments ADD CONSTRAINT ck_shoulder_right CHECK (shoulder_right IN {SHOULDER_TYPES})"
    )


def _ensure_schema_postgres():
    with engine.connect() as conn:
        existing_cols = _pg_table_columns(conn, "roads")
        if "source_file" not in existing_cols:
            conn.exec_driver_sql("ALTER TABLE roads ADD COLUMN source_file TEXT")
        if "uploaded_at" not in existing_cols:
            conn.exec_driver_sql("ALTER TABLE roads ADD COLUMN uploaded_at TEXT")
            conn.exec_driver_sql("UPDATE roads SET uploaded_at = updated_at WHERE uploaded_at IS NULL")
        if "owner_type" not in existing_cols:
            _pg_migrate_roads_to_owner_scoped_schema(conn)
            existing_cols = _pg_table_columns(conn, "roads")
        if "section_id" not in existing_cols:
            _pg_migrate_road_id_to_section_id(conn)

        log_cols = _pg_table_columns(conn, "upload_log")
        if "edited_count" not in log_cols:
            conn.exec_driver_sql("ALTER TABLE upload_log ADD COLUMN edited_count INTEGER NOT NULL DEFAULT 0")
        if "owner_type" not in log_cols:
            conn.exec_driver_sql("ALTER TABLE upload_log ADD COLUMN owner_type TEXT NOT NULL DEFAULT 'workspace'")
            conn.exec_driver_sql("ALTER TABLE upload_log ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''")
        if "user_id" not in log_cols:
            conn.exec_driver_sql("ALTER TABLE upload_log ADD COLUMN user_id INTEGER")
            conn.exec_driver_sql("ALTER TABLE upload_log ADD COLUMN actor_name TEXT")
            conn.exec_driver_sql("ALTER TABLE upload_log ADD COLUMN actor_email TEXT")
            conn.exec_driver_sql("ALTER TABLE upload_log ADD COLUMN actor_avatar_url TEXT")

        # workspace_shares itself is created fresh (with every current
        # column, these two included) by Base.metadata.create_all whenever
        # it doesn't exist yet -- this only ever fires on a DB that already
        # had the table from before share notifications existed.
        share_cols = _pg_table_columns(conn, "workspace_shares")
        if "seen_at" not in share_cols:
            conn.exec_driver_sql("ALTER TABLE workspace_shares ADD COLUMN seen_at TEXT")
            conn.exec_driver_sql("ALTER TABLE workspace_shares ADD COLUMN last_change TEXT")

        conn.commit()


def _migrate_legacy_workspace_data(conn):
    """One-time reassignment of pre-accounts shared data (owner_type=
    'workspace', from when every signed-in user saw the same pool) into a
    real per-user workspace -- gated entirely by LEGACY_DATA_OWNER_EMAIL, so
    this is a silent no-op on every deploy that hasn't set it. Uses
    conn.execute(text(...), params) rather than exec_driver_sql here (unlike
    the rest of this file) specifically so the same parameterized SQL works
    unchanged on both SQLite (qmark) and psycopg (%s) without a dialect
    branch -- the email comes from an env var, not request input, but
    there's no reason to hand-interpolate it into the query either.

    Idempotent and safe to leave in place permanently: the UPDATEs only
    touch owner_type='workspace' rows, and after the first successful run
    there are none left, so every later startup's COUNT(*) check is 0 and
    returns immediately. Matches the target email case-insensitively since
    Google account emails aren't stored lowercased.

    road_segments' (section_id, owner_type, owner_id) foreign key to roads
    has no ON UPDATE CASCADE, so an UPDATE that reassigns the PARENT row's
    key columns is rejected immediately by both engines while a child row
    still points at the old (section_id, 'workspace', '') combination --
    confirmed by actually running this against real data, not just reasoned
    through. The constraint is dropped for the duration of this one
    multi-table update and recreated identically after, same technique this
    file already uses for CHECK constraints that can't be altered in place.
    Caller must NOT already have an open transaction on `conn` when this
    runs: SQLite's PRAGMA foreign_keys is a no-op inside one ("may only be
    enabled or disabled when there is no pending BEGIN"), which would
    silently leave the constraint enforced and this would still fail."""
    target_email = (os.environ.get("LEGACY_DATA_OWNER_EMAIL") or "").strip()
    if not target_email:
        return

    row = conn.execute(
        text("SELECT id FROM users WHERE LOWER(email) = LOWER(:email)"), {"email": target_email}
    ).fetchone()
    if row is None:
        print(
            f"LEGACY_DATA_OWNER_EMAIL={target_email!r} is set but no matching user has signed "
            "in yet -- legacy workspace data stays untouched until they do."
        )
        return
    owner_id = str(row[0])

    road_count = conn.execute(text("SELECT COUNT(*) FROM roads WHERE owner_type = 'workspace'")).scalar()
    if not road_count:
        return  # already migrated (or there was never any shared data)

    seg_count = conn.execute(text("SELECT COUNT(*) FROM road_segments WHERE owner_type = 'workspace'")).scalar()
    log_count = conn.execute(text("SELECT COUNT(*) FROM upload_log WHERE owner_type = 'workspace'")).scalar()

    if IS_SQLITE:
        # The SELECTs above already auto-began their own transaction (any
        # execute() does, on a fresh or just-committed connection) -- close
        # it out immediately before this PRAGMA, which is a silent no-op
        # while one is open.
        conn.commit()
        conn.exec_driver_sql("PRAGMA foreign_keys = OFF")
    else:
        for name in _pg_constraint_names(conn, "road_segments", "f"):
            conn.exec_driver_sql(f'ALTER TABLE road_segments DROP CONSTRAINT "{name}"')

    conn.execute(
        text("UPDATE roads SET owner_type = 'user', owner_id = :oid WHERE owner_type = 'workspace'"),
        {"oid": owner_id},
    )
    conn.execute(
        text("UPDATE road_segments SET owner_type = 'user', owner_id = :oid WHERE owner_type = 'workspace'"),
        {"oid": owner_id},
    )
    conn.execute(
        text("UPDATE upload_log SET owner_type = 'user', owner_id = :oid WHERE owner_type = 'workspace'"),
        {"oid": owner_id},
    )

    if IS_SQLITE:
        # Takes effect immediately even mid-transaction when turning ON
        # (unlike OFF, which needs no pending BEGIN) -- but commit anyway so
        # a crash before the next statement can't leave it off for the rest
        # of this connection's lifetime in the pool.
        conn.exec_driver_sql("PRAGMA foreign_keys = ON")
        conn.commit()
    else:
        conn.exec_driver_sql(
            "ALTER TABLE road_segments ADD CONSTRAINT road_segments_section_id_fkey "
            "FOREIGN KEY (section_id, owner_type, owner_id) REFERENCES roads (section_id, owner_type, owner_id) "
            "ON DELETE CASCADE"
        )

    print(
        f"Legacy data migration: moved {road_count} section(s), {seg_count} segment(s), "
        f"{log_count} upload-log entr{'y' if log_count == 1 else 'ies'} to {target_email} (user id {row[0]})"
    )


def ensure_schema():
    """Base.metadata.create_all only creates missing TABLES, not missing
    COLUMNS on a table that already exists -- so a column added to a model
    after the live database was first created needs an explicit, additive
    ALTER TABLE here. Safe to call on every startup: each column/constraint
    change is only applied if it isn't already present.

    Both branches patch the same sequence of historical revisions (owner-
    scoped roads, then the road_id -> section_id/DPWH rename) up to the
    current model -- SQLite and Postgres just need different DDL to get
    there (SQLite can't ALTER a primary key or a CHECK constraint in place,
    so those steps rebuild the table; Postgres supports both directly). The
    legacy-workspace-data reassignment at the end runs for both dialects the
    same way, since it's plain parameterized DML, not DDL."""
    if not IS_SQLITE:
        _ensure_schema_postgres()
        with engine.connect() as conn:
            _migrate_legacy_workspace_data(conn)
            conn.commit()
        return
    with engine.connect() as conn:
        existing_cols = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(roads)").fetchall()}
        if "source_file" not in existing_cols:
            conn.exec_driver_sql("ALTER TABLE roads ADD COLUMN source_file TEXT")
        if "uploaded_at" not in existing_cols:
            conn.exec_driver_sql("ALTER TABLE roads ADD COLUMN uploaded_at TEXT")
            # Backfill from updated_at so pre-existing roads have a sensible
            # "first uploaded" value instead of NULL.
            conn.exec_driver_sql("UPDATE roads SET uploaded_at = updated_at WHERE uploaded_at IS NULL")
        if "owner_type" not in existing_cols:
            _migrate_roads_to_owner_scoped_schema(conn)
            existing_cols = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(roads)").fetchall()}
        if "section_id" not in existing_cols:
            _migrate_road_id_to_section_id(conn)

        log_cols = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(upload_log)").fetchall()}
        if "edited_count" not in log_cols:
            conn.exec_driver_sql("ALTER TABLE upload_log ADD COLUMN edited_count INTEGER NOT NULL DEFAULT 0")
        if "owner_type" not in log_cols:
            # Not part of any key here (just a filter column), so a plain
            # additive ALTER TABLE is enough -- no rebuild needed.
            conn.exec_driver_sql("ALTER TABLE upload_log ADD COLUMN owner_type TEXT NOT NULL DEFAULT 'workspace'")
            conn.exec_driver_sql("ALTER TABLE upload_log ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''")
        if "user_id" not in log_cols:
            # Every row that existed before this tracking shipped has no
            # actor -- the UI reads that (owner_type='workspace' + no
            # user_id) as "Unknown", not "Guest". Plain nullable columns,
            # no backfill needed (NULL is the correct value already).
            conn.exec_driver_sql("ALTER TABLE upload_log ADD COLUMN user_id INTEGER")
            conn.exec_driver_sql("ALTER TABLE upload_log ADD COLUMN actor_name TEXT")
            conn.exec_driver_sql("ALTER TABLE upload_log ADD COLUMN actor_email TEXT")
            conn.exec_driver_sql("ALTER TABLE upload_log ADD COLUMN actor_avatar_url TEXT")

        share_cols = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(workspace_shares)").fetchall()}
        if "seen_at" not in share_cols:
            conn.exec_driver_sql("ALTER TABLE workspace_shares ADD COLUMN seen_at TEXT")
            conn.exec_driver_sql("ALTER TABLE workspace_shares ADD COLUMN last_change TEXT")

        # Commits (and so closes out) the schema-migration transaction above
        # before the legacy-data migration runs -- it needs to toggle
        # PRAGMA foreign_keys mid-function, which SQLite silently ignores
        # while a transaction is still open.
        conn.commit()
        _migrate_legacy_workspace_data(conn)
        conn.commit()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
