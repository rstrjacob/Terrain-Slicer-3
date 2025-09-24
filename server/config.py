import os
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[1]
APP_DATA_DIR = Path(os.environ.get("FL_MISSION_APP_DATA", APP_ROOT / "app_data"))
APP_DATA_DIR.mkdir(parents=True, exist_ok=True)

BOUNDARY_CACHE = APP_DATA_DIR / "florida_boundary.geojson"
BOUNDARY_META = APP_DATA_DIR / "florida_boundary.json"

GRID_PATTERN = "grid_{cell}m"

DEFAULT_STEP_METRES = 5.0
DEFAULT_SPEED = 1.0

EPSG_INTERNAL = 26917
EPSG_LATLON = 4326
