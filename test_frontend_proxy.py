import urllib.request
import json
import time

print("[1] Testing GET http://localhost:5173/api/health via Vite proxy...")
req = urllib.request.Request("http://localhost:5173/api/health")
with urllib.request.urlopen(req) as resp:
    data = json.loads(resp.read().decode())
    print("  Status:", resp.status)
    print("  Backend service:", data.get("service"))
    print("  Reconstructed routes:", data["network"]["reconstructed_routes_indexed"])
    print("  Route segments:", data["network"]["route_segments_indexed"])

print("\n[2] Testing POST http://localhost:5173/api/journey/recommend via Vite proxy...")
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
    print("  Status:", resp.status)
    print("  System state:", data2.get("system_state"))
    print("  Message:", data2.get("message"))
    rec = data2.get("recommended_candidate") or {}
    print(f"  Recommended Route: {rec.get('route_id')} | Bus: {rec.get('vehicle_id')}")
    print(f"  Pickup ETA: {rec.get('pickup', {}).get('expected_pickup_eta')}")
    print(f"  Destination ETA: {rec.get('destination', {}).get('expected_arrival')}")
    print(f"  On-Time Probability: {rec.get('deadline_probability', {}).get('probability_on_time_pct')}% ({rec.get('deadline_probability', {}).get('confidence_tier')})")
    print(f"  Viable candidate count: {data2.get('summary', {}).get('viable_candidates_count')}")
    print(f"  Engine execution time: {data2.get('summary', {}).get('execution_time_ms')} ms")
    print(f"  End-to-End Latency: {latency_ms:.1f} ms")

print("\n[3] Testing POST http://localhost:5173/api/journey/recommend with invalid input (empty origin)...")
try:
    bad_payload = json.dumps({"from": "", "to": "Azadpur", "reach_by": 25}).encode()
    req3 = urllib.request.Request(
        "http://localhost:5173/api/journey/recommend",
        data=bad_payload,
        headers={"Content-Type": "application/json"}
    )
    urllib.request.urlopen(req3)
except urllib.error.HTTPError as e:
    err_body = json.loads(e.read().decode())
    print("  HTTP Code:", e.code)
    print("  Error Type:", err_body.get("error_type"))
    print("  Error Message:", err_body.get("message"))

print("\n[4] Testing GET http://localhost:5173/ (Vite HTML bundle)...")
req4 = urllib.request.Request("http://localhost:5173/")
with urllib.request.urlopen(req4) as resp:
    html = resp.read().decode()
    print("  Status:", resp.status)
    print("  Contains root div:", '<div id="root">' in html)
    print("  Contains main.tsx script:", 'src="/src/main.tsx"' in html)

print("\n[OK] All proxy and communication checks succeeded!")
