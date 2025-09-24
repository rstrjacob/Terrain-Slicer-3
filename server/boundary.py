from __future__ import annotations

import io
import json
import logging
import tempfile
from dataclasses import dataclass
from typing import Optional

import geopandas as gpd
import requests
from shapely.geometry import Polygon

from .config import (
    BOUNDARY_CACHE,
    BOUNDARY_META,
    EPSG_INTERNAL,
    EPSG_LATLON,
)
from .utils import ensure_parent, geometry_to_feature, round_bounds

logger = logging.getLogger(__name__)


PRIMARY_SOURCES = [
    {
        "name": "fdot_geojson",
        "url": "https://services.arcgis.com/CTjHJfLRMDtfE9Eh/arcgis/rest/services/Detailed_Florida_State_Boundary/FeatureServer/0/query?where=1=1&outFields=*&f=geojson",
        "format": "geojson",
    },
    {
        "name": "fdot_shp",
        "url": "https://opendata.arcgis.com/api/v3/datasets/fdot::detailed-florida-state-boundary/download?format=shp&spatialRefId=4326",
        "format": "zip",
    },
]

FALLBACK_SOURCES = [
    {
        "name": "census_state",
        "url": "https://www2.census.gov/geo/tiger/GENZ2022/shp/cb_2022_us_state_500k.zip",
        "format": "zip",
        "filter_field": "STUSPS",
        "filter_value": "FL",
    }
]


@dataclass
class BoundaryData:
    gdf: gpd.GeoDataFrame
    source: str


_cached_boundary: Optional[BoundaryData] = None


def _download_source(source: dict) -> gpd.GeoDataFrame:
    logger.info("Downloading boundary source %s", source["name"])
    response = requests.get(source["url"], timeout=120)
    response.raise_for_status()

    if source["format"] == "geojson":
        data = io.BytesIO(response.content)
        gdf = gpd.read_file(data)
    elif source["format"] == "zip":
        with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as tmp:
            tmp.write(response.content)
            tmp.flush()
            path = f"zip://{tmp.name}"
            gdf = gpd.read_file(path)
    else:
        raise ValueError(f"Unsupported format: {source['format']}")

    if source.get("filter_field"):
        gdf = gdf[gdf[source["filter_field"]] == source["filter_value"]]

    if gdf.empty:
        raise RuntimeError("Boundary dataset returned no features")

    gdf = gdf.to_crs(EPSG_LATLON)
    return gdf


def _prepare_boundary(gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    gdf = gdf.dissolve()
    gdf = gdf.to_crs(EPSG_INTERNAL)
    gdf["geometry"] = gdf["geometry"].buffer(0)
    gdf = gdf.explode(ignore_index=True)
    gdf = gdf.dissolve()
    gdf = gdf[["geometry"]]
    gdf["id"] = 1
    return gdf


def _cache_boundary(data: BoundaryData) -> None:
    ensure_parent(BOUNDARY_CACHE)
    data.gdf.to_file(BOUNDARY_CACHE, driver="GeoJSON")
    meta = {
        "source": data.source,
        "bounds_26917": round_bounds(data.gdf.total_bounds),
        "bounds_4326": round_bounds(data.gdf.to_crs(EPSG_LATLON).total_bounds),
    }
    BOUNDARY_META.write_text(json.dumps(meta, indent=2))


def load_boundary(force_refresh: bool = False) -> BoundaryData:
    global _cached_boundary

    if _cached_boundary is not None and not force_refresh:
        return _cached_boundary

    if BOUNDARY_CACHE.exists() and not force_refresh:
        gdf = gpd.read_file(BOUNDARY_CACHE)
        _cached_boundary = BoundaryData(gdf=gdf, source="cache")
        return _cached_boundary

    sources = PRIMARY_SOURCES + FALLBACK_SOURCES

    for source in sources:
        try:
            gdf = _download_source(source)
            prepped = _prepare_boundary(gdf)
            data = BoundaryData(gdf=prepped, source=source["name"])
            _cache_boundary(data)
            _cached_boundary = data
            return data
        except Exception as exc:  # pylint: disable=broad-except
            logger.exception("Boundary download failed for %s: %s", source["name"], exc)
            continue

    raise RuntimeError("Unable to download Florida boundary from any source")


def get_boundary_polygon() -> Polygon:
    data = load_boundary()
    return data.gdf.unary_union


def boundary_geojson_wgs84() -> dict:
    data = load_boundary()
    boundary = data.gdf.to_crs(EPSG_LATLON)
    geom = boundary.unary_union
    return geometry_to_feature(geom)
