
---

## How to Start the Dev Servers

Open **two separate terminals** in VS Code:

**Terminal 1 — Python backend (FastAPI):**
```powershell
cd "C:\System Support\App\RouteManagement"
.venv\Scripts\Activate.ps1
uvicorn cvrp_service:app --host 0.0.0.0 --port 8000 --reload
```

**Terminal 2 — Next.js frontend:**
```powershell
cd "C:\System Support\App\RouteManagement\frontend"
npm run dev
```

Then open http://localhost:3000 in your browser.

> You also need **OSRM running on port 5000** for routing geometry. If it's not running, route lines won't draw but the assignment will still work.

---

## How to Change the Depot (D) Coordinate

The depot is defined in one place — types.ts:

```ts
export const DEPOT_COORDS = { lat: -6.1661109, lng: 106.6889081 }
```

Change those values to your warehouse/depot location. For example: 

Read [](file:///c%3A/System%20Support/App/RouteManagement/frontend/lib/types.ts#54-54), lines 54 to 60

Just edit the `lat` and `lng` values on line 55 of types.ts. That single change will update the depot marker on the map AND the starting point used in all route calculations. You can get coordinates from Google Maps by right-clicking any location.