"use client";

import { useEffect, useRef } from "react";
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
// Auto-fit bounds
// ---------------------------------------------------------------------------
function FitBounds({ positions }: { positions: [number, number][] }) {
  const map = useMap();
  useEffect(() => {
    if (positions.length >= 2) {
      map.fitBounds(L.latLngBounds(positions), { padding: [50, 50] });
    } else if (positions.length === 1) {
      map.setView(positions[0], 13);
    }
  }, [map, positions]);
  return null;
}

// ---------------------------------------------------------------------------
// Popup controller — flies to outlet and opens its popup after movement
// ---------------------------------------------------------------------------
function MapPopupController({
  focusedOutlet,
  markerRefs,
}: {
  focusedOutlet: { custno: string; lat: number; lng: number } | null | undefined;
  markerRefs: React.MutableRefObject<Record<string, L.Marker>>;
}) {
  const map = useMap();
  useEffect(() => {
    if (!focusedOutlet) return;
    map.flyTo([focusedOutlet.lat, focusedOutlet.lng], 16, { duration: 1.5 });
    const timer = setTimeout(() => {
      const marker = markerRefs.current[focusedOutlet.custno];
      if (marker) marker.openPopup();
    }, 500);
    return () => clearTimeout(timer);
  }, [focusedOutlet, map, markerRefs]);
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
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function MapRoute({ routes, visibleVehicles, pendingOutlets, focusedOutlet }: MapRouteProps) {
  const markerRefs = useRef<Record<string, L.Marker>>({});
  const depotPos: [number, number] = [DEPOT_COORDS.lat, DEPOT_COORDS.lng];
  const isPreviewMode = routes.length === 0 && (pendingOutlets?.length ?? 0) > 0;

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
      <MapPopupController focusedOutlet={focusedOutlet} markerRefs={markerRefs} />
      <FitBounds positions={allPositions} />

      {/* Preview mode: gray markers for all pending outlets */}
      {isPreviewMode && pendingOutlets?.map((outlet, idx) => (
        <Marker
          key={`preview-${idx}`}
          position={[outlet.lat, outlet.lng]}
          icon={GRAY_ICON}
        >
          <Popup>
            <div style={{ minWidth: 160 }}>
              <p style={{ fontWeight: 600, margin: 0 }}>{outlet.custname}</p>
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
            {DEPOT_COORDS.lat.toFixed(4)}, {DEPOT_COORDS.lng.toFixed(4)}
          </span>
        </Popup>
      </Marker>

      {/* Per-vehicle route polylines & stop markers */}
      {routes.map((route, rIdx) => {
        // Respect visibility toggle — omit from DOM entirely when hidden
        if (visibleVehicles && !visibleVehicles.includes(route.vehicle.NO_KEND)) return null;

        // GeoJSON [lng, lat] → Leaflet [lat, lng]; fall back to straight lines
        const polylinePoints: [number, number][] = route.routeGeometry
          ? route.routeGeometry.coordinates.map((c) => [c[1], c[0]] as [number, number])
          : [depotPos, ...route.outlets.map((o) => [o.lat, o.lng] as [number, number])];

        return (
          <span key={`route-${rIdx}`}>
            {/* Polyline */}
            {polylinePoints.length >= 2 && (
              <Polyline
                positions={polylinePoints}
                pathOptions={{
                  color: route.color,
                  weight: 4,
                  opacity: 0.8,
                }}
              />
            )}

            {/* Stop markers */}
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
                    <p style={{ fontWeight: 600, margin: "2px 0" }}>{outlet.custname}</p>
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
    </MapContainer>
  );
}
