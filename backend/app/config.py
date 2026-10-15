"""Loads backend/.env (if present) into the process environment. Import this
module FIRST, before reading any env var -- every module that reads
os.environ (db.py, auth.py, main.py) imports this one up top so dotenv
loading can never lose a race against import order. Safe to import from
multiple modules: load_dotenv() only fills in variables not already set in
the environment, so re-running it here is a no-op after the first call."""

from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BACKEND_DIR / ".env")
