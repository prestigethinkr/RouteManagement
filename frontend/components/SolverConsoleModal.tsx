"use client";

import { useEffect, useRef, useState } from "react";
import {
  Terminal,
  X,
  Maximize2,
  Minimize2,
  ChevronDown,
  ChevronUp,
  Copy,
  Check,
  Trash2,
  Loader2,
  CheckCircle2,
} from "lucide-react";

export interface SolverLogItem {
  time: string;
  stage: string;
  percent: number;
  message: string;
  level: string;
}

interface SolverConsoleModalProps {
  isOpen: boolean;
  onClose: () => void;
  isMinimized?: boolean;
  onToggleMinimize?: () => void;
  logs: SolverLogItem[];
  progress: number;
  currentStage: string;
  isSolving: boolean;
  onClearLogs?: () => void;
}

export default function SolverConsoleModal({
  isOpen,
  onClose,
  logs,
  progress,
  currentStage,
  isSolving,
  onClearLogs,
}: SolverConsoleModalProps) {
  const [showLogs, setShowLogs] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [isCopied, setIsCopied] = useState(false);
  const [isExpandedFull, setIsExpandedFull] = useState(false);
  const logContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (showLogs && autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, autoScroll, showLogs]);

  if (!isOpen) return null;

  const getBadgeClass = (stage: string) => {
    switch (stage?.toUpperCase()) {
      case "INIT":
        return "bg-blue-50 text-blue-700 border-blue-200";
      case "OSRM":
        return "bg-cyan-50 text-cyan-700 border-cyan-200";
      case "SETUP":
        return "bg-purple-50 text-purple-700 border-purple-200";
      case "MATRIX":
        return "bg-indigo-50 text-indigo-700 border-indigo-200";
      case "CLUSTER":
        return "bg-violet-50 text-violet-700 border-violet-200";
      case "SOLVER":
        return "bg-emerald-50 text-emerald-700 border-emerald-200";
      case "PRUNE":
        return "bg-amber-50 text-amber-700 border-amber-200";
      case "EXCEL":
        return "bg-sky-50 text-sky-700 border-sky-200";
      case "MAP":
        return "bg-teal-50 text-teal-700 border-teal-200";
      case "DONE":
      case "READY":
        return "bg-green-50 text-green-700 border-green-200";
      case "ERROR":
        return "bg-rose-50 text-rose-700 border-rose-200";
      default:
        return "bg-slate-100 text-slate-600 border-slate-200";
    }
  };

  const copyAllLogs = () => {
    const text = logs
      .map((l) => `[${l.time}] [${l.stage}] (${l.percent}%) ${l.message}`)
      .join("\n");
    navigator.clipboard.writeText(text);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  };

  const latestLog = logs.length > 0 ? logs[logs.length - 1] : null;

  return (
    <div
      className={`fixed z-[2500] transition-all duration-300 ease-in-out ${
        isExpandedFull
          ? "top-4 bottom-4 left-4 right-4"
          : "bottom-5 right-5 w-[560px] max-w-[92vw] max-h-[85vh]"
      } flex flex-col bg-white/95 backdrop-blur-xl border border-slate-200 shadow-2xl shadow-slate-900/15 rounded-2xl overflow-hidden`}
    >
      {/* ── Mid-Top Bar Header ────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-slate-50/80 border-b border-slate-200 shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="p-1.5 rounded-lg bg-blue-50 border border-blue-200 text-blue-600 shrink-0">
            {isSolving ? (
              <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
            ) : progress === 100 ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            ) : (
              <Terminal className="h-4 w-4 text-blue-600" />
            )}
          </div>
          <div className="flex items-center gap-2 truncate">
            <span className="text-xs font-bold text-slate-900 uppercase tracking-wider shrink-0">
              Log Proses Dispatch
            </span>
            <span
              className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-md border shrink-0 tracking-wider ${getBadgeClass(
                currentStage || "INIT"
              )}`}
            >
              {currentStage || "READY"}
            </span>
          </div>
        </div>

        {/* Right side: Percent, Toggle Logs Button, Maximize, Close */}
        <div className="flex items-center gap-2 shrink-0">
          <span className="font-mono text-xs font-bold text-blue-700 bg-blue-50 px-2 py-0.5 rounded-md border border-blue-200">
            {progress}%
          </span>

          {/* Toggle Hide/Unhide Logs */}
          <button
            onClick={() => setShowLogs(!showLogs)}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition-colors ${
              showLogs
                ? "bg-blue-50 border-blue-300 text-blue-700"
                : "bg-white border-slate-200 text-slate-700 hover:bg-slate-50 hover:text-slate-900"
            }`}
            title={showLogs ? "Hide detailed logs" : "Unhide detailed logs"}
          >
            <Terminal className="h-3 w-3 text-blue-600" />
            <span>{showLogs ? "Hide Logs" : `Logs (${logs.length})`}</span>
            {showLogs ? (
              <ChevronUp className="h-3 w-3" />
            ) : (
              <ChevronDown className="h-3 w-3" />
            )}
          </button>

          {showLogs && (
            <button
              onClick={() => setIsExpandedFull(!isExpandedFull)}
              title={isExpandedFull ? "Restore size" : "Maximize"}
              className="p-1 rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition-colors"
            >
              {isExpandedFull ? (
                <Minimize2 className="h-3.5 w-3.5" />
              ) : (
                <Maximize2 className="h-3.5 w-3.5" />
              )}
            </button>
          )}

          <button
            onClick={onClose}
            title="Close"
            className="p-1 rounded-md text-slate-400 hover:bg-slate-100 hover:text-rose-600 transition-colors"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* ── Percentage Bar Row (Always visible) ────────────────────────── */}
      <div className="px-4 py-2.5 bg-white shrink-0">
        <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden shadow-inner">
          <div
            className="h-full bg-gradient-to-r from-blue-600 via-indigo-600 to-emerald-500 transition-all duration-300 ease-out"
            style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
          />
        </div>
        <div className="flex items-center justify-between text-[11px] text-slate-500 mt-1.5 gap-2">
          <span
            className="truncate font-mono text-[10.5px] text-slate-600 flex-1"
            title={latestLog?.message}
          >
            {latestLog ? latestLog.message : "Ready for optimization"}
          </span>
          {isSolving ? (
            <span className="shrink-0 text-[10.5px] text-blue-600 flex items-center gap-1 font-semibold">
              <span className="h-1.5 w-1.5 rounded-full bg-blue-600 animate-pulse" />
              Optimizing
            </span>
          ) : progress === 100 ? (
            <span className="shrink-0 text-[10.5px] text-emerald-600 flex items-center gap-1 font-semibold">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Finished
            </span>
          ) : null}
        </div>
      </div>

      {/* ── Unhidden Detailed Terminal Logs Body ───────────────────────── */}
      {showLogs && (
        <div className="border-t border-slate-200 flex flex-col flex-1 min-h-0">
          <div
            ref={logContainerRef}
            className={`${
              isExpandedFull ? "flex-1" : "max-h-[350px]"
            } overflow-y-auto p-3.5 font-mono text-[11px] leading-relaxed bg-slate-950 text-slate-100 space-y-1 select-text scrollbar-thin scrollbar-thumb-slate-800`}
          >
            {logs.length === 0 ? (
              <div className="py-8 flex flex-col items-center justify-center text-slate-400 text-xs italic">
                <Loader2 className="h-5 w-5 animate-spin mb-2 opacity-50" />
                Connecting to solver stream…
              </div>
            ) : (
              logs.map((log, idx) => (
                <div
                  key={idx}
                  className="flex items-start gap-2 hover:bg-slate-900 px-1.5 py-0.5 rounded transition-colors"
                >
                  <span className="text-slate-500 text-[10px] shrink-0 pt-0.5">
                    {log.time}
                  </span>
                  <span
                    className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border shrink-0 tracking-wider ${
                      log.stage === "SOLVER"
                        ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
                        : log.stage === "OSRM"
                        ? "bg-cyan-500/20 text-cyan-300 border-cyan-500/30"
                        : "bg-slate-800 text-slate-300 border-slate-700"
                    }`}
                  >
                    {log.stage}
                  </span>
                  <span className="text-slate-200 break-words flex-1">
                    {log.message}
                  </span>
                </div>
              ))
            )}
          </div>

          {/* Console Footer Toolbar */}
          <div className="flex items-center justify-between px-4 py-2 bg-slate-50 border-t border-slate-200 text-[11px] text-slate-600 shrink-0">
            <div className="flex items-center gap-3">
              <span className="font-medium">{logs.length} events logged</span>
              <label className="flex items-center gap-1.5 cursor-pointer text-slate-600 hover:text-slate-900">
                <input
                  type="checkbox"
                  checked={autoScroll}
                  onChange={(e) => setAutoScroll(e.target.checked)}
                  className="rounded border-slate-300 bg-white text-blue-600 focus:ring-0 h-3 w-3"
                />
                Auto-scroll
              </label>
            </div>

            <div className="flex items-center gap-2">
              {onClearLogs && (
                <button
                  onClick={onClearLogs}
                  title="Clear Console"
                  className="flex items-center gap-1 px-2 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors text-[10.5px] font-medium"
                >
                  <Trash2 className="h-3 w-3" />
                  Clear
                </button>
              )}
              <button
                onClick={copyAllLogs}
                title="Copy Logs to Clipboard"
                className="flex items-center gap-1 px-2.5 py-1 rounded bg-blue-50 border border-blue-200 text-blue-700 hover:bg-blue-100 transition-colors text-[10.5px] font-semibold"
              >
                {isCopied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                {isCopied ? "Copied" : "Copy Logs"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
