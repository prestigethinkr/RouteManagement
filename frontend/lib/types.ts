// ---------------------------------------------------------------------------
// CVRP Fleet Dispatch — Stateless Data Types
// ---------------------------------------------------------------------------

/** A single raw invoice row from the uploaded Excel/CSV */
export interface RawInvoice {
  CUSTNO: string;
  CUSTNAME: string;
  INVNO: string;
  LATITUDE: number;
  LONGITUDE: number;
  TOTAL_NETO: number;
  TOTAL_KUBIKASI_M3: number;
  TOTAL_BERAT_KG: number;
  TOTAL_KARTON: number;
  JNS_KEND?: string; // optional: max allowed vehicle type for this outlet
  GROUPPAYER?: string;
  ZONE?: string;
  ALLOWED_VEHICLES?: string;
  KECAMATAN?: string;
  KELURAHAN?: string;
  ALAMAT?: string;
}

/** Aggregated outlet — grouped by CUSTNO from raw invoices */
export interface PendingOutlet {
  custno: string;
  custname: string;
  lat: number;
  lng: number;
  invoices: RawInvoice[];
  total_kubikasi_m3: number;
  total_berat_kg: number;
  total_karton?: number;
  total_neto?: number;
  jns_kend: string; // max allowed vehicle type; defaults to "TRONTON" if not in source data
  grouppayer?: string;
  zone?: string;
  allowed_vehicles?: string[];
  kecamatan?: string;
  kelurahan?: string;
  alamat?: string;
  is_cross_zone_swept?: boolean;
}

/** A single vehicle from the fleet upload */
export interface Vehicle {
  JNS_KEND: string;
  NO_KEND: string;
  KUBIKASE: number; // capacity in M3
  TONASE: number;   // capacity in Kg
  ZONES?: string[];
  MAX_GROUPPAYER?: number;
}

/** GeoJSON LineString geometry returned by OSRM Trip API */
export interface GeoJsonLineString {
  type: "LineString";
  coordinates: [number, number][]; // [lng, lat] pairs
}

/** One vehicle's assigned route after the CVRP greedy algorithm */
export interface AssignedRoute {
  vehicle: Vehicle;
  outlets: PendingOutlet[];
  currentM3: number;
  currentKg: number;
  routeGeometry?: GeoJsonLineString; // GeoJSON from OSRM Trip API
  durationSeconds: number;           // total route duration in seconds (from backend)
  distanceKm: number;                // total route distance in km (from backend)
  color: string;
}

/** Depot coordinates — hardcoded area */
export const DEPOT_COORDS = { lat: -6.163799, lng: 106.690751 };
/** Distinct route colors for multi-vehicle map rendering */
export const ROUTE_COLORS = [
  "#2563eb", // blue
  "#dc2626", // red
  "#16a34a", // green
  "#7c3aed", // purple
  "#ea580c", // orange
  "#0891b2", // cyan
  "#be185d", // pink
  "#ca8a04", // yellow
  "#4f46e5", // indigo
  "#059669", // emerald
];
