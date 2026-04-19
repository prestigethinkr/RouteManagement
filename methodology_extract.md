# Methodology Extract — CVRP with Heterogeneous Fleet

> **Source file:** `cvrp_service.py` — FastAPI service implementing both solvers.
> Auto-generated from codebase audit. Every constant, formula, and logic branch
> referenced below maps directly to the implemented source code.

---

## 1. Data Pre-Processing & OSRM Integration

### 1.1 Duration Matrix Acquisition

A single global duration matrix of dimension $(N{+}1) \times (N{+}1)$ is fetched
from a self-hosted OSRM Table API instance (HTTP, `annotations=duration`), where
index 0 represents the depot and indices $1 \dots N$ represent the outlets in
payload order.

| Condition | HTTP Method | Rationale |
|---|---|---|
| URL length ≤ 4 000 chars | `GET` | Fits within standard URI limits |
| URL length > 4 000 chars | `GET` with query params | Avoids HTTP 414 for large coordinate sets (1 000+ nodes) |

The HTTP client timeout is set to **180 s** to accommodate large matrices.

The raw response yields `durations: list[list[float]]` — pairwise driving times
in **seconds** (floating-point).

### 1.2 Demand & Capacity Scaling (OR-Tools)

OR-Tools requires integer coefficients for all dimensions. Floating-point demands
(m³, kg) and vehicle capacities are converted to integers via a global scale factor:

$$
\text{DEMAND\_SCALE} = 1000
$$

$$
d_i^{\text{int}} = \text{round}(d_i^{\text{float}} \times 1000)
$$

This preserves three decimal places of precision. The same scaling is applied
symmetrically to both volume (m³) demands/capacities and weight (kg)
demands/capacities.

The depot node (index 0) is assigned zero demand in both dimensions.

### 1.3 Demand & Capacity Scaling (HGS-CVRP)

HGS-CVRP uses a separate but identically valued scale factor:

$$
\text{HGS\_SCALE} = 1000
$$

Because HGS is a **single-capacity** solver, only one binding dimension is
selected per solve. The binding dimension is chosen dynamically at runtime as the
dimension with the higher fleet load ratio:

$$
\rho_{\text{m³}} = \frac{\sum_i d_i^{\text{m³}}}{\sum_k C_k^{\text{m³}}}, \qquad
\rho_{\text{kg}} = \frac{\sum_i d_i^{\text{kg}}}{\sum_k C_k^{\text{kg}}}
$$

If $\rho_{\text{m³}} \ge \rho_{\text{kg}}$, volume is the binding dimension;
otherwise weight is used. All subsequent HGS demands and capacities reference
only the chosen dimension.

### 1.4 Duration Matrix Pre-Processing

Both solvers convert the raw floating-point OSRM matrix into integer seconds:

$$
d_{ij}^{\text{int}} = \max\!\bigl(0,\; \text{round}(d_{ij}^{\text{raw}})\bigr)
$$

For HGS specifically, values are additionally clamped to a stability ceiling:

$$
d_{ij}^{\text{HGS}} = \min\!\bigl(\text{HGS\_DIST\_CAP},\; d_{ij}^{\text{int}}\bigr), \qquad \text{HGS\_DIST\_CAP} = 90\,000 \text{ s}
$$

---

## 2. Algorithm 1: OR-Tools Implementation (Cost-Driven Global Solver)

### 2.1 Model Structure

A single global `RoutingModel` is created with $N{+}1$ nodes and $K$ vehicles,
all starting and ending at the depot (node 0). The solver evaluates all vehicles
and all outlets simultaneously in one monolithic search.

### 2.2 Quadratic Arc Cost (Spaghetti Prevention)

The arc cost is **not** raw travel time. Instead, a hybrid cost function is applied
to every edge $(i, j)$:

$$
c_{ij} = d_{ij} + \left\lfloor \frac{d_{ij}^2}{\text{QUAD\_DIVISOR}} \right\rfloor, \qquad \text{QUAD\_DIVISOR} = 100
$$

where $d_{ij}$ is the integer driving time in seconds. The effect is a
**super-linear penalty** on long arcs:

| $d_{ij}$ (s) | Linear term | Quadratic term | Hybrid cost $c_{ij}$ |
|---:|---:|---:|---:|
| 60 | 60 | 36 | 96 |
| 300 | 300 | 900 | 1 200 |
| 900 | 900 | 8 100 | 9 000 |
| 1 800 | 1 800 | 32 400 | 34 200 |
| 3 600 | 3 600 | 129 600 | 133 200 |

The linear floor ensures that zero-distance self-arcs remain at cost 0, while the
quadratic term explosively penalises cross-city jumps, strongly encouraging
geographically compact, petal-shaped routes.

This hybrid cost is registered via `SetArcCostEvaluatorOfAllVehicles` — the same
callback is used for every vehicle.

### 2.3 Dynamic Fixed Cost per Vehicle (Capacity-Proportional)

Rather than a uniform fixed cost, vehicles are assigned tiered activation costs
based on their volume capacity ($C_k^{\text{m³}}$):

| Tier | Condition | Fixed Cost |
|---|---|---:|
| Small | $C_k^{\text{m³}} \le 1.0$ | 500 |
| Medium | $1.0 < C_k^{\text{m³}} \le 5.0$ | 3 000 |
| Large | $C_k^{\text{m³}} > 5.0$ | 10 000 |

Applied per vehicle via `routing.SetFixedCostOfVehicle(cost, v_idx)`.

The 20× cost differential between Small and Large vehicles incentivises the solver
to prefer motorcycles / small vehicles for low-demand clusters, escalating to
larger trucks only when the cumulative route demand justifies the activation cost.

### 2.4 Dimensions (Hard Constraints)

Four dimensions are registered on the routing model:

| Dimension | Type | Slack | Bound | Per-Vehicle |
|---|---|---:|---|---|
| **Time** | Transit (pairwise) | 0 | $\le 28\,800$ s (8 h) | Uniform |
| **Volume** | Unary (node demand) | 0 | $\le C_k^{\text{m³}} \times 1000$ | Heterogeneous |
| **Weight** | Unary (node demand) | 0 | $\le C_k^{\text{kg}} \times 1000$ | Heterogeneous |
| **Stops** | Unary (0 for depot, 1 per outlet) | 0 | $\le \text{max\_stops}$ (default 40) | Uniform |

The **Time** dimension uses the raw integer duration matrix (not the hybrid cost)
as its transit callback. It serves exclusively as a hard per-vehicle cap
($\text{MAX\_VEHICLE\_TIME} = 8 \times 3600 = 28\,800$ s). No
`GlobalSpanCostCoefficient` is applied — route duration balancing is deliberately
not enforced, relying instead on the quadratic arc cost to produce compact clusters.

The **Volume** and **Weight** dimensions use `AddDimensionWithVehicleCapacity`,
enabling heterogeneous per-vehicle capacity bounds.

The **Stops** dimension caps the number of outlet nodes per vehicle at
`max_stops` (configurable, default 40, range 1–500).

### 2.5 Disjunctions (Node Dropping)

Every outlet node $i \in \{1, \dots, N\}$ is wrapped in a single-node disjunction
with penalty:

$$
P_{\text{drop}} = 100\,000\,000
$$

This allows the solver to leave outlets unassigned if no feasible insertion exists,
while making it vastly more expensive than any realistic route cost.

### 2.6 First Solution Strategy

```
PARALLEL_CHEAPEST_INSERTION
```

Constructs an initial feasible solution by simultaneously inserting the cheapest
unrouted node into the cheapest position across all vehicles.

### 2.7 Metaheuristic & Local Search Operators

**Metaheuristic:** Guided Local Search (GLS).

GLS augments the objective with penalties on frequently used arc features to escape
local optima.

**Explicitly enabled neighbourhood operators** (set via protobuf `BOOL_TRUE`):

| Operator | OR-Tools Field |
|---|---|
| Relocate | `use_relocate` |
| Relocate Neighbours | `use_relocate_neighbors` |
| Exchange | `use_exchange` |
| Cross-Exchange | `use_cross` |
| Or-Opt | `use_or_opt` |
| TSP-Opt | `use_tsp_opt` |

These operators perform both intra-route and inter-route moves:

- **Relocate / Relocate Neighbours:** Move a single node (or chain) from one
  route to another.
- **Exchange:** Swap segments between two routes.
- **Cross-Exchange:** Reconnect tails of two routes (2-opt* style inter-route).
- **Or-Opt:** Move subsequences of 1–3 consecutive nodes within or between routes.
- **TSP-Opt:** Intra-route optimisation (e.g., 2-opt, 3-opt on a single tour).

### 2.8 Termination Criterion — Calibrated Solution Limit

A wall-clock `time_limit` was deliberately **not used** as the OR-Tools termination
criterion. Wall-clock limits introduce non-determinism: the number of search
iterations completed within a fixed wall-clock budget varies with CPU load, process
scheduling, and hardware generation, making results non-reproducible across
execution environments — a critical requirement for academic benchmarking.

Instead, the solver terminates after a fixed number of **improving solutions**:

```python
# params.time_limit.seconds = SOLVER_TIME_LIMIT  # disabled — calibrated iteration limit used instead
params.solution_limit = 1200  # calibrated: ~500 solutions ≈ 21 s → 1200 ≈ 50 s on reference hardware
```

This calibration was empirically derived on the reference hardware: 500 improving
solutions completed in approximately 21 seconds, yielding a linear projection of
$1200 \approx 50$ seconds — chosen to balance determinism against wall-clock
runtime parity with the HGS sequential loop (§3.3).

The `random_seed` field is **intentionally omitted**. The `RoutingSearchParameters`
protobuf in the deployed OR-Tools build does not expose this attribute; attempting
to set it raises `AttributeError` at runtime. The `solution_limit` criterion alone
provides sufficient reproducibility: given identical inputs, the GLS trajectory
is fully determined by the search graph structure up to the fixed iteration count.

### 2.9 Solution Extraction

Routes are extracted by traversing each vehicle's chain from `routing.Start(v_idx)`
to `routing.IsEnd(idx)`, collecting non-depot nodes. Empty routes (vehicles with
no assigned stops) are omitted. Any outlet node not present in any route is
reported as unassigned.

---

## 3. Algorithm 2: HGS-CVRP Implementation (Sequential Routing)

### 3.1 Motivation

HGS-CVRP (Hybrid Genetic Search) is a state-of-the-art metaheuristic for the
classical CVRP, but it natively supports only a **homogeneous fleet** — a single
vehicle capacity value. The operational fleet is **heterogeneous** (motorcycles,
vans, trucks with different m³/kg limits).

Passing a heterogeneous fleet directly to HGS would require setting the capacity
to the smallest vehicle, causing nodes with demands exceeding that capacity to
trigger infeasibility.

### 3.2 Sequential Routing Strategy

The implementation decomposes the heterogeneous problem into a sequence of
homogeneous HGS sub-problems:

**Step 1 — Determine binding dimension** (§1.3): Choose m³ or kg based on fleet
load ratio.

**Step 2 — Hard-filter impossible outlets:** Any outlet whose scaled demand
exceeds the capacity of the **largest** vehicle in the fleet is immediately moved
to the unassigned list:

$$
\text{If } d_i^{\text{scaled}} > \max_k C_k^{\text{scaled}}, \quad \text{then } i \to \text{unassigned}
$$

**Step 3 — Group vehicles by capacity (descending):** Physical vehicles are
bucketed by their scaled binding-dimension capacity using integer rounding:

$$
\text{key}_k = \text{round}(\text{cap}_k \times \text{HGS\_SCALE})
$$

Groups are sorted in **descending** order of capacity.

**Step 4 — Iterative solve (largest capacity first):** For each capacity group
$g$ with scaled capacity $C_g$ and $K_g$ physical vehicles:

1. **Feasibility filter:** Remove any remaining outlet with
   $d_i^{\text{scaled}} > C_g$ from the candidate pool (these outlets are moved
   to unassigned since they also cannot fit in any subsequent smaller group).

2. **Build sub-problem:** Construct a sub-distance-matrix by selecting only
   rows/columns corresponding to the depot plus remaining outlets from the full
   duration matrix.

3. **Virtual fleet sizing:** Compute the number of virtual vehicles as:

$$
n_{\min} = \left\lceil \frac{\sum_i d_i^{\text{remaining}}}{C_g} \right\rceil
$$

$$
n_{\text{virtual}} = \min\!\Bigl(\text{HGS\_MAX\_FLEET},\;
  \max(K_g,\; n_{\min}) + \max\!\bigl(2,\; \lceil 0.10 \cdot n_{\min} \rceil\bigr)\Bigr)
$$

where $\text{HGS\_MAX\_FLEET} = 200$. The 10% buffer (minimum 2) provides HGS
with slack to discover better partitions than the theoretical minimum.

4. **Solve:** Invoke `hgs.Solver.solve_cvrp(data)` with `nbIter` genetic
   search iterations (§3.3). Service times are set to zero for all nodes.

5. **Route selection:** Non-empty routes are sorted by total demand (descending).
   The top $K_g$ routes (by utilisation) are assigned to the $K_g$ physical
   vehicles in the group.

6. **Pool update:** All outlets serviced by the assigned routes are removed from
   the remaining pool.

**Step 5 — Post-processing:** After all groups have been processed, any outlets
still in the remaining pool are appended to the unassigned list.

### 3.3 Termination Criterion — Calibrated Iteration Limit

Analogous to the OR-Tools `solution_limit` decision (§2.8), HGS does not use a
wall-clock time limit. Instead, a fixed iteration count is used per capacity group:

```python
HGS_NB_ITER = 150    # calibrated: 2500 iter/group took >400 s; 150 ≈ 60 s across typical group counts
HGS_SEED    = 42     # fixed seed — reproducible across runs
```

The calibration was derived empirically: at 2500 iterations per group, the total
wall-clock runtime exceeded 400 seconds for a typical multi-group fleet (e.g.,
3–4 capacity tiers), far exceeding the OR-Tools budget. Reducing to 150
iterations per group yields a total runtime of approximately 60 seconds across
typical group counts, achieving rough parity with the OR-Tools solver budget.

The fixed `seed=42` is passed directly to `hgs.AlgorithmParameters`, ensuring
that the HGS genetic population initialisation and crossover operators are
fully reproducible across runs.

### 3.4 The "Leftbehind Giant" Anomaly

The sequential routing strategy introduces a structural limitation that can cause
high-demand outlets to be silently dropped, referred to here as the
**"Leftbehind Giant" anomaly**.

The mechanism is as follows:

1. During the first iteration (largest capacity group), HGS optimises routes
   for the available large vehicles. Its objective is to **minimise total
   distance** — not to maximise coverage. Consequently, if a high-demand outlet
   is geographically isolated or would incur a disproportionately long arc
   relative to the overall route cost, HGS may elect to exclude it from the
   solution in favour of a lower-cost cluster.

2. This outlet remains in the `remaining` pool after the first iteration. It is
   then re-evaluated against the next capacity group (smaller vehicles).

3. If the outlet's scaled demand $d_i^{\text{scaled}}$ exceeds the capacity of
   this smaller group ($d_i^{\text{scaled}} > C_g$), the feasibility filter at
   Step 4.1 immediately moves it to `impossible_ids` and marks it as unassigned:

   ```python
   overflow = [i for i in remaining if outlet_scaled_demands[i] > group_cap]
   for i in overflow:
       impossible_ids.append(outlets[i].id)
   ```

The outlet is thus permanently dropped — not because it exceeded the absolute
maximum fleet capacity (which it does not; it was feasible for the first group),
but because the distance-minimising objective of HGS deprioritised it during
the only iteration in which a sufficiently large vehicle was available.

This anomaly is an inherent consequence of the greedy sequential decomposition
and the single-objective (distance) nature of HGS. It does not occur in OR-Tools,
which evaluates all nodes globally within a single model with explicit disjunction
penalties that strongly discourage dropping any node.

### 3.5 Limitations

- **Max-stops constraint is not enforced.** HGS-CVRP does not natively support a
  per-vehicle node-count limit. The `max_stops` parameter is accepted for API
  compatibility but has no effect on HGS routes.
- **Single binding dimension.** Only one of m³ or kg is used as the HGS capacity
  constraint. The non-binding dimension is not checked, which may produce routes
  that are feasible in the binding dimension but violate the other.
- **No quadratic arc cost.** HGS uses the raw (clamped) integer duration matrix
  directly. The petal-shaping effect present in OR-Tools is not replicated.
- **Leftbehind Giant anomaly** (§3.4): High-demand outliers may be dropped by
  early iterations, preventing their assignment by subsequent smaller-vehicle
  groups.

---

## 4. Objective Functions & Constraints Summary

### 4.1 OR-Tools Objective

The OR-Tools solver minimises the **total hybrid arc cost plus total fixed vehicle
activation cost**:

$$
\min \sum_{k=1}^{K} \left[ F_k \cdot \mathbb{1}[\text{route}_k \ne \emptyset]
+ \sum_{(i,j) \in \text{route}_k} \left( d_{ij} + \left\lfloor \frac{d_{ij}^2}{100} \right\rfloor \right) \right]
+ P_{\text{drop}} \cdot |\text{unassigned}|
$$

where $F_k \in \{500, 3000, 10000\}$ depending on $C_k^{\text{m³}}$ and
$P_{\text{drop}} = 10^8$.

### 4.2 HGS-CVRP Objective

Each HGS sub-problem minimises total route distance (duration in seconds, clamped
at 90 000 s) subject to a homogeneous capacity constraint:

$$
\min \sum_{k=1}^{n_{\text{virtual}}} \sum_{(i,j) \in \text{route}_k} d_{ij}^{\text{HGS}}
$$

The sequential decomposition imposes an implicit priority: larger-capacity groups
are solved first and claim the routes with highest utilisation.

### 4.3 Active Constraints

| Constraint | OR-Tools | HGS-CVRP |
|---|:---:|:---:|
| Volume capacity (m³), per-vehicle, heterogeneous | ✅ | ⚠️ Only if binding |
| Weight capacity (kg), per-vehicle, heterogeneous | ✅ | ⚠️ Only if binding |
| Max driving time per vehicle (28 800 s) | ✅ | ❌ |
| Max stops per vehicle (default 40) | ✅ | ❌ |
| Node dropping (disjunction, penalty $10^8$) | ✅ | ✅ (hard-filter + leftover) |
| Depot start/end for all vehicles | ✅ | ✅ |
| Fleet heterogeneity (different capacities) | ✅ Native | ✅ Via sequential decomposition |
| Quadratic arc cost penalty | ✅ | ❌ |
| Proportional vehicle fixed cost | ✅ | ❌ |

### 4.4 Shared Infrastructure

Both algorithms share:

- The same OSRM duration matrix (fetched once per request).
- The same API contract (`OptimizeRequest` / `OptimizeResponse`).
- Execution on a thread pool (`asyncio.run_in_executor`) to avoid blocking the
  FastAPI event loop during CPU-bound solving.
- The same depot location (node 0) with all vehicles starting and returning there.

---

## 5. Data Extraction & Heuristic Logging

### 5.1 Overview

Upon completion of every successful `/optimize` request, the service
automatically generates a structured Excel workbook (`.xlsx`) to disk using the
`pandas` DataFrame API and the `openpyxl` write engine. The file is written to
the `./logs/` directory with a timestamped filename:

```
logs/RoutingResult_{algorithm_name}_{YYYYMMDD_HHMMSS}.xlsx
```

The workbook contains three distinct sheets, each capturing a different
granularity of the routing result. The export is wrapped in a broad
`try/except` block so that a logging failure never propagates to the API
response — the HTTP result is returned regardless.

### 5.2 Sheet 1 — Fleet Summary

**Purpose:** Aggregated per-vehicle metrics for the entire assigned fleet.

One row is emitted per vehicle that was assigned at least one outlet. For each
assigned vehicle, the following fields are computed and recorded:

| Column | Description |
|---|---|
| `NOKEND` | Vehicle identifier (`vehicle_id`) |
| `JENIS` | Vehicle type label (`jns_kend`) |
| `OUTLET` | Number of outlet stops on the route |
| `KUBIKASI` | Total volume delivered (m³, 4 d.p.) |
| `STD KUBIK` | Vehicle volume capacity (m³) |
| `% KUBIK` | Volume utilisation: $\frac{\text{KUBIKASI}}{\text{STD KUBIK}} \times 100$ |
| `TONASE` | Total weight delivered (kg, 4 d.p.) |
| `STD TONASE` | Vehicle weight capacity (kg) |
| `% TONASE` | Weight utilisation: $\frac{\text{TONASE}}{\text{STD TONASE}} \times 100$ |
| `% MAX EPE` | $\max(\%\,\text{KUBIK},\; \%\,\text{TONASE})$ — the binding utilisation |

The **% MAX EPE** (Equivalent Payload Efficiency) column represents the
highest-pressure dimension for each vehicle, providing a single-figure
efficiency metric regardless of which capacity constraint is binding.

Below the tabular data, a run metadata block is appended directly to the
`Fleet Summary` worksheet cells (not as a separate row in the DataFrame)
to avoid disrupting the columnar structure:

| Field | Value |
|---|---|
| Algorithm | Algorithm name string |
| Execution Time (sec) | Wall-clock solve time (3 d.p.) |
| Timestamp | `YYYYMMDD_HHMMSS` |
| Total Vehicles Used | Count of rows in Fleet Summary |
| Total Outlets | Count of outlets in the request payload |
| Unassigned Outlets | Count of unassigned outlet IDs |

### 5.3 Sheet 2 — Invoice Detail

**Purpose:** Flattened, invoice-level detail for all **assigned** nodes only.

This sheet contains exclusively outlets that appear in `assigned_routes`. It
expands the invoices carried by each outlet, yielding one row per invoice
(not per outlet). If an outlet carries multiple invoices, each invoice
becomes a separate row with its own volume and weight figures. If an outlet
carries no invoices (i.e., `outlet.invoices` is empty), a single fallback
row is emitted using the outlet-level aggregates.

| Column | Description |
|---|---|
| `NOKEND` | Vehicle identifier |
| `JNSKEND` | Vehicle type label |
| `RITASE` | Trip count (always 1 per invoice row) |
| `CUSTNO` | Outlet identifier |
| `CUSTNAME` | Outlet customer name |
| `INVNO` | Invoice number (or outlet ID if no invoices) |
| `KUBIKASI` | Invoice-level volume (m³, 4 d.p.) |
| `TONASE` | Invoice-level weight (kg, 4 d.p.) |

This sheet does **not** contain any rows for unassigned outlets — all unassigned
nodes are captured exclusively in Sheet 3.

### 5.4 Sheet 3 — Unassigned Detail

**Purpose:** Enumeration of all outlets that the solver failed to assign,
with a heuristic classification of the reason for exclusion.

One row is emitted per outlet ID present in `response.unassigned_outlets`.
The outlet's demand figures are retrieved from the original request payload
via `outlet_map` for cross-referencing.

| Column | Description |
|---|---|
| `CUSTNO` | Outlet identifier |
| `CUSTNAME` | Outlet customer name |
| `INVNO` | Outlet identifier (used as proxy invoice reference) |
| `KUBIKASI` | Outlet volume demand (m³, 4 d.p.) |
| `TONASE` | Outlet weight demand (kg, 4 d.p.) |
| `ALASAN` | Heuristic classification of the drop reason |

### 5.5 Unassigned Node Reasoning Heuristic

The `ALASAN` (reason) column is populated by a post-hoc heuristic that
classifies each dropped node into one of two mutually exclusive categories
based on a comparison against the absolute maximum single-vehicle capacity
across the entire fleet:

```python
max_fleet_m3 = max((v.max_m3 for v in request_payload.vehicles), default=0.0)
max_fleet_kg = max((v.max_kg for v in request_payload.vehicles), default=0.0)

if outlet.m3 > max_fleet_m3 or outlet.kg > max_fleet_kg:
    reason = "Exceeds Maximum Fleet Capacity"
else:
    reason = "No feasible insertion found (Solver limitation)"
```

| `ALASAN` Value | Condition | Interpretation |
|---|---|---|
| `Exceeds Maximum Fleet Capacity` | `outlet.m3 > max_fleet_m3` **or** `outlet.kg > max_fleet_kg` | The outlet's demand in at least one dimension exceeds the capacity of the largest available vehicle. No vehicle in the fleet can physically carry this node — exclusion is a hard infeasibility, not a solver limitation. |
| `No feasible insertion found (Solver limitation)` | All other cases | The outlet's demand is within fleet capacity bounds, but the solver elected not to assign it. For OR-Tools, this typically indicates that inserting the node would violate the time cap, stop limit, or incur a higher cost than the disjunction penalty under the calibrated iteration budget. For HGS, this may additionally reflect the Leftbehind Giant anomaly (§3.4), where a feasible large node was bypassed during the only eligible capacity-group iteration. |

This heuristic provides operational analysts with an immediate, actionable
diagnosis: outlets classified as "Exceeds Maximum Fleet Capacity" require a
fleet upgrade or demand splitting, while those classified as "No feasible
insertion found" may be recoverable by manual insertion, a longer solver
budget, or route re-planning.


### 1.2 Demand & Capacity Scaling (OR-Tools)

OR-Tools requires integer coefficients for all dimensions. Floating-point demands
(m³, kg) and vehicle capacities are converted to integers via a global scale factor:

$$
\text{DEMAND\_SCALE} = 1000
$$

$$
d_i^{\text{int}} = \text{round}(d_i^{\text{float}} \times 1000)
$$

This preserves three decimal places of precision. The same scaling is applied
symmetrically to both volume (m³) demands/capacities and weight (kg)
demands/capacities.

The depot node (index 0) is assigned zero demand in both dimensions.

### 1.3 Demand & Capacity Scaling (HGS-CVRP)

HGS-CVRP uses a separate but identically valued scale factor:

$$
\text{HGS\_SCALE} = 1000
$$

Because HGS is a **single-capacity** solver, only one binding dimension is
selected per solve. The binding dimension is chosen dynamically at runtime as the
dimension with the higher fleet load ratio:

$$
\rho_{\text{m³}} = \frac{\sum_i d_i^{\text{m³}}}{\sum_k C_k^{\text{m³}}}, \qquad
\rho_{\text{kg}} = \frac{\sum_i d_i^{\text{kg}}}{\sum_k C_k^{\text{kg}}}
$$

If $\rho_{\text{m³}} \ge \rho_{\text{kg}}$, volume is the binding dimension;
otherwise weight is used. All subsequent HGS demands and capacities reference
only the chosen dimension.

### 1.4 Duration Matrix Pre-Processing

Both solvers convert the raw floating-point OSRM matrix into integer seconds:

$$
d_{ij}^{\text{int}} = \max\!\bigl(0,\; \text{round}(d_{ij}^{\text{raw}})\bigr)
$$

For HGS specifically, values are additionally clamped to a stability ceiling:

$$
d_{ij}^{\text{HGS}} = \min\!\bigl(\text{HGS\_DIST\_CAP},\; d_{ij}^{\text{int}}\bigr), \qquad \text{HGS\_DIST\_CAP} = 90\,000 \text{ s}
$$

---

## 2. Algorithm 1: OR-Tools Implementation (Cost-Driven Global Solver)

### 2.1 Model Structure

A single global `RoutingModel` is created with $N{+}1$ nodes and $K$ vehicles,
all starting and ending at the depot (node 0). The solver evaluates all vehicles
and all outlets simultaneously in one monolithic search.

### 2.2 Quadratic Arc Cost (Spaghetti Prevention)

The arc cost is **not** raw travel time. Instead, a hybrid cost function is applied
to every edge $(i, j)$:

$$
c_{ij} = d_{ij} + \left\lfloor \frac{d_{ij}^2}{\text{QUAD\_DIVISOR}} \right\rfloor, \qquad \text{QUAD\_DIVISOR} = 100
$$

where $d_{ij}$ is the integer driving time in seconds. The effect is a
**super-linear penalty** on long arcs:

| $d_{ij}$ (s) | Linear term | Quadratic term | Hybrid cost $c_{ij}$ |
|---:|---:|---:|---:|
| 60 | 60 | 36 | 96 |
| 300 | 300 | 900 | 1 200 |
| 900 | 900 | 8 100 | 9 000 |
| 1 800 | 1 800 | 32 400 | 34 200 |
| 3 600 | 3 600 | 129 600 | 133 200 |

The linear floor ensures that zero-distance self-arcs remain at cost 0, while the
quadratic term explosively penalises cross-city jumps, strongly encouraging
geographically compact, petal-shaped routes.

This hybrid cost is registered via `SetArcCostEvaluatorOfAllVehicles` — the same
callback is used for every vehicle.

### 2.3 Dynamic Fixed Cost per Vehicle (Capacity-Proportional)

Rather than a uniform fixed cost, vehicles are assigned tiered activation costs
based on their volume capacity ($C_k^{\text{m³}}$):

| Tier | Condition | Fixed Cost |
|---|---|---:|
| Small | $C_k^{\text{m³}} \le 1.0$ | 500 |
| Medium | $1.0 < C_k^{\text{m³}} \le 5.0$ | 3 000 |
| Large | $C_k^{\text{m³}} > 5.0$ | 10 000 |

Applied per vehicle via `routing.SetFixedCostOfVehicle(cost, v_idx)`.

The 20× cost differential between Small and Large vehicles incentivises the solver
to prefer motorcycles / small vehicles for low-demand clusters, escalating to
larger trucks only when the cumulative route demand justifies the activation cost.

### 2.4 Dimensions (Hard Constraints)

Four dimensions are registered on the routing model:

| Dimension | Type | Slack | Bound | Per-Vehicle |
|---|---|---:|---|---|
| **Time** | Transit (pairwise) | 0 | $\le 28\,800$ s (8 h) | Uniform |
| **Volume** | Unary (node demand) | 0 | $\le C_k^{\text{m³}} \times 1000$ | Heterogeneous |
| **Weight** | Unary (node demand) | 0 | $\le C_k^{\text{kg}} \times 1000$ | Heterogeneous |
| **Stops** | Unary (0 for depot, 1 per outlet) | 0 | $\le \text{max\_stops}$ (default 40) | Uniform |

The **Time** dimension uses the raw integer duration matrix (not the hybrid cost)
as its transit callback. It serves exclusively as a hard per-vehicle cap
($\text{MAX\_VEHICLE\_TIME} = 8 \times 3600 = 28\,800$ s). No
`GlobalSpanCostCoefficient` is applied — route duration balancing is deliberately
not enforced, relying instead on the quadratic arc cost to produce compact clusters.

The **Volume** and **Weight** dimensions use `AddDimensionWithVehicleCapacity`,
enabling heterogeneous per-vehicle capacity bounds.

The **Stops** dimension caps the number of outlet nodes per vehicle at
`max_stops` (configurable, default 40, range 1–500).

### 2.5 Disjunctions (Node Dropping)

Every outlet node $i \in \{1, \dots, N\}$ is wrapped in a single-node disjunction
with penalty:

$$
P_{\text{drop}} = 100\,000\,000
$$

This allows the solver to leave outlets unassigned if no feasible insertion exists,
while making it vastly more expensive than any realistic route cost.

### 2.6 First Solution Strategy

```
PARALLEL_CHEAPEST_INSERTION
```

Constructs an initial feasible solution by simultaneously inserting the cheapest
unrouted node into the cheapest position across all vehicles.

### 2.7 Metaheuristic & Local Search Operators

**Metaheuristic:** Guided Local Search (GLS) with a time budget of
$\text{SOLVER\_TIME\_LIMIT} = 60$ s.

GLS augments the objective with penalties on frequently used arc features to escape
local optima.

**Explicitly enabled neighbourhood operators** (set via protobuf `BOOL_TRUE`):

| Operator | OR-Tools Field |
|---|---|
| Relocate | `use_relocate` |
| Relocate Neighbours | `use_relocate_neighbors` |
| Exchange | `use_exchange` |
| Cross-Exchange | `use_cross` |
| Or-Opt | `use_or_opt` |
| TSP-Opt | `use_tsp_opt` |

These operators perform both intra-route and inter-route moves:

- **Relocate / Relocate Neighbours:** Move a single node (or chain) from one
  route to another.
- **Exchange:** Swap segments between two routes.
- **Cross-Exchange:** Reconnect tails of two routes (2-opt* style inter-route).
- **Or-Opt:** Move subsequences of 1–3 consecutive nodes within or between routes.
- **TSP-Opt:** Intra-route optimisation (e.g., 2-opt, 3-opt on a single tour).

### 2.8 Solution Extraction

Routes are extracted by traversing each vehicle's chain from `routing.Start(v_idx)`
to `routing.IsEnd(idx)`, collecting non-depot nodes. Empty routes (vehicles with
no assigned stops) are omitted. Any outlet node not present in any route is
reported as unassigned.

---

## 3. Algorithm 2: HGS-CVRP Implementation (Sequential Routing)

### 3.1 Motivation

HGS-CVRP (Hybrid Genetic Search) is a state-of-the-art metaheuristic for the
classical CVRP, but it natively supports only a **homogeneous fleet** — a single
vehicle capacity value. The operational fleet is **heterogeneous** (motorcycles,
vans, trucks with different m³/kg limits).

Passing a heterogeneous fleet directly to HGS would require setting the capacity
to the smallest vehicle, causing nodes with demands exceeding that capacity to
trigger infeasibility.

### 3.2 Sequential Routing Strategy

The implementation decomposes the heterogeneous problem into a sequence of
homogeneous HGS sub-problems:

**Step 1 — Determine binding dimension** (§1.3): Choose m³ or kg based on fleet
load ratio.

**Step 2 — Hard-filter impossible outlets:** Any outlet whose scaled demand
exceeds the capacity of the **largest** vehicle in the fleet is immediately moved
to the unassigned list:

$$
\text{If } d_i^{\text{scaled}} > \max_k C_k^{\text{scaled}}, \quad \text{then } i \to \text{unassigned}
$$

**Step 3 — Group vehicles by capacity (descending):** Physical vehicles are
bucketed by their scaled binding-dimension capacity using integer rounding:

$$
\text{key}_k = \text{round}(\text{cap}_k \times \text{HGS\_SCALE})
$$

Groups are sorted in **descending** order of capacity. The solver time budget is
divided equally across groups:

$$
t_{\text{iter}} = \max\!\left(5,\; \frac{\text{SOLVER\_TIME\_LIMIT}}{|\text{groups}|}\right) \text{ seconds}
$$

**Step 4 — Iterative solve (largest capacity first):** For each capacity group
$g$ with scaled capacity $C_g$ and $K_g$ physical vehicles:

1. **Feasibility filter:** Remove any remaining outlet with
   $d_i^{\text{scaled}} > C_g$ from the candidate pool (these outlets are moved
   to unassigned since they also cannot fit in any subsequent smaller group).

2. **Build sub-problem:** Construct a sub-distance-matrix by selecting only
   rows/columns corresponding to the depot plus remaining outlets from the full
   duration matrix.

3. **Virtual fleet sizing:** Compute the number of virtual vehicles as:

$$
n_{\min} = \left\lceil \frac{\sum_i d_i^{\text{remaining}}}{C_g} \right\rceil
$$

$$
n_{\text{virtual}} = \min\!\Bigl(\text{HGS\_MAX\_FLEET},\;
  \max(K_g,\; n_{\min}) + \max\!\bigl(2,\; \lceil 0.10 \cdot n_{\min} \rceil\bigr)\Bigr)
$$

where $\text{HGS\_MAX\_FLEET} = 200$. The 10% buffer (minimum 2) provides HGS
with slack to discover better partitions than the theoretical minimum.

4. **Solve:** Invoke `hgs.Solver.solve_cvrp(data)` with a time limit of
   $t_{\text{iter}}$ seconds. Service times are set to zero for all nodes.

5. **Route selection:** Non-empty routes are sorted by total demand (descending).
   The top $K_g$ routes (by utilisation) are assigned to the $K_g$ physical
   vehicles in the group.

6. **Pool update:** All outlets serviced by the assigned routes are removed from
   the remaining pool.

**Step 5 — Post-processing:** After all groups have been processed, any outlets
still in the remaining pool are appended to the unassigned list.

### 3.3 Limitations

- **Max-stops constraint is not enforced.** HGS-CVRP does not natively support a
  per-vehicle node-count limit. The `max_stops` parameter is accepted for API
  compatibility but has no effect on HGS routes.
- **Single binding dimension.** Only one of m³ or kg is used as the HGS capacity
  constraint. The non-binding dimension is not checked, which may produce routes
  that are feasible in the binding dimension but violate the other.
- **No quadratic arc cost.** HGS uses the raw (clamped) integer duration matrix
  directly. The petal-shaping effect present in OR-Tools is not replicated.

---

## 4. Objective Functions & Constraints Summary

### 4.1 OR-Tools Objective

The OR-Tools solver minimises the **total hybrid arc cost plus total fixed vehicle
activation cost**:

$$
\min \sum_{k=1}^{K} \left[ F_k \cdot \mathbb{1}[\text{route}_k \ne \emptyset]
+ \sum_{(i,j) \in \text{route}_k} \left( d_{ij} + \left\lfloor \frac{d_{ij}^2}{100} \right\rfloor \right) \right]
+ P_{\text{drop}} \cdot |\text{unassigned}|
$$

where $F_k \in \{500, 3000, 10000\}$ depending on $C_k^{\text{m³}}$ and
$P_{\text{drop}} = 10^8$.

### 4.2 HGS-CVRP Objective

Each HGS sub-problem minimises total route distance (duration in seconds, clamped
at 90 000 s) subject to a homogeneous capacity constraint:

$$
\min \sum_{k=1}^{n_{\text{virtual}}} \sum_{(i,j) \in \text{route}_k} d_{ij}^{\text{HGS}}
$$

The sequential decomposition imposes an implicit priority: larger-capacity groups
are solved first and claim the routes with highest utilisation.

### 4.3 Active Constraints

| Constraint | OR-Tools | HGS-CVRP |
|---|:---:|:---:|
| Volume capacity (m³), per-vehicle, heterogeneous | ✅ | ⚠️ Only if binding |
| Weight capacity (kg), per-vehicle, heterogeneous | ✅ | ⚠️ Only if binding |
| Max driving time per vehicle (28 800 s) | ✅ | ❌ |
| Max stops per vehicle (default 40) | ✅ | ❌ |
| Node dropping (disjunction, penalty $10^8$) | ✅ | ✅ (hard-filter + leftover) |
| Depot start/end for all vehicles | ✅ | ✅ |
| Fleet heterogeneity (different capacities) | ✅ Native | ✅ Via sequential decomposition |
| Quadratic arc cost penalty | ✅ | ❌ |
| Proportional vehicle fixed cost | ✅ | ❌ |

### 4.4 Shared Infrastructure

Both algorithms share:

- The same OSRM duration matrix (fetched once per request).
- The same API contract (`OptimizeRequest` / `OptimizeResponse`).
- Execution on a thread pool (`asyncio.run_in_executor`) to avoid blocking the
  FastAPI event loop during CPU-bound solving.
- The same depot location (node 0) with all vehicles starting and returning there.
