
#!/usr/bin/env python3
"""
===============================================================================
Delhi Bus Project - Phase 1: Network Reconstruction (Archive Profiler)
Script: build_network.py

Purpose:
  Recursively discovers and reads all compressed CSV files (.csv.gz) in the
  archive directory (data/YYYY-MM-DD/HHMMSS.csv.gz), validates raw records
  against established Delhi/NCR geographic and schema bounds, aggregates
  route-level metrics in a memory-efficient streaming manner, and produces
  a comprehensive JSON profile report (data/network_build_profile.json).

Design & Operational Principles:
  1. Memory Efficiency: Files are processed file-by-file; the complete archive
     is never loaded into memory all at once.
  2. Geographic Bounds: Enforces Delhi/NCR bounds used across this project:
       Latitude  : [27.5, 29.8]
       Longitude : [76.0, 78.2]
  3. No Speed Calculation: The 'speed' column is never used for movement or
     travel calculation.
  4. Privacy & Security: No secrets, .env contents, or API credentials are
     read, printed, or exposed.
  5. Scope Limitation: This is strictly a profiling stage. No route geometry,
     GPS projection, 500m segmentation, ETA, UI, or database writes are done.
===============================================================================
"""

# =============================================================================
# SECTION 1: IMPORTS AND CONFIGURATION
# =============================================================================
import argparse
import collections
import gzip
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

import pandas as pd

# Project-standard Delhi / NCR bounding box coordinates
DELHI_NCR_MIN_LAT = 27.5
DELHI_NCR_MAX_LAT = 29.8
DELHI_NCR_MIN_LON = 76.0
DELHI_NCR_MAX_LON = 78.2

# Exact expected column schema for archive CSVs
REQUIRED_COLUMNS = [
    "fetched_at_iso",
    "vehicle_id",
    "trip_id",
    "route_id",
    "latitude",
    "longitude",
    "speed",
    "vehicle_ts_unix",
    "schedule_relationship",
]

# Default filesystem paths
DEFAULT_ARCHIVE_DIR = Path("data")
DEFAULT_OUTPUT_JSON = Path("data") / "network_build_profile.json"


# =============================================================================
# SECTION 2: DATA VALIDATION HELPERS
# =============================================================================
def validate_archive_columns(df: pd.DataFrame, file_path: Path) -> Tuple[bool, List[str]]:
    """
    Validates that the DataFrame contains all required columns.

    Args:
        df: DataFrame parsed from an archive CSV.
        file_path: Source Path for diagnostic context.

    Returns:
        (is_valid, missing_columns)
    """
    missing = [col for col in REQUIRED_COLUMNS if col not in df.columns]
    if missing:
        return False, missing
    return True, []


def extract_archive_day(file_path: Path, df: pd.DataFrame) -> str:
    """
    Determines the archive day (YYYY-MM-DD) for a given archive file.
    Prefers the parent directory name when matching YYYY-MM-DD format,
    falling back to timestamps in 'fetched_at_iso' if needed.

    Args:
        file_path: Path to the .csv.gz file.
        df: DataFrame containing the file's data.

    Returns:
        Date string in 'YYYY-MM-DD' format.
    """
    # Standard project layout: data/YYYY-MM-DD/HHMMSS.csv.gz
    parent_name = file_path.parent.name
    if re.match(r"^\d{4}-\d{2}-\d{2}$", parent_name):
        return parent_name

    # Fallback to inspecting 'fetched_at_iso' values
    if "fetched_at_iso" in df.columns:
        valid_iso = df["fetched_at_iso"].dropna()
        if len(valid_iso) > 0:
            first_val = str(valid_iso.iloc[0]).strip()
            if len(first_val) >= 10 and re.match(r"^\d{4}-\d{2}-\d{2}$", first_val[:10]):
                return first_val[:10]

    return parent_name


# =============================================================================
# SECTION 3: ARCHIVE FILE DISCOVERY
# =============================================================================
def discover_archive_files(archive_dir: Path) -> List[Path]:
    """
    Recursively discovers all .csv.gz files under the archive directory.
    Results are sorted deterministically by parent directory and filename.

    Args:
        archive_dir: Path to root archive directory (e.g. data/)

    Returns:
        Sorted list of Path objects for all matching archive files.
    """
    if not archive_dir.exists() or not archive_dir.is_dir():
        return []

    # Recursively find all *.csv.gz files
    files = [
        p for p in archive_dir.rglob("*.csv.gz")
        if p.is_file() and not p.name.startswith(".")
    ]

    # Sort files chronologically: parent folder (YYYY-MM-DD) then filename (HHMMSS.csv.gz)
    files.sort(key=lambda p: (p.parent.name, p.name))
    return files


# =============================================================================
# SECTION 4: STREAMING FILE-BY-FILE ARCHIVE ACCUMULATOR
# =============================================================================
class RouteDataAccumulator:
    """
    Accumulates streaming metrics for a specific route across multiple archive files.
    Maintains compact in-memory state (sets and bounds) to profile routes without
    retaining raw telemetry rows in memory.
    """
    __slots__ = (
        "route_id",
        "observations",
        "unique_vehicles",
        "unique_trip_ids",
        "archive_days",
        "daily_observations",
        "min_latitude",
        "max_latitude",
        "min_longitude",
        "max_longitude",
    )

    def __init__(self, route_id: str):
        self.route_id = route_id
        self.observations = 0
        self.unique_vehicles: Set[str] = set()
        self.unique_trip_ids: Set[str] = set()
        self.archive_days: Set[str] = set()
        self.daily_observations: Dict[str, int] = collections.defaultdict(int)
        self.min_latitude = float("inf")
        self.max_latitude = float("-inf")
        self.min_longitude = float("inf")
        self.max_longitude = float("-inf")

    def update(
        self,
        archive_day: str,
        count: int,
        min_lat: float,
        max_lat: float,
        min_lon: float,
        max_lon: float,
        vehicles: Set[str],
        trips: Set[str],
    ) -> None:
        """Updates route profile metrics with a batch of observations from one file."""
        self.observations += count
        self.archive_days.add(archive_day)
        self.daily_observations[archive_day] += count

        if min_lat < self.min_latitude:
            self.min_latitude = min_lat
        if max_lat > self.max_latitude:
            self.max_latitude = max_lat

        if min_lon < self.min_longitude:
            self.min_longitude = min_lon
        if max_lon > self.max_longitude:
            self.max_longitude = max_lon

        if vehicles:
            self.unique_vehicles.update(vehicles)
        if trips:
            self.unique_trip_ids.update(trips)

    def to_dict(self) -> Dict[str, Any]:
        """Converts accumulated metrics into JSON-serializable dictionary."""
        return {
            "route_id": self.route_id,
            "observations": self.observations,
            "unique_vehicles": len(self.unique_vehicles),
            "unique_trip_ids": len(self.unique_trip_ids),
            "archive_days": len(self.archive_days),
            "archive_days_count": len(self.archive_days),
            "min_latitude": round(float(self.min_latitude), 6) if self.min_latitude != float("inf") else None,
            "max_latitude": round(float(self.max_latitude), 6) if self.max_latitude != float("-inf") else None,
            "min_longitude": round(float(self.min_longitude), 6) if self.min_longitude != float("inf") else None,
            "max_longitude": round(float(self.max_longitude), 6) if self.max_longitude != float("-inf") else None,
            "observations_per_day": dict(sorted(self.daily_observations.items())),
            "daily_observations": dict(sorted(self.daily_observations.items())),
        }


def process_archive_file(
    file_path: Path,
    routes_registry: Dict[str, RouteDataAccumulator],
    global_vehicles: Set[str],
    global_trips: Set[str],
    global_archive_days: Set[str],
) -> Tuple[int, int, int]:
    """
    Processes a single compressed CSV archive file.
    Validates required columns, applies geographic and timestamp bounds,
    and updates both route-level and global accumulators.

    Returns:
        (rows_read, valid_rows, invalid_rows)
    """
    try:
        # Read with dtype=str to maintain exact route and vehicle identifiers
        df = pd.read_csv(
            file_path,
            compression="gzip",
            dtype=str,
            low_memory=False,
        )
    except pd.errors.EmptyDataError:
        # Handle zero-byte or header-only empty files gracefully
        return 0, 0, 0
    except (gzip.BadGzipFile, EOFError, OSError) as read_err:
        print(f"[WARN] Skipping corrupted file {file_path.name}: {read_err}", file=sys.stderr)
        return 0, 0, 0

    rows_in_file = len(df)
    if rows_in_file == 0:
        return 0, 0, 0

    # 1. Validate required column schema
    columns_valid, missing_cols = validate_archive_columns(df, file_path)
    if not columns_valid:
        print(
            f"[WARN] File {file_path.name} missing required columns: {missing_cols}. Marking rows invalid.",
            file=sys.stderr,
        )
        return rows_in_file, 0, rows_in_file

    archive_day = extract_archive_day(file_path, df)
    global_archive_days.add(archive_day)

    # 2. Extract and validate required attributes
    # Note: Speed column is explicitly IGNORED and not used for any calculations.
    lat_num = pd.to_numeric(df["latitude"], errors="coerce")
    lon_num = pd.to_numeric(df["longitude"], errors="coerce")
    ts_num = pd.to_numeric(df["vehicle_ts_unix"], errors="coerce")

    # Route ID validation: present, non-empty, and not literal string representations of null
    route_raw = df["route_id"].astype(str).str.strip()
    valid_route = (
        df["route_id"].notna()
        & (route_raw != "")
        & (~route_raw.str.lower().isin(["nan", "none", "null", "undefined"]))
    )

    # Coordinate validation: numeric and strictly within project Delhi/NCR bounding box
    valid_coords = (
        lat_num.notna()
        & lon_num.notna()
        & (lat_num >= DELHI_NCR_MIN_LAT)
        & (lat_num <= DELHI_NCR_MAX_LAT)
        & (lon_num >= DELHI_NCR_MIN_LON)
        & (lon_num <= DELHI_NCR_MAX_LON)
    )

    # Timestamp validation: numeric, positive integer Unix timestamp
    valid_ts = ts_num.notna() & (ts_num > 0)

    # Combined validation mask according to project rules
    valid_mask = valid_route & valid_coords & valid_ts
    valid_count = int(valid_mask.sum())
    invalid_count = rows_in_file - valid_count

    if valid_count == 0:
        return rows_in_file, 0, invalid_count

    # 3. Filter valid rows into a concise DataFrame for route-level aggregation
    valid_df = pd.DataFrame({
        "route_id": route_raw[valid_mask],
        "latitude": lat_num[valid_mask],
        "longitude": lon_num[valid_mask],
        "vehicle_id": df["vehicle_id"][valid_mask],
        "trip_id": df["trip_id"][valid_mask],
    })

    # Group valid observations by route_id
    grouped = valid_df.groupby("route_id", sort=False)
    summary_stats = grouped.agg(
        obs=("latitude", "count"),
        min_lat=("latitude", "min"),
        max_lat=("latitude", "max"),
        min_lon=("longitude", "min"),
        max_lon=("longitude", "max"),
    )

    # Extract distinct non-empty vehicle_id and trip_id pairs per route
    v_pairs = valid_df[["route_id", "vehicle_id"]].dropna().drop_duplicates()
    t_pairs = valid_df[["route_id", "trip_id"]].dropna().drop_duplicates()

    # Pre-aggregate vehicle and trip sets per route for fast iteration
    route_vehicles: Dict[str, Set[str]] = collections.defaultdict(set)
    for rid, vid in zip(v_pairs["route_id"], v_pairs["vehicle_id"]):
        clean_vid = str(vid).strip()
        if clean_vid and clean_vid.lower() not in ("nan", "none", "null"):
            route_vehicles[rid].add(clean_vid)
            global_vehicles.add(clean_vid)

    route_trips: Dict[str, Set[str]] = collections.defaultdict(set)
    for rid, tid in zip(t_pairs["route_id"], t_pairs["trip_id"]):
        clean_tid = str(tid).strip()
        if clean_tid and clean_tid.lower() not in ("nan", "none", "null"):
            route_trips[rid].add(clean_tid)
            global_trips.add(clean_tid)

    # Update route accumulators using itertuples for high performance
    for stat_row in summary_stats.itertuples():
        rid = str(stat_row.Index)
        if rid not in routes_registry:
            routes_registry[rid] = RouteDataAccumulator(rid)

        routes_registry[rid].update(
            archive_day=archive_day,
            count=int(stat_row.obs),
            min_lat=float(stat_row.min_lat),
            max_lat=float(stat_row.max_lat),
            min_lon=float(stat_row.min_lon),
            max_lon=float(stat_row.max_lon),
            vehicles=route_vehicles.get(rid, set()),
            trips=route_trips.get(rid, set()),
        )

    return rows_in_file, valid_count, invalid_count


# =============================================================================
# SECTION 5: PROFILE AGGREGATION & REPORT GENERATION
# =============================================================================
def compile_profile_report(
    files_processed: int,
    total_rows_read: int,
    total_valid_rows: int,
    total_invalid_rows: int,
    routes_registry: Dict[str, RouteDataAccumulator],
    global_vehicles: Set[str],
    global_trips: Set[str],
    global_archive_days: Set[str],
) -> Dict[str, Any]:
    """
    Compiles summary statistics and detailed route profiles.
    Routes are sorted strictly by observation count descending.
    """
    # Convert route accumulators to dictionaries
    route_profiles = [acc.to_dict() for acc in routes_registry.values()]

    # Sort routes by observation count descending, with secondary tie-break on route_id
    route_profiles.sort(key=lambda r: (-r["observations"], str(r["route_id"])))

    sorted_days = sorted(list(global_archive_days))

    # Top-level summary dictionary
    summary_data = {
        "files_processed": files_processed,
        "rows_read": total_rows_read,
        "valid_rows": total_valid_rows,
        "invalid_rows": total_invalid_rows,
        "unique_routes": len(route_profiles),
        "unique_vehicles": len(global_vehicles),
        "unique_trip_ids": len(global_trips),
        "archive_days": len(sorted_days),
        "archive_days_count": len(sorted_days),
        "archive_days_list": sorted_days,
    }

    # Assembled complete profile report
    report = {
        "summary": summary_data,
        # Direct top-level fields for downstream convenience
        "files_processed": files_processed,
        "rows_read": total_rows_read,
        "valid_rows": total_valid_rows,
        "invalid_rows": total_invalid_rows,
        "unique_routes": len(route_profiles),
        "unique_vehicles": len(global_vehicles),
        "unique_trip_ids": len(global_trips),
        "archive_days": len(sorted_days),
        "archive_days_count": len(sorted_days),
        "archive_days_list": sorted_days,
        "routes": route_profiles,
    }

    return report


def save_profile_report(report: Dict[str, Any], output_path: Path) -> None:
    """
    Safely writes the profile report JSON to the specified destination.
    Creates parent directories if necessary.
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)


# =============================================================================
# SECTION 6: SAFE TERMINAL OUTPUT FORMATTER
# =============================================================================
def print_safe_summary(report: Dict[str, Any], output_path: Path, elapsed_sec: float) -> None:
    """
    Prints clean, safe summary metrics to stdout.
    Strictly avoids printing API URLs, authentication keys, passwords,
    or internal environment variable configurations.
    """
    summary = report["summary"]
    routes = report["routes"]

    print("\n" + "=" * 72)
    print("        DELHI BUS PROJECT - NETWORK BUILD PROFILE (PHASE 1)")
    print("=" * 72)
    print(f"Archive Files Processed : {summary['files_processed']:,}")
    print(f"Total Rows Read         : {summary['rows_read']:,}")
    valid_pct = (summary['valid_rows'] / summary['rows_read'] * 100.0) if summary['rows_read'] > 0 else 0.0
    invalid_pct = (summary['invalid_rows'] / summary['rows_read'] * 100.0) if summary['rows_read'] > 0 else 0.0
    print(f"Valid Rows              : {summary['valid_rows']:,} ({valid_pct:.2f}%)")
    print(f"Invalid Rows            : {summary['invalid_rows']:,} ({invalid_pct:.2f}%)")
    print("-" * 72)
    print(f"Unique Routes Identified: {summary['unique_routes']:,}")
    print(f"Unique Vehicles Observed: {summary['unique_vehicles']:,}")
    print(f"Unique Trip IDs Observed: {summary['unique_trip_ids']:,}")
    print(f"Archive Days ({summary['archive_days']}): {', '.join(summary['archive_days_list'])}")
    print("-" * 72)
    print("Top 10 Routes by Observation Count:")
    for idx, r in enumerate(routes[:10], start=1):
        print(
            f"  {idx:2d}. Route {r['route_id']:<10} : "
            f"{r['observations']:>7,} obs | "
            f"{r['unique_vehicles']:>4,} veh | "
            f"{r['unique_trip_ids']:>5,} trips | "
            f"{r['archive_days']} days"
        )
    print("-" * 72)
    print(f"Report File Generated   : {output_path}")
    print(f"Total Processing Time   : {elapsed_sec:.2f} seconds")
    print("=" * 72 + "\n")


# =============================================================================
# SECTION 7: CLI ENTRY POINT AND SYNTAX CHECK HANDLER
# =============================================================================
def parse_arguments() -> argparse.Namespace:
    """Parses command line arguments."""
    parser = argparse.ArgumentParser(
        description="Delhi Bus Project - Phase 1: Archive Reader & Route Data Profiler",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--archive-dir",
        type=Path,
        default=DEFAULT_ARCHIVE_DIR,
        help="Path to root archive directory containing YYYY-MM-DD subdirectories.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT_JSON,
        help="Output destination path for the JSON profile report.",
    )
    parser.add_argument(
        "--max-files",
        type=int,
        default=None,
        help="Optional limit on the number of archive files to process (useful for quick verification).",
    )
    parser.add_argument(
        "--check-syntax",
        action="store_true",
        help="Verify script syntax and dependencies then exit immediately without processing archive.",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Suppress intermediate progress logging to stdout.",
    )
    return parser.parse_args()


def main() -> int:
    """Main workflow entrypoint."""
    args = parse_arguments()

    # Syntax check mode: verify dependencies and exit immediately
    if args.check_syntax:
        print("[OK] Syntax check passed. Dependencies verified.")
        return 0

    t_start = time.time()
    archive_dir = args.archive_dir
    output_path = args.output

    if not args.quiet:
        print(f"[*] Discovering archive files in '{archive_dir}'...")

    files = discover_archive_files(archive_dir)
    total_found = len(files)

    if total_found == 0:
        print(f"[!] No .csv.gz archive files found in '{archive_dir}'.", file=sys.stderr)
        empty_report = compile_profile_report(
            files_processed=0,
            total_rows_read=0,
            total_valid_rows=0,
            total_invalid_rows=0,
            routes_registry={},
            global_vehicles=set(),
            global_trips=set(),
            global_archive_days=set(),
        )
        save_profile_report(empty_report, output_path)
        return 0

    if args.max_files is not None and args.max_files > 0:
        files = files[: args.max_files]
        if not args.quiet:
            print(f"[*] Limiting processing to first {len(files)} files as requested (--max-files).")

    if not args.quiet:
        print(f"[*] Processing {len(files)} archive files file-by-file...")

    routes_registry: Dict[str, RouteDataAccumulator] = {}
    global_vehicles: Set[str] = set()
    global_trips: Set[str] = set()
    global_archive_days: Set[str] = set()

    total_rows = 0
    total_valid = 0
    total_invalid = 0
    files_processed = 0

    log_interval = max(1, len(files) // 10)

    for idx, file_path in enumerate(files, start=1):
        r_read, r_valid, r_invalid = process_archive_file(
            file_path=file_path,
            routes_registry=routes_registry,
            global_vehicles=global_vehicles,
            global_trips=global_trips,
            global_archive_days=global_archive_days,
        )
        total_rows += r_read
        total_valid += r_valid
        total_invalid += r_invalid
        files_processed += 1

        if not args.quiet and (idx % log_interval == 0 or idx == len(files)):
            pct = (idx / len(files)) * 100.0
            print(
                f"    Progress: {idx}/{len(files)} files ({pct:5.1f}%) | "
                f"Rows: {total_rows:,} | Routes: {len(routes_registry):,}"
            )

    elapsed_sec = time.time() - t_start

    # Compile and persist profile report
    report = compile_profile_report(
        files_processed=files_processed,
        total_rows_read=total_rows,
        total_valid_rows=total_valid,
        total_invalid_rows=total_invalid,
        routes_registry=routes_registry,
        global_vehicles=global_vehicles,
        global_trips=global_trips,
        global_archive_days=global_archive_days,
    )

    save_profile_report(report, output_path)

    if not args.quiet:
        print_safe_summary(report, output_path, elapsed_sec)

    return 0


if __name__ == "__main__":
    sys.exit(main())
