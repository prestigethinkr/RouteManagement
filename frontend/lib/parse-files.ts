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
  const headers = Object.keys(rows[0]).map((h) => cleanString(h).toUpperCase());
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
    const custno = cleanString(norm["CUSTNO"]);
    const invno = cleanString(norm["INVNO"]);
    if (!custno || !invno) continue;

    const { value: lat, ok: latOk } = sanitizeCoord(norm["LATITUDE"], "lat");
    const { value: lng, ok: lngOk } = sanitizeCoord(norm["LONGITUDE"], "lng");
    if (!latOk || !lngOk) {
      console.warn(`[parse-files] Skipping ${custno}/${invno}: invalid coords lat=${norm["LATITUDE"]} lng=${norm["LONGITUDE"]}`);
      continue;
    }
    const jnsKend = norm["JNS_KEND"] ? cleanString(norm["JNS_KEND"]) : undefined;
    const grouppayer = norm["GROUPPAYER"] ? cleanString(norm["GROUPPAYER"]) : undefined;
    const zone = norm["ZONE"] ? cleanString(norm["ZONE"]) : (norm["GROUPKECAMATAN"] ? cleanString(norm["GROUPKECAMATAN"]) : undefined);
    const kecamatan = norm["KECAMATAN"] ? cleanString(norm["KECAMATAN"]) : undefined;
    const kelurahan = norm["KELURAHAN"] ? cleanString(norm["KELURAHAN"]) : undefined;
    const alamat = norm["ALAMAT"] ? cleanString(norm["ALAMAT"]) : (norm["ADDRESS"] ? cleanString(norm["ADDRESS"]) : undefined);
    const allowedVehiclesRaw = norm["ALLOWED_VEHICLES"] ?? norm["RESTRICTED_VEHICLES"] ?? norm["ALLOWED_VEHICLE"];
    let allowed_vehicles = allowedVehiclesRaw ? cleanString(allowedVehiclesRaw).split(",").map((s) => cleanString(s)).filter(Boolean) : undefined;
    
    // In Matrix ERP, if jns_kend is set to specific vehicle (e.g. ENGKEL, MOTOR, CDD), map to allowed compatible vehicle types
    if (!allowed_vehicles && jnsKend && jnsKend.toUpperCase() !== "TRONTON" && jnsKend !== "") {
      const jk = jnsKend.toUpperCase();
      if (jk.includes("MOTOR")) {
        allowed_vehicles = ["MOTOR_(DEMO)"];
      } else if (jk.includes("GRANDMAX") || jk.includes("CARRY")) {
        allowed_vehicles = ["MOTOR_(DEMO)", "GRANDMAX_BV", "GRANDMAX", "CARRY", "L_300", "L_300_RATA KABIN"];
      } else if (jk.includes("L_300") || jk.includes("L300")) {
        allowed_vehicles = ["MOTOR_(DEMO)", "GRANDMAX_BV", "GRANDMAX", "CARRY", "L_300", "L_300_RATA KABIN"];
      } else if (jk.includes("ENGKEL")) {
        allowed_vehicles = [
          "MOTOR_(DEMO)", "GRANDMAX_BV", "GRANDMAX", "CARRY",
          "L_300", "L_300_RATA KABIN",
          "CD_ENGKEL_BOX_KECIL", "CD_ENGKEL_FE71"
        ];
      } else if (jk.includes("DOUBLE")) {
        allowed_vehicles = [
          "MOTOR_(DEMO)", "GRANDMAX_BV", "GRANDMAX", "CARRY",
          "L_300", "L_300_RATA KABIN",
          "CD_ENGKEL_BOX_KECIL", "CD_ENGKEL_FE71",
          "CD_DOUBLE_FE73"
        ];
      }
    }

    invoices.push({
      CUSTNO: custno,
      CUSTNAME: cleanString(norm["CUSTNAME"]),
      INVNO: invno,
      LATITUDE: lat,
      LONGITUDE: lng,
      TOTAL_NETO: toNum(norm["TOTAL_NETO"]),
      TOTAL_KUBIKASI_M3: toNum(norm["TOTAL_KUBIKASI_M3"]),
      TOTAL_BERAT_KG: toNum(norm["TOTAL_BERAT_KG"]),
      TOTAL_KARTON: toNum(norm["TOTAL_KARTON"]),
      JNS_KEND: jnsKend,
      GROUPPAYER: grouppayer,
      ZONE: zone,
      ALLOWED_VEHICLES: allowed_vehicles && allowed_vehicles.length > 0 ? allowed_vehicles.join(",") : undefined,
      KECAMATAN: kecamatan,
      KELURAHAN: kelurahan,
      ALAMAT: alamat,
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
      existing.total_karton = (existing.total_karton ?? 0) + inv.TOTAL_KARTON;
      existing.total_neto = (existing.total_neto ?? 0) + inv.TOTAL_NETO;
      if (!existing.grouppayer && inv.GROUPPAYER) existing.grouppayer = inv.GROUPPAYER;
      if (!existing.zone && inv.ZONE) existing.zone = inv.ZONE;
      if (!existing.kecamatan && inv.KECAMATAN) existing.kecamatan = inv.KECAMATAN;
      if (!existing.kelurahan && inv.KELURAHAN) existing.kelurahan = inv.KELURAHAN;
      if (!existing.alamat && inv.ALAMAT) existing.alamat = inv.ALAMAT;
      if (!existing.allowed_vehicles && inv.ALLOWED_VEHICLES) {
        existing.allowed_vehicles = inv.ALLOWED_VEHICLES.split(",").map((s) => cleanString(s)).filter(Boolean);
      }
    } else {
      grouped.set(inv.CUSTNO, {
        custno: inv.CUSTNO,
        custname: inv.CUSTNAME,
        lat: inv.LATITUDE,
        lng: inv.LONGITUDE,
        invoices: [inv],
        total_kubikasi_m3: inv.TOTAL_KUBIKASI_M3,
        total_berat_kg: inv.TOTAL_BERAT_KG,
        total_karton: inv.TOTAL_KARTON,
        total_neto: inv.TOTAL_NETO,
        jns_kend: inv.JNS_KEND ?? "TRONTON",
        grouppayer: inv.GROUPPAYER,
        zone: inv.ZONE,
        kecamatan: inv.KECAMATAN,
        kelurahan: inv.KELURAHAN,
        alamat: inv.ALAMAT,
        allowed_vehicles: inv.ALLOWED_VEHICLES ? inv.ALLOWED_VEHICLES.split(",").map((s) => cleanString(s)).filter(Boolean) : undefined,
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

  const headers = Object.keys(rows[0]).map((h) => cleanString(h).toUpperCase());
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
    const noKend = cleanString(norm["NO_KEND"]);
    if (!noKend || kubikase <= 0 || tonase <= 0) continue;

    const zonesRaw = norm["ZONES"] ?? norm["ASSIGNED_ZONES"] ?? norm["GROUPKECAMATAN"];
    const zones = zonesRaw ? cleanString(zonesRaw).split(",").map((s) => cleanString(s)).filter(Boolean) : undefined;
    const maxGp = toNum(norm["MAX_GROUPPAYER"] ?? norm["TMSMAXGROUPPAYER"]);

    vehicles.push({
      JNS_KEND: cleanString(norm["JNS_KEND"]),
      NO_KEND: noKend,
      KUBIKASE: kubikase,
      TONASE: tonase,
      ZONES: zones && zones.length > 0 ? zones : undefined,
      MAX_GROUPPAYER: maxGp > 0 ? maxGp : undefined,
    });
  }

  if (vehicles.length === 0) throw new Error("No valid vehicle rows found after parsing.");
  return vehicles;
}

// ---------------------------------------------------------------------------
// Delimited Text Parser (RFC 4180 + Pipe/Semicolon/Tab/Comma with Quotes)
// ---------------------------------------------------------------------------
export function parseDelimitedText(text: string, forcedDelimiter?: string): Record<string, unknown>[] {
  // Strip UTF-8 BOM if present
  let cleanText = text.replace(/^\uFEFF/, "");
  cleanText = cleanText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  let delimiter = forcedDelimiter;
  if (!delimiter) {
    const lines = cleanText.split("\n");
    let headerLine = "";
    for (const l of lines) {
      if (l.trim()) {
        headerLine = l;
        break;
      }
    }
    const pipes = (headerLine.match(/\|/g) || []).length;
    const tabs = (headerLine.match(/\t/g) || []).length;
    const semicolons = (headerLine.match(/;/g) || []).length;
    const commas = (headerLine.match(/,/g) || []).length;

    if (pipes > 0 && pipes >= commas && pipes >= semicolons) {
      delimiter = "|";
    } else if (tabs > 0 && tabs >= commas) {
      delimiter = "\t";
    } else if (semicolons > 0 && semicolons >= commas) {
      delimiter = ";";
    } else {
      delimiter = ",";
    }
  }

  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentVal = "";
  let inQuotes = false;

  for (let i = 0; i < cleanText.length; i++) {
    const char = cleanText[i];
    const nextChar = cleanText[i + 1];

    if (inQuotes) {
      if (char === '"') {
        if (nextChar === '"') {
          // Escaped quote ("")
          currentVal += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        currentVal += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === delimiter) {
        currentRow.push(currentVal.trim());
        currentVal = "";
      } else if (char === "\n") {
        currentRow.push(currentVal.trim());
        currentVal = "";
        if (currentRow.some((col) => col.length > 0)) {
          rows.push(currentRow);
        }
        currentRow = [];
      } else {
        currentVal += char;
      }
    }
  }

  if (currentVal.length > 0 || currentRow.length > 0) {
    currentRow.push(currentVal.trim());
    if (currentRow.some((col) => col.length > 0)) {
      rows.push(currentRow);
    }
  }

  if (rows.length === 0) return [];

  const headers = rows[0].map((h) => cleanString(h));
  const data: Record<string, unknown>[] = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const obj: Record<string, unknown> = {};
    for (let c = 0; c < headers.length; c++) {
      const header = headers[c];
      const rawVal = row[c] !== undefined ? cleanString(row[c]) : "";
      obj[header] = rawVal;
    }
    data.push(obj);
  }

  return data;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function readSheet(buffer: ArrayBuffer, filename: string): Record<string, unknown>[] {
  const lower = filename.toLowerCase();

  // Text-based files: CSV, TXT, TSV
  if (lower.endsWith(".csv") || lower.endsWith(".txt") || lower.endsWith(".tsv")) {
    const decoder = new TextDecoder("utf-8");
    const text = decoder.decode(buffer);

    // Auto-detect delimiter from the first non-empty header line
    const lines = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    let headerLine = "";
    for (const l of lines) {
      if (l.trim()) {
        headerLine = l;
        break;
      }
    }

    const pipes = (headerLine.match(/\|/g) || []).length;
    const tabs = (headerLine.match(/\t/g) || []).length;
    const semicolons = (headerLine.match(/;/g) || []).length;
    const commas = (headerLine.match(/,/g) || []).length;

    let delimiter = ",";
    if (pipes > 0 && pipes >= commas && pipes >= semicolons) {
      delimiter = "|";
    } else if (tabs > 0 && tabs >= commas) {
      delimiter = "\t";
    } else if (semicolons > 0 && semicolons >= commas) {
      delimiter = ";";
    }

    // Attempt high-accuracy custom parsing first
    try {
      const customRows = parseDelimitedText(text, delimiter);
      if (customRows.length > 0 && Object.keys(customRows[0]).length > 1) {
        return customRows;
      }
    } catch {
      // Fallback below
    }

    // Fallback to SheetJS with explicit delimiter
    const workbook = XLSX.read(text, { type: "string", FS: delimiter });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
  }

  // Excel spreadsheets: XLS, XLSX
  if (lower.endsWith(".xls") || lower.endsWith(".xlsx")) {
    const workbook = XLSX.read(buffer, { type: "array" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
  }

  throw new Error("Unsupported file type. Please upload .csv, .txt, .xls, or .xlsx");
}

function cleanString(val: unknown): string {
  if (val === null || val === undefined) return "";
  let s = String(val).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function normalizeKeys(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    const cleanK = cleanString(k).toUpperCase();
    out[cleanK] = typeof v === "string" ? cleanString(v) : v;
  }
  return out;
}

function toNum(val: unknown): number {
  if (val === null || val === undefined) return 0;
  let s = cleanString(val).replace(",", ".");
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

/**
 * Sanitize and validate a coordinate value from a spreadsheet cell.
 *
 * Excel sometimes stores coordinates as large integers when the decimal point
 * gets dropped (e.g. Indonesian longitudes like 119.85… become 11985…).
 * This function:
 *  1. Replaces comma-as-decimal-separator with a dot.
 *  2. Strips whitespace and surrounding quotes.
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
  let s = cleanString(raw)
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

