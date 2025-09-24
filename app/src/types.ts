export interface GridBuildResult {
  cell_size: number;
  cells: number;
  centroids: number;
  bounds: [number, number, number, number];
  grid_lines: GeoJSON.Feature;
  boundary: GeoJSON.Feature;
  files: {
    grid_geojson: string;
    grid_centroids: string;
  };
  origin: {
    x: number;
    y: number;
  };
}

export interface MissionWaypoint {
  seq: number;
  x: number;
  y: number;
  z: number;
  lat: number;
  lon: number;
  line: number;
  in_florida: boolean;
  snapped: boolean;
}

export interface MissionCompileResult {
  mission: {
    name: string;
    speed: number | null;
  };
  totals: {
    distance_m: number;
    step_m: number;
    waypoints: number;
  };
  waypoints: MissionWaypoint[];
  exports: {
    mission_waypoints: string;
    mission_path: string;
    compile_report: string;
  };
  dwell_events: { index: number; duration: number }[];
  surface_index: number | null;
}

export interface SimulationState {
  points: MissionWaypoint[];
  segments: number[];
  cumulative: number[];
  currentIndex: number;
  progress: number;
  active: boolean;
  speed: number;
  multiplier: number;
  dwellQueue: number;
  totalDistance: number;
}

export interface ErrorItem {
  message: string;
  line?: number;
}
