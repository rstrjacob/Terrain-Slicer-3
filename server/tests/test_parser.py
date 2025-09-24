from server.mission_parser import MissionParseError, parse_mission


def test_parse_valid_mission():
    text = """
MISSION SAMPLE
CRS EPSG:26917
UNITS M
POINT X 100 Y 200 Z 5
END
"""
    mission = parse_mission(text)
    assert mission.name == "SAMPLE"
    assert len(mission.commands) == 1


def test_parse_requires_crs():
    text = """
MISSION SAMPLE
UNITS M
END
"""
    try:
        parse_mission(text)
    except MissionParseError as exc:
        assert "CRS" in exc.message
    else:
        raise AssertionError("Expected MissionParseError")
