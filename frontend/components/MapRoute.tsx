"use client";

import { useEffect, useRef, useMemo, memo } from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Polyline,
  Popup,
  useMap,
  ZoomControl,
} from "react-leaflet";
import L from "leaflet";
import type { AssignedRoute, PendingOutlet } from "@/lib/types";
import { DEPOT_COORDS } from "@/lib/types";

// ---------------------------------------------------------------------------
// Fix Leaflet's default icon paths broken by webpack asset hashing
// ---------------------------------------------------------------------------
delete (L.Icon.Default.prototype as unknown as Record<string, unknown>)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

// ---------------------------------------------------------------------------
// Coloured DivIcon factory — creates numbered circle markers
// ---------------------------------------------------------------------------
function makeNumberIcon(label: string | number, color: string, size = 28) {
  const textColor = ["#f59e0b", "#ca8a04"].includes(color) ? "#000" : "#fff";
  return L.divIcon({
    className: "",
    html: `<div style="
      width:${size}px;height:${size}px;border-radius:50%;
      background:${color};color:${textColor};
      display:flex;align-items:center;justify-content:center;
      font-size:${Math.round(size * 0.42)}px;font-weight:700;
      border:2px solid rgba(0,0,0,0.35);
      box-shadow:0 2px 8px rgba(0,0,0,0.5);
    ">${label}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -(size / 2 + 3)],
  });
}

const DEPOT_ICON = makeNumberIcon("D", "#1d4ed8", 32);

const GRAY_ICON = L.divIcon({
  className: "",
  html: `<div style="
    width:24px;height:24px;border-radius:50%;
    background:#6b7280;color:#fff;
    display:flex;align-items:center;justify-content:center;
    font-size:10px;font-weight:700;
    border:2px solid rgba(0,0,0,0.35);
    box-shadow:0 2px 8px rgba(0,0,0,0.5);
  ">●</div>`,
  iconSize: [24, 24],
  iconAnchor: [12, 12],
  popupAnchor: [0, -15],
});

// ---------------------------------------------------------------------------
// Distinct Ghost Marker icon for unassigned outlet preview / hover
// ---------------------------------------------------------------------------
const GHOST_ICON = L.divIcon({
  className: "ghost-pulse-icon",
  html: `<div style="
    position:relative;
    width:36px;height:36px;
    display:flex;align-items:center;justify-content:center;
  ">
    <div style="
      position:absolute;inset:0;border-radius:50%;
      background:rgba(100,116,139,0.35);
      border:2px dashed #475569;
    "></div>
    <div style="
      width:26px;height:26px;border-radius:50%;
      background:#475569;color:#ffffff;
      display:flex;align-items:center;justify-content:center;
      font-size:11px;font-weight:800;
      border:2px solid #ffffff;
      box-shadow:0 3px 12px rgba(15,23,42,0.6);
    ">?</div>
  </div>`,
  iconSize: [36, 36],
  iconAnchor: [18, 18],
  popupAnchor: [0, -20],
});

// ---------------------------------------------------------------------------
// Haversine distance helper for proximity calculation (km)
// ---------------------------------------------------------------------------
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Map Viewport Controller:
// Performs a single one-time initial frame when data first arrives so user sees the area.
// Handles:
// 1. One-time initial frame when dataset first arrives.
// 2. Focused vehicle framing when Route Editor Drawer is open (or vehicle is re-routed),
//    with bottom drawer offset padding ([40, 420]) so the route stays in the top viewport.
// ---------------------------------------------------------------------------
interface MapViewportControllerProps {
  routes: AssignedRoute[];
  pendingOutlets?: PendingOutlet[];
  isPreviewMode: boolean;
  depotPos: [number, number];
  isEditorOpen?: boolean;
  focusedVehicleId?: string | null;
}

function MapViewportController({
  routes,
  pendingOutlets,
  isPreviewMode,
  depotPos,
  isEditorOpen,
  focusedVehicleId,
}: MapViewportControllerProps) {
  const map = useMap();
  const initialFitDoneRef = useRef<boolean>(false);
  const lastFocusedRouteKeyRef = useRef<string | null>(null);

  // 1. One-time initial load framing
  useEffect(() => {
    if (initialFitDoneRef.current) return;

    if (routes.length > 0) {
      initialFitDoneRef.current = true;
      const allCoords: [number, number][] = [depotPos];
      routes.forEach((r) => r.outlets.forEach((o) => allCoords.push([o.lat, o.lng])));
      if (allCoords.length >= 2) {
        map.fitBounds(L.latLngBounds(allCoords), { padding: [50, 50] });
      }
    } else if (isPreviewMode && pendingOutlets && pendingOutlets.length > 0) {
      initialFitDoneRef.current = true;
      const coords: [number, number][] = [
        depotPos,
        ...pendingOutlets.map((o) => [o.lat, o.lng] as [number, number]),
      ];
      map.fitBounds(L.latLngBounds(coords), { padding: [50, 50] });
    }
  }, [map, routes, pendingOutlets, isPreviewMode, depotPos]);

  // 2. In-place Route Editor single-vehicle framing with bottom padding
  useEffect(() => {
    if (!isEditorOpen || !focusedVehicleId) {
      lastFocusedRouteKeyRef.current = null;
      return;
    }

    const activeRoute = routes.find((r) => r.vehicle.NO_KEND === focusedVehicleId);
    if (!activeRoute) return;

    // Unique key to detect vehicle switch or route re-sequencing / geometry update
    const activeRouteKey = `${activeRoute.vehicle.NO_KEND}-${activeRoute.outlets.length}-${activeRoute.distanceKm ?? 0}-${activeRoute.routeGeometry?.coordinates?.length ?? 0}`;

    if (lastFocusedRouteKeyRef.current === activeRouteKey) return;
    lastFocusedRouteKeyRef.current = activeRouteKey;

    const coords: [number, number][] = [depotPos];

    if (activeRoute.routeGeometry?.coordinates && activeRoute.routeGeometry.coordinates.length > 0) {
      activeRoute.routeGeometry.coordinates.forEach((c) => {
        coords.push([c[1], c[0]]);
      });
    } else {
      activeRoute.outlets.forEach((o) => {
        coords.push([o.lat, o.lng]);
      });
    }

    if (coords.length >= 2) {
      // Fit bounds with bottom padding [40, 420] so route remains visible in the top viewport
      map.fitBounds(L.latLngBounds(coords), {
        paddingTopLeft: [40, 40],
        paddingBottomRight: [40, 420],
        maxZoom: 15,
        animate: true,
        duration: 0.8,
      });
    }
  }, [map, routes, isEditorOpen, focusedVehicleId, depotPos]);

  return null;
}

// ---------------------------------------------------------------------------
// Popup controller — opens marker popup without jumping or recentering map
// ---------------------------------------------------------------------------
function MapPopupController({
  focusedOutlet,
  markerRefs,
}: {
  focusedOutlet: { custno: string; lat: number; lng: number } | null | undefined;
  markerRefs: React.MutableRefObject<Record<string, L.Marker>>;
}) {
  useEffect(() => {
    if (!focusedOutlet) return;
    const marker = markerRefs.current[focusedOutlet.custno];
    if (marker) {
      marker.openPopup();
    }
  }, [focusedOutlet, markerRefs]);
  return null;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
interface MapRouteProps {
  routes: AssignedRoute[];
  /** Set of NO_KEND values that should be rendered. Omit to show all. */
  visibleVehicles?: string[];
  /** Outlets to show as gray preview markers (before assignment). */
  pendingOutlets?: PendingOutlet[];
  /** Outlet to fly to and open popup when a dispatcher clicks it in the panel. */
  focusedOutlet?: { custno: string; lat: number; lng: number } | null;
  /** Ghost Marker: Hovered/clicked unassigned outlet in Route Editor Drawer */
  focusedUnassignedOutlet?: PendingOutlet | null;
  /** Currently selected vehicle route in Route Editor Drawer (for proximity line) */
  selectedVehicleRoute?: AssignedRoute | null;
  /** Whether the Route Editor Drawer is currently open */
  isEditorOpen?: boolean;
  /** Vehicle ID currently being edited in Route Editor Drawer */
  focusedVehicleId?: string | null;
  /** Configurable depot coordinates */
  depotCoords?: { lat: number; lng: number };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
function MapRouteComponent({
  routes,
  visibleVehicles,
  pendingOutlets,
  focusedOutlet,
  focusedUnassignedOutlet,
  selectedVehicleRoute,
  isEditorOpen,
  focusedVehicleId,
  depotCoords,
}: MapRouteProps) {
  const markerRefs = useRef<Record<string, L.Marker>>({});
  const activeDepot = depotCoords ?? DEPOT_COORDS;
  const depotPos: [number, number] = [activeDepot.lat, activeDepot.lng];
  const isPreviewMode = routes.length === 0 && (pendingOutlets?.length ?? 0) > 0;

  // Proximity Calculation: Find nearest stop of selectedVehicleRoute to focusedUnassignedOutlet
  const nearestStopInfo = useMemo(() => {
    if (!focusedUnassignedOutlet || !selectedVehicleRoute) return null;
    if (selectedVehicleRoute.outlets.length === 0) {
      const dist = haversineKm(
        focusedUnassignedOutlet.lat,
        focusedUnassignedOutlet.lng,
        activeDepot.lat,
        activeDepot.lng
      );
      return {
        lat: activeDepot.lat,
        lng: activeDepot.lng,
        outletName: "Depot / Warehouse",
        vehicleNoKend: selectedVehicleRoute.vehicle.NO_KEND,
        distanceKm: dist,
      };
    }

    let bestOutlet = selectedVehicleRoute.outlets[0];
    let minDistance = haversineKm(
      focusedUnassignedOutlet.lat,
      focusedUnassignedOutlet.lng,
      bestOutlet.lat,
      bestOutlet.lng
    );

    for (let i = 1; i < selectedVehicleRoute.outlets.length; i++) {
      const o = selectedVehicleRoute.outlets[i];
      const dist = haversineKm(
        focusedUnassignedOutlet.lat,
        focusedUnassignedOutlet.lng,
        o.lat,
        o.lng
      );
      if (dist < minDistance) {
        minDistance = dist;
        bestOutlet = o;
      }
    }

    return {
      lat: bestOutlet.lat,
      lng: bestOutlet.lng,
      outletName: bestOutlet.custname,
      vehicleNoKend: selectedVehicleRoute.vehicle.NO_KEND,
      distanceKm: minDistance,
    };
  }, [focusedUnassignedOutlet, selectedVehicleRoute]);

  // Collect all positions for bounds fitting
  const allPositions: [number, number][] = [depotPos];
  if (isPreviewMode && pendingOutlets) {
    for (const o of pendingOutlets) {
      allPositions.push([o.lat, o.lng]);
    }
  }
  for (const route of routes) {
    if (route.routeGeometry) {
      // GeoJSON coordinates are [lng, lat] — flip to [lat, lng] for Leaflet
      for (const coord of route.routeGeometry.coordinates) {
        allPositions.push([coord[1], coord[0]]);
      }
    }
    for (const o of route.outlets) {
      allPositions.push([o.lat, o.lng]);
    }
  }

  return (
    <MapContainer
      center={depotPos}
      zoom={12}
      className="h-full w-full rounded-xl"
      scrollWheelZoom
      zoomControl={false}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />

      <ZoomControl position="bottomright" />
      <MapPopupController
        focusedOutlet={focusedOutlet}
        markerRefs={markerRefs}
      />
      <MapViewportController
        routes={routes}
        pendingOutlets={pendingOutlets}
        isPreviewMode={isPreviewMode}
        depotPos={depotPos}
        isEditorOpen={isEditorOpen}
        focusedVehicleId={focusedVehicleId}
      />

      {/* Preview mode: gray markers for all pending outlets */}
      {isPreviewMode && pendingOutlets?.map((outlet, idx) => (
        <Marker
          key={`preview-${idx}`}
          position={[outlet.lat, outlet.lng]}
          icon={GRAY_ICON}
        >
          <Popup>
            <div style={{ minWidth: 160 }}>
              <p style={{ fontWeight: 600, margin: 0 }}>
                {outlet.custname}
                {outlet.is_cross_zone_swept && (
                  <span style={{ fontSize: 9, marginLeft: 6, background: "#dbeafe", color: "#1d4ed8", padding: "2px 4px", borderRadius: 4, textTransform: "uppercase", fontWeight: "bold" }}>Cross-Zone Swept</span>
                )}
              </p>
              <p style={{ fontSize: 11, color: "#555", margin: 0 }}>
                {outlet.custno} · {outlet.invoices.length} invoice(s)
              </p>
              <p style={{ fontSize: 11, color: "#777", margin: "2px 0 0" }}>
                {outlet.total_kubikasi_m3.toFixed(3)} M³ / {outlet.total_berat_kg.toFixed(1)} Kg
              </p>
            </div>
          </Popup>
        </Marker>
      ))}

      {/* Depot marker */}
      <Marker position={depotPos} icon={DEPOT_ICON} zIndexOffset={2000}>
        <Popup>
          <strong>Depot / Warehouse</strong>
          <br />
          <span style={{ fontSize: 11, color: "#666" }}>
            {activeDepot.lat.toFixed(4)}, {activeDepot.lng.toFixed(4)}
          </span>
        </Popup>
      </Marker>

      {/* Per-vehicle route polylines & stop markers */}
      {routes.map((route, rIdx) => {
        // Respect visibility toggle — omit from DOM entirely when hidden
        if (visibleVehicles && !visibleVehicles.includes(route.vehicle.NO_KEND)) return null;

        // When a vehicle is focused (e.g. editing in bottom drawer), completely HIDE other vehicles
        if (focusedVehicleId && route.vehicle.NO_KEND !== focusedVehicleId) {
          return null;
        }

        // GeoJSON [lng, lat] → Leaflet [lat, lng]; fall back to straight lines
        const polylinePoints: [number, number][] = route.routeGeometry
          ? route.routeGeometry.coordinates.map((c) => [c[1], c[0]] as [number, number])
          : [depotPos, ...route.outlets.map((o) => [o.lat, o.lng] as [number, number])];

        return (
          <span key={`route-${rIdx}`}>
            {polylinePoints.length >= 2 && (
              <Polyline
                positions={polylinePoints}
                pathOptions={{
                  color: route.color,
                  weight: 4,
                  opacity: 0.9,
                }}
              />
            )}

            {/* Stop markers for the active vehicle only */}
            {route.outlets.map((outlet, sIdx) => (
              <Marker
                key={`stop-${rIdx}-${sIdx}`}
                position={[outlet.lat, outlet.lng]}
                icon={makeNumberIcon(sIdx + 1, route.color)}
                ref={(r: L.Marker | null) => { if (r) markerRefs.current[outlet.custno] = r; }}
              >
                <Popup>
                  <div style={{ minWidth: 180 }}>
                    <p style={{ fontWeight: 700, margin: 0, color: route.color }}>
                      {route.vehicle.NO_KEND} — Stop {sIdx + 1}
                    </p>
                    <p style={{ fontWeight: 600, margin: "2px 0" }}>
                      {outlet.custname}
                      {outlet.is_cross_zone_swept && (
                        <span style={{ fontSize: 9, marginLeft: 6, background: "#dbeafe", color: "#1d4ed8", padding: "2px 4px", borderRadius: 4, textTransform: "uppercase", fontWeight: "bold", display: "inline-block" }}>Cross-Zone Swept</span>
                      )}
                    </p>
                    <p style={{ fontSize: 11, color: "#555", margin: 0 }}>
                      {outlet.custno} · {outlet.invoices.length} invoice(s)
                    </p>
                    <p style={{ fontSize: 11, color: "#777", margin: "2px 0 0" }}>
                      {outlet.total_kubikasi_m3.toFixed(3)} M³ / {outlet.total_berat_kg.toFixed(1)} Kg
                    </p>
                  </div>
                </Popup>
              </Marker>
            ))}
          </span>
        );
      })}

      {/* ── Ghost Marker & Proximity Visual for Route Editor Drawer ── */}
      {focusedUnassignedOutlet && (
        <>
          <Marker
            position={[focusedUnassignedOutlet.lat, focusedUnassignedOutlet.lng]}
            icon={GHOST_ICON}
            zIndexOffset={3500}
          >
            <Popup autoPan={false}>
              <div style={{ minWidth: 200, fontFamily: "sans-serif" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                  <span
                    style={{
                      background: "#334155",
                      color: "#f8fafc",
                      padding: "2px 6px",
                      borderRadius: 4,
                      fontSize: 10,
                      fontWeight: 700,
                    }}
                  >
                    GHOST UNASSIGNED
                  </span>
                  <span style={{ fontSize: 10, color: "#64748b", fontFamily: "monospace" }}>
                    {focusedUnassignedOutlet.custno}
                  </span>
                </div>
                <p style={{ fontWeight: 700, margin: "2px 0", fontSize: 12, color: "#0f172a" }}>
                  {focusedUnassignedOutlet.custname}
                </p>
                <p style={{ fontSize: 11, color: "#475569", margin: "2px 0" }}>
                  📦 {focusedUnassignedOutlet.total_kubikasi_m3.toFixed(3)} m³ · ⚖️ {focusedUnassignedOutlet.total_berat_kg.toFixed(1)} kg
                </p>
                {focusedUnassignedOutlet.zone && (
                  <p style={{ fontSize: 10, color: "#64748b", margin: "2px 0" }}>
                    📍 Zone: {focusedUnassignedOutlet.zone}
                  </p>
                )}
                {nearestStopInfo && (
                  <div
                    style={{
                      marginTop: 6,
                      padding: "5px 7px",
                      background: "#f1f5f9",
                      border: "1px solid #e2e8f0",
                      borderRadius: 6,
                      fontSize: 10,
                      color: "#334155",
                    }}
                  >
                    🔗 Nearest stop ({nearestStopInfo.vehicleNoKend}):<br />
                    <strong>{nearestStopInfo.outletName}</strong> (~{nearestStopInfo.distanceKm.toFixed(1)} km away)
                  </div>
                )}
              </div>
            </Popup>
          </Marker>

          {/* Proximity Visual: Dashed SVG Polyline to nearest route node */}
          {nearestStopInfo && (
            <Polyline
              positions={[
                [focusedUnassignedOutlet.lat, focusedUnassignedOutlet.lng],
                [nearestStopInfo.lat, nearestStopInfo.lng],
              ]}
              pathOptions={{
                color: selectedVehicleRoute?.color || "#475569",
                dashArray: "6, 8",
                weight: 3,
                opacity: 0.85,
              }}
            />
          )}
        </>
      )}
    </MapContainer>
  );
}

const MapRoute = memo(MapRouteComponent);
export default MapRoute;
