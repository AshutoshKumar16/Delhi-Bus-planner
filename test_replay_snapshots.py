"""
Delhi Bus Project - Unit Test Suite for Historical Replay Snapshot Resolver
File: test_replay_snapshots.py

Scope:
  Validates replay_snapshots.py in total isolation:
    - Pure in-memory and tempfile operations
    - Zero network calls, zero time.sleep, zero background threads
    - Zero access or modification to genuine data/ or logs/ directories
    - Full coverage of type, boundary, causal filtering, fallback, caching, and provenance rules
"""

import concurrent.futures
import datetime
import gzip
import io
import os
import shutil
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

from replay_snapshots import (
    ArchiveDataUnavailableError,
    ArchiveGapExceededError,
    COMMIT_MARGIN_S,
    FuturePredictionTimeError,
    InSampleReplayForbiddenError,
    InvalidPredictionTimeError,
    MAX_SNAPSHOT_AGE_S,
    MAX_TELEMETRY_AGE_S,
    MissingPredictionTimeError,
    ModelProvenancePolicy,
    NoHistoricalSnapshotError,
    ReplayResolutionResult,
    ReplaySnapshotResolver,
    SnapshotMemoryCache,
    filter_snapshot_telemetry,
    parse_snapshot_path,
    validate_prediction_ts,
)

BASE_TS: int = 1_800_000_000  # Realistic Unix timestamp (2027-01-15 08:00:00 UTC)


def make_synthetic_snapshot_file(
    base_dir: Path,
    timestamp_unix: int,
    rows: list,
    is_corrupt: bool = False,
) -> Path:
    """Helper to create synthetic YYYY-MM-DD/HHMMSS.csv.gz snapshot files."""
    dt = datetime.datetime.fromtimestamp(timestamp_unix, tz=datetime.timezone.utc)
    folder = base_dir / dt.strftime("%Y-%m-%d")
    folder.mkdir(parents=True, exist_ok=True)
    file_path = folder / f"{dt.strftime('%H%M%S')}.csv.gz"

    if is_corrupt:
        with open(file_path, "wb") as f:
            f.write(b"NOT_A_VALID_GZIP_STREAM")
        return file_path

    df = pd.DataFrame(rows)
    with gzip.open(file_path, "wt", encoding="utf-8") as f:
        df.to_csv(f, index=False)

    return file_path


class TestPredictionTimestampValidation(unittest.TestCase):
    """Tests for validate_prediction_ts scalar validation rules."""

    def test_valid_integer_and_ascii_digit_strings(self):
        now_ts = BASE_TS + 1000
        self.assertEqual(validate_prediction_ts(BASE_TS, now_ts=now_ts), BASE_TS)
        self.assertEqual(validate_prediction_ts(str(BASE_TS), now_ts=now_ts), BASE_TS)

    def test_reject_missing_and_none(self):
        with self.assertRaises(MissingPredictionTimeError):
            validate_prediction_ts(None)

    def test_reject_booleans(self):
        with self.assertRaises(InvalidPredictionTimeError):
            validate_prediction_ts(True)
        with self.assertRaises(InvalidPredictionTimeError):
            validate_prediction_ts(False)

    def test_reject_floats(self):
        with self.assertRaises(InvalidPredictionTimeError):
            validate_prediction_ts(1800000000.5)
        with self.assertRaises(InvalidPredictionTimeError):
            validate_prediction_ts(1800000000.0)

    def test_reject_malformed_and_unicode_strings(self):
        bad_values = [
            "",
            "   ",
            "abc",
            "1800000000a",
            "1800000000.5",
            "१२३४५६७८९०",  # Devanagari numerals
            "١٢٣٤٥٦٧٨٩٠",  # Arabic-Indic numerals
            "1800000000 ",
            "-1800000000",
        ]
        for val in bad_values:
            with self.subTest(val=val):
                with self.assertRaises(InvalidPredictionTimeError):
                    validate_prediction_ts(val, now_ts=BASE_TS + 1000)

    def test_reject_negative_zero_and_sub_billion_range(self):
        with self.assertRaises(InvalidPredictionTimeError):
            validate_prediction_ts(-5, now_ts=BASE_TS)
        with self.assertRaises(InvalidPredictionTimeError):
            validate_prediction_ts(0, now_ts=BASE_TS)
        with self.assertRaises(InvalidPredictionTimeError):
            validate_prediction_ts(999_999_999, now_ts=BASE_TS)
        with self.assertRaises(InvalidPredictionTimeError):
            validate_prediction_ts(1059, now_ts=BASE_TS)

    def test_reject_millisecond_timestamps(self):
        ms_ts = BASE_TS * 1000
        with self.assertRaises(InvalidPredictionTimeError):
            validate_prediction_ts(ms_ts, now_ts=ms_ts + 1000)

    def test_reject_future_timestamps(self):
        now_ts = BASE_TS
        with self.assertRaises(FuturePredictionTimeError):
            validate_prediction_ts(BASE_TS + 1, now_ts=now_ts)


class TestSnapshotPathParsing(unittest.TestCase):
    """Tests for parse_snapshot_path regex and date-time extraction."""

    def test_valid_utc_paths(self):
        p1 = "data/2026-10-05/142620.csv.gz"
        expected = int(
            datetime.datetime(2026, 10, 5, 14, 26, 20, tzinfo=datetime.timezone.utc).timestamp()
        )
        self.assertEqual(parse_snapshot_path(p1), expected)

        p2 = Path("some/nested/dir/data/2026-09-30/103613.csv.gz")
        expected2 = int(
            datetime.datetime(2026, 9, 30, 10, 36, 13, tzinfo=datetime.timezone.utc).timestamp()
        )
        self.assertEqual(parse_snapshot_path(p2), expected2)

    def test_reject_tmp_and_non_conforming_names(self):
        self.assertIsNone(parse_snapshot_path("data/2026-10-05/142620.csv.gz.tmp"))
        self.assertIsNone(parse_snapshot_path("data/2026-10-05/preview.csv.gz"))
        self.assertIsNone(parse_snapshot_path("data/2026-10-05/14262.csv.gz"))
        self.assertIsNone(parse_snapshot_path("data/invalid-date/142620.csv.gz"))
        self.assertIsNone(parse_snapshot_path("data/2026-02-30/142620.csv.gz"))  # Invalid Feb 30


class TestCausalTelemetryFiltering(unittest.TestCase):
    """Tests for filter_snapshot_telemetry."""

    def test_causal_telemetry_dropping_nan_and_future_preserving_stale(self):
        p_ts = BASE_TS + 100

        data = {
            "vehicle_id": ["v_fut", "v_now", "v_mod", "v_stale", "v_nan", "v_str_invalid"],
            "route_id": ["101", "101", "101", "101", "101", "101"],
            "vehicle_ts_unix": [
                p_ts + 10,       # Future ping -> must be dropped
                p_ts,            # Exact prediction time -> retained
                p_ts - 500,      # Moderate age -> retained
                p_ts - 1300,     # Stale age (>1200s) -> PRESERVED for engine diagnostics!
                np.nan,          # NaN -> must be dropped
                "corrupt_text",  # Invalid string -> must be dropped
            ],
        }
        df_raw = pd.DataFrame(data)

        filtered_df, diag = filter_snapshot_telemetry(df_raw, p_ts)

        self.assertEqual(diag["total_rows_raw"], 6)
        self.assertEqual(diag["eligible_rows_retained"], 3)
        self.assertEqual(diag["future_rows_discarded"], 1)
        self.assertEqual(diag["nan_rows_discarded"], 2)
        self.assertEqual(diag["newest_vehicle_ts_unix"], p_ts)
        self.assertEqual(diag["fleet_telemetry_lag_seconds"], 0)

        retained_vids = set(filtered_df["vehicle_id"])
        self.assertIn("v_now", retained_vids)
        self.assertIn("v_mod", retained_vids)
        self.assertIn("v_stale", retained_vids)
        self.assertNotIn("v_fut", retained_vids)
        self.assertNotIn("v_nan", retained_vids)
        self.assertNotIn("v_str_invalid", retained_vids)


class TestModelProvenancePolicy(unittest.TestCase):
    """Tests for injectable ModelProvenancePolicy evaluation."""

    def test_unverified_provenance_defaults(self):
        policy = ModelProvenancePolicy()
        res = policy.evaluate(BASE_TS)
        self.assertEqual(res["regime"], "UNVERIFIED_PROVENANCE")
        self.assertFalse(res["provenance_verified"])
        self.assertFalse(res["is_authoritative"])

    def test_in_sample_rejection_and_override(self):
        cutoff = BASE_TS + 500
        policy = ModelProvenancePolicy(training_cutoff_unix=cutoff)

        with self.assertRaises(InSampleReplayForbiddenError):
            policy.evaluate(BASE_TS + 100, allow_in_sample=False)

        res = policy.evaluate(BASE_TS + 100, allow_in_sample=True)
        self.assertEqual(res["regime"], "IN_SAMPLE_TRAINING_PERIOD")
        self.assertTrue(res["in_sample_leakage"])
        self.assertTrue(res["retrospective_model"])

    def test_pre_model_gap_and_post_artifact_replay(self):
        cutoff = BASE_TS + 500
        model_avail = BASE_TS + 1000
        policy = ModelProvenancePolicy(training_cutoff_unix=cutoff, model_available_unix=model_avail)

        res_gap = policy.evaluate(BASE_TS + 600)
        self.assertEqual(res_gap["regime"], "PRE_MODEL_ARTIFACT_GAP")
        self.assertFalse(res_gap["in_sample_leakage"])
        self.assertTrue(res_gap["retrospective_model"])

        res_post = policy.evaluate(BASE_TS + 1200)
        self.assertEqual(res_post["regime"], "OUT_OF_SAMPLE_POST_ARTIFACT_REPLAY")
        self.assertFalse(res_post["in_sample_leakage"])
        self.assertFalse(res_post["retrospective_model"])
        self.assertFalse(res_post["production_activation_verified"])

    def test_production_activation_verification(self):
        cutoff = BASE_TS + 500
        model_avail = BASE_TS + 1000
        prod_active = BASE_TS + 2000
        policy = ModelProvenancePolicy(
            training_cutoff_unix=cutoff,
            model_available_unix=model_avail,
            production_activation_unix=prod_active,
        )

        res_pre_prod = policy.evaluate(BASE_TS + 1500)
        self.assertEqual(res_pre_prod["regime"], "OUT_OF_SAMPLE_POST_ARTIFACT_REPLAY")
        self.assertFalse(res_pre_prod["production_activation_verified"])

        res_prod = policy.evaluate(BASE_TS + 2500)
        self.assertEqual(res_prod["regime"], "VERIFIED_PRODUCTION_REPLAY")
        self.assertTrue(res_prod["production_activation_verified"])


class TestSnapshotMemoryCache(unittest.TestCase):
    """Tests for SnapshotMemoryCache LRU eviction, invalidation, and thread-safety."""

    def test_lru_capacity_and_eviction(self):
        cache = SnapshotMemoryCache(max_entries=2)
        df1 = pd.DataFrame({"a": [1]})
        df2 = pd.DataFrame({"a": [2]})
        df3 = pd.DataFrame({"a": [3]})

        k1 = ("file1", 100, 1000)
        k2 = ("file2", 100, 1000)
        k3 = ("file3", 100, 1000)

        cache.put(k1, df1)
        cache.put(k2, df2)
        self.assertEqual(cache.stats()["size"], 2)

        # Access k1 to make it most-recently used
        res1 = cache.get(k1)
        self.assertIsNotNone(res1)

        # Insert k3 -> k2 should be evicted (least recently used)
        cache.put(k3, df3)
        self.assertIsNone(cache.get(k2))
        self.assertIsNotNone(cache.get(k1))
        self.assertIsNotNone(cache.get(k3))

    def test_cache_mutation_protection(self):
        cache = SnapshotMemoryCache(max_entries=2)
        df = pd.DataFrame({"val": [10]})
        k = ("file", 100, 1000)
        cache.put(k, df)

        # Mutate retrieved DataFrame
        retrieved = cache.get(k)
        retrieved.loc[0, "val"] = 999

        # Second retrieval must retain original unmutated value
        fresh = cache.get(k)
        self.assertEqual(fresh.loc[0, "val"], 10)

    def test_cache_concurrent_thread_safety(self):
        cache = SnapshotMemoryCache(max_entries=10)
        keys = [(f"file_{i}", 100, 1000) for i in range(20)]

        def worker(thread_idx: int):
            for i in range(50):
                k = keys[(thread_idx + i) % len(keys)]
                df = pd.DataFrame({"thread": [thread_idx], "iter": [i]})
                cache.put(k, df)
                cached = cache.get(k)
                if cached is not None:
                    _ = len(cached)

        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
            futures = [executor.submit(worker, t) for t in range(8)]
            for fut in futures:
                fut.result()

        stats = cache.stats()
        self.assertLessEqual(stats["size"], 10)


class TestReplaySnapshotResolver(unittest.TestCase):
    """End-to-end unit tests for ReplaySnapshotResolver discovery, fallback, and boundary logic."""

    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.archive_path = Path(self.temp_dir)
        self.clock_val = BASE_TS + 100_000  # Ensure all test queries are causal (< clock)

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_commit_margin_exact_boundary(self):
        """Tests exact 60-second commit margin boundary (T_poll_start + 60 <= P)."""
        t_poll = BASE_TS
        rows = [{"route_id": "100", "vehicle_id": "v1", "vehicle_ts_unix": t_poll}]
        make_synthetic_snapshot_file(self.archive_path, t_poll, rows)

        resolver = ReplaySnapshotResolver(
            archive_dir=self.archive_path,
            clock_fn=lambda: self.clock_val,
        )

        # P = BASE_TS + 59: Uncommitted (T + 60 > P) -> raises NoHistoricalSnapshotError
        with self.assertRaises(NoHistoricalSnapshotError):
            resolver.resolve_replay_snapshot(BASE_TS + 59)

        # P = BASE_TS + 60: Exactly committed -> accepted
        res60 = resolver.resolve_replay_snapshot(BASE_TS + 60)
        self.assertIsInstance(res60, ReplayResolutionResult)
        self.assertEqual(res60.snapshot_poll_start_unix, t_poll)

        # P = BASE_TS + 61: Committed -> accepted
        res61 = resolver.resolve_replay_snapshot(BASE_TS + 61)
        self.assertEqual(res61.snapshot_poll_start_unix, t_poll)

    def test_snapshot_age_exact_boundary(self):
        """Tests exact 420-second snapshot age boundary (P - T_poll_start <= 420)."""
        t_poll = BASE_TS
        rows = [{"route_id": "100", "vehicle_id": "v1", "vehicle_ts_unix": t_poll}]
        make_synthetic_snapshot_file(self.archive_path, t_poll, rows)

        resolver = ReplaySnapshotResolver(
            archive_dir=self.archive_path,
            clock_fn=lambda: self.clock_val,
        )

        # P = BASE_TS + 420: Exactly at 420s limit -> accepted
        res420 = resolver.resolve_replay_snapshot(BASE_TS + 420)
        self.assertEqual(res420.snapshot_age_seconds, 420)

        # P = BASE_TS + 421: Exceeds 420s limit -> raises ArchiveGapExceededError
        with self.assertRaises(ArchiveGapExceededError) as ctx:
            resolver.resolve_replay_snapshot(BASE_TS + 421)
        self.assertEqual(ctx.exception.gap_seconds, 421)

    def test_deterministic_fallback_loop_three_candidates(self):
        """
        Tests fallback across 3 candidates:
          Candidate 1: Corrupt file -> fails decompression -> falls back
          Candidate 2: Hung poll (all vehicle_ts_unix > P) -> 0 eligible rows -> falls back
          Candidate 3: Valid file with eligible rows -> selected
        """
        t3 = BASE_TS + 100
        t2 = BASE_TS + 200
        t1 = BASE_TS + 300
        p_ts = BASE_TS + 380

        # Note: All candidates are committed since t1 + 60 = BASE_TS + 360 <= p_ts
        make_synthetic_snapshot_file(self.archive_path, t1, [], is_corrupt=True)
        make_synthetic_snapshot_file(
            self.archive_path,
            t2,
            [{"route_id": "1", "vehicle_id": "v_hung", "vehicle_ts_unix": p_ts + 50}],
        )
        make_synthetic_snapshot_file(
            self.archive_path,
            t3,
            [{"route_id": "1", "vehicle_id": "v_valid", "vehicle_ts_unix": p_ts - 20}],
        )

        resolver = ReplaySnapshotResolver(
            archive_dir=self.archive_path,
            clock_fn=lambda: self.clock_val,
        )

        res = resolver.resolve_replay_snapshot(p_ts)
        self.assertEqual(res.snapshot_poll_start_unix, t3)
        self.assertEqual(res.candidates_evaluated, 3)
        self.assertEqual(len(res.df), 1)
        self.assertEqual(res.df.iloc[0]["vehicle_id"], "v_valid")

    def test_fallback_exhaustion_raises_archive_data_unavailable(self):
        """Tests that after 3 failed committed candidates, resolver raises ArchiveDataUnavailableError."""
        t1 = BASE_TS + 300
        t2 = BASE_TS + 200
        t3 = BASE_TS + 100
        p_ts = BASE_TS + 380

        # All 3 files are corrupt
        make_synthetic_snapshot_file(self.archive_path, t1, [], is_corrupt=True)
        make_synthetic_snapshot_file(self.archive_path, t2, [], is_corrupt=True)
        make_synthetic_snapshot_file(self.archive_path, t3, [], is_corrupt=True)

        resolver = ReplaySnapshotResolver(
            archive_dir=self.archive_path,
            clock_fn=lambda: self.clock_val,
        )

        with self.assertRaises(ArchiveDataUnavailableError):
            resolver.resolve_replay_snapshot(p_ts)

    def test_fallback_aborts_if_candidate_exceeds_age_limit(self):
        """Tests that fallback stops and raises ArchiveGapExceededError if an older candidate breaches 420s."""
        t_recent = BASE_TS + 300  # committed for p_ts = BASE_TS + 380 (age: 80s)
        t_ancient = BASE_TS - 500  # committed, but p_ts - t_ancient = 880s > 420s
        p_ts = BASE_TS + 380

        # Recent candidate is corrupt
        make_synthetic_snapshot_file(self.archive_path, t_recent, [], is_corrupt=True)
        # Ancient candidate is valid, but too old
        make_synthetic_snapshot_file(
            self.archive_path,
            t_ancient,
            [{"route_id": "1", "vehicle_id": "v", "vehicle_ts_unix": t_ancient}],
        )

        resolver = ReplaySnapshotResolver(
            archive_dir=self.archive_path,
            clock_fn=lambda: self.clock_val,
        )

        # Must raise ArchiveGapExceededError, NEVER bypassing the 420s limit
        with self.assertRaises(ArchiveGapExceededError):
            resolver.resolve_replay_snapshot(p_ts)

    def test_no_exposure_of_absolute_filesystem_paths(self):
        """Verifies snapshot_path in ReplayResolutionResult never exposes absolute paths."""
        t_poll = BASE_TS
        rows = [{"route_id": "100", "vehicle_id": "v1", "vehicle_ts_unix": t_poll}]
        make_synthetic_snapshot_file(self.archive_path, t_poll, rows)

        resolver = ReplaySnapshotResolver(
            archive_dir=self.archive_path,
            clock_fn=lambda: self.clock_val,
        )

        res = resolver.resolve_replay_snapshot(BASE_TS + 70)
        self.assertFalse(res.snapshot_path.startswith("/"))
        self.assertFalse(":" in res.snapshot_path)  # No Windows drive letters
        self.assertTrue(res.snapshot_path.endswith(".csv.gz"))


if __name__ == "__main__":
    unittest.main()
