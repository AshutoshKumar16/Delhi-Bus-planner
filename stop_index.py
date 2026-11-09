"""
===============================================================================
Delhi Bus Project — Stop Discovery Index
Module: stop_index.py

Purpose:
    Provides fast stop autocomplete (search_stops) and structural downstream
    destination lookup (get_reachable_destinations) for the Delhi bus network.

Design principles:
    1. Zero additional disk I/O.  Derives all data from an already-initialized
       JourneyRecommendationEngine instance (engine.stop_to_directions and
       engine.routes).
    2. Physical stop identity preserved.  Each StopEntry is keyed by its
       physical stop_id string.  Stops that share a name but have different IDs
       are NEVER merged, regardless of geographic proximity.
    3. Last-occurrence semantics untouched.  The engine's existing
       stop_to_directions lists are read as-is; this module never re-orders or
       re-builds them.
    4. Structural connectivity only.  get_reachable_destinations reflects
       reconstructed route topology, NOT live bus availability.
    5. No recommendation logic modified.  find_candidate_routes, ranking, Live
       Mode, and Replay Mode are entirely unaffected.
===============================================================================
"""

from __future__ import annotations

import bisect
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Set, Tuple

if TYPE_CHECKING:
    # Import only for type hints; avoids circular dependency at runtime.
    from prototype_journey_recommendation import JourneyRecommendationEngine


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass
class StopEntry:
    """
    Represents one physical bus stop pole in the route network.

    Fields
    ------
    stop_id : str
        Physical stop identifier as it appears in reconstructed_routes.json
        (e.g. "STOP_04160").  Never merged with other poles.
    display_name : str
        Original-casing stop name taken from the first occurrence of this
        stop_id across all route directions.
    name_normalized : str
        display_name.strip().lower() — the key used in _by_name and
        _prefix_sorted.
    lat : float
        Latitude from the first occurrence of this stop_id in route data.
    lon : float
        Longitude from the first occurrence of this stop_id in route data.
    route_direction_count : int
        Number of distinct (route_id, direction_id) pairs that serve this
        physical stop.
    """
    stop_id: str
    display_name: str
    name_normalized: str
    lat: float
    lon: float
    route_direction_count: int

    def to_dict(self) -> Dict[str, Any]:
        """Serialisable representation for JSON API responses."""
        return {
            "stop_id": self.stop_id,
            "display_name": self.display_name,
            "name_normalized": self.name_normalized,
            "lat": self.lat,
            "lon": self.lon,
            "route_direction_count": self.route_direction_count,
        }


@dataclass
class DestEntry:
    """
    A downstream destination reachable from an origin stop via the route
    network.  Structural connectivity only — not live bus availability.

    Fields
    ------
    stop_id : str
        Physical stop identifier of the destination pole.
    display_name : str
        Original-casing stop name.
    name_normalized : str
        display_name.strip().lower().
    serving_direction_count : int
        Number of distinct (route_id, direction_id) pairs that connect the
        origin stop to this destination in forward sequence.
    """
    stop_id: str
    display_name: str
    name_normalized: str
    serving_direction_count: int

    def to_dict(self) -> Dict[str, Any]:
        """Serialisable representation for JSON API responses."""
        return {
            "stop_id": self.stop_id,
            "display_name": self.display_name,
            "name_normalized": self.name_normalized,
            "serving_direction_count": self.serving_direction_count,
        }


# ---------------------------------------------------------------------------
# StopIndex
# ---------------------------------------------------------------------------

class StopIndex:
    """
    In-memory stop discovery index built from an already-initialized
    JourneyRecommendationEngine.

    Construction is O(|stop_to_directions| + |routes|) in time and O(|stops|)
    in additional space.  No disk I/O is performed.

    Public interface
    ----------------
    search_stops(query, limit=10)
        Autocomplete / lookup by stop ID or name fragment.
    get_reachable_destinations(origin_stop_id, limit=50)
        Structural downstream destinations from a given origin stop.
    stats() -> dict
        Summary counts for health-check / logging.
    """

    # ------------------------------------------------------------------
    # Construction
    # ------------------------------------------------------------------

    def __init__(self, engine: "JourneyRecommendationEngine") -> None:
        """
        Build indexes from the engine's already-loaded network data.

        Parameters
        ----------
        engine : JourneyRecommendationEngine
            A fully initialized engine (after _load_network() has completed).
            engine.stop_to_directions and engine.routes are read; nothing is
            modified.
        """
        # stop_id (str) -> StopEntry
        self._by_id: Dict[str, StopEntry] = {}

        # normalized name (str) -> list[StopEntry]  (one entry per unique stop_id)
        self._by_name: Dict[str, List[StopEntry]] = {}

        # Sorted list of normalized names for O(log N) prefix search
        self._prefix_sorted: List[str] = []

        # Keep a reference for get_reachable_destinations
        self._engine = engine

        t0 = time.time()
        self._build(engine)
        elapsed = time.time() - t0
        print(
            "[stop_index] Built StopIndex: %d stop IDs, %d name keys in %.3fs."
            % (len(self._by_id), len(self._by_name), elapsed)
        )

    def _build(self, engine: "JourneyRecommendationEngine") -> None:
        """
        Single-pass construction from engine.stop_to_directions and
        engine.routes.

        Step 1 — Collect the full set of physical stop IDs from route data.
                  This is the ground-truth classifier: a key in
                  stop_to_directions is a stop ID iff it is present in this
                  set.  No string-prefix assumptions are made.

        Step 2 — Iterate stop_to_directions.  For each key that IS a stop ID,
                  resolve coordinates and display name from route data, then
                  upsert a StopEntry into _by_id (accumulating
                  route_direction_count on subsequent occurrences).

        Step 3 — Populate _by_name from _by_id.

        Step 4 — Build _prefix_sorted from _by_name keys.
        """

        # -- Step 1: ground-truth stop ID set --
        all_stop_ids: Set[str] = set()
        for r in engine.routes.values():
            for d_data in r.get("directions", {}).values():
                if d_data.get("status") != "SUCCESS":
                    continue
                for sid in d_data.get("ordered_stop_ids", []):
                    all_stop_ids.add(str(sid).strip())

        # -- Step 2: build _by_id --
        # Tracks whether we have already set coordinates for each stop_id
        # (we use the first occurrence's coordinate, not a centroid — the
        # engine already proved zero missing/phantom keys and the 80 names
        # with >1 km spread correspond to genuinely different physical poles
        # keyed by distinct stop_ids, so first-occurrence coords are stable
        # per pole).
        _coord_set: Set[str] = set()

        for key, entries in engine.stop_to_directions.items():
            if key not in all_stop_ids:
                # This key is a normalized stop name, not a stop ID; skip here.
                continue

            stop_id = key  # already stripped in engine._load_network

            for rid, did, s_idx in entries:
                r_data = engine.routes.get(rid)
                if r_data is None:
                    continue
                d_data = r_data.get("directions", {}).get(str(did))
                if d_data is None or d_data.get("status") != "SUCCESS":
                    continue

                coords = d_data.get("stop_coordinates", [])
                snames = d_data.get("ordered_stop_names", [])

                if s_idx >= len(coords) or s_idx >= len(snames):
                    continue  # malformed direction; skip safely

                if stop_id in self._by_id:
                    # Already seen: increment serving count, leave coords/name
                    # unchanged (first-occurrence wins).
                    self._by_id[stop_id].route_direction_count += 1
                else:
                    lat = float(coords[s_idx][0])
                    lon = float(coords[s_idx][1])
                    display_name = str(snames[s_idx]).strip()
                    name_norm = display_name.lower()
                    self._by_id[stop_id] = StopEntry(
                        stop_id=stop_id,
                        display_name=display_name,
                        name_normalized=name_norm,
                        lat=lat,
                        lon=lon,
                        route_direction_count=1,
                    )
                    _coord_set.add(stop_id)

        # -- Step 3: build _by_name --
        for entry in self._by_id.values():
            key = entry.name_normalized
            if key not in self._by_name:
                self._by_name[key] = []
            self._by_name[key].append(entry)

        # Stable sort within each name bucket: by stop_id ascending so results
        # are deterministic across Python runs (PYTHONHASHSEED-independent).
        for bucket in self._by_name.values():
            bucket.sort(key=lambda e: e.stop_id)

        # -- Step 4: sorted name list for prefix search --
        self._prefix_sorted = sorted(self._by_name.keys())

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def search_stops(self, query: str, limit: int = 10) -> List[StopEntry]:
        """
        Autocomplete / lookup stops matching *query*.

        Matching order (highest priority first):
        1. Exact stop ID match — query equals a physical stop_id.
        2. Exact normalized name match — query.strip().lower() equals a full
           normalized name.
        3. Prefix match — normalized names starting with query.strip().lower(),
           in alphabetical order.
        4. Substring fallback — only applied when fewer than *limit* results
           have been found after prefix scan.

        Stop IDs are deduplicated; each physical pole appears at most once.
        Returns at most *limit* StopEntry objects.

        Parameters
        ----------
        query : str
            User input string.  May be a stop ID, full name, or prefix.
        limit : int
            Maximum number of results to return.  Default 10.

        Returns
        -------
        List[StopEntry]
            Matching stops in priority order.
        """
        if not query or not query.strip():
            return []

        limit = max(1, int(limit))
        seen_ids: Set[str] = set()
        results: List[StopEntry] = []

        def _add(entry: StopEntry) -> bool:
            """Add entry if not already seen; return True if limit reached."""
            if entry.stop_id not in seen_ids:
                seen_ids.add(entry.stop_id)
                results.append(entry)
            return len(results) >= limit

        # 1. Exact stop ID match
        query_stripped = query.strip()
        exact_id = self._by_id.get(query_stripped)
        if exact_id is not None:
            if _add(exact_id):
                return results

        # 2. Exact normalized name match
        query_norm = query_stripped.lower()
        for entry in self._by_name.get(query_norm, []):
            if _add(entry):
                return results

        # 3. Prefix scan using bisect on _prefix_sorted
        lo = bisect.bisect_left(self._prefix_sorted, query_norm)
        for name_key in self._prefix_sorted[lo:]:
            if not name_key.startswith(query_norm):
                break
            if name_key == query_norm:
                # Already added in step 2; don't duplicate
                continue
            for entry in self._by_name[name_key]:
                if _add(entry):
                    return results

        # 4. Substring fallback (only if still below limit)
        if len(results) < limit:
            for name_key in self._prefix_sorted:
                if query_norm in name_key and not name_key.startswith(query_norm):
                    for entry in self._by_name[name_key]:
                        if _add(entry):
                            return results

        return results

    def get_stop_by_id(self, stop_id: str) -> Optional[StopEntry]:
        """
        Direct lookup of a physical stop by its ID string.

        Parameters
        ----------
        stop_id : str
            Physical stop identifier (e.g. "STOP_04160").

        Returns
        -------
        StopEntry or None if the stop ID is not in the index.
        """
        return self._by_id.get(str(stop_id).strip())

    def get_reachable_destinations(
        self, origin_stop_id: str, limit: int = 50
    ) -> List[DestEntry]:
        """
        Returns all bus stops reachable from *origin_stop_id* via the
        reconstructed route network, in a single direct ride (no transfers).

        **Structural connectivity only** — this reflects route topology as
        recorded in reconstructed_routes.json.  It does NOT indicate that a
        live bus is available, or that any bus will arrive within any deadline.

        A destination stop is included when there exists at least one
        (route_id, direction_id) pair in which *origin_stop_id* appears at
        sequence position i, and the destination stop appears at position j > i
        in the same direction (forward travel only, matching the engine's
        existing find_candidate_routes semantics).

        Results are sorted by:
        - serving_direction_count descending (more routes = more options)
        - display_name ascending (deterministic tie-break)

        Parameters
        ----------
        origin_stop_id : str
            Physical stop ID for the origin pole.
        limit : int
            Maximum number of destination entries to return.  Default 50.

        Returns
        -------
        List[DestEntry]
            Reachable destination stops, sorted as described above.
        """
        origin_key = str(origin_stop_id).strip()
        engine = self._engine

        # Sanitize limit: safe parsing, fallback to default 50 on invalid, early return on <= 0
        if limit is None:
            safe_limit = 50
        else:
            try:
                safe_limit = int(float(limit))
            except (ValueError, TypeError, OverflowError):
                safe_limit = 50

        if safe_limit <= 0:
            return []

        # Directions that serve this origin stop (by physical ID)
        origin_entries: List[Tuple[str, int, int]] = engine.stop_to_directions.get(
            origin_key, []
        )

        if not origin_entries:
            return []

        # dest_stop_id -> {"name": str, "dirs": set of (rid, did)}
        dest_accum: Dict[str, Dict] = {}

        for rid, did, origin_idx in origin_entries:
            r_data = engine.routes.get(rid)
            if r_data is None:
                continue
            d_data = r_data.get("directions", {}).get(str(did))
            if d_data is None or d_data.get("status") != "SUCCESS":
                continue

            stop_ids = d_data.get("ordered_stop_ids", [])
            stop_names = d_data.get("ordered_stop_names", [])

            # Enumerate every stop after origin_idx in this direction
            for dest_idx in range(origin_idx + 1, len(stop_ids)):
                dest_sid = str(stop_ids[dest_idx]).strip()
                dest_name = str(stop_names[dest_idx]).strip()

                if dest_sid == origin_key:
                    # Route loops back to origin — skip to avoid circular entry
                    continue

                if dest_sid not in dest_accum:
                    dest_accum[dest_sid] = {
                        "name": dest_name,
                        "dirs": set(),
                    }
                dest_accum[dest_sid]["dirs"].add((rid, did))

        if not dest_accum:
            return []

        # Build DestEntry list and sort
        dest_list: List[DestEntry] = []
        for dest_sid, info in dest_accum.items():
            display_name = info["name"]
            dest_list.append(
                DestEntry(
                    stop_id=dest_sid,
                    display_name=display_name,
                    name_normalized=display_name.lower(),
                    serving_direction_count=len(info["dirs"]),
                )
            )

        dest_list.sort(
            key=lambda d: (-d.serving_direction_count, d.display_name.lower())
        )

        return dest_list[:safe_limit]

    # ------------------------------------------------------------------
    # Diagnostics
    # ------------------------------------------------------------------

    def stats(self) -> Dict[str, int]:
        """
        Returns summary counts suitable for health-check responses and logging.

        Returns
        -------
        dict with keys:
            indexed_stop_ids   — number of unique physical stop IDs in the index
            indexed_name_keys  — number of unique normalised name strings
        """
        return {
            "indexed_stop_ids": len(self._by_id),
            "indexed_name_keys": len(self._by_name),
        }
