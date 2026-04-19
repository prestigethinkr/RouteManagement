 SELECT
	DISTINCT jns_kend AS jns_kend,
	no_kend AS no_kend,
	kubikase AS kubikase,
	weightload AS TONASE,
	drivercode,
	helpercode
FROM
	ftable03
WHERE
	STATUSAKTIF = 'AKTIF'
	AND KUBIKASE <= '999'
ORDER BY
	no_kend ASC