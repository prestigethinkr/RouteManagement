"use client";

import dynamic from "next/dynamic";
import { useRef, useState, useMemo } from "react";
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
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  Menu,
  X,
  BarChart2,
  Terminal,
  ArrowRightLeft,
  MinusCircle,
  PlusCircle,
  Sliders,
  CheckCircle2,
  Search,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import SolverConsoleModal, { SolverLogItem } from "@/components/SolverConsoleModal";
import RouteEditModal from "@/components/RouteEditModal";
import RouteEditorDrawer from "@/components/RouteEditorDrawer";

// ---------------------------------------------------------------------------
// Dynamic import of Leaflet map (SSR disabled)
// ---------------------------------------------------------------------------
const MapRoute = dynamic(() => import("@/components/MapRoute"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center bg-slate-100">
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

function getCvrpApiBase(): string {
  if (typeof window !== "undefined" && window.location.protocol === "https:") {
    if (process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL.startsWith("https://")) {
      return process.env.NEXT_PUBLIC_API_URL;
    }
    return "/api/cvrp";
  }
  return process.env.NEXT_PUBLIC_API_URL || "http://163.52.135.197:8000";
}

function getOsrmApiBase(): string {
  if (typeof window !== "undefined" && window.location.protocol === "https:") {
    if (process.env.NEXT_PUBLIC_OSRM_API_URL && process.env.NEXT_PUBLIC_OSRM_API_URL.startsWith("https://")) {
      return process.env.NEXT_PUBLIC_OSRM_API_URL;
    }
    return "/api/osrm";
  }
  return process.env.NEXT_PUBLIC_OSRM_API_URL || "http://ficom.mayora.co.id:8081/osrm-api";
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

  // --- Algorithm / Constraint Mode state ---
  const [selectedAlgorithm, setSelectedAlgorithm] = useState<"matrix" | "ortools">("matrix");
  const [viewingAlgorithm, setViewingAlgorithm] = useState<"matrix" | "ortools">("matrix");
  const [ortoolsResult, setOrtoolsResult] = useState<{ routes: AssignedRoute[]; unassigned: PendingOutlet[] } | null>(null);
  const [matrixResult, setMatrixResult] = useState<{ routes: AssignedRoute[]; unassigned: PendingOutlet[] } | null>(null);

  // --- Derived: active result for current view ---
  const activeResult = viewingAlgorithm === "matrix" ? matrixResult : ortoolsResult;
  const assignedRoutes = activeResult?.routes ?? [];
  const unassignedOutlets = activeResult?.unassigned ?? [];

  function switchView(algo: "matrix" | "ortools") {
    const result = algo === "matrix" ? matrixResult : ortoolsResult;
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

  // --- UI Layout state (Minimalist Floating Widgets) ---
  const [isLeftPanelOpen, setIsLeftPanelOpen] = useState(true);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [leftTab, setLeftTab] = useState<"assigned" | "unassigned">("assigned");
  const [searchFleet, setSearchFleet] = useState("");
  const [searchUnassigned, setSearchUnassigned] = useState("");
  const [invoiceFileName, setInvoiceFileName] = useState<string | null>(null);
  const [vehicleFileName, setVehicleFileName] = useState<string | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [assignStatusText, setAssignStatusText] = useState("");
  const [isSummaryOpen, setIsSummaryOpen] = useState(false);

  // --- Max stops per vehicle ---
  const [maxStops, setMaxStops] = useState(40);

  // --- Min EPE Threshold (%) for Trip 1 Route Pruning ---
  const [minEpeThreshold, setMinEpeThreshold] = useState(80);

  // --- Min EPE Threshold (%) for Multi-Trip (Trip 2 & 3) Route Pruning ---
  const [minEpeTrip23Threshold, setMinEpeTrip23Threshold] = useState(50);

  // --- Depot Coordinates (Configurable by user, persisted in localStorage) ---
  const [depotCoords, setDepotCoords] = useState<{ lat: number; lng: number }>(() => {
    if (typeof window !== "undefined") {
      try {
        const saved = localStorage.getItem("cvrp_depot_coords");
        if (saved) {
          const parsed = JSON.parse(saved);
          if (
            typeof parsed.lat === "number" &&
            typeof parsed.lng === "number" &&
            !isNaN(parsed.lat) &&
            !isNaN(parsed.lng)
          ) {
            return parsed;
          }
        }
      } catch {
        // fallback to DEPOT_COORDS
      }
    }
    return DEPOT_COORDS;
  });
  const [depotLatStr, setDepotLatStr] = useState<string>(() => String(depotCoords.lat));
  const [depotLngStr, setDepotLngStr] = useState<string>(() => String(depotCoords.lng));

  // --- Real-time Solver Console & Progress ---
  const [solverLogs, setSolverLogs] = useState<SolverLogItem[]>([]);
  const [solverProgress, setSolverProgress] = useState(0);
  const [solverStage, setSolverStage] = useState("");
  const [isLogConsoleOpen, setIsLogConsoleOpen] = useState(false);
  const [isLogConsoleMinimized, setIsLogConsoleMinimized] = useState(false);

  // --- Accordion & map focus state ---
  const [expandedFleets, setExpandedFleets] = useState<Record<string, boolean>>({});
  const [focusedOutlet, setFocusedOutlet] = useState<{ custno: string; lat: number; lng: number } | null>(null);
  function toggleFleet(vehicleId: string) {
    setExpandedFleets((prev) => ({ ...prev, [vehicleId]: !prev[vehicleId] }));
  }

  // --- Human-in-the-Loop Route Editing ---
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingOutlet, setEditingOutlet] = useState<PendingOutlet | null>(null);
  const [editingSourceVehicle, setEditingSourceVehicle] = useState<Vehicle | null>(null);

  // --- Manual Route Editor Bottom Drawer State ---
  const [isRouteEditorOpen, setIsRouteEditorOpen] = useState(false);
  const [editorVehicleId, setEditorVehicleId] = useState<string>("");
  const [focusedUnassignedOutlet, setFocusedUnassignedOutlet] = useState<PendingOutlet | null>(null);

  const selectedEditorRoute = useMemo(() => {
    if (!editorVehicleId) return assignedRoutes[0] || null;
    return assignedRoutes.find((r) => r.vehicle.NO_KEND === editorVehicleId) || assignedRoutes[0] || null;
  }, [assignedRoutes, editorVehicleId]);

  // Helper to update active result (matrix or ortools)
  function updateActiveResult(newRoutes: AssignedRoute[], newUnassigned: PendingOutlet[]) {
    if (viewingAlgorithm === "matrix") {
      setMatrixResult({ routes: newRoutes, unassigned: newUnassigned });
    } else {
      setOrtoolsResult({ routes: newRoutes, unassigned: newUnassigned });
    }
  }

  // Fast single-vehicle OSRM Re-Order (< 1s)
  async function triggerVehicleReorder(vehicleId: string, currentOutlets: PendingOutlet[]) {
    try {
      const res = await fetch(`${getCvrpApiBase()}/routes/reorder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          depot: { lat: depotCoords.lat, lng: depotCoords.lng },
          vehicle_id: vehicleId,
          outlets: currentOutlets.map((o) => ({
            id: o.custno,
            lat: o.lat,
            lng: o.lng,
            m3: o.total_kubikasi_m3,
            kg: o.total_berat_kg,
            custname: o.custname,
            jns_kend: o.jns_kend,
            allowed_vehicles: o.allowed_vehicles,
            grouppayer: o.grouppayer,
            zone: o.zone,
            kecamatan: o.kecamatan,
            kelurahan: o.kelurahan,
            alamat: o.alamat,
          })),
        }),
      });

      if (!res.ok) {
        throw new Error(`Re-order API error HTTP ${res.status}`);
      }

      const data = await res.json();
      const outletMap = new Map(currentOutlets.map((o) => [o.custno, o]));
      const reorderedList = (data.route as string[])
        .map((id) => outletMap.get(id))
        .filter((o): o is PendingOutlet => o !== undefined);

      const updater = (prevResult: { routes: AssignedRoute[]; unassigned: PendingOutlet[] } | null) => {
        if (!prevResult) return null;
        return {
          ...prevResult,
          routes: prevResult.routes.map((r) => {
            if (r.vehicle.NO_KEND !== vehicleId) return r;
            return {
              ...r,
              outlets: reorderedList,
              currentM3: data.total_m3,
              currentKg: data.total_kg,
              routeGeometry: data.route_geometry ?? r.routeGeometry,
              distanceKm: data.total_distance_km,
              durationSeconds: data.total_duration_s,
            };
          }),
        };
      };

      if (viewingAlgorithm === "matrix") {
        setMatrixResult(updater);
      } else {
        setOrtoolsResult(updater);
      }

      return {
        reorderedList,
        totalM3: data.total_m3,
        totalKg: data.total_kg,
        distanceKm: data.total_distance_km,
        durationSeconds: data.total_duration_s,
        routeGeometry: data.route_geometry,
      };
    } catch (err) {
      console.warn(`[Route Re-order] Failed for ${vehicleId}:`, err);
      return null;
    }
  }

  // 1. Unassign an outlet from a vehicle
  function handleUnassignOutlet(vehicleId: string, custno: string) {
    const route = assignedRoutes.find((r) => r.vehicle.NO_KEND === vehicleId);
    if (!route) return;

    const targetOutlet = route.outlets.find((o) => o.custno === custno);
    if (!targetOutlet) return;

    const remainingOutlets = route.outlets.filter((o) => o.custno !== custno);
    const newRoutes = assignedRoutes.map((r) => {
      if (r.vehicle.NO_KEND !== vehicleId) return r;
      return {
        ...r,
        outlets: remainingOutlets,
        currentM3: Math.max(0, r.currentM3 - targetOutlet.total_kubikasi_m3),
        currentKg: Math.max(0, r.currentKg - targetOutlet.total_berat_kg),
      };
    });

    const newUnassigned = [...unassignedOutlets, targetOutlet];
    updateActiveResult(newRoutes, newUnassigned);

    toast({
      title: "Outlet Unassigned",
      description: `${targetOutlet.custname} returned to unassigned pool`,
    });

    triggerVehicleReorder(vehicleId, remainingOutlets);
  }

  // 2. Open Move / Assign Modal
  function handleOpenMoveModal(outlet: PendingOutlet, sourceVehicle: Vehicle | null) {
    setEditingOutlet(outlet);
    setEditingSourceVehicle(sourceVehicle);
    setEditModalOpen(true);
  }

  // 3. Confirm Move / Assign to Target Vehicle
  function handleConfirmMoveOutlet(targetVehicleId: string) {
    if (!editingOutlet) return;

    const outlet = editingOutlet;
    const sourceVehId = editingSourceVehicle?.NO_KEND ?? null;

    let newRoutes = [...assignedRoutes];
    let newUnassigned = [...unassignedOutlets];

    if (sourceVehId) {
      const sourceRoute = newRoutes.find((r) => r.vehicle.NO_KEND === sourceVehId);
      const remainingInSource = sourceRoute?.outlets.filter((o) => o.custno !== outlet.custno) ?? [];

      newRoutes = newRoutes.map((r) => {
        if (r.vehicle.NO_KEND === sourceVehId) {
          return {
            ...r,
            outlets: remainingInSource,
            currentM3: Math.max(0, r.currentM3 - outlet.total_kubikasi_m3),
            currentKg: Math.max(0, r.currentKg - outlet.total_berat_kg),
          };
        }
        if (r.vehicle.NO_KEND === targetVehicleId) {
          const updatedOutlets = [...r.outlets, outlet];
          return {
            ...r,
            outlets: updatedOutlets,
            currentM3: r.currentM3 + outlet.total_kubikasi_m3,
            currentKg: r.currentKg + outlet.total_berat_kg,
          };
        }
        return r;
      });

      updateActiveResult(newRoutes, newUnassigned);

      toast({
        title: "Outlet Reassigned",
        description: `${outlet.custname} moved from ${sourceVehId} to ${targetVehicleId}`,
      });

      triggerVehicleReorder(sourceVehId, remainingInSource);
      const targetRoute = newRoutes.find((r) => r.vehicle.NO_KEND === targetVehicleId);
      if (targetRoute) {
        triggerVehicleReorder(targetVehicleId, targetRoute.outlets);
      }
    } else {
      newUnassigned = newUnassigned.filter((o) => o.custno !== outlet.custno);

      newRoutes = newRoutes.map((r) => {
        if (r.vehicle.NO_KEND === targetVehicleId) {
          const updatedOutlets = [...r.outlets, outlet];
          return {
            ...r,
            outlets: updatedOutlets,
            currentM3: r.currentM3 + outlet.total_kubikasi_m3,
            currentKg: r.currentKg + outlet.total_berat_kg,
          };
        }
        return r;
      });

      updateActiveResult(newRoutes, newUnassigned);

      toast({
        title: "Outlet Assigned to Fleet",
        description: `${outlet.custname} dispatched to ${targetVehicleId}`,
      });

      const targetRoute = newRoutes.find((r) => r.vehicle.NO_KEND === targetVehicleId);
      if (targetRoute) {
        triggerVehicleReorder(targetVehicleId, targetRoute.outlets);
      }
    }
  }

  // --- Route Editor Drawer Handlers ---
  function handleOpenRouteEditor(vehicleId?: string) {
    if (vehicleId) {
      setEditorVehicleId(vehicleId);
    } else if (assignedRoutes.length > 0) {
      if (!editorVehicleId || !assignedRoutes.some((r) => r.vehicle.NO_KEND === editorVehicleId)) {
        setEditorVehicleId(assignedRoutes[0].vehicle.NO_KEND);
      }
    }
    setIsRouteEditorOpen(true);
  }

  async function handleSaveRouteFromDrawer(
    vehicleId: string,
    assignedOutlets: PendingOutlet[],
    updatedUnassignedPool: PendingOutlet[]
  ) {
    // 1. Immediately update active result state with new assignment & unassigned pool
    const newRoutes = assignedRoutes.map((r) => {
      if (r.vehicle.NO_KEND !== vehicleId) return r;
      return {
        ...r,
        outlets: assignedOutlets,
        currentM3: assignedOutlets.reduce((s, o) => s + (o.total_kubikasi_m3 || 0), 0),
        currentKg: assignedOutlets.reduce((s, o) => s + (o.total_berat_kg || 0), 0),
      };
    });

    updateActiveResult(newRoutes, updatedUnassignedPool);

    // 2. Trigger lightweight OSRM reorder for this vehicle (< 1s)
    const res = await triggerVehicleReorder(vehicleId, assignedOutlets);

    toast({
      title: "Rute Berhasil Dihitung Ulang (OSRM)",
      description: `${vehicleId}: ${res?.reorderedList?.length ?? assignedOutlets.length} stops berhasil diurutkan optimal (${res?.distanceKm?.toFixed(1) ?? 0} km)`,
    });

    // Ensure focused vehicle ID remains active in Route Editor
    setEditorVehicleId(vehicleId);

    return res
      ? { reorderedList: res.reorderedList, distanceKm: res.distanceKm }
      : undefined;
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
      setMatrixResult(null);
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
      setMatrixResult(null);
      setIsDataLoaded(false);
      toast({
        title: "Fleet loaded",
        description: `${vehicles.length} vehicles parsed from ${file.name}`,
      });
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Failed to parse fleet file",
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  // Preview data on map
  function handleLoadData() {
    if (pendingOutlets.length === 0 || availableVehicles.length === 0) return;
    setIsDataLoaded(true);
    setVisibleVehicles(availableVehicles.map((v) => v.NO_KEND));
    // Auto collapse settings widget once loaded so map is clear
    setIsSettingsOpen(false);
    toast({
      title: "Data loaded into view",
      description: `${pendingOutlets.length} outlets ready on map`,
    });
  }

  // Helper for SSE Streaming optimization
  // Helper for SSE Streaming optimization
  async function streamOptimization(
    payload: any,
    onProgress: (stage: string, percent: number, logItem: SolverLogItem) => void
  ) {
    const streamRes = await fetch(`${getCvrpApiBase()}/optimize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, stream: true }),
    });

    if (!streamRes.ok) {
      throw new Error(`AI Optimization service error: HTTP ${streamRes.status}`);
    }

    const contentType = streamRes.headers.get("content-type") || "";
    // If backend or proxy returned standard JSON instead of text/event-stream
    if (contentType.includes("application/json")) {
      const directData = await streamRes.json();
      if (directData && directData.assigned_routes) {
        return directData;
      }
    }

    const reader = streamRes.body?.getReader();
    if (!reader) throw new Error("Unable to read streaming response from backend");

    const decoder = new TextDecoder();
    let optimizedData: any = null;
    let buffer = "";

    const parseChunkLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (trimmed.startsWith("data: ")) {
        try {
          const parsed = JSON.parse(trimmed.slice(6));
          if (parsed.type === "log") {
            onProgress(parsed.stage, parsed.percent, parsed);
          } else if (parsed.type === "result") {
            optimizedData = parsed.data;
          } else if (parsed.type === "error") {
            throw new Error(parsed.message);
          }
        } catch (e: any) {
          if (e?.message && !e.message.includes("JSON")) throw e;
        }
      } else {
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.assigned_routes) {
            optimizedData = parsed;
          }
        } catch {}
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        parseChunkLine(line);
      }
    }

    // Process any remaining text in buffer after stream ends
    if (buffer.trim()) {
      for (const line of buffer.split("\n\n")) {
        parseChunkLine(line);
      }
    }

    // Graceful fallback: If stream closed before result (e.g. Netlify proxy timeout/cutoff),
    // fetch directly via standard non-streaming POST
    if (!optimizedData) {
      onProgress("FALLBACK", 75, {
        time: new Date().toLocaleTimeString("it-IT"),
        stage: "FALLBACK",
        percent: 75,
        message: "Stream selesai tanpa data akhir, mengambil hasil kalkulasi via request langsung...",
        level: "WARN",
      });

      const fallbackRes = await fetch(`${getCvrpApiBase()}/optimize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, stream: false }),
      });

      if (fallbackRes.ok) {
        optimizedData = await fallbackRes.json();
      }
    }

    if (!optimizedData) {
      throw new Error("No optimization result received from backend stream or direct fallback");
    }

    return optimizedData;
  }

  function getTripNumber(vehicleId?: string): number {
    if (!vehicleId) return 1;
    const str = String(vehicleId);
    const matches = str.match(/(?:Trip|Ritase)\s*(\d+)/gi);
    if (!matches || matches.length === 0) return 1;
    let maxTrip = 1;
    for (const m of matches) {
      const numMatch = m.match(/\d+/);
      if (numMatch) {
        const val = parseInt(numMatch[0], 10);
        if (!isNaN(val) && val > maxTrip) {
          maxTrip = val;
        }
      }
    }
    return maxTrip;
  }

  function getBaseVehicleId(vehicleId?: string): string {
    if (!vehicleId) return "";
    return String(vehicleId).replace(/\s*\(?(?:Trip|Ritase)\s*\d+\)?/gi, "").trim();
  }

  function resolveOutlet(id: string, outletMap: Map<string, PendingOutlet>): PendingOutlet | undefined {
    if (outletMap.has(id)) return outletMap.get(id);

    const splitMatch = id.match(/^(.*)_SPLIT_(\d+)$/);
    if (splitMatch) {
      const baseId = splitMatch[1];
      const splitIndex = splitMatch[2];
      const baseOutlet = outletMap.get(baseId);
      if (baseOutlet) {
        const cleanCustName = baseOutlet.custname.replace(/\s*\(Split\s*\d+\)/gi, "").trim();
        return {
          ...baseOutlet,
          custno: id,
          custname: `${cleanCustName} (Split ${splitIndex})`,
          invoices: baseOutlet.invoices.map((inv) => {
            const cleanInvNo = inv.INVNO.replace(/\s*\(Split\s*\d+\)/gi, "").trim();
            return {
              ...inv,
              INVNO: `${cleanInvNo} (Split ${splitIndex})`,
            };
          }),
        };
      }
    }

    return undefined;
  }

  // Auto-Assign via Python CVRP backend
  async function autoAssignRoutes() {
    if (pendingOutlets.length === 0 || availableVehicles.length === 0) {
      setIsSettingsOpen(true);
      return;
    }
    setAssigning(true);
    setAssignStatusText("Initializing AI Solver…");

    setSolverLogs([
      {
        time: new Date().toLocaleTimeString("it-IT"),
        stage: "INIT",
        percent: 5,
        message: `Starting optimization for ${pendingOutlets.length} outlets with ${availableVehicles.length} vehicles (${selectedAlgorithm === "matrix" ? "Matrix ERP" : "Baseline"})...`,
        level: "INFO",
      },
    ]);
    setSolverProgress(5);
    setSolverStage("INIT");
    setIsLogConsoleOpen(true);
    setIsLogConsoleMinimized(false);

    try {
      const useMatrix = selectedAlgorithm === "matrix";
      const payload = {
        depot: { lat: depotCoords.lat, lng: depotCoords.lng },
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
          allowed_vehicles: o.allowed_vehicles,
          grouppayer: o.grouppayer,
          zone: o.zone,
          kecamatan: o.kecamatan,
          kelurahan: o.kelurahan,
          alamat: o.alamat,
        })),
        vehicles: availableVehicles.map((v) => ({
          id: v.NO_KEND,
          max_m3: v.KUBIKASE,
          max_kg: v.TONASE,
          jns_kend: v.JNS_KEND,
          zones: v.ZONES,
          max_grouppayer: v.MAX_GROUPPAYER,
        })),
        algorithm: "ortools",
        max_stops: maxStops > 0 ? maxStops : 40,
        use_matrix_constraints: useMatrix,
        min_epe_threshold: minEpeThreshold > 0 ? minEpeThreshold / 100 : 0.0,
      };

      const optimizedData = await streamOptimization(payload, (stage, percent, logItem) => {
        setSolverLogs((prev) => [...prev, logItem]);
        setSolverProgress(percent);
        setSolverStage(stage);
        setAssignStatusText(`[${stage} ${percent}%] ${logItem.message}`);
      });

      setAssignStatusText("Drawing road networks…");
      setSolverStage("MAP");
      setSolverProgress(97);

      const outletMap = new Map<string, PendingOutlet>(
        pendingOutlets.map((o) => [o.custno, o])
      );
      if (optimizedData.split_outlets) {
        for (const so of optimizedData.split_outlets) {
          const baseId = so.id.replace(/_SPLIT_\d+$/, "");
          const base = outletMap.get(baseId);
          outletMap.set(so.id, {
            ...(base || {}),
            custno: so.id,
            custname: so.custname,
            total_kubikasi_m3: so.m3,
            total_berat_kg: so.kg,
            lat: so.lat,
            lng: so.lng,
            zone: so.zone,
            jns_kend: so.jns_kend,
            allowed_vehicles: so.allowed_vehicles || base?.allowed_vehicles,
            grouppayer: so.grouppayer,
            invoices: (so.invoices || []).map((inv: any) => ({
              CUSTNO: so.id,
              CUSTNAME: so.custname,
              INVNO: inv.invno,
              LATITUDE: so.lat,
              LONGITUDE: so.lng,
              TOTAL_KUBIKASI_M3: inv.m3,
              TOTAL_BERAT_KG: inv.kg,
              TOTAL_KARTON: base?.invoices?.[0]?.TOTAL_KARTON || 0,
              TOTAL_NETO: base?.invoices?.[0]?.TOTAL_NETO || 0,
              KECAMATAN: base?.invoices?.[0]?.KECAMATAN || base?.kecamatan || "",
              KELURAHAN: base?.invoices?.[0]?.KELURAHAN || base?.kelurahan || "",
              ALAMAT: base?.invoices?.[0]?.ALAMAT || base?.alamat || "",
            })),
            alamat: base?.alamat || "",
            kecamatan: base?.kecamatan || "",
            kelurahan: base?.kelurahan || "",
            total_karton: base?.total_karton || 0,
            total_neto: base?.total_neto || 0,
          } as PendingOutlet);
        }
      }
      const vehicleMap = new Map<string, Vehicle>(
        availableVehicles.map((v) => [v.NO_KEND, v])
      );

      const reconstructedRoutes: AssignedRoute[] = await Promise.all(
        optimizedData.assigned_routes.map(async (routeGroup: any, idx: number) => {
          const vehicle = vehicleMap.get(routeGroup.vehicle_id) ?? {
            JNS_KEND: "UNKNOWN",
            NO_KEND: routeGroup.vehicle_id,
            KUBIKASE: routeGroup.total_m3,
            TONASE: routeGroup.total_kg,
          };

          const sweptIds = new Set(routeGroup.cross_zone_swept_outlets || []);
          const orderedOutlets: PendingOutlet[] = routeGroup.route
            .map((id: string) => resolveOutlet(id, outletMap))
            .filter((o: PendingOutlet | undefined): o is PendingOutlet => o !== undefined)
            .map((o: PendingOutlet) => ({
              ...o,
              is_cross_zone_swept: sweptIds.has(o.custno)
            }));

          const rawCoords = [
            `${depotCoords.lng},${depotCoords.lat}`,
            ...orderedOutlets.map((o) => `${o.lng},${o.lat}`),
            `${depotCoords.lng},${depotCoords.lat}`,
          ];
          const coordsString = rawCoords.join(";");

          let routeGeometry: GeoJsonLineString | undefined;
          try {
            const osrmUrl = `${getOsrmApiBase()}/route/v1/driving/${coordsString}?overview=full&geometries=geojson&continue_straight=false`;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3500);
            const osrmRes = await fetch(osrmUrl, { signal: controller.signal });
            clearTimeout(timeoutId);
            if (osrmRes.ok) {
              const osrmData = await osrmRes.json();
              const routeObj = osrmData.routes?.[0];
              if (routeObj) {
                routeGeometry = routeObj.geometry ?? undefined;
              }
            }
          } catch (err) {
            console.warn(`[OSRM] Failed for ${vehicle.NO_KEND}:`, err);
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

      const unassignedList: PendingOutlet[] = optimizedData.unassigned_outlets
        .map((id: string) => resolveOutlet(id, outletMap))
        .filter((o: PendingOutlet | undefined): o is PendingOutlet => o !== undefined);

      const newResult = { routes: reconstructedRoutes, unassigned: unassignedList };
      if (useMatrix) {
        setMatrixResult(newResult);
        setViewingAlgorithm("matrix");
      } else {
        setOrtoolsResult(newResult);
        setViewingAlgorithm("ortools");
      }

      setVisibleVehicles(reconstructedRoutes.map((r) => r.vehicle.NO_KEND));
      setIsLeftPanelOpen(true);

      setSolverProgress(100);
      setSolverStage("DONE");
      setSolverLogs((prev) => [
        ...prev,
        {
          time: new Date().toLocaleTimeString("it-IT"),
          stage: "DONE",
          percent: 100,
          message: `Completed! ${reconstructedRoutes.length} vehicle routes generated. ${unassignedList.length} unassigned.`,
          level: "INFO",
        },
      ]);

      toast({
        title: "AI Routes Optimized",
        description: `${reconstructedRoutes.length} vehicles assigned · ${unassignedList.length} unassigned`,
      });
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Assignment failed",
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setAssigning(false);
      setAssignStatusText("");
    }
  }

  // Assign Next Trip (Trip 2 or Trip 3) for unassigned outlets
  async function assignNextTrip() {
    if (unassignedOutlets.length === 0) return;

    // Detect current maximum trip number in assigned routes
    let computedMaxTrip = 1;
    for (const r of assignedRoutes) {
      const vid = r.vehicle?.NO_KEND || (r as any).vehicle_id || "";
      const trip = getTripNumber(vid);
      if (trip > computedMaxTrip) computedMaxTrip = trip;
    }
    const nextTripNumber = computedMaxTrip + 1;

    if (nextTripNumber > 3) {
      toast({
        variant: "destructive",
        title: "Maximum Ritase Reached",
        description: "All vehicles have completed up to 3 trips. No more ritase can be scheduled.",
      });
      return;
    }

    setSolverLogs([
      {
        time: new Date().toLocaleTimeString("it-IT"),
        stage: "INIT",
        percent: 5,
        message: `Starting Trip ${nextTripNumber} optimization for ${unassignedOutlets.length} pending outlets...`,
        level: "INFO",
      },
    ]);
    setIsLogConsoleOpen(true);
    setIsLogConsoleMinimized(false);
    setAssigning(true);
    setAssignStatusText(`Calculating Trip ${nextTripNumber} dispatch…`);
    setSolverStage("INIT");
    setSolverProgress(5);

    try {
      const SERVICE_TIME_PER_STOP_SEC = 900;       // 15 mins per customer stop
      const DOCK_TURNAROUND_BUFFER_SEC = 2700;     // 45 mins dock turnaround & loading
      const MAX_DRIVER_SHIFT_SEC = 36000;          // 10 hours daily driver shift cap
      const MIN_SAFE_WORKING_SEC = 10800;          // 3 hours minimum remaining buffer

      // Sanitize and deduplicate available base vehicles
      const uniqueBaseVehicles = new Map<string, Vehicle>();
      for (const v of availableVehicles) {
        const cleanBaseId = getBaseVehicleId(v.NO_KEND);
        if (cleanBaseId && !uniqueBaseVehicles.has(cleanBaseId)) {
          uniqueBaseVehicles.set(cleanBaseId, { ...v, NO_KEND: cleanBaseId });
        }
      }

      // Group available physical vehicles by activity
      const idleVehicles: Vehicle[] = [];
      const returningVehicles: { vehicle: Vehicle; completedTrips: number; remainingShiftSec: number }[] = [];

      for (const v of uniqueBaseVehicles.values()) {
        const cleanBaseId = v.NO_KEND;
        const vRoutes = assignedRoutes.filter(
          (r) => getBaseVehicleId(r.vehicle?.NO_KEND || (r as any).vehicle_id || "") === cleanBaseId
        );
        const completedTrips = vRoutes.length;

        if (completedTrips === 0) {
          idleVehicles.push(v);
        } else if (completedTrips < nextTripNumber) {
          const totalAccumSec = vRoutes.reduce((sum, r) => {
            return (
              sum +
              (r.durationSeconds || 0) +
              (r.outlets.length * SERVICE_TIME_PER_STOP_SEC) +
              DOCK_TURNAROUND_BUFFER_SEC
            );
          }, 0);
          const remainingShiftSec = MAX_DRIVER_SHIFT_SEC - totalAccumSec;
          if (remainingShiftSec >= MIN_SAFE_WORKING_SEC) {
            returningVehicles.push({ vehicle: v, completedTrips, remainingShiftSec });
          }
        }
      }

      // Sort returning vehicles by highest remaining working hours first
      returningVehicles.sort((a, b) => b.remainingShiftSec - a.remainingShiftSec);

      // Calculate residual demand & outlet count per zone for next trip
      const zoneDemands: Record<string, { totalM3: number; totalKg: number; totalOutlets: number; requiredTypes: Set<string> }> = {};
      for (const o of unassignedOutlets) {
        const z = o.zone || "UNKNOWN";
        if (!zoneDemands[z]) zoneDemands[z] = { totalM3: 0, totalKg: 0, totalOutlets: 0, requiredTypes: new Set() };
        zoneDemands[z].totalM3 += o.total_kubikasi_m3;
        zoneDemands[z].totalKg += o.total_berat_kg;
        zoneDemands[z].totalOutlets += 1;
        if (o.allowed_vehicles) o.allowed_vehicles.forEach((t) => zoneDemands[z].requiredTypes.add(t));
        else if (o.jns_kend) zoneDemands[z].requiredTypes.add(o.jns_kend);
      }

      const selectedVehicles: Vehicle[] = [];
      const chosenVehicleIds = new Set<string>();

      const canServeZone = (v: Vehicle, zone: string) =>
        !v.ZONES || v.ZONES.length === 0 || v.ZONES.includes("ALL") || v.ZONES.includes(zone);
      const matchesType = (v: Vehicle, types: Set<string>) =>
        types.size === 0 || types.has(v.JNS_KEND) || types.has("TRONTON");

      const vehicleStopLimit = maxStops > 0 ? maxStops : 40;

      for (const [zone, data] of Object.entries(zoneDemands)) {
        let allocatedM3 = 0;
        let allocatedKg = 0;
        let allocatedStops = 0;

        // 1. Prioritize allocating completely idle vehicles (0 prior trips) first
        for (const v of idleVehicles) {
          const cleanBaseId = getBaseVehicleId(v.NO_KEND);
          if (chosenVehicleIds.has(cleanBaseId)) continue;
          if (canServeZone(v, zone) && matchesType(v, data.requiredTypes)) {
            selectedVehicles.push({ ...v, NO_KEND: `${cleanBaseId} (Trip ${nextTripNumber})` });
            chosenVehicleIds.add(cleanBaseId);
            allocatedM3 += v.KUBIKASE;
            allocatedKg += v.TONASE;
            allocatedStops += vehicleStopLimit;

            if (allocatedM3 >= data.totalM3 && allocatedStops >= data.totalOutlets) {
              break;
            }
          }
        }

        // 2. If zone demand or stop count is still not covered, allocate from returning vehicles with >= 3 hrs buffer
        if (allocatedM3 < data.totalM3 || allocatedStops < data.totalOutlets) {
          for (const rv of returningVehicles) {
            const v = rv.vehicle;
            const cleanBaseId = getBaseVehicleId(v.NO_KEND);
            if (chosenVehicleIds.has(cleanBaseId)) continue;
            if (canServeZone(v, zone) && matchesType(v, data.requiredTypes)) {
              selectedVehicles.push({ ...v, NO_KEND: `${cleanBaseId} (Trip ${nextTripNumber})` });
              chosenVehicleIds.add(cleanBaseId);
              allocatedM3 += v.KUBIKASE;
              allocatedKg += v.TONASE;
              allocatedStops += vehicleStopLimit;

              if (allocatedM3 >= data.totalM3 && allocatedStops >= data.totalOutlets) {
                break;
              }
            }
          }
        }
      }

      if (selectedVehicles.length === 0) {
        for (const v of idleVehicles) {
          const cleanBaseId = getBaseVehicleId(v.NO_KEND);
          if (!chosenVehicleIds.has(cleanBaseId)) {
            selectedVehicles.push({ ...v, NO_KEND: `${cleanBaseId} (Trip ${nextTripNumber})` });
            chosenVehicleIds.add(cleanBaseId);
          }
        }
        if (selectedVehicles.length === 0) {
          for (const rv of returningVehicles) {
            const v = rv.vehicle;
            const cleanBaseId = getBaseVehicleId(v.NO_KEND);
            if (!chosenVehicleIds.has(cleanBaseId)) {
              selectedVehicles.push({ ...v, NO_KEND: `${cleanBaseId} (Trip ${nextTripNumber})` });
              chosenVehicleIds.add(cleanBaseId);
            }
          }
        }
      }

      if (selectedVehicles.length === 0) {
        toast({
          variant: "destructive",
          title: "No Eligible Fleet Available",
          description: `No idle vehicles or returning vehicles with ≥ 3h safe working buffer remaining for Trip ${nextTripNumber}.`,
        });
        return;
      }

      const payload = {
        depot: { lat: depotCoords.lat, lng: depotCoords.lng },
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
          allowed_vehicles: o.allowed_vehicles,
          grouppayer: o.grouppayer,
          zone: o.zone,
        })),
        vehicles: selectedVehicles.map((v) => ({
          id: v.NO_KEND,
          max_m3: v.KUBIKASE,
          max_kg: v.TONASE,
          jns_kend: v.JNS_KEND,
          zones: v.ZONES,
          max_grouppayer: v.MAX_GROUPPAYER,
        })),
        algorithm: "ortools",
        max_stops: maxStops > 0 ? maxStops : 40,
        use_matrix_constraints: viewingAlgorithm === "matrix",
        min_epe_threshold: minEpeTrip23Threshold > 0 ? minEpeTrip23Threshold / 100 : 0.50,
      };

      const optimizedData = await streamOptimization(payload, (stage, percent, logItem) => {
        setSolverLogs((prev) => [...prev, logItem]);
        setSolverProgress(percent);
        setSolverStage(stage);
        setAssignStatusText(`[${stage} ${percent}%] ${logItem.message}`);
      });

      setAssignStatusText(`Drawing road networks for Trip ${nextTripNumber}…`);
      setSolverStage("MAP");
      setSolverProgress(97);

      const outletMap = new Map<string, PendingOutlet>(
        unassignedOutlets.map((o) => [o.custno, o])
      );
      if (optimizedData.split_outlets) {
        for (const so of optimizedData.split_outlets) {
          const baseId = so.id.replace(/_SPLIT_\d+$/, "");
          const base = outletMap.get(baseId);
          outletMap.set(so.id, {
            ...(base || {}),
            custno: so.id,
            custname: so.custname,
            total_kubikasi_m3: so.m3,
            total_berat_kg: so.kg,
            lat: so.lat,
            lng: so.lng,
            zone: so.zone,
            jns_kend: so.jns_kend,
            allowed_vehicles: so.allowed_vehicles || base?.allowed_vehicles,
            grouppayer: so.grouppayer,
            invoices: (so.invoices || []).map((inv: any) => ({
              CUSTNO: so.id,
              CUSTNAME: so.custname,
              INVNO: inv.invno,
              LATITUDE: so.lat,
              LONGITUDE: so.lng,
              TOTAL_KUBIKASI_M3: inv.m3,
              TOTAL_BERAT_KG: inv.kg,
              TOTAL_KARTON: base?.invoices?.[0]?.TOTAL_KARTON || 0,
              TOTAL_NETO: base?.invoices?.[0]?.TOTAL_NETO || 0,
              KECAMATAN: base?.invoices?.[0]?.KECAMATAN || base?.kecamatan || "",
              KELURAHAN: base?.invoices?.[0]?.KELURAHAN || base?.kelurahan || "",
              ALAMAT: base?.invoices?.[0]?.ALAMAT || base?.alamat || "",
            })),
            alamat: base?.alamat || "",
            kecamatan: base?.kecamatan || "",
            kelurahan: base?.kelurahan || "",
            total_karton: base?.total_karton || 0,
            total_neto: base?.total_neto || 0,
          } as PendingOutlet);
        }
      }

      const vehicleMap = new Map<string, Vehicle>(
        selectedVehicles.map((v) => [v.NO_KEND, v])
      );
      const colorOffset = assignedRoutes.length;

      const nextTripRoutes: AssignedRoute[] = await Promise.all(
        optimizedData.assigned_routes.map(async (routeGroup: any, idx: number) => {
          const vehicle = vehicleMap.get(routeGroup.vehicle_id) ?? {
            JNS_KEND: "UNKNOWN",
            NO_KEND: routeGroup.vehicle_id,
            KUBIKASE: routeGroup.total_m3,
            TONASE: routeGroup.total_kg,
          };
          const orderedOutlets: PendingOutlet[] = routeGroup.route
            .map((id: string) => resolveOutlet(id, outletMap))
            .filter((o: PendingOutlet | undefined): o is PendingOutlet => o !== undefined);

          const rawCoords = [
            `${depotCoords.lng},${depotCoords.lat}`,
            ...orderedOutlets.map((o) => `${o.lng},${o.lat}`),
            `${depotCoords.lng},${depotCoords.lat}`,
          ];
          const coordsString = rawCoords.join(";");

          let routeGeometry: GeoJsonLineString | undefined;
          try {
            const osrmUrl = `${getOsrmApiBase()}/route/v1/driving/${coordsString}?overview=full&geometries=geojson&continue_straight=false`;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3500);
            const osrmRes = await fetch(osrmUrl, { signal: controller.signal });
            clearTimeout(timeoutId);
            if (osrmRes.ok) {
              const osrmData = await osrmRes.json();
              const routeObj = osrmData.routes?.[0];
              if (routeObj) {
                routeGeometry = routeObj.geometry ?? undefined;
              }
            }
          } catch (err) {
            console.warn(`[OSRM Trip ${nextTripNumber}] ${vehicle.NO_KEND}:`, err);
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

      const newlyAssignedIds = new Set(optimizedData.assigned_routes.flatMap((r: any) => r.route));
      const remainingUnassigned = optimizedData.unassigned_outlets
        ? optimizedData.unassigned_outlets
            .map((id: string) => resolveOutlet(id, outletMap))
            .filter((o: PendingOutlet | undefined): o is PendingOutlet => o !== undefined)
        : unassignedOutlets.filter((o) => !newlyAssignedIds.has(o.custno));

      const updater = (prev: { routes: AssignedRoute[]; unassigned: PendingOutlet[] } | null) => {
        const baseRoutes = prev?.routes ?? assignedRoutes;
        return {
          routes: [...baseRoutes, ...nextTripRoutes],
          unassigned: remainingUnassigned,
        };
      };

      if (viewingAlgorithm === "matrix") {
        setMatrixResult(updater);
      } else {
        setOrtoolsResult(updater);
      }

      setVisibleVehicles((prev) => [...prev, ...nextTripRoutes.map((r) => r.vehicle.NO_KEND)]);
      setSolverProgress(100);
      setSolverStage("DONE");
      toast({
        title: `Trip ${nextTripNumber} assigned`,
        description: `${nextTripRoutes.length} vehicle(s) dispatched, ${remainingUnassigned.length} outlet(s) remaining`,
      });
    } catch (err) {
      toast({
        variant: "destructive",
        title: `Trip ${nextTripNumber} failed`,
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setAssigning(false);
      setAssignStatusText("");
    }
  }

  // Backward compatibility alias
  const assignSecondTrip = assignNextTrip;

  // --- Derived values ---
  const bothLoaded = pendingOutlets.length > 0 && availableVehicles.length > 0;
  const hasRoutes = assignedRoutes.length > 0;
  const hasAnyResult = ortoolsResult !== null || matrixResult !== null;
  const totalInvoices = pendingOutlets.reduce((s, o) => s + o.invoices.length, 0);
  const totalAssignedStops = assignedRoutes.reduce((s, r) => s + r.outlets.length, 0);
  const currentMaxTrip = useMemo(() => {
    if (!assignedRoutes || assignedRoutes.length === 0) return 0;
    let maxTrip = 1;
    for (const r of assignedRoutes) {
      const vid = r.vehicle?.NO_KEND || (r as any).vehicle_id || "";
      const trip = getTripNumber(vid);
      if (trip > maxTrip) maxTrip = trip;
    }
    return maxTrip;
  }, [assignedRoutes]);
  const nextTripNumber = currentMaxTrip + 1;

  // Filtered routes & unassigned
  const filteredRoutes = assignedRoutes.filter((r) => {
    if (!searchFleet) return true;
    const q = searchFleet.toLowerCase();
    return (
      r.vehicle.NO_KEND.toLowerCase().includes(q) ||
      r.vehicle.JNS_KEND.toLowerCase().includes(q)
    );
  });

  const filteredUnassigned = unassignedOutlets.filter((o) => {
    if (!searchUnassigned) return true;
    const q = searchUnassigned.toLowerCase();
    return (
      o.custname.toLowerCase().includes(q) ||
      o.custno.toLowerCase().includes(q) ||
      (o.zone && o.zone.toLowerCase().includes(q))
    );
  });

  // ── Render Clean Light Mode Dashboard ─────────────────────────────────────
  return (
    <div className="relative w-full h-screen overflow-hidden bg-slate-100 text-slate-800 font-sans">

      {/* ════════════ 1. FULL-SCREEN MAP ════════════ */}
      <div className="absolute inset-0 z-0">
        {!hasRoutes && !isDataLoaded ? (
          <div className="flex h-full w-full flex-col items-center justify-center text-slate-400 bg-slate-100">
            <Truck className="mb-3 h-16 w-16 opacity-30 text-blue-600" />
            <p className="text-sm font-semibold text-slate-600">No data loaded yet</p>
            <p className="text-xs text-slate-400 mt-1">Upload Invoices and Fleet files to preview on map</p>
            <Button
              onClick={() => setIsSettingsOpen(true)}
              className="mt-4 bg-blue-600 hover:bg-blue-700 text-white rounded-xl shadow-sm text-xs font-semibold"
            >
              Upload Data
            </Button>
          </div>
        ) : !hasRoutes && isDataLoaded ? (
          <MapRoute
            routes={[]}
            pendingOutlets={pendingOutlets}
            focusedOutlet={focusedOutlet}
            focusedUnassignedOutlet={focusedUnassignedOutlet}
            selectedVehicleRoute={selectedEditorRoute}
            isEditorOpen={isRouteEditorOpen}
            focusedVehicleId={isRouteEditorOpen ? (editorVehicleId || selectedEditorRoute?.vehicle.NO_KEND) : null}
            depotCoords={depotCoords}
          />
        ) : (
          <MapRoute
            routes={assignedRoutes}
            visibleVehicles={visibleVehicles}
            focusedOutlet={focusedOutlet}
            focusedUnassignedOutlet={focusedUnassignedOutlet}
            selectedVehicleRoute={selectedEditorRoute}
            isEditorOpen={isRouteEditorOpen}
            focusedVehicleId={isRouteEditorOpen ? (editorVehicleId || selectedEditorRoute?.vehicle.NO_KEND) : null}
            depotCoords={depotCoords}
          />
        )}
      </div>

      {/* ════════════ 2. FLOATING TOP-RIGHT ACTION DOCK ════════════ */}
      <div className="absolute top-4 right-4 z-[1000] flex items-center gap-1.5 p-1.5 bg-white/90 backdrop-blur-md rounded-2xl border border-slate-200/80 shadow-md">
        {!hasRoutes ? (
          <>
            {!isDataLoaded && bothLoaded && (
              <Button
                onClick={handleLoadData}
                className="bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 text-xs h-8 px-3 rounded-xl shadow-xs font-semibold gap-1.5"
              >
                <Eye className="h-3.5 w-3.5" />
                <span>Load Preview</span>
              </Button>
            )}

            <Button
              onClick={autoAssignRoutes}
              disabled={assigning}
              className="bg-blue-600 hover:bg-blue-700 text-white text-xs h-8 px-3.5 rounded-xl shadow-sm shadow-blue-500/20 font-semibold gap-1.5"
            >
              {assigning ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Zap className="h-3.5 w-3.5" />
              )}
              <span>{assigning ? "Optimizing…" : "Auto-Assign Fleet"}</span>
            </Button>
          </>
        ) : (
          <>
            <Button
              onClick={autoAssignRoutes}
              disabled={assigning}
              variant="outline"
              className="border-slate-200 text-slate-700 hover:bg-slate-50 text-xs h-8 px-3 rounded-xl gap-1.5 font-semibold"
              title="Run optimization again"
            >
              <RotateCcw className="h-3 w-3" />
              <span>Re-Optimize</span>
            </Button>

            {unassignedOutlets.length > 0 && nextTripNumber <= 3 && (
              <Button
                onClick={assignNextTrip}
                disabled={assigning}
                className="bg-indigo-600 hover:bg-indigo-700 text-white text-xs h-8 px-3 rounded-xl shadow-sm text-xs font-semibold gap-1.5"
              >
                <Sparkles className="h-3.5 w-3.5" />
                <span>{`Assign ${nextTripNumber === 2 ? "2nd" : "3rd"} Trip`}</span>
              </Button>
            )}

            {/* Manual Route Editor Drawer Button */}
            <Button
              variant="outline"
              onClick={() => handleOpenRouteEditor()}
              className={`border-slate-200 text-xs h-8 px-3 rounded-xl gap-1.5 font-semibold transition-colors ${
                isRouteEditorOpen
                  ? "bg-blue-50 text-blue-700 border-blue-300 shadow-xs"
                  : "text-slate-700 hover:bg-slate-50"
              }`}
              title="Open Manual Route Editor (Transfer Invoices)"
            >
              <Sliders className="h-3.5 w-3.5 text-blue-600" />
              <span>Route Editor</span>
            </Button>

            <Button
              variant="outline"
              onClick={() => setIsSummaryOpen(true)}
              className="border-slate-200 text-slate-700 hover:bg-slate-50 text-xs h-8 px-3 rounded-xl gap-1.5 font-semibold"
              title="View Fleet Utilization Summary"
            >
              <BarChart2 className="h-3.5 w-3.5 text-blue-600" />
              <span>Utilization</span>
            </Button>
          </>
        )}

        {/* Solver Console Trigger in Floating Dock */}
        {(solverLogs.length > 0 || assigning) && (
          <Button
            variant="outline"
            onClick={() => setIsLogConsoleOpen(!isLogConsoleOpen)}
            className={`border-slate-200 text-xs h-8 px-2.5 rounded-xl gap-1.5 font-semibold transition-colors ${
              isLogConsoleOpen
                ? "bg-blue-50 text-blue-700 border-blue-300"
                : "text-slate-700 hover:bg-slate-50"
            }`}
            title={isLogConsoleOpen ? "Hide Solver Console" : "Open Solver Console"}
          >
            {assigning ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-600" />
            ) : (
              <Terminal className="h-3.5 w-3.5 text-emerald-600" />
            )}
            <span className="hidden sm:inline">Console</span>
            <span className="font-mono text-[10px] font-bold px-1.5 py-0.2 rounded-md bg-blue-50 text-blue-700 border border-blue-200">
              {solverProgress}%
            </span>
          </Button>
        )}

        {/* Settings Toggle */}
        <Button
          variant="outline"
          onClick={() => setIsSettingsOpen(!isSettingsOpen)}
          className={`border-slate-200 text-xs h-8 px-2.5 rounded-xl gap-1.5 transition-colors font-semibold ${
            isSettingsOpen ? "bg-slate-100 text-slate-900 border-slate-300" : "text-slate-600 hover:bg-slate-50"
          }`}
          title="Dispatch Settings & Files"
        >
          <Sliders className="h-3.5 w-3.5 text-slate-600" />
          <span className="hidden sm:inline">Settings</span>
        </Button>
      </div>

      {/* ════════════ 3. LEFT DISPATCH DESK (COLLAPSIBLE FLOATING WIDGET) ════════════ */}
      {!isLeftPanelOpen ? (
        <button
          onClick={() => setIsLeftPanelOpen(true)}
          className="absolute top-4 left-4 z-[1000] flex items-center gap-2 px-3.5 py-2 bg-white/95 backdrop-blur-md border border-slate-200/90 rounded-2xl shadow-lg hover:shadow-xl text-slate-700 hover:text-blue-600 transition-all cursor-pointer text-xs font-bold"
          title="Open Dispatch Desk"
        >
          <Menu className="h-4 w-4" />
          <span>Dispatch Desk</span>
          <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-blue-50 text-blue-700 font-bold border border-blue-200">
            {assignedRoutes.length}
          </span>
          {unassignedOutlets.length > 0 && (
            <span className="h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
          )}
        </button>
      ) : (
        <div className="absolute top-4 bottom-4 left-4 z-[1000] w-88 max-h-[calc(100vh-2rem)] bg-white/95 backdrop-blur-md rounded-2xl border border-slate-200/90 shadow-xl shadow-slate-900/10 overflow-hidden flex flex-col transition-all">
          {/* Panel Header: Brand Title, Client Badge & Live Dispatch Stats */}
          <div className="shrink-0 p-3 bg-white border-b border-slate-100 flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0">
                <div className="p-1.5 rounded-xl bg-blue-600 text-white shadow-xs flex items-center justify-center shrink-0">
                  <Truck className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <h1 className="text-xs font-extrabold text-slate-900 tracking-tight truncate">
                      AI Route Dispatcher
                    </h1>
                    <span
                      className={`text-[9px] font-bold px-1.5 py-0.2 rounded-md border shrink-0 ${
                        selectedAlgorithm === "matrix"
                          ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                          : "bg-blue-50 text-blue-700 border-blue-200"
                      }`}
                    >
                      {selectedAlgorithm === "matrix" ? "Matrix ERP" : "Baseline"}
                    </span>
                  </div>
                  <p className="text-[9.5px] text-slate-400 font-medium leading-none mt-0.5 truncate">
                    Enterprise Fleet Management · Mayora TMS
                  </p>
                </div>
              </div>
              <button
                onClick={() => setIsLeftPanelOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition-colors shrink-0"
                title="Collapse sidebar"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
            </div>

            {/* Status & Pipeline Badges Row */}
            <div className="flex items-center gap-1.5 flex-wrap text-[10px]">
              {!bothLoaded ? (
                <span className="text-slate-400 text-[10px] flex items-center gap-1">
                  <UploadCloud className="h-3 w-3 text-blue-500" />
                  Upload invoices & fleet files in Settings
                </span>
              ) : !hasRoutes ? (
                <>
                  <span className="font-semibold text-slate-700 bg-slate-50 border border-slate-200 px-2 py-0.5 rounded-md">
                    {pendingOutlets.length} Outlets ({totalInvoices} Invoices)
                  </span>
                  <span className="font-semibold text-slate-700 bg-slate-50 border border-slate-200 px-2 py-0.5 rounded-md">
                    {availableVehicles.length} Vehicles
                  </span>
                </>
              ) : (
                <>
                  <span className="font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-md flex items-center gap-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    {assignedRoutes.length} Dispatched ({totalAssignedStops} stops)
                  </span>
                  {unassignedOutlets.length > 0 ? (
                    <span className="font-bold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-md flex items-center gap-1">
                      <AlertTriangle className="h-3 w-3 text-amber-600" />
                      {unassignedOutlets.length} Unassigned
                    </span>
                  ) : (
                    <span className="font-bold text-slate-500 bg-slate-50 border border-slate-200 px-2 py-0.5 rounded-md">
                      0 Unassigned
                    </span>
                  )}
                </>
              )}
            </div>
          </div>

          {/* 2 Tabs: Assigned Fleet vs Unassigned Pool */}
          <div className="px-3 pt-2.5 pb-2 bg-slate-50/60 border-b border-slate-100 shrink-0">
            <div className="flex p-0.5 rounded-xl bg-slate-200/70 text-xs font-semibold">
              <button
                onClick={() => setLeftTab("assigned")}
                className={`flex-1 py-1.5 rounded-lg transition-all text-center flex items-center justify-center gap-1.5 text-xs ${
                  leftTab === "assigned"
                    ? "bg-white text-slate-900 shadow-xs font-bold"
                    : "text-slate-600 hover:text-slate-900 font-medium"
                }`}
              >
                <span>Fleet</span>
                <span
                  className={`px-1.5 py-0.2 rounded-full text-[10px] ${
                    leftTab === "assigned"
                      ? "bg-blue-50 text-blue-700 font-bold"
                      : "bg-slate-200 text-slate-600"
                  }`}
                >
                  {assignedRoutes.length}
                </span>
              </button>
              <button
                onClick={() => setLeftTab("unassigned")}
                className={`flex-1 py-1.5 rounded-lg transition-all text-center flex items-center justify-center gap-1.5 text-xs ${
                  leftTab === "unassigned"
                    ? "bg-white text-amber-900 shadow-xs font-bold"
                    : "text-slate-600 hover:text-slate-900 font-medium"
                }`}
              >
                <span>Unassigned</span>
                <span
                  className={`px-1.5 py-0.2 rounded-full text-[10px] ${
                    unassignedOutlets.length > 0
                      ? "bg-amber-100 text-amber-800 font-bold"
                      : "bg-slate-200 text-slate-600"
                  }`}
                >
                  {unassignedOutlets.length}
                </span>
              </button>
            </div>
          </div>

          {/* TAB 1: Assigned Fleet List */}
          {leftTab === "assigned" && (
            <div className="flex-1 flex flex-col min-h-0">
              {/* Controls bar: search + all/none & segmented control */}
              <div className="p-3 pb-2 flex flex-col gap-2 shrink-0 border-b border-slate-100/80 bg-white">
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <Search className="h-3 w-3 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input
                      type="text"
                      placeholder="Search fleet (plate, type)..."
                      value={searchFleet}
                      onChange={(e) => setSearchFleet(e.target.value)}
                      className="w-full pl-7 pr-2.5 py-1 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-blue-500 focus:bg-white"
                    />
                  </div>
                  {hasRoutes && (
                    <div className="flex items-center gap-0.5 shrink-0 bg-slate-100 p-0.5 rounded-lg border border-slate-200 text-[10px] font-semibold text-slate-600">
                      <button
                        onClick={showAllVehicles}
                        className="px-2 py-0.5 rounded hover:bg-white hover:text-slate-900 hover:shadow-xs transition-all"
                        title="Show all route lines on map"
                      >
                        All
                      </button>
                      <button
                        onClick={hideAllVehicles}
                        className="px-2 py-0.5 rounded hover:bg-white hover:text-slate-900 hover:shadow-xs transition-all"
                        title="Hide all route lines on map"
                      >
                        None
                      </button>
                    </div>
                  )}
                </div>

                {/* Algorithm comparison toggle (if both results exist) */}
                {hasAnyResult && (
                  <div className="flex rounded-lg border border-slate-200 overflow-hidden text-[10px] font-semibold p-0.5 bg-slate-50">
                    <button
                      disabled={!matrixResult}
                      onClick={() => matrixResult && switchView("matrix")}
                      className={`flex-1 py-1 rounded-md transition-all text-center flex items-center justify-center gap-1 ${
                        viewingAlgorithm === "matrix" && matrixResult
                          ? "bg-white text-emerald-800 shadow-xs font-bold border border-emerald-200/50"
                          : matrixResult
                          ? "text-slate-600 hover:text-slate-900"
                          : "text-slate-300 cursor-not-allowed"
                      }`}
                    >
                      <span>Matrix ERP</span>
                      {matrixResult && <span className="text-emerald-600 font-bold">✓</span>}
                    </button>
                    <button
                      disabled={!ortoolsResult}
                      onClick={() => ortoolsResult && switchView("ortools")}
                      className={`flex-1 py-1 rounded-md transition-all text-center flex items-center justify-center gap-1 ${
                        viewingAlgorithm === "ortools" && ortoolsResult
                          ? "bg-white text-blue-800 shadow-xs font-bold border border-blue-200/50"
                          : ortoolsResult
                          ? "text-slate-600 hover:text-slate-900"
                          : "text-slate-300 cursor-not-allowed"
                      }`}
                    >
                      <span>Baseline</span>
                      {ortoolsResult && <span className="text-blue-600 font-bold">✓</span>}
                    </button>
                  </div>
                )}
              </div>

              {/* Vehicle Routes List */}
              <div className="flex-1 overflow-y-auto p-3 space-y-2.5 scrollbar-thin scrollbar-thumb-slate-200">
                {!hasRoutes ? (
                  <div className="flex flex-col items-center justify-center py-12 text-center text-slate-400">
                    <Truck className="mb-2 h-8 w-8 opacity-40 text-blue-500" />
                    <p className="text-xs font-medium text-slate-600">No routes generated</p>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      {isDataLoaded ? 'Click "Auto-Assign Fleet" in dock above' : "Upload files to start dispatch"}
                    </p>
                  </div>
                ) : (
                  filteredRoutes.map((route, idx) => {
                    const isExpanded = !!expandedFleets[route.vehicle.NO_KEND];
                    const isVehicleVisible = visibleVehicles.includes(route.vehicle.NO_KEND);
                    const volPct = route.vehicle.KUBIKASE > 0 ? (route.currentM3 / route.vehicle.KUBIKASE) * 100 : 0;
                    const wtPct = route.vehicle.TONASE > 0 ? (route.currentKg / route.vehicle.TONASE) * 100 : 0;

                    return (
                      <div
                        key={idx}
                        className={`rounded-xl border bg-white shadow-xs overflow-hidden transition-all ${
                          isExpanded
                            ? "border-blue-300 ring-1 ring-blue-200/50 shadow-sm"
                            : "border-slate-200/90 hover:border-slate-300"
                        }`}
                      >
                        {/* Compact Default Card Header */}
                        <div className="p-2.5 cursor-pointer select-none">
                          <div className="flex items-center gap-2">
                            {/* Color index badge */}
                            <span
                              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white shadow-xs"
                              style={{ background: route.color }}
                            >
                              {idx + 1}
                            </span>

                            {/* Plate No & Vehicle Type Pill */}
                            <div
                              className="flex-1 min-w-0"
                              onClick={() => toggleFleet(route.vehicle.NO_KEND)}
                            >
                              <div className="flex items-center gap-1.5">
                                <span className="font-bold text-xs text-slate-900 truncate">
                                  {route.vehicle.NO_KEND}
                                </span>
                                <span className="px-1.5 py-0.2 rounded text-[9.5px] font-bold bg-slate-100 text-slate-700 border border-slate-200 shrink-0">
                                  {route.vehicle.JNS_KEND}
                                </span>
                              </div>
                              <div className="text-[10px] text-slate-500 flex items-center gap-1 mt-0.5 font-medium">
                                <span>{route.outlets.length} stops</span>
                                {(route.distanceKm > 0 || route.durationSeconds > 0) && (
                                  <>
                                    <span>·</span>
                                    <span className="font-semibold text-blue-600">
                                      {formatDistance(route.distanceKm)}
                                    </span>
                                  </>
                                )}
                              </div>
                            </div>

                            {/* Actions: Route Editor, Map Toggle & Chevron */}
                            <div className="flex items-center gap-1 shrink-0">
                              <button
                                className="shrink-0 rounded-lg p-1.5 transition-colors hover:bg-blue-50 text-slate-400 hover:text-blue-600"
                                title="Open in Manual Route Editor (Transfer List)"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleOpenRouteEditor(route.vehicle.NO_KEND);
                                }}
                              >
                                <Sliders className="h-3.5 w-3.5" />
                              </button>

                              <button
                                className="shrink-0 rounded-lg p-1.5 transition-colors hover:bg-slate-100"
                                style={{ color: isVehicleVisible ? route.color : "#94a3b8" }}
                                title={isVehicleVisible ? "Hide route line on map" : "Show route line on map"}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleVehicleVisibility(route.vehicle.NO_KEND);
                                }}
                              >
                                {isVehicleVisible ? (
                                  <Eye className="h-3.5 w-3.5" />
                                ) : (
                                  <EyeOff className="h-3.5 w-3.5" />
                                )}
                              </button>

                              <button
                                onClick={() => toggleFleet(route.vehicle.NO_KEND)}
                                className="shrink-0 rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition-colors"
                                title={isExpanded ? "Collapse details" : "Expand details"}
                              >
                                {isExpanded ? (
                                  <ChevronUp className="h-3.5 w-3.5" />
                                ) : (
                                  <ChevronDown className="h-3.5 w-3.5" />
                                )}
                              </button>
                            </div>
                          </div>

                          {/* Mini Progress Bars (Compact Default View) */}
                          <div
                            className="flex items-center gap-2 mt-2 pt-2 border-t border-slate-100 text-[10px]"
                            onClick={() => toggleFleet(route.vehicle.NO_KEND)}
                          >
                            <div className="flex-1 flex items-center gap-1.5">
                              <span className="text-slate-400 font-semibold text-[9px] uppercase">Vol</span>
                              <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden border border-slate-200/60 shadow-inner">
                                <div
                                  className={`h-full rounded-full transition-all duration-300 ${
                                    volPct > 100
                                      ? "bg-rose-500 animate-pulse"
                                      : volPct >= 80
                                      ? "bg-emerald-500"
                                      : volPct >= 50
                                      ? "bg-amber-500"
                                      : "bg-blue-500"
                                  }`}
                                  style={{ width: `${Math.min(100, volPct)}%` }}
                                />
                              </div>
                              <span className="font-mono text-[9px] font-bold text-slate-600 shrink-0">
                                {volPct.toFixed(0)}%
                              </span>
                            </div>

                            <div className="flex-1 flex items-center gap-1.5">
                              <span className="text-slate-400 font-semibold text-[9px] uppercase">Wt</span>
                              <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden border border-slate-200/60 shadow-inner">
                                <div
                                  className={`h-full rounded-full transition-all duration-300 ${
                                    wtPct > 100
                                      ? "bg-rose-500 animate-pulse"
                                      : wtPct >= 80
                                      ? "bg-emerald-500"
                                      : wtPct >= 50
                                      ? "bg-amber-500"
                                      : "bg-indigo-500"
                                  }`}
                                  style={{ width: `${Math.min(100, wtPct)}%` }}
                                />
                              </div>
                              <span className="font-mono text-[9px] font-bold text-slate-600 shrink-0">
                                {wtPct.toFixed(0)}%
                              </span>
                            </div>
                          </div>
                        </div>

                        {/* Collapsible Accordion Body: Detailed Numeric Breakdown & Outlet Stops */}
                        {isExpanded && (
                          <div className="border-t border-slate-100 bg-slate-50/50">
                            {/* Detailed numeric volume & weight statistics */}
                            <div className="p-2.5 bg-white border-b border-slate-100 space-y-1.5 text-[10.5px]">
                              <div className="flex items-center justify-between">
                                <span className="text-slate-500 font-medium">Volume Payload</span>
                                <span className="font-mono font-bold text-slate-800">
                                  {route.currentM3.toFixed(2)} / {route.vehicle.KUBIKASE} m³ ({volPct.toFixed(0)}%)
                                </span>
                              </div>
                              <div className="flex items-center justify-between">
                                <span className="text-slate-500 font-medium">Weight Payload</span>
                                <span className="font-mono font-bold text-slate-800">
                                  {route.currentKg.toFixed(0)} / {route.vehicle.TONASE} kg ({wtPct.toFixed(0)}%)
                                </span>
                              </div>
                            </div>

                            {/* Outlet Stops List */}
                            <div className="p-2 space-y-1 max-h-64 overflow-y-auto scrollbar-thin scrollbar-thumb-slate-200">
                              {route.outlets.map((outlet, sIdx) => (
                                <div
                                  key={sIdx}
                                  className="group flex items-center gap-2 rounded-lg p-1.5 text-[10.5px] hover:bg-white hover:shadow-xs border border-transparent hover:border-slate-200 cursor-pointer transition-all"
                                  onClick={() =>
                                    setFocusedOutlet({ custno: outlet.custno, lat: outlet.lat, lng: outlet.lng })
                                  }
                                >
                                  <span
                                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[8px] font-bold text-white shadow-xs"
                                    style={{ background: route.color }}
                                  >
                                    {sIdx + 1}
                                  </span>
                                  <div className="min-w-0 flex-1">
                                    <p className="truncate text-slate-800 font-semibold">{outlet.custname}</p>
                                    <p className="text-slate-500 font-mono text-[9.5px]">
                                      {outlet.total_kubikasi_m3.toFixed(2)} m³ · {outlet.total_berat_kg.toFixed(0)} kg
                                    </p>
                                  </div>

                                  {/* Quick Action buttons on hover */}
                                  <div className="opacity-0 group-hover:opacity-100 flex items-center gap-1 transition-opacity shrink-0">
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleOpenMoveModal(outlet, route.vehicle);
                                      }}
                                      title="Reassign to another vehicle"
                                      className="p-1 rounded-md hover:bg-blue-50 text-slate-400 hover:text-blue-600 transition-colors"
                                    >
                                      <ArrowRightLeft className="h-3 w-3" />
                                    </button>
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleUnassignOutlet(route.vehicle.NO_KEND, outlet.custno);
                                      }}
                                      title="Unassign outlet back to pool"
                                      className="p-1 rounded-md hover:bg-rose-50 text-slate-400 hover:text-rose-600 transition-colors"
                                    >
                                      <MinusCircle className="h-3 w-3" />
                                    </button>
                                  </div>
                                </div>
                              ))}
                            </div>

                            {/* Drawer Transfer Trigger inside expanded vehicle card */}
                            <div className="p-2 bg-slate-50 border-t border-slate-100 flex items-center justify-between">
                              <span className="text-[10px] text-slate-500 font-medium">
                                Manual Dual-List Reorder
                              </span>
                              <button
                                onClick={() => handleOpenRouteEditor(route.vehicle.NO_KEND)}
                                className="px-2.5 py-1 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-700 text-[10.5px] font-bold border border-blue-200 flex items-center gap-1.5 transition-colors cursor-pointer"
                              >
                                <Sliders className="h-3 w-3" />
                                <span>Transfer Invoices</span>
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {/* TAB 2: Unassigned Outlets Pool */}
          {leftTab === "unassigned" && (
            <div className="flex-1 flex flex-col min-h-0">
              {/* Unassigned Summary Banner */}
              <div className="p-3 pb-2 border-b border-slate-100 bg-amber-50/40 shrink-0">
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-amber-900">
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
                    <span>{unassignedOutlets.length} Pending Outlets</span>
                  </div>
                  {assignedRoutes.length > 0 && unassignedOutlets.length > 0 && nextTripNumber <= 3 && (
                    <Button
                      onClick={assignNextTrip}
                      disabled={assigning}
                      className="px-2.5 py-1 bg-amber-600 hover:bg-amber-700 text-white text-[10px] font-semibold rounded-lg shadow-xs h-6"
                    >
                      {assigning ? "Computing…" : `Assign ${nextTripNumber === 2 ? "2nd" : "3rd"} Trip`}
                    </Button>
                  )}
                </div>

                <div className="relative">
                  <Search className="h-3 w-3 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    placeholder="Search pending outlet..."
                    value={searchUnassigned}
                    onChange={(e) => setSearchUnassigned(e.target.value)}
                    className="w-full pl-7 pr-2.5 py-1 text-xs bg-white border border-slate-200 rounded-lg text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-amber-500"
                  />
                </div>
              </div>

              {/* Unassigned items list */}
              <div className="flex-1 overflow-y-auto p-3 space-y-1.5 scrollbar-thin scrollbar-thumb-slate-200">
                {unassignedOutlets.length === 0 ? (
                  <div className="py-12 flex flex-col items-center justify-center text-center text-slate-400">
                    <CheckCircle2 className="h-8 w-8 text-emerald-500 mb-2 opacity-80" />
                    <p className="text-xs font-bold text-slate-700">All outlets dispatched!</p>
                    <p className="text-[11px] text-slate-400">0 unassigned outlets remaining</p>
                  </div>
                ) : (
                  filteredUnassigned.map((o, i) => (
                    <div
                      key={i}
                      onMouseEnter={() => setFocusedUnassignedOutlet(o)}
                      onMouseLeave={() => setFocusedUnassignedOutlet(null)}
                      onClick={() => {
                        setFocusedOutlet({ custno: o.custno, lat: o.lat, lng: o.lng });
                        setFocusedUnassignedOutlet(o);
                      }}
                      className="flex items-center justify-between gap-2 p-2 rounded-xl bg-white border border-slate-200 text-[11px] shadow-xs hover:border-amber-300 transition-colors cursor-pointer"
                    >
                      <div className="min-w-0 flex-1 truncate">
                        <p className="truncate text-slate-900 font-bold">{o.custname}</p>
                        <p className="text-[10px] text-slate-500 font-mono">
                          {o.total_kubikasi_m3.toFixed(2)} m³ · {o.total_berat_kg.toFixed(0)} kg {o.zone ? `· ${o.zone}` : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleOpenRouteEditor();
                            setFocusedUnassignedOutlet(o);
                          }}
                          title="Open in Transfer Editor Drawer"
                          className="p-1 rounded-lg hover:bg-blue-50 text-slate-400 hover:text-blue-600 transition-colors"
                        >
                          <Sliders className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleOpenMoveModal(o, null);
                          }}
                          title="Assign to active vehicle"
                          className="px-2 py-1 rounded-lg bg-blue-50 text-blue-700 hover:bg-blue-600 hover:text-white text-[10px] font-bold border border-blue-200 flex items-center gap-1 transition-colors cursor-pointer"
                        >
                          <PlusCircle className="h-3 w-3" />
                          Assign
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ════════════ 4. RIGHT SETTINGS & UPLOADS WIDGET (COLLAPSIBLE FLOATING) ════════════ */}
      {isSettingsOpen && (
        <div className="absolute top-16 right-4 z-[1000] w-80 bg-white/95 backdrop-blur-md rounded-2xl border border-slate-200 shadow-2xl p-4 flex flex-col gap-3.5 animate-in fade-in slide-in-from-top-2 duration-200">
          <div className="flex items-center justify-between pb-2 border-b border-slate-100">
            <div className="flex items-center gap-2">
              <Sliders className="h-4 w-4 text-blue-600" />
              <h4 className="text-xs font-bold text-slate-900">Dispatch Configuration</h4>
            </div>
            <button
              onClick={() => setIsSettingsOpen(false)}
              className="p-1 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition-colors"
              title="Close settings"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* File Uploads Dropzones */}
          <div className="space-y-2">
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
              📁 Input Data (Excel / CSV)
            </p>

            <input ref={invoiceInputRef} type="file" accept=".csv,.xls,.xlsx" className="hidden" onChange={handleInvoiceFile} />
            <button
              onClick={() => invoiceInputRef.current?.click()}
              className={`flex w-full items-center gap-2.5 rounded-xl border-2 border-dashed p-2.5 text-left transition-all cursor-pointer ${
                pendingOutlets.length > 0
                  ? "border-blue-300 bg-blue-50/50"
                  : "border-slate-200 hover:border-blue-400 hover:bg-slate-50"
              }`}
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-100 text-blue-700">
                <FileSpreadsheet className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-bold text-slate-800">
                  {invoiceFileName ?? "1. Upload Invoices (Excel)"}
                </p>
                <p className="text-[10px] text-slate-500">
                  {pendingOutlets.length > 0
                    ? `✓ ${pendingOutlets.length} outlets · ${totalInvoices} invoices`
                    : "Sales invoices, m³, kg, lat/lng"}
                </p>
              </div>
              <UploadCloud className="h-4 w-4 shrink-0 text-slate-400" />
            </button>

            <input ref={vehicleInputRef} type="file" accept=".csv,.xls,.xlsx" className="hidden" onChange={handleVehicleFile} />
            <button
              onClick={() => vehicleInputRef.current?.click()}
              className={`flex w-full items-center gap-2.5 rounded-xl border-2 border-dashed p-2.5 text-left transition-all cursor-pointer ${
                availableVehicles.length > 0
                  ? "border-emerald-300 bg-emerald-50/50"
                  : "border-slate-200 hover:border-emerald-400 hover:bg-slate-50"
              }`}
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700">
                <Truck className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-bold text-slate-800">
                  {vehicleFileName ?? "2. Upload Fleet (Excel)"}
                </p>
                <p className="text-[10px] text-slate-500">
                  {availableVehicles.length > 0
                    ? `✓ ${availableVehicles.length} vehicles active`
                    : "Vehicles, m³, kg capacity"}
                </p>
              </div>
              <UploadCloud className="h-4 w-4 shrink-0 text-slate-400" />
            </button>
          </div>

          {/* Depot Location Input */}
          <div className="space-y-1.5 pt-2 border-t border-slate-100">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                📍 Depot Coordinates
              </span>
              <button
                type="button"
                onClick={() => {
                  setDepotCoords(DEPOT_COORDS);
                  setDepotLatStr(String(DEPOT_COORDS.lat));
                  setDepotLngStr(String(DEPOT_COORDS.lng));
                  try {
                    localStorage.setItem("cvrp_depot_coords", JSON.stringify(DEPOT_COORDS));
                  } catch {}
                }}
                className="text-[10px] font-semibold text-blue-600 hover:text-blue-800 transition-colors cursor-pointer"
                title="Reset to default depot coordinates"
              >
                Reset Default
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] font-semibold text-slate-500 mb-0.5 block">Latitude</label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={depotLatStr}
                  onChange={(e) => {
                    const text = e.target.value;
                    setDepotLatStr(text);
                    const parsed = parseFloat(text);
                    if (!isNaN(parsed) && parsed >= -90 && parsed <= 90) {
                      setDepotCoords((prev) => {
                        const updated = { ...prev, lat: parsed };
                        try {
                          localStorage.setItem("cvrp_depot_coords", JSON.stringify(updated));
                        } catch {}
                        return updated;
                      });
                    }
                  }}
                  onBlur={() => {
                    const parsed = parseFloat(depotLatStr);
                    if (isNaN(parsed) || parsed < -90 || parsed > 90) {
                      setDepotLatStr(String(depotCoords.lat));
                    }
                  }}
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-800 font-mono outline-none focus:border-blue-500 focus:bg-white"
                  placeholder="-6.224696"
                />
              </div>
              <div>
                <label className="text-[10px] font-semibold text-slate-500 mb-0.5 block">Longitude</label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={depotLngStr}
                  onChange={(e) => {
                    const text = e.target.value;
                    setDepotLngStr(text);
                    const parsed = parseFloat(text);
                    if (!isNaN(parsed) && parsed >= -180 && parsed <= 180) {
                      setDepotCoords((prev) => {
                        const updated = { ...prev, lng: parsed };
                        try {
                          localStorage.setItem("cvrp_depot_coords", JSON.stringify(updated));
                        } catch {}
                        return updated;
                      });
                    }
                  }}
                  onBlur={() => {
                    const parsed = parseFloat(depotLngStr);
                    if (isNaN(parsed) || parsed < -180 || parsed > 180) {
                      setDepotLngStr(String(depotCoords.lng));
                    }
                  }}
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-800 font-mono outline-none focus:border-blue-500 focus:bg-white"
                  placeholder="106.523337"
                />
              </div>
            </div>
            <p className="text-[10px] text-slate-500 leading-tight">
              Koordinat titik awal dan akhir rute armada (DC / Gudang).
            </p>
          </div>

          {/* Operational Constraints Mode Selector */}
          <div className="space-y-1.5 pt-2 border-t border-slate-100">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                ⚙️ Operational Rules
              </span>
              <span
                className={`text-[9px] font-bold px-1.5 py-0.2 rounded-full ${
                  selectedAlgorithm === "matrix"
                    ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                    : "bg-slate-100 text-slate-600"
                }`}
              >
                {selectedAlgorithm === "matrix" ? "Matrix ERP ON" : "Baseline OFF"}
              </span>
            </div>

            <div className="flex rounded-xl border border-slate-200 overflow-hidden text-xs font-semibold p-0.5 bg-slate-100">
              <button
                type="button"
                className={`flex-1 py-1 rounded-lg transition-all text-center ${
                  selectedAlgorithm === "matrix"
                    ? "bg-white text-emerald-800 shadow-xs"
                    : "text-slate-600 hover:text-slate-900"
                }`}
                onClick={() => setSelectedAlgorithm("matrix")}
              >
                Matrix ERP
              </button>
              <button
                type="button"
                className={`flex-1 py-1 rounded-lg transition-all text-center ${
                  selectedAlgorithm === "ortools"
                    ? "bg-white text-blue-800 shadow-xs"
                    : "text-slate-600 hover:text-slate-900"
                }`}
                onClick={() => setSelectedAlgorithm("ortools")}
              >
                Baseline
              </button>
            </div>
            <p className="text-[10px] text-slate-500 leading-tight">
              {selectedAlgorithm === "matrix"
                ? "✓ Gang Sempit lock · Zone match · GroupPayer"
                : "Algorithmic capacity & distance minimization only"}
            </p>
          </div>

          {/* Max Stops per Vehicle */}
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-slate-400">
              <span>Max Stops per Vehicle</span>
              <span className="text-slate-700 font-mono">{maxStops} stops</span>
            </div>
            <input
              type="number"
              min={1}
              max={500}
              value={maxStops === 0 ? "" : maxStops}
              onChange={(e) => {
                const val = e.target.value;
                if (val === "") {
                  setMaxStops(0);
                  return;
                }
                const v = parseInt(val, 10);
                if (!isNaN(v) && v >= 0 && v <= 500) setMaxStops(v);
              }}
              onBlur={() => {
                if (maxStops < 1) setMaxStops(40);
              }}
              className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-800 font-mono outline-none focus:border-blue-500 focus:bg-white"
            />
          </div>

          {/* Min EPE Threshold (%) for Trip 1 */}
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-slate-400">
              <span>Min EPE Threshold (%)</span>
              <span className="text-amber-700 font-mono font-bold">
                {minEpeThreshold > 0 ? `≥ ${minEpeThreshold}%` : "Off"}
              </span>
            </div>
            <input
              type="number"
              min={0}
              max={100}
              value={minEpeThreshold === 0 ? "" : minEpeThreshold}
              onChange={(e) => {
                const val = e.target.value;
                if (val === "") {
                  setMinEpeThreshold(0);
                  return;
                }
                const v = parseInt(val, 10);
                if (!isNaN(v) && v >= 0 && v <= 100) setMinEpeThreshold(v);
              }}
              onBlur={() => {
                if (minEpeThreshold < 0) setMinEpeThreshold(0);
              }}
              className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-800 font-mono outline-none focus:border-amber-500 focus:bg-white"
            />
            <p className="text-[10px] text-slate-500 leading-tight">
              Rute Ritase 1 di bawah {minEpeThreshold}% otomatis dialihkan ke Ritase 2.
            </p>
          </div>

          {/* Min EPE Threshold (%) for Trip 2 & 3 */}
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-slate-400">
              <span>Min EPE Ritase 2 & 3 (%)</span>
              <span className="text-amber-700 font-mono font-bold">
                {minEpeTrip23Threshold > 0 ? `≥ ${minEpeTrip23Threshold}%` : "Off"}
              </span>
            </div>
            <input
              type="number"
              min={0}
              max={100}
              value={minEpeTrip23Threshold === 0 ? "" : minEpeTrip23Threshold}
              onChange={(e) => {
                const val = e.target.value;
                if (val === "") {
                  setMinEpeTrip23Threshold(0);
                  return;
                }
                const v = parseInt(val, 10);
                if (!isNaN(v) && v >= 0 && v <= 100) setMinEpeTrip23Threshold(v);
              }}
              onBlur={() => {
                if (minEpeTrip23Threshold < 0) setMinEpeTrip23Threshold(0);
              }}
              className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-800 font-mono outline-none focus:border-amber-500 focus:bg-white"
            />
            <p className="text-[10px] text-slate-500 leading-tight">
              Rute Ritase 2 & 3 di bawah {minEpeTrip23Threshold}% otomatis di-prune ke unassigned pool.
            </p>
          </div>
        </div>
      )}

      {/* ════════════ 5. REOPEN FLOATING PILL (DOCKED BOTTOM-RIGHT) ════════════ */}
      {!isLogConsoleOpen && (solverLogs.length > 0 || assigning) && (
        <button
          onClick={() => setIsLogConsoleOpen(true)}
          className="fixed bottom-5 right-5 z-[2000] flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-white/95 hover:bg-slate-50 border border-slate-200/90 shadow-xl text-xs text-slate-700 transition-all backdrop-blur-md cursor-pointer font-bold hover:shadow-2xl hover:border-slate-300"
          title="Open AI Solver Console"
        >
          {assigning ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-600" />
          ) : (
            <Terminal className="h-3.5 w-3.5 text-emerald-600" />
          )}
          <span>{assigning ? "Solving Pipeline..." : "Solver Console"}</span>
          <span className="font-mono text-[10px] font-bold px-1.5 py-0.2 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
            {solverProgress}%
          </span>
        </button>
      )}

      {/* ════════════ 6. REAL-TIME SOLVER CONSOLE MODAL ════════════ */}
      <SolverConsoleModal
        isOpen={isLogConsoleOpen}
        onClose={() => setIsLogConsoleOpen(false)}
        isMinimized={isLogConsoleMinimized}
        onToggleMinimize={() => setIsLogConsoleMinimized(!isLogConsoleMinimized)}
        logs={solverLogs}
        progress={solverProgress}
        currentStage={solverStage}
        isSolving={assigning}
        onClearLogs={() => setSolverLogs([])}
      />

      {/* ════════════ 7. FLEET UTILIZATION SUMMARY MODAL ════════════ */}
      {isSummaryOpen && (
        <FleetSummaryTable
          routes={assignedRoutes}
          algorithm={viewingAlgorithm}
          onClose={() => setIsSummaryOpen(false)}
        />
      )}

      {/* ════════════ 8. HUMAN-IN-THE-LOOP ROUTE EDIT MODAL ════════════ */}
      <RouteEditModal
        isOpen={editModalOpen}
        onClose={() => setEditModalOpen(false)}
        outlet={editingOutlet}
        sourceVehicle={editingSourceVehicle}
        routes={assignedRoutes}
        onConfirmMove={handleConfirmMoveOutlet}
      />

      {/* ════════════ 9. MANUAL ROUTE EDITOR BOTTOM DRAWER ════════════ */}
      <RouteEditorDrawer
        isOpen={isRouteEditorOpen}
        onClose={() => {
          setIsRouteEditorOpen(false);
          setFocusedUnassignedOutlet(null);
        }}
        routes={assignedRoutes}
        selectedVehicleId={editorVehicleId || assignedRoutes[0]?.vehicle.NO_KEND || ""}
        onSelectVehicleId={(vId) => setEditorVehicleId(vId)}
        unassignedPool={unassignedOutlets}
        onSaveRoute={handleSaveRouteFromDrawer}
        onHoverUnassignedOutlet={(outlet) => setFocusedUnassignedOutlet(outlet)}
        onClickUnassignedOutlet={(outlet) => {
          setFocusedOutlet({ custno: outlet.custno, lat: outlet.lat, lng: outlet.lng });
          setFocusedUnassignedOutlet(outlet);
        }}
      />

    </div>
  );
}
