# Logistics Route Management System
## Business Logic & Architectural Documentation

> **Classification:** Internal Technical Reference  
> **Audience:** Operations Management, Warehouse Supervisors, IT Team  
> **System Version:** 1.0.0  
> **Last Updated:** April 2026

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Architecture Overview](#2-system-architecture-overview)
3. [Core Mechanism 1 — Clustering & Assignment (Bin Packing / CVRP)](#3-core-mechanism-1--clustering--assignment)
4. [Core Mechanism 2 — Sequencing (Route Optimization)](#4-core-mechanism-2--sequencing-route-optimization)
5. [Core Mechanism 3 — Routing & Visualization](#5-core-mechanism-3--routing--visualization)
6. [Core Mechanism 4 — Iterative Wave Dispatching (2nd Trip)](#6-core-mechanism-4--iterative-wave-dispatching)
7. [End-to-End Operational Flow](#7-end-to-end-operational-flow)
8. [Data Contract Reference](#8-data-contract-reference)

---

## 1. Executive Summary

The Logistics Route Management System is a full-stack platform designed to eliminate the manual, error-prone process of daily fleet dispatching. Before this system, a dispatcher would spend hours manually assigning delivery outlets to trucks on a whiteboard, often resulting in overloaded vehicles, inefficient driving sequences, and unnecessary fuel costs.

This system replaces that process with a decision engine that solves three hard problems simultaneously in under 20 seconds:

1. **Which truck carries which outlets?** — Ensuring no vehicle ever exceeds its physical volume or weight limit.
2. **In what order should a driver visit those outlets?** — Minimizing total driving time across the entire fleet.
3. **What exact roads should a driver take?** — Generating turn-by-turn road-accurate routes displayed on an interactive map.

When the initial fleet is insufficient to serve all orders in a single trip, the system automatically identifies the fastest-returning vehicles and re-dispatches them for a second wave, clearing the remaining backlog without manual intervention.

**The business result:** Significant reduction in fuel expenditure, equitable workload distribution across the driver pool, elimination of overloading compliance risk, and a projected increase in delivery throughput within the same operational window.

---

## 2. System Architecture Overview

The system is composed of three independent, specialized services that communicate over standard HTTP. Each service is responsible for one domain of the problem and can be scaled or maintained independently.

```
┌─────────────────────────────────────────────────────────────────────┐
│                        DISPATCHER'S BROWSER                         │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │           FRONTEND  (Next.js + React Leaflet)                │  │
│  │                                                              │  │
│  │  • Upload invoice & vehicle Excel files                      │  │
│  │  • Trigger optimization                                       │  │
│  │  • Render interactive map with color-coded routes            │  │
│  │  • Display ETA, distance, load metrics per vehicle           │  │
│  └───────────────┬──────────────────────────┬───────────────────┘  │
└──────────────────┼──────────────────────────┼───────────────────────┘
                   │ POST /optimize            │ GET /route/v1/driving
                   │ (JSON payload)            │ (road geometry)
                   ▼                           ▼
   ┌───────────────────────────┐   ┌───────────────────────────────┐
   │  BACKEND  — "The Brain"   │   │  MAP ENGINE  — Local OSRM     │
   │  Python + FastAPI +       │   │  (Docker Container)           │
   │  Google OR-Tools          │   │                               │
   │                           │   │  • /table/v1/driving          │
   │  • Receives depot,        │◄──│    → NxN travel-time matrix   │
   │    outlets, vehicles      │   │                               │
   │  • Fetches OSRM matrix    │   │  • /route/v1/driving          │
   │  • Solves CVRP            │   │    → GeoJSON road polylines   │
   │  • Returns ordered        │   │    → Duration & distance      │
   │    routes + unassigned    │   └───────────────────────────────┘
   └───────────────────────────┘
```

### Why Three Separate Services?

| Service | Technology | Responsibility | Reason for Separation |
|---|---|---|---|
| **Frontend** | Next.js, React Leaflet, TypeScript | User interface, file parsing, map rendering, 2nd-trip orchestration | Browser-native rendering is fundamentally different from computation |
| **Backend (Brain)** | Python, FastAPI, Google OR-Tools | Mathematical optimization (CVRP solver) | OR-Tools is a Python/C++ library; computationally intensive; benefits from isolated scaling |
| **Map Engine** | OSRM (Docker) | Road-accurate distance/time data and route geometry | OSRM requires a pre-processed map data tile; runs best as a dedicated local service |

A local OSRM instance is used instead of commercial map APIs for two critical reasons: **zero per-request cost** (a commercial API with this request volume would be prohibitively expensive) and **data privacy** (customer delivery coordinates never leave the company network).

---

## 3. Core Mechanism 1 — Clustering & Assignment

### The Problem: Bin Packing at Scale

Every morning, the warehouse receives a list of sales invoices destined for delivery. Multiple invoices may belong to the same customer outlet. The fundamental challenge is: **given a fixed fleet of trucks with known physical capacities, how do we decide which outlets go on which truck — without overloading any vehicle and while keeping total driving time as low as possible?**

This is mathematically known as the **Capacitated Vehicle Routing Problem (CVRP)** — one of the most studied problems in logistics optimization. It is a generalization of the classic "Traveling Salesman Problem," but with additional hard constraints on vehicle capacity.

### Why This Cannot Be Solved by Guessing

A common intuitive approach is to assign outlets to trucks one by one until a truck is full, then move to the next truck. While simple, this **greedy approach** ignores the fact that the order in which outlets are assigned directly affects overall driving efficiency. By packing a truck sub-optimally, you may force a driver to criss-cross the city while another truck runs nearly empty nearby.

Google OR-Tools treats the assignment and sequencing problems **simultaneously** — it cannot improve a route sequence without also reconsidering the assignment, and vice versa.

### The Two Capacity Constraints: Volume (M³) and Weight (Kg)

The system enforces **two independent hard constraints** on every vehicle, sourced directly from the fleet data file:

- **`KUBIKASE` (Maximum Volume in M³):** The physical cubic space inside the truck body. A single heavy item cannot overflow this limit, nor can many small-but-bulky items.
- **`TONASE` (Maximum Weight in Kg):** The legal load-bearing limit of the vehicle's axles. Loading beyond this risks equipment damage, traffic fines, and safety hazards.

An outlet is only assigned to a vehicle if **both** constraints are satisfied simultaneously. A truck that has remaining weight capacity but has run out of volume space is treated as full.

```
Vehicle Assignment Rule:
  (currentLoad_M3 + outlet.total_kubikasi_m3) ≤ vehicle.KUBIKASE
  AND
  (currentLoad_Kg + outlet.total_berat_kg)    ≤ vehicle.TONASE
```

### How the Data Flows Into the Solver

Before the optimizer runs, the frontend consolidates raw invoice data into **outlet-level demand nodes**:

1. The dispatcher uploads an Excel file containing individual invoice rows.
2. All invoices belonging to the same `CUSTNO` (Customer Number) are **aggregated** into a single `PendingOutlet` object.
3. That outlet's total `total_kubikasi_m3` and `total_berat_kg` are the **sum** of all its invoices.
4. This aggregated outlet is the atomic unit that the CVRP solver treats as a single, indivisible stop.

This aggregation is critical: a customer with three invoices is treated as one delivery stop, not three — reflecting real-world operations where a driver delivers everything to one doorstep in a single visit.

### Inside the OR-Tools Solver

The backend (`cvrp_service.py`) receives the request and builds the optimization model as follows:

**Step 1 — Integer Scaling:** OR-Tools works with integers internally for performance. All floating-point volumes (M³) and weights (Kg) are multiplied by a scaling factor of `1000` and rounded. A demand of `0.850 M³` becomes `850` internally. This preserves precision without floating-point errors.

```python
SCALE = 1000
m3_demand = [0] + [int(round(o.m3 * SCALE)) for o in outlets]
kg_demand  = [0] + [int(round(o.kg * SCALE)) for o in outlets]
m3_cap     = [int(round(v.max_m3 * SCALE)) for v in vehicles]
kg_cap     = [int(round(v.max_kg * SCALE)) for v in vehicles]
```

**Step 2 — Routing Model Construction:** The solver builds a graph where Node `0` is the depot (warehouse) and Nodes `1` through `N` are the outlets. Each vehicle must start and end at Node `0`.

**Step 3 — Dual Capacity Dimensions:** Two separate capacity constraints are registered — one for volume and one for weight. OR-Tools tracks the cumulative load along each vehicle's path and guarantees it never exceeds the vehicle's respective limit.

**Step 4 — Disjunctions (The "Unassigned" Mechanism):** Every outlet node is wrapped in a **disjunction** with a very high penalty (`10,000,000 × SCALE`). This tells the solver: "You *may* skip delivering to this outlet, but it will cost you an enormous penalty." In practice, the solver only skips an outlet when there is genuinely no vehicle with remaining capacity to serve it. These skipped nodes are returned to the frontend as `unassigned_outlets` — the backlog for Trip 2.

### Business Value

- **Compliance:** The system mathematically guarantees that no dispatched vehicle is overloaded, eliminating the risk of traffic violations and equipment damage.
- **Fairness:** The optimizer distributes the workload across the fleet more equitably than manual assignment, preventing situations where one driver is overwhelmed while another runs a light load.
- **Speed:** A human dispatcher solving this for 100+ outlets across 10+ vehicles may take 1-2 hours. The solver completes it in under 20 seconds.

---

## 4. Core Mechanism 2 — Sequencing (Route Optimization)

### The Problem: Ordering the Stops

Once the solver has decided which outlets go on which truck, a second but equally important question arises: **In what order should the driver visit those outlets?** For a truck assigned 15 stops, there are over 1.3 trillion possible orderings. Visiting them in the wrong sequence could add hours of unnecessary driving.

This is the classic **Traveling Salesman Problem (TSP)**, embedded within each vehicle's assigned cluster.

### The Travel Time Matrix: OSRM as the Ground Truth

A naive approach would measure distance "as the crow flies" — straight-line Euclidean distance between GPS coordinates. This is dangerously inaccurate: two points 3 km apart on a map may be 12 km apart by road due to rivers, one-way streets, or highway ramps.

Instead, the backend first queries the **OSRM Table API** to fetch a real-world travel time matrix:

1. All coordinates (the depot + every outlet) are sent to OSRM in a single request.
2. OSRM returns an **N × N matrix** where `matrix[i][j]` is the estimated driving duration in seconds to travel from point `i` to point `j` via actual road networks.
3. This matrix becomes the "cost" that OR-Tools minimizes. The optimizer is instructed to **minimize total driving time**, not straight-line distance.

```
OSRM Table Request:
  GET /table/v1/driving/{lng0,lat0};{lng1,lat1};...;{lngN,latN}
       ?annotations=duration

Response:
  durations[i][j] = driving time in seconds from node i to node j
```

**Index 0 in the matrix always represents the depot.** Outlets occupy indices 1 through N in the same order they were sent in the request. This index alignment is critical: the solver uses the same indices to build its routing model.

### The Search Algorithm: Guided Local Search (GLS)

Finding the absolute optimal solution to a TSP with 100+ nodes is computationally infeasible in real-time (it is an NP-hard problem). OR-Tools instead uses a two-phase approach:

**Phase 1 — Construction (`PATH_CHEAPEST_ARC`):**  
The solver builds an initial feasible solution quickly by always connecting the cheapest (shortest-time) available arc from the current node. This generates a "good enough" starting point in milliseconds.

**Phase 2 — Improvement (`GUIDED_LOCAL_SEARCH`):**  
Starting from the initial solution, OR-Tools applies a meta-heuristic called **Guided Local Search (GLS)** for up to 20 seconds. GLS works by:

1. Identifying "expensive" arcs — road segments that contribute disproportionately to the total travel time.
2. Penalizing those arcs to discourage their use in future iterations.
3. Exploring neighboring solutions (e.g., "what if we swap Stop 3 and Stop 7?") and accepting improvements.
4. Repeating this cycle, progressively refining the solution until the time budget expires.

```python
params.first_solution_strategy = FirstSolutionStrategy.PATH_CHEAPEST_ARC
params.local_search_metaheuristic = LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
params.time_limit.seconds = 20
```

The 20-second time limit is a deliberate business trade-off: it gives the solver enough time to find a near-optimal solution while keeping the dispatcher's waiting time acceptable. In practice, GLS typically finds solutions within 5-10% of the mathematical optimum for fleets of 5-20 vehicles serving 50-200 outlets.

### What the Solver Returns

After solving, the backend returns for each vehicle an **ordered list of outlet IDs** (`route: ["CUST042", "CUST017", "CUST089", ...]`). This sequence represents Stop 1, Stop 2, Stop 3, and so on — the mathematically optimal visiting order to minimize total driving time across the entire fleet simultaneously.

Crucially, the optimizer makes assignments and sequences **jointly**. Swapping an outlet from one vehicle to another might worsen that vehicle's individual time, but if it unlocks a major improvement for another vehicle, OR-Tools will make that trade.

### Business Value

- **Fuel Savings:** An optimized route sequence directly reduces kilometers driven and therefore fuel consumed. Even a 10-15% reduction in total fleet kilometers translates to tangible monthly savings.
- **Earlier Completions:** Faster routes mean drivers return to the depot earlier, enabling more flexible scheduling and reducing overtime costs.
- **Real-World Accuracy:** By using road network travel times (not straight-line distances), the system produces route plans that align with what drivers actually experience on the road.

---

## 5. Core Mechanism 3 — Routing & Visualization

### The Problem: From Sequence to Map

At this point, the backend has returned an ordered list of outlet IDs for each vehicle. The frontend knows "Vehicle A should visit Outlet 1, then Outlet 3, then Outlet 7." But a GPS coordinate sequence alone cannot be displayed as a map route — it needs actual road geometries.

Drawing straight lines between GPS points on a map is misleading and unprofessional: it suggests driving through buildings, along rivers, or on non-existent roads. The visualization layer must reflect the **real roads a driver will take**.

### Phase A: Requesting Road Geometry from OSRM

After receiving the optimized sequence from the Python backend, the frontend makes a second, separate call to the OSRM `/route/v1/driving` endpoint for each vehicle:

```
Request:
  GET /route/v1/driving/{depot};{stop1};{stop2};...;{stopN}
       ?overview=full&geometries=geojson&continue_straight=true

Response:
  routes[0].geometry  → GeoJSON LineString (detailed road polyline)
  routes[0].duration  → Total estimated driving time in seconds
  routes[0].distance  → Total road distance in meters
```

The `overview=full` parameter instructs OSRM to return a **full-resolution road polyline** — not a simplified approximation. The `geometries=geojson` parameter returns it in the standard GeoJSON format, directly consumable by React Leaflet.

The OSRM `/route` endpoint (as opposed to `/table`) performs full turn-by-turn routing. It follows the actual road topology of the local map data — respecting one-way streets, turn restrictions, highway on-ramps, and speed limits — and returns the precise sequence of road coordinates that trace the actual driving path.

### Phase B: Rendering with React Leaflet

The frontend's `MapRoute.tsx` component consumes the GeoJSON geometry and renders it using React Leaflet's `<Polyline>` component:

- **Road-accurate polylines:** Each vehicle's route is drawn as a colored line that follows actual road geometry, not straight lines.
- **Color-coded by vehicle:** Each truck is assigned a distinct color (blue, red, green, purple, orange, etc.) so a dispatcher can instantly differentiate routes on the map.
- **Numbered stop markers:** Each outlet stop is rendered as a numbered circle (1, 2, 3…) in the vehicle's color, giving drivers and dispatchers a clear visual of the stop sequence.
- **Interactive popups:** Clicking any stop marker opens a popup displaying the customer name, customer number, invoice count, volume (M³), and weight (Kg) for that stop.
- **Depot marker:** The warehouse/depot is rendered as a blue "D" marker at the center of all routes.
- **Auto-fit bounds:** The map automatically adjusts its zoom and pan to fit all assigned routes comfortably in the viewport.

### Phase C: Operational Metrics (ETA & Distance)

The OSRM `/route` response also provides the two most operationally important metrics:

| Metric | Source | Usage |
|---|---|---|
| **Duration (seconds)** | `routes[0].duration` | Displayed as ETA (e.g., "2h 35m") in the vehicle panel; used by the 2nd-trip algorithm to rank vehicles |
| **Distance (meters)** | `routes[0].distance` | Displayed as total route distance (e.g., "47.3 km") for cost estimation and driver briefing |

These metrics are calculated by OSRM using the actual road network graph and historical speed data embedded in the map tiles — they are not approximations.

### Coordinate System Note

A critical technical detail: OSRM uses **longitude-first** coordinate ordering (`[lng, lat]`), conforming to the GeoJSON standard. React Leaflet, however, expects **latitude-first** (`[lat, lng]`), following geographic convention.

The `MapRoute.tsx` component handles this conversion explicitly:

```typescript
// GeoJSON [lng, lat] → Leaflet [lat, lng]
const polylinePoints = route.routeGeometry.coordinates.map(
  (c) => [c[1], c[0]] as [number, number]
);
```

Failing to swap these coordinates would place every route in a mirror-image location on the wrong side of the globe — a common and silent failure mode that the system handles correctly.

### Large Routes: Chunked Parallel Requests

For vehicles assigned a very large number of stops (50+), the coordinate string in the URL could exceed browser and server URI length limits. The `fetchTripRoute` utility in `cvrp.ts` handles this automatically by:

1. Splitting the ordered waypoint list into overlapping chunks of 50 waypoints (with a 1-point overlap at boundaries to ensure continuity).
2. Fetching all chunks in **parallel** (`Promise.all`).
3. Merging the returned polyline coordinates into a single continuous `LineString`, discarding the duplicate boundary point between chunks.

### Business Value

- **Dispatcher Confidence:** A dispatcher can visually verify that a route makes geographic sense before handing it to a driver — catching any outlier assignments (e.g., a customer on the wrong side of the city accidentally included in a cluster).
- **Driver Briefing:** Drivers can see their exact route on a physical or digital map, reducing time spent on phone inquiries about directions.
- **Real ETAs for Customer Communication:** The duration data enables customer service teams to proactively communicate realistic delivery windows, improving customer satisfaction.

---

## 6. Core Mechanism 4 — Iterative Wave Dispatching

### The Problem: What Happens When There Are Not Enough Trucks?

In real operations, the daily invoice volume is not constant. On peak days (month-end, promotional campaigns, holidays), total order volume may exceed what the current fleet can carry in a single trip. When this happens, the CVRP optimizer has no choice but to **drop** certain outlets from the first trip — these appear in the system as `unassigned_outlets`.

A manual dispatcher would then spend additional time figuring out which trucks will finish earliest, call drivers back to the depot, reload, and send them out again. This second decision is itself a non-trivial planning problem.

### The 2nd Trip Logic: ETA-Ranked Vehicle Selection

The system automates the second-trip dispatching decision using the following algorithm, implemented in the `assignSecondTrip` function:

**Step 1 — Assess the Remaining Backlog:**  
The system calculates the total volume (`requiredM3`) and weight (`requiredKg`) of all unassigned outlets combined. This establishes how much capacity is needed for the second wave.

```typescript
const requiredM3 = unassignedOutlets.reduce((sum, o) => sum + o.total_kubikasi_m3, 0);
const requiredKg = unassignedOutlets.reduce((sum, o) => sum + o.total_berat_kg, 0);
```

**Step 2 — Rank First-Trip Vehicles by ETA (Shortest First):**  
All vehicles that completed the first trip are sorted in ascending order of their `durationSeconds` — the total driving time of their first-trip route as calculated by OSRM. The vehicle with the shortest first-trip duration is expected to return to the depot earliest.

```typescript
const sortedRoutes = [...assignedRoutes].sort(
  (a, b) => (a.durationSeconds || 0) - (b.durationSeconds || 0)
);
```

This is the key business insight: **the fastest truck on the first trip becomes the fastest truck available for the second trip.** By dispatching it before slower trucks return, the system minimizes the total time for the entire backlog to be delivered.

**Step 3 — Select the Minimum Set of Vehicles:**  
Starting from the fastest vehicle, the system adds trucks to the second-wave roster until the accumulated capacity of selected vehicles meets or exceeds the required backlog volume and weight. This prevents over-dispatching (sending 5 trucks when 2 would suffice).

```typescript
for (const routeGroup of sortedRoutes) {
  if (accumulatedM3 >= requiredM3 && accumulatedKg >= requiredKg) break;
  selectedVehicles.push({ ...routeGroup.vehicle, NO_KEND: `${NO_KEND} (Trip 2)` });
  accumulatedM3 += vehicle.KUBIKASE;
  accumulatedKg += vehicle.TONASE;
}
```

Each Trip 2 vehicle is labeled with a `(Trip 2)` suffix in the system, making it immediately distinguishable from first-trip assignments in the dispatcher's panel and on the map.

**Step 4 — Re-Optimize with the Full Backend Pipeline:**  
The selected second-trip vehicles and the backlog of unassigned outlets are sent to the **same Python CVRP backend** used for the first trip. The backend runs the full OR-Tools optimization again — fetching a fresh OSRM travel time matrix for the backlog outlets and solving the CVRP from scratch with the selected vehicles.

This means Trip 2 routes are just as mathematically optimized as Trip 1 routes. The system does not "guess" or use shortcuts for the second wave.

**Step 5 — Append and Update State:**  
The Trip 2 routes are appended to the existing route list on the map, rendered in new colors to visually distinguish them from first-trip routes. The `unassignedOutlets` state is updated to reflect any outlets that could not be served even by Trip 2 (e.g., if the backlog is extremely large), which would surface a signal for further manual intervention.

### Example Scenario

| Vehicle | Trip 1 Duration | Trip 1 Load | Status |
|---|---|---|---|
| Truck A | 1h 45m | 95% capacity | ✅ Selected for Trip 2 (fastest) |
| Truck B | 2h 10m | 88% capacity | ✅ Selected for Trip 2 (2nd fastest, needed for remaining capacity) |
| Truck C | 3h 20m | 100% capacity | ⏳ Not selected (still on road) |
| Truck D | 3h 55m | 90% capacity | ⏳ Not selected (still on road) |

In this scenario, Truck A and Truck B are identified as the earliest returnees with sufficient combined capacity to cover the backlog. The system dispatches them for Trip 2 without waiting for Trucks C and D to return — maximizing throughput within the operational day.

### Business Value

- **Throughput Maximization:** By identifying the fastest-returning vehicles automatically, the system minimizes idle time between trips and maximizes the number of deliveries completed within the working day.
- **Reduced Dispatcher Cognitive Load:** The dispatcher does not need to manually track which driver is expected back earliest. The system makes this decision based on hard data (OSRM-calculated ETAs) rather than intuition.
- **Scalable to Multiple Waves:** The logic is iterative — if Trip 2 still leaves outlets unassigned, the dispatcher can trigger the same process again for a potential Trip 3, using the same algorithm.

---

## 7. End-to-End Operational Flow

The following sequence describes the complete lifecycle of a dispatch operation from data upload to trucks on the road.

```
DISPATCHER                     FRONTEND (Browser)              BACKEND (Python)          MAP ENGINE (OSRM)
     │                               │                               │                         │
     │  1. Upload invoice Excel       │                               │                         │
     ├──────────────────────────────►│                               │                         │
     │                               │  Parse & aggregate rows       │                         │
     │                               │  by CUSTNO → PendingOutlet[]  │                         │
     │                               │                               │                         │
     │  2. Upload vehicle Excel       │                               │                         │
     ├──────────────────────────────►│                               │                         │
     │                               │  Parse rows → Vehicle[]       │                         │
     │                               │                               │                         │
     │  3. Click "Load Data"          │                               │                         │
     ├──────────────────────────────►│                               │                         │
     │                               │  Preview: show gray outlet    │                         │
     │                               │  markers on map               │                         │
     │                               │                               │                         │
     │  4. Click "Auto-Assign"        │                               │                         │
     ├──────────────────────────────►│                               │                         │
     │                               │  POST /optimize               │                         │
     │                               │  { depot, outlets, vehicles } │                         │
     │                               ├──────────────────────────────►│                         │
     │                               │                               │  GET /table/v1/driving  │
     │                               │                               ├────────────────────────►│
     │                               │                               │  ◄ NxN duration matrix  │
     │                               │                               │                         │
     │                               │                               │  Solve CVRP:            │
     │                               │                               │  PATH_CHEAPEST_ARC      │
     │                               │                               │  + GLS (20s)            │
     │                               │                               │                         │
     │                               │  ◄ assigned_routes[]          │                         │
     │                               │    unassigned_outlets[]       │                         │
     │                               │                               │                         │
     │                               │  For each vehicle:            │                         │
     │                               │  GET /route/v1/driving/...    │                         │
     │                               ├────────────────────────────────────────────────────────►│
     │                               │  ◄ GeoJSON geometry           │                         │
     │                               │    duration, distance         │                         │
     │                               │                               │                         │
     │                               │  Render polylines, markers,   │                         │
     │                               │  metrics on map               │                         │
     │◄──────────────────────────────┤                               │                         │
     │  5. Review map & results       │                               │                         │
     │                               │                               │                         │
     │  [If unassigned outlets exist] │                               │                         │
     │  6. Click "Assign Trip 2"      │                               │                         │
     ├──────────────────────────────►│                               │                         │
     │                               │  Rank vehicles by ETA         │                         │
     │                               │  Select minimum vehicle set   │                         │
     │                               │                               │                         │
     │                               │  POST /optimize               │                         │
     │                               │  { unassigned, selected_veh } │                         │
     │                               ├──────────────────────────────►│                         │
     │                               │  [Repeat optimization cycle]  │                         │
     │                               │                               │                         │
     │                               │  Append Trip 2 routes to map  │                         │
     │◄──────────────────────────────┤                               │                         │
     │  7. Full dispatch plan ready   │                               │                         │
```

---

## 8. Data Contract Reference

### Input: Invoice File (Excel/CSV)

Each row in the invoice file represents a single delivery invoice. Multiple rows with the same `CUSTNO` are aggregated into one outlet stop.

| Column | Type | Description |
|---|---|---|
| `CUSTNO` | String | Unique customer number — the aggregation key |
| `CUSTNAME` | String | Customer/outlet display name |
| `INVNO` | String | Invoice number — must be unique per row |
| `LATITUDE` | Float | GPS latitude of the delivery address |
| `LONGITUDE` | Float | GPS longitude of the delivery address |
| `TOTAL_NETO` | Float | Net invoice value (informational, not used in optimization) |
| `TOTAL_KUBIKASI_M3` | Float | Volume demand for this invoice, in cubic metres |
| `TOTAL_BERAT_KG` | Float | Weight demand for this invoice, in kilograms |
| `TOTAL_KARTON` | Integer | Number of cartons (informational) |
| `JNS_KEND` | String *(optional)* | Maximum permitted vehicle type for this customer |

### Input: Vehicle File (Excel/CSV)

Each row represents a single vehicle in the available fleet.

| Column | Type | Description |
|---|---|---|
| `JNS_KEND` | String | Vehicle type/category (e.g., "ENGKEL", "TRONTON") |
| `NO_KEND` | String | Vehicle registration plate — the unique vehicle identifier |
| `KUBIKASE` | Float | Maximum cargo volume, in cubic metres (M³) |
| `TONASE` | Float | Maximum cargo weight, in kilograms (Kg) |

### Backend API: `POST /optimize`

**Request Body:**
```json
{
  "depot": { "lat": -7.793415, "lng": 110.320430 },
  "outlets": [
    { "id": "CUST001", "lat": -7.801, "lng": 110.335, "m3": 1.25, "kg": 320.5 }
  ],
  "vehicles": [
    { "id": "AB1234CD", "max_m3": 20.0, "max_kg": 8000.0 }
  ]
}
```

**Response Body:**
```json
{
  "assigned_routes": [
    {
      "vehicle_id": "AB1234CD",
      "total_m3": 18.75,
      "total_kg": 7620.0,
      "route": ["CUST042", "CUST017", "CUST001"]
    }
  ],
  "unassigned_outlets": ["CUST099", "CUST103"]
}
```

The `route` array is **ordered** — index 0 is Stop 1, index 1 is Stop 2, and so on. The optimizer has determined this sequence to minimize total driving time.

---

*This document was generated as an internal technical reference for the Logistics Route Management System. For questions about specific implementation details, refer to `cvrp_service.py` (backend solver) and `frontend/app/admin/dashboard/page.tsx` (dispatch orchestration logic).*
