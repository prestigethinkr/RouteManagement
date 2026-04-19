"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Truck } from "lucide-react";

const NAV_LINKS = [
  { href: "/admin/dashboard", label: "Fleet Dispatch", icon: LayoutDashboard },
];

export default function Navbar() {
  const pathname = usePathname();

  return (
    <nav className="flex h-12 shrink-0 items-center justify-between border-b border-gray-800 bg-gray-900 px-4">
      {/* Brand */}
      <Link href="/admin/dashboard" className="flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-600">
          <Truck className="h-4 w-4 text-white" />
        </div>
        <span className="hidden text-sm font-bold text-white sm:inline">RouteManager</span>
      </Link>

      {/* Links */}
      <div className="flex items-center gap-1">
        {NAV_LINKS.map(({ href, label, icon: Icon }) => {
          const isActive =
            pathname === href || pathname.startsWith(href + "/");
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                isActive
                  ? "bg-blue-600 text-white"
                  : "text-gray-400 hover:bg-gray-800 hover:text-gray-100"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
