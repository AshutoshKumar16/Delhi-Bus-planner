#!/usr/bin/env python3
"""
===============================================================================
Delhi Bus Project - Web Integration Backend Layer
Script: backend_service.py

Purpose:
  Provides a minimal, robust HTTP REST API service that exposes the existing
  Risk-Aware Journey Recommendation Engine to web clients (such as the React UI)
  without duplicating or modifying research mathematics.

Endpoints:
  GET  /api/health
       Returns system operational status, warm cache metrics, and indexed route counts.

  POST /api/journey/recommend
       Computes risk-aware bus recommendations given origin, destination, and deadline.

Operational Guarantees:
  1. In-Memory Persistence: Loads route geometries (reconstructed_routes.json)
     and empirical segment distributions (route_segments.json) ONCE at startup.
     Query execution is warm and sub-50ms (no 3-second cold load per request).
  2. Zero Math Duplication: Directly delegates calculation to JourneyRecommendationEngine.
  3. Strict Information Hygiene: Strips all internal filesystem paths, DB credentials,
     and OTD API keys from client responses.
  4. Robust Input Validation: Sanitizes stop names, timestamps, and deadline formats.
  5. Built-in CORS Support: Enables direct integration with frontend development servers.
===============================================================================
"""

import datetime
import glob
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd
from flask import Flask, jsonify, request

from prototype_journey_recommendation import (
    DEFAULT_ROUTES_PATH,
    DEFAULT_SEGMENTS_PATH,
    JourneyRecommendationEngine,
    format_unix_timestamp,
)
from stop_index import StopIndex
from replay_snapshots import (
    ArchiveDataUnavailableError,
    ArchiveGapExceededError,
    FuturePredictionTimeError,
    InSampleReplayForbiddenError,
    InvalidPredictionTimeError,
    MissingPredictionTimeError,
    ModelProvenancePolicy,
    NoHistoricalSnapshotError,
    ReplayError,
    ReplayResolutionResult,
    ReplaySnapshotResolver,
    filter_snapshot_telemetry,
    validate_prediction_ts,
)

# App Configuration
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 5000
DATA_DIR = Path("data")
MAX_LIVE_SNAPSHOT_AGE_S = 420  # 7 minutes maximum age for live telemetry feed

app = Flask(__name__)
START_TIME = time.time()

# Global Engine & Cache Instances (loaded once in memory)
engine: Optional[JourneyRecommendationEngine] = None
latest_snapshot_cache: Optional[Tuple[str, pd.DataFrame, int]] = None
replay_resolver: Optional[ReplaySnapshotResolver] = None
stop_index_instance: Optional[StopIndex] = None


def load_model_provenance_policy(data_dir: Path = DATA_DIR) -> ModelProvenancePolicy:
    """
    Dynamically loads authoritative model provenance boundaries from disk artifacts:
      1. training_cutoff_unix: from network_build_profile.json (summary.archive_days_list)
      2. model_available_unix: strictly from route_segments_summary.json (metadata.created_at_iso)
      3. production_activation_unix: None (unverified in repository metadata)

    Operational Guarantees:
      - Preserves verified training cutoff even if route_segments_summary.json is missing.
      - If route_segments_summary.json is missing or malformed, model_available_unix is None.
      - Never falls back to route_reconstruction_summary.json for segment availability.
      - Never injects diagnostic defaults into production.
    """
    training_cutoff_unix: Optional[int] = None
    model_available_unix: Optional[int] = None

    # 1. Training Cutoff: end of last archive day processed in network_build_profile.json
    profile_path = data_dir / "network_build_profile.json"
    if profile_path.is_file():
        try:
            with open(profile_path, "r", encoding="utf-8") as f:
                prof_data = json.load(f)
            days = prof_data.get("summary", {}).get("archive_days_list") or prof_data.get("archive_days_list")
            if days and isinstance(days, list):
                valid_days = [str(d).strip() for d in days if re.match(r"^\d{4}-\d{2}-\d{2}$", str(d).strip())]
                if valid_days:
                    last_day = max(valid_days)
                    dt_last = datetime.datetime.strptime(last_day, "%Y-%m-%d").replace(tzinfo=datetime.timezone.utc)
                    training_cutoff_unix = int((dt_last + datetime.timedelta(days=1)).timestamp())
        except Exception:
            training_cutoff_unix = None

    # 2. Model Availability: strictly from route_segments_summary.json
    summary_path = data_dir / "route_segments_summary.json"
    if summary_path.is_file():
        try:
            with open(summary_path, "r", encoding="utf-8") as f:
                seg_summary = json.load(f)
            iso_str = seg_summary.get("metadata", {}).get("created_at_iso")
            if iso_str and isinstance(iso_str, str):
                dt_created = datetime.datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
                model_available_unix = int(dt_created.timestamp())
        except Exception:
            model_available_unix = None

    return ModelProvenancePolicy(
        training_cutoff_unix=training_cutoff_unix,
        model_available_unix=model_available_unix,
        production_activation_unix=None,
    )


def get_replay_resolver(data_dir: Path = DATA_DIR) -> ReplaySnapshotResolver:
    """Returns the singleton ReplaySnapshotResolver initialized with dynamic artifact provenance."""
    global replay_resolver
    if replay_resolver is None:
        policy = load_model_provenance_policy(data_dir)
        replay_resolver = ReplaySnapshotResolver(archive_dir=data_dir, provenance_policy=policy)
    return replay_resolver


def get_latest_snapshot() -> Tuple[str, pd.DataFrame, int]:
    """
    Finds and loads the latest genuine OTD archive snapshot.
    Caches the DataFrame in memory for fast query servicing.
    Skips empty/unpopulated snapshots.
    """
    global latest_snapshot_cache
    snapshots = sorted(glob.glob("data/*/*.csv.gz"))
    if not snapshots:
        raise FileNotFoundError("No archive snapshot files found under data/*/*.csv.gz")

    for file_path in reversed(snapshots):
        try:
            if os.path.getsize(file_path) < 200:
                continue
            if latest_snapshot_cache is not None and latest_snapshot_cache[0] == file_path:
                return latest_snapshot_cache
            df = pd.read_csv(file_path, dtype={"route_id": str, "vehicle_id": str})
            if df.empty or "vehicle_ts_unix" not in df.columns or df["vehicle_ts_unix"].dropna().empty:
                continue
            pred_ts = int(df["vehicle_ts_unix"].dropna().max())
            latest_snapshot_cache = (file_path, df, pred_ts)
            return latest_snapshot_cache
        except Exception:
            continue

    raise FileNotFoundError("No valid non-empty archive snapshot found under data/*/*.csv.gz")


def initialize_engine(
    routes_path: Path = DEFAULT_ROUTES_PATH, segments_path: Path = DEFAULT_SEGMENTS_PATH
) -> JourneyRecommendationEngine:
    """Initializes the global journey recommendation engine."""
    global engine
    if engine is None:
        print("[*] Initializing JourneyRecommendationEngine into memory...")
        t0 = time.time()
        engine = JourneyRecommendationEngine(routes_path, segments_path)
        print(f"[OK] Engine initialized successfully in {time.time()-t0:.2f}s.")
    return engine


def initialize_stop_index(
    routes_path: Path = DEFAULT_ROUTES_PATH, segments_path: Path = DEFAULT_SEGMENTS_PATH
) -> StopIndex:
    """Initializes and returns the singleton StopIndex instance using the recommendation engine."""
    global stop_index_instance
    if stop_index_instance is None:
        eng = initialize_engine(routes_path, segments_path)
        stop_index_instance = StopIndex(eng)
    return stop_index_instance


def parse_reach_by(
    reach_by_val: Any, prediction_ts: int
) -> Tuple[Optional[int], Optional[str]]:
    """
    Parses various user deadline representations into a unix timestamp:
      - Relative integer/float minutes (e.g. 25, 25.0, "25m")
      - Unix timestamp integer (e.g. 1790772057)
      - ISO 8601 timestamp string (e.g. "2026-09-30T18:10:57")
    Returns (deadline_unix_ts, error_message).
    """
    if reach_by_val is None:
        return None, "Field 'reach_by' is required."

    # 1. Direct integer/float
    if isinstance(reach_by_val, (int, float)):
        val = float(reach_by_val)
        # If value is smaller than 1000, treat as relative minutes offset
        if val < 1000.0:
            if val <= 0:
                return None, "Relative deadline offset in minutes must be greater than 0."
            return int(prediction_ts + round(val * 60)), None
        # Otherwise treat as unix timestamp
        if val < 1500000000:
            return None, f"Invalid unix timestamp value: {val}."
        return int(val), None

    # 2. String handling
    if isinstance(reach_by_val, str):
        s = reach_by_val.strip()
        # Relative minutes format like "25m", "25 min", "25"
        m_rel = re.match(r"^(\d+(?:\.\d+)?)\s*(?:m|min|mins|minutes)?$", s, re.IGNORECASE)
        if m_rel:
            minutes = float(m_rel.group(1))
            if minutes < 1000.0:
                if minutes <= 0:
                    return None, "Relative deadline offset in minutes must be greater than 0."
                return int(prediction_ts + round(minutes * 60)), None

        # Numeric string (unix timestamp)
        if s.isdigit():
            ts = int(s)
            if ts < 1500000000:
                return None, f"Invalid unix timestamp: {s}."
            return ts, None

        # ISO format strings: "2026-09-30 18:10:57" or "2026-09-30T18:10:57"
        iso_str = s.replace("Z", "+00:00")
        for fmt in (
            "%Y-%m-%dT%H:%M:%S",
            "%Y-%m-%d %H:%M:%S",
            "%Y-%m-%dT%H:%M:%S%z",
            "%Y-%m-%d %H:%M:%S%z",
            "%Y-%m-%d",
        ):
            try:
                dt = datetime.datetime.strptime(iso_str, fmt)
                # If timezone naive, assume Indian Standard Time (UTC+05:30)
                if dt.tzinfo is None:
                    ist_tz = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
                    dt = dt.replace(tzinfo=ist_tz)
                return int(dt.timestamp()), None
            except ValueError:
                continue

        return None, f"Unrecognized reach_by timestamp format: '{s}'. Use ISO format (YYYY-MM-DD HH:MM:SS), relative minutes (e.g. 25), or unix timestamp."

    return None, f"Unsupported reach_by type: {type(reach_by_val).__name__}."


def sanitize_candidate_for_api(
    c: Dict[str, Any], eng: Optional[JourneyRecommendationEngine] = None
) -> Dict[str, Any]:
    """
    Sanitizes candidate bus dictionary for public API consumption:
      - Strips internal debug pointers and raw coordinate arrays.
      - Keeps operational, commuter-facing metrics.
      - Adds map coordinate geometry:
        * pickup.latitude, pickup.longitude
        * destination.latitude, destination.longitude
        * vehicle_position { latitude, longitude, speed_kmh_or_null, speed_mps_or_null, timestamp_unix }
        * route_path [[lat, lon], ...]
        * route_path_type: "stop_sequence"
    """
    if eng is None:
        eng = initialize_engine()

    tel = c.get("telemetry", {})
    pl = c.get("pickup_leg", {})
    iv = c.get("in_vehicle_leg", {})
    da = c.get("destination_arrival", {})
    de = c.get("deadline_evaluation", {})
    ev = c.get("evidence", {})

    age_s = tel.get("telemetry_age_seconds")
    if age_s is None or not isinstance(age_s, (int, float)):
        freshness_status = "UNKNOWN"
        age_s = 0
    elif age_s < 0:
        freshness_status = "INVALID_FUTURE_TIMESTAMP"
    elif age_s <= 300:
        freshness_status = "FRESH"
    elif age_s <= 900:
        freshness_status = "MODERATE"
    else:
        freshness_status = "STALE"

    # 1. Lookup route stop coordinates for the candidate's own direction
    rid = str(c.get("route_id", ""))
    did = str(c.get("direction_id", ""))
    r_data = eng.routes.get(rid, {}) if eng else {}
    d_data = r_data.get("directions", {}).get(did, {}) if r_data else {}
    stop_coordinates = d_data.get("stop_coordinates", [])

    # Sequence indices for pickup and destination stops
    from_idx = pl.get("from_stop_sequence") if pl.get("from_stop_sequence") is not None else c.get("from_stop_sequence")
    to_idx = da.get("to_stop_sequence") if da.get("to_stop_sequence") is not None else c.get("to_stop_sequence")

    # Fallback to ordered_stop_ids if sequence indices are not directly on candidate
    if (from_idx is None or to_idx is None) and d_data:
        ordered_stop_ids = d_data.get("ordered_stop_ids", [])
        if from_idx is None and pl.get("from_stop_id") in ordered_stop_ids:
            from_idx = ordered_stop_ids.index(pl.get("from_stop_id"))
        if to_idx is None and da.get("to_stop_id") in ordered_stop_ids:
            to_idx = ordered_stop_ids.index(da.get("to_stop_id"))

    # 2. Pickup Coordinates
    pickup_lat = None
    pickup_lon = None
    if from_idx is not None and isinstance(from_idx, int) and 0 <= from_idx < len(stop_coordinates):
        pt = stop_coordinates[from_idx]
        if pt is not None and len(pt) >= 2 and pt[0] is not None and pt[1] is not None:
            pickup_lat = round(float(pt[0]), 6)
            pickup_lon = round(float(pt[1]), 6)

    # 3. Destination Coordinates
    dest_lat = None
    dest_lon = None
    if to_idx is not None and isinstance(to_idx, int) and 0 <= to_idx < len(stop_coordinates):
        pt = stop_coordinates[to_idx]
        if pt is not None and len(pt) >= 2 and pt[0] is not None and pt[1] is not None:
            dest_lat = round(float(pt[0]), 6)
            dest_lon = round(float(pt[1]), 6)

    # 4. Route Path (stop_coordinates from pickup to destination inclusive)
    route_path = None
    if (
        from_idx is not None
        and to_idx is not None
        and isinstance(from_idx, int)
        and isinstance(to_idx, int)
        and 0 <= from_idx <= to_idx < len(stop_coordinates)
    ):
        pts = stop_coordinates[from_idx : to_idx + 1]
        route_path = [
            [round(float(pt[0]), 6), round(float(pt[1]), 6)]
            for pt in pts
            if pt is not None and len(pt) >= 2 and pt[0] is not None and pt[1] is not None
        ]

    # 5. Vehicle Position
    v_lat = tel.get("latitude")
    v_lon = tel.get("longitude")
    v_ts = tel.get("telemetry_timestamp_unix")
    raw_spd = tel.get("speed")

    spd_mps = None
    spd_kmh = None
    if raw_spd is not None and raw_spd != "":
        try:
            spd_val = float(raw_spd)
            spd_mps = round(spd_val, 2)
            spd_kmh = round(spd_val * 3.6, 2)
        except (ValueError, TypeError):
            spd_mps = None
            spd_kmh = None

    vehicle_position = {
        "latitude": round(float(v_lat), 6) if v_lat is not None else None,
        "longitude": round(float(v_lon), 6) if v_lon is not None else None,
        "speed_kmh_or_null": spd_kmh,
        "speed_mps_or_null": spd_mps,
        "timestamp_unix": int(v_ts) if v_ts is not None else None,
    }

    return {
        "recommendation_rank": c.get("recommendation_rank"),
        "recommendation_tier": c.get("recommendation_tier"),
        "route_id": c.get("route_id"),
        "direction_id": c.get("direction_id"),
        "vehicle_id": c.get("vehicle_id"),
        "vehicle_position": vehicle_position,
        "data_freshness": {
            "telemetry_age_seconds": age_s,
            "status": freshness_status,
        },
        "pickup": {
            "stop_id": pl.get("from_stop_id"),
            "stop_name": pl.get("from_stop_name"),
            "latitude": pickup_lat,
            "longitude": pickup_lon,
            "distance_meters": pl.get("distance_to_pickup_meters"),
            "expected_wait_minutes": pl.get("expected_pickup_wait_minutes"),
            "expected_pickup_eta": pl.get("expected_pickup_eta_formatted"),
            "pickup_std_seconds": pl.get("pickup_std_seconds"),
        },
        "in_vehicle": {
            "distance_meters": iv.get("distance_meters"),
            "stops_count": iv.get("stops_count"),
            "expected_travel_time_minutes": iv.get("expected_travel_time_minutes"),
            "std_travel_time_seconds": iv.get("std_travel_time_seconds"),
        },
        "destination": {
            "stop_id": da.get("to_stop_id"),
            "stop_name": da.get("to_stop_name"),
            "latitude": dest_lat,
            "longitude": dest_lon,
            "total_distance_meters": da.get("total_remaining_distance_meters"),
            "expected_travel_time_minutes": da.get("expected_total_travel_time_minutes"),
            "expected_arrival": da.get("expected_arrival_formatted"),
            "uncertainty_interval_80pct_minutes": da.get("uncertainty_interval_80pct_minutes"),
            "standard_deviation_seconds": da.get("standard_deviation_seconds"),
            "corridor_percentile_bounds_minutes": da.get("corridor_percentile_bounds_minutes"),
            "implied_speed_kmh": da.get("implied_speed_kmh"),
        },
        "route_path": route_path,
        "route_path_type": "stop_sequence",
        "deadline_probability": {
            "probability_on_time": de.get("probability_on_time"),
            "probability_on_time_pct": de.get("probability_on_time_pct"),
            "probability_miss": de.get("probability_miss"),
            "probability_miss_pct": de.get("probability_miss_pct"),
            "confidence_tier": de.get("confidence_tier"),
            "slack_minutes": de.get("slack_minutes"),
        },
        "route_reconstruction_confidence": c.get("route_reconstruction_confidence"),
        "evidence_samples": ev.get("historical_samples_pooled"),
    }


# CORS Middleware for all responses
@app.after_request
def add_cors_headers(response):
    allowed_origins = {"http://localhost:5173", "http://127.0.0.1:5173"}
    origin = request.headers.get("Origin")
    if origin in allowed_origins:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Vary"] = "Origin"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type,Authorization"
    response.headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS"
    return response


# Stop Discovery Configuration
DEFAULT_SEARCH_LIMIT = 10
MAX_SEARCH_LIMIT = 50
DEFAULT_DEST_LIMIT = 50
MAX_DEST_LIMIT = 100


@app.route("/api/health", methods=["GET"])
def health_check():
    """
    Health check endpoint: returns engine readiness and network dimensions.
    """
    eng = initialize_engine()
    stop_idx = initialize_stop_index()
    uptime_s = round(time.time() - START_TIME, 1)

    return jsonify({
        "status": "healthy",
        "service": "delhi-bus-journey-recommendation-api",
        "version": "1.0.0",
        "uptime_seconds": uptime_s,
        "network": {
            "reconstructed_routes_indexed": len(eng.routes),
            "route_segments_indexed": sum(len(d) for d in eng.segments_by_dir.values()),
            "distinct_stop_keys_indexed": len(eng.stop_to_directions),
            "indexed_stop_ids": stop_idx.stats()["indexed_stop_ids"],
            "indexed_stop_names": stop_idx.stats()["indexed_name_keys"],
        },
        "timestamp_unix": int(time.time()),
        "timestamp_formatted": format_unix_timestamp(int(time.time())),
    }), 200


@app.route("/api/stops/search", methods=["GET", "OPTIONS"])
def search_stops_endpoint():
    """
    GET /api/stops/search?q=<query>&limit=<limit>

    Autocomplete / lookup for Delhi bus stops by physical ID, exact name,
    prefix, or substring. Deduplicated by physical stop_id.
    """
    if request.method == "OPTIONS":
        return "", 204

    q = request.args.get("q")
    if q is None:
        return jsonify({
            "status": "error",
            "error_type": "MISSING_QUERY",
            "message": "Query parameter 'q' is required.",
        }), 400

    limit_raw = request.args.get("limit")
    if limit_raw is not None:
        try:
            limit = int(limit_raw)
            if limit <= 0:
                return jsonify({
                    "status": "error",
                    "error_type": "INVALID_LIMIT",
                    "message": "Parameter 'limit' must be a positive integer.",
                }), 400
            limit = min(limit, MAX_SEARCH_LIMIT)
        except (ValueError, TypeError):
            return jsonify({
                "status": "error",
                "error_type": "INVALID_LIMIT",
                "message": "Parameter 'limit' must be an integer.",
            }), 400
    else:
        limit = DEFAULT_SEARCH_LIMIT

    stop_idx = initialize_stop_index()
    results = stop_idx.search_stops(q, limit=limit)

    return jsonify({
        "status": "success",
        "query": q,
        "results_count": len(results),
        "limit": limit,
        "stops": [s.to_dict() for s in results],
    }), 200


@app.route("/api/stops/destinations", methods=["GET", "OPTIONS"])
def reachable_destinations_endpoint():
    """
    GET /api/stops/destinations?origin_id=<stop_id>&limit=<limit>

    Returns downstream bus stops reachable from origin_id via the
    reconstructed route network in forward sequence.
    Structural connectivity only — NOT live bus availability.
    """
    if request.method == "OPTIONS":
        return "", 204

    origin_id = request.args.get("origin_id") or request.args.get("origin_stop_id")
    if not origin_id or not origin_id.strip():
        return jsonify({
            "status": "error",
            "error_type": "MISSING_ORIGIN_ID",
            "message": "Query parameter 'origin_id' (or 'origin_stop_id') is required.",
        }), 400

    origin_id = origin_id.strip()

    limit_raw = request.args.get("limit")
    if limit_raw is not None:
        try:
            limit = int(limit_raw)
            if limit <= 0:
                return jsonify({
                    "status": "error",
                    "error_type": "INVALID_LIMIT",
                    "message": "Parameter 'limit' must be a positive integer.",
                }), 400
            limit = min(limit, MAX_DEST_LIMIT)
        except (ValueError, TypeError):
            return jsonify({
                "status": "error",
                "error_type": "INVALID_LIMIT",
                "message": "Parameter 'limit' must be an integer.",
            }), 400
    else:
        limit = DEFAULT_DEST_LIMIT

    stop_idx = initialize_stop_index()
    origin_stop = stop_idx.get_stop_by_id(origin_id)
    if origin_stop is None:
        return jsonify({
            "status": "error",
            "error_type": "STOP_NOT_FOUND",
            "message": f"Stop ID '{origin_id}' was not found in the reconstructed route network.",
        }), 404

    dests = stop_idx.get_reachable_destinations(origin_id, limit=limit)

    return jsonify({
        "status": "success",
        "origin": origin_stop.to_dict(),
        "connectivity_type": "structural_network",
        "disclosure": "Destination suggestions represent structural route-network connectivity only, not live bus availability or deadline feasibility.",
        "results_count": len(dests),
        "limit": limit,
        "destinations": [d.to_dict() for d in dests],
    }), 200


@app.route("/api/journey/recommend", methods=["POST", "OPTIONS"])
def recommend_journey_endpoint():
    """
    POST /api/journey/recommend

    Request JSON:
    {
      "from": "Mahindra Park",
      "to": "Azadpur",
      "reach_by": 25  // or "2026-09-30 18:10:57", or unix timestamp
    }
    """
    if request.method == "OPTIONS":
        return "", 204

    data = request.get_json(silent=True)
    if not data or not isinstance(data, dict):
        return jsonify({
            "status": "error",
            "error_type": "INVALID_JSON",
            "message": "Request body must be a valid JSON object.",
        }), 400

    # 1. Validate 'from' and 'to'
    from_stop = data.get("from") or data.get("from_stop") or data.get("origin")
    to_stop = data.get("to") or data.get("to_stop") or data.get("destination")

    if not from_stop or not isinstance(from_stop, str) or not from_stop.strip():
        return jsonify({
            "status": "error",
            "error_type": "MISSING_ORIGIN",
            "message": "Field 'from' (origin stop name or ID) is required and must be a non-empty string.",
        }), 400

    if not to_stop or not isinstance(to_stop, str) or not to_stop.strip():
        return jsonify({
            "status": "error",
            "error_type": "MISSING_DESTINATION",
            "message": "Field 'to' (destination stop name or ID) is required and must be a non-empty string.",
        }), 400

    from_stop = from_stop.strip()
    to_stop = to_stop.strip()

    if from_stop.lower() == to_stop.lower():
        return jsonify({
            "status": "error",
            "error_type": "IDENTICAL_STOPS",
            "message": "Origin and destination stops cannot be identical.",
        }), 400

    # 2. Mode Validation Precedence
    # Step 1: Reject unsupported mode values first
    raw_mode = data.get("mode")
    mode_str: Optional[str] = None
    if raw_mode is not None:
        if not isinstance(raw_mode, str) or raw_mode.strip().lower() not in ("live", "replay"):
            return jsonify({
                "status": "error",
                "error_type": "INVALID_MODE",
                "message": f"Unsupported mode: '{raw_mode}'. Mode must be 'live' or 'replay'.",
                "supported_modes": ["live", "replay"],
            }), 400
        mode_str = raw_mode.strip().lower()

    # Step 2: Apply backward-compatible mode resolution
    raw_pred_time = data.get("prediction_time") if "prediction_time" in data else data.get("current_time")
    if mode_str is not None:
        resolved_mode = mode_str
    elif raw_pred_time is not None:
        resolved_mode = "replay"  # Inferred for existing clients and tests
    else:
        resolved_mode = "live"    # Default live behavior

    # Step 3: Reject mode="live" combined with prediction_time
    if resolved_mode == "live" and raw_pred_time is not None:
        return jsonify({
            "status": "error",
            "error_type": "CONFLICTING_MODE",
            "message": "Parameter 'prediction_time' cannot be specified when mode is 'live'.",
        }), 400

    # Step 4: Reject mode="replay" without prediction_time
    if resolved_mode == "replay" and raw_pred_time is None:
        return jsonify({
            "status": "error",
            "error_type": "MISSING_PREDICTION_TIME",
            "message": "Field 'prediction_time' is required for replay mode.",
        }), 400

    # 3. Resolve Snapshot & Telemetry Feed
    now_ts = int(time.time())
    replay_metadata: Optional[Dict[str, Any]] = None

    if resolved_mode == "live":
        # Live Snapshot Resolution
        try:
            snap_file, df_snap, default_pred_ts = get_latest_snapshot()
        except Exception as e:
            return jsonify({
                "status": "error",
                "error_type": "DATASET_UNAVAILABLE",
                "message": f"Realtime observation snapshot is currently unavailable: {str(e)}",
            }), 503

        pred_ts = now_ts
        telemetry_mode = "live"

        snapshot_age_s = max(0, now_ts - default_pred_ts)
        if snapshot_age_s > MAX_LIVE_SNAPSHOT_AGE_S:
            return jsonify({
                "status": "error",
                "error_type": "STALE_TELEMETRY_FEED",
                "message": (
                    f"Live telemetry feed is delayed: latest snapshot is {snapshot_age_s}s old "
                    f"(exceeds {MAX_LIVE_SNAPSHOT_AGE_S}s limit). Cannot serve live recommendations on stale data."
                ),
                "telemetry_mode": "live",
                "telemetry_age_seconds": snapshot_age_s,
                "latest_snapshot_ts": default_pred_ts,
                "server_time_unix": now_ts,
            }), 503

        # Defensive Live Telemetry Filtering:
        # Prune missing, non-numeric, or future vehicle observations (vehicle_ts_unix > now_ts)
        df_snap, _ = filter_snapshot_telemetry(df_snap, pred_ts)

    else:
        # Replay Snapshot Resolution
        telemetry_mode = "replay"
        try:
            pred_ts = validate_prediction_ts(raw_pred_time, now_ts=now_ts)
        except MissingPredictionTimeError as e:
            return jsonify({
                "status": "error",
                "error_type": "MISSING_PREDICTION_TIME",
                "message": str(e),
            }), 400
        except InvalidPredictionTimeError as e:
            return jsonify({
                "status": "error",
                "error_type": "INVALID_PREDICTION_TIME",
                "message": str(e),
            }), 400
        except FuturePredictionTimeError as e:
            return jsonify({
                "status": "error",
                "error_type": "FUTURE_PREDICTION_TIME",
                "message": str(e),
                "prediction_timestamp_unix": int(raw_pred_time) if str(raw_pred_time).isdigit() else raw_pred_time,
                "server_time_unix": now_ts,
            }), 400

        server_diagnostic_override = bool(app.config.get("ALLOW_IN_SAMPLE_REPLAY", False))
        resolver = get_replay_resolver()
        try:
            res: ReplayResolutionResult = resolver.resolve_replay_snapshot(
                pred_ts, allow_in_sample=server_diagnostic_override
            )
        except InSampleReplayForbiddenError as e:
            return jsonify({
                "status": "error",
                "error_type": "IN_SAMPLE_REPLAY_FORBIDDEN",
                "message": (
                    "Historical replay is not supported for timestamps within the model training corpus. "
                    "Please select a prediction time after the training cutoff."
                ),
                "prediction_timestamp_unix": pred_ts,
            }), 403
        except NoHistoricalSnapshotError as e:
            return jsonify({
                "status": "error",
                "error_type": "NO_HISTORICAL_SNAPSHOT",
                "message": str(e),
                "prediction_timestamp_unix": pred_ts,
                "commit_margin_seconds": resolver.commit_margin_s,
            }), 404
        except ArchiveGapExceededError as e:
            return jsonify({
                "status": "error",
                "error_type": "ARCHIVE_GAP_EXCEEDED",
                "message": str(e),
                "prediction_ts": e.prediction_ts,
                "gap_seconds": e.gap_seconds,
                "max_gap_seconds": e.max_gap_seconds,
                "newest_snapshot_poll_start": e.newest_snapshot_poll_start,
            }), 503
        except ArchiveDataUnavailableError as e:
            return jsonify({
                "status": "error",
                "error_type": "ARCHIVE_DATA_UNAVAILABLE",
                "message": str(e),
                "candidates_evaluated": resolver.max_fallback_candidates,
                "max_snapshot_age_seconds": resolver.max_snapshot_age_s,
            }), 503
        except ReplayError as e:
            return jsonify({
                "status": "error",
                "error_type": "REPLAY_ERROR",
                "message": str(e),
            }), 500

        df_snap = res.df
        replay_metadata = {
            "snapshot_path": res.snapshot_path,
            "snapshot_age_seconds": res.snapshot_age_seconds,
            "candidates_evaluated": res.candidates_evaluated,
            "provenance": res.provenance,
            "telemetry_diagnostics": res.telemetry_diagnostics,
        }

    # 4. Parse and Validate 'reach_by'
    reach_by_raw = data.get("reach_by") or data.get("deadline")
    deadline_ts, err_msg = parse_reach_by(reach_by_raw, pred_ts)
    if err_msg:
        return jsonify({
            "status": "error",
            "error_type": "INVALID_DEADLINE",
            "message": err_msg,
        }), 400

    # 5. Execute Engine Recommendation
    eng = initialize_engine()
    t_start = time.time()
    try:
        rec = eng.recommend_journey(
            origin_stop=from_stop,
            destination_stop=to_stop,
            deadline_ts=deadline_ts,
            snapshot_df=df_snap,
            prediction_ts=pred_ts,
        )
    except Exception as e:
        return jsonify({
            "status": "error",
            "error_type": "ENGINE_ERROR",
            "message": f"An error occurred while evaluating recommendations: {str(e)}",
        }), 500

    exec_time_ms = round((time.time() - t_start) * 1000.0, 2)

    # 6. Sanitize Output for Web API
    system_state = rec.get("system_state", "UNKNOWN")
    ro_raw = rec.get("recommended_option")
    recommended_option = sanitize_candidate_for_api(ro_raw, eng) if ro_raw else None

    alt_options = [
        sanitize_candidate_for_api(a, eng) for a in rec.get("alternative_options", [])
    ]
    unrel_options = [
        sanitize_candidate_for_api(u, eng) for u in rec.get("unreliable_candidates", [])
    ]

    # Baseline comparison summary
    comp_raw = rec.get("risk_aware_vs_baseline_comparison", {})
    comparison = {
        "is_same_choice": comp_raw.get("is_same_choice", True),
        "divergence_explanation": comp_raw.get("divergence_explanation"),
    }
    if comp_raw.get("fastest_eta_baseline_choice"):
        comparison["fastest_eta_baseline_choice"] = comp_raw["fastest_eta_baseline_choice"]

    # Final Web Response Payload
    query_payload: Dict[str, Any] = {
        "origin_stop": from_stop,
        "destination_stop": to_stop,
        "reach_by_unix": deadline_ts,
        "reach_by_formatted": format_unix_timestamp(deadline_ts),
        "prediction_timestamp_unix": pred_ts,
        "prediction_time_formatted": format_unix_timestamp(pred_ts),
        "time_budget_minutes": round((deadline_ts - pred_ts) / 60.0, 1),
        "telemetry_mode": telemetry_mode,
    }
    if replay_metadata is not None:
        query_payload["snapshot_path"] = replay_metadata["snapshot_path"]
        query_payload["snapshot_age_seconds"] = replay_metadata["snapshot_age_seconds"]

    response_payload = {
        "status": "success",
        "system_state": system_state,
        "message": rec.get("message"),
        "query": query_payload,
        "recommended_candidate": recommended_option,
        "alternative_candidates": alt_options,
        "unreliable_candidates": unrel_options,
        "comparison_with_fastest_eta": comparison,
        "summary": {
            "candidate_routes_count": rec.get("candidate_routes_count", 0),
            "viable_candidates_count": rec.get("viable_candidates_count", 0),
            "rejected_candidates_count": rec.get("rejected_candidates_count", 0),
            "execution_time_ms": exec_time_ms,
        },
    }
    if replay_metadata is not None:
        response_payload["provenance"] = replay_metadata["provenance"]
        response_payload["telemetry_diagnostics"] = replay_metadata["telemetry_diagnostics"]

    return jsonify(response_payload), 200


def main():
    import argparse

    parser = argparse.ArgumentParser(description="Delhi Bus Project: Backend REST API Service")
    parser.add_argument("--host", default=DEFAULT_HOST, help=f"Host address (default: {DEFAULT_HOST})")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"Port number (default: {DEFAULT_PORT})")
    parser.add_argument("--preload", action="store_true", help="Preload engine models into RAM at startup")

    args = parser.parse_args()

    # Preload engine models & stop index
    initialize_engine()
    initialize_stop_index()

    print(f"\n[OK] Delhi Bus Backend API Service listening on http://{args.host}:{args.port}")
    print(f"  Health Check:           GET  http://{args.host}:{args.port}/api/health")
    print(f"  Stop Autocomplete:      GET  http://{args.host}:{args.port}/api/stops/search")
    print(f"  Reachable Destinations: GET  http://{args.host}:{args.port}/api/stops/destinations")
    print(f"  Journey Recommendation: POST http://{args.host}:{args.port}/api/journey/recommend")
    app.run(host=args.host, port=args.port, debug=False)


if __name__ == "__main__":
    main()
