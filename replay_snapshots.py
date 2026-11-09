"""
Delhi Bus Project - Historical Replay Snapshot Resolver Module
File: replay_snapshots.py

Purpose:
  Provides a pure, thread-safe, self-contained Python module for:
    - Prediction timestamp validation (scalar Unix seconds)
    - Causal candidate snapshot selection with commit margin and age limit
    - Bounded LRU in-memory caching of raw snapshot DataFrames
    - Causal telemetry filtering (eliminating NaNs and future vehicle observations)
    - Model provenance policy evaluation

Operational Guarantees:
  1. Strict Historical Causality: Never admits vehicle observations where vehicle_ts_unix > P.
  2. Zero Look-Ahead at Snapshot Level: Candidate poll-start + COMMIT_MARGIN_S <= P.
  3. Gap Control: Enforces MAX_SNAPSHOT_AGE_S (420s) snapshot-level freshness limit.
  4. Non-Destructive Caching: Raw DataFrames cached safely; returns isolated copies.
  5. Information Hygiene: Never exposes absolute filesystem paths in results or errors.
"""

from __future__ import annotations

import collections
import datetime
import os
import re
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple, Union

import pandas as pd

# Core Configuration Thresholds
MAX_SNAPSHOT_AGE_S: int = 420       # 7 minutes snapshot-level freshness limit
COMMIT_MARGIN_S: int = 60           # 60 seconds write/publish margin
MAX_TELEMETRY_AGE_S: int = 1200     # 20 minutes vehicle telemetry limit (engine level)
MAX_FALLBACK_CANDIDATES: int = 3    # Maximum fallback candidates evaluated

# Diagnostic / Test Defaults (NOT authoritative production metadata)
DIAGNOSTIC_DEFAULT_TRAINING_CUTOFF_UNIX: int = 1791158400  # 2026-10-05 00:00:00 UTC
DIAGNOSTIC_DEFAULT_MODEL_AVAILABLE_UNIX: int = 1791210380  # 2026-10-05 14:26:20 UTC


# =============================================================================
# Exception Hierarchy
# =============================================================================

class ReplayError(Exception):
    """Base exception for all replay snapshot resolver errors."""
    pass


class MissingPredictionTimeError(ReplayError):
    """Raised when replay mode is explicitly requested without a prediction timestamp."""
    pass


class InvalidPredictionTimeError(ReplayError):
    """Raised when prediction timestamp fails scalar, range, or format validation."""
    pass


class FuturePredictionTimeError(ReplayError):
    """Raised when prediction timestamp exceeds current clock time."""
    pass


class NoHistoricalSnapshotError(ReplayError):
    """Raised when archive contains no committed snapshots before prediction time."""
    pass


class ArchiveGapExceededError(ReplayError):
    """Raised when the newest committed snapshot exceeds the snapshot age threshold."""
    def __init__(
        self,
        message: str,
        prediction_ts: int,
        newest_snapshot_poll_start: int,
        gap_seconds: int,
        max_gap_seconds: int = MAX_SNAPSHOT_AGE_S,
    ):
        super().__init__(message)
        self.prediction_ts = prediction_ts
        self.newest_snapshot_poll_start = newest_snapshot_poll_start
        self.gap_seconds = gap_seconds
        self.max_gap_seconds = max_gap_seconds


class ArchiveDataUnavailableError(ReplayError):
    """Raised when all evaluated fallback candidates fail due to corruption or zero usable rows."""
    pass


class InSampleReplayForbiddenError(ReplayError):
    """Raised when prediction timestamp falls within training corpus without override."""
    pass


# =============================================================================
# Validation & Path Parsing
# =============================================================================

def validate_prediction_ts(prediction_ts: Any, now_ts: Optional[int] = None) -> int:
    """
    Validates that prediction_ts is an integer Unix timestamp in seconds.

    Rules:
      - Reject None (raises MissingPredictionTimeError)
      - Reject bool (isinstance(True, int) is True in Python)
      - Reject float
      - Accept int directly
      - Accept str only if ASCII digits only (rejects Unicode digits, decimals, negatives)
      - Enforce range: positive, >= 1,000,000,000 (valid epoch seconds), < 100,000,000,000 (no ms)
      - Enforce causality: <= now_ts (or current system time)
    """
    if prediction_ts is None:
        raise MissingPredictionTimeError("Field 'prediction_time' is required for replay mode.")

    # In Python, bool is a subclass of int (bool -> int), so check bool explicitly first
    if isinstance(prediction_ts, bool):
        raise InvalidPredictionTimeError("Prediction timestamp cannot be a boolean.")

    if isinstance(prediction_ts, float):
        raise InvalidPredictionTimeError("Prediction timestamp must be integer Unix seconds, not float.")

    if isinstance(prediction_ts, str):
        if not (prediction_ts.isascii() and prediction_ts.isdigit()):
            raise InvalidPredictionTimeError(
                f"Prediction timestamp string must contain ASCII digits only (got: {prediction_ts!r})."
            )
        try:
            ts = int(prediction_ts)
        except ValueError:
            raise InvalidPredictionTimeError(f"Cannot parse prediction timestamp string: {prediction_ts!r}.")
    elif isinstance(prediction_ts, int):
        ts = prediction_ts
    else:
        raise InvalidPredictionTimeError(
            f"Unsupported type for prediction timestamp: {type(prediction_ts).__name__}."
        )

    if ts <= 0:
        raise InvalidPredictionTimeError("Prediction timestamp must be a positive integer.")

    if ts < 1_000_000_000:
        raise InvalidPredictionTimeError(
            f"Prediction timestamp {ts} is below valid epoch seconds range (>= 1,000,000,000)."
        )

    if ts >= 100_000_000_000:
        raise InvalidPredictionTimeError("Millisecond timestamps are not supported; provide Unix seconds.")

    current_clock = now_ts if now_ts is not None else int(time.time())
    if ts > current_clock:
        raise FuturePredictionTimeError(
            f"Prediction timestamp {ts} is in the future (current clock: {current_clock})."
        )

    return ts


def parse_snapshot_path(file_path: Union[str, Path]) -> Optional[int]:
    """
    Parses a snapshot path conforming to 'data/YYYY-MM-DD/HHMMSS.csv.gz' or 'YYYY-MM-DD/HHMMSS.csv.gz'.

    Returns:
      Integer Unix seconds (UTC), or None if path format/date/time is invalid or temporary (.tmp).
    """
    p = Path(file_path)
    filename = p.name

    # Reject non-conforming filenames and temporary files
    if not re.match(r"^\d{6}\.csv\.gz$", filename):
        return None

    parent_name = p.parent.name
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", parent_name):
        return None

    try:
        yyyy = int(parent_name[0:4])
        mm = int(parent_name[5:7])
        dd = int(parent_name[8:10])
        hh = int(filename[0:2])
        minute = int(filename[2:4])
        ss = int(filename[4:6])

        dt = datetime.datetime(yyyy, mm, dd, hh, minute, ss, tzinfo=datetime.timezone.utc)
        return int(dt.timestamp())
    except (ValueError, OverflowError):
        return None


# =============================================================================
# Model Provenance Policy
# =============================================================================

class ModelProvenancePolicy:
    """
    Evaluates historical prediction timestamps against model training and publication boundaries.

    Boundaries are injectable. When boundaries are not supplied (None), evaluation returns
    an unverified provenance state without raising an exception.
    """

    def __init__(
        self,
        training_cutoff_unix: Optional[int] = None,
        model_available_unix: Optional[int] = None,
        production_activation_unix: Optional[int] = None,
    ):
        self.training_cutoff_unix = training_cutoff_unix
        self.model_available_unix = model_available_unix
        self.production_activation_unix = production_activation_unix

    @classmethod
    def from_diagnostic_defaults(cls) -> "ModelProvenancePolicy":
        """Explicitly labeled test/diagnostic defaults. Not authoritative for production."""
        return cls(
            training_cutoff_unix=DIAGNOSTIC_DEFAULT_TRAINING_CUTOFF_UNIX,
            model_available_unix=DIAGNOSTIC_DEFAULT_MODEL_AVAILABLE_UNIX,
            production_activation_unix=None,
        )

    def evaluate(self, prediction_ts: int, allow_in_sample: bool = False) -> Dict[str, Any]:
        """
        Evaluates prediction timestamp P against provenance boundaries.

        Returns metadata dictionary containing regime and causality flags.
        """
        # 1. In-Sample Check (evaluates whenever training_cutoff_unix is defined)
        if self.training_cutoff_unix is not None and prediction_ts < self.training_cutoff_unix:
            if not allow_in_sample:
                raise InSampleReplayForbiddenError(
                    f"Prediction timestamp {prediction_ts} falls within training corpus "
                    f"(< {self.training_cutoff_unix}). Set allow_in_sample=True to allow retrospective evaluation."
                )
            return {
                "regime": "IN_SAMPLE_TRAINING_PERIOD",
                "provenance_verified": True,
                "is_authoritative": True,
                "in_sample_leakage": True,
                "retrospective_model": True,
                "production_activation_verified": False,
            }

        # 2. Pre-Model Artifact Gap Check
        if (
            self.training_cutoff_unix is not None
            and self.model_available_unix is not None
            and self.training_cutoff_unix <= prediction_ts < self.model_available_unix
        ):
            return {
                "regime": "PRE_MODEL_ARTIFACT_GAP",
                "provenance_verified": True,
                "is_authoritative": True,
                "in_sample_leakage": False,
                "retrospective_model": True,
                "production_activation_verified": False,
            }

        # 3. Post-Artifact Out-of-Sample Replay
        if self.model_available_unix is not None and prediction_ts >= self.model_available_unix:
            if self.production_activation_unix is not None:
                if prediction_ts < self.production_activation_unix:
                    return {
                        "regime": "OUT_OF_SAMPLE_POST_ARTIFACT_REPLAY",
                        "provenance_verified": True,
                        "is_authoritative": True,
                        "in_sample_leakage": False,
                        "retrospective_model": False,
                        "production_activation_verified": False,
                    }
                else:
                    return {
                        "regime": "VERIFIED_PRODUCTION_REPLAY",
                        "provenance_verified": True,
                        "is_authoritative": True,
                        "in_sample_leakage": False,
                        "retrospective_model": False,
                        "production_activation_verified": True,
                    }
            else:
                return {
                    "regime": "OUT_OF_SAMPLE_POST_ARTIFACT_REPLAY",
                    "provenance_verified": True,
                    "is_authoritative": True,
                    "in_sample_leakage": False,
                    "retrospective_model": False,
                    "production_activation_verified": False,
                }

        # 4. Unverified Provenance Fallback
        return {
            "regime": "UNVERIFIED_PROVENANCE",
            "provenance_verified": False,
            "is_authoritative": False,
            "in_sample_leakage": None,
            "retrospective_model": None,
            "production_activation_verified": False,
        }


# =============================================================================
# Causal Telemetry Filtering
# =============================================================================

def filter_snapshot_telemetry(
    df: pd.DataFrame, prediction_ts: int
) -> Tuple[pd.DataFrame, Dict[str, Any]]:
    """
    Filters raw snapshot DataFrame to ensure causal integrity:
      - Drops rows with null, NaN, or non-numeric vehicle_ts_unix
      - Drops rows where vehicle_ts_unix > prediction_ts (eliminates future observations)
      - PRESERVES rows older than 1200 seconds (engine handles stale telemetry diagnostics)

    Returns:
      (filtered_df, telemetry_diagnostics_dict)
    """
    total_rows_raw = len(df)
    if total_rows_raw == 0:
        return df.copy(), {
            "total_rows_raw": 0,
            "eligible_rows_retained": 0,
            "future_rows_discarded": 0,
            "nan_rows_discarded": 0,
            "newest_vehicle_ts_unix": None,
            "fleet_telemetry_lag_seconds": None,
        }

    if "vehicle_ts_unix" not in df.columns:
        return df.iloc[0:0].copy(), {
            "total_rows_raw": total_rows_raw,
            "eligible_rows_retained": 0,
            "future_rows_discarded": 0,
            "nan_rows_discarded": total_rows_raw,
            "newest_vehicle_ts_unix": None,
            "fleet_telemetry_lag_seconds": None,
        }

    # Convert vehicle_ts_unix to numeric series safely
    ts_series = pd.to_numeric(df["vehicle_ts_unix"], errors="coerce")
    valid_mask = ts_series.notna()
    nan_rows_discarded = int((~valid_mask).sum())

    valid_ts = ts_series[valid_mask]
    causal_mask = valid_ts <= prediction_ts
    future_rows_discarded = int((~causal_mask).sum())

    eligible_indices = valid_ts[causal_mask].index
    filtered_df = df.loc[eligible_indices].copy()
    eligible_rows_retained = len(filtered_df)

    newest_vehicle_ts_unix = int(valid_ts[causal_mask].max()) if eligible_rows_retained > 0 else None
    fleet_telemetry_lag_seconds = (
        int(prediction_ts - newest_vehicle_ts_unix) if newest_vehicle_ts_unix is not None else None
    )

    diagnostics = {
        "total_rows_raw": total_rows_raw,
        "eligible_rows_retained": eligible_rows_retained,
        "future_rows_discarded": future_rows_discarded,
        "nan_rows_discarded": nan_rows_discarded,
        "newest_vehicle_ts_unix": newest_vehicle_ts_unix,
        "fleet_telemetry_lag_seconds": fleet_telemetry_lag_seconds,
    }
    return filtered_df, diagnostics


# =============================================================================
# Thread-Safe Bounded LRU Cache
# =============================================================================

class SnapshotMemoryCache:
    """
    Thread-safe, capacity-bounded LRU cache for raw snapshot DataFrames.
    Key: (relative_path, file_size, mtime_ns).
    Stores unmutated copies; returns isolated copies to prevent caller mutation.
    """

    def __init__(self, max_entries: int = 32):
        if max_entries < 1:
            raise ValueError("max_entries must be >= 1")
        self.max_entries = max_entries
        self._cache: collections.OrderedDict[Tuple[str, int, int], pd.DataFrame] = collections.OrderedDict()
        self._lock = threading.Lock()
        self._hits = 0
        self._misses = 0

    def get(self, key: Tuple[str, int, int]) -> Optional[pd.DataFrame]:
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
                self._hits += 1
                return self._cache[key].copy()
            self._misses += 1
            return None

    def put(self, key: Tuple[str, int, int], df: pd.DataFrame) -> None:
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
                self._cache[key] = df.copy()
            else:
                if len(self._cache) >= self.max_entries:
                    self._cache.popitem(last=False)  # Evict least-recently used
                self._cache[key] = df.copy()

    def clear(self) -> None:
        with self._lock:
            self._cache.clear()
            self._hits = 0
            self._misses = 0

    def stats(self) -> Dict[str, int]:
        with self._lock:
            return {
                "hits": self._hits,
                "misses": self._misses,
                "size": len(self._cache),
                "capacity": self.max_entries,
            }


# =============================================================================
# Resolver Result Dataclass
# =============================================================================

@dataclass(frozen=True)
class ReplayResolutionResult:
    df: pd.DataFrame
    snapshot_path: str
    snapshot_poll_start_unix: int
    snapshot_age_seconds: int
    candidates_evaluated: int
    provenance: Dict[str, Any]
    telemetry_diagnostics: Dict[str, Any]


# =============================================================================
# Deterministic Replay Snapshot Resolver
# =============================================================================

class ReplaySnapshotResolver:
    """
    Resolves historical snapshot candidates deterministically for prediction time P.

    Guarantees:
      - Validates prediction timestamp scalar types, range, and causality.
      - Filters committed snapshots: T_poll_start + commit_margin_s <= P.
      - Enforces max_snapshot_age_s (420s) snapshot-level gap limit.
      - Evaluates up to max_fallback_candidates (3) on corruption or zero usable rows.
      - Thread-safe caching with zero Live Mode cache contamination.
      - Never exposes absolute filesystem paths.
    """

    def __init__(
        self,
        archive_dir: Union[str, Path] = "data",
        cache: Optional[SnapshotMemoryCache] = None,
        provenance_policy: Optional[ModelProvenancePolicy] = None,
        max_snapshot_age_s: int = MAX_SNAPSHOT_AGE_S,
        commit_margin_s: int = COMMIT_MARGIN_S,
        max_fallback_candidates: int = MAX_FALLBACK_CANDIDATES,
        clock_fn: Optional[Callable[[], int]] = None,
    ):
        self.archive_dir = Path(archive_dir)
        self.cache = cache or SnapshotMemoryCache()
        # Safe default: unconfigured policy returns UNVERIFIED_PROVENANCE without raising
        self.provenance_policy = provenance_policy or ModelProvenancePolicy()
        self.max_snapshot_age_s = max_snapshot_age_s
        self.commit_margin_s = commit_margin_s
        self.max_fallback_candidates = max_fallback_candidates
        self.clock_fn = clock_fn or (lambda: int(time.time()))

    def resolve_replay_snapshot(
        self, prediction_ts: Any, allow_in_sample: bool = False
    ) -> ReplayResolutionResult:
        """
        Resolves the appropriate historical snapshot for prediction_ts.

        Returns ReplayResolutionResult with causally filtered DataFrame.
        """
        # 1. Validate prediction_ts
        p_ts = validate_prediction_ts(prediction_ts, now_ts=self.clock_fn())

        # 2. Evaluate model provenance
        provenance = self.provenance_policy.evaluate(p_ts, allow_in_sample=allow_in_sample)

        # 3. Discover candidates in archive_dir
        if not self.archive_dir.exists():
            raise NoHistoricalSnapshotError(f"Archive directory does not exist: {self.archive_dir.name}")

        candidates: List[Tuple[int, Path]] = []
        for file_path in self.archive_dir.glob("*/*.csv.gz"):
            ts = parse_snapshot_path(file_path)
            if ts is not None and ts + self.commit_margin_s <= p_ts:
                candidates.append((ts, file_path))

        # Check committed candidate availability
        if not candidates:
            raise NoHistoricalSnapshotError(
                f"No committed historical snapshot found for prediction time {p_ts} "
                f"(required: T_poll_start + {self.commit_margin_s}s <= {p_ts})."
            )

        # 4. Order candidates descending (newest committed first)
        candidates.sort(key=lambda c: c[0], reverse=True)

        # 5. Fallback loop (up to max_fallback_candidates)
        candidates_to_evaluate = candidates[: self.max_fallback_candidates]
        evaluated_count = 0

        for poll_start_ts, candidate_path in candidates_to_evaluate:
            evaluated_count += 1
            snapshot_age = p_ts - poll_start_ts

            # Snapshot age limit check: never bypass 420s limit during fallback
            if snapshot_age > self.max_snapshot_age_s:
                raise ArchiveGapExceededError(
                    f"Newest eligible snapshot is {snapshot_age}s old (exceeds {self.max_snapshot_age_s}s limit).",
                    prediction_ts=p_ts,
                    newest_snapshot_poll_start=poll_start_ts,
                    gap_seconds=snapshot_age,
                    max_gap_seconds=self.max_snapshot_age_s,
                )

            # Load raw DataFrame via cache
            try:
                stat_res = candidate_path.stat()
                file_size = stat_res.st_size
                mtime_ns = stat_res.st_mtime_ns
                try:
                    rel_path = str(candidate_path.relative_to(self.archive_dir)).replace("\\", "/")
                except ValueError:
                    rel_path = candidate_path.name
            except OSError:
                continue

            cache_key = (rel_path, file_size, mtime_ns)
            raw_df = self.cache.get(cache_key)

            if raw_df is None:
                try:
                    raw_df = pd.read_csv(
                        candidate_path,
                        compression="gzip",
                        dtype={"route_id": str, "vehicle_id": str},
                    )
                    self.cache.put(cache_key, raw_df)
                except Exception:
                    # Corrupt file, non-gzip, empty, or unreadable -> fallback
                    continue

            # Filter telemetry causally (dropping NaNs and vehicle_ts_unix > p_ts)
            filtered_df, diag = filter_snapshot_telemetry(raw_df, p_ts)

            # If zero eligible rows remain (e.g. hung poll) -> fallback
            if diag["eligible_rows_retained"] == 0:
                continue

            # Return success with sanitized relative path
            return ReplayResolutionResult(
                df=filtered_df,
                snapshot_path=rel_path,
                snapshot_poll_start_unix=poll_start_ts,
                snapshot_age_seconds=snapshot_age,
                candidates_evaluated=evaluated_count,
                provenance=provenance,
                telemetry_diagnostics=diag,
            )

        # 6. Fallback exhausted
        raise ArchiveDataUnavailableError(
            f"All {evaluated_count} candidate snapshot(s) evaluated within {self.max_snapshot_age_s}s "
            f"failed due to corrupt data or zero usable telemetry rows."
        )
