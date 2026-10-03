-- ============================================================================
-- get_dataPenjualan.sql (Oracle 10g / 11g / 12c / 19c Compatible)
-- Matrix ERP -> CVRP Optimization: Sales Invoices & Outlet Constraints
-- Termasuk detail: Kecamatan, Kelurahan, Alamat, Karton, Kubikasi, Tonase, Total Neto, Zone
--
-- CARA PENGGUNAAN DI DBEAVER:
-- 1. Ganti '2 APR 2026' dengan tanggal faktur yang diinginkan (misal: '11 JUL 2026')
-- 2. Jalankan query (Ctrl + Enter)
-- 3. Klik kanan hasil tabel -> "Export Data" -> pilih "XLSX" -> Simpan sebagai Invoices.xlsx
-- 4. Upload Invoices.xlsx ke Web UI CVRP (Tombol: 1. Upload Invoices)
-- ============================================================================

WITH RawDetail AS (
    -- 1. Ambil data detail barang reguler (fjual_d1)
    SELECT 
        h.invdate,
        h.invno,
        h.custno,
        d.pcode,
        d.qty,
        h.invamountcharge AS invamount
    FROM fjual_h h
    INNER JOIN fjual_d1 d ON h.orderno = d.orderno 
        AND h.transtype = d.transtype 
        AND h.slsno = d.slsno
    WHERE h.transtype = 'F'
      AND (h.flagoprtype = 'T' OR h.flagoprtype <> 'C')
      AND h.invdate = '2 APR 2026' 
      -- Filter Exclude Sales Office
      AND h.slsno NOT IN (SELECT memostring FROM ftable13 WHERE xkey = 'SLSOFFICE')
      -- Filter Exclude SO / Kanvas internal
      AND (h.remark IS NULL OR LOWER(h.remark) NOT LIKE '%so%')

    UNION ALL

    -- 2. Ambil data barang promo/bonus (fjual_d2)
    SELECT 
        h.invdate,
        h.invno,
        h.custno,
        d.pcode,
        d.qtypro AS qty,
        0 AS invamount
    FROM fjual_h h
    INNER JOIN fjual_d2 d ON h.orderno = d.orderno 
        AND h.transtype = d.transtype 
        AND h.slsno = d.slsno
    WHERE h.transtype = 'F'
      AND (h.flagoprtype = 'T' OR h.flagoprtype <> 'C')
      AND h.invdate = '2 APR 2026'
      -- Filter Exclude Sales Office
      AND h.slsno NOT IN (SELECT memostring FROM ftable13 WHERE xkey = 'SLSOFFICE')
      -- Filter Exclude SO / Kanvas internal
      AND (h.remark IS NULL OR LOWER(h.remark) NOT LIKE '%so%')
),
CalculatedItems AS (
    -- 3. Gabungkan dengan Master untuk Hitung Kubikasi, Tonase, Koordinat & Atribut Matrix ERP
    SELECT 
        a.invdate,
        a.invno,
        a.custno,
        c.custname,
        loc.latitude,
        loc.longitude,
        -- Group Payer Matrix: Toko yang satu pembayaran diikat bersama
        NVL(fk.grouppayer, a.custno) AS grouppayer,
        -- Restriksi Kendaraan (misal: Gang Sempit -> Engkel/Motor)
        NVL(fk.jns_kend, 'TRONTON') AS jns_kend,
        -- Detail Wilayah dari Master Hierarchy Matrix (fcustud + fcshir13 + fcshir14)
        kec_kel.kecamatan,
        kec_kel.kelurahan,
        -- Alamat Outlet dari Master Customer (fcustmst)
        NVL(c.data02, c.custadd1) AS alamat,
        -- Zonasi Wilayah (GroupKecamatan / Kecamatan)
        NVL(gk.groupkecamatan, kec_kel.kecamatan) AS zone,
        a.invamount,
        ROUND((a.qty / m.convunit3) * ((m.data04 / 100) * (m.data05 / 100) * (m.data06 / 100)), 3) AS kubikasi,
        ROUND((a.qty / m.convunit3) * NVL(m.data03, m.weight3), 1) AS beratbrutto,
        ROUND(a.qty / m.convunit3, 3) AS total_karton
    FROM RawDetail a
    INNER JOIN fmaster m ON a.pcode = m.pcode
    LEFT JOIN fcustmst c ON a.custno = c.custno
    -- Koordinat GPS
    JOIN ftable274 loc ON a.custno = loc.custno
    -- Atribut Khusus Outlet Matrix (GroupPayer & Jenis Kendaraan)
    LEFT JOIN ftable48 fk ON a.custno = fk.custno
    -- Hierarchy Kecamatan & Kelurahan Matrix ERP (sesuai log get detail rekap)
    LEFT JOIN (
        SELECT 
            ud.custno, 
            ud.h13 AS kodekecamatan, 
            c13.ket AS kecamatan, 
            ud.h14 AS kodekelurahan, 
            c14.ket AS kelurahan
        FROM fcustud ud
        LEFT JOIN fcshir13 c13 ON ud.h11 = c13.t11 AND ud.h12 = c13.t12 AND ud.h13 = c13.t13
        LEFT JOIN fcshir14 c14 ON ud.h11 = c14.t11 AND ud.h12 = c14.t12 AND ud.h13 = c14.t13 AND ud.h14 = c14.t14
    ) kec_kel ON a.custno = kec_kel.custno
    LEFT JOIN FGROUPKECAMATAN gk ON kec_kel.kecamatan = gk.kecamatan
    WHERE loc.latitude IS NOT NULL 
      AND loc.longitude IS NOT NULL 
      AND loc.latitude <> 0 
      AND loc.longitude <> 0
)
-- 4. Agregasi hasil akhir per Faktur & Outlet
-- Sesuai format Route Editor: no faktur | kode outlet | nama outlet | group payer | kecamatan | kelurahan | alamat | karton | kubikasi | tonase | total neto | zone
SELECT 
    invno,
    custno,
    custname,
    MAX(grouppayer) AS grouppayer,
    MAX(kecamatan) AS kecamatan,
    MAX(kelurahan) AS kelurahan,
    MAX(alamat) AS alamat,
    ROUND(SUM(total_karton), 3) AS total_karton,
    ROUND(SUM(kubikasi), 3) AS total_kubikasi_m3,
    ROUND(SUM(beratbrutto), 2) AS total_berat_kg,
    MAX(invamount) AS total_neto,
    MAX(zone) AS zone,
    TO_CHAR(MAX(latitude), 'FM999.999999999999999', 'NLS_NUMERIC_CHARACTERS = ''.,''') AS latitude,
    TO_CHAR(MAX(longitude), 'FM999.999999999999999', 'NLS_NUMERIC_CHARACTERS = ''.,''') AS longitude,
    MAX(jns_kend) AS jns_kend
FROM CalculatedItems
GROUP BY 
    invno,
    custno,
    custname
ORDER BY 
    custno, invno;