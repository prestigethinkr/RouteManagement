import * as React from "react";
import { cn } from "@/lib/utils";

interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  value: number;       // 0-100
  max?: number;
  label?: string;
}

const Progress = React.forwardRef<HTMLDivElement, ProgressProps>(
  ({ className, value, max = 100, label, ...props }, ref) => {
    const pct = Math.max(0, max > 0 ? (value / max) * 100 : 0);
    const barWidth = Math.min(100, pct);
    const isOver = pct > 100;
    const barColor = isOver
      ? "bg-red-600 animate-pulse"
      : pct >= 80
        ? "bg-green-500"
        : pct >= 50
          ? "bg-yellow-500"
          : "bg-red-500";
    const labelColor = isOver
      ? "text-red-400"
      : pct >= 80
        ? "text-green-400"
        : pct >= 50
          ? "text-yellow-400"
          : "text-red-400";
    return (
      <div ref={ref} className={cn("w-full", className)} {...props}>
        {label && (
          <div className="mb-1 flex items-center justify-between text-[10px]">
            <span className="text-slate-500 font-medium">{label}</span>
            <span className={cn("font-bold font-mono", labelColor)}>
              {pct.toFixed(0)}%
            </span>
          </div>
        )}
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100 border border-slate-200/60 shadow-inner">
          <div
            className={cn("h-full rounded-full transition-all duration-300", barColor)}
            style={{ width: `${barWidth}%` }}
          />
        </div>
      </div>
    );
  }
);

Progress.displayName = "Progress";
export { Progress };
