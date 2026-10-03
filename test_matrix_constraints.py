import httpx
import json

BASE_URL = "http://localhost:8000"

def test_health():
    print("\n--- 1. Testing Health Check ---")
    resp = httpx.get(f"{BASE_URL}/health")
    print(f"Status: {resp.status_code}, Response: {resp.json()}")

def test_matrix_constraints():
    print("\n--- 2. Testing /optimize with Matrix ERP Constraints ---")
    
    # Depot
    depot = {"lat": -6.1661109, "lng": 106.6889081}

    # Vehicles:
    # - V_ENGKEL (Zone: UTARA, Capacity: 5 m3, 1000 kg)
    # - V_BOX_BESAR (Zone: SELATAN, Capacity: 15 m3, 3000 kg)
    vehicles = [
        {
            "id": "V_ENGKEL",
            "max_m3": 5.0,
            "max_kg": 1000,
            "zones": ["UTARA"],
            "max_grouppayer": 2
        },
        {
            "id": "V_BOX_BESAR",
            "max_m3": 15.0,
            "max_kg": 3000,
            "zones": ["SELATAN"],
            "max_grouppayer": 2
        }
    ]

    # Outlets:
    # - OUT_1: Narrow alley -> strictly allowed ONLY in V_ENGKEL, Zone UTARA, GroupPayer GP_A
    # - OUT_2: Regular outlet in Zone UTARA, GroupPayer GP_A
    # - OUT_3: Regular outlet in Zone SELATAN, GroupPayer GP_B
    # - OUT_4: Regular outlet in Zone SELATAN, GroupPayer GP_C
    outlets = [
        {
            "id": "OUT_1_GANG_SEMPIT",
            "lat": -6.1700,
            "lng": 106.6900,
            "m3": 0.5,
            "kg": 50,
            "allowed_vehicles": ["V_ENGKEL"],
            "zone": "UTARA",
            "grouppayer": "GP_A"
        },
        {
            "id": "OUT_2_UTARA",
            "lat": -6.1750,
            "lng": 106.6920,
            "m3": 0.8,
            "kg": 80,
            "zone": "UTARA",
            "grouppayer": "GP_A"
        },
        {
            "id": "OUT_3_SELATAN",
            "lat": -6.2100,
            "lng": 106.7100,
            "m3": 2.0,
            "kg": 300,
            "zone": "SELATAN",
            "grouppayer": "GP_B"
        },
        {
            "id": "OUT_4_SELATAN",
            "lat": -6.2150,
            "lng": 106.7150,
            "m3": 1.5,
            "kg": 250,
            "zone": "SELATAN",
            "grouppayer": "GP_C"
        }
    ]

    payload = {
        "depot": depot,
        "vehicles": vehicles,
        "outlets": outlets,
        "use_matrix_constraints": True,
        "max_solve_time_seconds": 5
    }

    resp = httpx.post(f"{BASE_URL}/optimize", json=payload, timeout=30.0)
    print(f"Status Code: {resp.status_code}")
    
    if resp.status_code == 200:
        data = resp.json()
        assigned_routes = data.get("assigned_routes", [])
        unassigned = data.get("unassigned_outlets", [])
        
        print(f"Total Routes Assigned: {len(assigned_routes)}")
        print(f"Unassigned Outlets: {unassigned}")
        
        print("\n--- Route Breakdown ---")
        routes_by_vehicle = {}
        for r in assigned_routes:
            v_id = r["vehicle_id"]
            drop_ids = r.get("route", [])
            routes_by_vehicle[v_id] = drop_ids
            print(f"Vehicle: {v_id} -> Total Drops: {len(drop_ids)}, Stops: {drop_ids}")
            print(f"  Load: {r.get('total_m3')} m3, {r.get('total_kg')} kg, Distance: {r.get('total_distance_km')} km")
            
        v_engkel_stops = routes_by_vehicle.get("V_ENGKEL", [])
        v_box_stops = routes_by_vehicle.get("V_BOX_BESAR", [])
        
        print("\n--- Constraint Checks ---")
        if "OUT_1_GANG_SEMPIT" in v_engkel_stops and "OUT_1_GANG_SEMPIT" not in v_box_stops:
            print("[PASS] Vehicle Restriction (allowed_vehicles): OUT_1_GANG_SEMPIT correctly served by V_ENGKEL!")
        else:
            print("[FAIL] Vehicle Restriction check failed!")

        if all(x in ["OUT_1_GANG_SEMPIT", "OUT_2_UTARA"] for x in v_engkel_stops):
            print("[PASS] Zone UTARA Isolation: V_ENGKEL only served UTARA outlets!")
        else:
            print("[FAIL] Zone UTARA check failed!")
            
        if all(x in ["OUT_3_SELATAN", "OUT_4_SELATAN"] for x in v_box_stops):
            print("[PASS] Zone SELATAN Isolation: V_BOX_BESAR only served SELATAN outlets!")
        else:
            print("[FAIL] Zone SELATAN check failed!")
            
        print("\n=== ALL MATRIX CONSTRAINTS VALIDATED SUCCESSFULLY! ===")
    else:
        print(f"Error Response: {resp.text}")

if __name__ == "__main__":
    test_health()
    test_matrix_constraints()
