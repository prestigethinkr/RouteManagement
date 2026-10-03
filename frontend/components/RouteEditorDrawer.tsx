"use client";

import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  X,
  Truck,
  ChevronRight,
  ChevronLeft,
  ChevronsRight,
  ChevronsLeft,
  RotateCcw,
  Zap,
  Search,
  AlertTriangle,
  CheckCircle2,
  Box,
  Sliders,
  Filter,
  Loader2,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  FilterX,
} from "lucide-react";
import type { AssignedRoute, PendingOutlet } from "@/lib/types";

// ---------------------------------------------------------------------------
// Column Definitions
// ---------------------------------------------------------------------------
export type ColumnKey =
  | "no_faktur"
  | "custno"
  | "custname"
  | "grouppayer"
  | "kecamatan"
  | "kelurahan"
  | "alamat"
  | "karton"
  | "kubikasi"
  | "tonase"
  | "total_neto"
  | "zone";

interface ColumnDef {
  key: ColumnKey;
  label: string;
  width: string;
  minWidth: number;
  align?: "left" | "right" | "center";
  type: "string" | "number";
  getValue: (o: PendingOutlet) => any;
  format?: (val: any, o: PendingOutlet) => React.ReactNode;
}

const COLUMNS: ColumnDef[] = [
  {
    key: "no_faktur",
    label: "No Faktur",
    width: "w-28",
    minWidth: 110,
    type: "string",
    getValue: (o) => o.invoices.map((i) => i.INVNO).filter(Boolean).join(", ") || "-",
    format: (val) => (
      <span className="font-mono text-slate-700 truncate block" title={String(val)}>
        {val}
      </span>
    ),
  },
  {
    key: "custno",
    label: "Kode Outlet",
    width: "w-24",
    minWidth: 95,
    type: "string",
    getValue: (o) => o.custno,
    format: (val) => <span className="font-mono font-medium text-slate-600">{val}</span>,
  },
  {
    key: "custname",
    label: "Nama Outlet",
    width: "w-44",
    minWidth: 180,
    type: "string",
    getValue: (o) => o.custname,
    format: (val, o) => (
      <div className="flex flex-col gap-1">
        <span className="font-semibold text-slate-900 truncate block" title={String(val)}>
          {val}
        </span>
        {o.is_cross_zone_swept && (
          <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-blue-100 text-blue-700 w-fit leading-none shadow-sm uppercase tracking-wider border border-blue-200">
            Cross-Zone Swept
          </span>
        )}
      </div>
    ),
  },
  {
    key: "grouppayer",
    label: "Group Payer",
    width: "w-28",
    minWidth: 110,
    type: "string",
    getValue: (o) => o.grouppayer || "-",
    format: (val) => (
      <span className="text-slate-600 truncate block" title={String(val)}>
        {val}
      </span>
    ),
  },
  {
    key: "kecamatan",
    label: "Kecamatan",
    width: "w-32",
    minWidth: 120,
    type: "string",
    getValue: (o) => o.kecamatan || o.invoices[0]?.KECAMATAN || "-",
    format: (val) => (
      <span className="text-slate-700 truncate block" title={String(val)}>
        {val}
      </span>
    ),
  },
  {
    key: "kelurahan",
    label: "Kelurahan",
    width: "w-32",
    minWidth: 120,
    type: "string",
    getValue: (o) => o.kelurahan || o.invoices[0]?.KELURAHAN || "-",
    format: (val) => (
      <span className="text-slate-700 truncate block" title={String(val)}>
        {val}
      </span>
    ),
  },
  {
    key: "alamat",
    label: "Alamat",
    width: "w-52",
    minWidth: 200,
    type: "string",
    getValue: (o) => o.alamat || o.invoices[0]?.ALAMAT || "-",
    format: (val) => (
      <span className="text-slate-500 truncate block text-[10.5px]" title={String(val)}>
        {val}
      </span>
    ),
  },
  {
    key: "karton",
    label: "Karton",
    width: "w-20",
    minWidth: 80,
    align: "right",
    type: "number",
    getValue: (o) =>
      o.total_karton ?? o.invoices.reduce((s, i) => s + (i.TOTAL_KARTON || 0), 0),
    format: (val) => (
      <span className="font-mono text-slate-800 font-medium">
        {Number(val || 0).toLocaleString("id-ID", { maximumFractionDigits: 1 })}
      </span>
    ),
  },
  {
    key: "kubikasi",
    label: "Kubikasi",
    width: "w-22",
    minWidth: 85,
    align: "right",
    type: "number",
    getValue: (o) => o.total_kubikasi_m3,
    format: (val) => (
      <span className="font-mono text-slate-800 font-medium">
        {Number(val || 0).toFixed(3)}
      </span>
    ),
  },
  {
    key: "tonase",
    label: "Tonase",
    width: "w-22",
    minWidth: 85,
    align: "right",
    type: "number",
    getValue: (o) => o.total_berat_kg,
    format: (val) => (
      <span className="font-mono text-slate-800 font-medium">
        {Number(val || 0).toLocaleString("id-ID", { maximumFractionDigits: 1 })}
      </span>
    ),
  },
  {
    key: "total_neto",
    label: "Total Neto",
    width: "w-28",
    minWidth: 115,
    align: "right",
    type: "number",
    getValue: (o) =>
      o.total_neto ?? o.invoices.reduce((s, i) => s + (i.TOTAL_NETO || 0), 0),
    format: (val) => (
      <span className="font-mono text-slate-800 font-medium">
        {Number(val || 0).toLocaleString("id-ID")}
      </span>
    ),
  },
  {
    key: "zone",
    label: "Zone",
    width: "w-24",
    minWidth: 95,
    align: "center",
    type: "string",
    getValue: (o) => o.zone || "-",
    format: (val) =>
      val && val !== "-" ? (
        <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-slate-100 text-slate-700 border border-slate-200">
          {val}
        </span>
      ) : (
        <span className="text-slate-300">-</span>
      ),
  },
];

// Helper: Filter & Sort Processor
function processOutlets(
  outlets: PendingOutlet[],
  globalSearch: string,
  colFilters: Record<string, string>,
  sortState: { col: ColumnKey | null; dir: "asc" | "desc" | null }
): PendingOutlet[] {
  const gq = globalSearch.toLowerCase().trim();
  const activeFilters = Object.entries(colFilters).filter(([_, v]) => v && v.trim() !== "");

  // 1. Filtering
  let result = outlets.filter((o) => {
    if (gq) {
      const matchGlobal =
        o.custname.toLowerCase().includes(gq) ||
        o.custno.toLowerCase().includes(gq) ||
        (o.grouppayer && o.grouppayer.toLowerCase().includes(gq)) ||
        (o.zone && o.zone.toLowerCase().includes(gq)) ||
        (o.kecamatan && o.kecamatan.toLowerCase().includes(gq)) ||
        (o.kelurahan && o.kelurahan.toLowerCase().includes(gq)) ||
        (o.alamat && o.alamat.toLowerCase().includes(gq)) ||
        o.invoices.some((inv) => inv.INVNO.toLowerCase().includes(gq));
      if (!matchGlobal) return false;
    }

    for (const [colKey, filterVal] of activeFilters) {
      const fv = filterVal.toLowerCase().trim();
      const colDef = COLUMNS.find((c) => c.key === colKey);
      if (!colDef) continue;
      const rawVal = colDef.getValue(o);
      const strVal = String(rawVal ?? "").toLowerCase();
      if (!strVal.includes(fv)) return false;
    }

    return true;
  });

  // 2. Sorting
  if (sortState.col && sortState.dir) {
    const colDef = COLUMNS.find((c) => c.key === sortState.col);
    if (colDef) {
      const isNum = colDef.type === "number";
      const dirMult = sortState.dir === "asc" ? 1 : -1;

      result = [...result].sort((a, b) => {
        const valA = colDef.getValue(a);
        const valB = colDef.getValue(b);

        if (isNum) {
          const numA = Number(valA) || 0;
          const numB = Number(valB) || 0;
          return (numA - numB) * dirMult;
        }

        const strA = String(valA ?? "").toLowerCase();
        const strB = String(valB ?? "").toLowerCase();
        return strA.localeCompare(strB) * dirMult;
      });
    }
  }

  return result;
}

interface RouteEditorDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  routes: AssignedRoute[];
  selectedVehicleId: string;
  onSelectVehicleId: (vehicleId: string) => void;
  unassignedPool: PendingOutlet[];
  onSaveRoute: (
    vehicleId: string,
    assignedOutlets: PendingOutlet[],
    updatedUnassignedPool: PendingOutlet[]
  ) => Promise<{ reorderedList?: PendingOutlet[]; distanceKm?: number } | void>;
  onHoverUnassignedOutlet?: (outlet: PendingOutlet | null) => void;
  onClickUnassignedOutlet?: (outlet: PendingOutlet) => void;
}

export default function RouteEditorDrawer({
  isOpen,
  onClose,
  routes,
  selectedVehicleId,
  onSelectVehicleId,
  unassignedPool,
  onSaveRoute,
  onHoverUnassignedOutlet,
  onClickUnassignedOutlet,
}: RouteEditorDrawerProps) {
  // Current vehicle route
  const currentRoute = useMemo(() => {
    return routes.find((r) => r.vehicle.NO_KEND === selectedVehicleId) || routes[0] || null;
  }, [routes, selectedVehicleId]);

  // Local state for fast responsive dual-list transfer
  const [localAssigned, setLocalAssigned] = useState<PendingOutlet[]>([]);
  const [localUnassigned, setLocalUnassigned] = useState<PendingOutlet[]>([]);

  // Selection states (custnos)
  const [selectedLeft, setSelectedLeft] = useState<Set<string>>(new Set());
  const [selectedRight, setSelectedRight] = useState<Set<string>>(new Set());

  // Global search filters
  const [searchLeft, setSearchLeft] = useState<string>("");
  const [searchRight, setSearchRight] = useState<string>("");

  // Independent Column Filters for Left and Right tables
  const [colFiltersLeft, setColFiltersLeft] = useState<Record<string, string>>({});
  const [colFiltersRight, setColFiltersRight] = useState<Record<string, string>>({});
  const [showFilterRowLeft, setShowFilterRowLeft] = useState(false);
  const [showFilterRowRight, setShowFilterRowRight] = useState(false);

  // Independent Column Sort for Left and Right tables
  const [sortLeft, setSortLeft] = useState<{ col: ColumnKey | null; dir: "asc" | "desc" | null }>({
    col: null,
    dir: null,
  });
  const [sortRight, setSortRight] = useState<{ col: ColumnKey | null; dir: "asc" | "desc" | null }>({
    col: null,
    dir: null,
  });

  // Save / reorder loading state
  const [isSaving, setIsSaving] = useState(false);

  // Track previous open state & vehicle ID to only reset local state on explicit switch or initial open
  const prevVehicleIdRef = useRef<string>(selectedVehicleId);
  const prevIsOpenRef = useRef<boolean>(isOpen);

  // Sync local state ONLY when drawer newly opens or active vehicle changes
  useEffect(() => {
    const isNewOpen = isOpen && !prevIsOpenRef.current;
    const isVehicleSwitched = selectedVehicleId !== prevVehicleIdRef.current;

    prevIsOpenRef.current = isOpen;
    prevVehicleIdRef.current = selectedVehicleId;

    if (isOpen && (isNewOpen || isVehicleSwitched) && currentRoute) {
      setLocalAssigned([...currentRoute.outlets]);
      setLocalUnassigned([...unassignedPool]);
      setSelectedLeft(new Set());
      setSelectedRight(new Set());
    }
  }, [isOpen, selectedVehicleId, currentRoute, unassignedPool]);

  // Reset local modifications back to original
  const handleReset = () => {
    if (currentRoute) {
      setLocalAssigned([...currentRoute.outlets]);
      setLocalUnassigned([...unassignedPool]);
      setSelectedLeft(new Set());
      setSelectedRight(new Set());
      setColFiltersLeft({});
      setColFiltersRight({});
      setSortLeft({ col: null, dir: null });
      setSortRight({ col: null, dir: null });
    }
  };

  // Toggle Sort Handlers
  const handleToggleSortLeft = (col: ColumnKey) => {
    setSortLeft((prev) => {
      if (prev.col !== col) return { col, dir: "asc" };
      if (prev.dir === "asc") return { col, dir: "desc" };
      return { col: null, dir: null };
    });
  };

  const handleToggleSortRight = (col: ColumnKey) => {
    setSortRight((prev) => {
      if (prev.col !== col) return { col, dir: "asc" };
      if (prev.dir === "asc") return { col, dir: "desc" };
      return { col: null, dir: null };
    });
  };

  // Processed lists (Filtered & Sorted)
  const filteredUnassigned = useMemo(() => {
    return processOutlets(localUnassigned, searchLeft, colFiltersLeft, sortLeft);
  }, [localUnassigned, searchLeft, colFiltersLeft, sortLeft]);

  const filteredAssigned = useMemo(() => {
    return processOutlets(localAssigned, searchRight, colFiltersRight, sortRight);
  }, [localAssigned, searchRight, colFiltersRight, sortRight]);

  const activeFiltersLeftCount = useMemo(() => {
    return Object.values(colFiltersLeft).filter((v) => v && v.trim() !== "").length;
  }, [colFiltersLeft]);

  const activeFiltersRightCount = useMemo(() => {
    return Object.values(colFiltersRight).filter((v) => v && v.trim() !== "").length;
  }, [colFiltersRight]);

  // Dynamic live capacity calculations
  const vehicle = currentRoute?.vehicle;
  const currentKg = useMemo(() => {
    return localAssigned.reduce((acc, o) => acc + (o.total_berat_kg || 0), 0);
  }, [localAssigned]);

  const currentM3 = useMemo(() => {
    return localAssigned.reduce((acc, o) => acc + (o.total_kubikasi_m3 || 0), 0);
  }, [localAssigned]);

  const maxKg = vehicle?.TONASE || 1;
  const maxM3 = vehicle?.KUBIKASE || 1;

  const kgPct = (currentKg / maxKg) * 100;
  const m3Pct = (currentM3 / maxM3) * 100;
  const maxEpePct = Math.max(kgPct, m3Pct);

  const isOverKg = currentKg > maxKg;
  const isOverM3 = currentM3 > maxM3;
  const isOverloaded = isOverKg || isOverM3;

  // Compatibility warnings
  const compatibilityWarnings = useMemo(() => {
    if (!vehicle) return [];
    const warnings: string[] = [];
    localAssigned.forEach((o) => {
      if (vehicle.ZONES && vehicle.ZONES.length > 0 && !vehicle.ZONES.includes("ALL")) {
        if (o.zone && !vehicle.ZONES.includes(o.zone)) {
          warnings.push(`Zone mismatch: ${o.custname} (${o.zone})`);
        }
      }
      if (o.allowed_vehicles && o.allowed_vehicles.length > 0) {
        if (!o.allowed_vehicles.includes(vehicle.JNS_KEND)) {
          warnings.push(`Vehicle mismatch: ${o.custname} requires [${o.allowed_vehicles.join(", ")}]`);
        }
      }
    });
    return warnings;
  }, [localAssigned, vehicle]);

  const hasHardViolation = compatibilityWarnings.length > 0;

  // Transfer Handlers
  const transferToAssigned = (custnos: string[]) => {
    if (custnos.length === 0) return;
    
    const finalCustnos = new Set(custnos);
    let hasCrossVehicleGroup = false;
    const relatedVehicles = new Set<string>();

    for (const id of custnos) {
      const outlet = localUnassigned.find((o) => o.custno === id);
      if (outlet?.grouppayer) {
        localUnassigned
          .filter((o) => o.grouppayer === outlet.grouppayer)
          .forEach((o) => finalCustnos.add(o.custno));
          
        routes.forEach(r => {
            if (r.vehicle.NO_KEND !== selectedVehicleId && r.outlets.some(o => o.grouppayer === outlet.grouppayer)) {
                hasCrossVehicleGroup = true;
                relatedVehicles.add(r.vehicle.NO_KEND);
            }
        });
      }
    }

    if (hasCrossVehicleGroup) {
        const vList = Array.from(relatedVehicles).join(", ");
        const confirmed = window.confirm(
            `Toko ini terhubung dengan GroupPayer bersama toko lainnya di armada ${vList}. Pindahkan seluruh grup yang ada di pool unassigned ke armada ini? (Toko yang sudah di armada lain tidak akan otomatis pindah)`
        );
        if (!confirmed) return;
    }

    const toMove = localUnassigned.filter((o) => finalCustnos.has(o.custno));
    setLocalAssigned((prev) => [...prev, ...toMove]);
    setLocalUnassigned((prev) => prev.filter((o) => !finalCustnos.has(o.custno)));
    setSelectedLeft((prev) => {
      const next = new Set(prev);
      finalCustnos.forEach((id) => next.delete(id));
      return next;
    });
  };

  const transferToUnassigned = (custnos: string[]) => {
    if (custnos.length === 0) return;

    const finalCustnos = new Set(custnos);
    let hasCrossVehicleGroup = false;
    const relatedVehicles = new Set<string>();

    for (const id of custnos) {
      const outlet = localAssigned.find((o) => o.custno === id);
      if (outlet?.grouppayer) {
        localAssigned
          .filter((o) => o.grouppayer === outlet.grouppayer)
          .forEach((o) => finalCustnos.add(o.custno));
          
        routes.forEach(r => {
            if (r.vehicle.NO_KEND !== selectedVehicleId && r.outlets.some(o => o.grouppayer === outlet.grouppayer)) {
                hasCrossVehicleGroup = true;
                relatedVehicles.add(r.vehicle.NO_KEND);
            }
        });
      }
    }

    if (hasCrossVehicleGroup) {
        const vList = Array.from(relatedVehicles).join(", ");
        const confirmed = window.confirm(
            `Toko ini terhubung dengan GroupPayer bersama toko lainnya di armada ${vList}. Keluarkan seluruh grup yang ada di armada ini?`
        );
        if (!confirmed) return;
    }

    const toMove = localAssigned.filter((o) => finalCustnos.has(o.custno));
    setLocalUnassigned((prev) => [...prev, ...toMove]);
    setLocalAssigned((prev) => prev.filter((o) => !finalCustnos.has(o.custno)));
    setSelectedRight((prev) => {
      const next = new Set(prev);
      finalCustnos.forEach((id) => next.delete(id));
      return next;
    });
  };

  const handleTransferSelectedRight = () => {
    transferToAssigned(Array.from(selectedLeft));
  };

  const handleTransferSelectedLeft = () => {
    transferToUnassigned(Array.from(selectedRight));
  };

  const handleTransferAllRight = () => {
    transferToAssigned(filteredUnassigned.map((o) => o.custno));
  };

  const handleTransferAllLeft = () => {
    transferToUnassigned(filteredAssigned.map((o) => o.custno));
  };

  // Toggle selection
  const toggleSelectLeft = (custno: string) => {
    setSelectedLeft((prev) => {
      const next = new Set(prev);
      if (next.has(custno)) next.delete(custno);
      else next.add(custno);
      return next;
    });
  };

  const toggleSelectAllLeft = () => {
    if (selectedLeft.size === filteredUnassigned.length && filteredUnassigned.length > 0) {
      setSelectedLeft(new Set());
    } else {
      setSelectedLeft(new Set(filteredUnassigned.map((o) => o.custno)));
    }
  };

  const toggleSelectRight = (custno: string) => {
    setSelectedRight((prev) => {
      const next = new Set(prev);
      if (next.has(custno)) next.delete(custno);
      else next.add(custno);
      return next;
    });
  };

  const toggleSelectAllRight = () => {
    if (selectedRight.size === filteredAssigned.length && filteredAssigned.length > 0) {
      setSelectedRight(new Set());
    } else {
      setSelectedRight(new Set(filteredAssigned.map((o) => o.custno)));
    }
  };

  // Hitung Ulang Rute (OSRM) handler
  const handleReorderRoute = async () => {
    if (!currentRoute) return;
    try {
      setIsSaving(true);
      const res = await onSaveRoute(currentRoute.vehicle.NO_KEND, localAssigned, localUnassigned);
      if (res && res.reorderedList && res.reorderedList.length > 0) {
        setLocalAssigned(res.reorderedList);
      }
      setSelectedLeft(new Set());
      setSelectedRight(new Set());
    } finally {
      setIsSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-[2500] h-[54vh] min-h-[440px] max-h-[60vh] bg-white/95 backdrop-blur-md border-t border-slate-200/90 shadow-2xl flex flex-col font-sans text-slate-800 transition-transform duration-300 ease-out select-none">
      
      {/* ── TOP DRAWER HEADER BAR ── */}
      <div className="h-12 px-5 bg-slate-50/90 border-b border-slate-200 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <div className="p-1.5 rounded-lg bg-blue-50 text-blue-600 border border-blue-200">
            <Sliders className="h-4 w-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xs font-bold text-slate-900 uppercase tracking-wide">
                Manual Route Editor (Dual-List Transfer)
              </h2>
              <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-slate-200/70 text-slate-600">
                13 Kolom Rekap · Sort & Filter Independen
              </span>
            </div>
          </div>
        </div>

        {/* Vehicle Selector Switcher & Controls */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 bg-white px-2.5 py-1 rounded-xl border border-slate-200 shadow-xs">
            <Truck className="h-3.5 w-3.5 text-blue-600" />
            <span className="text-[11px] font-bold text-slate-500">Fleet:</span>
            <select
              value={currentRoute?.vehicle.NO_KEND || ""}
              onChange={(e) => onSelectVehicleId(e.target.value)}
              className="text-xs font-bold text-slate-800 bg-transparent outline-none cursor-pointer pr-2"
            >
              {routes.map((r) => {
                const v = r.vehicle;
                const vKgPct = v.TONASE > 0 ? (r.currentKg / v.TONASE) * 100 : 0;
                const vM3Pct = v.KUBIKASE > 0 ? (r.currentM3 / v.KUBIKASE) * 100 : 0;
                return (
                  <option key={v.NO_KEND} value={v.NO_KEND}>
                    {v.NO_KEND} ({v.JNS_KEND}) — {r.outlets.length} stops [EPE: {Math.max(vKgPct, vM3Pct).toFixed(0)}%]
                  </option>
                );
              })}
            </select>
          </div>

          {/* Close Drawer Button */}
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 transition-colors cursor-pointer"
            title="Close Drawer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* ── MAIN BODY: DUAL PANEL DOCK (LEFT - CENTER CONTROLS - RIGHT) ── */}
      <div className="flex-1 flex overflow-hidden min-h-0 bg-slate-100/60">
        
        {/* ════════════ 1. LEFT PANEL: FAKTUR UNMAPPING ════════════ */}
        <div className="flex-1 flex flex-col min-w-0 border-r border-slate-200/80 bg-white">
          {/* Header Toolbar */}
          <div className="p-2 px-3 bg-slate-50/80 border-b border-slate-200 flex items-center justify-between gap-2 shrink-0">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-bold text-amber-900">Faktur Unmapping</span>
              <span className="text-[10px] font-mono font-bold px-1.5 py-0.2 rounded-full bg-amber-100 text-amber-800 border border-amber-200">
                {localUnassigned.length} pool
              </span>
              {selectedLeft.size > 0 && (
                <span className="text-[10px] font-semibold text-blue-600 bg-blue-50 px-1.5 py-0.2 rounded-md border border-blue-200">
                  {selectedLeft.size} selected
                </span>
              )}
            </div>

            <div className="flex items-center gap-1.5">
              {/* Toggle Column Filter Row */}
              <button
                onClick={() => setShowFilterRowLeft(!showFilterRowLeft)}
                className={`flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] font-bold border transition-colors cursor-pointer ${
                  showFilterRowLeft || activeFiltersLeftCount > 0
                    ? "bg-amber-100 text-amber-900 border-amber-300"
                    : "bg-white text-slate-600 border-slate-200 hover:bg-slate-100"
                }`}
                title="Toggle filter per kolom"
              >
                <Filter className="h-3 w-3" />
                <span>Filter Kolom</span>
                {activeFiltersLeftCount > 0 && (
                  <span className="px-1 rounded-full bg-amber-500 text-white font-mono text-[9px]">
                    {activeFiltersLeftCount}
                  </span>
                )}
              </button>

              {activeFiltersLeftCount > 0 && (
                <button
                  onClick={() => setColFiltersLeft({})}
                  className="p-1 rounded text-slate-400 hover:text-rose-600 transition-colors cursor-pointer"
                  title="Reset semua filter kolom"
                >
                  <FilterX className="h-3 w-3" />
                </button>
              )}

              {/* Global search */}
              <div className="relative w-36 sm:w-44">
                <Search className="h-3 w-3 absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  placeholder="Cari semua kolom..."
                  value={searchLeft}
                  onChange={(e) => setSearchLeft(e.target.value)}
                  className="w-full pl-6 pr-2 py-0.5 text-[11px] bg-white border border-slate-200 rounded-md text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-blue-400"
                />
              </div>
            </div>
          </div>

          {/* Table Container with Horizontal & Vertical Scroll */}
          <div className="flex-1 overflow-x-auto overflow-y-auto scrollbar-thin scrollbar-thumb-slate-300 scrollbar-track-slate-100">
            <table className="w-full border-collapse text-[11px] table-fixed min-w-[1450px]">
              <thead className="sticky top-0 z-30 bg-slate-100/95 backdrop-blur-xs text-slate-600 font-bold border-b border-slate-200 shadow-xs">
                {/* 1. Header Title Row with Sort Icons */}
                <tr>
                  {/* Sticky Checkbox Column */}
                  <th className="sticky left-0 z-40 bg-slate-100 w-11 px-2 py-1.5 text-center border-r border-slate-200 shadow-[1px_0_0_0_#e2e8f0]">
                    <input
                      type="checkbox"
                      checked={selectedLeft.size === filteredUnassigned.length && filteredUnassigned.length > 0}
                      onChange={toggleSelectAllLeft}
                      className="rounded border-slate-300 text-blue-600 cursor-pointer"
                      title="Select all unassigned"
                    />
                  </th>

                  {/* 12 Data Columns */}
                  {COLUMNS.map((col) => {
                    const isSorted = sortLeft.col === col.key;
                    return (
                      <th
                        key={col.key}
                        onClick={() => handleToggleSortLeft(col.key)}
                        style={{ minWidth: col.minWidth }}
                        className={`px-2.5 py-1.5 text-left border-r border-slate-200/70 cursor-pointer hover:bg-slate-200/80 transition-colors uppercase tracking-wider text-[10px] select-none ${
                          col.align === "right" ? "text-right" : col.align === "center" ? "text-center" : "text-left"
                        } ${isSorted ? "bg-amber-100/60 text-amber-900" : ""}`}
                        title={`Klik untuk sort ${col.label}`}
                      >
                        <div className={`flex items-center gap-1 ${col.align === "right" ? "justify-end" : col.align === "center" ? "justify-center" : "justify-start"}`}>
                          <span className="truncate">{col.label}</span>
                          {isSorted ? (
                            sortLeft.dir === "asc" ? (
                              <ArrowUp className="h-3 w-3 text-amber-700 shrink-0" />
                            ) : (
                              <ArrowDown className="h-3 w-3 text-amber-700 shrink-0" />
                            )
                          ) : (
                            <ArrowUpDown className="h-2.5 w-2.5 text-slate-300 hover:text-slate-500 shrink-0" />
                          )}
                        </div>
                      </th>
                    );
                  })}

                  {/* Fast Action Column */}
                  <th className="w-12 px-1 text-center font-bold uppercase text-[9.5px]">Aksi</th>
                </tr>

                {/* 2. Optional Independent Filter Input Row */}
                {showFilterRowLeft && (
                  <tr className="bg-amber-50/70 border-b border-amber-200/80 text-[10px]">
                    <th className="sticky left-0 z-40 bg-amber-50/90 px-1 py-1 text-center border-r border-slate-200">
                      <span className="text-[9px] text-amber-700 font-mono">🔍</span>
                    </th>
                    {COLUMNS.map((col) => (
                      <th key={`filter-left-${col.key}`} className="px-1.5 py-1 border-r border-slate-200/60">
                        <input
                          type="text"
                          placeholder={`Filter...`}
                          value={colFiltersLeft[col.key] || ""}
                          onChange={(e) =>
                            setColFiltersLeft((prev) => ({
                              ...prev,
                              [col.key]: e.target.value,
                            }))
                          }
                          className="w-full px-1.5 py-0.5 text-[10px] font-normal rounded border border-slate-200 bg-white text-slate-800 placeholder:text-slate-300 focus:outline-none focus:border-amber-500"
                        />
                      </th>
                    ))}
                    <th className="px-1 py-1 text-center">
                      {activeFiltersLeftCount > 0 && (
                        <button
                          onClick={() => setColFiltersLeft({})}
                          className="text-[9px] text-amber-700 underline hover:text-rose-600 cursor-pointer"
                        >
                          Clear
                        </button>
                      )}
                    </th>
                  </tr>
                )}
              </thead>

              {/* Table Body */}
              <tbody className="divide-y divide-slate-100">
                {filteredUnassigned.length === 0 ? (
                  <tr>
                    <td colSpan={14} className="py-12 text-center text-slate-400">
                      <Box className="h-6 w-6 opacity-30 text-amber-500 mb-1 mx-auto" />
                      <span>Tidak ada outlet yang sesuai filter</span>
                    </td>
                  </tr>
                ) : (
                  filteredUnassigned.map((outlet) => {
                    const isSelected = selectedLeft.has(outlet.custno);
                    return (
                      <tr
                        key={outlet.custno}
                        onMouseEnter={() => onHoverUnassignedOutlet?.(outlet)}
                        onMouseLeave={() => onHoverUnassignedOutlet?.(null)}
                        onClick={() => {
                          toggleSelectLeft(outlet.custno);
                          onClickUnassignedOutlet?.(outlet);
                        }}
                        className={`group cursor-pointer transition-colors ${
                          isSelected
                            ? "bg-amber-50/80 hover:bg-amber-100/70"
                            : "hover:bg-slate-50/90 text-slate-700"
                        }`}
                      >
                        {/* Sticky Checkbox */}
                        <td
                          className={`sticky left-0 z-20 px-2 py-1.5 text-center border-r border-slate-200 shadow-[1px_0_0_0_#e2e8f0] ${
                            isSelected ? "bg-amber-50" : "bg-white group-hover:bg-slate-50"
                          }`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleSelectLeft(outlet.custno)}
                            className="rounded border-slate-300 text-blue-600 cursor-pointer"
                          />
                        </td>

                        {/* 12 Data Columns */}
                        {COLUMNS.map((col) => {
                          const val = col.getValue(outlet);
                          return (
                            <td
                              key={`cell-left-${col.key}-${outlet.custno}`}
                              style={{ minWidth: col.minWidth }}
                              className={`px-2.5 py-1.5 border-r border-slate-100 whitespace-nowrap overflow-hidden text-ellipsis ${
                                col.align === "right"
                                  ? "text-right"
                                  : col.align === "center"
                                  ? "text-center"
                                  : "text-left"
                              }`}
                            >
                              {col.format ? col.format(val, outlet) : val}
                            </td>
                          );
                        })}

                        {/* Fast Move Action */}
                        <td className="px-1 py-1 text-center" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={() => transferToAssigned([outlet.custno])}
                            title="Pindahkan ke Armada"
                            className="p-1 rounded hover:bg-blue-100 text-slate-400 hover:text-blue-600 transition-colors cursor-pointer"
                          >
                            <ChevronRight className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* ════════════ 2. CENTER CONTROLS: TRANSFER BUTTONS ════════════ */}
        <div className="w-14 flex flex-col items-center justify-center gap-2 p-1.5 bg-slate-50/80 border-r border-slate-200/80 shrink-0">
          {/* Transfer Selected Right > */}
          <button
            onClick={handleTransferSelectedRight}
            disabled={selectedLeft.size === 0}
            title="Tugaskan outlet terpilih ke armada"
            className="p-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white shadow-xs disabled:opacity-30 disabled:cursor-not-allowed transition-all cursor-pointer"
          >
            <ChevronRight className="h-4 w-4" />
          </button>

          {/* Transfer Selected Left < */}
          <button
            onClick={handleTransferSelectedLeft}
            disabled={selectedRight.size === 0}
            title="Kembalikan outlet terpilih ke unassigned"
            className="p-2 rounded-xl bg-slate-700 hover:bg-slate-800 text-white shadow-xs disabled:opacity-30 disabled:cursor-not-allowed transition-all cursor-pointer"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>

          <div className="h-px w-6 bg-slate-200 my-1" />

          {/* Transfer All Right >> */}
          <button
            onClick={handleTransferAllRight}
            disabled={filteredUnassigned.length === 0}
            title="Tugaskan semua yang tampil ke armada"
            className="p-1.5 rounded-lg bg-slate-200 hover:bg-slate-300 text-slate-700 disabled:opacity-30 disabled:cursor-not-allowed transition-all cursor-pointer"
          >
            <ChevronsRight className="h-3.5 w-3.5" />
          </button>

          {/* Transfer All Left << */}
          <button
            onClick={handleTransferAllLeft}
            disabled={filteredAssigned.length === 0}
            title="Kembalikan semua yang tampil ke pool"
            className="p-1.5 rounded-lg bg-slate-200 hover:bg-slate-300 text-slate-700 disabled:opacity-30 disabled:cursor-not-allowed transition-all cursor-pointer"
          >
            <ChevronsLeft className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* ════════════ 3. RIGHT PANEL: FAKTUR MAPPING (ASSIGNED TO VEHICLE) ════════════ */}
        <div className="flex-1 flex flex-col min-w-0 bg-white">
          {/* Header Toolbar */}
          <div className="p-2 px-3 bg-slate-50/80 border-b border-slate-200 flex items-center justify-between gap-2 shrink-0">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-bold text-blue-900">
                Faktur Mapping ({vehicle?.NO_KEND})
              </span>
              <span className="text-[10px] font-mono font-bold px-1.5 py-0.2 rounded-full bg-blue-100 text-blue-800 border border-blue-200">
                {localAssigned.length} stops
              </span>
              {selectedRight.size > 0 && (
                <span className="text-[10px] font-semibold text-amber-700 bg-amber-50 px-1.5 py-0.2 rounded-md border border-amber-200">
                  {selectedRight.size} selected
                </span>
              )}
            </div>

            <div className="flex items-center gap-1.5">
              {/* Toggle Column Filter Row */}
              <button
                onClick={() => setShowFilterRowRight(!showFilterRowRight)}
                className={`flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] font-bold border transition-colors cursor-pointer ${
                  showFilterRowRight || activeFiltersRightCount > 0
                    ? "bg-blue-100 text-blue-900 border-blue-300"
                    : "bg-white text-slate-600 border-slate-200 hover:bg-slate-100"
                }`}
                title="Toggle filter per kolom"
              >
                <Filter className="h-3 w-3" />
                <span>Filter Kolom</span>
                {activeFiltersRightCount > 0 && (
                  <span className="px-1 rounded-full bg-blue-600 text-white font-mono text-[9px]">
                    {activeFiltersRightCount}
                  </span>
                )}
              </button>

              {activeFiltersRightCount > 0 && (
                <button
                  onClick={() => setColFiltersRight({})}
                  className="p-1 rounded text-slate-400 hover:text-rose-600 transition-colors cursor-pointer"
                  title="Reset semua filter kolom"
                >
                  <FilterX className="h-3 w-3" />
                </button>
              )}

              {/* Global search */}
              <div className="relative w-36 sm:w-44">
                <Search className="h-3 w-3 absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  placeholder="Cari semua kolom..."
                  value={searchRight}
                  onChange={(e) => setSearchRight(e.target.value)}
                  className="w-full pl-6 pr-2 py-0.5 text-[11px] bg-white border border-slate-200 rounded-md text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-blue-400"
                />
              </div>
            </div>
          </div>

          {/* Table Container with Horizontal & Vertical Scroll */}
          <div className="flex-1 overflow-x-auto overflow-y-auto scrollbar-thin scrollbar-thumb-slate-300 scrollbar-track-slate-100">
            <table className="w-full border-collapse text-[11px] table-fixed min-w-[1480px]">
              <thead className="sticky top-0 z-30 bg-slate-100/95 backdrop-blur-xs text-slate-600 font-bold border-b border-slate-200 shadow-xs">
                {/* 1. Header Title Row with Sort Icons */}
                <tr>
                  {/* Sticky Checkbox & Stop # Column */}
                  <th className="sticky left-0 z-40 bg-slate-100 w-16 px-2 py-1.5 text-center border-r border-slate-200 shadow-[1px_0_0_0_#e2e8f0]">
                    <div className="flex items-center justify-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={selectedRight.size === filteredAssigned.length && filteredAssigned.length > 0}
                        onChange={toggleSelectAllRight}
                        className="rounded border-slate-300 text-blue-600 cursor-pointer"
                        title="Select all assigned"
                      />
                      <span className="text-[9.5px] text-slate-400 font-mono font-bold">#</span>
                    </div>
                  </th>

                  {/* 12 Data Columns */}
                  {COLUMNS.map((col) => {
                    const isSorted = sortRight.col === col.key;
                    return (
                      <th
                        key={`th-right-${col.key}`}
                        onClick={() => handleToggleSortRight(col.key)}
                        style={{ minWidth: col.minWidth }}
                        className={`px-2.5 py-1.5 text-left border-r border-slate-200/70 cursor-pointer hover:bg-slate-200/80 transition-colors uppercase tracking-wider text-[10px] select-none ${
                          col.align === "right" ? "text-right" : col.align === "center" ? "text-center" : "text-left"
                        } ${isSorted ? "bg-blue-100/60 text-blue-900" : ""}`}
                        title={`Klik untuk sort ${col.label}`}
                      >
                        <div className={`flex items-center gap-1 ${col.align === "right" ? "justify-end" : col.align === "center" ? "justify-center" : "justify-start"}`}>
                          <span className="truncate">{col.label}</span>
                          {isSorted ? (
                            sortRight.dir === "asc" ? (
                              <ArrowUp className="h-3 w-3 text-blue-700 shrink-0" />
                            ) : (
                              <ArrowDown className="h-3 w-3 text-blue-700 shrink-0" />
                            )
                          ) : (
                            <ArrowUpDown className="h-2.5 w-2.5 text-slate-300 hover:text-slate-500 shrink-0" />
                          )}
                        </div>
                      </th>
                    );
                  })}

                  {/* Fast Action Column */}
                  <th className="w-12 px-1 text-center font-bold uppercase text-[9.5px]">Aksi</th>
                </tr>

                {/* 2. Optional Independent Filter Input Row */}
                {showFilterRowRight && (
                  <tr className="bg-blue-50/70 border-b border-blue-200/80 text-[10px]">
                    <th className="sticky left-0 z-40 bg-blue-50/90 px-1 py-1 text-center border-r border-slate-200">
                      <span className="text-[9px] text-blue-700 font-mono">🔍</span>
                    </th>
                    {COLUMNS.map((col) => (
                      <th key={`filter-right-${col.key}`} className="px-1.5 py-1 border-r border-slate-200/60">
                        <input
                          type="text"
                          placeholder={`Filter...`}
                          value={colFiltersRight[col.key] || ""}
                          onChange={(e) =>
                            setColFiltersRight((prev) => ({
                              ...prev,
                              [col.key]: e.target.value,
                            }))
                          }
                          className="w-full px-1.5 py-0.5 text-[10px] font-normal rounded border border-slate-200 bg-white text-slate-800 placeholder:text-slate-300 focus:outline-none focus:border-blue-500"
                        />
                      </th>
                    ))}
                    <th className="px-1 py-1 text-center">
                      {activeFiltersRightCount > 0 && (
                        <button
                          onClick={() => setColFiltersRight({})}
                          className="text-[9px] text-blue-700 underline hover:text-rose-600 cursor-pointer"
                        >
                          Clear
                        </button>
                      )}
                    </th>
                  </tr>
                )}
              </thead>

              {/* Table Body */}
              <tbody className="divide-y divide-slate-100">
                {filteredAssigned.length === 0 ? (
                  <tr>
                    <td colSpan={14} className="py-12 text-center text-slate-400">
                      <Truck className="h-6 w-6 opacity-30 text-blue-500 mb-1 mx-auto" />
                      <span>Belum ada stop yang ditugaskan ke armada ini</span>
                    </td>
                  </tr>
                ) : (
                  filteredAssigned.map((outlet, idx) => {
                    const isSelected = selectedRight.has(outlet.custno);
                    return (
                      <tr
                        key={outlet.custno}
                        onClick={() => {
                          toggleSelectRight(outlet.custno);
                          onClickUnassignedOutlet?.(outlet);
                        }}
                        className={`group cursor-pointer transition-colors ${
                          isSelected
                            ? "bg-blue-50/80 hover:bg-blue-100/70"
                            : "hover:bg-slate-50/90 text-slate-700"
                        }`}
                      >
                        {/* Sticky Checkbox & Stop # */}
                        <td
                          className={`sticky left-0 z-20 px-2 py-1.5 text-center border-r border-slate-200 shadow-[1px_0_0_0_#e2e8f0] ${
                            isSelected ? "bg-blue-50" : "bg-white group-hover:bg-slate-50"
                          }`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="flex items-center justify-center gap-1.5">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => toggleSelectRight(outlet.custno)}
                              className="rounded border-slate-300 text-blue-600 cursor-pointer"
                            />
                            <span className="h-4 w-4 shrink-0 rounded-full bg-slate-200 text-slate-700 font-mono text-[9px] font-bold flex items-center justify-center">
                              {idx + 1}
                            </span>
                          </div>
                        </td>

                        {/* 12 Data Columns */}
                        {COLUMNS.map((col) => {
                          const val = col.getValue(outlet);
                          return (
                            <td
                              key={`cell-right-${col.key}-${outlet.custno}`}
                              style={{ minWidth: col.minWidth }}
                              className={`px-2.5 py-1.5 border-r border-slate-100 whitespace-nowrap overflow-hidden text-ellipsis ${
                                col.align === "right"
                                  ? "text-right"
                                  : col.align === "center"
                                  ? "text-center"
                                  : "text-left"
                              }`}
                            >
                              {col.format ? col.format(val, outlet) : val}
                            </td>
                          );
                        })}

                        {/* Fast Move Action */}
                        <td className="px-1 py-1 text-center" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={() => transferToUnassigned([outlet.custno])}
                            title="Kembalikan ke Pool"
                            className="p-1 rounded hover:bg-amber-100 text-slate-400 hover:text-amber-700 transition-colors cursor-pointer"
                          >
                            <ChevronLeft className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

      </div>

      {/* ── 4. LIVE SUMMARY FOOTER: REAL-TIME VEHICLE CAPACITY & SAVE BUTTON ── */}
      <div className="h-14 px-5 bg-white border-t border-slate-200 flex items-center justify-between gap-4 shrink-0 shadow-lg">
        {/* Live Capacity Indicators */}
        <div className="flex items-center gap-6 min-w-0">
          {/* Volume Capacity Indicator */}
          <div className="flex items-center gap-2.5">
            <div className="text-[11px]">
              <div className="flex items-center gap-1 text-slate-500 font-semibold">
                <Box className="h-3.5 w-3.5" />
                <span>Volume:</span>
                <span className={`font-mono font-bold ${isOverM3 ? "text-rose-600" : "text-slate-800"}`}>
                  {currentM3.toFixed(2)} / {vehicle?.KUBIKASE} m³
                </span>
              </div>
              <div className="w-32 h-1.5 bg-slate-100 rounded-full overflow-hidden border border-slate-200 mt-1">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${
                    m3Pct > 100
                      ? "bg-rose-500 animate-pulse"
                      : m3Pct >= 80
                      ? "bg-emerald-500"
                      : "bg-blue-500"
                  }`}
                  style={{ width: `${Math.min(m3Pct, 100)}%` }}
                />
              </div>
            </div>
            <span
              className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded ${
                isOverM3
                  ? "bg-rose-100 text-rose-700 border border-rose-200"
                  : m3Pct >= 80
                  ? "bg-emerald-100 text-emerald-700"
                  : "bg-slate-100 text-slate-700"
              }`}
            >
              {m3Pct.toFixed(0)}%
            </span>
          </div>

          {/* Weight Capacity Indicator */}
          <div className="flex items-center gap-2.5">
            <div className="text-[11px]">
              <div className="flex items-center gap-1 text-slate-500 font-semibold">
                <Truck className="h-3.5 w-3.5" />
                <span>Weight:</span>
                <span className={`font-mono font-bold ${isOverKg ? "text-rose-600" : "text-slate-800"}`}>
                  {currentKg.toFixed(0)} / {vehicle?.TONASE} kg
                </span>
              </div>
              <div className="w-32 h-1.5 bg-slate-100 rounded-full overflow-hidden border border-slate-200 mt-1">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${
                    kgPct > 100
                      ? "bg-rose-500 animate-pulse"
                      : kgPct >= 80
                      ? "bg-emerald-500"
                      : "bg-indigo-500"
                  }`}
                  style={{ width: `${Math.min(kgPct, 100)}%` }}
                />
              </div>
            </div>
            <span
              className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded ${
                isOverKg
                  ? "bg-rose-100 text-rose-700 border border-rose-200"
                  : kgPct >= 80
                  ? "bg-emerald-100 text-emerald-700"
                  : "bg-slate-100 text-slate-700"
              }`}
            >
              {kgPct.toFixed(0)}%
            </span>
          </div>

          {/* Max EPE Pill & Overload Alert */}
          <div className="flex items-center gap-2">
            <span
              className={`px-2.5 py-1 rounded-xl text-xs font-bold flex items-center gap-1 border ${
                isOverloaded
                  ? "bg-rose-100 text-rose-800 border-rose-300"
                  : maxEpePct >= 80
                  ? "bg-emerald-100 text-emerald-800 border-emerald-300"
                  : "bg-slate-100 text-slate-700 border-slate-200"
              }`}
            >
              {isOverloaded && <AlertTriangle className="h-3 w-3" />}
              <span>Max EPE: {maxEpePct.toFixed(1)}%</span>
            </span>

            {isOverloaded && (
              <span className="text-[11px] text-rose-600 font-bold hidden xl:inline">
                ⚠️ Kapasitas armada terlampaui!
              </span>
            )}

            {compatibilityWarnings.length > 0 && !isOverloaded && (
              <span className="text-[11px] text-amber-700 font-medium truncate max-w-xs" title={compatibilityWarnings[0]}>
                ⚠️ {compatibilityWarnings[0]}
              </span>
            )}
          </div>
        </div>

        {/* Footer Actions: Reset, Hitung Ulang Rute (OSRM), Selesai / Tutup */}
        <div className="flex items-center gap-2.5 shrink-0">
          <button
            onClick={handleReset}
            disabled={isSaving}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-200 text-slate-600 hover:bg-slate-100 text-xs font-semibold transition-all disabled:opacity-50 cursor-pointer"
            title="Reset perubahan lokal kembali ke awal"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>Reset</span>
          </button>

          <button
            onClick={handleReorderRoute}
            disabled={isSaving || hasHardViolation}
            className={`flex items-center gap-2 px-4 py-1.5 rounded-xl text-xs font-bold shadow-md transition-all cursor-pointer ${
              hasHardViolation
                ? "bg-slate-300 text-slate-500 cursor-not-allowed shadow-none"
                : "bg-blue-600 hover:bg-blue-700 text-white shadow-blue-500/20 disabled:opacity-50"
            }`}
            title={hasHardViolation ? "Perbaiki pelanggaran constraint sebelum Hitung Ulang" : "Urutkan ulang rute armada ini via OSRM tanpa menutup drawer"}
          >
            {isSaving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : hasHardViolation ? (
              <AlertTriangle className="h-3.5 w-3.5 text-rose-500" />
            ) : (
              <Zap className="h-3.5 w-3.5" />
            )}
            <span>Hitung Ulang Rute (OSRM)</span>
          </button>

          <button
            onClick={onClose}
            disabled={isSaving}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-900 text-white text-xs font-bold shadow-sm transition-all cursor-pointer"
            title="Selesai mengedit dan tutup drawer"
          >
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
            <span>Selesai / Tutup</span>
          </button>
        </div>
      </div>

    </div>
  );
}
