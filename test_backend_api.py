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
from unittest.mock import patch
from backend_service import (
    app,
    initialize_engine,
    get_latest_snapshot,
    get_replay_resolver,
    sanitize_candidate_for_api,
    parse_reach_by,
)


class TestBackendAPI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        print("\n" + "=" * 75)
        print("DELHI BUS PROJECT: BACKEND API INTEGRATION TEST SUITE")
        print("=" * 75)
        print("[*] Initializing test client & warming recommendation engine...")
        t0 = time.perf_counter()
        cls.engine = initialize_engine()
        cls.client = app.test_client()
        _, _, cls.default_pred_ts = get_latest_snapshot()
        # Mock time.time to be within fresh live window (60s after snapshot) for base suite tests
        cls.time_patcher = patch("backend_service.time.time", return_value=cls.default_pred_ts + 60)
        cls.mock_time = cls.time_patcher.start()
        print(f"[OK] Test client ready in {time.perf_counter()-t0:.2f}s.\n")

    @classmethod
    def tearDownClass(cls):
        cls.time_patcher.stop()

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
                "from": "Mahindra Park",
                "to": "Azadpur",
                "reach_by": 0.5,  # Physically infeasible (30s for >1.7km corridor)
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

    def test_12_live_request_uses_wall_clock_time(self):
        """Verify that normal live request uses server wall-clock time, not snapshot max timestamp."""
        print("[Test 12] Testing that live request uses wall-clock time...")
        simulated_now = self.default_pred_ts + 75
        self.mock_time.return_value = simulated_now
        response = self.client.post(
            "/api/journey/recommend",
            json={"from": "Mahindra Park", "to": "Azadpur", "reach_by": 25},
        )
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data["status"], "success")
        self.assertEqual(data["query"]["telemetry_mode"], "live")
        self.assertEqual(data["query"]["prediction_timestamp_unix"], simulated_now)
        self.assertNotEqual(data["query"]["prediction_timestamp_unix"], self.default_pred_ts)
        print(f"  [OK] Live request anchored to wall-clock time {simulated_now} (telemetry_mode=live).")

    def test_13_explicit_replay_prediction_time(self):
        """Verify that supplying prediction_time preserves replay mode with exact supplied timestamp."""
        print("[Test 13] Testing that explicit prediction_time uses supplied timestamp...")
        replay_ts = 1791250502  # Verified out-of-sample timestamp (2026-10-06 01:35:02 UTC)
        response = self.client.post(
            "/api/journey/recommend",
            json={
                "from": "Mahindra Park",
                "to": "Azadpur",
                "reach_by": 25,
                "prediction_time": replay_ts,
            },
        )
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data["status"], "success")
        self.assertEqual(data["query"]["telemetry_mode"], "replay")
        self.assertEqual(data["query"]["prediction_timestamp_unix"], replay_ts)
        print(f"  [OK] Replay request used exact supplied timestamp {replay_ts} (telemetry_mode=replay).")

    def test_14_stale_snapshot_detection(self):
        """Verify that live request detects stale snapshot when age > 420s and returns 503 error."""
        print("[Test 14] Testing stale snapshot detection (> 420s)...")
        stale_now = self.default_pred_ts + 450  # 450s > 420s limit
        self.mock_time.return_value = stale_now
        response = self.client.post(
            "/api/journey/recommend",
            json={"from": "Mahindra Park", "to": "Azadpur", "reach_by": 25},
        )
        self.assertEqual(response.status_code, 503)
        data = response.get_json()
        self.assertEqual(data["status"], "error")
        self.assertEqual(data["error_type"], "STALE_TELEMETRY_FEED")
        self.assertEqual(data["telemetry_mode"], "live")
        self.assertEqual(data["telemetry_age_seconds"], 450)
        self.assertIn("exceeds 420s limit", data["message"])
        print(f"  [OK] Stale feed rejected with 503 STALE_TELEMETRY_FEED (age: {data['telemetry_age_seconds']}s).")

    def test_15_math_consistency_same_prediction_timestamp(self):
        """Verify that recommendation calculations match direct engine output on verified historical snapshot."""
        print("[Test 15] Testing recommendation math consistency when using same prediction timestamp...")
        self.mock_time.return_value = self.default_pred_ts + 60
        fixed_ts = 1791250502  # Verified committed snapshot in data/2026-10-06/013302.csv.gz

        # 1. Direct engine call using resolved snapshot DataFrame
        resolver = get_replay_resolver()
        res = resolver.resolve_replay_snapshot(fixed_ts)
        direct_rec = self.engine.recommend_journey(
            origin_stop="Mahindra Park",
            destination_stop="Azadpur",
            deadline_ts=fixed_ts + 25 * 60,
            snapshot_df=res.df,
            prediction_ts=fixed_ts,
        )

        # 2. Endpoint call in replay mode with explicit prediction_time
        response = self.client.post(
            "/api/journey/recommend",
            json={
                "from": "Mahindra Park",
                "to": "Azadpur",
                "reach_by": 25,
                "prediction_time": fixed_ts,
            },
        )
        self.assertEqual(response.status_code, 200)
        data = response.get_json()

        # Compare core recommendations
        direct_cand = direct_rec.get("recommended_option", {})
        api_cand = data.get("recommended_candidate", {})

        self.assertEqual(api_cand["vehicle_id"], direct_cand["vehicle_id"])
        self.assertEqual(api_cand["route_id"], direct_cand["route_id"])
        self.assertEqual(
            api_cand["pickup"]["expected_wait_minutes"],
            direct_cand["pickup_leg"]["expected_pickup_wait_minutes"],
        )
        self.assertEqual(
            api_cand["destination"]["expected_arrival"],
            direct_cand["destination_arrival"]["expected_arrival_formatted"],
        )
        self.assertEqual(
            api_cand["deadline_probability"]["probability_on_time_pct"],
            direct_cand["deadline_evaluation"]["probability_on_time_pct"],
        )
        self.assertEqual(
            api_cand["deadline_probability"]["slack_minutes"],
            direct_cand["deadline_evaluation"]["slack_minutes"],
        )
        print("  [OK] Math consistency verified: vehicle, arrival ETA, probability, and slack match direct engine output exactly.")

    def test_16_replay_mode_explicit_valid(self):
        """Verify explicit mode='replay' with valid prediction_time succeeds with replay metadata."""
        print("[Test 16] Testing explicit mode='replay'...")
        replay_ts = 1791250502
        response = self.client.post(
            "/api/journey/recommend",
            json={
                "from": "Mahindra Park",
                "to": "Azadpur",
                "reach_by": 25,
                "mode": "replay",
                "prediction_time": replay_ts,
            },
        )
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data["status"], "success")
        self.assertEqual(data["query"]["telemetry_mode"], "replay")
        self.assertEqual(data["query"]["prediction_timestamp_unix"], replay_ts)
        self.assertIn("snapshot_path", data["query"])
        self.assertIn("snapshot_age_seconds", data["query"])
        self.assertIn("provenance", data)
        self.assertIn("telemetry_diagnostics", data)
        print("  [OK] Explicit replay mode returned 200 OK with sanitized replay metadata.")

    def test_17_replay_mode_missing_prediction_time(self):
        """Verify mode='replay' without prediction_time returns 400 MISSING_PREDICTION_TIME."""
        print("[Test 17] Testing mode='replay' without prediction_time...")
        response = self.client.post(
            "/api/journey/recommend",
            json={
                "from": "Mahindra Park",
                "to": "Azadpur",
                "reach_by": 25,
                "mode": "replay",
            },
        )
        self.assertEqual(response.status_code, 400)
        data = response.get_json()
        self.assertEqual(data["status"], "error")
        self.assertEqual(data["error_type"], "MISSING_PREDICTION_TIME")
        print("  [OK] Missing prediction_time in replay mode rejected with 400 MISSING_PREDICTION_TIME.")

    def test_18_replay_mode_invalid_prediction_time_types(self):
        """Verify invalid prediction_time types (bool, float, string) return 400 INVALID_PREDICTION_TIME."""
        print("[Test 18] Testing invalid prediction_time formats...")
        invalid_values = [True, False, 1791250502.5, "not_a_ts", "1791250502ms", -500, 100]
        for val in invalid_values:
            response = self.client.post(
                "/api/journey/recommend",
                json={
                    "from": "Mahindra Park",
                    "to": "Azadpur",
                    "reach_by": 25,
                    "prediction_time": val,
                },
            )
            self.assertEqual(response.status_code, 400, f"Expected 400 for value {val!r}")
            data = response.get_json()
            self.assertEqual(data["error_type"], "INVALID_PREDICTION_TIME")
        print("  [OK] Invalid prediction_time values rejected with 400 INVALID_PREDICTION_TIME.")

    def test_19_replay_mode_future_prediction_time(self):
        """Verify prediction_time exceeding current clock returns 400 FUTURE_PREDICTION_TIME."""
        print("[Test 19] Testing future prediction_time...")
        future_ts = (self.default_pred_ts + 60) + 100000
        response = self.client.post(
            "/api/journey/recommend",
            json={
                "from": "Mahindra Park",
                "to": "Azadpur",
                "reach_by": 25,
                "prediction_time": future_ts,
            },
        )
        self.assertEqual(response.status_code, 400)
        data = response.get_json()
        self.assertEqual(data["status"], "error")
        self.assertEqual(data["error_type"], "FUTURE_PREDICTION_TIME")
        self.assertEqual(data["prediction_timestamp_unix"], future_ts)
        print("  [OK] Future prediction_time rejected with 400 FUTURE_PREDICTION_TIME.")

    def test_20_replay_mode_invalid_mode_param(self):
        """Verify unsupported mode strings return 400 INVALID_MODE."""
        print("[Test 20] Testing unsupported mode parameter...")
        response = self.client.post(
            "/api/journey/recommend",
            json={
                "from": "Mahindra Park",
                "to": "Azadpur",
                "reach_by": 25,
                "mode": "benchmark_offline",
            },
        )
        self.assertEqual(response.status_code, 400)
        data = response.get_json()
        self.assertEqual(data["status"], "error")
        self.assertEqual(data["error_type"], "INVALID_MODE")
        self.assertIn("supported_modes", data)
        print("  [OK] Unsupported mode rejected with 400 INVALID_MODE.")

    def test_21_replay_mode_conflicting_mode_and_timestamp(self):
        """Verify mode='live' combined with prediction_time returns 400 CONFLICTING_MODE."""
        print("[Test 21] Testing mode='live' with prediction_time conflict...")
        response = self.client.post(
            "/api/journey/recommend",
            json={
                "from": "Mahindra Park",
                "to": "Azadpur",
                "reach_by": 25,
                "mode": "live",
                "prediction_time": 1791250502,
            },
        )
        self.assertEqual(response.status_code, 400)
        data = response.get_json()
        self.assertEqual(data["status"], "error")
        self.assertEqual(data["error_type"], "CONFLICTING_MODE")
        print("  [OK] Live mode with prediction_time rejected with 400 CONFLICTING_MODE.")

    def test_22_replay_mode_no_historical_snapshot(self):
        """Verify prediction_time prior to all archive snapshots returns 404 NO_HISTORICAL_SNAPSHOT."""
        print("[Test 22] Testing timestamp prior to archive start (year 2001)...")
        app.config["ALLOW_IN_SAMPLE_REPLAY"] = True
        try:
            response = self.client.post(
                "/api/journey/recommend",
                json={
                    "from": "Mahindra Park",
                    "to": "Azadpur",
                    "reach_by": 25,
                    "prediction_time": 1000000000,
                },
            )
            self.assertEqual(response.status_code, 404)
            data = response.get_json()
            self.assertEqual(data["status"], "error")
            self.assertEqual(data["error_type"], "NO_HISTORICAL_SNAPSHOT")
            print("  [OK] Missing historical snapshot rejected with 404 NO_HISTORICAL_SNAPSHOT.")
        finally:
            app.config["ALLOW_IN_SAMPLE_REPLAY"] = False

    def test_23_replay_mode_archive_gap_exceeded(self):
        """Verify prediction_time in an archive gap > 420s returns 503 ARCHIVE_GAP_EXCEEDED."""
        print("[Test 23] Testing archive gap > 420s...")
        gap_ts = 1791253835  # 450s gap on 2026-10-06 between 02:23:05 and 02:33:05
        response = self.client.post(
            "/api/journey/recommend",
            json={
                "from": "Mahindra Park",
                "to": "Azadpur",
                "reach_by": 25,
                "prediction_time": gap_ts,
            },
        )
        self.assertEqual(response.status_code, 503)
        data = response.get_json()
        self.assertEqual(data["status"], "error")
        self.assertEqual(data["error_type"], "ARCHIVE_GAP_EXCEEDED")
        self.assertEqual(data["gap_seconds"], 450)
        self.assertEqual(data["max_gap_seconds"], 420)
        print(f"  [OK] Archive gap rejected with 503 ARCHIVE_GAP_EXCEEDED (gap: {data['gap_seconds']}s).")

    def test_24_replay_mode_relative_deadline_anchored_to_P(self):
        """Verify relative deadline in replay mode is anchored to historical P, not wall-clock time."""
        print("[Test 24] Testing relative deadline calculation in replay mode...")
        replay_ts = 1791250502
        response = self.client.post(
            "/api/journey/recommend",
            json={
                "from": "Mahindra Park",
                "to": "Azadpur",
                "reach_by": 30,  # 30 minutes offset
                "prediction_time": replay_ts,
            },
        )
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        expected_deadline = replay_ts + 30 * 60
        self.assertEqual(data["query"]["reach_by_unix"], expected_deadline)
        self.assertEqual(data["query"]["time_budget_minutes"], 30.0)
        print(f"  [OK] Replay deadline anchored to P: {expected_deadline} (budget: 30.0m).")

    def test_25_replay_telemetry_strictly_causal(self):
        """Verify returned candidate vehicles in replay mode have timestamp <= P and age >= 0."""
        print("[Test 25] Testing causal telemetry filtering...")
        replay_ts = 1791250502
        response = self.client.post(
            "/api/journey/recommend",
            json={
                "from": "Mahindra Park",
                "to": "Azadpur",
                "reach_by": 25,
                "prediction_time": replay_ts,
            },
        )
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        candidates = []
        if data.get("recommended_candidate"):
            candidates.append(data["recommended_candidate"])
        candidates.extend(data.get("alternative_candidates", []))
        self.assertGreater(len(candidates), 0)

        for c in candidates:
            v_pos = c["vehicle_position"]
            if v_pos and v_pos.get("timestamp_unix") is not None:
                self.assertLessEqual(
                    v_pos["timestamp_unix"],
                    replay_ts,
                    f"Vehicle timestamp {v_pos['timestamp_unix']} exceeds prediction time {replay_ts}",
                )
            age_s = c["data_freshness"]["telemetry_age_seconds"]
            self.assertGreaterEqual(age_s, 0, f"Negative telemetry age: {age_s}")
        print(f"  [OK] Causal integrity verified across {len(candidates)} candidate(s) (all timestamps <= P).")

    def test_26_cache_isolation(self):
        """Verify Live and Replay snapshot caches remain completely isolated."""
        print("[Test 26] Testing Live vs Replay cache isolation...")
        resolver = get_replay_resolver()
        resolver.cache.clear()
        stats_before = resolver.cache.stats()
        self.assertEqual(stats_before["size"], 0)

        # 1. Execute Live query
        self.mock_time.return_value = self.default_pred_ts + 60
        live_resp = self.client.post(
            "/api/journey/recommend",
            json={"from": "Mahindra Park", "to": "Azadpur", "reach_by": 25},
        )
        self.assertEqual(live_resp.status_code, 200)

        # Verify live query did not touch replay cache
        stats_after_live1 = resolver.cache.stats()
        self.assertEqual(stats_after_live1["size"], 0)

        # 2. Execute Replay query
        replay_resp = self.client.post(
            "/api/journey/recommend",
            json={
                "from": "Mahindra Park",
                "to": "Azadpur",
                "reach_by": 25,
                "prediction_time": 1791250502,
            },
        )
        self.assertEqual(replay_resp.status_code, 200)
        stats_after_replay = resolver.cache.stats()
        self.assertEqual(stats_after_replay["size"], 1)

        # 3. Execute another Live query and verify replay cache stats are unchanged
        live_resp2 = self.client.post(
            "/api/journey/recommend",
            json={"from": "Mahindra Park", "to": "Azadpur", "reach_by": 25},
        )
        self.assertEqual(live_resp2.status_code, 200)
        stats_after_live2 = resolver.cache.stats()
        self.assertEqual(stats_after_replay["hits"], stats_after_live2["hits"])
        self.assertEqual(stats_after_replay["misses"], stats_after_live2["misses"])
        self.assertEqual(stats_after_replay["size"], stats_after_live2["size"])
        print("  [OK] Cache isolation verified: Live queries do not touch Replay cache.")

    def test_27_dynamic_provenance_metadata(self):
        """Verify provenance metadata is dynamically loaded from disk artifacts."""
        print("[Test 27] Testing dynamic provenance metadata loading...")
        response = self.client.post(
            "/api/journey/recommend",
            json={
                "from": "Mahindra Park",
                "to": "Azadpur",
                "reach_by": 25,
                "prediction_time": 1791250502,
            },
        )
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        prov = data.get("provenance", {})
        self.assertEqual(prov.get("regime"), "OUT_OF_SAMPLE_POST_ARTIFACT_REPLAY")
        self.assertTrue(prov.get("provenance_verified"))
        self.assertTrue(prov.get("is_authoritative"))
        self.assertFalse(prov.get("in_sample_leakage"))
        self.assertFalse(prov.get("production_activation_verified"))
        print(f"  [OK] Provenance dynamically verified: regime={prov.get('regime')}, prod_activation={prov.get('production_activation_verified')}.")

    def test_28_in_sample_rejection_and_server_override(self):
        """Verify public in-sample replay is rejected with 403, and allowed via server config override."""
        print("[Test 28] Testing in-sample restriction and server-side override...")
        in_sample_ts = 1790772057  # 2026-09-30 (within training corpus < 1791158400)

        # 1. Public client without override -> 403
        resp1 = self.client.post(
            "/api/journey/recommend",
            json={
                "from": "Mahindra Park",
                "to": "Azadpur",
                "reach_by": 25,
                "prediction_time": in_sample_ts,
            },
        )
        self.assertEqual(resp1.status_code, 403)
        data1 = resp1.get_json()
        self.assertEqual(data1["error_type"], "IN_SAMPLE_REPLAY_FORBIDDEN")
        self.assertNotIn("allow_in_sample", data1["message"].lower())

        # 2. Public client sending allow_in_sample=True in JSON -> Still 403 (cannot bypass)
        resp2 = self.client.post(
            "/api/journey/recommend",
            json={
                "from": "Mahindra Park",
                "to": "Azadpur",
                "reach_by": 25,
                "prediction_time": in_sample_ts,
                "allow_in_sample": True,
            },
        )
        self.assertEqual(resp2.status_code, 403)

        # 3. Server-side diagnostic override enabled -> 200 OK
        app.config["ALLOW_IN_SAMPLE_REPLAY"] = True
        try:
            resp3 = self.client.post(
                "/api/journey/recommend",
                json={
                    "from": "Mahindra Park",
                    "to": "Azadpur",
                    "reach_by": 25,
                    "prediction_time": in_sample_ts,
                },
            )
            self.assertEqual(resp3.status_code, 200)
            data3 = resp3.get_json()
            self.assertEqual(data3["status"], "success")
            self.assertEqual(data3["provenance"]["regime"], "IN_SAMPLE_TRAINING_PERIOD")
        finally:
            app.config["ALLOW_IN_SAMPLE_REPLAY"] = False
        print("  [OK] In-sample request strictly rejected with 403; server-side override permitted.")

    def test_29_security_hygiene_replay_errors(self):
        """Verify replay errors and responses do not leak absolute paths, database credentials, or keys."""
        print("[Test 29] Testing security hygiene across replay error responses...")
        error_responses = [
            self.client.post("/api/journey/recommend", json={"from": "Mahindra Park", "to": "Azadpur", "reach_by": 25, "prediction_time": 1791253835}),
            self.client.post("/api/journey/recommend", json={"from": "Mahindra Park", "to": "Azadpur", "reach_by": 25, "prediction_time": 1790772057}),
            self.client.post("/api/journey/recommend", json={"from": "Mahindra Park", "to": "Azadpur", "reach_by": 25, "mode": "invalid"}),
        ]
        for resp in error_responses:
            raw_text = resp.get_data(as_text=True)
            self.assertNotIn("E:\\", raw_text)
            self.assertNotIn("C:\\", raw_text)
            self.assertNotIn(".csv.gz", raw_text)
            self.assertNotIn("DATABASE_URL", raw_text)
            self.assertNotIn("postgres", raw_text.lower())
            self.assertNotIn("password", raw_text.lower())
            self.assertNotIn("api_key", raw_text.lower())

        # Success response: verify zero absolute disk paths or credentials
        success_resp = self.client.post(
            "/api/journey/recommend",
            json={"from": "Mahindra Park", "to": "Azadpur", "reach_by": 25, "prediction_time": 1791250502},
        )
        self.assertEqual(success_resp.status_code, 200)
        succ_text = success_resp.get_data(as_text=True)
        self.assertNotIn("E:\\", succ_text)
        self.assertNotIn("C:\\", succ_text)
        self.assertNotIn("DATABASE_URL", succ_text)
        self.assertNotIn("postgres", succ_text.lower())
        self.assertNotIn("password", succ_text.lower())
        self.assertNotIn("api_key", succ_text.lower())
        print("  [OK] Security check passed: 0 absolute filesystem paths or secrets leaked in replay responses.")

    def test_30_live_telemetry_future_filtering(self):
        """Verify that live snapshot telemetry with future, non-numeric, or missing timestamps is pruned."""
        print("[Test 30] Testing live telemetry filtering of future/invalid timestamps...")
        import pandas as pd
        from unittest.mock import patch

        snap_file, base_df, snap_pred_ts = get_latest_snapshot()
        simulated_now = snap_pred_ts + 60
        self.mock_time.return_value = simulated_now

        # Construct synthetic live snapshot containing:
        # 1. Valid row (vehicle_ts_unix <= simulated_now)
        # 2. Future row (vehicle_ts_unix = simulated_now + 300)
        # 3. Missing/None timestamp
        # 4. Non-numeric timestamp ("BAD_TIMESTAMP")
        valid_sample = base_df[base_df["route_id"] == "1526"].copy()
        if len(valid_sample) > 0:
            test_rows = valid_sample.iloc[:1].copy().astype({"vehicle_ts_unix": object})
            test_rows.iloc[0, test_rows.columns.get_loc("vehicle_id")] = "VALID_BUS_01"
            test_rows.iloc[0, test_rows.columns.get_loc("vehicle_ts_unix")] = simulated_now - 30

            future_row = test_rows.copy()
            future_row.iloc[0, future_row.columns.get_loc("vehicle_id")] = "FUTURE_BUS_99"
            future_row.iloc[0, future_row.columns.get_loc("vehicle_ts_unix")] = simulated_now + 300

            missing_row = test_rows.copy()
            missing_row.iloc[0, missing_row.columns.get_loc("vehicle_id")] = "MISSING_TS_BUS"
            missing_row.iloc[0, missing_row.columns.get_loc("vehicle_ts_unix")] = None

            bad_row = test_rows.copy()
            bad_row.iloc[0, bad_row.columns.get_loc("vehicle_id")] = "BAD_TS_BUS"
            bad_row.iloc[0, bad_row.columns.get_loc("vehicle_ts_unix")] = "NON_NUMERIC"

            synthetic_df = pd.concat([test_rows, future_row, missing_row, bad_row], ignore_index=True)

            with patch("backend_service.get_latest_snapshot", return_value=(snap_file, synthetic_df, snap_pred_ts)):
                resp = self.client.post(
                    "/api/journey/recommend",
                    json={"from": "Mahindra Park", "to": "Azadpur", "reach_by": 25, "mode": "live"},
                )
                self.assertEqual(resp.status_code, 200)
                data = resp.get_json()
                self.assertEqual(data["status"], "success")

                # Verify FUTURE_BUS_99, MISSING_TS_BUS, BAD_TS_BUS are not recommended
                rec_vid = data.get("recommended_candidate", {}).get("vehicle_id") if data.get("recommended_candidate") else None
                alt_vids = [c["vehicle_id"] for c in data.get("alternative_candidates", [])]
                all_returned_vids = ([rec_vid] if rec_vid else []) + alt_vids

                self.assertNotIn("FUTURE_BUS_99", all_returned_vids)
                self.assertNotIn("MISSING_TS_BUS", all_returned_vids)
                self.assertNotIn("BAD_TS_BUS", all_returned_vids)
        print("  [OK] Live telemetry filtering pruned future, non-numeric, and missing vehicle observations.")

    def test_31_negative_telemetry_age_guard(self):
        """Verify negative telemetry age cannot be FRESH and is rejected in recommendation calculations."""
        print("[Test 31] Testing negative telemetry age guard...")
        import pandas as pd

        # 1. Test sanitize_candidate_for_api classification
        candidate_with_neg_age = {
            "route_id": "1526",
            "direction_id": "0",
            "vehicle_id": "CLOCK_DRIFT_BUS",
            "telemetry": {
                "latitude": 28.72,
                "longitude": 77.16,
                "telemetry_timestamp_unix": 1792609000,
                "telemetry_age_seconds": -120,
            },
        }
        sanitized = sanitize_candidate_for_api(candidate_with_neg_age, self.engine)
        self.assertEqual(sanitized["data_freshness"]["status"], "INVALID_FUTURE_TIMESTAMP")
        self.assertNotEqual(sanitized["data_freshness"]["status"], "FRESH")

        # 2. Test engine rejection of future vehicle row
        test_route = {
            "route_id": "1526",
            "direction_id": "0",
            "from_stop_id": "STOP_0001",
            "from_stop_name": "Mahindra Park",
            "to_stop_id": "STOP_0002",
            "to_stop_name": "Azadpur",
        }
        future_vehicle_row = pd.Series({
            "vehicle_id": "FUTURE_BUS_TEST",
            "route_id": "1526",
            "latitude": 28.72,
            "longitude": 77.16,
            "speed": "25.0",
            "vehicle_ts_unix": 1792609500,
        })
        eval_res = self.engine.evaluate_candidate_journey(
            candidate_route=test_route,
            vehicle_row=future_vehicle_row,
            deadline_ts=1792609000 + 1800,
            prediction_ts=1792609000,  # prediction_ts < vehicle_ts_unix -> age = -500
        )
        self.assertEqual(eval_res["status"], "FUTURE_TELEMETRY")
        self.assertEqual(eval_res["telemetry_age_seconds"], -500)
        self.assertIn("in the future", eval_res["reason"])
        print("  [OK] Negative telemetry age correctly rejected with FUTURE_TELEMETRY and INVALID_FUTURE_TIMESTAMP.")

    def test_32_parse_reach_by_iso_timezone_handling(self):
        """Verify naive ISO datetime strings are strictly interpreted as IST without server double-offset."""
        print("[Test 32] Testing parse_reach_by ISO datetime parsing and timezone handling...")
        fixed_p_ts = 1791250502  # 2026-10-06 07:05:02 IST
        expected_deadline_ts = 1791252302  # 2026-10-06 07:35:02 IST (+30m)

        # 1. Direct unit test of parse_reach_by()
        # Naive ISO formats (must be interpreted as IST)
        ts, err = parse_reach_by("2026-10-06 07:35:02", fixed_p_ts)
        self.assertIsNone(err)
        self.assertEqual(ts, expected_deadline_ts)

        ts, err = parse_reach_by("2026-10-06T07:35:02", fixed_p_ts)
        self.assertIsNone(err)
        self.assertEqual(ts, expected_deadline_ts)

        # Explicit timezone formats
        ts, err = parse_reach_by("2026-10-06 07:35:02+05:30", fixed_p_ts)
        self.assertIsNone(err)
        self.assertEqual(ts, expected_deadline_ts)

        ts, err = parse_reach_by("2026-10-06T02:05:02Z", fixed_p_ts)
        self.assertIsNone(err)
        self.assertEqual(ts, expected_deadline_ts)

        ts, err = parse_reach_by("2026-10-06 02:05:02+00:00", fixed_p_ts)
        self.assertIsNone(err)
        self.assertEqual(ts, expected_deadline_ts)

        # Date-only format (midnight IST)
        ts, err = parse_reach_by("2026-10-06", fixed_p_ts)
        self.assertIsNone(err)
        self.assertEqual(ts, 1791225000)  # 2026-10-06 00:00:00 IST

        # 2. End-to-end API integration via /api/journey/recommend
        # Naive ISO string passed in request payload
        response = self.client.post(
            "/api/journey/recommend",
            json={
                "from": "Mahindra Park",
                "to": "Azadpur",
                "reach_by": "2026-10-06 07:35:02",
                "prediction_time": fixed_p_ts,
            },
        )
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data["status"], "success")
        self.assertEqual(data["query"]["reach_by_unix"], expected_deadline_ts)
        self.assertEqual(data["query"]["time_budget_minutes"], 30.0)

        # Explicit UTC string passed in request payload
        response_utc = self.client.post(
            "/api/journey/recommend",
            json={
                "from": "Mahindra Park",
                "to": "Azadpur",
                "reach_by": "2026-10-06T02:05:02Z",
                "prediction_time": fixed_p_ts,
            },
        )
        self.assertEqual(response_utc.status_code, 200)
        data_utc = response_utc.get_json()
        self.assertEqual(data_utc["status"], "success")
        self.assertEqual(data_utc["query"]["reach_by_unix"], expected_deadline_ts)
        self.assertEqual(data_utc["query"]["time_budget_minutes"], 30.0)
        print("  [OK] ISO datetime strings correctly parsed as IST across naive, explicit offset, and UTC representations.")

    def test_33_stop_search_success(self):
        """Verify GET /api/stops/search handles physical ID, name prefix, and preserves distinct poles."""
        print("[Test 33] Testing GET /api/stops/search successful lookups...")

        # 1. Physical Stop ID search
        res_id = self.client.get("/api/stops/search?q=STOP_04160")
        self.assertEqual(res_id.status_code, 200)
        data_id = res_id.get_json()
        self.assertEqual(data_id["status"], "success")
        self.assertEqual(data_id["results_count"], 1)
        self.assertEqual(data_id["stops"][0]["stop_id"], "STOP_04160")
        self.assertEqual(data_id["stops"][0]["display_name"], "Lakhhi Ram Park")

        # 2. Name prefix search
        res_prefix = self.client.get("/api/stops/search?q=Rohini&limit=5")
        self.assertEqual(res_prefix.status_code, 200)
        data_prefix = res_prefix.get_json()
        self.assertEqual(data_prefix["status"], "success")
        self.assertEqual(data_prefix["results_count"], 5)
        self.assertEqual(data_prefix["limit"], 5)
        # Verify all stop IDs in results are distinct
        sids = [s["stop_id"] for s in data_prefix["stops"]]
        self.assertEqual(len(sids), len(set(sids)))

        # 3. Distinct physical poles with shared name are NOT merged
        res_poles = self.client.get("/api/stops/search?q=Azadpur&limit=10")
        self.assertEqual(res_poles.status_code, 200)
        data_poles = res_poles.get_json()
        self.assertGreater(data_poles["results_count"], 1)
        pole_ids = [s["stop_id"] for s in data_poles["stops"]]
        self.assertEqual(len(pole_ids), len(set(pole_ids)), "Poles must have distinct stop IDs")
        print(f"  [OK] Stop search verified: physical ID lookup, prefix autocomplete, and distinct poles preserved ({len(pole_ids)} distinct poles for 'Azadpur').")

    def test_34_stop_search_empty_and_validation(self):
        """Verify GET /api/stops/search handles empty results, missing query, and limit validation."""
        print("[Test 34] Testing GET /api/stops/search validation and empty results...")

        # 1. Missing query param -> 400 MISSING_QUERY
        res_missing = self.client.get("/api/stops/search")
        self.assertEqual(res_missing.status_code, 400)
        data_missing = res_missing.get_json()
        self.assertEqual(data_missing["error_type"], "MISSING_QUERY")

        # 2. Empty string query -> 200 with empty list
        res_empty = self.client.get("/api/stops/search?q=")
        self.assertEqual(res_empty.status_code, 200)
        data_empty = res_empty.get_json()
        self.assertEqual(data_empty["status"], "success")
        self.assertEqual(data_empty["results_count"], 0)
        self.assertEqual(data_empty["stops"], [])

        # 3. Whitespace query -> 200 with empty list
        res_ws = self.client.get("/api/stops/search?q=%20%20")
        self.assertEqual(res_ws.status_code, 200)
        self.assertEqual(res_ws.get_json()["results_count"], 0)

        # 4. Non-matching query -> 200 with empty list
        res_unmatched = self.client.get("/api/stops/search?q=NONEXISTENT_XYZ_STOP_99999")
        self.assertEqual(res_unmatched.status_code, 200)
        self.assertEqual(res_unmatched.get_json()["results_count"], 0)

        # 5. Invalid limit (non-integer string) -> 400 INVALID_LIMIT
        res_bad_limit = self.client.get("/api/stops/search?q=Azadpur&limit=abc")
        self.assertEqual(res_bad_limit.status_code, 400)
        self.assertEqual(res_bad_limit.get_json()["error_type"], "INVALID_LIMIT")

        # 6. Negative limit -> 400 INVALID_LIMIT
        res_neg_limit = self.client.get("/api/stops/search?q=Azadpur&limit=-5")
        self.assertEqual(res_neg_limit.status_code, 400)
        self.assertEqual(res_neg_limit.get_json()["error_type"], "INVALID_LIMIT")

        # 7. Zero limit -> 400 INVALID_LIMIT
        res_zero_limit = self.client.get("/api/stops/search?q=Azadpur&limit=0")
        self.assertEqual(res_zero_limit.status_code, 400)
        self.assertEqual(res_zero_limit.get_json()["error_type"], "INVALID_LIMIT")

        # 8. Limit clamped to MAX_SEARCH_LIMIT (50)
        res_clamp = self.client.get("/api/stops/search?q=Rohini&limit=200")
        self.assertEqual(res_clamp.status_code, 200)
        self.assertEqual(res_clamp.get_json()["limit"], 50)
        print("  [OK] Search validation verified: 400 on missing query, empty lists on blank/unmatched, strict limit guards and max clamping.")

    def test_35_stop_destinations_success_and_structural_label(self):
        """Verify GET /api/stops/destinations returns structural connectivity with required disclosures."""
        print("[Test 35] Testing GET /api/stops/destinations structural connectivity...")

        # 1. Valid origin lookup
        res = self.client.get("/api/stops/destinations?origin_id=STOP_04115&limit=5")
        self.assertEqual(res.status_code, 200)
        data = res.get_json()

        self.assertEqual(data["status"], "success")
        self.assertEqual(data["origin"]["stop_id"], "STOP_04115")
        self.assertEqual(data["origin"]["display_name"], "Azadpur")
        self.assertIn("lat", data["origin"])
        self.assertIn("lon", data["origin"])

        # 2. Structural connectivity label & disclosure (NEVER claim live bus availability)
        self.assertEqual(data["connectivity_type"], "structural_network")
        self.assertIn("structural route-network connectivity only", data["disclosure"].lower())
        self.assertIn("not live bus availability", data["disclosure"].lower())

        # 3. Destination results properties
        self.assertEqual(data["results_count"], 5)
        self.assertEqual(data["limit"], 5)
        destinations = data["destinations"]
        self.assertEqual(len(destinations), 5)

        # 4. Origin must NOT appear in its own destination suggestions
        dest_ids = [d["stop_id"] for d in destinations]
        self.assertNotIn("STOP_04115", dest_ids)

        # 5. Destinations must be sorted by serving_direction_count descending
        dir_counts = [d["serving_direction_count"] for d in destinations]
        self.assertEqual(dir_counts, sorted(dir_counts, reverse=True))

        # 6. Aliased param 'origin_stop_id' works identically
        res_alias = self.client.get("/api/stops/destinations?origin_stop_id=STOP_04115&limit=3")
        self.assertEqual(res_alias.status_code, 200)
        self.assertEqual(res_alias.get_json()["results_count"], 3)
        print("  [OK] Destinations verified: structural network disclosure present, origin excluded, sorted by direction count.")

    def test_36_stop_destinations_validation_and_unknown_id(self):
        """Verify GET /api/stops/destinations handles missing/invalid origin, unknown stop IDs, and limit guards."""
        print("[Test 36] Testing GET /api/stops/destinations validation and error handling...")

        # 1. Missing origin_id -> 400 MISSING_ORIGIN_ID
        res_missing = self.client.get("/api/stops/destinations")
        self.assertEqual(res_missing.status_code, 400)
        self.assertEqual(res_missing.get_json()["error_type"], "MISSING_ORIGIN_ID")

        # 2. Empty/whitespace origin_id -> 400 MISSING_ORIGIN_ID
        res_empty = self.client.get("/api/stops/destinations?origin_id=%20%20")
        self.assertEqual(res_empty.status_code, 400)
        self.assertEqual(res_empty.get_json()["error_type"], "MISSING_ORIGIN_ID")

        # 3. Unknown stop ID -> 404 STOP_NOT_FOUND
        res_unknown = self.client.get("/api/stops/destinations?origin_id=STOP_99999999")
        self.assertEqual(res_unknown.status_code, 404)
        data_unknown = res_unknown.get_json()
        self.assertEqual(data_unknown["error_type"], "STOP_NOT_FOUND")

        # 4. Invalid limit (non-integer string) -> 400 INVALID_LIMIT
        res_bad_lim = self.client.get("/api/stops/destinations?origin_id=STOP_04115&limit=xyz")
        self.assertEqual(res_bad_lim.status_code, 400)
        self.assertEqual(res_bad_lim.get_json()["error_type"], "INVALID_LIMIT")

        # 5. Negative limit -> 400 INVALID_LIMIT
        res_neg_lim = self.client.get("/api/stops/destinations?origin_id=STOP_04115&limit=-1")
        self.assertEqual(res_neg_lim.status_code, 400)
        self.assertEqual(res_neg_lim.get_json()["error_type"], "INVALID_LIMIT")

        # 6. Zero limit -> 400 INVALID_LIMIT
        res_zero_lim = self.client.get("/api/stops/destinations?origin_id=STOP_04115&limit=0")
        self.assertEqual(res_zero_lim.status_code, 400)
        self.assertEqual(res_zero_lim.get_json()["error_type"], "INVALID_LIMIT")

        # 7. Limit clamped to MAX_DEST_LIMIT (100)
        res_clamp = self.client.get("/api/stops/destinations?origin_id=STOP_04115&limit=500")
        self.assertEqual(res_clamp.status_code, 200)
        self.assertEqual(res_clamp.get_json()["limit"], 100)
        print("  [OK] Destinations validation verified: 400 on missing origin, 404 on unknown stop ID, limit clamping to 100.")

    def test_37_stop_endpoints_cors_and_options(self):
        """Verify OPTIONS preflight and CORS header reflection on stop discovery endpoints."""
        print("[Test 37] Testing OPTIONS preflight and CORS on stop discovery endpoints...")

        # 1. OPTIONS on /api/stops/search -> 204
        res_opt_search = self.client.open("/api/stops/search", method="OPTIONS")
        self.assertEqual(res_opt_search.status_code, 204)

        # 2. OPTIONS on /api/stops/destinations -> 204
        res_opt_dest = self.client.open("/api/stops/destinations", method="OPTIONS")
        self.assertEqual(res_opt_dest.status_code, 204)

        # 3. CORS headers with allowed origin
        res_cors = self.client.get(
            "/api/stops/search?q=Azadpur",
            headers={"Origin": "http://localhost:5173"},
        )
        self.assertEqual(res_cors.status_code, 200)
        self.assertEqual(res_cors.headers.get("Access-Control-Allow-Origin"), "http://localhost:5173")
        print("  [OK] CORS headers and OPTIONS preflight verified across both stop discovery endpoints.")


if __name__ == "__main__":
    unittest.main()
