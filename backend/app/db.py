import os

from sqlalchemy import create_engine, event
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


def ensure_schema():
    """Base.metadata.create_all only creates missing TABLES, not missing
    COLUMNS on a table that already exists -- so a column added to a model
    after the live DB file was first created needs an explicit, additive
    ALTER TABLE here. Safe to call on every startup: each column is only
    added if it isn't already present.

    SQLite-only: these patches exist because the local dev DB file has been
    through several schema revisions over time. A Postgres DATABASE_URL
    always starts from Base.metadata.create_all's fresh, fully-current
    schema, so none of this historical backfill is needed there."""
    if not IS_SQLITE:
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

        conn.commit()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
