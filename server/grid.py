from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Tuple

import geopandas as gpd
import pandas as pd
from pyproj import Transformer
from shapely.geometry import LineString, MultiLineString, Polygon, box
from shapely.prepared import prep

from .boundary import boundary_geojson_wgs84, get_boundary_polygon
from .config import APP_DATA_DIR, EPSG_INTERNAL, EPSG_LATLON
from .utils import ensure_parent, geometry_to_feature

MAX_GRID_CELLS = 400_000


@dataclass
class GridSummary:
    cell_size: float
    cells: int
    centroids: int
    bounds: Tuple[float, float, float, float]
    file_geojson: Path
    file_centroids: Path
    grid_lines: dict
    boundary: dict
    origin: Tuple[float, float]


transformer_to_wgs84 = Transformer.from_crs(EPSG_INTERNAL, EPSG_LATLON, always_xy=True)


def _grid_file_paths(cell_size: float) -> Tuple[Path, Path]:
    cell_int = int(round(cell_size))
    geojson_path = APP_DATA_DIR / f"grid_{cell_int}m.geojson"
    centroid_path = APP_DATA_DIR / f"grid_{cell_int}m.csv"
    return geojson_path, centroid_path


def build_grid(cell_size: float) -> GridSummary:
    if cell_size <= 0:
        raise ValueError("Cell size must be positive")

    boundary_poly = get_boundary_polygon()
    minx, miny, maxx, maxy = boundary_poly.bounds

    width = maxx - minx
    height = maxy - miny

    cols = math.ceil(width / cell_size)
    rows = math.ceil(height / cell_size)

    if cols * rows > MAX_GRID_CELLS:
        raise ValueError(
            "Requested grid is too dense to generate reliably. Increase the cell size."
        )

    start_x = math.floor(minx / cell_size) * cell_size
    start_y = math.floor(miny / cell_size) * cell_size

    xs = [start_x + i * cell_size for i in range(cols + 1)]
    ys = [start_y + j * cell_size for j in range(rows + 1)]

    prepared_boundary = prep(boundary_poly)

    polygons: List[Polygon] = []
    records: List[Dict[str, object]] = []

    centroid_rows: List[Dict[str, object]] = []

    for i in range(cols):
        for j in range(rows):
            x0 = start_x + i * cell_size
            y0 = start_y + j * cell_size
            cell = box(x0, y0, x0 + cell_size, y0 + cell_size)
            if not prepared_boundary.intersects(cell):
                continue
            clipped = cell.intersection(boundary_poly)
            if clipped.is_empty:
                continue
            polygons.append(clipped)
            records.append({"id": len(polygons), "i": i, "j": j})
            centroid = clipped.centroid
            lon, lat = transformer_to_wgs84.transform(centroid.x, centroid.y)
            centroid_rows.append(
                {
                    "id": len(polygons),
                    "i": i,
                    "j": j,
                    "x": centroid.x,
                    "y": centroid.y,
                    "lat": lat,
                    "lon": lon,
                }
            )

    if not polygons:
        raise RuntimeError("Grid generation produced no cells")

    gdf = gpd.GeoDataFrame(records, geometry=polygons, crs=EPSG_INTERNAL)

    geojson_path, centroid_path = _grid_file_paths(cell_size)
    ensure_parent(geojson_path)
    gdf.to_file(geojson_path, driver="GeoJSON")

    centroid_df = pd.DataFrame(centroid_rows)
    centroid_df.to_csv(centroid_path, index=False)

    vertical_lines: List[LineString] = []
    horizontal_lines: List[LineString] = []

    min_line = start_y
    max_line = start_y + rows * cell_size
    for x in xs:
        line = LineString([(x, min_line), (x, max_line)])
        clipped = line.intersection(boundary_poly)
        if not clipped.is_empty:
            vertical_lines.append(clipped)

    min_col = start_x
    max_col = start_x + cols * cell_size
    for y in ys:
        line = LineString([(min_col, y), (max_col, y)])
        clipped = line.intersection(boundary_poly)
        if not clipped.is_empty:
            horizontal_lines.append(clipped)

    grid_lines = MultiLineString(vertical_lines + horizontal_lines)

    grid_feature = geometry_to_feature(grid_lines, {"type": "grid"})

    bounds = gdf.total_bounds

    return GridSummary(
        cell_size=cell_size,
        cells=len(polygons),
        centroids=len(centroid_rows),
        bounds=(bounds[0], bounds[1], bounds[2], bounds[3]),
        file_geojson=geojson_path,
        file_centroids=centroid_path,
        grid_lines=grid_feature,
        boundary=boundary_geojson_wgs84(),
        origin=(start_x, start_y),
    )
