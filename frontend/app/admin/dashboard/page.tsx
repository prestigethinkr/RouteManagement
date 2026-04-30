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
} from "lucide-react";

// ---------------------------------------------------------------------------
// Dynamic import of Leaflet map (SSR disabled)
// ---------------------------------------------------------------------------
const MapRoute = dynamic(() => import("@/components/MapRoute"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center rounded-xl bg-gray-900">
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
  const [loading, setLoading] = useState(false);
  const [assignStatusText, setAssignStatusText] = useState("");

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
      };

      const backendRes = await fetch("http://localhost:8000/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

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

      const outletMap = new Map(pendingOutlets.map((o) => [o.custno, o]));
      const vehicleMap = new Map(availableVehicles.map((v) => [v.NO_KEND, v]));

      const finalRoutes = await Promise.all(
        optimizedData.assigned_routes.map(async (routeGroup, idx) => {
          // Reconstruct ordered outlet objects from optimized sequence
          const orderedOutlets = routeGroup.route
            .map((id) => outletMap.get(id))
            .filter((o): o is PendingOutlet => o !== undefined);

          const vehicle = vehicleMap.get(routeGroup.vehicle_id)!;

          // Build OSRM coordinate string: depot → outlets in optimized order
          // Filter out any points with NaN coords before building the URL
          const rawCoords = [
            `${DEPOT_COORDS.lng},${DEPOT_COORDS.lat}`,
            ...orderedOutlets.map((o) => `${o.lng},${o.lat}`),
          ].filter((c) => !c.includes("NaN"));

          const coordsString = rawCoords.join(";");

          let routeGeometry: GeoJsonLineString | undefined;
          try {
            // GET with coords in URL path — avoids URLSearchParams encoding semicolons as %3B
            const osrmUrl = `http://20.187.66.251/osrm/route/v1/driving/${coordsString}?overview=full&geometries=geojson`;
            const osrmRes = await fetch(osrmUrl);
            if (!osrmRes.ok) {
              console.warn(`[OSRM Route] ${vehicle.NO_KEND}: HTTP ${osrmRes.status}`);
            } else {
              const osrmData = await osrmRes.json();
              const routeObj = osrmData.routes?.[0];
              if (routeObj) {
                routeGeometry = routeObj.geometry ?? undefined;
              }
            }
          } catch (err) {
            console.warn(`[OSRM Route] ${vehicle.NO_KEND}:`, err);
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

  // --- Assign 2nd Trip (Ritase 2) ---
  async function assignSecondTrip() {
    if (unassignedOutlets.length === 0) return;
    setAssigning(true);
    setAssignStatusText("Selecting fastest vehicles for Trip 2…");

    try {
      // 1. Calculate total required capacity for unassigned outlets
      const requiredM3 = unassignedOutlets.reduce((sum, o) => sum + o.total_kubikasi_m3, 0);
      const requiredKg = unassignedOutlets.reduce((sum, o) => sum + o.total_berat_kg, 0);

      // 2. Sort current routes by duration (fastest first)
      const sortedRoutes = [...assignedRoutes].sort(
        (a, b) => (a.durationSeconds || 0) - (b.durationSeconds || 0)
      );

      // 3. Select vehicles until capacity is met
      const selectedVehicles: Vehicle[] = [];
      let accumulatedM3 = 0;
      let accumulatedKg = 0;

      for (const routeGroup of sortedRoutes) {
        if (accumulatedM3 >= requiredM3 && accumulatedKg >= requiredKg) break;
        const vehicleClone: Vehicle = {
          ...routeGroup.vehicle,
          NO_KEND: `${routeGroup.vehicle.NO_KEND} (Trip 2)`,
        };
        selectedVehicles.push(vehicleClone);
        accumulatedM3 += vehicleClone.KUBIKASE;
        accumulatedKg += vehicleClone.TONASE;
      }

      setAssignStatusText("AI is calculating Trip 2 routes…");

      // 4. Build payload for Python backend
      const payload = {
        depot: { lat: DEPOT_COORDS.lat, lng: DEPOT_COORDS.lng },
        outlets: unassignedOutlets.map((o) => ({
          id: o.custno,
          lat: o.lat,
          lng: o.lng,
          m3: o.total_kubikasi_m3,
          kg: o.total_berat_kg,
        })),
        vehicles: selectedVehicles.map((v) => ({
          id: v.NO_KEND,
          max_m3: v.KUBIKASE,
          max_kg: v.TONASE,
        })),
        algorithm: viewingAlgorithm,
        max_stops: maxStops,
      };

      // 5. Fetch from Python backend
      const backendRes = await fetch("http://localhost:8000/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!backendRes.ok) {
        const errText = await backendRes.text();
        throw new Error(`Trip 2 optimization failed: ${errText}`);
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

      setAssignStatusText("Drawing Trip 2 road networks…");

      // 6. Reconstruct outlet objects + fetch OSRM road geometries
      const outletMap = new Map(unassignedOutlets.map((o) => [o.custno, o]));
      const vehicleMap = new Map(selectedVehicles.map((v) => [v.NO_KEND, v]));
      const colorOffset = assignedRoutes.length;

      const trip2Routes = await Promise.all(
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
            const osrmUrl = `http://20.187.66.251:5000/route/v1/driving/${coordsString}?overview=full&geometries=geojson&continue_straight=true`;
            const osrmRes = await fetch(osrmUrl);
            if (osrmRes.ok) {
              const osrmData = await osrmRes.json();
              const routeObj = osrmData.routes?.[0];
              if (routeObj) {
                routeGeometry = routeObj.geometry ?? undefined;
              }
            }
          } catch (err) {
            console.warn(`[OSRM Trip2] ${vehicle.NO_KEND}:`, err);
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

      // 7. Append new routes to existing state and update unassigned
      const newlyAssignedIds = new Set(
        optimizedData.assigned_routes.flatMap((r) => r.route)
      );
      const remainingUnassigned = unassignedOutlets.filter(
        (o) => !newlyAssignedIds.has(o.custno)
      );
      const updatedResult = {
        routes: [...assignedRoutes, ...trip2Routes],
        unassigned: remainingUnassigned,
      };
      if (viewingAlgorithm === "ortools") {
        setOrtoolsResult(updatedResult);
      } else {
        setHygeseResult(updatedResult);
      }
      setVisibleVehicles((prev) => [...prev, ...trip2Routes.map((r) => r.vehicle.NO_KEND)]);

      const stillUnassigned = optimizedData.unassigned_outlets.length;
      toast({
        title: "Trip 2 assigned",
        description: `${trip2Routes.length} vehicle(s) dispatched, ${stillUnassigned} outlet(s) still unassigned`,
      });
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Trip 2 failed",
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
    <div className="relative w-full h-screen overflow-hidden bg-gray-950 text-gray-100">

      {/* ════════════ FULL-SCREEN MAP ════════════ */}
      <div className="absolute inset-0 z-0">
        {!hasRoutes && !isDataLoaded ? (
          <div className="flex h-full w-full flex-col items-center justify-center text-gray-700">
            <Truck className="mb-3 h-16 w-16 opacity-20" />
            <p className="text-sm font-medium opacity-50">Upload files and load data to begin</p>
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
          className="absolute top-4 left-4 z-[1000] bg-slate-900/80 backdrop-blur border border-slate-700 p-3 rounded-lg shadow-lg cursor-pointer text-slate-300 hover:text-white transition-colors"
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
        <div className="w-72 flex flex-col max-h-full bg-slate-900/80 backdrop-blur-md rounded-xl border border-slate-700 shadow-2xl overflow-hidden">
          <div className="shrink-0 px-3 pt-3 pb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <button
                onClick={() => setIsLeftPanelOpen(false)}
                className="text-slate-500 hover:text-slate-200 transition-colors p-0.5 rounded"
                title="Close panel"
              >
                <X className="h-4 w-4" />
              </button>
              <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
                {hasRoutes ? `Assigned Routes (${assignedRoutes.length})` : "Route Summary"}
              </p>
            </div>
            {hasRoutes && (
              <div className="flex gap-1">
                <button onClick={showAllVehicles} className="text-[10px] px-1.5 py-0.5 rounded text-slate-400 hover:bg-slate-700 hover:text-slate-200 transition-colors">All</button>
                <button onClick={hideAllVehicles} className="text-[10px] px-1.5 py-0.5 rounded text-slate-400 hover:bg-slate-700 hover:text-slate-200 transition-colors">None</button>
              </div>
            )}
          </div>

          {/* Algorithm comparison toggle */}
          {hasAnyResult && (
            <div className="shrink-0 flex mx-3 mb-2 rounded-lg border border-slate-700 overflow-hidden text-[10px] font-semibold">
              <button
                disabled={!ortoolsResult}
                onClick={() => ortoolsResult && switchView("ortools")}
                className={`flex-1 py-1.5 transition-colors border-r border-slate-700 ${
                  viewingAlgorithm === "ortools" && ortoolsResult
                    ? "bg-blue-600/30 text-blue-300"
                    : ortoolsResult
                      ? "text-slate-500 hover:bg-slate-800"
                      : "text-slate-700 cursor-not-allowed"
                }`}
              >
                OR-Tools {ortoolsResult ? "✓" : "–"}
              </button>
              <button
                disabled={!hygeseResult}
                onClick={() => hygeseResult && switchView("pyhygese")}
                className={`flex-1 py-1.5 transition-colors ${
                  viewingAlgorithm === "pyhygese" && hygeseResult
                    ? "bg-violet-600/30 text-violet-300"
                    : hygeseResult
                      ? "text-slate-500 hover:bg-slate-800"
                      : "text-slate-700 cursor-not-allowed"
                }`}
              >
                HGS-CVRP {hygeseResult ? "✓" : "–"}
              </button>
            </div>
          )}

          <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-2">
            {!hasRoutes ? (
              <div className="flex flex-col items-center justify-center py-8 text-center text-slate-600">
                <Truck className="mb-2 h-8 w-8 opacity-30" />
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
                    <div key={idx} className="rounded-lg border border-slate-700 bg-slate-800/50">
                      {/* Accordion header */}
                      <div className="w-full flex items-center gap-1 px-3 pt-3 pb-1">
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
                            <p className="truncate text-xs font-bold text-slate-100">
                              {route.vehicle.NO_KEND}
                            </p>
                            <div className="text-[10px] text-slate-300 flex items-center gap-1 flex-wrap">
                              <span>{route.vehicle.JNS_KEND}</span>
                              <span>·</span>
                              <span>{route.outlets.length} stop(s)</span>
                              {(route.distanceKm > 0 || route.durationSeconds > 0) && (
                                <>
                                  <span>·</span>
                                  <span className="font-semibold text-blue-400">{formatDistance(route.distanceKm)}</span>
                                  <span>·</span>
                                  <span className="font-semibold text-amber-400">ETA: {formatDuration(route.durationSeconds)}</span>
                                </>
                              )}
                            </div>
                          </div>
                          {isExpanded
                            ? <ChevronUp className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                            : <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-500" />}
                        </button>
                        <button
                          className="shrink-0 rounded p-0.5 transition-colors"
                          style={{ color: isVehicleVisible ? route.color : "#6b7280" }}
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
                        <div className="border-t border-slate-700 px-3 py-2 space-y-1">
                          {route.outlets.map((outlet, sIdx) => (
                            <div
                              key={sIdx}
                              className="flex items-center gap-2 rounded px-2 py-1 text-[10px] hover:bg-slate-700/50 cursor-pointer"
                              onClick={() => setFocusedOutlet({ custno: outlet.custno, lat: outlet.lat, lng: outlet.lng })}
                            >
                              <span
                                className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[8px] font-bold text-white"
                                style={{ background: route.color }}
                              >
                                {sIdx + 1}
                              </span>
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-slate-200 font-medium">{outlet.custname}</p>
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
                  <div className="rounded-lg border border-amber-800/50 bg-amber-900/20 p-3">
                    <div className="mb-1 flex items-center justify-between">
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-400">
                        <AlertTriangle className="h-3.5 w-3.5" />
                        {unassignedOutlets.length} Unassigned
                      </div>
                      {assignedRoutes.length > 0 && (
                        <button
                          onClick={assignSecondTrip}
                          disabled={assigning}
                          className="px-2.5 py-1 bg-blue-600 hover:bg-blue-500 text-white text-[10px] font-medium rounded shadow disabled:opacity-50 transition-colors"
                        >
                          {assigning ? "Calculating…" : "Assign 2nd Trip"}
                        </button>
                      )}
                    </div>
                    <div className="max-h-32 overflow-y-auto space-y-0.5">
                      {unassignedOutlets.map((o, i) => (
                        <p key={i} className="truncate text-[10px] text-amber-300/70">
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
      <div className="absolute top-4 right-4 z-[1000] w-72 bg-slate-900/80 backdrop-blur-md rounded-xl border border-slate-700 shadow-2xl p-4 flex flex-col gap-4">

        {/* File uploads */}
        <div className="space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
            File Uploads
          </p>

          <input ref={invoiceInputRef} type="file" accept=".csv,.xls,.xlsx" className="hidden" onChange={handleInvoiceFile} />
          <button
            onClick={() => invoiceInputRef.current?.click()}
            className="flex w-full items-center gap-2.5 rounded-lg border border-dashed border-slate-700 p-2.5 text-left transition-colors hover:border-blue-500 hover:bg-slate-800"
          >
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-600/20">
              <FileSpreadsheet className="h-3.5 w-3.5 text-blue-400" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-slate-200">
                {invoiceFileName ?? "Upload Invoices"}
              </p>
              <p className="text-[10px] text-slate-500">
                {pendingOutlets.length > 0
                  ? `${pendingOutlets.length} outlets · ${totalInvoices} invoices`
                  : "CUSTNO, INVNO, LAT, LNG, M³, KG…"}
              </p>
            </div>
            <UploadCloud className="h-3.5 w-3.5 shrink-0 text-slate-500" />
          </button>

          <input ref={vehicleInputRef} type="file" accept=".csv,.xls,.xlsx" className="hidden" onChange={handleVehicleFile} />
          <button
            onClick={() => vehicleInputRef.current?.click()}
            className="flex w-full items-center gap-2.5 rounded-lg border border-dashed border-slate-700 p-2.5 text-left transition-colors hover:border-green-500 hover:bg-slate-800"
          >
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-green-600/20">
              <Truck className="h-3.5 w-3.5 text-green-400" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-slate-200">
                {vehicleFileName ?? "Upload Fleet"}
              </p>
              <p className="text-[10px] text-slate-500">
                {availableVehicles.length > 0
                  ? `${availableVehicles.length} vehicle(s)`
                  : "JNS_KEND, NO_KEND, KUBIKASE, TONASE"}
              </p>
            </div>
            <UploadCloud className="h-3.5 w-3.5 shrink-0 text-slate-500" />
          </button>
        </div>

        {/* Algorithm selector */}
        <div className="space-y-1.5">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
            Algorithm
          </p>
          <div className="flex rounded-lg border border-slate-700 overflow-hidden text-xs font-medium">
            <button
              className={`flex-1 py-1.5 transition-colors ${
                selectedAlgorithm === "ortools"
                  ? "bg-blue-600 text-white"
                  : "text-slate-400 hover:bg-slate-800"
              }`}
              onClick={() => setSelectedAlgorithm("ortools")}
            >
              OR-Tools
            </button>
            <button
              className={`flex-1 py-1.5 transition-colors border-l border-slate-700 ${
                selectedAlgorithm === "pyhygese"
                  ? "bg-violet-600 text-white"
                  : "text-slate-400 hover:bg-slate-800"
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
            className="text-[10px] font-semibold uppercase tracking-widest text-slate-500"
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
            className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
          />
        </div>

        {/* Action buttons */}
        <div className="flex flex-col gap-2">
          <Button
            className="w-full gap-2"
            variant="secondary"
            disabled={!bothLoaded || isDataLoaded}
            onClick={handleLoadData}
          >
            <MapPin className="h-4 w-4" />
            {isDataLoaded ? "Data Loaded ✓" : "Load Data"}
          </Button>
          <Button
            className="w-full gap-2"
            disabled={!isDataLoaded || assigning}
            onClick={autoAssignRoutes}
          >
            {assigning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
            {assigning ? "Computing…" : "Auto-Assign Fleet"}
          </Button>
          {activeResult && (
            <Button
              className="w-full gap-2"
              variant="secondary"
              onClick={() => setIsSummaryOpen(true)}
            >
              <BarChart2 className="h-4 w-4" />
              Fleet Utilization ({viewingAlgorithm === "ortools" ? "OR-Tools" : "HGS-CVRP"})
            </Button>
          )}
          {assigning && assignStatusText && (
            <div className="text-sm text-slate-300 text-center break-words mt-2">
              {assignStatusText}
            </div>
          )}
        </div>

        {/* Summary chips */}
        {hasRoutes && (
          <div className="flex gap-2">
            <div className="flex flex-1 items-center gap-1 rounded-lg bg-slate-800 px-2 py-1.5 text-[10px] text-slate-400">
              <Package className="h-3 w-3 text-blue-400" />
              {assignedRoutes.reduce((s, r) => s + r.currentM3, 0).toFixed(2)} M³
            </div>
            <div className="flex flex-1 items-center gap-1 rounded-lg bg-slate-800 px-2 py-1.5 text-[10px] text-slate-400">
              <Weight className="h-3 w-3 text-amber-400" />
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
