"use client";

import dynamic from "next/dynamic";
import { useRef, useState } from "react";
import type { PendingOutlet, Vehicle, AssignedRoute, GeoJsonLineString } from "@/lib/types";
import { DEPOT_COORDS, ROUTE_COLORS } from "@/lib/types";
import { parseInvoiceFile, parseVehicleFile } from "@/lib/parse-files";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { toast } from "@/hooks/use-toast";
import FleetSummaryTable from "@/components/FleetSummaryTable";
import { simplifyCoordinates } from "@/lib/cvrp";
import {
  Loader2,
  MapPin,
  Truck,
  FileSpreadsheet,
  UploadCloud,
  Zap,
  Package,
  Weight,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Menu,
  X,
  BarChart2,
  RouteIcon,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Dynamic import of Leaflet map (SSR disabled)
// ---------------------------------------------------------------------------
const MapRoute = dynamic(() => import("@/components/MapRoute"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center rounded-xl bg-slate-100">
      <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
    </div>
  ),
});

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
function formatDuration(seconds: number): string {
  if (!seconds) return "0m";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatDistance(km: number): string {
  if (!km) return "0 km";
  return km.toFixed(1) + " km";
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------
export default function FleetDispatchPage() {
  // --- File upload refs ---
  const invoiceInputRef = useRef<HTMLInputElement>(null);
  const vehicleInputRef = useRef<HTMLInputElement>(null);

  // --- Core state ---
  const [pendingOutlets, setPendingOutlets] = useState<PendingOutlet[]>([]);
  const [availableVehicles, setAvailableVehicles] = useState<Vehicle[]>([]);
  const [visibleVehicles, setVisibleVehicles] = useState<string[]>([]);
  const [isDataLoaded, setIsDataLoaded] = useState(false);

  // --- Algorithm A/B state ---
  const [selectedAlgorithm, setSelectedAlgorithm] = useState<"ortools" | "pyhygese">("ortools");
  const [viewingAlgorithm, setViewingAlgorithm] = useState<"ortools" | "pyhygese">("ortools");
  const [ortoolsResult, setOrtoolsResult] = useState<{ routes: AssignedRoute[]; unassigned: PendingOutlet[] } | null>(null);
  const [hygeseResult, setHygeseResult] = useState<{ routes: AssignedRoute[]; unassigned: PendingOutlet[] } | null>(null);

  // --- Derived: active result for current view ---
  const activeResult = viewingAlgorithm === "ortools" ? ortoolsResult : hygeseResult;
  const assignedRoutes = activeResult?.routes ?? [];
  const unassignedOutlets = activeResult?.unassigned ?? [];

  function switchView(algo: "ortools" | "pyhygese") {
    const result = algo === "ortools" ? ortoolsResult : hygeseResult;
    setViewingAlgorithm(algo);
    setVisibleVehicles(result?.routes.map((r) => r.vehicle.NO_KEND) ?? []);
  }

  function toggleVehicleVisibility(noKend: string) {
    setVisibleVehicles((prev) =>
      prev.includes(noKend) ? prev.filter((id) => id !== noKend) : [...prev, noKend]
    );
  }

  function showAllVehicles() {
    setVisibleVehicles(assignedRoutes.map((r) => r.vehicle.NO_KEND));
  }

  function hideAllVehicles() {
    setVisibleVehicles([]);
  }

  // --- UI state ---
  const [invoiceFileName, setInvoiceFileName] = useState<string | null>(null);
  const [vehicleFileName, setVehicleFileName] = useState<string | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [isDrawingRoutes, setIsDrawingRoutes] = useState(false);
  const [loading, setLoading] = useState(false);
  const [assignStatusText, setAssignStatusText] = useState("");

  // --- Env-var URLs (configurable via .env.local) ---
  const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8000";
  const OSRM_URL = process.env.NEXT_PUBLIC_OSRM_URL ?? "http://203.175.125.185:8001";

  // --- Panel visibility ---
  const [isLeftPanelOpen, setIsLeftPanelOpen] = useState(true);
  const [isSummaryOpen, setIsSummaryOpen] = useState(false);

  // --- Max stops per vehicle ---
  const [maxStops, setMaxStops] = useState(40);

  // --- Accordion & map focus state ---
  const [expandedFleets, setExpandedFleets] = useState<Record<string, boolean>>({});
  const [focusedOutlet, setFocusedOutlet] = useState<{ custno: string; lat: number; lng: number } | null>(null);
  function toggleFleet(vehicleId: string) {
    setExpandedFleets((prev) => ({ ...prev, [vehicleId]: !prev[vehicleId] }));
  }

  // --- File handlers ---
  async function handleInvoiceFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const buffer = await file.arrayBuffer();
      const outlets = parseInvoiceFile(buffer, file.name);
      setPendingOutlets(outlets);
      setInvoiceFileName(file.name);
      setOrtoolsResult(null);
      setHygeseResult(null);
      setIsDataLoaded(false);
      toast({
        title: "Invoices loaded",
        description: `${outlets.length} unique outlets parsed from ${file.name}`,
      });
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Failed to parse invoices",
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  async function handleVehicleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const buffer = await file.arrayBuffer();
      const vehicles = parseVehicleFile(buffer, file.name);
      setAvailableVehicles(vehicles);
      setVehicleFileName(file.name);
      setOrtoolsResult(null);
      setHygeseResult(null);
      setIsDataLoaded(false);
      toast({
        title: "Fleet loaded",
        description: `${vehicles.length} vehicle(s) parsed from ${file.name}`,
      });
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Failed to parse vehicles",
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  // --- Load Data: validate & show preview ---
  function handleLoadData() {
    if (pendingOutlets.length === 0 || availableVehicles.length === 0) return;
    setOrtoolsResult(null);
    setHygeseResult(null);
    setIsDataLoaded(true);
    toast({
      title: "Data loaded",
      description: `${pendingOutlets.length} outlets & ${availableVehicles.length} vehicles ready for preview`,
    });
  }

  // --- Auto-Assign via Python CVRP backend + OSRM Road Geometry ---
  async function autoAssignRoutes() {
    if (pendingOutlets.length === 0 || availableVehicles.length === 0) return;
    setAssigning(true);
    setAssignStatusText("Calculating optimal fleet & route assignment…");
    try {
      // PHASE A: Send to Python OR-Tools backend
      const payload = {
        depot: { lat: DEPOT_COORDS.lat, lng: DEPOT_COORDS.lng },
        outlets: pendingOutlets.map((o) => ({
          id: o.custno,
          lat: o.lat,
          lng: o.lng,
          m3: o.total_kubikasi_m3,
          kg: o.total_berat_kg,
          custname: o.custname,
          jns_kend: o.jns_kend,
          invoices: o.invoices.map((inv) => ({
            invno: inv.INVNO,
            m3: inv.TOTAL_KUBIKASI_M3,
            kg: inv.TOTAL_BERAT_KG,
          })),
        })),
        vehicles: availableVehicles.map((v) => ({
          id: v.NO_KEND,
          max_m3: v.KUBIKASE,
          max_kg: v.TONASE,
          jns_kend: v.JNS_KEND,
        })),
        algorithm: selectedAlgorithm,
        max_stops: maxStops,
        trip_iteration: 1,
      };

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(new Error("Timeout: The solver took longer than 5 minutes to respond.")), 300000); // 300s timeout

      let backendRes;
      try {
        backendRes = await fetch(`${BACKEND_URL}/optimize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!backendRes.ok) {
        const errText = await backendRes.text();
        throw new Error(`Backend optimization failed: ${errText}`);
      }

      const optimizedData: {
        assigned_routes: Array<{
          vehicle_id: string;
          total_m3: number;
          total_kg: number;
          route: string[];
          total_duration_s: number;
          total_distance_km: number;
        }>;
        unassigned_outlets: string[];
      } = await backendRes.json();

      // PHASE B: Reconstruct outlet objects + fetch OSRM road geometries
      setAssignStatusText("Drawing road networks…");
      setIsDrawingRoutes(true);

      const outletMap = new Map(pendingOutlets.map((o) => [o.custno, o]));
      const vehicleMap = new Map(availableVehicles.map((v) => [v.NO_KEND, v]));

      let finalRoutes: AssignedRoute[] = [];
      try {
        finalRoutes = await Promise.all(
          optimizedData.assigned_routes.map(async (routeGroup, idx) => {
            const orderedOutlets = routeGroup.route
              .map((id) => outletMap.get(id))
              .filter((o): o is PendingOutlet => o !== undefined);

            const vehicle = vehicleMap.get(routeGroup.vehicle_id)!;

            const rawCoords = [
              `${DEPOT_COORDS.lng},${DEPOT_COORDS.lat}`,
              ...orderedOutlets.map((o) => `${o.lng},${o.lat}`),
            ].filter((c) => !c.includes("NaN"));

            const coordsString = rawCoords.join(";");

            let routeGeometry: GeoJsonLineString | undefined;
            try {
              const osrmUrl = `${OSRM_URL}/route/v1/driving/${coordsString}?overview=full&geometries=geojson`;
              const osrmRes = await fetch(osrmUrl);
              if (!osrmRes.ok) {
                console.error(
                  `[OSRM Route] ${vehicle.NO_KEND}: HTTP ${osrmRes.status} — check CORS headers or OSRM server availability at ${OSRM_URL}`
                );
              } else {
                const osrmData = await osrmRes.json();
                const routeObj = osrmData.routes?.[0];
                if (routeObj?.geometry?.coordinates?.length) {
                  const simplified = simplifyCoordinates(
                    routeObj.geometry.coordinates as [number, number][]
                  );
                  routeGeometry = { ...routeObj.geometry, coordinates: simplified };
                } else {
                  console.error(
                    `[OSRM Route] ${vehicle.NO_KEND}: empty or invalid geometry in response`,
                    osrmData
                  );
                }
              }
            } catch (err) {
              console.error(
                `[OSRM Route] ${vehicle.NO_KEND}: network or CORS error —`,
                err
              );
            }

            return {
              vehicle,
              outlets: orderedOutlets,
              currentM3: routeGroup.total_m3,
              currentKg: routeGroup.total_kg,
              routeGeometry,
              durationSeconds: routeGroup.total_duration_s ?? 0,
              distanceKm: routeGroup.total_distance_km ?? 0,
              color: ROUTE_COLORS[idx % ROUTE_COLORS.length],
            } satisfies AssignedRoute;
          })
        );
      } finally {
        setIsDrawingRoutes(false);
      }

      // Map unassigned IDs back to full outlet objects
      const unassigned = optimizedData.unassigned_outlets
        .map((id) => outletMap.get(id))
        .filter((o): o is PendingOutlet => o !== undefined);

      const newResult = { routes: finalRoutes, unassigned };
      if (selectedAlgorithm === "ortools") {
        setOrtoolsResult(newResult);
      } else {
        setHygeseResult(newResult);
      }
      setViewingAlgorithm(selectedAlgorithm);
      setVisibleVehicles(finalRoutes.map((r) => r.vehicle.NO_KEND));

      toast({
        title: "Fleet assigned & routes drawn",
        description: `${finalRoutes.length} vehicle(s) assigned, ${unassigned.length} outlet(s) unassigned`,
      });
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Auto-assign failed",
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setAssigning(false);
      setAssignStatusText("");
    }
  }

  // --- Assign Next Trip ---
  async function assignNextTrip() {
    if (unassignedOutlets.length === 0) return;
    setAssigning(true);

    const currentMaxTrip = Math.max(1, ...assignedRoutes.map(r => {
      const match = r.vehicle.NO_KEND.match(/\(Trip (\d+)\)/);
      return match ? parseInt(match[1]) : 1;
    }));
    const nextTripNum = currentMaxTrip + 1;

    setAssignStatusText(`Selecting fastest vehicles for Trip ${nextTripNum}…`);

    try {
      const requiredM3 = unassignedOutlets.reduce((sum, o) => sum + o.total_kubikasi_m3, 0);
      const requiredKg = unassignedOutlets.reduce((sum, o) => sum + o.total_berat_kg, 0);

      const sortedRoutes = [...assignedRoutes].sort(
        (a, b) => (a.durationSeconds || 0) - (b.durationSeconds || 0)
      );

      const selectedVehicles: Vehicle[] = [];
      let accumulatedM3 = 0;
      let accumulatedKg = 0;

      for (const routeGroup of sortedRoutes) {
        if (accumulatedM3 >= requiredM3 && accumulatedKg >= requiredKg) break;
        const baseNoKend = routeGroup.vehicle.NO_KEND.split(" (Trip ")[0];
        const vehicleClone: Vehicle = {
          ...routeGroup.vehicle,
          NO_KEND: `${baseNoKend} (Trip ${nextTripNum})`,
        };
        selectedVehicles.push(vehicleClone);
        accumulatedM3 += vehicleClone.KUBIKASE;
        accumulatedKg += vehicleClone.TONASE;
      }

      setAssignStatusText(`AI is calculating Trip ${nextTripNum} routes…`);

      const payload = {
        depot: { lat: DEPOT_COORDS.lat, lng: DEPOT_COORDS.lng },
        outlets: unassignedOutlets.map((o) => ({
          id: o.custno,
          lat: o.lat,
          lng: o.lng,
          m3: o.total_kubikasi_m3,
          kg: o.total_berat_kg,
          custname: o.custname,
          jns_kend: o.jns_kend,
          invoices: o.invoices.map((inv) => ({
            invno: inv.INVNO,
            m3: inv.TOTAL_KUBIKASI_M3,
            kg: inv.TOTAL_BERAT_KG,
          })),
        })),
        vehicles: selectedVehicles.map((v) => ({
          id: v.NO_KEND,
          max_m3: v.KUBIKASE,
          max_kg: v.TONASE,
          jns_kend: v.JNS_KEND,
        })),
        algorithm: viewingAlgorithm,
        max_stops: maxStops,
        trip_iteration: nextTripNum,
      };

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(new Error("Timeout: The solver took longer than 5 minutes to respond.")), 300000); // 300s timeout

      let backendRes;
      try {
        backendRes = await fetch(`${BACKEND_URL}/optimize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!backendRes.ok) {
        const errText = await backendRes.text();
        throw new Error(`Trip ${nextTripNum} optimization failed: ${errText}`);
      }

      const optimizedData: {
        assigned_routes: Array<{
          vehicle_id: string;
          total_m3: number;
          total_kg: number;
          route: string[];
          total_duration_s: number;
          total_distance_km: number;
        }>;
        unassigned_outlets: string[];
      } = await backendRes.json();

      setAssignStatusText(`Drawing Trip ${nextTripNum} road networks…`);
      setIsDrawingRoutes(true);

      const outletMap = new Map(unassignedOutlets.map((o) => [o.custno, o]));
      const vehicleMap = new Map(selectedVehicles.map((v) => [v.NO_KEND, v]));
      const colorOffset = assignedRoutes.length;

      let nextTripRoutes: AssignedRoute[] = [];
      try {
        nextTripRoutes = await Promise.all(
          optimizedData.assigned_routes.map(async (routeGroup, idx) => {
            const orderedOutlets = routeGroup.route
              .map((id) => outletMap.get(id))
              .filter((o): o is PendingOutlet => o !== undefined);

            const vehicle = vehicleMap.get(routeGroup.vehicle_id)!;

            const rawCoords = [
              `${DEPOT_COORDS.lng},${DEPOT_COORDS.lat}`,
              ...orderedOutlets.map((o) => `${o.lng},${o.lat}`),
            ].filter((c) => !c.includes("NaN"));
            const coordsString = rawCoords.join(";");

            let routeGeometry: GeoJsonLineString | undefined;
            try {
              const osrmUrl = `${OSRM_URL}/route/v1/driving/${coordsString}?overview=full&geometries=geojson&continue_straight=true`;
              const osrmRes = await fetch(osrmUrl);
              if (!osrmRes.ok) {
                console.error(
                  `[OSRM Trip2] ${vehicle.NO_KEND}: HTTP ${osrmRes.status} — check CORS or OSRM server at ${OSRM_URL}`
                );
              } else {
                const osrmData = await osrmRes.json();
                const routeObj = osrmData.routes?.[0];
                if (routeObj?.geometry?.coordinates?.length) {
                  const simplified = simplifyCoordinates(
                    routeObj.geometry.coordinates as [number, number][]
                  );
                  routeGeometry = { ...routeObj.geometry, coordinates: simplified };
                } else {
                  console.error(
                    `[OSRM Trip2] ${vehicle.NO_KEND}: empty or invalid geometry`,
                    osrmData
                  );
                }
              }
            } catch (err) {
              console.error(`[OSRM Trip2] ${vehicle.NO_KEND}: network or CORS error —`, err);
            }

            return {
              vehicle,
              outlets: orderedOutlets,
              currentM3: routeGroup.total_m3,
              currentKg: routeGroup.total_kg,
              routeGeometry,
              durationSeconds: routeGroup.total_duration_s ?? 0,
              distanceKm: routeGroup.total_distance_km ?? 0,
              color: ROUTE_COLORS[(colorOffset + idx) % ROUTE_COLORS.length],
            } satisfies AssignedRoute;
          })
        );
      } finally {
        setIsDrawingRoutes(false);
      }

      const newlyAssignedIds = new Set(
        optimizedData.assigned_routes.flatMap((r) => r.route)
      );
      const remainingUnassigned = unassignedOutlets.filter(
        (o) => !newlyAssignedIds.has(o.custno)
      );
      const updatedResult = {
        routes: [...assignedRoutes, ...nextTripRoutes],
        unassigned: remainingUnassigned,
      };
      if (viewingAlgorithm === "ortools") {
        setOrtoolsResult(updatedResult);
      } else {
        setHygeseResult(updatedResult);
      }
      setVisibleVehicles((prev) => [...prev, ...nextTripRoutes.map((r) => r.vehicle.NO_KEND)]);

      const stillUnassigned = optimizedData.unassigned_outlets.length;
      toast({
        title: `Trip ${nextTripNum} assigned`,
        description: `${nextTripRoutes.length} vehicle(s) dispatched, ${stillUnassigned} outlet(s) still unassigned`,
      });
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Trip Assignment failed",
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setAssigning(false);
      setAssignStatusText("");
    }
  }

  // --- Derived values ---
  const bothLoaded = pendingOutlets.length > 0 && availableVehicles.length > 0;
  const hasRoutes = assignedRoutes.length > 0;
  const hasAnyResult = ortoolsResult !== null || hygeseResult !== null;
  const totalInvoices = pendingOutlets.reduce((s, o) => s + o.invoices.length, 0);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="relative w-full h-screen overflow-hidden bg-slate-100">

      {/* ════════════ FULL-SCREEN MAP ════════════ */}
      <div className="absolute inset-0 z-0">
        {!hasRoutes && !isDataLoaded ? (
          <div className="flex h-full w-full flex-col items-center justify-center text-slate-400 bg-slate-50">
            <RouteIcon className="mb-3 h-14 w-14 opacity-20" />
            <p className="text-sm font-medium">Upload files and load data to begin</p>
          </div>
        ) : !hasRoutes && isDataLoaded ? (
          <MapRoute routes={[]} pendingOutlets={pendingOutlets} focusedOutlet={focusedOutlet} />
        ) : (
          <MapRoute routes={assignedRoutes} visibleVehicles={visibleVehicles} focusedOutlet={focusedOutlet} />
        )}
      </div>

      {/* ════════════ FLOATING LEFT PANEL ════════════ */}
      {/* Hamburger button — only shown when panel is closed */}
      {!isLeftPanelOpen && (
        <button
          onClick={() => setIsLeftPanelOpen(true)}
          className="absolute top-4 left-4 z-[1000] bg-white border border-slate-200 p-2.5 rounded-lg shadow-sm cursor-pointer text-slate-600 hover:text-slate-900 hover:bg-slate-50 transition-colors"
          title="Open panel"
        >
          <Menu className="h-4 w-4" />
        </button>
      )}

      {/* Panel body */}
      <div
        className={`absolute top-4 bottom-4 left-4 z-[1000] flex flex-col gap-3 transition-transform duration-300 ${
          isLeftPanelOpen ? "translate-x-0" : "-translate-x-[110%]"
        }`}
      >
        {/* Routes / empty state */}
        <div className="w-72 flex flex-col max-h-full bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="shrink-0 px-3 pt-3 pb-2 flex items-center justify-between border-b border-slate-100">
            <div className="flex items-center gap-2">
              <button
                onClick={() => setIsLeftPanelOpen(false)}
                className="text-slate-400 hover:text-slate-700 transition-colors p-0.5 rounded"
                title="Close panel"
              >
                <X className="h-4 w-4" />
              </button>
              <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">
                {hasRoutes ? `Assigned Routes (${assignedRoutes.length})` : "Route Summary"}
              </p>
            </div>
            {hasRoutes && (
              <div className="flex gap-1">
                <button onClick={showAllVehicles} className="text-[10px] px-1.5 py-0.5 rounded text-slate-500 hover:bg-slate-100 hover:text-slate-800 transition-colors">All</button>
                <button onClick={hideAllVehicles} className="text-[10px] px-1.5 py-0.5 rounded text-slate-500 hover:bg-slate-100 hover:text-slate-800 transition-colors">None</button>
              </div>
            )}
          </div>

          {/* Algorithm comparison toggle */}
          {hasAnyResult && (
            <div className="shrink-0 flex mx-3 my-2 rounded-lg border border-slate-200 overflow-hidden text-[10px] font-semibold">
              <button
                disabled={!ortoolsResult}
                onClick={() => ortoolsResult && switchView("ortools")}
                className={`flex-1 py-1.5 transition-colors border-r border-slate-200 ${
                  viewingAlgorithm === "ortools" && ortoolsResult
                    ? "bg-slate-100 text-slate-900 border-slate-300"
                    : ortoolsResult
                      ? "text-slate-500 hover:bg-slate-50 bg-white"
                      : "text-slate-300 cursor-not-allowed bg-white"
                }`}
              >
                OR-Tools {ortoolsResult ? "✓" : "–"}
              </button>
              <button
                disabled={!hygeseResult}
                onClick={() => hygeseResult && switchView("pyhygese")}
                className={`flex-1 py-1.5 transition-colors ${
                  viewingAlgorithm === "pyhygese" && hygeseResult
                    ? "bg-slate-100 text-slate-900"
                    : hygeseResult
                      ? "text-slate-500 hover:bg-slate-50 bg-white"
                      : "text-slate-300 cursor-not-allowed bg-white"
                }`}
              >
                HGS-CVRP {hygeseResult ? "✓" : "–"}
              </button>
            </div>
          )}

          <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-2">
            {!hasRoutes ? (
              <div className="flex flex-col items-center justify-center py-10 text-center text-slate-400">
                <Truck className="mb-2 h-8 w-8 opacity-25" />
                <p className="text-xs">
                  {isDataLoaded
                    ? 'Click "Auto-Assign Fleet" to compute routes'
                    : bothLoaded
                      ? 'Click "Load Data" to preview outlets'
                      : "Upload both files to start"}
                </p>
              </div>
            ) : (
              <>
                {assignedRoutes.map((route, idx) => {
                  const isExpanded = !!expandedFleets[route.vehicle.NO_KEND];
                  const isVehicleVisible = visibleVehicles.includes(route.vehicle.NO_KEND);
                  return (
                    <div key={idx} className="rounded-lg border border-slate-200 bg-white overflow-hidden">
                      {/* Accordion header */}
                      <div className="w-full flex items-center gap-1 px-3 pt-2.5 pb-1.5">
                        <button
                          className="flex items-center gap-2 text-left flex-1 min-w-0"
                          onClick={() => toggleFleet(route.vehicle.NO_KEND)}
                        >
                          <span
                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
                            style={{ background: route.color }}
                          >
                            {idx + 1}
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-xs font-bold text-slate-900">
                              {route.vehicle.NO_KEND}
                            </p>
                            <div className="text-[10px] text-slate-500 flex items-center gap-1 flex-wrap">
                              <span>{route.vehicle.JNS_KEND}</span>
                              <span>·</span>
                              <span>{route.outlets.length} stop(s)</span>
                              {(route.distanceKm > 0 || route.durationSeconds > 0) && (
                                <>
                                  <span>·</span>
                                  <span className="font-semibold text-blue-600">{formatDistance(route.distanceKm)}</span>
                                  <span>·</span>
                                  <span className="font-semibold text-amber-600">ETA: {formatDuration(route.durationSeconds)}</span>
                                </>
                              )}
                            </div>
                          </div>
                          {isExpanded
                            ? <ChevronUp className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                            : <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" />}
                        </button>
                        <button
                          className="shrink-0 rounded p-0.5 transition-colors"
                          style={{ color: isVehicleVisible ? route.color : "#94a3b8" }}
                          title={isVehicleVisible ? "Hide route" : "Show route"}
                          onClick={() => toggleVehicleVisibility(route.vehicle.NO_KEND)}
                        >
                          {isVehicleVisible
                            ? <Eye className="h-3.5 w-3.5" />
                            : <EyeOff className="h-3.5 w-3.5" />}
                        </button>
                      </div>

                      {/* Capacity bars — always visible */}
                      <div className="px-3 pb-2 space-y-1.5">
                        <Progress
                          value={route.currentM3}
                          max={route.vehicle.KUBIKASE}
                          label={`Vol: ${route.currentM3.toFixed(2)} / ${route.vehicle.KUBIKASE} M³`}
                        />
                        <Progress
                          value={route.currentKg}
                          max={route.vehicle.TONASE}
                          label={`Wt: ${route.currentKg.toFixed(1)} / ${route.vehicle.TONASE} Kg`}
                        />
                      </div>

                      {/* Outlet list — accordion body */}
                      {isExpanded && (
                        <div className="border-t border-slate-100 px-3 py-2 space-y-0.5 bg-slate-50/60">
                          {route.outlets.map((outlet, sIdx) => (
                            <div
                              key={sIdx}
                              className="flex items-center gap-2 rounded px-2 py-1 text-[10px] hover:bg-white cursor-pointer transition-colors"
                              onClick={() => setFocusedOutlet({ custno: outlet.custno, lat: outlet.lat, lng: outlet.lng })}
                            >
                              <span
                                className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[8px] font-bold text-white"
                                style={{ background: route.color }}
                              >
                                {sIdx + 1}
                              </span>
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-slate-800 font-medium">{outlet.custname}</p>
                                <p className="text-slate-400">{outlet.total_kubikasi_m3.toFixed(2)} m³ | {outlet.total_berat_kg.toFixed(2)} Kg</p>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* Unassigned warning + 2nd Trip */}
                {unassignedOutlets.length > 0 && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                    <div className="mb-1 flex items-center justify-between">
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-700">
                        <AlertTriangle className="h-3.5 w-3.5" />
                        {unassignedOutlets.length} Unassigned
                      </div>
                      {assignedRoutes.length > 0 && (
                        <button
                          onClick={assignNextTrip}
                          disabled={assigning}
                          className="px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white text-[10px] font-medium rounded-md shadow-sm disabled:opacity-50 transition-colors"
                        >
                          {assigning ? "Calculating…" : "Assign Next Trip"}
                        </button>
                      )}
                    </div>
                    <div className="max-h-32 overflow-y-auto space-y-0.5">
                      {unassignedOutlets.map((o, i) => (
                        <p key={i} className="truncate text-[10px] text-amber-600/80">
                          {o.custname} ({o.custno})
                        </p>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* ════════════ FLOATING TOP-RIGHT CONTROL PANEL ════════════ */}
      <div className="absolute top-4 right-4 z-[1000] w-72 bg-white rounded-xl border border-slate-200 shadow-sm p-4 flex flex-col gap-4">

        {/* File uploads */}
        <div className="space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">
            File Uploads
          </p>

          <input ref={invoiceInputRef} type="file" accept=".csv,.xls,.xlsx" className="hidden" onChange={handleInvoiceFile} />
          <button
            onClick={() => invoiceInputRef.current?.click()}
            className="flex w-full items-center gap-2.5 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-2.5 text-left transition-colors hover:border-blue-400 hover:bg-slate-100"
          >
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-50 border border-blue-100">
              <FileSpreadsheet className="h-3.5 w-3.5 text-slate-400" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-slate-700">
                {invoiceFileName ?? "Upload Invoices"}
              </p>
              <p className="text-[10px] text-slate-400">
                {pendingOutlets.length > 0
                  ? `${pendingOutlets.length} outlets · ${totalInvoices} invoices`
                  : "CUSTNO, INVNO, LAT, LNG, M³, KG…"}
              </p>
            </div>
            <UploadCloud className="h-3.5 w-3.5 shrink-0 text-slate-400" />
          </button>

          <input ref={vehicleInputRef} type="file" accept=".csv,.xls,.xlsx" className="hidden" onChange={handleVehicleFile} />
          <button
            onClick={() => vehicleInputRef.current?.click()}
            className="flex w-full items-center gap-2.5 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-2.5 text-left transition-colors hover:border-blue-400 hover:bg-slate-100"
          >
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-green-50 border border-green-100">
              <Truck className="h-3.5 w-3.5 text-slate-400" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-slate-700">
                {vehicleFileName ?? "Upload Fleet"}
              </p>
              <p className="text-[10px] text-slate-400">
                {availableVehicles.length > 0
                  ? `${availableVehicles.length} vehicle(s)`
                  : "JNS_KEND, NO_KEND, KUBIKASE, TONASE"}
              </p>
            </div>
            <UploadCloud className="h-3.5 w-3.5 shrink-0 text-slate-400" />
          </button>
        </div>

        {/* Algorithm selector */}
        <div className="space-y-1.5">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">
            Algorithm
          </p>
          <div className="flex rounded-lg border border-slate-200 overflow-hidden text-xs font-medium bg-white">
            <button
              className={`flex-1 py-1.5 transition-colors ${
                selectedAlgorithm === "ortools"
                  ? "bg-blue-600 text-white"
                  : "text-slate-600 hover:bg-slate-50"
              }`}
              onClick={() => setSelectedAlgorithm("ortools")}
            >
              OR-Tools
            </button>
            <button
              className={`flex-1 py-1.5 transition-colors border-l border-slate-200 ${
                selectedAlgorithm === "pyhygese"
                  ? "bg-violet-600 text-white"
                  : "text-slate-600 hover:bg-slate-50"
              }`}
              onClick={() => setSelectedAlgorithm("pyhygese")}
            >
              HGS-CVRP
            </button>
          </div>
        </div>

        {/* Max Stops per Vehicle */}
        <div className="space-y-1.5">
          <label
            htmlFor="max-stops"
            className="text-[10px] font-semibold uppercase tracking-widest text-slate-400"
          >
            Max Stops per Vehicle
          </label>
          <input
            id="max-stops"
            type="number"
            min={1}
            max={500}
            value={maxStops}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (!isNaN(v) && v >= 1 && v <= 500) setMaxStops(v);
            }}
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {/* Action buttons */}
        <div className="flex flex-col gap-2">
          <Button
            className="w-full gap-2 bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 font-medium rounded-md shadow-sm text-xs"
            variant="secondary"
            disabled={!bothLoaded || isDataLoaded}
            onClick={handleLoadData}
          >
            <MapPin className="h-4 w-4" />
            {isDataLoaded ? "Data Loaded ✓" : "Load Data"}
          </Button>
          <Button
            className="w-full gap-2 bg-blue-600 text-white hover:bg-blue-700 font-medium rounded-md shadow-sm text-xs"
            disabled={!isDataLoaded || assigning}
            onClick={autoAssignRoutes}
          >
            {assigning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
            {assigning
              ? isDrawingRoutes
                ? "Drawing Routes…"
                : "Computing…"
              : "Auto-Assign Fleet"}
          </Button>
          {activeResult && (
            <Button
              className="w-full gap-2 bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 font-medium rounded-md shadow-sm text-xs"
              variant="secondary"
              onClick={() => setIsSummaryOpen(true)}
            >
              <BarChart2 className="h-4 w-4" />
              Fleet Utilization ({viewingAlgorithm === "ortools" ? "OR-Tools" : "HGS-CVRP"})
            </Button>
          )}
          {assigning && assignStatusText && (
            <div className="text-xs text-slate-500 text-center break-words mt-1">
              {assignStatusText}
            </div>
          )}
        </div>

        {/* Summary chips */}
        {hasRoutes && (
          <div className="flex gap-2">
            <div className="flex flex-1 items-center gap-1 rounded-lg bg-slate-50 border border-slate-200 px-2 py-1.5 text-[10px] text-slate-600">
              <Package className="h-3 w-3 text-blue-500" />
              {assignedRoutes.reduce((s, r) => s + r.currentM3, 0).toFixed(2)} M³
            </div>
            <div className="flex flex-1 items-center gap-1 rounded-lg bg-slate-50 border border-slate-200 px-2 py-1.5 text-[10px] text-slate-600">
              <Weight className="h-3 w-3 text-amber-500" />
              {assignedRoutes.reduce((s, r) => s + r.currentKg, 0).toFixed(1)} Kg
            </div>
          </div>
        )}
      </div>

      {/* Fleet Utilization Summary modal */}
      {isSummaryOpen && (
        <FleetSummaryTable
          routes={assignedRoutes}
          algorithm={viewingAlgorithm}
          onClose={() => setIsSummaryOpen(false)}
        />
      )}

    </div>
  );
}
