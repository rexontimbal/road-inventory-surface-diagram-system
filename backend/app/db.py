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

        log_cols = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(upload_log)").fetchall()}
        if "edited_count" not in log_cols:
            conn.exec_driver_sql("ALTER TABLE upload_log ADD COLUMN edited_count INTEGER NOT NULL DEFAULT 0")

        conn.commit()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
