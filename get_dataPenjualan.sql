WITH RawDetail AS (
    -- 1. Ambil data detail barang reguler (fjual_d1)
    SELECT 
        h.invdate,
        h.invno,
        h.custno,
        d.pcode,
        d.qty,
        h.invamountcharge as invamount
    FROM fjual_h h
    INNER JOIN fjual_d1 d ON h.orderno = d.orderno 
        AND h.transtype = d.transtype 
        AND h.slsno = d.slsno
    WHERE h.transtype = 'F'
      AND h.flagoprtype = 'T'
      AND h.invdate = '2 APR 2026' 
      -- Filter Exclude Sales Office
      AND h.slsno NOT IN (SELECT memostring FROM ftable13 WHERE xkey = 'SLSOFFICE')
      -- Filter Exclude SO (Ditambahkan di sini juga)
      AND (h.remark IS NULL OR LOWER(h.remark) NOT LIKE '%so%')

    UNION ALL

    -- 2. Ambil data barang promo/bonus (fjual_d2)
    SELECT 
        h.invdate,
        h.invno,
        h.custno,
        d.pcode,
        d.qtypro as qty,
        0 as invamount
    FROM fjual_h h
    INNER JOIN fjual_d2 d ON h.orderno = d.orderno 
        AND h.transtype = d.transtype 
        AND h.slsno = d.slsno
    WHERE h.transtype = 'F'
      AND h.flagoprtype = 'T'
      AND h.invdate = '2 APR 2026'
      -- Filter Exclude Sales Office
      AND h.slsno NOT IN (SELECT memostring FROM ftable13 WHERE xkey = 'SLSOFFICE')
      -- Filter Exclude SO (Diperbaiki jadi NOT LIKE + proteksi NULL)
      AND (h.remark IS NULL OR LOWER(h.remark) NOT LIKE '%so%')
),
CalculatedItems AS (
    -- 3. Gabungkan dengan Master untuk Hitung Kubikasi, Tonase, Koordinat & Jns Kendaraan
    SELECT 
        a.invdate,
        a.invno,
        a.custno,
        c.custname,
        loc.latitude,
        loc.longitude,
        --fk.jns_kend, -- Tarik JNS_KEND dari ftable48
        a.invamount,
        ROUND((a.qty / m.convunit3) * ((m.data04 / 100) * (m.data05 / 100) * (m.data06 / 100)), 3) AS kubikasi,
        ROUND((a.qty / m.convunit3) * m.weight3, 1) AS beratbrutto,
        (a.qty / m.convunit3) AS total_karton
    FROM RawDetail a
    INNER JOIN FMASTER m ON a.pcode = m.pcode
    LEFT JOIN FCUSTMST c ON a.custno = c.custno
    -- Join untuk koordinat
    JOIN ftable274 loc ON a.custno = loc.custno
    -- Join untuk Jenis Kendaraan
    --JOIN ftable48 fk ON a.custno = fk.custno
    WHERE loc.latitude IS NOT NULL 
      AND loc.longitude IS NOT NULL 
      AND loc.latitude <> 0 
      AND loc.longitude <> 0
      -- Filter JNS_KEND agar yang kosong terbuang
      -- AND fk.jns_kend IS NOT NULL 
)
-- 4. Agregasi hasil akhir per Faktur & Outlet
SELECT 
    custno,
    custname,
    invno,
    --MAX(jns_kend) AS jns_kend,
    -- Paksa jadi Text dengan titik sebagai desimal
    TO_CHAR(MAX(latitude), 'FM999.999999999999999', 'NLS_NUMERIC_CHARACTERS = ''.,''') AS latitude,
    TO_CHAR(MAX(longitude), 'FM999.999999999999999', 'NLS_NUMERIC_CHARACTERS = ''.,''') AS longitude,
    MAX(invamount) AS total_neto,
    SUM(kubikasi) AS total_kubikasi_m3,
    SUM(beratbrutto) AS total_berat_kg,
    ROUND(SUM(total_karton), 3) AS total_karton
FROM CalculatedItems
GROUP BY 
    invno,
    custno,
    custname
ORDER BY 
    custno, invno;