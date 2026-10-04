-- ============================================================================
-- get_dataPenjualan.sql (Oracle) - VERSI CLEAN
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
      AND h.slsno NOT IN (SELECT memostring FROM ftable13 WHERE xkey = 'SLSOFFICE')
      AND (h.remark IS NULL OR LOWER(h.remark) NOT LIKE '%so%')
      
      -- FILTER EXCLUDE TRONTON (Simple & Direct)
      AND NOT EXISTS (
          SELECT 1 
          FROM ftable81 f81
          INNER JOIN ftable03 f03 ON f81.carno = f03.no_kend
          WHERE f81.invno = h.invno 
            AND f03.kubikase > 30
      )

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
      AND h.slsno NOT IN (SELECT memostring FROM ftable13 WHERE xkey = 'SLSOFFICE')
      AND (h.remark IS NULL OR LOWER(h.remark) NOT LIKE '%so%')
      
      -- FILTER EXCLUDE TRONTON (Simple & Direct)
      AND NOT EXISTS (
          SELECT 1 
          FROM ftable81 f81
          INNER JOIN ftable03 f03 ON f81.carno = f03.no_kend
          WHERE f81.invno = h.invno 
            AND f03.kubikase > 30
      )
),
CalculatedItems AS (
    -- 3. Semua rumus hitungan KEMBALI KE ASLI buatanmu (Tanpa fungsi replace aneh-aneh)
    SELECT 
        a.invdate,
        a.invno,
        a.custno,
        c.custname,
        loc.latitude,
        loc.longitude,
        NVL(fk.grouppayer, a.custno) AS grouppayer,
        NVL(fk.jns_kend, 'TRONTON') AS jns_kend,
        kec_kel.kecamatan,
        kec_kel.kelurahan,
        NVL(c.data02, c.custadd1) AS alamat,
        NVL(gk.groupkecamatan, kec_kel.kecamatan) AS zone,
        a.invamount,
        ROUND((a.qty / m.convunit3) * ((m.data04 / 100) * (m.data05 / 100) * (m.data06 / 100)), 3) AS kubikasi,
        ROUND((a.qty / m.convunit3) * NVL(m.data03, m.weight3), 1) AS beratbrutto,
        ROUND(a.qty / m.convunit3, 3) AS total_karton
    FROM RawDetail a
    INNER JOIN fmaster m ON a.pcode = m.pcode
    LEFT JOIN fcustmst c ON a.custno = c.custno
    JOIN ftable274 loc ON a.custno = loc.custno
    LEFT JOIN ftable48 fk ON a.custno = fk.custno
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
    
    -- Filter koordinat KEMBALI KE ASLI buatanmu
    WHERE loc.latitude IS NOT NULL 
      AND loc.longitude IS NOT NULL 
      AND loc.latitude <> 0 
      AND loc.longitude <> 0
)
-- 4. Agregasi hasil akhir per Faktur & Outlet
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