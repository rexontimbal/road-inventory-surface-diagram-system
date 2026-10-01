# Road Inventory & Surface Diagram System

Excel-based road pavement inventory tracking and strip-map surface diagram
generator. Upload a road inventory Excel file, browse the inventory table,
and generate a station-by-station diagram showing which parts of each road
are already asphalted ("spalto" = done) versus not.

## Stack

- **Backend**: Python 3.12 + FastAPI + SQLAlchemy + SQLite
- **Excel parsing**: `openpyxl` (no `pandas` — its native DLLs were blocked by
  this machine's Application Control policy; `openpyxl` is pure Python and
  avoids that entirely, which is also safer for a locked-down office PC)
- **Frontend**: React + Vite
- **Diagram rendering**: HTML5 Canvas

## Running in development

### Quick start: `start.bat`

Double-click `start.bat` at the project root. It opens the backend and
frontend each in their own window and opens the app in your browser once
both are up. Requires the one-time setup below to have been done already
(venv created + `pip install`, `npm install`). To stop, just close the two
server windows.

### Backend (port 8000)

```powershell
cd backend
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
venv\Scripts\python.exe -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Use `python -m uvicorn` (not the bare `uvicorn` command) — on a machine with
an Application Control / Device Guard policy, the `uvicorn.exe` shim in
`venv\Scripts` gets blocked as an unapproved executable, while running it as
a module through `python.exe` is unaffected.

API docs available at `http://localhost:8000/docs`.

### Frontend (port 5173)

```powershell
cd frontend
npm install
npm run dev
```

**Known issue on this project folder**: because the folder name contains an
`&` (`Road Inventory & Surface Diagram System`), `npm run dev` / `npm run
build` fail on Windows — npm internally spawns scripts through `cmd.exe`,
which splits the working-directory path on `&`. If you hit
`'Surface' is not recognized as an internal or external command`, run Vite's
Node entry point directly instead, which bypasses the cmd.exe wrapper:

```powershell
node node_modules\vite\bin\vite.js --port 5173
# production build:
node node_modules\vite\bin\vite.js build
```

This only affects this specific folder name; a plain `npm run dev` will work
fine on any deployment path that doesn't contain `&`.

## Project layout

```
backend/
  app/
    main.py            # FastAPI app + CORS
    db.py               # SQLAlchemy engine/session, SQLite PRAGMAs
    models.py           # Road, RoadSegment ORM models
    schemas.py           # Pydantic request/response models
    chainage.py          # 'K+MMM' station parsing + per-road validation
    excel_import.py      # Excel template enforcement + import orchestration
    routers/roads.py     # /api/roads* endpoints
  tests/                 # pytest unit tests (chainage + excel import, run
                          #   against the real sample_road_inventory.xlsx)
  data/road_inventory.db  # SQLite database file (created on first run)

frontend/
  src/
    App.jsx              # top-level state and layout
    api/roads.js         # fetch wrapper for the backend API
    components/
      sidebar/            # Upload, Select Road, Diagram Settings panels
      inventory/           # Road Inventory Data table + pagination
      diagram/              # Canvas diagram renderer, legend, export/print

sample INTERFACE.jpg       # client-provided UI reference
sample diagram.jpg         # client-provided diagram output reference
sample_road_inventory.xlsx # client-provided template/sample data
```

## Excel template

The upload must follow the confirmed template structure (see
`sample_road_inventory.xlsx`): **row 1** is a decorative two-column-group
header (`STATION` spanning Start/End, `SHOULDER` spanning Left/Right), **row
2** holds the actual column names, **row 3 onward** is data:

| ROAD ID | Road Name | Start | End | Number of Lanes | Surface type | LEFT | RIGHT |
|---|---|---|---|---|---|---|---|

- Station format: `K+MMM` chainage notation, e.g. `5+000`, `18+000`.
- Surface type / LEFT / RIGHT values: `unpaved`, `paved`, `gravel`, `asphalt`.
- Column order is not enforced; matching is case-insensitive by name.

## Upload behavior

Uploading a file replaces data **only for the Road ID(s) contained in that
file** — other roads already stored are untouched. Within one upload, a
Road ID with any validation error (malformed station, overlapping/gapped
segments, invalid surface value, non-positive lane count) is rejected in
full and reported with row numbers and messages; roads with no errors are
imported normally. Only a structural problem (a required column missing
from the file) aborts the entire upload.

## Tests

```powershell
cd backend
.\venv\Scripts\Activate.ps1
pytest tests/ -v
```

## Deploying so a client can access it via a link (no install needed)

The backend can serve the built frontend directly, so the whole system runs
as **one URL** (see the static-file mount in `backend/app/main.py`, active
whenever `frontend/dist` exists). That makes it deployable as a single web
service.

### 1. Push to GitHub

```powershell
git remote add origin <your-empty-github-repo-url>
git branch -M main
git push -u origin main
```

(Create the empty repo first at github.com/new — don't initialize it with a
README/.gitignore, since this project already has its own.)

### 2. Deploy on Render.com (free tier)

1. Sign in to [render.com](https://render.com) with your GitHub account.
2. **New** → **Blueprint** → pick this repo. Render will read `render.yaml`
   at the repo root and configure the build/start commands automatically.
   (Or **New** → **Web Service** and set them manually: build command
   `cd backend && pip install -r requirements.txt && cd ../frontend && npm
   install && npm run build`, start command `cd backend && uvicorn
   app.main:app --host 0.0.0.0 --port $PORT`.)
3. Deploy. Render gives you a public URL — that's the link to send the
   client.

**Important caveat**: Render's **free** web service plan has an ephemeral
filesystem — the SQLite database (`backend/data/road_inventory.db`) gets
wiped on every redeploy, and the instance also spins down after 15 minutes
of inactivity (the first request after that takes ~30–60s to wake back up).
That's fine for the client to *try out* the upload/diagram workflow, but
uploaded data won't reliably persist long-term on the free tier. If the
client wants to actually start using it for real, upgrade to a paid instance
(~$7/mo) and attach a persistent disk (~$0.25/GB/mo) mounted at
`backend/data`, so uploads survive redeploys — ask me and I'll wire that up
when you're ready for that step.
