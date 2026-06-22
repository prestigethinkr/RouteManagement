import type { PendingOutlet, Vehicle, AssignedRoute, GeoJsonLineString } from "./types";
import { DEPOT_COORDS, ROUTE_COLORS } from "./types";

// ---------------------------------------------------------------------------
// OSRM Table API — fetch NxN duration matrix from local OSRM instance
// ---------------------------------------------------------------------------
// Override via NEXT_PUBLIC_OSRM_URL in .env.local (e.g. http://localhost:5000)
const OSRM_BASE =
  process.env.NEXT_PUBLIC_OSRM_URL ?? "http://203.175.125.185:8001";

// ---------------------------------------------------------------------------
// Polyline simplification — Ramer–Douglas–Peucker
// Reduces coordinate count to prevent browser/Leaflet freeze on large routes.
// tolerance: ~0.0001° ≈ 10m accuracy tradeoff (imperceptible on city zoom)
// ---------------------------------------------------------------------------
function perpendicularDistance(
  point: [number, number],
  lineStart: [number, number],
  lineEnd: [number, number]
): number {
  const [x, y] = point;
  const [x1, y1] = lineStart;
  const [x2, y2] = lineEnd;
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) return Math.hypot(x - x1, y - y1);
  const t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy);
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

function rdpSimplify(
  points: [number, number][],
  tolerance: number
): [number, number][] {
  if (points.length <= 2) return points;
  let maxDist = 0;
  let maxIdx = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(points[i], points[0], points[points.length - 1]);
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }
  if (maxDist <= tolerance) return [points[0], points[points.length - 1]];
  return [
    ...rdpSimplify(points.slice(0, maxIdx + 1), tolerance),
    ...rdpSimplify(points.slice(maxIdx), tolerance).slice(1),
  ];
}

/**
 * Simplify a GeoJSON [lng, lat] coordinate array using RDP.
 * Tolerance ~0.0001° ≈ 11m — visually lossless at city zoom levels.
 * Reduces 5 000-coord routes to ~200-400 pts, preventing Leaflet freeze.
 */
export function simplifyCoordinates(
  coords: [number, number][],
  tolerance = 0.0001
): [number, number][] {
  if (coords.length <= 2) return coords;
  return rdpSimplify(coords, tolerance);
}

interface OsrmTableResponse {
  code: string;
  durations: number[][];
}

interface OsrmRouteResponse {
  code: string;
  routes: Array<{ geometry: GeoJsonLineString }>;
}

export async function fetchDurationMatrix(
  depotCoords: { lat: number; lng: number },
  outlets: PendingOutlet[]
): Promise<number[][]> {
  // OSRM format: lng,lat (longitude first!)
  const coordParts = [
    `${depotCoords.lng},${depotCoords.lat}`,
    ...outlets.map((o) => `${o.lng},${o.lat}`),
  ];
  const coordStr = coordParts.join(";");

  // Use POST to avoid URI length limits with 500+ coordinates.
  // The OSRM HTTP API also accepts the coordinates in the request body
  // when using the `sources` and `destinations` query params via POST.
  // However, the simplest cross-version workaround is to pass coordinates
  // in the URL but fall back to POST form-body when the URL would be too long.
  const url = `${OSRM_BASE}/table/v1/driving/${coordStr}?annotations=duration`;

  let res: Response;
  if (url.length > 4000) {
    // POST with coordinates in the body to avoid HTTP 414 / 400
    res = await fetch(`${OSRM_BASE}/table/v1/driving`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `coordinates=${encodeURIComponent(coordStr)}&annotations=duration`,
    });
    // OSRM doesn't actually support POST for the Table service in all builds;
    // if POST fails, fall back to GET with the full URL and let OSRM decide.
    if (!res.ok) {
      res = await fetch(url);
    }
  } else {
    res = await fetch(url);
  }

  if (!res.ok) throw new Error(`OSRM Table API error: HTTP ${res.status}`);

  const data: OsrmTableResponse = await res.json();
  if (data.code !== "Ok") throw new Error(`OSRM Table API returned: ${data.code}`);

  return data.durations; // NxN matrix, index 0 = depot
}

// ---------------------------------------------------------------------------
// Greedy Time-Based CVRP Assignment
// ---------------------------------------------------------------------------
export function greedyAssign(
  durations: number[][],
  outlets: PendingOutlet[],
  vehicles: Vehicle[]
): { assigned: AssignedRoute[]; unassigned: PendingOutlet[] } {
  // Track which outlet indices (1-based in the durations matrix) are unassigned
  // outlets[i] corresponds to durations matrix index (i + 1)
  const unassignedIndices = new Set<number>();
  for (let i = 0; i < outlets.length; i++) {
    unassignedIndices.add(i);
  }

  const assigned: AssignedRoute[] = [];

  for (let v = 0; v < vehicles.length; v++) {
    if (unassignedIndices.size === 0) break;

    const vehicle = vehicles[v];
    let currentM3 = 0;
    let currentKg = 0;
    const route: PendingOutlet[] = [];

    // Start from depot (matrix index 0)
    let currentMatrixIdx = 0;

    while (unassignedIndices.size > 0) {
      // Get durations from current location to all unassigned outlets
      const row = durations[currentMatrixIdx];
      if (!row) break;

      // Build candidate list sorted by travel duration (ascending)
      const candidates = [...unassignedIndices]
        .map((outletIdx) => ({
          outletIdx,
          matrixIdx: outletIdx + 1, // +1 because depot is at index 0
          duration: row[outletIdx + 1] ?? Infinity,
        }))
        .sort((a, b) => a.duration - b.duration);

      let foundFit = false;
      for (const candidate of candidates) {
        const outlet = outlets[candidate.outletIdx];
        const newM3 = currentM3 + outlet.total_kubikasi_m3;
        const newKg = currentKg + outlet.total_berat_kg;

        if (newM3 <= vehicle.KUBIKASE && newKg <= vehicle.TONASE) {
          // Fits! Assign this outlet
          route.push(outlet);
          currentM3 = newM3;
          currentKg = newKg;
          unassignedIndices.delete(candidate.outletIdx);
          currentMatrixIdx = candidate.matrixIdx;
          foundFit = true;
          break;
        }
      }

      if (!foundFit) break; // No remaining outlets fit this vehicle
    }

    if (route.length > 0) {
      assigned.push({
        vehicle,
        outlets: route,
        currentM3,
        currentKg,
        durationSeconds: 0,
        distanceKm: 0,
        color: ROUTE_COLORS[v % ROUTE_COLORS.length],
      });
    }
  }

  // Collect unassigned outlets
  const unassigned = [...unassignedIndices].map((i) => outlets[i]);

  return { assigned, unassigned };
}

// ---------------------------------------------------------------------------
// OSRM Route API — get actual road geometry for an ordered stop sequence.
// Uses /route/v1/driving (not Trip) so there is no TSP waypoint limit.
// For routes with many stops the coordinate string is chunked into parallel
// requests of CHUNK_SIZE waypoints (overlapping by 1 at boundaries) and the
// returned geometries are merged into a single LineString.
// ---------------------------------------------------------------------------
const ROUTE_CHUNK_SIZE = 50; // max waypoints per Route API call

export async function fetchTripRoute(
  outlets: PendingOutlet[]
): Promise<GeoJsonLineString | null> {
  if (outlets.length === 0) return null;

  // Build ordered waypoint strings: depot first, then outlets in sequence
  const waypoints: string[] = [
    `${DEPOT_COORDS.lng},${DEPOT_COORDS.lat}`,
    ...outlets.map((o) => `${o.lng},${o.lat}`),
  ];

  // Split into overlapping chunks of ROUTE_CHUNK_SIZE
  const chunks: string[][] = [];
  for (let i = 0; i < waypoints.length - 1; i += ROUTE_CHUNK_SIZE - 1) {
    const chunk = waypoints.slice(i, i + ROUTE_CHUNK_SIZE);
    if (chunk.length >= 2) chunks.push(chunk);
  }

  // Fetch all chunks in parallel
  const chunkCoords = await Promise.all(
    chunks.map(async (chunk): Promise<[number, number][]> => {
      const coordStr = chunk.join(";");
      const url = `${OSRM_BASE}/route/v1/driving/${coordStr}?overview=full&geometries=geojson`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`OSRM Route API error: HTTP ${res.status}`);
      const data: OsrmRouteResponse = await res.json();
      if (data.code !== "Ok") throw new Error(`OSRM Route API returned: ${data.code}`);
      return (data.routes?.[0]?.geometry?.coordinates ?? []) as [number, number][];
    })
  );

  // Merge chunk geometries — skip the first coordinate of each subsequent chunk
  // because it is the duplicated boundary point from the previous chunk
  const merged: [number, number][] = [];
  for (const coords of chunkCoords) {
    if (merged.length > 0 && coords.length > 0) {
      merged.push(...coords.slice(1));
    } else {
      merged.push(...coords);
    }
  }

  if (merged.length === 0) return null;
  return { type: "LineString", coordinates: merged };
}
