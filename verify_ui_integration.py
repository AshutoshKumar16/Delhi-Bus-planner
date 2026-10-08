import urllib.request
import json
import time

print("=" * 75)
print("DELHI BUS PROJECT: UI/UX BACKEND INTEGRATION VERIFICATION")
print("=" * 75)

# 1. Health check via Vite dev server proxy
print("\n[1] Health Check via Frontend Proxy (http://localhost:5173/api/health)...")
req = urllib.request.Request("http://localhost:5173/api/health")
with urllib.request.urlopen(req) as resp:
    data = json.loads(resp.read().decode())
    print("  HTTP Status:", resp.status)
    print("  Service:", data.get("service"))
    print("  Reconstructed Routes:", data["network"]["reconstructed_routes_indexed"])
    print("  Segments Indexed:", data["network"]["route_segments_indexed"])
    assert resp.status == 200
    assert data["network"]["reconstructed_routes_indexed"] > 1000

# 2. Real query: Mahindra Park -> Azadpur (25 min budget)
print("\n[2] Real Commuter Query: Mahindra Park -> Azadpur (25 min deadline)...")
payload = json.dumps({"from": "Mahindra Park", "to": "Azadpur", "reach_by": 25}).encode()
req2 = urllib.request.Request(
    "http://localhost:5173/api/journey/recommend",
    data=payload,
    headers={"Content-Type": "application/json"}
)
t0 = time.time()
with urllib.request.urlopen(req2) as resp:
    data2 = json.loads(resp.read().decode())
    latency_ms = (time.time() - t0) * 1000.0
    print("  HTTP Status:", resp.status)
    print("  System State:", data2.get("system_state"))
    print("  Message:", data2.get("message"))
    
    rec = data2.get("recommended_candidate")
    assert rec is not None, "recommended_candidate should not be None"
    
    print("\n  [VERIFIED BACKEND VALUES FOR PRIMARY RECOMMENDATION]")
    print(f"    - Route ID:                {rec['route_id']}")
    print(f"    - Vehicle ID:              {rec['vehicle_id']}")
    print(f"    - Telemetry Freshness:     {rec['data_freshness']['telemetry_age_seconds']}s ago ({rec['data_freshness']['status']})")
    print(f"    - Pickup Wait ETA:         {rec['pickup']['expected_pickup_eta']} (~{rec['pickup']['expected_wait_minutes']} min)")
    print(f"    - In-Vehicle Transit:      ~{rec['in_vehicle']['expected_travel_time_minutes']} min ({rec['in_vehicle']['stops_count']} stops, {rec['in_vehicle']['distance_meters']}m)")
    print(f"    - Destination Arrival:     {rec['destination']['expected_arrival']} (~{rec['destination']['expected_travel_time_minutes']} min total)")
    print(f"    - 80% Confidence Interval: {rec['destination']['uncertainty_interval_80pct_minutes']} min")
    print(f"    - On-Time Probability:     {rec['deadline_probability']['probability_on_time_pct']}% ({rec['deadline_probability']['confidence_tier']})")
    print(f"    - Safety Buffer:           +{rec['deadline_probability']['slack_minutes']} min")
    print(f"    - Verified Route Quality:  {rec['route_reconstruction_confidence'] * 100}% confidence")
    print(f"    - Empirical Evidence:      {rec['evidence_samples']} historical traversals")

    alts = data2.get("alternative_candidates", [])
    print(f"\n  [VERIFIED OTHER AVAILABLE BUSES]: {len(alts)} candidates")
    for alt in alts[:3]:
        print(f"    - Route {alt['route_id']} (Bus {alt['vehicle_id']}): Wait ~{alt['pickup']['expected_wait_minutes']}m | Arrival {alt['destination']['expected_arrival']} | P(on-time) {alt['deadline_probability']['probability_on_time_pct']}%")

    print(f"\n  Roundtrip Latency: {latency_ms:.1f}ms (Engine execution: {data2['summary']['execution_time_ms']}ms)")

# 3. Boundary State: NO_DIRECT_ROUTE
print("\n[3] Boundary State: Dwarka Sector 22 -> Narela Terminal (No Direct Route)...")
payload_nd = json.dumps({"from": "Dwarka Sector 22", "to": "Narela Terminal", "reach_by": 60}).encode()
req_nd = urllib.request.Request(
    "http://localhost:5173/api/journey/recommend",
    data=payload_nd,
    headers={"Content-Type": "application/json"}
)
with urllib.request.urlopen(req_nd) as resp:
    data_nd = json.loads(resp.read().decode())
    print("  System State:", data_nd.get("system_state"))
    print("  Message:", data_nd.get("message"))
    assert data_nd.get("system_state") == "NO_DIRECT_ROUTE"
    assert data_nd.get("recommended_candidate") is None

# 4. Boundary State: NO_RELIABLE_JOURNEY
print("\n[4] Boundary State: Mahindra Park -> Azadpur (2 min deadline - Infeasible)...")
payload_nr = json.dumps({"from": "Mahindra Park", "to": "Azadpur", "reach_by": 2}).encode()
req_nr = urllib.request.Request(
    "http://localhost:5173/api/journey/recommend",
    data=payload_nr,
    headers={"Content-Type": "application/json"}
)
with urllib.request.urlopen(req_nr) as resp:
    data_nr = json.loads(resp.read().decode())
    print("  System State:", data_nr.get("system_state"))
    print("  Message:", data_nr.get("message"))
    assert data_nr.get("system_state") == "NO_RELIABLE_JOURNEY"
    assert data_nr.get("recommended_candidate") is None
    if data_nr.get("unreliable_candidates"):
        print(f"  Unreliable Candidates Displayed: {len(data_nr['unreliable_candidates'])} buses")

# 5. Frontend HTML bundle delivery
print("\n[5] Verifying Frontend HTML Delivery (http://localhost:5173/)...")
req_html = urllib.request.Request("http://localhost:5173/")
with urllib.request.urlopen(req_html) as resp:
    html = resp.read().decode()
    print("  HTTP Status:", resp.status)
    print("  HTML Length:", len(html))
    assert '<div id="root">' in html

print("\n[OK] All UI/UX backend integration verification tests passed successfully!")
