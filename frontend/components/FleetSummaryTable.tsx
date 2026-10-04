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
  if (p >= 80) return "text-emerald-700 bg-emerald-50 border border-emerald-200";
  if (p >= 60) return "text-amber-700 bg-amber-50 border border-amber-200";
  return "text-rose-700 bg-rose-50 border border-rose-200";
}

// ---------------------------------------------------------------------------
// Row type
// ---------------------------------------------------------------------------
interface SummaryRow {
  recapNo: string;
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
    const pctKubik = pct(r.currentM3, r.vehicle.KUBIKASE);
    const pctTonase = pct(r.currentKg, r.vehicle.TONASE);
    return {
      recapNo: r.recap_no || "-",
      noKend: r.vehicle.NO_KEND,
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
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-xl bg-slate-50 px-3.5 py-2.5 border border-slate-200">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        {label}
      </p>
      <p className={`text-sm font-bold font-mono ${valueClass ?? "text-slate-800"}`}>
        {value}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
interface FleetSummaryTableProps {
  routes: AssignedRoute[];
  algorithm: "matrix" | "ortools" | "pyhygese";
  onClose: () => void;
}

export default function FleetSummaryTable({
  routes,
  algorithm,
  onClose,
}: FleetSummaryTableProps) {
  const rows = buildRows(routes);
  const stats = buildGlobalStats(routes, rows);

  const algoLabel =
    algorithm === "matrix"
      ? "OR-Tools (Matrix ERP)"
      : algorithm === "ortools"
      ? "OR-Tools (Baseline)"
      : "HGS-CVRP";

  return (
    /* Backdrop — centered */
    <div
      className="fixed inset-0 z-[2000] flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4 animate-in fade-in duration-200"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Dialog */}
      <div className="relative w-full max-w-[95vw] max-h-[90vh] flex flex-col bg-white border border-slate-200 rounded-2xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-6 py-3.5 border-b border-slate-200 bg-slate-50/70">
          <div>
            <div className="flex items-center gap-2.5">
              <h3 className="text-sm font-bold text-slate-900">
                Fleet Utilization Summary
              </h3>
              <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
                {algoLabel}
              </span>
            </div>
            <p className="text-[11px] text-slate-500 mt-0.5">
              {stats.totalKendaraan} vehicle(s) · {stats.totalOutlet} stop(s) ·{" "}
              {stats.totalFaktur} invoice(s)
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition-colors"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Scrollable table area */}
        <div className="overflow-auto flex-1">
          <table className="w-full text-xs border-collapse">
            <thead className="sticky top-0 z-10 bg-slate-100 border-b border-slate-200">
              <tr>
                {[
                  "NO REKAP",
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
                    className="px-4 py-2.5 text-left font-bold uppercase tracking-wider text-slate-600 whitespace-nowrap text-[10.5px]"
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
                    idx % 2 === 0 ? "bg-white" : "bg-slate-50/50"
                  }`}
                >
                  {/* NO REKAP */}
                  <td className="px-4 py-2 whitespace-nowrap font-mono text-[11px] font-bold text-amber-800">
                    {row.recapNo !== "-" ? `#${row.recapNo}` : "-"}
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
              ))}
            </tbody>
          </table>
        </div>

        {/* Global summary stat cards */}
        <div className="shrink-0 border-t border-slate-200 bg-white px-6 py-4">
          <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2.5">
            Global Summary
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 md:grid-cols-7">
            <StatCard label="Total Outlet" value={String(stats.totalOutlet)} />
            <StatCard label="Total Faktur" value={String(stats.totalFaktur)} />
            <StatCard
              label="Total Kendaraan"
              value={String(stats.totalKendaraan)}
            />
            <StatCard
              label="Total Kubikasi"
              value={fmtNum(stats.totalKubikasi)}
            />
            <StatCard
              label="% Avg Kubikasi"
              value={fmtPct(stats.avgPctKubik)}
              valueClass={
                stats.avgPctKubik >= 80 ? "text-emerald-600" : "text-amber-600"
              }
            />
            <StatCard
              label="% Avg Tonase"
              value={fmtPct(stats.avgPctTonase)}
              valueClass={
                stats.avgPctTonase >= 80 ? "text-emerald-600" : "text-amber-600"
              }
            />
            <StatCard
              label="% Avg EPE"
              value={fmtPct(stats.avgPctEpe)}
              valueClass={
                stats.avgPctEpe >= 80 ? "text-emerald-600" : "text-amber-600"
              }
            />
          </div>
        </div>
      </div>
    </div>
  );
}
