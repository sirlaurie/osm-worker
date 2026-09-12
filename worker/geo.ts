export type Position = [number, number];
export type Polygon = Position[][];
export type Coverage =
  | { type: "Polygon"; coordinates: Polygon }
  | { type: "MultiPolygon"; coordinates: Polygon[] };
export type Bounds = [number, number, number, number];

export const EARTH_RADIUS = 6371000;

export function normalizeLongitude(lon: number): number {
  if (lon >= -180 && lon < 180) return lon;

  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

export function cellFor(lat: number, lon: number): string {
  return `${Math.min(17999, Math.floor((lat + 90) * 100))}_${Math.floor((normalizeLongitude(lon) + 180) * 100)}`;
}

export function distanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const rad = Math.PI / 180;
  const a = Math.min(
    1,
    Math.max(
      0,
      Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
        Math.cos(lat1 * rad) *
          Math.cos(lat2 * rad) *
          Math.sin(((lon2 - lon1) * rad) / 2) ** 2,
    ),
  );

  return EARTH_RADIUS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function queryBounds(
  lat: number,
  lon: number,
  radius: number,
): Bounds[] {
  const angle = radius / EARTH_RADIUS;
  const deltaLat = (angle * 180) / Math.PI;
  const south = Math.max(-90, lat - deltaLat);
  const north = Math.min(90, lat + deltaLat);

  if (south === -90 || north === 90) return [[-180, south, 180, north]];

  const deltaLon =
    (Math.asin(Math.min(1, Math.sin(angle) / Math.cos((lat * Math.PI) / 180))) *
      180) /
    Math.PI;
  const west = normalizeLongitude(lon) - deltaLon;
  const east = normalizeLongitude(lon) + deltaLon;

  if (west < -180)
    return [
      [west + 360, south, 180, north],
      [-180, south, east, north],
    ];

  if (east > 180)
    return [
      [west, south, 180, north],
      [-180, south, east - 360, north],
    ];

  return [[west, south, east, north]];
}

export function cellsForBounds(
  boxes: Bounds[],
  maximum: number,
): string[] | null {
  const cells = new Set<string>();

  for (const [west, south, east, north] of boxes) {
    const minX = Math.max(0, Math.floor((west + 180) * 100 - 1e-8));
    const maxX = Math.min(35999, Math.floor((east + 180) * 100 + 1e-8));
    const minY = Math.max(0, Math.floor((south + 90) * 100 - 1e-8));
    const maxY = Math.min(17999, Math.floor((north + 90) * 100 + 1e-8));

    if ((maxX - minX + 1) * (maxY - minY + 1) > maximum) return null;

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        cells.add(`${y}_${x}`);

        if (cells.size > maximum) return null;
      }
    }
  }

  return [...cells];
}

export function intersects(a: Bounds, b: Bounds): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

export function coverageBounds(coverage: Coverage): Bounds {
  const result: Bounds = [180, 90, -180, -90];

  for (const polygon of polygons(coverage)) {
    for (const ring of polygon) {
      for (const [x, y] of ring) {
        result[0] = Math.min(result[0], x);
        result[1] = Math.min(result[1], y);
        result[2] = Math.max(result[2], x);
        result[3] = Math.max(result[3], y);
      }
    }
  }

  return result;
}

function polygons(coverage: Coverage): Polygon[] {
  return coverage.type === "Polygon"
    ? [coverage.coordinates]
    : coverage.coordinates;
}

function inRing(point: Position, ring: Position[]): boolean {
  let inside = false;

  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1];
    const b = ring[i];

    if (
      a[1] > point[1] !== b[1] > point[1] &&
      point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }

  return inside;
}

function inPolygon(point: Position, polygon: Polygon): boolean {
  return (
    inRing(point, polygon[0]) &&
    !polygon.slice(1).some((ring) => inRing(point, ring))
  );
}

function segmentTouchesBox(a: Position, b: Position, box: Bounds): boolean {
  let low = 0;
  let high = 1;

  for (let axis = 0; axis < 2; axis++) {
    const start = a[axis];
    const change = b[axis] - start;

    if (change === 0) {
      if (start < box[axis] || start > box[axis + 2]) return false;
    } else {
      const first = (box[axis] - start) / change;
      const last = (box[axis + 2] - start) / change;
      low = Math.max(low, Math.min(first, last));
      high = Math.min(high, Math.max(first, last));

      if (low > high) return false;
    }
  }

  return true;
}

export function coverageStatus(
  coverages: Coverage[],
  boxes: Bounds[],
): "covered" | "partial" | "uncovered" {
  const all = coverages.flatMap(polygons);
  let touched = false;
  const coveredBoxes = boxes.map((box) => {
    const center: Position = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
    let covered = false;

    for (const polygon of all) {
      const inside = inPolygon(center, polygon);
      const edge = polygon.some((ring) =>
        ring.some(
          (point, i) => i > 0 && segmentTouchesBox(ring[i - 1], point, box),
        ),
      );
      touched ||= inside || edge;
      covered ||= inside && !edge;
    }

    return covered;
  });

  if (coveredBoxes.every(Boolean)) return "covered";

  return touched ? "partial" : "uncovered";
}
