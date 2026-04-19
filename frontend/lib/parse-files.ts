import * as XLSX from "xlsx";
import type { RawInvoice, PendingOutlet, Vehicle } from "./types";

// ---------------------------------------------------------------------------
// Invoice file parser
// ---------------------------------------------------------------------------
const INVOICE_COLUMNS = [
  "CUSTNO", "CUSTNAME", "INVNO", "LATITUDE", "LONGITUDE",
  "TOTAL_NETO", "TOTAL_KUBIKASI_M3", "TOTAL_BERAT_KG", "TOTAL_KARTON",
] as const;

export function parseInvoiceFile(buffer: ArrayBuffer, filename: string): PendingOutlet[] {
  const rows = readSheet(buffer, filename);
  if (rows.length === 0) throw new Error("Invoice file contains no data rows.");

  // Validate required columns — normalize headers the same way normalizeKeys() does
  const headers = Object.keys(rows[0]).map((h) => h.trim().toUpperCase());
  const missing = INVOICE_COLUMNS.filter(
    (c) => !headers.includes(c)
  );
  if (missing.length > 0) {
    throw new Error(`Invoice file missing columns: ${missing.join(", ")}`);
  }

  // Normalize each row into RawInvoice
  const invoices: RawInvoice[] = [];
  for (const raw of rows) {
    const norm = normalizeKeys(raw);
    const custno = String(norm["CUSTNO"] ?? "").trim();
    const invno = String(norm["INVNO"] ?? "").trim();
    if (!custno || !invno) continue;

    const { value: lat, ok: latOk } = sanitizeCoord(norm["LATITUDE"], "lat");
    const { value: lng, ok: lngOk } = sanitizeCoord(norm["LONGITUDE"], "lng");
    if (!latOk || !lngOk) {
      console.warn(`[parse-files] Skipping ${custno}/${invno}: invalid coords lat=${norm["LATITUDE"]} lng=${norm["LONGITUDE"]}`);
      continue;
    }
    invoices.push({
      CUSTNO: custno,
      CUSTNAME: String(norm["CUSTNAME"] ?? "").trim(),
      INVNO: invno,
      LATITUDE: lat,
      LONGITUDE: lng,
      TOTAL_NETO: toNum(norm["TOTAL_NETO"]),
      TOTAL_KUBIKASI_M3: toNum(norm["TOTAL_KUBIKASI_M3"]),
      TOTAL_BERAT_KG: toNum(norm["TOTAL_BERAT_KG"]),
      TOTAL_KARTON: toNum(norm["TOTAL_KARTON"]),
      JNS_KEND: norm["JNS_KEND"] ? String(norm["JNS_KEND"]).trim() : undefined,
    });
  }

  if (invoices.length === 0) throw new Error("No valid invoice rows found after parsing.");

  // Group by CUSTNO → PendingOutlet[]
  const grouped = new Map<string, PendingOutlet>();
  for (const inv of invoices) {
    const existing = grouped.get(inv.CUSTNO);
    if (existing) {
      existing.invoices.push(inv);
      existing.total_kubikasi_m3 += inv.TOTAL_KUBIKASI_M3;
      existing.total_berat_kg += inv.TOTAL_BERAT_KG;
    } else {
      grouped.set(inv.CUSTNO, {
        custno: inv.CUSTNO,
        custname: inv.CUSTNAME,
        lat: inv.LATITUDE,
        lng: inv.LONGITUDE,
        invoices: [inv],
        total_kubikasi_m3: inv.TOTAL_KUBIKASI_M3,
        total_berat_kg: inv.TOTAL_BERAT_KG,
        jns_kend: inv.JNS_KEND ?? "TRONTON",
      });
    }
  }

  return [...grouped.values()];
}

// ---------------------------------------------------------------------------
// Vehicle fleet file parser
// ---------------------------------------------------------------------------
const VEHICLE_COLUMNS = ["JNS_KEND", "NO_KEND", "KUBIKASE", "TONASE"] as const;

export function parseVehicleFile(buffer: ArrayBuffer, filename: string): Vehicle[] {
  const rows = readSheet(buffer, filename);
  if (rows.length === 0) throw new Error("Vehicle file contains no data rows.");

  const headers = Object.keys(rows[0]).map((h) => h.trim().toUpperCase());
  const missing = VEHICLE_COLUMNS.filter(
    (c) => !headers.includes(c)
  );
  if (missing.length > 0) {
    throw new Error(`Vehicle file missing columns: ${missing.join(", ")}`);
  }

  const vehicles: Vehicle[] = [];
  for (const raw of rows) {
    const norm = normalizeKeys(raw);
    const kubikase = toNum(norm["KUBIKASE"]);
    const tonase = toNum(norm["TONASE"]);
    if (!norm["NO_KEND"] || kubikase <= 0 || tonase <= 0) continue;
    vehicles.push({
      JNS_KEND: String(norm["JNS_KEND"] ?? "").trim(),
      NO_KEND: String(norm["NO_KEND"]).trim(),
      KUBIKASE: kubikase,
      TONASE: tonase,
    });
  }

  if (vehicles.length === 0) throw new Error("No valid vehicle rows found after parsing.");
  return vehicles;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function readSheet(buffer: ArrayBuffer, filename: string): Record<string, unknown>[] {
  const lower = filename.toLowerCase();
  let workbook: XLSX.WorkBook;
  if (lower.endsWith(".csv")) {
    workbook = XLSX.read(buffer, { type: "array", raw: false });
  } else if (lower.endsWith(".xls") || lower.endsWith(".xlsx")) {
    workbook = XLSX.read(buffer, { type: "array" });
  } else {
    throw new Error("Unsupported file type. Please upload .csv, .xls, or .xlsx");
  }
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
}

function normalizeKeys(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k.trim().toUpperCase()] = v;
  }
  return out;
}

function toNum(val: unknown): number {
  const n = parseFloat(String(val ?? "0"));
  return isNaN(n) ? 0 : n;
}

/**
 * Sanitize and validate a coordinate value from a spreadsheet cell.
 *
 * Excel sometimes stores coordinates as large integers when the decimal point
 * gets dropped (e.g. Indonesian longitudes like 119.85… become 11985…).
 * This function:
 *  1. Replaces comma-as-decimal-separator with a dot.
 *  2. Strips whitespace.
 *  3. For longitude values that look like they lost their decimal point
 *     (start with "119" or "120" and have no dot), injects it after the
 *     3rd digit.
 *  4. Similarly handles latitude values starting with "0" or "-0" that may
 *     also have lost their decimal.
 *  5. Validates the result against WGS-84 bounds.
 */
function sanitizeCoord(
  raw: unknown,
  type: "lat" | "lng"
): { value: number; ok: boolean } {
  let s = String(raw ?? "")
    .replace(",", ".")
    .replace(/\s/g, "");

  const isNegative = s.startsWith("-");
  const abs = isNegative ? s.slice(1) : s;

  if (abs && !abs.includes(".")) {
    if (type === "lng") {
      // Indonesian longitudes valid range ~95–141°
      // Digit lengths without dot: 119.xxxxx → 8+ digits starting "119"/"120"/"1xx"
      if (/^1[0-9]{2}\d{4,}$/.test(abs)) {
        s = (isNegative ? "-" : "") + abs.substring(0, 3) + "." + abs.substring(3);
      }
    } else {
      // Indonesian latitudes: roughly -11° to +6°, abs starts with 0-11
      // e.g. -0.895… stored as -0895… (leading zero) or without
      if (/^0\d{4,}$/.test(abs)) {
        // starts with 0 → insert dot after first digit: 0.895…
        s = (isNegative ? "-" : "") + abs.substring(0, 1) + "." + abs.substring(1);
      } else if (/^[1-9]\d{4,}$/.test(abs) && parseInt(abs.substring(0, 2)) <= 11) {
        // starts with 1-9, second digit brings it to ≤11 degrees
        s = (isNegative ? "-" : "") + abs.substring(0, 1) + "." + abs.substring(1);
      }
    }
  }

  const value = parseFloat(s);
  const ok =
    !isNaN(value) &&
    (type === "lat" ? value >= -90 && value <= 90 : value >= -180 && value <= 180);

  return { value, ok };
}
