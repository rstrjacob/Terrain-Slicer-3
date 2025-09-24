from __future__ import annotations

import json
import math
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import pandas as pd
from fastapi import HTTPException
from pyproj import Transformer
from shapely.geometry import LineString, Point
from shapely.prepared import prep

from .boundary import get_boundary_polygon
from .config import APP_DATA_DIR, DEFAULT_SPEED, EPSG_INTERNAL, EPSG_LATLON
from .mission_parser import (
    DwellCommand,
    MissionDefinition,
    MissionParseError,
    PathCommand,
    PointCommand,
    SurfaceCommand,
    parse_mission,
)
from .utils import ensure_parent, geometry_to_feature, round_bounds, slugify


transform_to_internal = Transformer.from_crs(EPSG_LATLON, EPSG_INTERNAL, always_xy=True)
transform_to_wgs84 = Transformer.from_crs(EPSG_INTERNAL, EPSG_LATLON, always_xy=True)


@dataclass
class MissionPoint:
    x: float
    y: float
    z: float
    lat: float
    lon: float
    source_line: int
    snapped: bool
    in_florida: bool


@dataclass
class CompileResult:
    mission: MissionDefinition
    waypoints: List[MissionPoint]
    total_distance: float
    step: float
    exports: Dict[str, str]
    dwell_events: List[Tuple[int, float]]
    surface_index: Optional[int]


class MissionValidationError(Exception):
    def __init__(self, errors: List[Dict[str, object]]):
        super().__init__("Mission validation failed")
        self.errors = errors


def _coordinate_to_xy(command: PointCommand) -> Tuple[float, float, float]:
    coord = command.coordinate
    if coord.system == "projected":
        return coord.x, coord.y, coord.z
    lon = coord.x
    lat = coord.y
    x, y = transform_to_internal.transform(lon, lat)
    return x, y, coord.z


def _path_coordinate_to_xy(coord) -> Tuple[float, float, float]:
    if coord.system == "projected":
        return coord.x, coord.y, coord.z
    lon = coord.x
    lat = coord.y
    x, y = transform_to_internal.transform(lon, lat)
    return x, y, coord.z


def _load_centroids(cell_size: float) -> Optional[pd.DataFrame]:
    cell_int = int(round(cell_size))
    centroid_path = APP_DATA_DIR / f"grid_{cell_int}m.csv"
    if not centroid_path.exists():
        return None
    return pd.read_csv(centroid_path)


def _snap_points(points: List[Tuple[float, float, float]], centroid_df: pd.DataFrame):
    from scipy.spatial import cKDTree

    tree = cKDTree(centroid_df[["x", "y"]].values)
    snapped_points = []
    snapped_flags = []
    for x, y, z in points:
        _, index = tree.query([x, y])
        row = centroid_df.iloc[int(index)]
        snapped_points.append((row["x"], row["y"], z))
        snapped_flags.append(abs(row["x"] - x) > 1e-6 or abs(row["y"] - y) > 1e-6)
    return snapped_points, snapped_flags


def _to_latlon(points: List[Tuple[float, float, float]]):
    latlons = []
    for x, y, _ in points:
        lon, lat = transform_to_wgs84.transform(x, y)
        latlons.append((lat, lon))
    return latlons


def _densify_with_map(
    points: List[Tuple[float, float, float]], step: float
) -> Tuple[List[Tuple[float, float, float]], List[int]]:
    if not points:
        return [], []

    densified: List[Tuple[float, float, float]] = [points[0]]
    index_map: List[int] = [0]

    for start, end in zip(points[:-1], points[1:]):
        x0, y0, z0 = start
        x1, y1, z1 = end
        dx = x1 - x0
        dy = y1 - y0
        dz = z1 - z0
        distance = math.sqrt(dx * dx + dy * dy)
        if distance == 0:
            densified.append(end)
            index_map.append(len(densified) - 1)
            continue
        steps = max(int(math.floor(distance / step)), 1)
        for i in range(1, steps + 1):
            ratio = min((i * step) / distance, 1.0)
            densified.append((x0 + dx * ratio, y0 + dy * ratio, z0 + dz * ratio))
        if densified[-1] != end:
            densified.append(end)
        index_map.append(len(densified) - 1)

    if len(index_map) < len(points):
        index_map.append(len(densified) - 1)

    return densified, index_map


def compile_mission(
    text: str,
    *,
    step: float,
    snap_to_grid: bool = False,
    grid_cell_size: Optional[float] = None,
) -> CompileResult:
    try:
        mission = parse_mission(text)
    except MissionParseError as exc:
        raise HTTPException(status_code=400, detail=exc.to_dict()) from exc

    boundary_poly = get_boundary_polygon()
    prepared_boundary = prep(boundary_poly)

    xy_points: List[Tuple[float, float, float]] = []
    line_numbers: List[int] = []
    command_snapped: List[bool] = []
    dwell_events: List[Tuple[int, float]] = []
    surface_index: Optional[int] = None

    for command in mission.commands:
        if isinstance(command, PointCommand):
            x, y, z = _coordinate_to_xy(command)
            xy_points.append((x, y, z))
            line_numbers.append(command.line)
            command_snapped.append(False)
        elif isinstance(command, PathCommand):
            for waypoint in command.waypoints:
                x, y, z = _path_coordinate_to_xy(waypoint)
                xy_points.append((x, y, z))
                line_numbers.append(command.line)
                command_snapped.append(False)
        elif isinstance(command, DwellCommand):
            if not xy_points:
                raise HTTPException(status_code=400, detail={"line": command.line, "message": "DWELL must follow a waypoint"})
            dwell_events.append((len(xy_points) - 1, command.duration))
        elif isinstance(command, SurfaceCommand):
            surface_index = len(xy_points) - 1 if xy_points else None

    if not xy_points:
        raise HTTPException(status_code=400, detail={"message": "Mission does not contain any waypoints"})

    if snap_to_grid:
        if grid_cell_size is None:
            raise HTTPException(status_code=400, detail={"message": "Grid cell size required for snapping"})
        centroid_df = _load_centroids(grid_cell_size)
        if centroid_df is None:
            raise HTTPException(
                status_code=400,
                detail={"message": "Grid centroids not found. Build the grid first."},
            )
        snapped_points, snapped_flags = _snap_points(xy_points, centroid_df)
        xy_points = snapped_points
        command_snapped = [snapped or original for snapped, original in zip(snapped_flags, command_snapped)]

    violations: List[Dict[str, object]] = []
    for idx, (point, line_no) in enumerate(zip(xy_points, line_numbers)):
        shapely_point = Point(point[0], point[1])
        if not prepared_boundary.contains(shapely_point):
            violations.append({"index": idx, "line": line_no, "message": "Waypoint lies outside Florida boundary"})

    if violations:
        raise MissionValidationError(violations)

    densified_points, index_map = _densify_with_map(xy_points, step)

    latlons = _to_latlon(densified_points)

    mission_points: List[MissionPoint] = []
    total_distance = 0.0
    prev_point = densified_points[0]

    for idx, ((x, y, z), (lat, lon)) in enumerate(zip(densified_points, latlons)):
        in_florida = prepared_boundary.contains(Point(x, y))
        snapped_flag = command_snapped[min(idx, len(command_snapped) - 1)]
        if idx > 0:
            dx = x - prev_point[0]
            dy = y - prev_point[1]
            total_distance += math.sqrt(dx * dx + dy * dy)
        mission_points.append(
            MissionPoint(
                x=x,
                y=y,
                z=z,
                lat=lat,
                lon=lon,
                source_line=line_numbers[min(idx, len(line_numbers) - 1)],
                snapped=snapped_flag,
                in_florida=in_florida,
            )
        )
        prev_point = (x, y, z)

    mission_dir = APP_DATA_DIR / "missions" / slugify(mission.name)
    ensure_parent(mission_dir / "dummy")

    waypoint_path = mission_dir / "mission_waypoints.csv"
    path_geojson = mission_dir / "mission_path.geojson"
    report_path = mission_dir / "compile_report.json"

    waypoints_payload = [
        {
            "seq": idx + 1,
            "x": point.x,
            "y": point.y,
            "z": point.z,
            "lat": point.lat,
            "lon": point.lon,
            "in_florida": point.in_florida,
            "snapped": point.snapped,
        }
        for idx, point in enumerate(mission_points)
    ]

    pd.DataFrame(waypoints_payload).to_csv(waypoint_path, index=False)

    path_feature = geometry_to_feature(
        LineString([(point.lon, point.lat) for point in mission_points]),
        {"name": mission.name},
    )
    path_geojson.write_text(json.dumps({"type": "FeatureCollection", "features": [path_feature]}, indent=2))

    report = {
        "mission": mission.name,
        "step_metres": step,
        "speed_mps": mission.speed or DEFAULT_SPEED,
        "total_length_m": round(total_distance, 3),
        "waypoint_count": len(mission_points),
        "bounds_xy": round_bounds(LineString([(p.x, p.y) for p in mission_points]).bounds),
        "snap_to_grid": snap_to_grid,
    }
    report_path.write_text(json.dumps(report, indent=2))

    exports = {
        "mission_waypoints": str(waypoint_path),
        "mission_path": str(path_geojson),
        "compile_report": str(report_path),
        "mission_directory": str(mission_dir),
    }

    mapped_dwell = [
        (index_map[min(index, len(index_map) - 1)], duration) for index, duration in dwell_events
    ]
    mapped_surface = index_map[surface_index] if surface_index is not None and surface_index < len(index_map) else None

    return CompileResult(
        mission=mission,
        waypoints=mission_points,
        total_distance=total_distance,
        step=step,
        exports=exports,
        dwell_events=mapped_dwell,
        surface_index=mapped_surface,
    )
