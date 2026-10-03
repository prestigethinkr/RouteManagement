-- ============================================================================
-- get_dataKendaraan.sql (Oracle 10g / 11g / 12c / 19c Compatible)
-- Matrix ERP -> CVRP Optimization: Active Fleet & Vehicle Zones
--
-- CARA PENGGUNAAN DI DBEAVER:
-- 1. Jalankan query (Ctrl + Enter)
-- 2. Klik kanan hasil tabel -> "Export Data" -> pilih "XLSX" -> Simpan sebagai Vehicles.xlsx
-- 3. Upload Vehicles.xlsx ke Web UI CVRP (Tombol: 2. Upload Fleet)
-- ============================================================================

SELECT
    a.jns_kend AS jns_kend,
    a.no_kend AS no_kend,
    a.kubikase AS kubikase,
    a.weightload AS tonase,
    b.assigned_zones AS zones
FROM ftable03 a
LEFT JOIN (
    SELECT
        no_kend,
        MIN(groupkecamatan) AS assigned_zones
    FROM farmadavskecamatan
    WHERE groupkecamatan IS NOT NULL
    GROUP BY no_kend
) b ON a.no_kend = b.no_kend
WHERE a.statusaktif = 'AKTIF'
  AND a.kubikase <= 999
ORDER BY a.no_kend ASC;