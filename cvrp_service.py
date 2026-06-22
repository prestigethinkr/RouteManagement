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
OSRM_BASE = "http://203.175.125.185:8001"

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

# Continuous proportional fixed cost parameters
# fixed_cost = BASE_FEE + (vehicle.max_m3 * COST_PER_M3_MULTIPLIER)
FIXED_COST_BASE   =    500
FIXED_COST_PER_M3 =   2000
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
    trip_iteration: int = Field(
        default=1,
        description="Trip iteration number for this routing wave",
    )


class AssignedRouteOut(BaseModel):
    vehicle_id: str
    total_m3: float
    total_kg: float
    route: list[str]           # ordered outlet IDs
    total_duration_s: float = 0.0   # total driving time in seconds (depot → stops → depot)
    total_distance_km: float = 0.0  # total driving distance in km (depot → stops → depot)
    trip_iteration: int = 1


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
    Fetch the full (N+1)×(N+1) duration AND distance matrices from OSRM
    using parallel source-batched requests via asyncio.gather.

    Why batching:
      • A single request for 1451 nodes (2.1M pairs) blocks OSRM for ~40 s.
      • Splitting into BATCH_SIZE-source chunks lets OSRM compute each sub-matrix
        concurrently on separate connections — wall-clock time ≈ max(batch time)
        instead of sum(batch times), typically 4-8× faster.
      • OSRM `sources=` / `destinations=` are index parameters — all batches
        share the same coordinate list in the URL path; only source indices vary.

    Index 0 = depot; indices 1..N = outlets in payload order.
    Returns (durations_seconds, distances_meters).
    """
    BATCH_SIZE = 200   # source rows per parallel request — tune for your OSRM hardware

    # Build coordinate list: depot first (index 0), then outlets.
    # Truncate to 5 decimal places (~1.1 m accuracy) — shrinks path URL ~15%
    # without any meaningful impact on route quality.
    coord_parts: list[str] = [f"{depot.lng:.5f},{depot.lat:.5f}"]
    coord_parts.extend(f"{o.lng:.5f},{o.lat:.5f}" for o in outlets)
    coord_str = ";".join(coord_parts)
    n = len(coord_parts)  # total nodes including depot

    base_path = f"{OSRM_BASE}/table/v1/driving/{coord_str}"
    dest_str = ";".join(str(i) for i in range(n))

    # Partition source indices into batches
    source_batches = [
        list(range(start, min(start + BATCH_SIZE, n)))
        for start in range(0, n, BATCH_SIZE)
    ]

    log.info(
        "OSRM matrix: %d nodes → %d parallel batch(es) of ≤%d sources each",
        n, len(source_batches), BATCH_SIZE,
    )

    # Limit concurrency to avoid overwhelming the OSRM server and triggering connection resets
    sem = asyncio.Semaphore(2)

    async def fetch_batch(
        client: httpx.AsyncClient,
        source_indices: list[int],
        batch_idx: int,
    ) -> dict[str, Any]:
        src_str = ";".join(str(i) for i in source_indices)
        params = {
            "sources":      src_str,
            "destinations": dest_str,
            "annotations":  "duration,distance",
        }
        
        max_retries = 3
        for attempt in range(max_retries):
            try:
                async with sem:
                    resp = await client.get(base_path, params=params)
                    if resp.status_code != 200:
                        raise HTTPException(
                            status_code=502,
                            detail=f"OSRM batch {batch_idx} HTTP {resp.status_code}: {resp.text[:300]}",
                        )
                    data: dict[str, Any] = resp.json()
                    if data.get("code") != "Ok":
                        raise HTTPException(
                            status_code=502,
                            detail=f"OSRM batch {batch_idx} error: {data.get('code')} — {data.get('message', '')}",
                        )
                    return data
            except (httpx.ConnectError, httpx.ReadTimeout, httpx.PoolTimeout) as e:
                log.warning("OSRM batch %d attempt %d failed with %s: %s", batch_idx, attempt + 1, type(e).__name__, str(e))
                if attempt == max_retries - 1:
                    raise HTTPException(status_code=502, detail=f"OSRM connection failed after {max_retries} attempts: {str(e)}")
                await asyncio.sleep(2 ** attempt)  # Exponential backoff

    # Shared client — connection pool reused across parallel batch coroutines
    async with httpx.AsyncClient(
        timeout=httpx.Timeout(connect=15.0, read=180.0, write=30.0, pool=10.0),
        limits=httpx.Limits(max_connections=10, max_keepalive_connections=5),
    ) as client:
        batch_results: list[dict[str, Any]] = await asyncio.gather(
            *[fetch_batch(client, batch, idx) for idx, batch in enumerate(source_batches)]
        )

    # Reassemble full NxN matrices by concatenating batch rows in order
    durations: list[list[float]] = []
    distances: list[list[float]] = []
    for data in batch_results:
        durations.extend(data["durations"])
        distances.extend(data["distances"])

    log.info(
        "OSRM matrix assembled: %d×%d (duration + distance) from %d parallel batch(es)",
        len(durations), len(durations[0]), len(source_batches),
    )
    return durations, distances



# ---------------------------------------------------------------------------
# OR-Tools — Global CVRP solver
# ---------------------------------------------------------------------------
def _build_int_matrices(
    raw_durations: list[list[float]],
) -> tuple[list[list[int]], list[list[int]]]:
    """
    Pre-compute two integer matrices from the raw OSRM durations using NumPy
    vectorized operations — same formula as before, ~50-100× faster for N>200:
      • int_dur    — raw seconds, rounded (hard time-cap dimension)
      • hybrid     — d + d²/QUAD_DIVISOR  (arc cost: ultra-aggressive
                     spaghetti prevention without removing the linear floor)
    """
    arr = np.array(raw_durations, dtype=np.float64)
    # Clip negatives then round to integer seconds
    d = np.maximum(0, np.round(arr)).astype(np.int64)
    # Hybrid cost: same formula d + d² // QUAD_DIVISOR, fully vectorized
    hybrid_np = d + (d * d) // QUAD_DIVISOR
    # Convert back to nested Python lists (OR-Tools callbacks index into them)
    int_dur: list[list[int]] = d.tolist()
    hybrid:  list[list[int]] = hybrid_np.tolist()
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

    # Continuous proportional fixed cost per vehicle.
    # Mathematically forces the solver to prefer small/cheap vehicles 
    # and severely penalizes activating large trucks for small loads.
    for v_idx, vehicle in enumerate(vehicles):
        fixed_cost = int(2000 + (vehicle.max_m3 * 100))
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
    # Apply Global Span Cost Coefficient to balance workload (duration) across active vehicles.
    # This strongly penalizes the maximum difference in route durations across the fleet,
    # preventing extreme driver workload imbalance.
    time_dimension = routing.GetDimensionOrDie("Time")
    time_dimension.SetGlobalSpanCostCoefficient(10)

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
        routing.AddDisjunction([manager.NodeToIndex(node)], 10_000_000)

    # ── search parameters (Dual Safety Net) ───────────────────────────
    params = pywrapcp.DefaultRoutingSearchParameters()
    params.first_solution_strategy = (
        routing_enums_pb2.FirstSolutionStrategy.SAVINGS
    )
    params.local_search_metaheuristic = (
        routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    )
    
    # 1. Hard fail-safe time limit
    params.time_limit.seconds = 60
    
    # 2. Pragmatic target for local search improvements
    params.solution_limit = 100
    
    # Ensure search logging is on to monitor solver iteration speed and cost drops
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

    # ── Build full OSRM integer-duration matrix as NumPy array (depot=row/col 0) ──
    full_dur = np.array(
        [[min(HGS_DIST_CAP, max(0, int(round(cell)))) for cell in row]
         for row in raw_durations],
        dtype=np.int64,
    )

    # \u2500\u2500 Scale demands & capacities to integers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    # outlet_index here is 0-based into `outlets`; in the full matrix the
    # corresponding row/col is outlet_index + 1 (depot = 0).
    outlet_scaled_demands: list[int] = [
        int(round(get_demand(o) * HGS_SCALE)) for o in outlets
    ]

    # \u2500\u2500 Hard-filter: remove outlets that exceed LARGEST vehicle \u2500\u2500\u2500\u2500\u2500\u2500\u2500
    # ── Hard-filter: remove outlets that exceed LARGEST vehicle ────────────────
    max_scaled_cap = max(int(round(get_cap(v) * HGS_SCALE)) for v in vehicles)
    impossible_ids: list[str] = []
    valid_outlet_indices: list[int] = []     # 0-based indices into `outlets`

    for idx, sd in enumerate(outlet_scaled_demands):
        if sd > max_scaled_cap:
            impossible_ids.append(outlets[idx].id)
            log.warning(
                "HGS: outlet %s demand %d > max fleet cap %d — pre-filtered",
                outlets[idx].id, sd, max_scaled_cap,
            )
        else:
            valid_outlet_indices.append(idx)

    if impossible_ids:
        log.info("HGS: %d outlet(s) impossible for any vehicle → unassigned", len(impossible_ids))

    # ── Group vehicles by binding-dimension capacity (DESC) ────────────────
    from collections import defaultdict
    cap_groups: dict[int, list[VehicleIn]] = defaultdict(list)
    for v in vehicles:
        cap_groups[int(round(get_cap(v) * HGS_SCALE))].append(v)

    sorted_cap_groups: list[tuple[int, list[VehicleIn]]] = sorted(
        cap_groups.items(), key=lambda x: x[0], reverse=True,
    )
    n_groups = len(sorted_cap_groups)
    HGS_NB_ITER = 50     # Reduced from 150 for faster execution speed
    HGS_SEED    = 42     # fixed seed — reproducible across runs

    log.info(
        "HGS concurrent routing: %d capacity group(s), %d iter/group, "
        "%d valid outlets, %d impossible",
        n_groups, HGS_NB_ITER, len(valid_outlet_indices), len(impossible_ids),
    )

    # ── Pre-pass: partition outlets into per-group feasibility pools ──────────
    # Groups must still be processed largest-capacity-first so that overflow
    # detection is correct (an outlet rejected by a large group is impossible
    # for smaller ones too).  We compute the assignment sequentially but run
    # the actual HGS solves in parallel.
    remaining: list[int] = list(valid_outlet_indices)   # 0-based into outlets

    # Each entry: (group_cap, group_vehicles, feasible_outlet_indices)
    group_tasks: list[tuple[int, list[VehicleIn], list[int]]] = []

    for group_cap, group_vehicles in sorted_cap_groups:
        if not remaining:
            break

        feasible = [i for i in remaining if outlet_scaled_demands[i] <= group_cap]
        overflow = [i for i in remaining if outlet_scaled_demands[i] > group_cap]
        for i in overflow:
            impossible_ids.append(outlets[i].id)
            log.warning(
                "HGS: outlet %s demand %d > group cap %d — dropped",
                outlets[i].id, outlet_scaled_demands[i], group_cap,
            )
        remaining = feasible

        if not remaining:
            break

        group_tasks.append((group_cap, group_vehicles, list(remaining)))

    # ── Worker: solve one HGS group, return (group_cap, group_vehicles, result, sub_demands, sub_node_map)
    def _run_hgs_group(
        task: tuple[int, list[VehicleIn], list[int]],
    ):
        group_cap, group_vehicles, feasible_indices = task
        n_grp_vehicles = len(group_vehicles)

        sub_node_map: list[int] = list(feasible_indices)
        n_sub = 1 + len(sub_node_map)

        full_indices = [0] + [i + 1 for i in sub_node_map]
        # Vectorized sub-matrix selection using NumPy fancy indexing
        sub_dist = full_dur[np.ix_(full_indices, full_indices)].astype(np.float64)

        sub_demands = np.array(
            [0] + [outlet_scaled_demands[i] for i in sub_node_map],
            dtype=np.float64,
        )

        total_sub_demand = int(sub_demands.sum())
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
            "HGS group: cap=%d, %d outlets, %d phys vehicles, %d virtual, %d iter …",
            group_cap, len(sub_node_map), n_grp_vehicles, virtual_fleet, HGS_NB_ITER,
        )
        try:
            solver = hgs.Solver(parameters=ap, verbose=True)
            result = solver.solve_cvrp(data)
        except Exception as exc:
            log.error("HGS group cap=%d failed: %s — skipping", group_cap, exc)
            result = None

        return group_cap, group_vehicles, result, sub_demands, sub_node_map

    # ── Concurrent execution — HGS is a C++ process; GIL is released ─────────
    from concurrent.futures import ThreadPoolExecutor
    assigned_routes: list[AssignedRouteOut] = []

    with ThreadPoolExecutor(max_workers=min(n_groups, 4)) as executor:
        futures = [executor.submit(_run_hgs_group, task) for task in group_tasks]
        ordered_results = [f.result() for f in futures]
    
    # Re-sort by group_cap DESC to assign routes in correct priority order
    ordered_results.sort(key=lambda x: x[0], reverse=True)

    # Track which outlet indices have been assigned across groups
    globally_serviced: set[int] = set()

    for group_cap, group_vehicles, result, sub_demands, sub_node_map in ordered_results:
        n_grp_vehicles = len(group_vehicles)

        if result is None or not getattr(result, "routes", None):
            log.warning("HGS group cap=%d: no solution — skipping", group_cap)
            continue

        nonempty: list[list[int]] = [r for r in result.routes if r]
        nonempty.sort(
            key=lambda r: sum(sub_demands[nidx] for nidx in r),
            reverse=True,
        )

        serviced_sub_indices: set[int] = set()
        for slot, route_sub_nodes in enumerate(nonempty):
            if slot >= n_grp_vehicles:
                break
            orig_indices = [sub_node_map[sn - 1] for sn in route_sub_nodes]
            # Skip any outlets already assigned by a higher-capacity group
            orig_indices = [oi for oi in orig_indices if oi not in globally_serviced]
            if not orig_indices:
                continue

            outlet_ids = [outlets[oi].id for oi in orig_indices]
            total_m3 = round(sum(outlets[oi].m3 for oi in orig_indices), 4)
            total_kg = round(sum(outlets[oi].kg for oi in orig_indices), 4)

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
        newly_serviced = {sub_node_map[sn - 1] for sn in serviced_sub_indices}
        globally_serviced.update(newly_serviced)
        log.info(
            "HGS group cap=%d: %d routes assigned",
            group_cap, min(n_grp_vehicles, len(nonempty)),
        )

    # ── Post-processing: any outlet not globally serviced → unassigned ──────────
    all_feasible = {i for _, _, feasible in group_tasks for i in feasible}
    leftover_ids = [outlets[i].id for i in all_feasible if i not in globally_serviced]
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
        vehicle_map: dict[str, VehicleIn] = {v.id.split(" (Trip ")[0]: v for v in request_payload.vehicles}
        outlet_map: dict[str, OutletIn]   = {o.id: o for o in request_payload.outlets}

        # ── Sheet 1: Fleet Summary ───────────────────────────────────────────
        fleet_rows: list[dict] = []
        for route in response_data.assigned_routes:
            base_vehicle_id = route.vehicle_id.split(" (Trip ")[0]
            vehicle = vehicle_map.get(base_vehicle_id)
            if vehicle is None:
                continue
            kub_pct = (route.total_m3 / vehicle.max_m3 * 100.0) if vehicle.max_m3 > 0 else 0.0
            ton_pct = (route.total_kg / vehicle.max_kg * 100.0) if vehicle.max_kg > 0 else 0.0
            fleet_rows.append({
                "Trip_Iteration":    route.trip_iteration,
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
            "Trip_Iteration", "NOKEND", "JENIS", "OUTLET",
            "KUBIKASI", "STD KUBIK", "% KUBIK",
            "TONASE", "STD TONASE", "% TONASE",
            "% MAX EPE", "JARAK (Km)", "WAKTU TEMPUH (Jam)",
        ])

        # ── Sheet 2: Invoice Detail ──────────────────────────────────────────
        invoice_rows: list[dict] = []
        for route in response_data.assigned_routes:
            base_vehicle_id = route.vehicle_id.split(" (Trip ")[0]
            vehicle  = vehicle_map.get(base_vehicle_id)
            jns_kend = vehicle.jns_kend if vehicle else ""

            for outlet_id in route.route:
                outlet = outlet_map.get(outlet_id)
                if outlet is None:
                    continue

                if outlet.invoices:
                    # Outlet aggregates multiple invoices — expand each one
                    for inv in outlet.invoices:
                        invoice_rows.append({
                            "Trip_Iteration": route.trip_iteration,
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
                        "Trip_Iteration": route.trip_iteration,
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
            "Trip_Iteration", "NOKEND", "JNSKEND", "RITASE",
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
    
    # Tag routes with the current trip iteration
    for route in assigned_routes:
        route.trip_iteration = payload.trip_iteration
        
    _execution_time = time.monotonic() - _t0

    log.info(
        "Final [%s] Trip %d: %d routes, %d unassigned",
        algorithm, payload.trip_iteration, len(assigned_routes), len(unassigned),
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
