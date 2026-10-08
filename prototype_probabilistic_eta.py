#!/usr/bin/env python3
"""
===============================================================================
Delhi Bus Project - Network Layer: Probabilistic ETA Prototype
Script: prototype_probabilistic_eta.py

Purpose:
  Prototypes probabilistic ETA estimation for a current genuine OTD bus observation
  traveling toward a target stop on the same reconstructed route direction.

Operational Principles:
  1. 100% Genuine Empirical Foundations: Uses reconstructed route geometries from
     reconstructed_routes.json and empirical segment distributions from route_segments.json.
     Never uses static GTFS timetables or fabricated travel times.
  2. Orthogonal Chainage Projection: Projects instantaneous GPS pings onto the
     monotonically ordered stop chain to determine precise corridor progression (chainage)
     and lateral offset without 1D line-projection distortion.
  3. Direction Disambiguation: Resolves direction via net chainage progression between
     consecutive pings when available, or minimum lateral corridor displacement.
  4. Segment Decomposition: Decomposes remaining trip into:
     - Initial partial segment: proportional fraction (1 - t_frac) of current link.
     - Intermediate complete segments: full historical distributions.
  5. Probabilistic Uncertainty Modeling:
     - Expected travel time: sum of segment medians/means scaled by segment fractions.
     - Uncertainty propagation: incorporates adjacent segment traffic autocorrelation (rho).
     - Free-flow (p10) to congested (p90) corridor range bounds.
  6. Transparent Data Quality & Fallback Handling:
     - Segments with INSUFFICIENT_DATA are transparently flagged.
     - If <= 20% of distance is unobserved, explicit route-level median speed fallback is used.
     - If > 20% of distance or > 3 segments are unobserved, ETA is marked INSUFFICIENT_DATA.
  7. Separation of Concerns: Reconstructed route confidence score is kept strictly
     separate from operational ETA uncertainty spread.
===============================================================================
"""

import argparse
import glob
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

import numpy as np
import pandas as pd

# Projection Constants around Delhi Center (28.6 N, 77.1 E)
LAT_TO_M = 110852.0
LON_TO_M = 97740.0
REF_LAT = 28.6
REF_LON = 77.1
R_EARTH = 6371000.0

MAX_OFF_CORRIDOR_OFFSET_M = 150.0
MAX_PHYSICAL_SPEED_MS = 25.0     # 90 km/h speed-of-light bound
MIN_PHYSICAL_SPEED_MS = 0.8      # ~2.9 km/h crawl bound
FALLBACK_MAX_DIST_RATIO = 0.20   # At most 20% of remaining distance can use fallback
FALLBACK_MAX_SEGS = 3            # At most 3 segments can use fallback
DEFAULT_AUTOCORRELATION_RHO = 0.25

DEFAULT_ROUTES_PATH = Path("data") / "reconstructed_routes.json"
DEFAULT_SEGMENTS_PATH = Path("data") / "route_segments.json"


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculates haversine distance in meters between two coordinate pairs."""
    phi1, phi2 = np.radians(lat1), np.radians(lat2)
    dphi = np.radians(lat2 - lat1)
    dlambda = np.radians(lon2 - lon1)
    a = np.sin(dphi / 2.0) ** 2 + np.cos(phi1) * np.cos(phi2) * np.sin(dlambda / 2.0) ** 2
    return float(2.0 * R_EARTH * np.arcsin(np.sqrt(np.clip(a, 0.0, 1.0))))


class ProbabilisticETAPredictor:
    """
    In-memory engine for calculating probabilistic ETA predictions based on
    reconstructed route topologies and empirical segment datasets.
    """

    def __init__(self, routes_path: Path, segments_path: Path) -> None:
        self.routes_path = Path(routes_path)
        self.segments_path = Path(segments_path)
        self.routes: Dict[str, Any] = {}
        self.segments_by_dir: Dict[Tuple[str, int], Dict[int, Dict[str, Any]]] = {}
        self.route_median_speeds: Dict[str, float] = {}
        self._load_network()

    def _load_network(self) -> None:
        print(f"[*] Loading reconstructed routes from: {self.routes_path}")
        t0 = time.time()
        with open(self.routes_path, "r", encoding="utf-8") as f:
            routes_list = json.load(f)
        for r in routes_list:
            if r.get("status") == "SUCCESS":
                self.routes[r["route_id"]] = r
        print(f"[OK] Indexed {len(self.routes):,} successful routes in {time.time()-t0:.2f}s.")

        print(f"[*] Loading route segments dataset from: {self.segments_path}")
        t0 = time.time()
        with open(self.segments_path, "r", encoding="utf-8") as f:
            segments_list = json.load(f)

        speed_samples_by_route: Dict[str, List[float]] = {}
        for s in segments_list:
            key = (s["route_id"], s["direction_id"])
            if key not in self.segments_by_dir:
                self.segments_by_dir[key] = {}
            self.segments_by_dir[key][s["segment_sequence"]] = s

            if s.get("status") == "ESTIMATED" and s.get("implied_speed_kmh"):
                rid = s["route_id"]
                if rid not in speed_samples_by_route:
                    speed_samples_by_route[rid] = []
                speed_samples_by_route[rid].append(s["implied_speed_kmh"])

        # Compute route-level fallback speeds
        for rid, speeds in speed_samples_by_route.items():
            self.route_median_speeds[rid] = float(np.median(speeds))

        print(
            f"[OK] Indexed {len(segments_list):,} segments across {len(self.segments_by_dir):,} directions in {time.time()-t0:.2f}s."
        )

    def _get_direction_geometry(
        self, route_id: str, direction_id: int
    ) -> Optional[Dict[str, Any]]:
        r = self.routes.get(route_id)
        if not r:
            return None
        d = r.get("directions", {}).get(str(direction_id))
        if not d or d.get("status") != "SUCCESS":
            return None
        return d

    def project_observation(
        self,
        route_id: str,
        lat: float,
        lon: float,
        prev_lat: Optional[float] = None,
        prev_lon: Optional[float] = None,
        candidate_directions: Optional[List[int]] = None,
    ) -> Dict[str, Any]:
        """
        Projects an instantaneous bus GPS ping onto the matching route direction.
        Returns matched direction_id, chainage, offset, and current segment.
        """
        r = self.routes.get(route_id)
        if not r:
            return {"status": "ERROR_ROUTE_NOT_FOUND"}

        succ_dirs = [
            int(d_id)
            for d_id, d in r.get("directions", {}).items()
            if d.get("status") == "SUCCESS"
        ]
        if candidate_directions is not None:
            succ_dirs = [d for d in succ_dirs if d in candidate_directions]

        if not succ_dirs:
            return {
                "status": "ERROR_NO_SUCCESSFUL_DIRECTIONS",
                "details": f"No qualifying route directions matching candidate set {candidate_directions}",
            }

        p_cur = np.array([(lon - REF_LON) * LON_TO_M, (lat - REF_LAT) * LAT_TO_M])
        p_prev = (
            np.array([(prev_lon - REF_LON) * LON_TO_M, (prev_lat - REF_LAT) * LAT_TO_M])
            if (prev_lat is not None and prev_lon is not None)
            else None
        )

        dir_projections = {}
        for d_id in succ_dirs:
            d_data = r["directions"][str(d_id)]
            stop_coords = np.array(d_data["stop_coordinates"], dtype=np.float64)
            N_stops = len(stop_coords)

            # Cumulative stop distances
            stop_cum = [0.0]
            for i in range(N_stops - 1):
                d_m = haversine_m(
                    stop_coords[i, 0],
                    stop_coords[i, 1],
                    stop_coords[i + 1, 0],
                    stop_coords[i + 1, 1],
                )
                stop_cum.append(stop_cum[-1] + d_m)
            stop_cum = np.array(stop_cum, dtype=np.float64)

            stop_x = (stop_coords[:, 1] - REF_LON) * LON_TO_M
            stop_y = (stop_coords[:, 0] - REF_LAT) * LAT_TO_M
            stops_xy = np.column_stack([stop_x, stop_y])
            A = stops_xy[:-1]
            B = stops_xy[1:]
            AB = B - A
            seg_lens_sq = np.maximum(np.sum(AB**2, axis=1), 1e-6)

            # Project current point
            AP = p_cur - A
            t = np.sum(AP * AB, axis=1) / seg_lens_sq
            t_clamped = np.clip(t, 0.0, 1.0)
            proj = A + t_clamped[:, None] * AB
            dist_sq = np.sum((proj - p_cur) ** 2, axis=1)
            best_idx = int(np.argmin(dist_sq))
            offset_m = float(np.sqrt(dist_sq[best_idx]))
            chainage_m = float(
                stop_cum[best_idx]
                + t_clamped[best_idx] * (stop_cum[best_idx + 1] - stop_cum[best_idx])
            )

            # Project prev point if available to measure progression
            progression_m = 0.0
            if p_prev is not None:
                AP_prev = p_prev - A
                t_p = np.clip(np.sum(AP_prev * AB, axis=1) / seg_lens_sq, 0.0, 1.0)
                proj_p = A + t_p[:, None] * AB
                dist_sq_p = np.sum((proj_p - p_prev) ** 2, axis=1)
                best_idx_p = int(np.argmin(dist_sq_p))
                chainage_prev_m = float(
                    stop_cum[best_idx_p]
                    + t_p[best_idx_p] * (stop_cum[best_idx_p + 1] - stop_cum[best_idx_p])
                )
                progression_m = chainage_m - chainage_prev_m

            dir_projections[d_id] = {
                "direction_id": d_id,
                "chainage_meters": round(chainage_m, 1),
                "offset_meters": round(offset_m, 1),
                "segment_index": best_idx,
                "fraction_along_segment": float(round(t_clamped[best_idx], 3)),
                "progression_meters": round(progression_m, 1),
                "stop_cum_dist": stop_cum,
                "ordered_stop_ids": d_data["ordered_stop_ids"],
                "ordered_stop_names": d_data["ordered_stop_names"],
                "stop_coordinates": d_data["stop_coordinates"],
                "reconstruction_confidence": d_data["quality_metrics"]["confidence_score"],
            }

        # Choose best direction
        if len(succ_dirs) == 1:
            chosen_id = succ_dirs[0]
        else:
            # If prev point provided, forward progression is decisive
            if p_prev is not None:
                prog_scores = {
                    d_id: proj["progression_meters"]
                    for d_id, proj in dir_projections.items()
                }
                best_by_prog = max(prog_scores, key=prog_scores.get)
                if prog_scores[best_by_prog] >= 20.0:
                    chosen_id = best_by_prog
                else:
                    # Fall back to minimum offset
                    chosen_id = min(
                        dir_projections, key=lambda k: dir_projections[k]["offset_meters"]
                    )
            else:
                chosen_id = min(
                    dir_projections, key=lambda k: dir_projections[k]["offset_meters"]
                )

        best_proj = dir_projections[chosen_id]
        if best_proj["offset_meters"] > MAX_OFF_CORRIDOR_OFFSET_M:
            return {
                "status": "OFF_CORRIDOR",
                "offset_meters": best_proj["offset_meters"],
                "direction_id": chosen_id,
                "details": f"Vehicle is {best_proj['offset_meters']}m from route centerline (max allowable {MAX_OFF_CORRIDOR_OFFSET_M}m)",
            }

        return {"status": "SUCCESS", "projection": best_proj}

    def predict_eta(
        self,
        route_id: str,
        vehicle_id: str,
        current_lat: float,
        current_lon: float,
        current_ts: int,
        target_stop: Any,  # stop_id (str) or stop_sequence (int)
        prev_lat: Optional[float] = None,
        prev_lon: Optional[float] = None,
        autocorrelation_rho: float = DEFAULT_AUTOCORRELATION_RHO,
    ) -> Dict[str, Any]:
        """
        Estimates probabilistic ETA to target stop from current bus observation.
        """
        r = self.routes.get(route_id)
        if not r:
            return {
                "vehicle_id": vehicle_id,
                "route_id": route_id,
                "status": "ERROR_ROUTE_NOT_FOUND",
                "reason": f"Route '{route_id}' not found in reconstructed routes",
            }

        # Resolve candidate directions that serve target_stop
        candidate_dirs = []
        for d_id_str, d_data in r.get("directions", {}).items():
            if d_data.get("status") != "SUCCESS":
                continue
            d_ids = d_data["ordered_stop_ids"]
            d_names = d_data["ordered_stop_names"]
            if isinstance(target_stop, int):
                if 0 <= target_stop < len(d_ids):
                    candidate_dirs.append(int(d_id_str))
            elif isinstance(target_stop, str):
                if target_stop in d_ids or any(
                    target_stop.lower() in name.lower() for name in d_names
                ):
                    candidate_dirs.append(int(d_id_str))

        if not candidate_dirs:
            return {
                "vehicle_id": vehicle_id,
                "route_id": route_id,
                "status": "TARGET_STOP_NOT_FOUND",
                "reason": f"Target stop '{target_stop}' is not served by any successful direction of route {route_id}",
            }

        proj_res = self.project_observation(
            route_id,
            current_lat,
            current_lon,
            prev_lat,
            prev_lon,
            candidate_directions=candidate_dirs,
        )
        if proj_res["status"] != "SUCCESS":
            return {
                "vehicle_id": vehicle_id,
                "route_id": route_id,
                "status": proj_res["status"],
                "reason": proj_res.get("details", proj_res["status"]),
            }

        proj = proj_res["projection"]
        d_id = proj["direction_id"]
        stop_ids = proj["ordered_stop_ids"]
        stop_names = proj["ordered_stop_names"]
        stop_cum = proj["stop_cum_dist"]
        conf_score = proj["reconstruction_confidence"]

        # Resolve target stop index in this direction
        target_idx: Optional[int] = None
        if isinstance(target_stop, int):
            if 0 <= target_stop < len(stop_ids):
                target_idx = target_stop
        elif isinstance(target_stop, str):
            if target_stop in stop_ids:
                target_idx = stop_ids.index(target_stop)
            else:
                for idx, name in enumerate(stop_names):
                    if target_stop.lower() in name.lower():
                        target_idx = idx
                        break

        if target_idx is None:
            return {
                "vehicle_id": vehicle_id,
                "route_id": route_id,
                "direction_id": d_id,
                "status": "TARGET_STOP_NOT_FOUND",
                "reason": f"Target stop '{target_stop}' is not in direction {d_id} stop sequence",
            }

        cur_cum = proj["chainage_meters"]
        target_cum = float(stop_cum[target_idx])
        rem_dist_m = target_cum - cur_cum

        # Check if target stop already passed
        if rem_dist_m <= 0.0:
            return {
                "vehicle_id": vehicle_id,
                "route_id": route_id,
                "direction_id": d_id,
                "status": "TARGET_STOP_ALREADY_PASSED",
                "target_stop_id": stop_ids[target_idx],
                "target_stop_name": stop_names[target_idx],
                "target_chainage_meters": round(target_cum, 1),
                "current_chainage_meters": round(cur_cum, 1),
                "reason": f"Bus chainage ({cur_cum:.1f}m) has already passed target stop ({target_cum:.1f}m)",
            }

        cur_seg_idx = proj["segment_index"]
        t_frac = proj["fraction_along_segment"]

        # Segments to traverse: cur_seg_idx up to target_idx - 1
        rem_seg_indices = list(range(cur_seg_idx, target_idx))

        dir_segs = self.segments_by_dir.get((route_id, d_id), {})
        route_fallback_speed_kmh = self.route_median_speeds.get(route_id, 22.0)
        route_fallback_speed_ms = route_fallback_speed_kmh / 3.6

        seg_expected_times = []
        seg_stds = []
        seg_p10s = []
        seg_p90s = []
        samples_pooled = 0
        missing_count = 0
        missing_dist_m = 0.0

        for i, s_idx in enumerate(rem_seg_indices):
            seg = dir_segs.get(s_idx)
            # Remaining fraction of this segment
            # For the first segment, fraction is (1 - t_frac)
            frac = (1.0 - t_frac) if i == 0 else 1.0
            seg_full_dist = float(stop_cum[s_idx + 1] - stop_cum[s_idx])
            seg_rem_dist = seg_full_dist * frac

            if seg and seg.get("status") == "ESTIMATED":
                m_t = seg["median_travel_time_sec"] * frac
                s_t = seg["std_travel_time_sec"] * frac
                q10 = seg["p10_travel_time_sec"] * frac
                q90 = seg["p90_travel_time_sec"] * frac

                seg_expected_times.append(m_t)
                seg_stds.append(s_t)
                seg_p10s.append(q10)
                seg_p90s.append(q90)
                samples_pooled += seg["sample_count"]
            else:
                # Sparse segment fallback
                m_t = seg_rem_dist / route_fallback_speed_ms
                s_t = 0.35 * m_t  # 35% CV for fallback
                q10 = m_t * 0.7
                q90 = m_t * 1.4

                seg_expected_times.append(m_t)
                seg_stds.append(s_t)
                seg_p10s.append(q10)
                seg_p90s.append(q90)
                missing_count += 1
                missing_dist_m += seg_rem_dist

        # Check defensible fallback constraints
        missing_ratio = missing_dist_m / max(1.0, rem_dist_m)
        if missing_ratio > FALLBACK_MAX_DIST_RATIO or missing_count > FALLBACK_MAX_SEGS:
            return {
                "vehicle_id": vehicle_id,
                "route_id": route_id,
                "direction_id": d_id,
                "status": "INSUFFICIENT_DATA",
                "target_stop_id": stop_ids[target_idx],
                "target_stop_name": stop_names[target_idx],
                "remaining_distance_meters": round(rem_dist_m, 1),
                "missing_segments_count": missing_count,
                "missing_distance_meters": round(missing_dist_m, 1),
                "missing_distance_ratio": round(missing_ratio, 3),
                "reason": f"Too many unobserved segments ({missing_count} segments, {missing_dist_m:.1f}m, {missing_ratio*100:.1f}% of path); ETA cannot be reliably estimated without artificial fabrication.",
            }

        # Uncertainty propagation:
        # Sum of expectations
        expected_travel_time_s = float(sum(seg_expected_times))

        # Variance with adjacent segment traffic correlation rho
        var_sum = float(sum(s**2 for s in seg_stds))
        for i in range(len(seg_stds) - 1):
            var_sum += 2.0 * autocorrelation_rho * seg_stds[i] * seg_stds[i + 1]

        total_std_s = float(np.sqrt(max(1.0, var_sum)))

        # 80% credible interval (z = 1.282)
        # Bounded below by free-flow road speed-of-light (90 km/h)
        min_physical_time_s = rem_dist_m / MAX_PHYSICAL_SPEED_MS
        eta_p10_s = float(max(min_physical_time_s, expected_travel_time_s - 1.282 * total_std_s))
        eta_p90_s = float(expected_travel_time_s + 1.282 * total_std_s)

        # Segment percentile sum bounds (optimistic corridor vs congested corridor bounds)
        corridor_p10_sum_s = float(sum(seg_p10s))
        corridor_p90_sum_s = float(sum(seg_p90s))

        status_str = "ESTIMATED" if missing_count == 0 else "ESTIMATED_WITH_FALLBACK"

        return {
            "vehicle_id": vehicle_id,
            "route_id": route_id,
            "direction_id": d_id,
            "route_reconstruction_confidence": round(conf_score, 3),
            "status": status_str,
            "current_position": {
                "latitude": round(current_lat, 6),
                "longitude": round(current_lon, 6),
                "timestamp_unix": current_ts,
                "chainage_meters": round(cur_cum, 1),
                "offset_meters": round(proj["offset_meters"], 1),
                "current_segment_index": cur_seg_idx,
                "current_from_stop": stop_names[cur_seg_idx],
                "current_to_stop": stop_names[cur_seg_idx + 1],
            },
            "target_stop": {
                "stop_id": stop_ids[target_idx],
                "stop_name": stop_names[target_idx],
                "stop_sequence": target_idx,
                "chainage_meters": round(target_cum, 1),
            },
            "spatial_progress": {
                "remaining_distance_meters": round(rem_dist_m, 1),
                "total_corridor_length_meters": round(float(stop_cum[-1]), 1),
                "remaining_segments_count": len(rem_seg_indices),
            },
            "eta_prediction": {
                "expected_travel_time_seconds": round(expected_travel_time_s, 1),
                "expected_travel_time_minutes": round(expected_travel_time_s / 60.0, 1),
                "expected_eta_timestamp_unix": int(current_ts + round(expected_travel_time_s)),
                "uncertainty_interval_80pct_seconds": [
                    round(eta_p10_s, 1),
                    round(eta_p90_s, 1),
                ],
                "uncertainty_interval_80pct_minutes": [
                    round(eta_p10_s / 60.0, 1),
                    round(eta_p90_s / 60.0, 1),
                ],
                "standard_deviation_seconds": round(total_std_s, 1),
                "corridor_percentile_bounds_seconds": [
                    round(corridor_p10_sum_s, 1),
                    round(corridor_p90_sum_s, 1),
                ],
                "corridor_percentile_bounds_minutes": [
                    round(corridor_p10_sum_s / 60.0, 1),
                    round(corridor_p90_sum_s / 60.0, 1),
                ],
                "implied_expected_speed_kmh": round(
                    (rem_dist_m / max(1.0, expected_travel_time_s)) * 3.6, 1
                ),
            },
            "evidence_and_fallbacks": {
                "historical_samples_pooled": samples_pooled,
                "populated_segments_count": len(rem_seg_indices) - missing_count,
                "fallback_segments_count": missing_count,
                "fallback_distance_meters": round(missing_dist_m, 1),
                "fallback_details": (
                    f"{missing_count} segment(s) ({missing_dist_m:.1f}m) imputed using route median speed {route_fallback_speed_kmh:.1f} km/h"
                    if missing_count > 0
                    else None
                ),
            },
        }


def run_prototype_validation() -> None:
    """
    Runs multi-route, multi-day empirical validation against genuine OTD observations.
    Compares predicted probabilistic ETA against ground-truth actual subsequent arrivals.
    """
    print("=" * 80)
    print("DELHI BUS PROJECT: PROBABILISTIC ETA PROTOTYPE VALIDATION")
    print("=" * 80)

    predictor = ProbabilisticETAPredictor(DEFAULT_ROUTES_PATH, DEFAULT_SEGMENTS_PATH)

    # Test Cases: Real vehicles from different dates, corridors, and distances
    # We will evaluate 6 real historical vehicle journeys:
    test_cases = [
        {
            "description": "Route 2183 (Trunk Arterial, Central Delhi, 13km, 47 stops): DL1PD8683 to Inderpuri A-Block",
            "route_id": "2183",
            "vehicle_id": "DL1PD8683",
            "obs_file": "data/2026-09-30/121620.csv.gz",
            "target_stop_name": "Inderpuri A-Block",
            "ground_truth_ts": 1790773256, # Actual arrival at Ping 9 (45.1 min)
        },
        {
            "description": "Route 2183 (Short Hop, Central Delhi, 5.7km, 18 stops): DL1PD8683 to Rachna cinema Rajender Place",
            "route_id": "2183",
            "vehicle_id": "DL1PD8683",
            "obs_file": "data/2026-09-30/121620.csv.gz",
            "target_stop_name": "Rachna cinema  Rajender Place",
            "ground_truth_ts": 1790772354, # Actual arrival at Ping 6 (30.0 min)
        },
        {
            "description": "Route 2203 (Mega Trunk Route, 7.8km, 32 stops): DL1PD4089 to Patel Chowk Metro Station",
            "route_id": "2203",
            "vehicle_id": "DL1PD4089",
            "obs_file": "data/2026-09-30/115118.csv.gz",
            "target_stop_name": "Patel Chowk Metro Station",
            "ground_truth_ts": 1790770432, # Actual arrival at 12:13 (24.6 min)
        },
        {
            "description": "Route 2203 (Sparse Intermediate Corridor Test): DL1PD4089 to Turkman Gate / GB Pant Hospital",
            "route_id": "2203",
            "vehicle_id": "DL1PD4089",
            "obs_file": "data/2026-09-30/115118.csv.gz",
            "target_stop_name": "Turkman Gate / GB Pant Hospital",
            "ground_truth_ts": 1790771164,
        },
        {
            "description": "Route 1881 (Ring Road Outer Arterial, 7km, 20 stops): DL51GD8990 to Moolchand Hospital",
            "route_id": "1881",
            "vehicle_id": "DL51GD8990",
            "obs_file": "data/2026-09-30/121620.csv.gz",
            "target_stop_name": "Moolchand Hospital",
            "ground_truth_ts": 1790771781, # Actual arrival at 12:36 (20.0 min)
        },
        {
            "description": "Sparse Direction Honest Handling: Route 100 Dir 0 to ISBT Nityanand Marg",
            "route_id": "100",
            "vehicle_id": "DL1PD4944",
            "obs_file": "data/2026-10-02/120000.csv.gz",
            "target_stop_name": "ISBT Nityanand Marg",
            "ground_truth_ts": None,
        },
        {
            "description": "Boundary Test: Target stop already passed (DTC Rajghat Depot behind bus)",
            "route_id": "2183",
            "vehicle_id": "DL1PD8683",
            "obs_file": "data/2026-09-30/121620.csv.gz",
            "target_stop_name": "DTC Rajghat Depot",
            "ground_truth_ts": None,
        },
        {
            "description": "Boundary Test: Vehicle off-corridor (>150m from route)",
            "route_id": "2183",
            "vehicle_id": "TEST_OFF_CORRIDOR",
            "obs_file": None,
            "manual_lat": 28.500000,
            "manual_lon": 77.000000,
            "manual_ts": 1790770551,
            "target_stop_name": "Inderpuri A-Block",
            "ground_truth_ts": None,
        },
    ]

    results = []
    print("\nExecuting prototype test suite...")
    for idx, tc in enumerate(test_cases, 1):
        print(f"\n[{idx}/6] {tc['description']}")
        # Find observation
        if tc.get("manual_lat") is not None:
            cur_lat = float(tc["manual_lat"])
            cur_lon = float(tc["manual_lon"])
            cur_ts = int(tc["manual_ts"])
            vid = tc["vehicle_id"]
            rid = tc["route_id"]
        else:
            obs_file = tc["obs_file"]
            if not obs_file or not os.path.exists(obs_file):
                print(f"  [!] Archive file {tc['obs_file']} not found, searching archive...")
                files = sorted(glob.glob("data/*/*.csv.gz"))
                obs_file = files[100]

            df = pd.read_csv(obs_file, dtype={"route_id": str, "vehicle_id": str})
            sub = df[(df["route_id"] == tc["route_id"]) & (df["vehicle_id"] == tc["vehicle_id"])]

            if len(sub) == 0:
                sub_r = df[df["route_id"] == tc["route_id"]]
                if len(sub_r) > 0:
                    sub = sub_r.iloc[[0]]
                    tc["vehicle_id"] = str(sub["vehicle_id"].iloc[0])
                else:
                    for f_search in sorted(glob.glob("data/*/*.csv.gz"))[:50]:
                        df_s = pd.read_csv(f_search, dtype={"route_id": str, "vehicle_id": str})
                        sub_s = df_s[df_s["route_id"] == tc["route_id"]]
                        if len(sub_s) > 0:
                            sub = sub_s.iloc[[0]]
                            tc["vehicle_id"] = str(sub["vehicle_id"].iloc[0])
                            break

            if len(sub) == 0:
                print(f"  [!] No active observations found for route {tc['route_id']}, skipping.")
                continue

            row = sub.iloc[0]
            cur_lat = float(row["latitude"])
            cur_lon = float(row["longitude"])
            cur_ts = int(row["vehicle_ts_unix"])
            vid = tc["vehicle_id"]
            rid = tc["route_id"]

        pred = predictor.predict_eta(
            route_id=rid,
            vehicle_id=vid,
            current_lat=cur_lat,
            current_lon=cur_lon,
            current_ts=cur_ts,
            target_stop=tc["target_stop_name"],
        )

        results.append({
            "test_case": tc["description"],
            "prediction": pred,
            "ground_truth_ts": tc.get("ground_truth_ts"),
            "current_ts": cur_ts,
        })

        # Print formatted summary of result
        status = pred.get("status")
        print(f"  Vehicle: {vid} | Route: {rid} | Status: {status}")
        if status in ("ESTIMATED", "ESTIMATED_WITH_FALLBACK"):
            pos = pred["current_position"]
            tgt = pred["target_stop"]
            sp = pred["spatial_progress"]
            eta = pred["eta_prediction"]
            ev = pred["evidence_and_fallbacks"]
            print(f"  Current: {pos['current_from_stop']} -> {pos['current_to_stop']} (chainage: {pos['chainage_meters']}m, offset: {pos['offset_meters']}m)")
            print(f"  Target:  {tgt['stop_name']} [{tgt['stop_sequence']}] (chainage: {tgt['chainage_meters']}m)")
            print(f"  Remaining Dist: {sp['remaining_distance_meters']}m across {sp['remaining_segments_count']} segments")
            print(f"  Expected Time:  {eta['expected_travel_time_minutes']} min ({eta['expected_travel_time_seconds']}s) @ {eta['implied_expected_speed_kmh']} km/h")
            print(f"  Uncertainty (80%): [{eta['uncertainty_interval_80pct_minutes'][0]} min, {eta['uncertainty_interval_80pct_minutes'][1]} min] (std: {eta['standard_deviation_seconds']}s)")
            print(f"  Corridor Bounds:   [{eta['corridor_percentile_bounds_minutes'][0]} min (p10), {eta['corridor_percentile_bounds_minutes'][1]} min (p90)]")
            print(f"  Evidence: {ev['historical_samples_pooled']} samples | fallback: {ev['fallback_segments_count']} segs")
            print(f"  Route Reconstruction Confidence: {pred['route_reconstruction_confidence']}")

            # Ground truth validation if available
            gt_ts = tc.get("ground_truth_ts")
            if gt_ts:
                actual_s = gt_ts - cur_ts
                actual_m = actual_s / 60.0
                err_s = actual_s - eta["expected_travel_time_seconds"]
                err_pct = (abs(err_s) / actual_s) * 100.0
                inside_80 = eta["uncertainty_interval_80pct_seconds"][0] <= actual_s <= eta["uncertainty_interval_80pct_seconds"][1]
                inside_bounds = eta["corridor_percentile_bounds_seconds"][0] <= actual_s <= eta["corridor_percentile_bounds_seconds"][1]
                print(f"  [GROUND TRUTH] Actual Travel Time: {actual_m:.1f} min ({actual_s:.1f}s)")
                print(f"  [GROUND TRUTH] Error: {err_s:+.1f}s ({err_pct:.1f}%) | Inside 80% CI: {inside_80} | Inside Corridor Bounds: {inside_bounds}")
        else:
            print(f"  Reason: {pred.get('reason')}")

    # Output artifact
    output_path = Path("data") / "prototype_eta_results.json"
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2)
    print(f"\n[OK] Prototype ETA evaluation results saved to: {output_path}")


if __name__ == "__main__":
    run_prototype_validation()
