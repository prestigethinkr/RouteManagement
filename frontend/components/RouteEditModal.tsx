"use client";

import React, { useState, useMemo } from "react";
import {
  X,
  Truck,
  AlertTriangle,
  ArrowRight,
  Box,
  Scale,
  MapPin,
  AlertCircle,
  Search,
} from "lucide-react";
import type { PendingOutlet, AssignedRoute, Vehicle } from "@/lib/types";

interface RouteEditModalProps {
  isOpen: boolean;
  onClose: () => void;
  outlet: PendingOutlet | null;
  sourceVehicle: Vehicle | null; // null if coming from unassigned pool
  routes: AssignedRoute[];
  onConfirmMove: (targetVehicleId: string) => void;
}

export default function RouteEditModal({
  isOpen,
  onClose,
  outlet,
  sourceVehicle,
  routes,
  onConfirmMove,
}: RouteEditModalProps) {
  const [selectedVehicleId, setSelectedVehicleId] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [allowOverload, setAllowOverload] = useState<boolean>(false);

  // Filter routes (exclude source vehicle if moving from a vehicle)
  const candidateRoutes = useMemo(() => {
    return routes.filter((r) => {
      if (sourceVehicle && r.vehicle.NO_KEND === sourceVehicle.NO_KEND) {
        return false;
      }
      if (!searchQuery) return true;
      const q = searchQuery.toLowerCase();
      return (
        r.vehicle.NO_KEND.toLowerCase().includes(q) ||
        r.vehicle.JNS_KEND.toLowerCase().includes(q) ||
        (r.vehicle.ZONES?.some((z) => z.toLowerCase().includes(q)) ?? false)
      );
    });
  }, [routes, sourceVehicle, searchQuery]);

  // Selected route data
  const selectedRoute = useMemo(() => {
    return routes.find((r) => r.vehicle.NO_KEND === selectedVehicleId) || null;
  }, [routes, selectedVehicleId]);

  // Capacity calculations for selected vehicle
  const validation = useMemo(() => {
    if (!outlet || !selectedRoute) return null;

    const v = selectedRoute.vehicle;
    const newM3 = selectedRoute.currentM3 + outlet.total_kubikasi_m3;
    const newKg = selectedRoute.currentKg + outlet.total_berat_kg;

    const m3Pct = v.KUBIKASE > 0 ? (newM3 / v.KUBIKASE) * 100 : 0;
    const kgPct = v.TONASE > 0 ? (newKg / v.TONASE) * 100 : 0;
    const maxPct = Math.max(m3Pct, kgPct);

    const isOverM3 = newM3 > v.KUBIKASE;
    const isOverKg = newKg > v.TONASE;
    const isOverloaded = isOverM3 || isOverKg;

    // Vehicle type compatibility check
    let isTypeCompatible = true;
    let typeWarning: string | null = null;
    if (outlet.allowed_vehicles && outlet.allowed_vehicles.length > 0) {
      isTypeCompatible = outlet.allowed_vehicles.includes(v.JNS_KEND);
      if (!isTypeCompatible) {
        typeWarning = `Restricted: Outlet requires [${outlet.allowed_vehicles.join(", ")}], but vehicle is ${v.JNS_KEND}`;
      }
    } else if (outlet.jns_kend && outlet.jns_kend.toUpperCase() !== "TRONTON") {
      if (outlet.jns_kend.toUpperCase().includes("DEMO") && !v.JNS_KEND.toUpperCase().includes("DEMO")) {
        isTypeCompatible = false;
        typeWarning = `Sample/Demo outlet requires Motor Demo, vehicle is ${v.JNS_KEND}`;
      }
    }

    // Zone compatibility check
    let isZoneCompatible = true;
    if (outlet.zone && v.ZONES && v.ZONES.length > 0) {
      isZoneCompatible = v.ZONES.includes("ALL") || v.ZONES.includes(outlet.zone);
    }

    return {
      newM3,
      newKg,
      m3Pct,
      kgPct,
      maxPct,
      isOverM3,
      isOverKg,
      isOverloaded,
      isTypeCompatible,
      typeWarning,
      isZoneCompatible,
    };
  }, [outlet, selectedRoute]);

  if (!isOpen || !outlet) return null;

  const handleConfirm = () => {
    if (!selectedVehicleId) return;
    if (validation?.isOverloaded && !allowOverload) return;
    onConfirmMove(selectedVehicleId);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[3000] flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="w-[620px] max-w-full bg-white border border-slate-200 shadow-2xl rounded-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-3.5 bg-slate-50 border-b border-slate-200 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-blue-50 border border-blue-200 text-blue-600">
              <Truck className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">
                {sourceVehicle ? "Reassign Outlet to Another Vehicle" : "Assign Unassigned Outlet to Fleet"}
              </h3>
              <p className="text-[11px] text-slate-500">
                {sourceVehicle
                  ? `Transfer from ${sourceVehicle.NO_KEND} (${sourceVehicle.JNS_KEND})`
                  : "Dispatch to an active vehicle route"}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Outlet Details Banner */}
        <div className="px-6 py-3 bg-blue-50/50 border-b border-blue-100 shrink-0">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-slate-900 truncate">
                  {outlet.custname}
                </span>
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-white text-slate-600 border border-blue-200 shadow-xs">
                  {outlet.custno}
                </span>
                {outlet.is_cross_zone_swept && (
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 border border-blue-200 shadow-xs uppercase tracking-wider">
                    Cross-Zone Swept
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 mt-1.5 text-[11px] text-slate-600">
                <span className="flex items-center gap-1 font-semibold text-blue-700">
                  <Box className="h-3 w-3" />
                  {outlet.total_kubikasi_m3.toFixed(3)} m³
                </span>
                <span>·</span>
                <span className="flex items-center gap-1 font-semibold text-amber-700">
                  <Scale className="h-3 w-3" />
                  {outlet.total_berat_kg.toFixed(1)} kg
                </span>
                {outlet.zone && (
                  <>
                    <span>·</span>
                    <span className="flex items-center gap-1 text-slate-600">
                      <MapPin className="h-3 w-3 text-slate-400" />
                      {outlet.zone}
                    </span>
                  </>
                )}
                {outlet.jns_kend && (
                  <>
                    <span>·</span>
                    <span className="text-[10px] text-purple-700 bg-purple-100/70 px-1.5 py-0.5 rounded border border-purple-200 font-medium">
                      Req: {outlet.jns_kend}
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Vehicle Selection List */}
        <div className="flex-1 overflow-hidden flex flex-col p-5 min-h-[220px]">
          <div className="flex items-center justify-between mb-2.5">
            <span className="text-xs font-bold text-slate-700">Select Target Vehicle:</span>
            <div className="relative w-52">
              <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                placeholder="Search fleet number / type..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-8 pr-2.5 py-1 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-blue-500 focus:bg-white"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto space-y-2 pr-1 scrollbar-thin scrollbar-thumb-slate-200">
            {candidateRoutes.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-400">No matching vehicles found</div>
            ) : (
              candidateRoutes.map((r) => {
                const isSelected = r.vehicle.NO_KEND === selectedVehicleId;
                const v = r.vehicle;
                const projM3 = r.currentM3 + outlet.total_kubikasi_m3;
                const projKg = r.currentKg + outlet.total_berat_kg;
                const projM3Pct = v.KUBIKASE > 0 ? (projM3 / v.KUBIKASE) * 100 : 0;
                const projKgPct = v.TONASE > 0 ? (projKg / v.TONASE) * 100 : 0;
                const maxPct = Math.max(projM3Pct, projKgPct);
                const isOver = maxPct > 100;

                return (
                  <div
                    key={v.NO_KEND}
                    onClick={() => {
                      setSelectedVehicleId(v.NO_KEND);
                      setAllowOverload(false);
                    }}
                    className={`p-3 rounded-xl border cursor-pointer transition-all ${
                      isSelected
                        ? "bg-blue-50/70 border-blue-500 shadow-sm ring-1 ring-blue-500"
                        : "bg-white border-slate-200 hover:bg-slate-50 hover:border-slate-300"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div
                          className="h-3 w-3 rounded-full shrink-0"
                          style={{ background: r.color }}
                        />
                        <span className="font-bold text-xs text-slate-900">{v.NO_KEND}</span>
                        <span className="text-[10px] text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200 font-medium">
                          {v.JNS_KEND}
                        </span>
                        <span className="text-[10px] text-slate-500">{r.outlets.length} stops</span>
                      </div>
                      <div className="flex items-center gap-2">
                        {isOver && (
                          <span className="flex items-center gap-1 text-[10px] font-bold text-rose-700 bg-rose-50 px-2 py-0.5 rounded-full border border-rose-200">
                            <AlertTriangle className="h-3 w-3" />
                            Overload {maxPct.toFixed(0)}%
                          </span>
                        )}
                        <span className="font-mono text-xs font-bold text-slate-700">
                          {maxPct.toFixed(0)}% Cap
                        </span>
                      </div>
                    </div>

                    {/* Projected Capacity Progress Bar */}
                    <div className="mt-2 space-y-1">
                      <div className="w-full bg-slate-100 rounded-full h-1.5 overflow-hidden">
                        <div
                          className={`h-full transition-all duration-300 ${
                            isOver ? "bg-rose-500" : maxPct >= 80 ? "bg-emerald-500" : "bg-blue-600"
                          }`}
                          style={{ width: `${Math.min(100, maxPct)}%` }}
                        />
                      </div>
                      <div className="flex items-center justify-between text-[10px] text-slate-500">
                        <span>
                          Vol: {r.currentM3.toFixed(2)} → <strong className="text-slate-800">{projM3.toFixed(2)}</strong> / {v.KUBIKASE} m³
                        </span>
                        <span>
                          Wt: {r.currentKg.toFixed(0)} → <strong className="text-slate-800">{projKg.toFixed(0)}</strong> / {v.TONASE} kg
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Live Validation Alert Box (if selected) */}
        {validation && (
          <div className="px-6 py-3 bg-slate-50 border-t border-slate-200 shrink-0">
            {validation.isOverloaded && (
              <div className="p-2.5 rounded-lg bg-rose-50 border border-rose-200 mb-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-rose-700 text-xs font-semibold">
                    <AlertCircle className="h-4 w-4 shrink-0 text-rose-600" />
                    <span>
                      Warning: Adding this outlet will overload vehicle ({validation.maxPct.toFixed(0)}% capacity)
                    </span>
                  </div>
                  <label className="flex items-center gap-1.5 text-[11px] font-medium text-rose-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={allowOverload}
                      onChange={(e) => setAllowOverload(e.target.checked)}
                      className="rounded border-rose-300 text-rose-600 focus:ring-0 h-3.5 w-3.5"
                    />
                    <span>Allow Overload</span>
                  </label>
                </div>
              </div>
            )}

            {!validation.isTypeCompatible && validation.typeWarning && (
              <div className="flex items-center gap-2 p-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-xs mb-2 font-medium">
                <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
                <span>{validation.typeWarning}</span>
              </div>
            )}

            {!validation.isZoneCompatible && (
              <div className="flex items-center gap-2 text-slate-500 text-[11px]">
                <MapPin className="h-3.5 w-3.5 text-slate-400" />
                <span>
                  Vehicle zone ({selectedRoute?.vehicle.ZONES?.join(", ") || "None"}) differs from outlet zone ({outlet.zone}).
                </span>
              </div>
            )}
          </div>
        )}

        {/* Footer Actions */}
        <div className="flex items-center justify-between px-6 py-3.5 bg-white border-t border-slate-200 shrink-0">
          <button
            onClick={onClose}
            className="px-3.5 py-1.5 text-xs font-semibold text-slate-600 hover:text-slate-900 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!selectedVehicleId || (validation?.isOverloaded && !allowOverload)}
            className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-semibold shadow-md shadow-blue-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            <span>Confirm Reassignment</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
