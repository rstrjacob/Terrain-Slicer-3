import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor, { Monaco } from '@monaco-editor/react';
import maplibregl, { Map as MapLibreMap, GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import type { Feature, FeatureCollection } from 'geojson';
import { ErrorItem, GridBuildResult, MissionCompileResult, MissionWaypoint, SimulationState } from './types';

const blankStyle: maplibregl.StyleSpecification = {
  version: 8,
  name: 'Blank',
  sources: {},
  layers: [
    {
      id: 'background',
      type: 'background',
      paint: {
        'background-color': '#0f0f0f'
      }
    }
  ],
  glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf'
};

const emptyCollection: FeatureCollection = {
  type: 'FeatureCollection',
  features: []
};

const defaultMission = `MISSION SE_FL_TEST\nCRS EPSG:26917\nUNITS M\nSPEED 1.0 mps\nPATH (LAT 25.7617 LON -80.1918 Z 2.0) -> (LAT 26.1224 LON -80.1373 Z 2.0)\nSURFACE\nEND\n`;

const languageId = 'missiondsl';

function registerLanguage(monaco: Monaco) {
  if (monaco.languages.getLanguages().some((lang) => lang.id === languageId)) {
    return;
  }
  monaco.languages.register({ id: languageId });
  monaco.languages.setMonarchTokensProvider(languageId, {
    tokenizer: {
      root: [
        [/MISSION|CRS|UNITS|POINTLL|POINT|PATH|DWELL|SURFACE|END|SPEED/i, 'keyword'],
        [/EPSG:\d+/, 'number'],
        [/->/, 'operator'],
        [/\(.*?\)/, 'string'],
        [/#[^$]*/, 'comment'],
        [/;[^$]*/, 'comment'],
        [/\d+\.\d+|\d+/, 'number']
      ]
    }
  });
  monaco.languages.setLanguageConfiguration(languageId, {
    comments: {
      lineComment: '#'
    }
  });
}

function computeSegments(points: MissionWaypoint[]) {
  const segments: number[] = [];
  const cumulative: number[] = [0];
  let total = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    segments.push(length);
    total += length;
    cumulative.push(total);
  }
  if (points.length === 1) {
    cumulative.push(0);
  }
  return { segments, cumulative, total };
}

function App() {
  const [missionText, setMissionText] = useState(defaultMission);
  const [gridSize, setGridSize] = useState(1000);
  const [gridData, setGridData] = useState<GridBuildResult | null>(null);
  const [gridVisible, setGridVisible] = useState(true);
  const [compileResult, setCompileResult] = useState<MissionCompileResult | null>(null);
  const [errors, setErrors] = useState<ErrorItem[]>([]);
  const [snapToGrid, setSnapToGrid] = useState(false);
  const [stepLength, setStepLength] = useState(5);
  const [isBuildingGrid, setIsBuildingGrid] = useState(false);
  const [isCompiling, setIsCompiling] = useState(false);
  const [showCursorLatLon, setShowCursorLatLon] = useState(false);
  const [cursorLatLon, setCursorLatLon] = useState<[number, number] | null>(null);
  const [speedMultiplier, setSpeedMultiplier] = useState(1);
  const [simulation, setSimulation] = useState<SimulationState | null>(null);

  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const mapReadyRef = useRef(false);
  const animationRef = useRef<number>();
  const showCursorRef = useRef(false);

  const dwellMap = useMemo(() => {
    const map = new Map<number, number>();
    (compileResult?.dwell_events || []).forEach((event) => {
      map.set(event.index, event.duration);
    });
    return map;
  }, [compileResult?.dwell_events]);

  useEffect(() => {
    if (mapRef.current || !mapContainerRef.current) {
      return;
    }
    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: blankStyle,
      center: [-81.5, 27.5],
      zoom: 5
    });
    mapRef.current = map;

    const handleLoad = () => {
      mapReadyRef.current = true;
      map.addSource('boundary', { type: 'geojson', data: emptyCollection });
      map.addLayer({
        id: 'boundary-outline',
        type: 'line',
        source: 'boundary',
        paint: {
          'line-color': '#4ade80',
          'line-width': 2.5
        }
      });

      map.addSource('grid-lines', { type: 'geojson', data: emptyCollection });
      map.addLayer({
        id: 'grid-lines-layer',
        type: 'line',
        source: 'grid-lines',
        layout: {
          visibility: gridVisible ? 'visible' : 'none'
        },
        paint: {
          'line-color': '#2dd4bf',
          'line-width': 0.8,
          'line-opacity': 0.6
        }
      });

      map.addSource('mission-path', { type: 'geojson', data: emptyCollection });
      map.addLayer({
        id: 'mission-path-line',
        type: 'line',
        source: 'mission-path',
        paint: {
          'line-color': '#60a5fa',
          'line-width': 3
        }
      });

      map.addSource('mission-waypoints', { type: 'geojson', data: emptyCollection });
      map.addLayer({
        id: 'mission-waypoints-circles',
        type: 'circle',
        source: 'mission-waypoints',
        paint: {
          'circle-radius': 3.5,
          'circle-color': '#f9a8d4',
          'circle-stroke-width': 1,
          'circle-stroke-color': '#1f2937'
        }
      });

      map.addSource('toolhead', { type: 'geojson', data: emptyCollection });
      map.addLayer({
        id: 'toolhead-marker',
        type: 'circle',
        source: 'toolhead',
        paint: {
          'circle-radius': 6,
          'circle-color': '#facc15',
          'circle-stroke-width': 2,
          'circle-stroke-color': '#1f2937'
        }
      });

      map.addSource('surface-point', { type: 'geojson', data: emptyCollection });
      map.addLayer({
        id: 'surface-marker',
        type: 'circle',
        source: 'surface-point',
        paint: {
          'circle-radius': 5,
          'circle-color': '#f97316',
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#fff7ed'
        }
      });
    };

    map.on('load', handleLoad);
    map.addControl(new maplibregl.NavigationControl(), 'top-right');

    map.on('mousemove', (event) => {
      if (!showCursorRef.current) {
        return;
      }
      setCursorLatLon([event.lngLat.lat, event.lngLat.lng]);
    });

    return () => {
      map.off('load', handleLoad);
      map.remove();
    };
  }, []);

  useEffect(() => {
    showCursorRef.current = showCursorLatLon;
    if (!showCursorLatLon) {
      setCursorLatLon(null);
    }
  }, [showCursorLatLon]);

  useEffect(() => {
    if (!mapReadyRef.current || !mapRef.current) return;
    const map = mapRef.current;
    if (map.getLayer('grid-lines-layer')) {
      map.setLayoutProperty('grid-lines-layer', 'visibility', gridVisible ? 'visible' : 'none');
    }
  }, [gridVisible]);

  const updateSource = useCallback((id: string, data: FeatureCollection | Feature) => {
    if (!mapReadyRef.current || !mapRef.current) return;
    const map = mapRef.current;
    const source = map.getSource(id) as GeoJSONSource | undefined;
    if (source) {
      source.setData(data as any);
    }
  }, []);

  const fitToBoundary = useCallback((boundary: Feature) => {
    if (!mapReadyRef.current || !mapRef.current) return;
    const map = mapRef.current;
    const geometry = boundary.geometry;
    if (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') {
      const coordinates = geometry.type === 'Polygon' ? geometry.coordinates[0] : geometry.coordinates.flat();
      const lats = coordinates.map((coord) => coord[1]);
      const lons = coordinates.map((coord) => coord[0]);
      const bounds: maplibregl.LngLatBoundsLike = [
        [Math.min(...lons), Math.min(...lats)],
        [Math.max(...lons), Math.max(...lats)]
      ];
      map.fitBounds(bounds, { padding: 40, duration: 800 });
    }
  }, []);

  const handleBuildGrid = useCallback(async () => {
    setIsBuildingGrid(true);
    try {
      const result = await window.api.buildGrid(gridSize);
      setGridData(result as GridBuildResult);
      updateSource('boundary', {
        type: 'FeatureCollection',
        features: [result.boundary]
      });
      updateSource('grid-lines', {
        type: 'FeatureCollection',
        features: [result.grid_lines]
      });
      if (mapReadyRef.current) {
        fitToBoundary(result.boundary);
      }
    } catch (error) {
      setErrors([{ message: (error as Error).message }]);
    } finally {
      setIsBuildingGrid(false);
    }
  }, [fitToBoundary, gridSize, updateSource]);

  useEffect(() => {
    void handleBuildGrid();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // initial grid

  useEffect(() => {
    if (!gridData || !mapReadyRef.current) return;
    updateSource('boundary', {
      type: 'FeatureCollection',
      features: [gridData.boundary]
    });
    updateSource('grid-lines', {
      type: 'FeatureCollection',
      features: [gridData.grid_lines]
    });
    fitToBoundary(gridData.boundary);
  }, [fitToBoundary, gridData, updateSource]);

  const handleCompile = useCallback(async () => {
    setIsCompiling(true);
    setErrors([]);
    try {
      const result = await window.api.compileMission({
        mission_text: missionText,
        step: stepLength,
        snap_to_grid: snapToGrid,
        grid_cell_size: gridSize
      });
      setCompileResult(result as MissionCompileResult);
      const featureCollection: FeatureCollection = {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: (result.waypoints as MissionWaypoint[]).map((pt) => [pt.lon, pt.lat])
            },
            properties: { name: result.mission.name }
          }
        ]
      };
      const waypointFeatures: Feature[] = (result.waypoints as MissionWaypoint[]).map((pt) => ({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [pt.lon, pt.lat]
        },
        properties: {
          seq: pt.seq,
          snapped: pt.snapped
        }
      }));
      updateSource('mission-path', featureCollection);
      updateSource('mission-waypoints', { type: 'FeatureCollection', features: waypointFeatures });

      if (result.surface_index !== null) {
        const surfacePt = result.waypoints[Math.min(result.surface_index, result.waypoints.length - 1)];
        updateSource('surface-point', {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [surfacePt.lon, surfacePt.lat] },
              properties: { seq: surfacePt.seq }
            }
          ]
        });
      } else {
        updateSource('surface-point', emptyCollection);
      }

      const { segments, cumulative, total } = computeSegments(result.waypoints as MissionWaypoint[]);
      setSimulation({
        points: result.waypoints as MissionWaypoint[],
        segments,
        cumulative,
        currentIndex: 0,
        progress: 0,
        active: false,
        speed: result.mission.speed ?? 1,
        multiplier: speedMultiplier,
        dwellQueue: 0,
        totalDistance: total
      });
      if ((result.waypoints as MissionWaypoint[]).length > 0) {
        const first = (result.waypoints as MissionWaypoint[])[0];
        updateSource('toolhead', {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [first.lon, first.lat] },
              properties: {}
            }
          ]
        });
      } else {
        updateSource('toolhead', emptyCollection);
      }
    } catch (error) {
      const message = (error as Error).message;
      try {
        const parsed = JSON.parse(message);
        if (Array.isArray(parsed.errors)) {
          setErrors(parsed.errors.map((err: any) => ({ message: err.message, line: err.line })));
        } else if (parsed.message) {
          setErrors([{ message: parsed.message }]);
        } else {
          setErrors([{ message }]);
        }
      } catch (parseError) {
        setErrors([{ message }]);
      }
    } finally {
      setIsCompiling(false);
    }
  }, [gridSize, missionText, snapToGrid, speedMultiplier, stepLength, updateSource]);

  useEffect(() => {
    if (!simulation) return;
    setSimulation((prev) => (prev ? { ...prev, multiplier: speedMultiplier } : prev));
  }, [speedMultiplier]);

  useEffect(() => {
    if (!simulation || !simulation.active) {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = undefined;
      }
      return;
    }

    let last = performance.now();

    const tick = (time: number) => {
      const delta = (time - last) / 1000;
      last = time;
      setSimulation((prev) => {
        if (!prev || !prev.active) return prev;
        let { currentIndex, progress } = prev;
        let dwellQueue = prev.dwellQueue;
        const segments = prev.segments;
        const maxIndex = segments.length;

        if (dwellQueue > 0) {
          const remaining = Math.max(dwellQueue - delta, 0);
          return { ...prev, dwellQueue: remaining };
        }

        let remainingDistance = prev.speed * prev.multiplier * delta + progress;

        while (currentIndex < maxIndex && remainingDistance >= segments[currentIndex]) {
          remainingDistance -= segments[currentIndex];
          currentIndex += 1;
          const dwellEvent = dwellMap.get(currentIndex);
          if (dwellEvent) {
            dwellQueue = dwellEvent;
            remainingDistance = 0;
            break;
          }
        }

        if (currentIndex >= maxIndex) {
          updateSource('toolhead', {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                geometry: {
                  type: 'Point',
                  coordinates: [prev.points[prev.points.length - 1].lon, prev.points[prev.points.length - 1].lat]
                },
                properties: {}
              }
            ]
          });
          return { ...prev, currentIndex: maxIndex, progress: 0, active: false, dwellQueue: 0 };
        }

        const segmentLength = segments[currentIndex] || 0;
        const ratio = segmentLength > 0 ? Math.min(remainingDistance / segmentLength, 1) : 1;
        const pointA = prev.points[currentIndex];
        const pointB = prev.points[Math.min(currentIndex + 1, prev.points.length - 1)];
        const lon = pointA.lon + (pointB.lon - pointA.lon) * ratio;
        const lat = pointA.lat + (pointB.lat - pointA.lat) * ratio;
        updateSource('toolhead', {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [lon, lat] },
              properties: {}
            }
          ]
        });

        return {
          ...prev,
          currentIndex,
          progress: remainingDistance,
          dwellQueue
        };
      });

      animationRef.current = requestAnimationFrame(tick);
    };

    animationRef.current = requestAnimationFrame(tick);

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = undefined;
      }
    };
  }, [dwellMap, simulation?.active, updateSource]);

  const currentDistance = useMemo(() => {
    if (!simulation) return 0;
    const { currentIndex, progress, cumulative } = simulation;
    const base = cumulative[Math.min(currentIndex, cumulative.length - 1)] || 0;
    return base + progress;
  }, [simulation]);

  const togglePlay = () => {
    if (!simulation) return;
    if (simulation.currentIndex >= simulation.segments.length) {
      setSimulation({ ...simulation, currentIndex: 0, progress: 0, active: true, dwellQueue: 0 });
    } else {
      setSimulation({ ...simulation, active: !simulation.active });
    }
  };

  const stepForward = () => {
    if (!simulation) return;
    const nextIndex = Math.min(simulation.currentIndex + 1, simulation.segments.length);
    setSimulation({ ...simulation, currentIndex: nextIndex, progress: 0, active: false });
    if (simulation.points[nextIndex]) {
      updateSource('toolhead', {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [simulation.points[nextIndex].lon, simulation.points[nextIndex].lat] },
            properties: {}
          }
        ]
      });
    }
  };

  const resetSimulation = () => {
    if (!simulation) return;
    setSimulation({ ...simulation, currentIndex: 0, progress: 0, active: false, dwellQueue: 0 });
    if (simulation.points.length) {
      updateSource('toolhead', {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [simulation.points[0].lon, simulation.points[0].lat] },
            properties: {}
          }
        ]
      });
    }
  };

  return (
    <div className="app-shell">
      <div className="panel">
        <div className="panel-header">Mission Editor</div>
        <div className="panel-body">
          <div className="editor-container">
            <Editor
              height="100%"
              defaultLanguage={languageId}
              value={missionText}
              beforeMount={registerLanguage}
              onChange={(value) => setMissionText(value ?? '')}
              theme="vs-dark"
              options={{
                fontSize: 14,
                minimap: { enabled: false },
                scrollBeyondLastLine: false
              }}
            />
          </div>
          <div className="status-bar">
            <span>Cells: {gridData ? gridData.cells.toLocaleString() : '—'}</span>
            <span>Waypoints: {compileResult ? compileResult.totals.waypoints : '—'}</span>
          </div>
        </div>
      </div>
      <div className="panel">
        <div className="panel-header">Map View</div>
        <div className="panel-body">
          <div className="map-container" ref={mapContainerRef} />
          <div className="status-bar">
            <span>
              {simulation
                ? `Sim Distance: ${currentDistance.toFixed(1)} m / ${simulation.totalDistance.toFixed(1)} m`
                : 'Sim Distance: —'}
            </span>
            <span>
              {showCursorLatLon && cursorLatLon
                ? `Lat ${cursorLatLon[0].toFixed(5)} | Lon ${cursorLatLon[1].toFixed(5)}`
                : 'Lat/Lon hidden'}
            </span>
          </div>
        </div>
      </div>
      <div className="panel">
        <div className="panel-header">Controls</div>
        <div className="panel-body">
          <div className="controls">
            <label>
              Grid Cell Size (m)
              <input
                type="range"
                min={10}
                max={10000}
                step={10}
                value={gridSize}
                onChange={(event) => setGridSize(Number(event.target.value))}
              />
              <span>{gridSize.toLocaleString()} m</span>
            </label>
            <button onClick={handleBuildGrid} disabled={isBuildingGrid}>
              {isBuildingGrid ? 'Building…' : 'Build Grid'}
            </button>
            <label className="toggle-row">
              <span>Show Grid Overlay</span>
              <input type="checkbox" checked={gridVisible} onChange={(event) => setGridVisible(event.target.checked)} />
            </label>
            <label>
              Step Length (m)
              <input
                type="number"
                min={1}
                max={100}
                value={stepLength}
                onChange={(event) => setStepLength(Number(event.target.value))}
              />
            </label>
            <label className="toggle-row">
              <span>Snap to Grid Centroids</span>
              <input type="checkbox" checked={snapToGrid} onChange={(event) => setSnapToGrid(event.target.checked)} />
            </label>
            <label className="toggle-row">
              <span>Show Cursor Lat/Lon</span>
              <input type="checkbox" checked={showCursorLatLon} onChange={(event) => setShowCursorLatLon(event.target.checked)} />
            </label>
            <button onClick={handleCompile} disabled={isCompiling}>
              {isCompiling ? 'Compiling…' : 'Compile Mission'}
            </button>

            {compileResult && (
              <div>
                <div className="metric-row">
                  <span>Total Length</span>
                  <span>{compileResult.totals.distance_m.toFixed(1)} m</span>
                </div>
                <div className="metric-row">
                  <span>Waypoints</span>
                  <span>{compileResult.totals.waypoints}</span>
                </div>
                <div className="metric-row">
                  <span>Speed</span>
                  <span>{(compileResult.mission.speed ?? 1).toFixed(2)} m/s</span>
                </div>
                <div className="metric-row">
                  <span>Step</span>
                  <span>{compileResult.totals.step_m} m</span>
                </div>
                <div className="playback-controls">
                  <button onClick={togglePlay} disabled={!simulation}>
                    {simulation?.active ? 'Pause' : 'Play'}
                  </button>
                  <button onClick={stepForward} disabled={!simulation}>
                    Step
                  </button>
                  <button onClick={resetSimulation} disabled={!simulation}>
                    Reset
                  </button>
                </div>
                <label>
                  Speed Multiplier
                  <input
                    type="number"
                    min={0.1}
                    max={10}
                    step={0.1}
                    value={speedMultiplier}
                    onChange={(event) => setSpeedMultiplier(Number(event.target.value))}
                  />
                </label>
                <div className="metric-row">
                  <span>Exports</span>
                </div>
                <div className="playback-controls">
                  <button onClick={() => window.api.openPath(compileResult.exports.mission_waypoints)}>Waypoints CSV</button>
                  <button onClick={() => window.api.openPath(compileResult.exports.mission_path)}>Path GeoJSON</button>
                  <button onClick={() => window.api.openPath(compileResult.exports.compile_report)}>Compile Report</button>
                </div>
              </div>
            )}

            {errors.length > 0 && (
              <div className="error-list">
                {errors.map((error, index) => (
                  <div key={`${error.message}-${index}`} className="error-item">
                    {error.line ? `Line ${error.line}: ${error.message}` : error.message}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
