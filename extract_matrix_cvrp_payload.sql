-- ============================================================================
-- extract_matrix_cvrp_payload.sql
-- Matrix ERP → CVRP Engine Data Extraction
--
-- PURPOSE:  Pull EVERY field the CVRP engine needs in a single script.
--           Results are consumed by the middleware layer that builds the
--           JSON payload for POST /optimize.
--
-- USAGE:    Replace :P_INVDATE with the target dispatch date literal
--           (e.g., '11 JUL 2026').  All 7 queries use the same bind.
--
-- SCHEMA:   USERMYR9  (Matrix ERP production schema)
-- ============================================================================


-- =====================================================================
-- QUERY 1 — DEPOT COORDINATES
-- Source: FTABLE13 system parameter 'XLatitudeLongitude'
-- =====================================================================
SELECT
    MEMONAMA  AS depot_latitude,
    MEMOSTRING AS depot_longitude
FROM USERMYR9.FTABLE13
WHERE XKEY = 'XLatitudeLongitude';


-- =====================================================================
-- QUERY 2 — SYSTEM PARAMETERS
-- =====================================================================
SELECT
    XKEY,
    MEMOINT   AS int_value,
    MEMOSTRING AS string_value
FROM USERMYR9.FTABLE13
WHERE XKEY IN (
    'TMSMAXGROUPPAYER',   -- max distinct grouppayer per trip  (legacy: 50)
    'TMSMAXRADIUS',       -- max cluster radius in km          (legacy: 7)
    'TMSFIRSTOUT'         -- seed customer mode                (legacy: 2)
);


-- =====================================================================
-- QUERY 3 — ACTIVE VEHICLE FLEET  (ftable03 + farmadavskecamatan)
--
-- Returns one row per vehicle with:
--   • Capacity (kubikase m³, weightload kg, std_isi cartons)
--   • Vehicle type (jns_kend)
--   • Maximum daily trips (maxrit)
--   • Assigned territory groups (comma-separated)
--   • Priority ordering (nourut)
--
-- Hard filters:
--   • statusaktif = 'AKTIF'
--   • Exclude vehicles already dispatched today (non-cancelled recaps)
-- =====================================================================
SELECT
    a.no_kend        AS vehicle_id,
    a.jns_kend       AS vehicle_type,
    a.std_isi        AS std_cartons,
    a.weightload     AS max_kg,
    a.kubikase       AS max_m3,
    NVL(a.maxrit, 1) AS max_trips_per_day,
    b.priority       AS priority_class,    -- 'Reguler' or 'Cadangan'
    b.priority_order AS priority_order,
    d.groupkecamatan AS assigned_zones     -- comma-separated: 'GROUP1, GROUP2'
FROM USERMYR9.ftable03 a
    LEFT JOIN (
        SELECT
            no_kend,
            MIN(priority) AS priority,
            MIN(TO_NUMBER(nourut)) AS priority_order
        FROM USERMYR9.farmadavskecamatan
        GROUP BY no_kend
    ) b ON a.no_kend = b.no_kend
    -- Exclude vehicles with active (non-cancelled) dispatches today
    LEFT JOIN (
        SELECT DISTINCT b2.carno
        FROM USERMYR9.ftable100 a2
            INNER JOIN USERMYR9.ftable81 b2
                ON a2.recapno = b2.recapno
        WHERE a2.recapdate = :P_INVDATE
          AND NVL(a2.cancelflag, 0) <> '1'
    ) c ON a.no_kend = c.carno
    -- Concatenated zone list per vehicle (Universal Oracle 10g / 11g / 12c / 19c compatible)
    LEFT JOIN (
        SELECT
            no_kend,
            RTRIM(
                XMLAGG(XMLELEMENT(e, groupkecamatan || ', ') ORDER BY groupkecamatan).EXTRACT('//text()').GETSTRINGVAL(),
                ', '
            ) AS groupkecamatan
        FROM (
            SELECT DISTINCT no_kend, groupkecamatan
            FROM USERMYR9.farmadavskecamatan
            WHERE groupkecamatan IS NOT NULL
        )
        GROUP BY no_kend
    ) d ON a.no_kend = d.no_kend
WHERE a.statusaktif = 'AKTIF'
  AND c.carno IS NULL           -- not already dispatched
ORDER BY
    b.priority ASC,             -- Reguler first, then Cadangan
    b.priority_order ASC,
    a.kubikase DESC,
    a.no_kend ASC;


-- =====================================================================
-- QUERY 4 — OUTLET-TO-VEHICLE MAPPING  (fmappingoutletarmada)
--
-- Returns one row per (custno, vehicle) restriction.
-- If custno is NOT in this result set → any vehicle can serve it.
-- If custno IS present → only vehicles matching no_kend or jns_kend
-- are allowed.
-- =====================================================================
SELECT
    custno            AS outlet_id,
    no_kend           AS restricted_vehicle_id,
    jns_kend          AS restricted_vehicle_type
FROM USERMYR9.fmappingoutletarmada
ORDER BY custno, no_kend;


-- =====================================================================
-- QUERY 5 — TERRITORY / ZONE DEFINITIONS  (fgroupkecamatan)
--
-- Maps each kecamatan (subdistrict) to a GROUP tag.
-- Used to tag outlets by zone and match with vehicle zones.
-- =====================================================================
SELECT
    groupkecamatan    AS zone_id,
    kecamatan         AS kecamatan_name
FROM USERMYR9.FGROUPKECAMATAN
ORDER BY groupkecamatan, kecamatan;


-- =====================================================================
-- QUERY 6 — OUTLETS & AGGREGATED DEMANDS
--
-- One row per custno (outlet / grouppayer node) with:
--   • GPS coordinates (latitude, longitude)
--   • grouppayer linkage
--   • Summed volume (m³) and weight (kg) across all eligible invoices
--   • Invoice count, outlet's kecamatan / zone
--   • Customer active status (flagout)
--
-- EXACT legacy hard filters applied:
--   transtype = 'F', flagoprtype <> 'C', flagkon IS NULL,
--   status IN (NULL, '', '2'), recapno IS NULL, tglterima IS NULL,
--   data7 IS NULL, not in REKAP lock table, not SLSOFFICE salesman.
--   GPS is sanitised (no ^, *, NULL → '0'; exclude lat/lon = 0).
--   Customer flagout IN ('C','O').
-- =====================================================================
WITH
-- Step 1: Union regular items + promo items (exact legacy pattern)
RawInvoiceLines AS (
    SELECT h.invno, h.orderno, h.custno, h.slsno, h.invdate,
           d.pcode, d.qty
    FROM USERMYR9.fjual_h h
        INNER JOIN USERMYR9.fjual_d1 d
            ON h.orderno = d.orderno
           AND h.slsno   = d.slsno
           AND h.transtype = d.transtype
    WHERE h.invdate    = :P_INVDATE
      AND h.transtype  = 'F'
      AND h.flagoprtype <> 'C'
      AND h.flagkon    IS NULL
      AND (h.status = '' OR h.status IS NULL OR h.status = '2')
      AND (h.recapno IS NULL OR h.recapno = '')
      AND h.tglterima  IS NULL
      AND h.data7      IS NULL
      AND h.invno  NOT IN (SELECT memostring FROM USERMYR9.ftable13 WHERE xkey = 'REKAP')
      AND h.slsno  NOT IN (SELECT memostring FROM USERMYR9.ftable13 WHERE xkey = 'SLSOFFICE')

    UNION ALL

    SELECT h.invno, h.orderno, h.custno, h.slsno, h.invdate,
           d.pcode, d.qtypro AS qty
    FROM USERMYR9.fjual_h h
        INNER JOIN USERMYR9.fjual_d2 d
            ON h.orderno = d.orderno
           AND h.slsno   = d.slsno
           AND h.transtype = d.transtype
    WHERE h.invdate    = :P_INVDATE
      AND h.transtype  = 'F'
      AND h.flagoprtype <> 'C'
      AND h.flagkon    IS NULL
      AND (h.status = '' OR h.status IS NULL OR h.status = '2')
      AND (h.recapno IS NULL OR h.recapno = '')
      AND h.tglterima  IS NULL
      AND h.data7      IS NULL
      AND h.invno  NOT IN (SELECT memostring FROM USERMYR9.ftable13 WHERE xkey = 'REKAP')
      AND h.slsno  NOT IN (SELECT memostring FROM USERMYR9.ftable13 WHERE xkey = 'SLSOFFICE')
),

-- Step 2: Aggregate qty per (invno, custno, pcode) then calculate dimensions
-- EXACT legacy formula: kubikasi = (qty/convunit3) * (data04/100 * data05/100 * data06/100)
--                       tonase   = (qty/convunit3) * data03
InvoiceProductDemand AS (
    SELECT
        r.invno,
        r.custno,
        r.pcode,
        SUM(r.qty)                                               AS total_qty,
        ROUND(
            (SUM(r.qty) / m.convunit3)
            * ((m.data04 / 100) * (m.data05 / 100) * (m.data06 / 100)),
            3
        )                                                        AS kubikasi_m3,
        ROUND(
            (SUM(r.qty) / m.convunit3) * m.data03,
            1
        )                                                        AS tonase_kg,
        ROUND(
            ABS(SUM(r.qty)) / m.convunit3,
            4
        )                                                        AS cartons
    FROM RawInvoiceLines r
        INNER JOIN USERMYR9.fmaster m ON r.pcode = m.pcode
    GROUP BY r.invno, r.custno, r.pcode,
             m.convunit3, m.data03, m.data04, m.data05, m.data06
),

-- Step 3: Roll up to invoice level
InvoiceDemand AS (
    SELECT
        invno,
        custno,
        ROUND(SUM(kubikasi_m3), 3)   AS inv_m3,
        ROUND(SUM(tonase_kg), 2)     AS inv_kg,
        ROUND(SUM(cartons), 4)       AS inv_cartons
    FROM InvoiceProductDemand
    GROUP BY invno, custno
),

-- Step 4: Resolve GPS coordinates
-- Priority: ftable48 (outlet master) → ftable274 (registration/survey)
-- Legacy sanitisation: strip ^, *, replace NULL/empty with '0'
OutletCoords AS (
    SELECT
        a.custno,
        a.grouppayer,
        CASE
            WHEN NVL(b.latitude, a.latitude) IS NULL
            THEN (
                SELECT latitude
                FROM USERMYR9.ftable274
                WHERE custno || registrationdate IN (
                    SELECT custno || MAX(registrationdate)
                    FROM USERMYR9.ftable274
                    GROUP BY custno
                )
                AND custno IN (
                    SELECT custno FROM USERMYR9.ftable48
                    WHERE grouppayer = a.custno AND latitude IS NOT NULL
                )
            )
            ELSE NVL(b.latitude, a.latitude)
        END AS latitude,
        CASE
            WHEN NVL(b.longitude, a.longitude) IS NULL
            THEN (
                SELECT longitude
                FROM USERMYR9.ftable274
                WHERE custno || registrationdate IN (
                    SELECT custno || MAX(registrationdate)
                    FROM USERMYR9.ftable274
                    GROUP BY custno
                )
                AND custno IN (
                    SELECT custno FROM USERMYR9.ftable48
                    WHERE grouppayer = a.custno AND longitude IS NOT NULL
                )
            )
            ELSE NVL(b.longitude, a.longitude)
        END AS longitude
    FROM USERMYR9.ftable48 a
        LEFT JOIN (
            SELECT *
            FROM USERMYR9.ftable274
            WHERE custno || registrationdate IN (
                SELECT custno || MAX(registrationdate)
                FROM USERMYR9.ftable274
                GROUP BY custno
            )
        ) b ON a.grouppayer = b.custno
),

-- Step 5: Resolve outlet zone from hierarchy tables
OutletZone AS (
    SELECT
        k.custno,
        c.ket   AS kecamatan,
        gk.groupkecamatan AS zone_id
    FROM USERMYR9.fcustudsummary k
        INNER JOIN USERMYR9.fcshir13 c
            ON k.h13 = c.t13 AND k.h11 = c.t11 AND k.h12 = c.t12
        LEFT JOIN USERMYR9.FGROUPKECAMATAN gk
            ON c.ket = gk.kecamatan
)

-- ── FINAL OUTPUT: One row per outlet with full demand + constraints ──
SELECT
    oc.custno                          AS outlet_id,
    cm.custname                        AS outlet_name,
    oc.grouppayer                      AS grouppayer,
    TO_CHAR(oc.latitude,  'FM999.999999999999999',
            'NLS_NUMERIC_CHARACTERS = ''.,''' ) AS latitude,
    TO_CHAR(oc.longitude, 'FM999.999999999999999',
            'NLS_NUMERIC_CHARACTERS = ''.,''' ) AS longitude,
    oz.kecamatan                       AS kecamatan,
    oz.zone_id                         AS zone,
    cm.flagout                         AS customer_status,
    COUNT(DISTINCT id.invno)           AS invoice_count,
    ROUND(SUM(id.inv_m3), 3)          AS total_m3,
    ROUND(SUM(id.inv_kg), 2)          AS total_kg,
    ROUND(SUM(id.inv_cartons), 4)     AS total_cartons
FROM InvoiceDemand id
    INNER JOIN OutletCoords oc      ON id.custno = oc.custno
    INNER JOIN USERMYR9.fcustmst cm ON id.custno = cm.custno
    LEFT  JOIN OutletZone oz        ON id.custno = oz.custno
WHERE cm.flagout IN ('C', 'O')                    -- active customer/outlet only
  AND oc.latitude  IS NOT NULL
  AND oc.longitude IS NOT NULL
  AND oc.latitude  <> '0'
  AND oc.longitude <> '0'
GROUP BY
    oc.custno, cm.custname, oc.grouppayer,
    oc.latitude, oc.longitude,
    oz.kecamatan, oz.zone_id, cm.flagout
ORDER BY oc.custno;


-- =====================================================================
-- QUERY 7 — INVOICE-LEVEL DETAIL  (for outlet.invoices[] array)
--
-- Same filters as Query 6, but returns one row per invoice
-- (not aggregated to outlet level).
-- =====================================================================
WITH
RawInvoiceLines AS (
    SELECT h.invno, h.orderno, h.custno, h.slsno,
           d.pcode, d.qty
    FROM USERMYR9.fjual_h h
        INNER JOIN USERMYR9.fjual_d1 d
            ON h.orderno = d.orderno
           AND h.slsno   = d.slsno
           AND h.transtype = d.transtype
    WHERE h.invdate    = :P_INVDATE
      AND h.transtype  = 'F'
      AND h.flagoprtype <> 'C'
      AND h.flagkon    IS NULL
      AND (h.status = '' OR h.status IS NULL OR h.status = '2')
      AND (h.recapno IS NULL OR h.recapno = '')
      AND h.tglterima  IS NULL
      AND h.data7      IS NULL
      AND h.invno  NOT IN (SELECT memostring FROM USERMYR9.ftable13 WHERE xkey = 'REKAP')
      AND h.slsno  NOT IN (SELECT memostring FROM USERMYR9.ftable13 WHERE xkey = 'SLSOFFICE')

    UNION ALL

    SELECT h.invno, h.orderno, h.custno, h.slsno,
           d.pcode, d.qtypro AS qty
    FROM USERMYR9.fjual_h h
        INNER JOIN USERMYR9.fjual_d2 d
            ON h.orderno = d.orderno
           AND h.slsno   = d.slsno
           AND h.transtype = d.transtype
    WHERE h.invdate    = :P_INVDATE
      AND h.transtype  = 'F'
      AND h.flagoprtype <> 'C'
      AND h.flagkon    IS NULL
      AND (h.status = '' OR h.status IS NULL OR h.status = '2')
      AND (h.recapno IS NULL OR h.recapno = '')
      AND h.tglterima  IS NULL
      AND h.data7      IS NULL
      AND h.invno  NOT IN (SELECT memostring FROM USERMYR9.ftable13 WHERE xkey = 'REKAP')
      AND h.slsno  NOT IN (SELECT memostring FROM USERMYR9.ftable13 WHERE xkey = 'SLSOFFICE')
)
SELECT
    r.invno                                              AS invno,
    r.custno                                             AS outlet_id,
    ROUND(
        SUM((r.qty / m.convunit3)
            * ((m.data04 / 100) * (m.data05 / 100) * (m.data06 / 100))),
        3
    )                                                    AS inv_m3,
    ROUND(
        SUM((r.qty / m.convunit3) * m.data03),
        2
    )                                                    AS inv_kg
FROM RawInvoiceLines r
    INNER JOIN USERMYR9.fmaster m ON r.pcode = m.pcode
GROUP BY r.invno, r.custno
ORDER BY r.custno, r.invno;
