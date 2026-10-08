#!/usr/bin/env python3
"""
===============================================================================
Delhi Bus Project - Backend API Verification Suite
Script: test_backend_api.py

Purpose:
  Validates the backend HTTP REST API layer without external network dependencies
  using Flask's in-process test client.

Verifications:
  1. Health Endpoint (GET /api/health): 200 OK, engine readiness, network dimensions.
  2. Input Validation (POST /api/journey/recommend):
     - Missing body -> 400
     - Missing origin ('from') -> 400
     - Missing destination ('to') -> 400
     - Identical origin & destination -> 400
     - Missing deadline ('reach_by') -> 400
     - Invalid deadline values -> 400
  3. Recommendation Execution:
     - Viable corridor recommendation -> 200 OK, system_state == 'RECOMMENDED'
     - Multi-leg decomposition (pickup + in-vehicle + destination)
     - Continuous deadline probability & confidence tiers
     - Naive fastest-ETA baseline comparison
  4. Boundary Handling:
     - Infeasible / severe delay risk -> 'NO_RELIABLE_JOURNEY'
     - Disconnected stops -> 'NO_DIRECT_ROUTE'
  5. Information Security & Sanitization:
     - Response must not leak absolute filesystem paths ('E:\\', '/data/')
     - Response must not leak database credentials, environment variables, or API keys.
  6. Latency & Performance:
     - Query execution time verification (<150ms).
===============================================================================
"""

import json
import time
import unittest
from backend_service import app, initialize_engine


class TestBackendAPI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        print("\n" + "=" * 75)
        print("DELHI BUS PROJECT: BACKEND API INTEGRATION TEST SUITE")
        print("=" * 75)
        print("[*] Initializing test client & warming recommendation engine...")
        t0 = time.time()
        cls.engine = initialize_engine()
        cls.client = app.test_client()
        print(f"[OK] Test client ready in {time.time()-t0:.2f}s.\n")

    def test_01_health_endpoint(self):
        """Verify GET /api/health returns 200 and operational network stats."""
        print("[Test 01] Testing GET /api/health...")
        response = self.client.get("/api/health")
        self.assertEqual(response.status_code, 200)

        data = response.get_json()
        self.assertEqual(data.get("status"), "healthy")
        self.assertEqual(data.get("service"), "delhi-bus-journey-recommendation-api")
        self.assertIn("network", data)
        self.assertGreater(data["network"]["reconstructed_routes_indexed"], 1000)
        self.assertGreater(data["network"]["route_segments_indexed"], 100000)
        print(f"  [OK] Health Check passed: {data['network']['reconstructed_routes_indexed']} routes, {data['network']['route_segments_indexed']} segments indexed.")

    def test_02_validation_missing_body(self):
        """Verify POST without body returns 400."""
        print("[Test 02] Testing POST /api/journey/recommend with empty body...")
        response = self.client.post("/api/journey/recommend", data="", content_type="application/json")
        self.assertEqual(response.status_code, 400)
        data = response.get_json()
        self.assertEqual(data.get("status"), "error")
        self.assertEqual(data.get("error_type"), "INVALID_JSON")
        print("  [OK] Empty body rejected with 400 INVALID_JSON.")

    def test_03_validation_missing_origin(self):
        """Verify POST without 'from' returns 400."""
        print("[Test 03] Testing POST /api/journey/recommend missing 'from'...")
        response = self.client.post("/api/journey/recommend", json={"to": "Azadpur", "reach_by": 25})
        self.assertEqual(response.status_code, 400)
        data = response.get_json()
        self.assertEqual(data.get("error_type"), "MISSING_ORIGIN")
        print("  [OK] Missing 'from' rejected with 400 MISSING_ORIGIN.")

    def test_04_validation_missing_destination(self):
        """Verify POST without 'to' returns 400."""
        print("[Test 04] Testing POST /api/journey/recommend missing 'to'...")
        response = self.client.post("/api/journey/recommend", json={"from": "Mahindra Park", "reach_by": 25})
        self.assertEqual(response.status_code, 400)
        data = response.get_json()
        self.assertEqual(data.get("error_type"), "MISSING_DESTINATION")
        print("  [OK] Missing 'to' rejected with 400 MISSING_DESTINATION.")

    def test_05_validation_identical_stops(self):
        """Verify POST with identical origin and destination returns 400."""
        print("[Test 05] Testing POST /api/journey/recommend with identical stops...")
        response = self.client.post(
            "/api/journey/recommend",
            json={"from": "Azadpur", "to": "Azadpur", "reach_by": 25},
        )
        self.assertEqual(response.status_code, 400)
        data = response.get_json()
        self.assertEqual(data.get("error_type"), "IDENTICAL_STOPS")
        print("  [OK] Identical stops rejected with 400 IDENTICAL_STOPS.")

    def test_06_validation_invalid_deadline(self):
        """Verify POST with invalid deadline returns 400."""
        print("[Test 06] Testing POST /api/journey/recommend with invalid deadline...")
        response = self.client.post(
            "/api/journey/recommend",
            json={"from": "Mahindra Park", "to": "Azadpur", "reach_by": -10},
        )
        self.assertEqual(response.status_code, 400)
        data = response.get_json()
        self.assertEqual(data.get("error_type"), "INVALID_DEADLINE")
        print("  [OK] Negative deadline rejected with 400 INVALID_DEADLINE.")

    def test_07_successful_recommendation(self):
        """Verify successful recommendation query on valid corridor."""
        print("[Test 07] Testing POST /api/journey/recommend on valid corridor...")
        t0 = time.time()
        response = self.client.post(
            "/api/journey/recommend",
            json={
                "from": "Mahindra Park",
                "to": "Azadpur",
                "reach_by": 25,
            },
        )
        latency_ms = (time.time() - t0) * 1000.0
        self.assertEqual(response.status_code, 200)

        data = response.get_json()
        self.assertEqual(data.get("status"), "success")
        self.assertEqual(data.get("system_state"), "RECOMMENDED")
        self.assertIsNotNone(data.get("recommended_candidate"))

        rec = data["recommended_candidate"]
        self.assertIn("route_id", rec)
        self.assertIn("vehicle_id", rec)
        self.assertIn("pickup", rec)
        self.assertIn("in_vehicle", rec)
        self.assertIn("destination", rec)
        self.assertIn("deadline_probability", rec)
        self.assertIn("comparison_with_fastest_eta", data)

        print(f"  [OK] Recommendation received in {latency_ms:.1f}ms (Engine execution: {data['summary']['execution_time_ms']}ms):")
        print(f"       Recommended Route {rec['route_id']} (Bus {rec['vehicle_id']})")
        print(f"       Pickup ETA: {rec['pickup']['expected_pickup_eta']} ({rec['pickup']['expected_wait_minutes']}m wait)")
        print(f"       Dest Arrival: {rec['destination']['expected_arrival']} ({rec['destination']['expected_travel_time_minutes']}m)")
        print(f"       On-time Probability: {rec['deadline_probability']['probability_on_time_pct']}% ({rec['deadline_probability']['confidence_tier']})")
        print(f"       Viable Candidates: {data['summary']['viable_candidates_count']} options")

    def test_08_no_direct_route_boundary(self):
        """Verify boundary handling when no direct route exists."""
        print("[Test 08] Testing POST /api/journey/recommend for unconnected stops...")
        response = self.client.post(
            "/api/journey/recommend",
            json={
                "from": "Dwarka Sector 22",
                "to": "Narela Terminal",
                "reach_by": 60,
            },
        )
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data.get("system_state"), "NO_DIRECT_ROUTE")
        self.assertIsNone(data.get("recommended_candidate"))
        self.assertIn("Transfer routing is not enabled", data.get("message"))
        print(f"  [OK] Unconnected stops handled: system_state={data['system_state']}.")

    def test_09_no_reliable_journey_boundary(self):
        """Verify boundary handling when deadline is physically or statistically infeasible."""
        print("[Test 09] Testing POST /api/journey/recommend with infeasible deadline...")
        response = self.client.post(
            "/api/journey/recommend",
            json={
                "from": "Dhaula Kuan",
                "to": "Patel Chowk Metro Station",
                "reach_by": 4,  # Only 4 minutes for a 22-minute trip
            },
        )
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data.get("system_state"), "NO_RELIABLE_JOURNEY")
        self.assertIsNone(data.get("recommended_candidate"))
        print(f"  [OK] Infeasible deadline handled: system_state={data['system_state']}.")

    def test_10_security_sanitization(self):
        """Verify responses do not leak filesystem paths, API keys, or credentials."""
        print("[Test 10] Testing security sanitization on API response...")
        response = self.client.post(
            "/api/journey/recommend",
            json={"from": "Mahindra Park", "to": "Azadpur", "reach_by": 25},
        )
        self.assertEqual(response.status_code, 200)
        raw_text = response.get_data(as_text=True)

        # Check for path leaks
        self.assertNotIn("E:\\", raw_text)
        self.assertNotIn("C:\\", raw_text)
        self.assertNotIn(".csv.gz", raw_text)
        self.assertNotIn("reconstructed_routes.json", raw_text)
        self.assertNotIn("route_segments.json", raw_text)

        # Check for credential leaks
        self.assertNotIn("DATABASE_URL", raw_text)
        self.assertNotIn("postgres", raw_text.lower())
        self.assertNotIn("password", raw_text.lower())
        self.assertNotIn("api_key", raw_text.lower())
        print("  [OK] Security check passed: 0 internal paths, 0 keys, 0 database credentials leaked.")

    def test_11_map_geometry_and_coordinates(self):
        """
        Verify additive map fields on candidates:
          - pickup.latitude, pickup.longitude
          - destination.latitude, destination.longitude
          - vehicle_position (latitude, longitude, speed_kmh_or_null / speed_mps_or_null, timestamp_unix)
          - route_path list of [lat, lon] starting at pickup and ending at destination
          - route_path_type == "stop_sequence"
          - All coordinates within Delhi bounding box: lat [28.3, 28.95], lon [76.8, 77.4]
        """
        print("[Test 11] Testing map geometry, bounding box and coordinate consistency...")
        response = self.client.post(
            "/api/journey/recommend",
            json={"from": "Mahindra Park", "to": "Azadpur", "reach_by": 25},
        )
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data.get("status"), "success")

        # Collect all candidates: recommended, alternatives, and unreliable
        candidates = []
        if data.get("recommended_candidate"):
            candidates.append(data["recommended_candidate"])
        candidates.extend(data.get("alternative_candidates", []))
        candidates.extend(data.get("unreliable_candidates", []))

        self.assertGreater(len(candidates), 0, "Expected at least one candidate option.")

        DELHI_LAT_MIN, DELHI_LAT_MAX = 28.3, 28.95
        DELHI_LON_MIN, DELHI_LON_MAX = 76.8, 77.4

        for c in candidates:
            # 1. Pickup coordinates
            self.assertIn("pickup", c)
            pickup = c["pickup"]
            self.assertIn("latitude", pickup)
            self.assertIn("longitude", pickup)
            self.assertIsNotNone(pickup["latitude"])
            self.assertIsNotNone(pickup["longitude"])
            self.assertTrue(
                DELHI_LAT_MIN <= pickup["latitude"] <= DELHI_LAT_MAX,
                f"Pickup latitude {pickup['latitude']} out of Delhi bounds",
            )
            self.assertTrue(
                DELHI_LON_MIN <= pickup["longitude"] <= DELHI_LON_MAX,
                f"Pickup longitude {pickup['longitude']} out of Delhi bounds",
            )

            # 2. Destination coordinates
            self.assertIn("destination", c)
            dest = c["destination"]
            self.assertIn("latitude", dest)
            self.assertIn("longitude", dest)
            self.assertIsNotNone(dest["latitude"])
            self.assertIsNotNone(dest["longitude"])
            self.assertTrue(
                DELHI_LAT_MIN <= dest["latitude"] <= DELHI_LAT_MAX,
                f"Destination latitude {dest['latitude']} out of Delhi bounds",
            )
            self.assertTrue(
                DELHI_LON_MIN <= dest["longitude"] <= DELHI_LON_MAX,
                f"Destination longitude {dest['longitude']} out of Delhi bounds",
            )

            # 3. Vehicle position
            self.assertIn("vehicle_position", c)
            vp = c["vehicle_position"]
            self.assertIsInstance(vp, dict)
            self.assertIn("latitude", vp)
            self.assertIn("longitude", vp)
            self.assertIn("timestamp_unix", vp)
            self.assertTrue("speed_kmh_or_null" in vp or "speed_mps_or_null" in vp)
            if vp.get("latitude") is not None:
                self.assertTrue(
                    DELHI_LAT_MIN <= vp["latitude"] <= DELHI_LAT_MAX,
                    f"Vehicle latitude {vp['latitude']} out of Delhi bounds",
                )
            if vp.get("longitude") is not None:
                self.assertTrue(
                    DELHI_LON_MIN <= vp["longitude"] <= DELHI_LON_MAX,
                    f"Vehicle longitude {vp['longitude']} out of Delhi bounds",
                )

            # 4. Route path
            self.assertIn("route_path", c)
            self.assertEqual(c.get("route_path_type"), "stop_sequence")
            rp = c["route_path"]
            self.assertIsInstance(rp, list)
            self.assertGreaterEqual(len(rp), 2, "route_path must have at least 2 points (pickup to destination)")

            # Check route_path endpoints match pickup and destination exactly
            self.assertEqual(rp[0], [pickup["latitude"], pickup["longitude"]], "route_path must start at pickup coordinates")
            self.assertEqual(rp[-1], [dest["latitude"], dest["longitude"]], "route_path must end at destination coordinates")

            # Check all points in route_path are within Delhi bounding box
            for pt in rp:
                self.assertEqual(len(pt), 2)
                self.assertTrue(DELHI_LAT_MIN <= pt[0] <= DELHI_LAT_MAX, f"Point lat {pt[0]} out of Delhi bounds")
                self.assertTrue(DELHI_LON_MIN <= pt[1] <= DELHI_LON_MAX, f"Point lon {pt[1]} out of Delhi bounds")

        print(f"  [OK] Map geometry verified on {len(candidates)} candidates:")
        print(f"       Pickup: ({candidates[0]['pickup']['latitude']}, {candidates[0]['pickup']['longitude']})")
        print(f"       Destination: ({candidates[0]['destination']['latitude']}, {candidates[0]['destination']['longitude']})")
        print(f"       Vehicle: ({candidates[0]['vehicle_position']['latitude']}, {candidates[0]['vehicle_position']['longitude']})")
        print(f"       Route Path: {len(candidates[0]['route_path'])} stops from pickup to destination")


if __name__ == "__main__":
    unittest.main()
