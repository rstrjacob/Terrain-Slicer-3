from pathlib import Path

import pytest
import shapely.geometry

from server import mission_compile


@pytest.fixture(autouse=True)
def _set_tmp_app_data(monkeypatch, tmp_path):
    monkeypatch.setattr(mission_compile, "APP_DATA_DIR", Path(tmp_path))


@pytest.fixture
def _mock_boundary(monkeypatch):
    polygon = shapely.geometry.Polygon([(0, 0), (0, 1000), (1000, 1000), (1000, 0)])
    monkeypatch.setattr(mission_compile, "get_boundary_polygon", lambda: polygon)


def test_projection_roundtrip():
    lon, lat = -80.1918, 25.7617
    x, y = mission_compile.transform_to_internal.transform(lon, lat)
    lon2, lat2 = mission_compile.transform_to_wgs84.transform(x, y)
    assert pytest.approx(lon, rel=1e-6) == lon2
    assert pytest.approx(lat, rel=1e-6) == lat2


def test_compile_projected_points(_mock_boundary):
    text = """
MISSION SIMPLE
CRS EPSG:26917
UNITS M
POINT X 10 Y 10 Z 1
POINT X 20 Y 20 Z 1
END
"""
    result = mission_compile.compile_mission(text, step=5.0)
    assert result.waypoints
    exports = result.exports
    for path in exports.values():
        assert Path(path).exists()


def test_compile_rejects_outside_boundary(_mock_boundary):
    text = """
MISSION OOB
CRS EPSG:26917
UNITS M
POINT X 5000 Y 5000 Z 1
END
"""
    with pytest.raises(mission_compile.MissionValidationError):
        mission_compile.compile_mission(text, step=5.0)
