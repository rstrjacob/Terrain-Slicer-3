from __future__ import annotations

import logging
from typing import Any, Dict

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .boundary import load_boundary
from .config import DEFAULT_STEP_METRES
from .grid import GridSummary, build_grid
from .mission_compile import CompileResult, MissionValidationError, compile_mission

logger = logging.getLogger(__name__)

app = FastAPI(title="Florida Mission Planner Worker", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> Dict[str, Any]:
    return {"status": "ok"}


@app.post("/boundary/cache")
def ensure_boundary() -> Dict[str, Any]:
    data = load_boundary()
    return {
        "source": data.source,
        "bounds": data.gdf.total_bounds.tolist(),
    }


@app.post("/grid/build")
def grid_build(payload: Dict[str, Any]):
    cell_size = float(payload.get("cell_size", 1000))
    try:
        summary: GridSummary = build_grid(cell_size)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    result = {
        "cell_size": summary.cell_size,
        "cells": summary.cells,
        "centroids": summary.centroids,
        "bounds": summary.bounds,
        "grid_lines": summary.grid_lines,
        "boundary": summary.boundary,
        "files": {
            "grid_geojson": str(summary.file_geojson),
            "grid_centroids": str(summary.file_centroids),
        },
        "origin": {
            "x": summary.origin[0],
            "y": summary.origin[1],
        },
    }
    return JSONResponse(result)


@app.post("/mission/compile")
def mission_compile(payload: Dict[str, Any]):
    mission_text = payload.get("mission_text")
    if not mission_text:
        raise HTTPException(status_code=400, detail="mission_text is required")

    step = float(payload.get("step", DEFAULT_STEP_METRES))
    snap_to_grid = bool(payload.get("snap_to_grid", False))
    grid_cell_size = payload.get("grid_cell_size")
    if grid_cell_size is not None:
        grid_cell_size = float(grid_cell_size)

    try:
        result: CompileResult = compile_mission(
            mission_text,
            step=step,
            snap_to_grid=snap_to_grid,
            grid_cell_size=grid_cell_size,
        )
    except MissionValidationError as exc:
        return JSONResponse(status_code=422, content={"errors": exc.errors})
    except HTTPException:
        raise
    except Exception as exc:  # pylint: disable=broad-except
        logger.exception("Mission compilation failed: %s", exc)
        raise HTTPException(status_code=500, detail="Mission compilation failed") from exc

    response = {
        "mission": {
            "name": result.mission.name,
            "speed": result.mission.speed,
        },
        "totals": {
            "distance_m": result.total_distance,
            "step_m": result.step,
            "waypoints": len(result.waypoints),
        },
        "waypoints": [
            {
                "seq": idx + 1,
                "x": point.x,
                "y": point.y,
                "z": point.z,
                "lat": point.lat,
                "lon": point.lon,
                "line": point.source_line,
                "in_florida": point.in_florida,
                "snapped": point.snapped,
            }
            for idx, point in enumerate(result.waypoints)
        ],
        "exports": result.exports,
        "dwell_events": [
            {"index": index, "duration": duration} for index, duration in result.dwell_events
        ],
        "surface_index": result.surface_index,
    }
    return JSONResponse(response)
