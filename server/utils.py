from __future__ import annotations

import re
from pathlib import Path
from typing import Iterable, Tuple

from shapely.geometry import mapping


def slugify(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    value = re.sub(r"-+", "-", value)
    return value.strip("-") or "mission"


def ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def round_bounds(bounds: Iterable[float], digits: int = 3) -> Tuple[float, ...]:
    return tuple(round(float(b), digits) for b in bounds)


def geometry_to_feature(geometry, properties=None):
    feature = {
        "type": "Feature",
        "geometry": mapping(geometry),
        "properties": properties or {},
    }
    return feature
