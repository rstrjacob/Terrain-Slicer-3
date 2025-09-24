from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional


class MissionParseError(Exception):
    def __init__(self, message: str, line: int):
        super().__init__(message)
        self.line = line
        self.message = message

    def to_dict(self):
        return {"line": self.line, "message": self.message}


@dataclass
class Coordinate:
    system: str  # 'projected' or 'geographic'
    x: float
    y: float
    z: float
    line: int


@dataclass
class PointCommand:
    coordinate: Coordinate
    line: int


@dataclass
class PathCommand:
    waypoints: List[Coordinate]
    line: int


@dataclass
class DwellCommand:
    duration: float
    line: int


@dataclass
class SurfaceCommand:
    line: int


MissionCommand = PointCommand | PathCommand | DwellCommand | SurfaceCommand


@dataclass
class MissionDefinition:
    name: str
    speed: Optional[float]
    commands: List[MissionCommand]


def _strip_comments(line: str) -> str:
    for marker in ("#", ";"):
        if marker in line:
            line = line.split(marker, 1)[0]
    return line.strip()


def _parse_float(token: str, line_no: int) -> float:
    try:
        return float(token)
    except ValueError as exc:  # pragma: no cover - message propagation
        raise MissionParseError(f"Invalid numeric literal '{token}'", line_no) from exc


def parse_coordinate(tokens: List[str], line_no: int) -> Coordinate:
    tokens_upper = [token.upper() for token in tokens]
    if tokens_upper[0] == "X":
        if len(tokens) != 6:
            raise MissionParseError("POINT requires X Y Z components", line_no)
        try:
            x = _parse_float(tokens[1], line_no)
            if tokens_upper[2] != "Y":
                raise MissionParseError("POINT missing Y component", line_no)
            y = _parse_float(tokens[3], line_no)
            if tokens_upper[4] != "Z":
                raise MissionParseError("POINT missing Z component", line_no)
            z = _parse_float(tokens[5], line_no)
        except IndexError as exc:
            raise MissionParseError("POINT requires X Y Z components", line_no) from exc
        return Coordinate(system="projected", x=x, y=y, z=z, line=line_no)
    if tokens_upper[0] == "LAT":
        if len(tokens) != 6:
            raise MissionParseError("POINTLL requires LAT LON Z components", line_no)
        try:
            lat = _parse_float(tokens[1], line_no)
            if tokens_upper[2] != "LON":
                raise MissionParseError("POINTLL missing LON component", line_no)
            lon = _parse_float(tokens[3], line_no)
            if tokens_upper[4] != "Z":
                raise MissionParseError("POINTLL missing Z component", line_no)
            z = _parse_float(tokens[5], line_no)
        except IndexError as exc:
            raise MissionParseError("POINTLL requires LAT LON Z components", line_no) from exc
        return Coordinate(system="geographic", x=lon, y=lat, z=z, line=line_no)
    raise MissionParseError("Unknown coordinate format", line_no)


def parse_mission(text: str) -> MissionDefinition:
    lines = text.splitlines()

    mission_name: Optional[str] = None
    speed: Optional[float] = None
    seen_crs = False
    seen_units = False
    commands: List[MissionCommand] = []

    for idx, raw_line in enumerate(lines, start=1):
        line = _strip_comments(raw_line)
        if not line:
            continue

        parts = line.split()
        keyword = parts[0].upper()

        if keyword == "MISSION":
            if mission_name is not None:
                raise MissionParseError("MISSION declared multiple times", idx)
            if len(parts) < 2:
                raise MissionParseError("MISSION must include an identifier", idx)
            mission_name = parts[1]
            continue

        if keyword == "CRS":
            if len(parts) != 2:
                raise MissionParseError("CRS must be in format 'CRS EPSG:26917'", idx)
            if parts[1].upper() != "EPSG:26917":
                raise MissionParseError("CRS must be EPSG:26917", idx)
            seen_crs = True
            continue

        if keyword == "UNITS":
            if len(parts) != 2 or parts[1].upper() != "M":
                raise MissionParseError("UNITS must be 'UNITS M'", idx)
            seen_units = True
            continue

        if keyword == "SPEED":
            if len(parts) != 3 or parts[2].lower() != "mps":
                raise MissionParseError("SPEED must be '<value> mps'", idx)
            speed = _parse_float(parts[1], idx)
            continue

        if keyword == "POINT":
            coord_tokens = parts[1:]
            coordinate = parse_coordinate(coord_tokens, idx)
            commands.append(PointCommand(coordinate=coordinate, line=idx))
            continue

        if keyword == "POINTLL":
            coord_tokens = parts[1:]
            coordinate = parse_coordinate(coord_tokens, idx)
            commands.append(PointCommand(coordinate=coordinate, line=idx))
            continue

        if keyword == "PATH":
            path_str = line[len(parts[0]) :].strip()
            segments = [segment.strip() for segment in path_str.split("->")]
            waypoints: List[Coordinate] = []
            for segment in segments:
                if not (segment.startswith("(") and segment.endswith(")")):
                    raise MissionParseError("PATH waypoints must be wrapped in parentheses", idx)
                inner = segment[1:-1].strip()
                tokens = inner.split()
                waypoint = parse_coordinate(tokens, idx)
                waypoints.append(waypoint)
            if len(waypoints) < 2:
                raise MissionParseError("PATH requires at least two waypoints", idx)
            commands.append(PathCommand(waypoints=waypoints, line=idx))
            continue

        if keyword == "DWELL":
            if len(parts) != 3 or parts[2].lower() != "s":
                raise MissionParseError("DWELL must be '<seconds> s'", idx)
            duration = _parse_float(parts[1], idx)
            commands.append(DwellCommand(duration=duration, line=idx))
            continue

        if keyword == "SURFACE":
            commands.append(SurfaceCommand(line=idx))
            continue

        if keyword == "END":
            break

        raise MissionParseError(f"Unknown statement '{parts[0]}'", idx)

    if mission_name is None:
        raise MissionParseError("MISSION header is required", 1)
    if not seen_crs:
        raise MissionParseError("CRS EPSG:26917 is required", 1)
    if not seen_units:
        raise MissionParseError("UNITS M is required", 1)

    return MissionDefinition(name=mission_name, speed=speed, commands=commands)
