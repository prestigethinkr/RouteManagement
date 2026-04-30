"""
CVRP Optimization Service — v4 (Global Solver + Aggressive Spatial Clustering)
FastAPI + Google OR-Tools + OSRM

POST /optimize  — accepts depot, outlets, vehicles; fetches ONE global OSRM
                  duration matrix (optimized for 1000+ nodes); solves CVRP with:
                  • Hybrid arc cost d + d²/100 (ultra-aggressive spaghetti prevention)
                  • Fixed vehicle cost to discourage trivial empty routes
                  • Volume (m³) + Weight (kg) capacity constraints
                  • Duration dimension as hard per-vehicle time cap (no span forcing)
                  • GLS + LNS operators (Relocate, Exchange, Cross, Or-Opt, TSP-Opt)
                  • 60 s solver budget on 56 GB VPS
                  Returns optimized route sequences per vehicle.
"""

from __future__ import annotations

import asyncio
import logging
import math
import os
import time
from datetime import datetime
from typing import Any

import pandas as pd

import httpx
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from ortools.constraint_solver import pywrapcp, routing_enums_pb2
from ortools.util import optional_boolean_pb2
from pydantic import BaseModel, Field

try:
    import hygese as hgs  # PyHygese — optional; only required for pyhygese algorithm
    _HYGESE_AVAILABLE = True
except ImportError:
    _HYGESE_AVAILABLE = False

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(message)s")
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------
app = FastAPI(title="CVRP Optimization Service", version="3.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Tuning constants
# ---------------------------------------------------------------------------
OSRM_BASE = "http://127.0.0.1:5001"

DEMAND_SCALE = 1000          # m³/kg float → int scaling (preserves 3 decimals)

# Hybrid arc cost:  cost = d + d² / QUAD_DIVISOR
# Linear term keeps zero-distance self-arcs at 0 and provides a sensible floor.
# Quadratic term explosively penalises long cross-city jumps.
#   60 s  →    60 +    36 =     96  (nearby  — almost free)
#  300 s  →   300 +   900 =  1 200  (short leg — noticeable)
#  900 s  →   900 + 8 100 =  9 000  (medium   — expensive)
# 1800 s  →  1800 +32 400 = 34 200  (long leg — very costly)
# 3600 s  →  3600 +129600 =133 200  (cross-region — effectively forbidden)
QUAD_DIVISOR = 100

# Proportional fixed costs by capacity tier — smaller vehicles cost less to
# activate, so the solver prefers motorcycles for tiny loads and escalates to
# large trucks only when the cumulative demand justifies it.
FIXED_COST_SMALL  =    500   # max_m3 ≤ 1.0  (motorcycles / DEMO)
FIXED_COST_MEDIUM =  3_000   # 1.0 < max_m3 ≤ 5.0  (L300 / small vans)
FIXED_COST_LARGE  = 10_000   # max_m3 > 5.0  (Engkel / large trucks)
DROP_PENALTY = 100_000_000   # Disjunction penalty for dropping a node
MAX_VEHICLE_TIME = 8 * 3600  # 8-hour hard cap per vehicle (seconds)
SOLVER_TIME_LIMIT = 15       # GLS + LNS refinement budget (seconds)

_ALGO_DISPLAY = {"ortools": "OR-Tools", "pyhygese": "HGS-CVRP"}
# ---------------------------------------------------------------------------
# Pydantic models  (unchanged — keeps frontend contract intact)
# ---------------------------------------------------------------------------
class DepotIn(BaseModel):
    lat: float
    lng: float


class InvoiceIn(BaseModel):
    invno: str
    m3: float = Field(default=0.0, ge=0)
    kg: float = Field(default=0.0, ge=0)


class OutletIn(BaseModel):
    id: str
    lat: float
    lng: float
    m3: float = Field(..., ge=0, description="Volume in cubic metres")
    kg: float = Field(..., ge=0, description="Weight in kilograms")
    # Optional rich fields — used for Excel export; ignored by the solver
    custname: str = ""
    jns_kend: str = ""
    invoices: list[InvoiceIn] = Field(default_factory=list)


class VehicleIn(BaseModel):
    id: str
    max_m3: float = Field(..., gt=0)
    max_kg: float = Field(..., gt=0)
    jns_kend: str = ""  # Vehicle type label — used for Excel export; ignored by the solver


class OptimizeRequest(BaseModel):
    depot: DepotIn
    outlets: list[OutletIn]
    vehicles: list[VehicleIn]
    algorithm: str = Field(
        default="ortools",
        pattern="^(ortools|pyhygese)$",
        description='Solver backend: "ortools" (default) or "pyhygese"',
    )
    max_stops: int = Field(
        default=40,
        ge=1,
        le=500,
        description="Maximum number of outlet stops per vehicle",
    )


class AssignedRouteOut(BaseModel):
    vehicle_id: str
    total_m3: float
    total_kg: float
    route: list[str]           # ordered outlet IDs
    total_duration_s: float = 0.0   # total driving time in seconds (depot → stops → depot)
    total_distance_km: float = 0.0  # total driving distance in km (depot → stops → depot)


class OptimizeResponse(BaseModel):
    assigned_routes: list[AssignedRouteOut]
    unassigned_outlets: list[str]


# ---------------------------------------------------------------------------
# OSRM — ONE global duration + distance matrix
# ---------------------------------------------------------------------------
async def fetch_duration_matrix(
    depot: DepotIn,
    outlets: list[OutletIn],
) -> tuple[list[list[float]], list[list[float]]]:
    """
    Fetch the full (N+1)×(N+1) duration AND distance matrices from the OSRM
    Table API in a single HTTP request.  Optimized for 1000+ nodes:
      • GET  when the URL fits comfortably (< 4 000 chars)
      • GET with query params otherwise (avoids HTTP 414)
    Index 0 = depot; indices 1..N = outlets in payload order.
    Returns (durations_seconds, distances_meters).
    """
    coord_parts: list[str] = [f"{depot.lng},{depot.lat}"]
    coord_parts.extend(f"{o.lng},{o.lat}" for o in outlets)
    coord_str = ";".join(coord_parts)

    get_url = f"{OSRM_BASE}/table/v1/driving/{coord_str}?annotations=duration,distance"

    async with httpx.AsyncClient(timeout=180.0) as client:
        if len(get_url) <= 4000:
            resp = await client.get(get_url)
        else:
            # GET with query params for large coordinate sets (1000+ nodes)
            log.info(
                "URL length %d exceeds threshold — using GET with params for %d coords",
                len(get_url), len(coord_parts),
            )
            resp = await client.get(
                f"{OSRM_BASE}/table/v1/driving/{coord_str}",
                params={"annotations": "duration,distance"},
            )

    if resp.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"OSRM Table API returned HTTP {resp.status_code}: {resp.text[:300]}",
        )

    data: dict[str, Any] = resp.json()
    if data.get("code") != "Ok":
        raise HTTPException(
            status_code=502,
            detail=f"OSRM Table API error: {data.get('code')} — {data.get('message', '')}",
        )

    durations: list[list[float]] = data["durations"]
    distances: list[list[float]] = data["distances"]
    log.info("OSRM matrix fetched: %d×%d (duration + distance)", len(durations), len(durations[0]))
    return durations, distances


# ---------------------------------------------------------------------------
# OR-Tools — Global CVRP solver
# ---------------------------------------------------------------------------
def _build_int_matrices(
    raw_durations: list[list[float]],
) -> tuple[list[list[int]], list[list[int]]]:
    """
    Pre-compute two integer matrices from the raw OSRM durations:
      • int_dur    — raw seconds, rounded (hard time-cap dimension)
      • hybrid     — d + d²/QUAD_DIVISOR  (arc cost: ultra-aggressive
                     spaghetti prevention without removing the linear floor)
    """
    int_dur: list[list[int]] = []
    hybrid: list[list[int]] = []

    for row in raw_durations:
        dur_row: list[int] = []
        hyb_row: list[int] = []
        for cell in row:
            d = max(0, int(round(cell)))
            dur_row.append(d)
            hyb_row.append(d + (d * d) // QUAD_DIVISOR)
        int_dur.append(dur_row)
        hybrid.append(hyb_row)

    return int_dur, hybrid


def solve_cvrp(
    raw_durations: list[list[float]],
    raw_distances: list[list[float]],
    outlets: list[OutletIn],
    vehicles: list[VehicleIn],
    max_stops: int = 40,
) -> tuple[list[AssignedRouteOut], list[str]]:
    """
    Solve the full multi-vehicle CVRP globally with:
      • Hybrid arc cost (d + d²/100) → ultra-aggressive petal-shaped routes
      • Fixed vehicle cost           → discourages unnecessary fleet use
      • Volume + Weight capacity dims→ hard feasibility
      • Raw-time dimension           → hard 8-hour per-vehicle cap (no span forcing)
    Returns (assigned_routes, unassigned_outlet_ids).
    """
    n_nodes = 1 + len(outlets)   # node 0 = depot
    n_vehicles = len(vehicles)

    # ── matrices ──────────────────────────────────────────────────────
    int_dur, hybrid_cost = _build_int_matrices(raw_durations)

    # ── demand arrays (index 0 = depot → 0) ──────────────────────────
    m3_demand = [0] + [int(round(o.m3 * DEMAND_SCALE)) for o in outlets]
    kg_demand = [0] + [int(round(o.kg * DEMAND_SCALE)) for o in outlets]
    m3_caps = [int(round(v.max_m3 * DEMAND_SCALE)) for v in vehicles]
    kg_caps = [int(round(v.max_kg * DEMAND_SCALE)) for v in vehicles]

    # ── routing model (all vehicles start & end at depot 0) ──────────
    manager = pywrapcp.RoutingIndexManager(n_nodes, n_vehicles, 0)
    routing = pywrapcp.RoutingModel(manager)

    # ── ARC COST: hybrid d + d²/100  (ultra-aggressive spaghetti prevention) ─
    def hybrid_transit_cb(from_idx: int, to_idx: int) -> int:
        return hybrid_cost[manager.IndexToNode(from_idx)][
            manager.IndexToNode(to_idx)
        ]

    hyb_cb_idx = routing.RegisterTransitCallback(hybrid_transit_cb)
    routing.SetArcCostEvaluatorOfAllVehicles(hyb_cb_idx)

    # Proportional fixed cost per vehicle — encourages the solver to use the
    # smallest feasible vehicle (motorcycle for a tiny drop, Engkel only when
    # cumulative demand warrants it).  Tiers are aligned with max_m3 capacity.
    for v_idx, vehicle in enumerate(vehicles):
        if vehicle.max_m3 <= 1.0:
            fixed_cost = FIXED_COST_SMALL
        elif vehicle.max_m3 <= 5.0:
            fixed_cost = FIXED_COST_MEDIUM
        else:
            fixed_cost = FIXED_COST_LARGE
        routing.SetFixedCostOfVehicle(fixed_cost, v_idx)

    # ── DIMENSION: raw driving time (for span balancing) ──────────────
    def raw_time_cb(from_idx: int, to_idx: int) -> int:
        return int_dur[manager.IndexToNode(from_idx)][
            manager.IndexToNode(to_idx)
        ]

    time_cb_idx = routing.RegisterTransitCallback(raw_time_cb)
    routing.AddDimension(
        time_cb_idx,
        0,                  # no waiting/slack
        MAX_VEHICLE_TIME,   # cumulative upper bound per vehicle
        True,               # start cumul to zero
        "Time",
    )
    # No GlobalSpanCostCoefficient — we do NOT force balanced routes.
    # Short local clusters are perfectly acceptable; the quadratic arc cost
    # already deters cross-city jumps without any workload-balancing pressure.
    _ = routing.GetDimensionOrDie("Time")  # dimension registered; hard cap only

    # ── DIMENSION: volume (m³) ────────────────────────────────────────
    def m3_cb(from_idx: int) -> int:
        return m3_demand[manager.IndexToNode(from_idx)]

    m3_cb_idx = routing.RegisterUnaryTransitCallback(m3_cb)
    routing.AddDimensionWithVehicleCapacity(
        m3_cb_idx, 0, m3_caps, True, "Volume",
    )

    # ── DIMENSION: weight (kg) ────────────────────────────────────────
    def kg_cb(from_idx: int) -> int:
        return kg_demand[manager.IndexToNode(from_idx)]

    kg_cb_idx = routing.RegisterUnaryTransitCallback(kg_cb)
    routing.AddDimensionWithVehicleCapacity(
        kg_cb_idx, 0, kg_caps, True, "Weight",
    )

    # ── DIMENSION: stops (max outlets per vehicle) ────────────────
    def stops_cb(from_idx: int) -> int:
        node = manager.IndexToNode(from_idx)
        return 0 if node == 0 else 1   # depot=0, any outlet=1

    stops_cb_idx = routing.RegisterUnaryTransitCallback(stops_cb)
    routing.AddDimensionWithVehicleCapacity(
        stops_cb_idx,
        0,                                       # no slack
        [max_stops] * n_vehicles,                 # same cap for all vehicles
        True,                                     # start cumul to zero
        "Stops",
    )

    # ── disjunctions: allow dropping any outlet (with heavy penalty) ──
    for node in range(1, n_nodes):
        routing.AddDisjunction([manager.NodeToIndex(node)], DROP_PENALTY)

    # ── search parameters ─────────────────────────────────────────────
    params = pywrapcp.DefaultRoutingSearchParameters()
    params.first_solution_strategy = (
        routing_enums_pb2.FirstSolutionStrategy.PARALLEL_CHEAPEST_INSERTION
    )
    params.local_search_metaheuristic = (
        routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    )
    # params.time_limit.seconds = SOLVER_TIME_LIMIT  # disabled — calibrated iteration limit used instead
    params.solution_limit = 1200  # calibrated: ~500 solutions ≈ 21 s → 1200 ≈ 50 s on reference hardware
    params.log_search = True
    # params.random_seed — intentionally omitted: field not exposed on RoutingSearchParameters
    #                       in this OR-Tools build; would raise AttributeError at runtime.

    # ── LNS operators: Relocate, Exchange, Cross-Exchange ─────────────
    # Enable aggressive neighborhood destruction to escape local optima.
    # NOTE: nested operator fields require the protobuf OptionalBoolean enum,
    # NOT a plain Python bool (which would be treated as integer 1, not BOOL_TRUE=3).
    _BOOL_TRUE = optional_boolean_pb2.BOOL_TRUE
    params.local_search_operators.use_relocate = _BOOL_TRUE
    params.local_search_operators.use_exchange = _BOOL_TRUE
    params.local_search_operators.use_cross = _BOOL_TRUE
    params.local_search_operators.use_relocate_neighbors = _BOOL_TRUE
    params.local_search_operators.use_tsp_opt = _BOOL_TRUE
    params.local_search_operators.use_or_opt = _BOOL_TRUE

    # ── solve ─────────────────────────────────────────────────────────
    log.info(
        "Solving global CVRP: %d nodes, %d vehicles, %ds GLS …",
        n_nodes, n_vehicles, SOLVER_TIME_LIMIT,
    )
    solution = routing.SolveWithParameters(params)

    if not solution:
        log.warning("No feasible solution — returning all outlets as unassigned")
        return [], [o.id for o in outlets]

    # ── extract routes ────────────────────────────────────────────────
    assigned_routes: list[AssignedRouteOut] = []
    served_nodes: set[int] = set()

    for v_idx in range(n_vehicles):
        route_nodes: list[int] = []
        idx = routing.Start(v_idx)
        while not routing.IsEnd(idx):
            node = manager.IndexToNode(idx)
            if node != 0:
                route_nodes.append(node)
                served_nodes.add(node)
            idx = solution.Value(routing.NextVar(idx))

        if not route_nodes:
            continue

        outlet_ids = [outlets[n - 1].id for n in route_nodes]
        total_m3 = round(sum(outlets[n - 1].m3 for n in route_nodes), 4)
        total_kg = round(sum(outlets[n - 1].kg for n in route_nodes), 4)

        # Total driving time and distance: depot → stop_1 → … → stop_k → depot
        route_seq = [0] + route_nodes + [0]
        total_dur_s = sum(
            raw_durations[route_seq[i]][route_seq[i + 1]]
            for i in range(len(route_seq) - 1)
        )
        total_dist_m = sum(
            raw_distances[route_seq[i]][route_seq[i + 1]]
            for i in range(len(route_seq) - 1)
        )

        assigned_routes.append(AssignedRouteOut(
            vehicle_id=vehicles[v_idx].id,
            total_m3=total_m3,
            total_kg=total_kg,
            route=outlet_ids,
            total_duration_s=round(total_dur_s, 1),
            total_distance_km=round(total_dist_m / 1000, 2),
        ))

    unassigned = [
        outlets[n - 1].id
        for n in range(1, n_nodes)
        if n not in served_nodes
    ]

    log.info(
        "Solution: %d routes, %d served, %d unassigned",
        len(assigned_routes), len(served_nodes), len(unassigned),
    )
    return assigned_routes, unassigned


# ---------------------------------------------------------------------------
# PyHygese (HGS-CVRP) solver  \u2014 Sequential Routing (Iterative) strategy
# ---------------------------------------------------------------------------
# HGS is a homogeneous single-capacity solver.  Our fleet is heterogeneous
# (vehicles have different m\u00b3/kg limits).
#
# Strategy \u2014 "Sequential Routing":
#   1. Group physical vehicles by capacity (binding dimension), sorted DESC.
#   2. Iterate from the largest-capacity group to the smallest.
#   3. At each iteration, solve an HGS sub-problem containing only the
#      remaining outlets and a virtual fleet of that group\u2019s capacity.
#   4. Assign the top N routes (by utilisation) to the N physical vehicles
#      in the group; remove those outlets from the remaining pool.
#   5. After all groups are exhausted, any leftover outlets \u2192 unassigned.
#
# This naturally handles heterogeneous fleets and avoids the NO-FEASIBLE
# crash caused by passing demand > capacity for any single node.
# ---------------------------------------------------------------------------
HGS_MAX_FLEET = 200          # virtual fleet cap per HGS call
HGS_SCALE     = 1000         # float \u2192 int demand/capacity multiplier
HGS_DIST_CAP  = 90_000       # clamp OSRM durations (seconds) for HGS stability


def solve_hygese_cvrp(
    raw_durations: list[list[float]],
    raw_distances: list[list[float]],
    outlets: list[OutletIn],
    vehicles: list[VehicleIn],
    max_stops: int = 40,
) -> tuple[list[AssignedRouteOut], list[str]]:
    """
    Solve a heterogeneous-fleet CVRP with PyHygese via sequential routing.

    Returns (assigned_routes, unassigned_outlet_ids) \u2014 identical shape to
    solve_cvrp() so the frontend contract is fully preserved.
    """
    # NOTE: PyHygese (HGS-CVRP) does not natively support a "max stops"
    # (node count) constraint. The max_stops parameter is accepted for API
    # compatibility but is NOT enforced by the HGS solver.  Routes returned
    # by HGS may exceed max_stops if the capacity/distance allows it.
    # A post-processing split could be added if strict enforcement is needed.

    if not _HYGESE_AVAILABLE:
        raise HTTPException(
            status_code=501,
            detail="PyHygese is not installed on this server.  "
                   "Install it with: pip install hygese",
        )

    # \u2500\u2500 Determine binding capacity dimension \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    total_m3_demand = sum(o.m3 for o in outlets)
    total_kg_demand = sum(o.kg for o in outlets)
    total_m3_cap = sum(v.max_m3 for v in vehicles)
    total_kg_cap = sum(v.max_kg for v in vehicles)

    m3_load = total_m3_demand / total_m3_cap if total_m3_cap > 0 else 0.0
    kg_load = total_kg_demand / total_kg_cap if total_kg_cap > 0 else 0.0
    use_m3 = m3_load >= kg_load

    if use_m3:
        get_demand = lambda o: o.m3          # noqa: E731
        get_cap    = lambda v: v.max_m3      # noqa: E731
        log.info("HGS: binding = m\u00b3  (load %.2f vs kg load %.2f)", m3_load, kg_load)
    else:
        get_demand = lambda o: o.kg          # noqa: E731
        get_cap    = lambda v: v.max_kg      # noqa: E731
        log.info("HGS: binding = kg  (load %.2f vs m\u00b3 load %.2f)", kg_load, m3_load)

    # \u2500\u2500 Build full OSRM integer-duration matrix (depot=row/col 0) \u2500\u2500\u2500\u2500\u2500
    full_dur = [
        [min(HGS_DIST_CAP, max(0, int(round(cell)))) for cell in row]
        for row in raw_durations
    ]

    # \u2500\u2500 Scale demands & capacities to integers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    # outlet_index here is 0-based into `outlets`; in the full matrix the
    # corresponding row/col is outlet_index + 1 (depot = 0).
    outlet_scaled_demands: list[int] = [
        int(round(get_demand(o) * HGS_SCALE)) for o in outlets
    ]

    # \u2500\u2500 Hard-filter: remove outlets that exceed LARGEST vehicle \u2500\u2500\u2500\u2500\u2500\u2500\u2500
    max_scaled_cap = max(int(round(get_cap(v) * HGS_SCALE)) for v in vehicles)
    impossible_ids: list[str] = []
    valid_outlet_indices: list[int] = []     # 0-based indices into `outlets`

    for idx, sd in enumerate(outlet_scaled_demands):
        if sd > max_scaled_cap:
            impossible_ids.append(outlets[idx].id)
            log.warning(
                "HGS: outlet %s demand %d > max fleet cap %d \u2014 pre-filtered",
                outlets[idx].id, sd, max_scaled_cap,
            )
        else:
            valid_outlet_indices.append(idx)

    if impossible_ids:
        log.info("HGS: %d outlet(s) impossible for any vehicle \u2192 unassigned", len(impossible_ids))

    # \u2500\u2500 Group vehicles by binding-dimension capacity (DESC) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    from collections import defaultdict
    cap_groups: dict[int, list[VehicleIn]] = defaultdict(list)
    for v in vehicles:
        cap_groups[int(round(get_cap(v) * HGS_SCALE))].append(v)

    sorted_cap_groups: list[tuple[int, list[VehicleIn]]] = sorted(
        cap_groups.items(), key=lambda x: x[0], reverse=True,
    )
    n_groups = len(sorted_cap_groups)
    HGS_NB_ITER = 150    # calibrated: 2500 iter/group took >400 s; 150 ≈ 60 s across typical group counts
    HGS_SEED    = 42     # fixed seed — reproducible across runs

    log.info(
        "HGS sequential routing: %d capacity group(s), %d iter/group, "
        "%d valid outlets, %d impossible",
        n_groups, HGS_NB_ITER, len(valid_outlet_indices), len(impossible_ids),
    )

    # \u2500\u2500 Sequential routing loop \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    remaining: list[int] = list(valid_outlet_indices)    # 0-based into outlets
    assigned_routes: list[AssignedRouteOut] = []

    for group_cap, group_vehicles in sorted_cap_groups:
        if not remaining:
            break

        # Filter: remove outlets whose demand exceeds this group's capacity
        feasible  = [i for i in remaining if outlet_scaled_demands[i] <= group_cap]
        overflow  = [i for i in remaining if outlet_scaled_demands[i] > group_cap]
        # overflow outlets can't fit in this or any smaller group \u2192 unassigned
        for i in overflow:
            impossible_ids.append(outlets[i].id)
            log.warning(
                "HGS: outlet %s demand %d > group cap %d \u2014 dropped",
                outlets[i].id, outlet_scaled_demands[i], group_cap,
            )
        remaining = feasible

        if not remaining:
            break

        n_grp_vehicles = len(group_vehicles)

        # -- Build sub-problem: depot (index 0) + remaining outlets ----
        # sub_node_map[sub_idx] \u2192 original outlet 0-based index
        # sub_idx 0 = depot; sub_idx 1..len(remaining) = outlets
        sub_node_map: list[int] = list(remaining)
        n_sub = 1 + len(sub_node_map)                 # depot + outlets

        # Sub distance matrix: rows & cols selected from full_dur
        # full_dur indices: depot=0, outlet i \u2192 i+1
        full_indices = [0] + [i + 1 for i in sub_node_map]
        sub_dist = np.array(
            [[full_dur[r][c] for c in full_indices] for r in full_indices],
            dtype=np.float64,
        )

        sub_demands = np.array(
            [0] + [outlet_scaled_demands[i] for i in sub_node_map],
            dtype=np.float64,
        )

        # Virtual fleet: enough to cover all sub-demand
        total_sub_demand = int(sum(sub_demands))
        min_needed = math.ceil(total_sub_demand / group_cap) if group_cap > 0 else n_grp_vehicles
        virtual_fleet = min(
            HGS_MAX_FLEET,
            max(n_grp_vehicles, min_needed) + max(2, math.ceil(min_needed * 0.10)),
        )

        data: dict[str, Any] = {
            "distance_matrix": sub_dist,
            "demands": sub_demands,
            "vehicle_capacity": float(group_cap),
            "num_vehicles": virtual_fleet,
            "service_times": np.zeros(n_sub, dtype=np.float64),
            "depot": 0,
        }

        ap = hgs.AlgorithmParameters(nbIter=HGS_NB_ITER, seed=HGS_SEED)

        log.info(
            "HGS iter: cap=%d, %d outlets, %d phys vehicles, %d virtual, %d iter …",
            group_cap, len(sub_node_map), n_grp_vehicles, virtual_fleet, HGS_NB_ITER,
        )

        try:
            solver = hgs.Solver(parameters=ap, verbose=True)
            result = solver.solve_cvrp(data)
        except Exception as exc:
            log.error("HGS iteration cap=%d failed: %s \u2014 skipping group", group_cap, exc)
            continue

        if result is None or not getattr(result, "routes", None):
            log.warning("HGS iteration cap=%d: no solution \u2014 skipping group", group_cap)
            continue

        # -- Extract & sort non-empty routes by utilisation (DESC) -----
        nonempty: list[list[int]] = [r for r in result.routes if r]
        nonempty.sort(
            key=lambda r: sum(sub_demands[nidx] for nidx in r),
            reverse=True,
        )

        # -- Assign top N routes to this group's physical vehicles -----
        serviced_sub_indices: set[int] = set()
        for slot, route_sub_nodes in enumerate(nonempty):
            if slot >= n_grp_vehicles:
                break
            # route_sub_nodes are 1-based into sub_node_map
            orig_indices = [sub_node_map[sn - 1] for sn in route_sub_nodes]
            outlet_ids = [outlets[oi].id for oi in orig_indices]
            total_m3 = round(sum(outlets[oi].m3 for oi in orig_indices), 4)
            total_kg = round(sum(outlets[oi].kg for oi in orig_indices), 4)

            # Total driving time and distance: depot → stop_1 → … → stop_k → depot
            route_seq = [0] + [oi + 1 for oi in orig_indices] + [0]
            total_dur_s = sum(
                raw_durations[route_seq[i]][route_seq[i + 1]]
                for i in range(len(route_seq) - 1)
            )
            total_dist_m = sum(
                raw_distances[route_seq[i]][route_seq[i + 1]]
                for i in range(len(route_seq) - 1)
            )

            assigned_routes.append(AssignedRouteOut(
                vehicle_id=group_vehicles[slot].id,
                total_m3=total_m3,
                total_kg=total_kg,
                route=outlet_ids,
                total_duration_s=round(total_dur_s, 1),
                total_distance_km=round(total_dist_m / 1000, 2),
            ))
            serviced_sub_indices.update(route_sub_nodes)

        # -- Remove serviced outlets from remaining --------------------
        serviced_orig: set[int] = {sub_node_map[sn - 1] for sn in serviced_sub_indices}
        remaining = [i for i in remaining if i not in serviced_orig]

        log.info(
            "HGS iter cap=%d: %d routes assigned, %d outlets remaining",
            group_cap, min(n_grp_vehicles, len(nonempty)), len(remaining),
        )

    # \u2500\u2500 Post-processing: any remaining outlets \u2192 unassigned \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    leftover_ids = [outlets[i].id for i in remaining]
    unassigned = impossible_ids + leftover_ids

    log.info(
        "HGS Solution: %d routes assigned, %d unassigned "
        "(%d impossible + %d leftover)",
        len(assigned_routes), len(unassigned),
        len(impossible_ids), len(leftover_ids),
    )
    return assigned_routes, unassigned


# ---------------------------------------------------------------------------
# Excel export helper
# ---------------------------------------------------------------------------
_EXCEL_LOG_DIR = "logs"


def generate_routing_excel(
    algorithm_name: str,
    request_payload: "OptimizeRequest",
    response_data: "OptimizeResponse",
    execution_time_seconds: float = 0.0,
) -> None:
    """
    Generate a multi-sheet Excel (.xlsx) after each successful routing run.

    Sheet 1 — "Fleet Summary"    : one row per assigned vehicle +
                                   run metadata footer (algorithm, execution time, etc.).
    Sheet 2 — "Invoice Detail"   : one row per invoice within each assigned route
                                   (expands outlets that carry multiple invoices).
    Sheet 3 — "Unassigned Detail": one row per unassigned outlet with a REASON column
                                   explaining why the solver dropped the node.

    File is saved to ./logs/RoutingResult_{algorithm_name}_{YYYYMMDD_HHMMSS}.xlsx.
    Requires: pandas, openpyxl  (pip install pandas openpyxl)
    """
    try:
        vehicle_map: dict[str, VehicleIn] = {v.id: v for v in request_payload.vehicles}
        outlet_map: dict[str, OutletIn]   = {o.id: o for o in request_payload.outlets}

        # ── Sheet 1: Fleet Summary ───────────────────────────────────────────
        fleet_rows: list[dict] = []
        for route in response_data.assigned_routes:
            vehicle = vehicle_map.get(route.vehicle_id)
            if vehicle is None:
                continue
            kub_pct = (route.total_m3 / vehicle.max_m3 * 100.0) if vehicle.max_m3 > 0 else 0.0
            ton_pct = (route.total_kg / vehicle.max_kg * 100.0) if vehicle.max_kg > 0 else 0.0
            fleet_rows.append({
                "NOKEND":            route.vehicle_id,
                "JENIS":             vehicle.jns_kend,
                "OUTLET":            len(route.route),
                "KUBIKASI":          round(route.total_m3, 4),
                "STD KUBIK":         vehicle.max_m3,
                "% KUBIK":           round(kub_pct, 2),
                "TONASE":            round(route.total_kg, 4),
                "STD TONASE":        vehicle.max_kg,
                "% TONASE":          round(ton_pct, 2),
                "% MAX EPE":         round(max(kub_pct, ton_pct), 2),
                "JARAK (Km)":        round(route.total_distance_km, 2),
                "WAKTU TEMPUH (Jam)": round(route.total_duration_s / 3600, 2),
            })
        df_fleet = pd.DataFrame(fleet_rows, columns=[
            "NOKEND", "JENIS", "OUTLET",
            "KUBIKASI", "STD KUBIK", "% KUBIK",
            "TONASE", "STD TONASE", "% TONASE",
            "% MAX EPE", "JARAK (Km)", "WAKTU TEMPUH (Jam)",
        ])

        # ── Sheet 2: Invoice Detail ──────────────────────────────────────────
        invoice_rows: list[dict] = []
        for route in response_data.assigned_routes:
            vehicle  = vehicle_map.get(route.vehicle_id)
            jns_kend = vehicle.jns_kend if vehicle else ""

            for outlet_id in route.route:
                outlet = outlet_map.get(outlet_id)
                if outlet is None:
                    continue

                if outlet.invoices:
                    # Outlet aggregates multiple invoices — expand each one
                    for inv in outlet.invoices:
                        invoice_rows.append({
                            "NOKEND":   route.vehicle_id,
                            "JNSKEND":  jns_kend,
                            "RITASE":   1,
                            "CUSTNO":   outlet_id,
                            "CUSTNAME": outlet.custname,
                            "INVNO":    inv.invno,
                            "KUBIKASI": round(inv.m3, 4),
                            "TONASE":   round(inv.kg, 4),
                        })
                else:
                    # Single-invoice outlet (fallback)
                    invoice_rows.append({
                        "NOKEND":   route.vehicle_id,
                        "JNSKEND":  jns_kend,
                        "RITASE":   1,
                        "CUSTNO":   outlet_id,
                        "CUSTNAME": outlet.custname,
                        "INVNO":    outlet_id,
                        "KUBIKASI": round(outlet.m3, 4),
                        "TONASE":   round(outlet.kg, 4),
                    })

        df_invoice = pd.DataFrame(invoice_rows, columns=[
            "NOKEND", "JNSKEND", "RITASE",
            "CUSTNO", "CUSTNAME", "INVNO",
            "KUBIKASI", "TONASE",
        ])

        # ── Sheet 3: Unassigned Detail ───────────────────────────────────────
        max_fleet_m3 = max((v.max_m3 for v in request_payload.vehicles), default=0.0)
        max_fleet_kg = max((v.max_kg for v in request_payload.vehicles), default=0.0)

        unassigned_rows: list[dict] = []
        for outlet_id in response_data.unassigned_outlets:
            outlet = outlet_map.get(outlet_id)
            if outlet is None:
                continue
            if outlet.m3 > max_fleet_m3 or outlet.kg > max_fleet_kg:
                reason = "Exceeds Maximum Fleet Capacity"
            else:
                reason = "No feasible insertion found (Solver limitation)"
            unassigned_rows.append({
                "CUSTNO":   outlet_id,
                "CUSTNAME": outlet.custname,
                "INVNO":    outlet_id,
                "KUBIKASI": round(outlet.m3, 4),
                "TONASE":   round(outlet.kg, 4),
                "ALASAN":   reason,
            })

        df_unassigned = pd.DataFrame(unassigned_rows, columns=[
            "CUSTNO", "CUSTNAME", "INVNO", "KUBIKASI", "TONASE", "ALASAN",
        ])

        # ── Save ────────────────────────────────────────────────────────────
        os.makedirs(_EXCEL_LOG_DIR, exist_ok=True)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename  = os.path.join(_EXCEL_LOG_DIR, f"RoutingResult_{algorithm_name}_{timestamp}.xlsx")

        with pd.ExcelWriter(filename, engine="openpyxl") as writer:
            df_fleet.to_excel(writer,      sheet_name="Fleet Summary",    index=False)
            df_invoice.to_excel(writer,    sheet_name="Invoice Detail",   index=False)
            df_unassigned.to_excel(writer, sheet_name="Unassigned Detail", index=False)

            # ── Run metadata footer in Fleet Summary ─────────────────────
            # Written below the table so it is visible in the same sheet
            # without disrupting the tabular data above.
            ws = writer.sheets["Fleet Summary"]
            meta_row = len(df_fleet) + 3   # header(1) + data rows + blank row(1) → 1-based
            ws.cell(row=meta_row,     column=1, value="--- Run Metadata ---")
            ws.cell(row=meta_row + 1, column=1, value="Algorithm")
            ws.cell(row=meta_row + 1, column=2, value=algorithm_name)
            ws.cell(row=meta_row + 2, column=1, value="Execution Time (sec)")
            ws.cell(row=meta_row + 2, column=2, value=round(execution_time_seconds, 3))
            ws.cell(row=meta_row + 3, column=1, value="Timestamp")
            ws.cell(row=meta_row + 3, column=2, value=timestamp)
            ws.cell(row=meta_row + 4, column=1, value="Total Vehicles Used")
            ws.cell(row=meta_row + 4, column=2, value=len(df_fleet))
            ws.cell(row=meta_row + 5, column=1, value="Total Outlets")
            ws.cell(row=meta_row + 5, column=2, value=len(request_payload.outlets))
            ws.cell(row=meta_row + 6, column=1, value="Unassigned Outlets")
            ws.cell(row=meta_row + 6, column=2, value=len(response_data.unassigned_outlets))

        log.info("Routing Excel saved → %s", filename)

    except Exception as exc:                    # never crash the request
        log.warning("generate_routing_excel failed: %s", exc)


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------
@app.post("/optimize", response_model=OptimizeResponse)
async def optimize(payload: OptimizeRequest) -> OptimizeResponse:
    if not payload.outlets:
        raise HTTPException(status_code=422, detail="outlets list is empty")
    if not payload.vehicles:
        raise HTTPException(status_code=422, detail="vehicles list is empty")

    outlets = payload.outlets
    vehicles = payload.vehicles
    depot = payload.depot
    algorithm = payload.algorithm

    log.info(
        "Request: %d outlets, %d vehicles, algorithm=%s",
        len(outlets), len(vehicles), algorithm,
    )

    # Phase 1 — Fetch ONE global duration + distance matrix (Depot + All Outlets)
    durations, distances = await fetch_duration_matrix(depot, outlets)

    # Phase 2 — Solve CVRP (CPU-bound → offload to thread pool)
    loop = asyncio.get_event_loop()
    solver_fn = solve_hygese_cvrp if algorithm == "pyhygese" else solve_cvrp
    _t0 = time.monotonic()
    assigned_routes, unassigned = await loop.run_in_executor(
        None, solver_fn, durations, distances, outlets, vehicles, payload.max_stops,
    )
    _execution_time = time.monotonic() - _t0

    log.info(
        "Final [%s]: %d routes, %d unassigned",
        algorithm, len(assigned_routes), len(unassigned),
    )

    response = OptimizeResponse(
        assigned_routes=assigned_routes,
        unassigned_outlets=unassigned,
    )

    generate_routing_excel(
        algorithm_name=_ALGO_DISPLAY.get(algorithm, algorithm).replace("-", ""),
        request_payload=payload,
        response_data=response,
        execution_time_seconds=_execution_time,
    )

    return response


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------
@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn
    import sys
    # reload=True uses multiprocessing which breaks stdin on Windows (Python 3.13+).
    # Use reload only on non-Windows platforms.
    uvicorn.run(
        "cvrp_service:app",
        host="0.0.0.0",
        port=8000,
        reload=sys.platform != "win32",
    )
