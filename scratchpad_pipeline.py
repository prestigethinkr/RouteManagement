import re

def _enforce_all_or_nothing_splits(
    assigned_routes: list[AssignedRouteOut],
    unassigned_ids: list[str],
    merged_outlets: list[OutletIn]
) -> tuple[list[AssignedRouteOut], list[str], set[str]]:
    yanked_roots = set()
    mo_map = {mo.id: mo for mo in merged_outlets}
    
    for uid in unassigned_ids:
        m = re.match(r"^(.*)_SPLIT_\d+$", uid)
        if m:
            yanked_roots.add(m.group(1))
            
    if not yanked_roots:
        return assigned_routes, unassigned_ids, yanked_roots
        
    yanked_ids = set()
    for route in assigned_routes:
        new_route = []
        for oid in route.route:
            m = re.match(r"^(.*)_SPLIT_\d+$", oid)
            is_yanked = False
            if m and m.group(1) in yanked_roots:
                is_yanked = True
            elif oid in yanked_roots:
                is_yanked = True
                
            if is_yanked:
                yanked_ids.add(oid)
                if oid not in unassigned_ids:
                    unassigned_ids.append(oid)
                if oid in mo_map:
                    route.total_m3 = max(0.0, route.total_m3 - mo_map[oid].m3)
                    route.total_kg = max(0.0, route.total_kg - mo_map[oid].kg)
            else:
                new_route.append(oid)
        
        route.route = new_route
        
    if yanked_ids:
        log.info("Yanker removed %d sibling split parts belonging to %d roots.", len(yanked_ids), len(yanked_roots))
        
    return assigned_routes, unassigned_ids, yanked_roots

def _dissolve_low_epe_routes(
    assigned_routes: list[AssignedRouteOut],
    vehicles: list[VehicleIn],
    min_epe_threshold: float,
) -> tuple[list[AssignedRouteOut], list[str], int, set[str]]:
    if min_epe_threshold <= 0.0:
        return assigned_routes, [], 0, set()

    vehicle_map = {v.id: v for v in vehicles}
    retained_routes = []
    dissolved_unassigned_ids = []
    dissolved_count = 0
    dissolved_outlet_ids = set()

    for r in assigned_routes:
        veh = vehicle_map.get(r.vehicle_id)
        if not veh:
            retained_routes.append(r)
            continue

        m3_util = (r.total_m3 / veh.max_m3) if veh.max_m3 > 0 else 0.0
        kg_util = (r.total_kg / veh.max_kg) if veh.max_kg > 0 else 0.0
        epe = max(m3_util, kg_util)

        if epe < min_epe_threshold and r.total_distance_km > 0:
            dissolved_count += 1
            dissolved_outlet_ids.update(r.route)
            dissolved_unassigned_ids.extend(r.route)
            log.info("Kill Switch: Route %s EPE %.2f%% < %.2f%%, dissolving.", r.vehicle_id, epe*100, min_epe_threshold*100)
        else:
            retained_routes.append(r)

    return retained_routes, dissolved_unassigned_ids, dissolved_count, dissolved_outlet_ids
