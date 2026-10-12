"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import type { AssignedRoute, Vehicle } from "@/lib/types";
import {
  X,
  Printer,
  Truck,
  CheckCircle2,
  Clock,
  Search,
  CheckSquare,
  Square,
  MinusSquare,
  Filter,
  BarChart2,
  Layers,
  AlertCircle,
  Copy,
  Check,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function pct(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return (numerator / denominator) * 100;
}

function fmtNum(n: number): string {
  return n.toFixed(2);
}

function fmtPct(n: number): string {
  return n.toFixed(2) + "%";
}

function maxEpeColor(p: number): string {
  if (p >= 80) return "text-emerald-700 bg-emerald-50 border border-emerald-200";
  if (p >= 60) return "text-amber-700 bg-amber-50 border border-amber-200";
  return "text-rose-700 bg-rose-50 border border-rose-200";
}

function getBaseVehicleId(vehicleId?: string): string {
  if (!vehicleId) return "";
  return String(vehicleId).replace(/\s*\(?(?:Trip|Ritase)\s*\d+\)?/gi, "").trim();
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

// ---------------------------------------------------------------------------
// Row Types
// ---------------------------------------------------------------------------
interface RouteSummaryRow {
  recapNo: string;
  hasValidRecap: boolean;
  noKend: string;
  baseNoKend: string;
  tripNo: number;
  jenis: string;
  outlets: number;
  kubikasi: number;
  stdKubik: number;
  pctKubik: number;
  tonase: number;
  stdTonase: number;
  pctTonase: number;
  pctMaxEpe: number;
  color: string;
}

interface MasterFleetSummaryRow {
  noKend: string;
  jenis: string;
  ritaseCount: number;
  assignedRecaps: string[];
  totalKubikasi: number;
  stdKubik: number;
  pctKubikHarian: number;
  totalTonase: number;
  stdTonase: number;
  pctTonaseHarian: number;
  status: "Aktif" | "Standby";
  activeRoutesCount: number;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------
function buildRouteRows(routes: AssignedRoute[]): RouteSummaryRow[] {
  return routes.map((r) => {
    const pctKubik = pct(r.currentM3, r.vehicle.KUBIKASE);
    const pctTonase = pct(r.currentKg, r.vehicle.TONASE);
    const recapNo = r.recap_no?.trim() || "";
    const hasValidRecap = recapNo.length > 0 && recapNo !== "-";

    return {
      recapNo: hasValidRecap ? recapNo : "-",
      hasValidRecap,
      noKend: r.vehicle.NO_KEND,
      baseNoKend: getBaseVehicleId(r.vehicle.NO_KEND),
      tripNo: getTripNumber(r.vehicle.NO_KEND),
      jenis: r.vehicle.JNS_KEND,
      outlets: r.outlets.length,
      kubikasi: r.currentM3,
      stdKubik: r.vehicle.KUBIKASE,
      pctKubik,
      tonase: r.currentKg,
      stdTonase: r.vehicle.TONASE,
      pctTonase,
      pctMaxEpe: Math.max(pctKubik, pctTonase),
      color: r.color,
    };
  });
}

function buildMasterFleetRows(
  allVehicles: Vehicle[] | undefined,
  routes: AssignedRoute[]
): MasterFleetSummaryRow[] {
  // Map routes by cleaned base vehicle plate
  const routesByBaseVehicle = new Map<string, AssignedRoute[]>();
  for (const r of routes) {
    const baseId = getBaseVehicleId(r.vehicle.NO_KEND).toUpperCase();
    if (!routesByBaseVehicle.has(baseId)) {
      routesByBaseVehicle.set(baseId, []);
    }
    routesByBaseVehicle.get(baseId)!.push(r);
  }

  // Combine master vehicles with any vehicles existing in routes
  const masterMap = new Map<string, { noKend: string; jenis: string; stdKubik: number; stdTonase: number }>();

  if (allVehicles && allVehicles.length > 0) {
    for (const v of allVehicles) {
      const key = v.NO_KEND.trim().toUpperCase();
      masterMap.set(key, {
        noKend: v.NO_KEND.trim(),
        jenis: v.JNS_KEND,
        stdKubik: v.KUBIKASE || 0,
        stdTonase: v.TONASE || 0,
      });
    }
  }

  // Ensure any vehicle active in routes is also present in master list
  for (const r of routes) {
    const baseId = getBaseVehicleId(r.vehicle.NO_KEND).trim();
    const key = baseId.toUpperCase();
    if (!masterMap.has(key)) {
      masterMap.set(key, {
        noKend: baseId,
        jenis: r.vehicle.JNS_KEND,
        stdKubik: r.vehicle.KUBIKASE || 0,
        stdTonase: r.vehicle.TONASE || 0,
      });
    }
  }

  const result: MasterFleetSummaryRow[] = [];

  for (const [, vInfo] of masterMap.entries()) {
    const matchingRoutes = routesByBaseVehicle.get(vInfo.noKend.toUpperCase()) || [];
    const ritaseCount = matchingRoutes.length;
    const assignedRecaps = matchingRoutes
      .map((r) => r.recap_no?.trim())
      .filter((rec): rec is string => Boolean(rec && rec !== "-"));

    const totalKubikasi = matchingRoutes.reduce((sum, r) => sum + r.currentM3, 0);
    const totalTonase = matchingRoutes.reduce((sum, r) => sum + r.currentKg, 0);

    const pctKubikHarian = pct(totalKubikasi, vInfo.stdKubik);
    const pctTonaseHarian = pct(totalTonase, vInfo.stdTonase);
    const status: "Aktif" | "Standby" = ritaseCount > 0 ? "Aktif" : "Standby";

    result.push({
      noKend: vInfo.noKend,
      jenis: vInfo.jenis,
      ritaseCount,
      assignedRecaps,
      totalKubikasi,
      stdKubik: vInfo.stdKubik,
      pctKubikHarian,
      totalTonase,
      stdTonase: vInfo.stdTonase,
      pctTonaseHarian,
      status,
      activeRoutesCount: matchingRoutes.length,
    });
  }

  // Sort: Aktif first, then by ritaseCount desc, then by noKend asc
  return result.sort((a, b) => {
    if (a.status !== b.status) {
      return a.status === "Aktif" ? -1 : 1;
    }
    if (b.ritaseCount !== a.ritaseCount) {
      return b.ritaseCount - a.ritaseCount;
    }
    return a.noKend.localeCompare(b.noKend);
  });
}

// ---------------------------------------------------------------------------
// Global Stats
// ---------------------------------------------------------------------------
interface RouteGlobalStats {
  totalOutlet: number;
  totalFaktur: number;
  totalKendaraan: number;
  totalKubikasi: number;
  avgPctKubik: number;
  avgPctTonase: number;
  avgPctEpe: number;
}

function buildRouteGlobalStats(routes: AssignedRoute[], rows: RouteSummaryRow[]): RouteGlobalStats {
  const totalOutlet = rows.reduce((s, r) => s + r.outlets, 0);
  const totalFaktur = routes.reduce(
    (s, r) => s + r.outlets.reduce((si, o) => si + o.invoices.length, 0),
    0
  );
  const totalKendaraan = routes.length;
  const totalKubikasi = rows.reduce((s, r) => s + r.kubikasi, 0);
  const avgPctKubik =
    rows.length > 0 ? rows.reduce((s, r) => s + r.pctKubik, 0) / rows.length : 0;
  const avgPctTonase =
    rows.length > 0 ? rows.reduce((s, r) => s + r.pctTonase, 0) / rows.length : 0;
  const avgPctEpe =
    rows.length > 0 ? rows.reduce((s, r) => s + r.pctMaxEpe, 0) / rows.length : 0;

  return {
    totalOutlet,
    totalFaktur,
    totalKendaraan,
    totalKubikasi,
    avgPctKubik,
    avgPctTonase,
    avgPctEpe,
  };
}

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------
function StatCard({
  label,
  value,
  valueClass,
  subLabel,
}: {
  label: string;
  value: string;
  valueClass?: string;
  subLabel?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-xl bg-slate-50 px-3.5 py-2.5 border border-slate-200 shadow-2xs">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        {label}
      </p>
      <p className={`text-sm font-bold font-mono ${valueClass ?? "text-slate-800"}`}>
        {value}
      </p>
      {subLabel && <p className="text-[9.5px] text-slate-400 font-medium">{subLabel}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------
export interface FleetSummaryTableProps {
  routes: AssignedRoute[];
  allVehicles?: Vehicle[];
  algorithm: "matrix" | "ortools" | "pyhygese";
  onClose: () => void;
  onBatchPrint?: (selectedRecapNos: string[]) => void;
  initialTab?: "routes" | "master";
}

export default function FleetSummaryTable({
  routes,
  allVehicles = [],
  algorithm,
  onClose,
  onBatchPrint,
  initialTab = "routes",
}: FleetSummaryTableProps) {
  // Tab view: "routes" = Formed routes + Batch print; "master" = All fleet utilization
  const [activeTab, setActiveTab] = useState<"routes" | "master">(initialTab);

  // Search filter
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "standby">("all");

  // Multi-select state for Batch Print (array of 8-digit recap_no strings)
  const [selectedRecapNos, setSelectedRecapNos] = useState<string[]>([]);
  const [isPrinting, setIsPrinting] = useState(false);
  const [printSuccessNotice, setPrintSuccessNotice] = useState<string | null>(null);

  // Header checkbox ref for indeterminate state
  const selectAllCheckboxRef = useRef<HTMLInputElement>(null);

  // Data transformations
  const routeRows = useMemo(() => buildRouteRows(routes), [routes]);
  const masterRows = useMemo(
    () => buildMasterFleetRows(allVehicles, routes),
    [allVehicles, routes]
  );
  const routeStats = useMemo(() => buildRouteGlobalStats(routes, routeRows), [routes, routeRows]);

  // Valid recap numbers available for batch print
  const printableRecapNos = useMemo(() => {
    return routeRows.filter((r) => r.hasValidRecap).map((r) => r.recapNo);
  }, [routeRows]);

  // Filtered route rows based on search
  const filteredRouteRows = useMemo(() => {
    if (!searchQuery.trim()) return routeRows;
    const q = searchQuery.toLowerCase().trim();
    return routeRows.filter(
      (r) =>
        r.noKend.toLowerCase().includes(q) ||
        r.recapNo.toLowerCase().includes(q) ||
        r.jenis.toLowerCase().includes(q)
    );
  }, [routeRows, searchQuery]);

  // Filtered master rows based on search and status
  const filteredMasterRows = useMemo(() => {
    return masterRows.filter((r) => {
      const matchSearch =
        !searchQuery.trim() ||
        r.noKend.toLowerCase().includes(searchQuery.toLowerCase().trim()) ||
        r.jenis.toLowerCase().includes(searchQuery.toLowerCase().trim()) ||
        r.assignedRecaps.some((rec) => rec.toLowerCase().includes(searchQuery.toLowerCase().trim()));

      const matchStatus =
        statusFilter === "all" ||
        (statusFilter === "active" && r.status === "Aktif") ||
        (statusFilter === "standby" && r.status === "Standby");

      return matchSearch && matchStatus;
    });
  }, [masterRows, searchQuery, statusFilter]);

  // Select-All checkbox state handling
  const allPrintableSelected =
    printableRecapNos.length > 0 &&
    printableRecapNos.every((recap) => selectedRecapNos.includes(recap));
  const somePrintableSelected =
    selectedRecapNos.length > 0 && !allPrintableSelected;

  useEffect(() => {
    if (selectAllCheckboxRef.current) {
      selectAllCheckboxRef.current.indeterminate = somePrintableSelected;
    }
  }, [somePrintableSelected]);

  // Handlers for Checkbox Multi-Select
  const handleToggleSelectAll = () => {
    if (allPrintableSelected) {
      // Uncheck all
      setSelectedRecapNos([]);
    } else {
      // Select all printable recaps
      setSelectedRecapNos([...printableRecapNos]);
    }
  };

  const handleToggleOne = (recapNo: string) => {
    if (!recapNo || recapNo === "-") return;
    setSelectedRecapNos((prev) => {
      if (prev.includes(recapNo)) {
        return prev.filter((id) => id !== recapNo);
      } else {
        return [...prev, recapNo];
      }
    });
  };

  // Batch Print Mock Handler
  const handleBatchPrint = (recapNosToPrint: string[] = selectedRecapNos) => {
    if (recapNosToPrint.length === 0) {
      alert("Silakan pilih minimal 1 rute dengan nomor rekap yang valid untuk di-print!");
      return;
    }

    setIsPrinting(true);

    // If external onBatchPrint handler provided, invoke it
    if (onBatchPrint) {
      onBatchPrint(recapNosToPrint);
    } else {
      // Internal default mock print service
      console.log("[BATCH PRINT DISPATCH] Mengirim nomor rekap ke Print Service:", recapNosToPrint);
    }

    // Visual feedback
    setPrintSuccessNotice(
      `Berhasil mengirim ${recapNosToPrint.length} Rekap ke antrean printer: ${recapNosToPrint.join(", ")}`
    );

    setTimeout(() => {
      setIsPrinting(false);
    }, 600);

    // Auto dismiss notice after 5 seconds
    setTimeout(() => {
      setPrintSuccessNotice(null);
    }, 5000);
  };

  // Master fleet global summary calculations
  const totalMasterArmada = masterRows.length;
  const totalArmadaAktif = masterRows.filter((r) => r.status === "Aktif").length;
  const totalArmadaStandby = masterRows.filter((r) => r.status === "Standby").length;
  const totalRitaseHariIni = masterRows.reduce((acc, r) => acc + r.ritaseCount, 0);
  const totalKubikasiHarian = masterRows.reduce((acc, r) => acc + r.totalKubikasi, 0);
  const totalTonaseHarian = masterRows.reduce((acc, r) => acc + r.totalTonase, 0);

  const algoLabel =
    algorithm === "matrix"
      ? "OR-Tools (Matrix ERP)"
      : algorithm === "ortools"
      ? "OR-Tools (Baseline)"
      : "HGS-CVRP";

  return (
    <div
      className="fixed inset-0 z-[2000] flex items-center justify-center bg-slate-900/50 backdrop-blur-xs p-3 md:p-6 animate-in fade-in duration-200"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Dialog Window */}
      <div className="relative w-full max-w-[96vw] max-h-[92vh] flex flex-col bg-white border border-slate-200/90 rounded-2xl shadow-2xl overflow-hidden animate-in zoom-in-95 duration-150">
        
        {/* Top Notification Banner if batch printed */}
        {printSuccessNotice && (
          <div className="bg-emerald-600 text-white px-6 py-2.5 flex items-center justify-between text-xs font-medium shadow-inner animate-in slide-in-from-top-2 duration-200">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-100" />
              <span>{printSuccessNotice}</span>
            </div>
            <button
              onClick={() => setPrintSuccessNotice(null)}
              className="p-1 hover:bg-emerald-700 rounded transition-colors text-emerald-100"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* ════════════ HEADER BAR ════════════ */}
        <div className="shrink-0 flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-6 py-3.5 border-b border-slate-200 bg-slate-50/80">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-600 text-white shadow-xs">
              <BarChart2 className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-sm font-bold text-slate-900">
                  Fleet Utilization & Batch Rekap
                </h3>
                <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
                  {algoLabel}
                </span>
              </div>
              <p className="text-[11px] text-slate-500 mt-0.5">
                {routes.length} rute aktif · {totalMasterArmada} total armada master terdaftar
              </p>
            </div>
          </div>

          {/* Navigation Tabs */}
          <div className="flex items-center gap-2 self-start sm:self-auto">
            <div className="flex rounded-xl border border-slate-200 bg-white p-1 shadow-2xs">
              <button
                onClick={() => setActiveTab("routes")}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                  activeTab === "routes"
                    ? "bg-blue-600 text-white shadow-xs"
                    : "text-slate-600 hover:text-slate-900 hover:bg-slate-50"
                }`}
              >
                <Printer className="h-3.5 w-3.5" />
                <span>Rute & Print Rekap</span>
                <span
                  className={`ml-1 px-1.5 py-0.2 rounded-full text-[10px] font-bold ${
                    activeTab === "routes"
                      ? "bg-blue-700 text-white"
                      : "bg-slate-100 text-slate-600"
                  }`}
                >
                  {routes.length}
                </span>
              </button>

              <button
                onClick={() => setActiveTab("master")}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                  activeTab === "master"
                    ? "bg-blue-600 text-white shadow-xs"
                    : "text-slate-600 hover:text-slate-900 hover:bg-slate-50"
                }`}
              >
                <Truck className="h-3.5 w-3.5" />
                <span>Utilisasi Master Armada</span>
                <span
                  className={`ml-1 px-1.5 py-0.2 rounded-full text-[10px] font-bold ${
                    activeTab === "master"
                      ? "bg-blue-700 text-white"
                      : "bg-slate-100 text-slate-600"
                  }`}
                >
                  {totalMasterArmada}
                </span>
              </button>
            </div>

            <button
              onClick={onClose}
              className="rounded-xl p-2 text-slate-400 hover:bg-slate-200/70 hover:text-slate-700 transition-colors"
              title="Tutup dialog"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* ════════════ TAB 1 TOOLBAR: BATCH PRINT CONTROLS ════════════ */}
        {activeTab === "routes" && (
          <div className="shrink-0 flex flex-wrap items-center justify-between gap-3 px-6 py-2.5 bg-slate-50 border-b border-slate-200">
            {/* Search Input */}
            <div className="relative flex-1 min-w-[200px] max-w-xs">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Cari Plat / No Rekap..."
                className="w-full pl-8.5 pr-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>

            {/* Batch Selection Action Bar */}
            <div className="flex items-center gap-2.5 flex-wrap">
              <div className="flex items-center gap-1.5 text-xs text-slate-600 font-medium bg-white px-2.5 py-1.5 rounded-lg border border-slate-200 shadow-2xs">
                <span className="font-bold text-slate-900 font-mono">
                  {selectedRecapNos.length}
                </span>
                <span>dari {printableRecapNos.length} rekap dipilih</span>
              </div>

              {selectedRecapNos.length > 0 && (
                <button
                  onClick={() => setSelectedRecapNos([])}
                  className="text-xs text-slate-500 hover:text-slate-800 underline px-1"
                >
                  Reset Pilihan
                </button>
              )}

              {/* Main Action Button: BATCH PRINT REKAP TERPILIH */}
              <button
                disabled={selectedRecapNos.length === 0 || isPrinting}
                onClick={() => handleBatchPrint()}
                className={`flex items-center gap-2 px-4 py-1.5 rounded-xl text-xs font-bold transition-all shadow-xs ${
                  selectedRecapNos.length > 0
                    ? "bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer active:scale-95 shadow-emerald-600/20"
                    : "bg-slate-100 text-slate-400 cursor-not-allowed border border-slate-200"
                }`}
                title="Cetak sekaligus semua rekap yang dicentang"
              >
                <Printer className="h-3.5 w-3.5" />
                <span>Print Rekap Terpilih</span>
                {selectedRecapNos.length > 0 && (
                  <span className="bg-emerald-700/80 text-white font-mono text-[10px] px-1.5 py-0.2 rounded-full">
                    {selectedRecapNos.length}
                  </span>
                )}
              </button>
            </div>
          </div>
        )}

        {/* ════════════ TAB 2 TOOLBAR: MASTER FLEET FILTER ════════════ */}
        {activeTab === "master" && (
          <div className="shrink-0 flex flex-wrap items-center justify-between gap-3 px-6 py-2.5 bg-slate-50 border-b border-slate-200">
            {/* Search Input */}
            <div className="relative flex-1 min-w-[200px] max-w-xs">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Cari No Polisi / Jenis Armada..."
                className="w-full pl-8.5 pr-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>

            {/* Status Filter Pills */}
            <div className="flex items-center gap-1.5 bg-white p-1 rounded-lg border border-slate-200">
              <button
                onClick={() => setStatusFilter("all")}
                className={`px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors ${
                  statusFilter === "all"
                    ? "bg-slate-800 text-white"
                    : "text-slate-600 hover:bg-slate-50"
                }`}
              >
                Semua ({masterRows.length})
              </button>
              <button
                onClick={() => setStatusFilter("active")}
                className={`px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors ${
                  statusFilter === "active"
                    ? "bg-emerald-600 text-white"
                    : "text-emerald-700 hover:bg-emerald-50"
                }`}
              >
                Aktif ({totalArmadaAktif})
              </button>
              <button
                onClick={() => setStatusFilter("standby")}
                className={`px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors ${
                  statusFilter === "standby"
                    ? "bg-amber-600 text-white"
                    : "text-amber-700 hover:bg-amber-50"
                }`}
              >
                Standby ({totalArmadaStandby})
              </button>
            </div>
          </div>
        )}

        {/* ════════════ SCROLLABLE TABLE AREA ════════════ */}
        <div className="overflow-auto flex-1">
          {/* TAB 1: RUTE & BATCH PRINT REKAP */}
          {activeTab === "routes" && (
            <table className="w-full text-xs border-collapse">
              <thead className="sticky top-0 z-10 bg-slate-100 border-b border-slate-200">
                <tr>
                  {/* SELECT ALL CHECKBOX COLUMN */}
                  <th className="px-3 py-2.5 text-center w-10">
                    <input
                      ref={selectAllCheckboxRef}
                      type="checkbox"
                      checked={allPrintableSelected}
                      onChange={handleToggleSelectAll}
                      disabled={printableRecapNos.length === 0}
                      className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer disabled:opacity-40"
                      title="Pilih Semua Rute Valid"
                    />
                  </th>
                  <th className="px-4 py-2.5 text-left font-bold uppercase tracking-wider text-slate-600 whitespace-nowrap text-[10.5px]">
                    NO REKAP
                  </th>
                  <th className="px-4 py-2.5 text-left font-bold uppercase tracking-wider text-slate-600 whitespace-nowrap text-[10.5px]">
                    NOKEND
                  </th>
                  <th className="px-4 py-2.5 text-left font-bold uppercase tracking-wider text-slate-600 whitespace-nowrap text-[10.5px]">
                    JENIS
                  </th>
                  <th className="px-4 py-2.5 text-center font-bold uppercase tracking-wider text-slate-600 whitespace-nowrap text-[10.5px]">
                    OUTLET
                  </th>
                  <th className="px-4 py-2.5 text-right font-bold uppercase tracking-wider text-slate-600 whitespace-nowrap text-[10.5px]">
                    KUBIKASI
                  </th>
                  <th className="px-4 py-2.5 text-right font-bold uppercase tracking-wider text-slate-600 whitespace-nowrap text-[10.5px]">
                    STD KUBIK
                  </th>
                  <th className="px-4 py-2.5 text-right font-bold uppercase tracking-wider text-slate-600 whitespace-nowrap text-[10.5px]">
                    % KUBIK
                  </th>
                  <th className="px-4 py-2.5 text-right font-bold uppercase tracking-wider text-slate-600 whitespace-nowrap text-[10.5px]">
                    TONASE
                  </th>
                  <th className="px-4 py-2.5 text-right font-bold uppercase tracking-wider text-slate-600 whitespace-nowrap text-[10.5px]">
                    STD TONASE
                  </th>
                  <th className="px-4 py-2.5 text-right font-bold uppercase tracking-wider text-slate-600 whitespace-nowrap text-[10.5px]">
                    % TONASE
                  </th>
                  <th className="px-4 py-2.5 text-right font-bold uppercase tracking-wider text-slate-600 whitespace-nowrap text-[10.5px]">
                    % MAX EPE
                  </th>
                </tr>
              </thead>

              <tbody>
                {filteredRouteRows.length === 0 ? (
                  <tr>
                    <td colSpan={12} className="px-4 py-12 text-center text-slate-400">
                      Tidak ada data rute yang cocok dengan pencarian
                    </td>
                  </tr>
                ) : (
                  filteredRouteRows.map((row, idx) => {
                    const isSelected = selectedRecapNos.includes(row.recapNo);
                    return (
                      <tr
                        key={`${row.noKend}-${idx}`}
                        className={`border-b border-slate-100 transition-colors ${
                          isSelected
                            ? "bg-blue-50/70 hover:bg-blue-100/60"
                            : idx % 2 === 0
                            ? "bg-white hover:bg-slate-50/80"
                            : "bg-slate-50/40 hover:bg-slate-100/70"
                        }`}
                      >
                        {/* ROW CHECKBOX */}
                        <td className="px-3 py-2 text-center">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            disabled={!row.hasValidRecap}
                            onChange={() => handleToggleOne(row.recapNo)}
                            className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                            title={
                              row.hasValidRecap
                                ? `Pilih Rekap #${row.recapNo}`
                                : "Belum memiliki nomor rekap valid"
                            }
                          />
                        </td>

                        {/* NO REKAP */}
                        <td className="px-4 py-2 whitespace-nowrap font-mono text-[11px] font-bold">
                          {row.hasValidRecap ? (
                            <span className="inline-flex items-center gap-1 text-amber-800 bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200">
                              <span>#{row.recapNo}</span>
                            </span>
                          ) : (
                            <span className="text-slate-400">-</span>
                          )}
                        </td>

                        {/* NOKEND */}
                        <td className="px-4 py-2 whitespace-nowrap">
                          <span className="flex items-center gap-2">
                            <span
                              className="inline-block h-2.5 w-2.5 rounded-full shrink-0"
                              style={{ background: row.color }}
                            />
                            <span className="font-semibold text-slate-900">
                              {row.noKend}
                            </span>
                          </span>
                        </td>

                        {/* JENIS */}
                        <td className="px-4 py-2 text-slate-600 whitespace-nowrap font-medium">
                          {row.jenis}
                        </td>

                        {/* OUTLET */}
                        <td className="px-4 py-2 text-center text-slate-800 font-semibold font-mono">
                          {row.outlets}
                        </td>

                        {/* KUBIKASI */}
                        <td className="px-4 py-2 text-right text-slate-700 font-mono">
                          {fmtNum(row.kubikasi)}
                        </td>

                        {/* STD KUBIK */}
                        <td className="px-4 py-2 text-right text-slate-400 font-mono">
                          {fmtNum(row.stdKubik)}
                        </td>

                        {/* % KUBIK */}
                        <td className="px-4 py-2 text-right font-mono font-medium">
                          <span
                            className={
                              row.pctKubik >= 80
                                ? "text-emerald-700 font-semibold"
                                : row.pctKubik >= 60
                                ? "text-amber-700 font-semibold"
                                : "text-slate-500"
                            }
                          >
                            {fmtPct(row.pctKubik)}
                          </span>
                        </td>

                        {/* TONASE */}
                        <td className="px-4 py-2 text-right text-slate-700 font-mono">
                          {fmtNum(row.tonase)}
                        </td>

                        {/* STD TONASE */}
                        <td className="px-4 py-2 text-right text-slate-400 font-mono">
                          {fmtNum(row.stdTonase)}
                        </td>

                        {/* % TONASE */}
                        <td className="px-4 py-2 text-right font-mono font-medium">
                          <span
                            className={
                              row.pctTonase >= 80
                                ? "text-emerald-700 font-semibold"
                                : row.pctTonase >= 60
                                ? "text-amber-700 font-semibold"
                                : "text-slate-500"
                            }
                          >
                            {fmtPct(row.pctTonase)}
                          </span>
                        </td>

                        {/* % MAX EPE */}
                        <td className="px-4 py-2 text-right">
                          <span
                            className={`font-mono text-[11px] font-bold px-2 py-0.5 rounded-full inline-block ${maxEpeColor(
                              row.pctMaxEpe
                            )}`}
                          >
                            {fmtPct(row.pctMaxEpe)}
                          </span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          )}

          {/* TAB 2: MASTER FLEET UTILISASI HARIAN */}
          {activeTab === "master" && (
            <table className="w-full text-xs border-collapse">
              <thead className="sticky top-0 z-10 bg-slate-100 border-b border-slate-200">
                <tr>
                  <th className="px-4 py-2.5 text-left font-bold uppercase tracking-wider text-slate-600 whitespace-nowrap text-[10.5px]">
                    NO POLISI / ARMADA
                  </th>
                  <th className="px-4 py-2.5 text-left font-bold uppercase tracking-wider text-slate-600 whitespace-nowrap text-[10.5px]">
                    JENIS KENDARAAN
                  </th>
                  <th className="px-4 py-2.5 text-center font-bold uppercase tracking-wider text-slate-600 whitespace-nowrap text-[10.5px]">
                    JUMLAH RITASE
                  </th>
                  <th className="px-4 py-2.5 text-left font-bold uppercase tracking-wider text-slate-600 whitespace-nowrap text-[10.5px]">
                    NOMOR REKAP HARI INI
                  </th>
                  <th className="px-4 py-2.5 text-right font-bold uppercase tracking-wider text-slate-600 whitespace-nowrap text-[10.5px]">
                    TOTAL KUBIKASI (M³)
                  </th>
                  <th className="px-4 py-2.5 text-right font-bold uppercase tracking-wider text-slate-600 whitespace-nowrap text-[10.5px]">
                    STD KUBIK (M³)
                  </th>
                  <th className="px-4 py-2.5 text-right font-bold uppercase tracking-wider text-slate-600 whitespace-nowrap text-[10.5px]">
                    % UTILISASI KUBIK
                  </th>
                  <th className="px-4 py-2.5 text-right font-bold uppercase tracking-wider text-slate-600 whitespace-nowrap text-[10.5px]">
                    TOTAL TONASE (KG)
                  </th>
                  <th className="px-4 py-2.5 text-right font-bold uppercase tracking-wider text-slate-600 whitespace-nowrap text-[10.5px]">
                    STD TONASE (KG)
                  </th>
                  <th className="px-4 py-2.5 text-right font-bold uppercase tracking-wider text-slate-600 whitespace-nowrap text-[10.5px]">
                    % UTILISASI TON
                  </th>
                  <th className="px-4 py-2.5 text-center font-bold uppercase tracking-wider text-slate-600 whitespace-nowrap text-[10.5px]">
                    STATUS HARIAN
                  </th>
                </tr>
              </thead>

              <tbody>
                {filteredMasterRows.length === 0 ? (
                  <tr>
                    <td colSpan={11} className="px-4 py-12 text-center text-slate-400">
                      Tidak ada master armada yang sesuai dengan kriteria filter
                    </td>
                  </tr>
                ) : (
                  filteredMasterRows.map((mRow, idx) => {
                    const isAktif = mRow.status === "Aktif";
                    return (
                      <tr
                        key={mRow.noKend}
                        className={`border-b border-slate-100 transition-colors ${
                          idx % 2 === 0 ? "bg-white" : "bg-slate-50/50"
                        } hover:bg-blue-50/40`}
                      >
                        {/* NO POLISI */}
                        <td className="px-4 py-2 whitespace-nowrap">
                          <span className="font-bold text-slate-900 font-mono text-[11.5px]">
                            {mRow.noKend}
                          </span>
                        </td>

                        {/* JENIS */}
                        <td className="px-4 py-2 text-slate-600 whitespace-nowrap font-medium">
                          {mRow.jenis}
                        </td>

                        {/* JUMLAH RITASE */}
                        <td className="px-4 py-2 text-center whitespace-nowrap">
                          {mRow.ritaseCount === 0 ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-500 border border-slate-200">
                              0 (Idle / Nganggur)
                            </span>
                          ) : (
                            <span
                              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px] font-bold border ${
                                mRow.ritaseCount === 1
                                  ? "bg-blue-50 text-blue-700 border-blue-200"
                                  : mRow.ritaseCount === 2
                                  ? "bg-purple-50 text-purple-700 border-purple-200"
                                  : "bg-emerald-50 text-emerald-700 border-emerald-200"
                              }`}
                            >
                              <span className="font-mono">{mRow.ritaseCount}</span> Ritase
                            </span>
                          )}
                        </td>

                        {/* NOMOR REKAP HARI INI */}
                        <td className="px-4 py-2 whitespace-nowrap font-mono text-[10.5px]">
                          {mRow.assignedRecaps.length > 0 ? (
                            <div className="flex items-center gap-1 flex-wrap">
                              {mRow.assignedRecaps.map((rec) => (
                                <span
                                  key={rec}
                                  className="px-1.5 py-0.2 rounded font-bold bg-amber-50 text-amber-800 border border-amber-200 shadow-2xs"
                                >
                                  #{rec}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className="text-slate-400 italic">Tidak ada rute</span>
                          )}
                        </td>

                        {/* TOTAL KUBIKASI */}
                        <td className="px-4 py-2 text-right font-mono font-medium text-slate-800">
                          {fmtNum(mRow.totalKubikasi)}
                        </td>

                        {/* STD KUBIK */}
                        <td className="px-4 py-2 text-right font-mono text-slate-400">
                          {fmtNum(mRow.stdKubik)}
                        </td>

                        {/* % UTILISASI KUBIK */}
                        <td className="px-4 py-2 text-right font-mono font-semibold">
                          <span
                            className={
                              mRow.pctKubikHarian >= 80
                                ? "text-emerald-700"
                                : mRow.pctKubikHarian > 0
                                ? "text-blue-700"
                                : "text-slate-400"
                            }
                          >
                            {fmtPct(mRow.pctKubikHarian)}
                          </span>
                        </td>

                        {/* TOTAL TONASE */}
                        <td className="px-4 py-2 text-right font-mono font-medium text-slate-800">
                          {fmtNum(mRow.totalTonase)}
                        </td>

                        {/* STD TONASE */}
                        <td className="px-4 py-2 text-right font-mono text-slate-400">
                          {fmtNum(mRow.stdTonase)}
                        </td>

                        {/* % UTILISASI TON */}
                        <td className="px-4 py-2 text-right font-mono font-semibold">
                          <span
                            className={
                              mRow.pctTonaseHarian >= 80
                                ? "text-emerald-700"
                                : mRow.pctTonaseHarian > 0
                                ? "text-blue-700"
                                : "text-slate-400"
                            }
                          >
                            {fmtPct(mRow.pctTonaseHarian)}
                          </span>
                        </td>

                        {/* STATUS HARIAN */}
                        <td className="px-4 py-2 text-center whitespace-nowrap">
                          {isAktif ? (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
                              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                              Aktif
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-600 border border-slate-200">
                              <Clock className="h-2.5 w-2.5 text-slate-400" />
                              Standby
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          )}
        </div>

        {/* ════════════ GLOBAL SUMMARY STAT CARDS (BOTTOM) ════════════ */}
        <div className="shrink-0 border-t border-slate-200 bg-white px-6 py-3.5">
          {activeTab === "routes" ? (
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                  Global Rute Dispatch Summary
                </p>
                <span className="text-[10.5px] text-slate-500 font-medium">
                  {routeStats.totalKendaraan} Armada Beroperasi
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 md:grid-cols-7">
                <StatCard label="Total Outlet" value={String(routeStats.totalOutlet)} />
                <StatCard label="Total Faktur" value={String(routeStats.totalFaktur)} />
                <StatCard
                  label="Rute Terbentuk"
                  value={String(routeStats.totalKendaraan)}
                />
                <StatCard
                  label="Total Kubikasi"
                  value={fmtNum(routeStats.totalKubikasi)}
                  subLabel="M³"
                />
                <StatCard
                  label="% Avg Kubikasi"
                  value={fmtPct(routeStats.avgPctKubik)}
                  valueClass={
                    routeStats.avgPctKubik >= 80 ? "text-emerald-600" : "text-amber-600"
                  }
                />
                <StatCard
                  label="% Avg Tonase"
                  value={fmtPct(routeStats.avgPctTonase)}
                  valueClass={
                    routeStats.avgPctTonase >= 80 ? "text-emerald-600" : "text-amber-600"
                  }
                />
                <StatCard
                  label="% Avg EPE"
                  value={fmtPct(routeStats.avgPctEpe)}
                  valueClass={
                    routeStats.avgPctEpe >= 80 ? "text-emerald-600" : "text-amber-600"
                  }
                />
              </div>
            </div>
          ) : (
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                  Master Fleet Utilization Summary (Hari Ini)
                </p>
                <span className="text-[10.5px] text-slate-500 font-medium">
                  Utilisasi Armada:{" "}
                  <strong className="text-emerald-700">
                    {totalMasterArmada > 0
                      ? ((totalArmadaAktif / totalMasterArmada) * 100).toFixed(1)
                      : 0}
                    %
                  </strong>
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-6">
                <StatCard
                  label="Total Master Truk"
                  value={String(totalMasterArmada)}
                  subLabel="Unit armada"
                />
                <StatCard
                  label="Armada Aktif (Jalan)"
                  value={String(totalArmadaAktif)}
                  valueClass="text-emerald-600"
                  subLabel={`${totalArmadaAktif} unit beroperasi`}
                />
                <StatCard
                  label="Armada Standby (Idle)"
                  value={String(totalArmadaStandby)}
                  valueClass="text-amber-600"
                  subLabel={`${totalArmadaStandby} unit nganggur`}
                />
                <StatCard
                  label="Total Ritase Hari Ini"
                  value={String(totalRitaseHariIni)}
                  valueClass="text-blue-600"
                  subLabel="Akumulasi seluruh ritase"
                />
                <StatCard
                  label="Total Muatan M³"
                  value={fmtNum(totalKubikasiHarian)}
                  subLabel="Volume terkirim"
                />
                <StatCard
                  label="Total Muatan Kg"
                  value={fmtNum(totalTonaseHarian)}
                  subLabel="Berat terkirim"
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
