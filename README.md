# Florida Mission Planner

A production-ready Electron + React desktop application for planning and simulating custom missions across the State of Florida. The app treats the peninsula as a precision EPSG:26917 (metre-based) build plate, validates missions written in a custom DSL, compiles and densifies waypoints, animates traversal, and exports controller-friendly CSV/GeoJSON artifacts. Heavy geospatial workloads run inside a Python FastAPI worker to keep the UI responsive.

## Repository structure

```
app/                # Electron + React (Vite) renderer + main process
app/electron/       # Electron main & preload processes (TypeScript)
app/src/            # React UI, Monaco editor, MapLibre integration
app_data/           # Cached boundary, grids, mission exports (created at runtime)
examples/           # Sample missions (.mission)
server/             # Python FastAPI worker (geospatial processing)
server/tests/       # Pytest unit tests for parser, projection, validation
```

## Prerequisites

* Node.js 18+
* npm 9+
* Python 3.10+
* Git / build tools required by native dependencies on your platform

## First-time setup

1. **Install Node dependencies**
   ```bash
   cd app
   npm install
   ```

2. **Create a Python virtual environment** (recommended) and install worker dependencies:
   ```bash
   cd ..
   python -m venv venv
   source venv/bin/activate  # Windows: venv\Scripts\activate
   pip install -r server/requirements.txt
   ```

   The Electron app looks for a `python` executable on the `PATH`. To use the virtual environment, launch the app from a shell where the venv is activated or set `PYTHON_BIN` to the interpreter path.

3. **Bundle an embedded Python runtime for packaged builds**
   ```bash
   cd app
   npm run bundle:python
   ```

   This command creates a self-contained `python_env/` directory with all worker dependencies, ensuring the packaged desktop app ships with a ready-to-run interpreter.

## Development workflow

*Start the Electron + Vite dev environment (renderer + Electron main + Python worker):*
```bash
cd app
npm run dev
```
This command will:
1. Start the Vite dev server for the React renderer.
2. Spawn the Python FastAPI worker on `http://127.0.0.1:8765`.
3. Launch Electron pointing at the dev server.

The first run will download and cache the Florida state boundary (FDOT primary source with Census fallback) to `app_data/florida_boundary.geojson` in EPSG:26917. Subsequent runs reuse the cached boundary unless deleted.

Use the **“New Mission”** button in the right-hand control pane to populate the editor with the Miami → Fort Lauderdale example mission at any time. It restores the canonical template without touching any existing exports.

## Building desktop packages

Electron Builder is configured for Windows (NSIS + ZIP), macOS (DMG + ZIP), and Linux (AppImage + tar.gz). Packages include the React renderer build, compiled Electron main/preload scripts, the Python worker source, and example missions.

```bash
cd app
npm run build:desktop
```
Artifacts are output to `app/dist/` by default. The `build:desktop` script automatically refreshes the embedded `python_env/` so installers include a fully provisioned Python worker.

### Windows quick-start packaging

If you only need a Windows installer and you are running on a machine without global Python tools configured, use PowerShell from the repository root:

```powershell
# Install frontend dependencies and build artefacts
cd app
npm ci
npm run bundle:python
npm run build:desktop -- --win
```

`npm ci` guarantees the install reproduces the locked dependency versions. After the build finishes, the NSIS installer and a portable ZIP live under `app/dist/`. Both bundles contain the cached Python environment and do not require a system-wide interpreter on the target computer.

### Continuous integration builds

Every push or pull request triggers the `Build desktop packages` GitHub Actions workflow, which builds Windows, macOS, and Linux installers and publishes them as downloadable artifacts. Grab the installer for your platform directly from the workflow run if you don’t want to build locally.

## Python worker endpoints (internal)

The Electron main process handles IPC requests from the renderer and forwards heavy tasks to the Python worker:

* `POST /grid/build` – generate a fishnet grid (caches grid geojson & centroid CSV under `app_data/grid_{cell}m.*`).
* `POST /mission/compile` – parse/validate missions, densify the path, export mission outputs, return simulation metadata.
* `POST /boundary/cache` – ensure the Florida boundary is cached locally.

## Runtime data & caches

* `app_data/florida_boundary.geojson` – EPSG:26917 state boundary.
* `app_data/grid_{cell}m.geojson` & `grid_{cell}m.csv` – clipped grid polygons and centroid tables for each cell size.
* `app_data/missions/<mission_name>/` – per-mission exports (`mission_waypoints.csv`, `mission_path.geojson`, `compile_report.json`).

To clear caches, remove files/directories under `app_data/` (the app recreates them on demand).

## Custom mission DSL quick reference

```
MISSION <IDENT>
CRS EPSG:26917
UNITS M
[SPEED <float> mps]
POINT X <x> Y <y> Z <z>
POINTLL LAT <lat> LON <lon> Z <z>
PATH (<coord> ...) -> (<coord> ...)
DWELL <seconds> s
SURFACE
END
```
* Coordinates may be supplied in EPSG:26917 metres (`POINT`) or WGS84 lat/lon (`POINTLL`, `PATH`).
* Z values are metres, positive **down**.
* The compiler converts all coordinates to EPSG:26917, validates them against the Florida boundary, optionally snaps to nearest grid centroids, and densifies path segments to the selected step length.

A ready-to-run example lives in `examples/miami_to_ftl.mission`.

### Mission templates & samples

The renderer exposes two quick starts:

1. **New Mission** – injects the sample mission into the Monaco editor so you can modify and compile immediately.
2. **Open Example Folder** – available via the exports panel after the first compile; jumps straight to the generated mission directory on disk.

## UI highlights

* Monaco-based mission editor with syntax highlighting for the custom DSL.
* MapLibre GL blank canvas styled in dark mode with boundary outline, grid overlay, mission path/waypoints, animated toolhead marker, and a cursor lat/lon readout toggle.
* Python-backed grid builder (10 m – 10,000 m cell slider) with caching.
* Compile panel: validation feedback with line numbers, export shortcuts, simulation controls (play/pause/step/reset, speed multiplier, dwell handling, resurfacing marker).

## Testing

Run unit tests (Python side):
```bash
pytest server/tests
```

Renderer/main TypeScript checks:
```bash
cd app
npm run typecheck
```

## Changing projection

Internally the system operates in EPSG:26917. To experiment with a different CRS, update the constants in `server/config.py` (`EPSG_INTERNAL`, `EPSG_LATLON`) and adjust UI messaging. Regenerate caches after changing CRS by deleting `app_data/` contents.

## Environment variables

* `PYTHON_BIN` – Override the Python executable used to launch the FastAPI worker in development.
* `FL_MISSION_APP_DATA` – Override the directory used for caches/exports (defaults to `<userData>/app_data`).

## Packaging notes

Electron Builder bundles the `server/`, `examples/`, and `python_env/` directories via `extraResources`. The packaged desktop apps ship with their own Python runtime, so no external interpreter is required on the target machine. During development you can still point the Electron main process at another interpreter by setting `PYTHON_BIN`.

