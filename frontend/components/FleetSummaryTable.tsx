"use client";

import type { AssignedRoute } from "@/lib/types";
import { X } from "lucide-react";

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
  if (p >= 80) return "text-emerald-600";
  if (p >= 60) return "text-amber-500";
  return "text-red-500";
}

// ---------------------------------------------------------------------------
// Row type
// ---------------------------------------------------------------------------
interface SummaryRow {
  noKend: string;
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

function buildRows(routes: AssignedRoute[]): SummaryRow[] {
  return routes.map((r) => {
    const pctKubik  = pct(r.currentM3, r.vehicle.KUBIKASE);
    const pctTonase = pct(r.currentKg, r.vehicle.TONASE);
    return {
      noKend:    r.vehicle.NO_KEND,
      jenis:     r.vehicle.JNS_KEND,
      outlets:   r.outlets.length,
      kubikasi:  r.currentM3,
      stdKubik:  r.vehicle.KUBIKASE,
      pctKubik,
      tonase:    r.currentKg,
      stdTonase: r.vehicle.TONASE,
      pctTonase,
      pctMaxEpe: Math.max(pctKubik, pctTonase),
      color:     r.color,
    };
  });
}

// ---------------------------------------------------------------------------
// Global stats
// ---------------------------------------------------------------------------
interface GlobalStats {
  totalOutlet: number;
  totalFaktur: number;
  totalKendaraan: number;
  totalKubikasi: number;
  avgPctKubik: number;
  avgPctTonase: number;
  avgPctEpe: number;
}

function buildGlobalStats(routes: AssignedRoute[], rows: SummaryRow[]): GlobalStats {
  const totalOutlet    = rows.reduce((s, r) => s + r.outlets, 0);
  const totalFaktur    = routes.reduce(
    (s, r) => s + r.outlets.reduce((si, o) => si + o.invoices.length, 0), 0
  );
  const totalKendaraan = routes.length;
  const totalKubikasi  = rows.reduce((s, r) => s + r.kubikasi, 0);
  const avgPctKubik    = rows.length > 0 ? rows.reduce((s, r) => s + r.pctKubik, 0)  / rows.length : 0;
  const avgPctTonase   = rows.length > 0 ? rows.reduce((s, r) => s + r.pctTonase, 0) / rows.length : 0;
  const avgPctEpe      = rows.length > 0 ? rows.reduce((s, r) => s + r.pctMaxEpe, 0) / rows.length : 0;
  return { totalOutlet, totalFaktur, totalKendaraan, totalKubikasi, avgPctKubik, avgPctTonase, avgPctEpe };
}

// ---------------------------------------------------------------------------
// Stat card — light mode
// ---------------------------------------------------------------------------
function StatCard({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg bg-slate-50 px-4 py-3 border border-slate-200">
      <p className="text-[9px] font-semibold uppercase tracking-widest text-slate-400">{label}</p>
      <p className={`text-base font-bold ${valueClass ?? "text-slate-900"}`}>{value}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
interface FleetSummaryTableProps {
  routes: AssignedRoute[];
  algorithm: "ortools" | "pyhygese";
  onClose: () => void;
}

export default function FleetSummaryTable({ routes, algorithm, onClose }: FleetSummaryTableProps) {
  const rows  = buildRows(routes);
  const stats = buildGlobalStats(routes, rows);

  const algoLabel = algorithm === "ortools" ? "OR-Tools" : "HGS-CVRP";

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-[2000] flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Dialog — light mode card */}
      <div className="relative w-full max-w-[95vw] max-h-[90vh] flex flex-col bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">

        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-5 py-3.5 border-b border-slate-200 bg-white">
          <div>
            <p className="text-sm font-bold text-slate-900 tracking-wide">
              Fleet Utilization Summary
              <span className="ml-2 text-[10px] font-semibold uppercase tracking-widest px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">
                {algoLabel}
              </span>
            </p>
            <p className="text-[10px] text-slate-500 mt-0.5">
              {stats.totalKendaraan} vehicle(s) · {stats.totalOutlet} stop(s) · {stats.totalFaktur} invoice(s)
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition-colors"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Scrollable table area */}
        <div className="overflow-auto flex-1">
          <table className="w-full text-xs border-collapse">
            <thead className="sticky top-0 z-10 bg-slate-50 border-b border-slate-200">
              <tr>
                {[
                  "NOKEND",
                  "JENIS",
                  "OUTLET",
                  "KUBIKASI",
                  "STD KUBIK",
                  "% KUBIK",
                  "TONASE",
                  "STD TONASE",
                  "% TONASE",
                  "% MAX EPE",
                ].map((col) => (
                  <th
                    key={col}
                    className="px-4 py-2.5 text-left font-semibold uppercase tracking-widest text-slate-500 whitespace-nowrap"
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>

            <tbody>
              {rows.map((row, idx) => (
                <tr
                  key={row.noKend}
                  className={`border-b border-slate-100 transition-colors hover:bg-blue-50/40 ${
                    idx % 2 === 0 ? "bg-white" : "bg-slate-50/60"
                  }`}
                >
                  {/* NOKEND */}
                  <td className="px-4 py-2 whitespace-nowrap">
                    <span className="flex items-center gap-2">
                      <span
                        className="inline-block h-2.5 w-2.5 rounded-full shrink-0"
                        style={{ background: row.color }}
                      />
                      <span className="font-semibold text-slate-900">{row.noKend}</span>
                    </span>
                  </td>
                  {/* JENIS */}
                  <td className="px-4 py-2 text-slate-500 whitespace-nowrap">{row.jenis}</td>
                  {/* OUTLET */}
                  <td className="px-4 py-2 text-center text-slate-900 font-medium">{row.outlets}</td>
                  {/* KUBIKASI */}
                  <td className="px-4 py-2 text-right text-slate-900">{fmtNum(row.kubikasi)}</td>
                  {/* STD KUBIK */}
                  <td className="px-4 py-2 text-right text-slate-400">{fmtNum(row.stdKubik)}</td>
                  {/* % KUBIK */}
                  <td className="px-4 py-2 text-right">
                    <span className={row.pctKubik >= 80 ? "text-emerald-600 font-medium" : row.pctKubik >= 60 ? "text-amber-500 font-medium" : "text-slate-400"}>
                      {fmtPct(row.pctKubik)}
                    </span>
                  </td>
                  {/* TONASE */}
                  <td className="px-4 py-2 text-right text-slate-900">{fmtNum(row.tonase)}</td>
                  {/* STD TONASE */}
                  <td className="px-4 py-2 text-right text-slate-400">{fmtNum(row.stdTonase)}</td>
                  {/* % TONASE */}
                  <td className="px-4 py-2 text-right">
                    <span className={row.pctTonase >= 80 ? "text-emerald-600 font-medium" : row.pctTonase >= 60 ? "text-amber-500 font-medium" : "text-slate-400"}>
                      {fmtPct(row.pctTonase)}
                    </span>
                  </td>
                  {/* % MAX EPE */}
                  <td className="px-4 py-2 text-right">
                    <span className={`font-bold ${maxEpeColor(row.pctMaxEpe)}`}>
                      {fmtPct(row.pctMaxEpe)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Global summary stat cards */}
        <div className="shrink-0 border-t border-slate-200 bg-white px-5 py-4">
          <p className="text-[9px] font-semibold uppercase tracking-widest text-slate-400 mb-3">Global Summary</p>
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
            <StatCard label="Total Outlet"     value={String(stats.totalOutlet)} />
            <StatCard label="Total Faktur"     value={String(stats.totalFaktur)} />
            <StatCard label="Total Kendaraan"  value={String(stats.totalKendaraan)} />
            <StatCard label="Total Kubikasi"   value={fmtNum(stats.totalKubikasi)} />
            <StatCard label="% Avg Kubikasi"   value={fmtPct(stats.avgPctKubik)}   valueClass={maxEpeColor(stats.avgPctKubik)} />
            <StatCard label="% Avg Tonase"     value={fmtPct(stats.avgPctTonase)}  valueClass={maxEpeColor(stats.avgPctTonase)} />
            <StatCard label="% Avg EPE"        value={fmtPct(stats.avgPctEpe)}     valueClass={maxEpeColor(stats.avgPctEpe)} />
          </div>
        </div>

      </div>
    </div>
  );
}
