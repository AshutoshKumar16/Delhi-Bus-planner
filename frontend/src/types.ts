/**
 * TypeScript types for Delhi Bus Journey Recommendation API
 */

export interface JourneyRecommendRequest {
  from: string;
  to: string;
  reach_by: string | number;
  prediction_time?: number;
}

export interface VehiclePosition {
  latitude: number | null;
  longitude: number | null;
  speed_mps_or_null?: number | null;
  speed_kmh_or_null?: number | null;
  timestamp_unix?: number | null;
}

export interface CandidateBus {
  recommendation_rank?: number;
  recommendation_tier?: string;
  route_id: string;
  direction_id: number;
  vehicle_id: string;
  vehicle_position?: VehiclePosition | null;
  bus_position?: {
    lat: number;
    lon: number;
  };
  data_freshness: {
    telemetry_age_seconds: number;
    status: 'FRESH' | 'MODERATE' | 'STALE';
  };
  pickup: {
    stop_id?: string;
    stop_name: string;
    latitude?: number | null;
    longitude?: number | null;
    distance_meters: number;
    expected_wait_minutes: number;
    expected_pickup_eta: string;
    pickup_std_seconds: number;
    coordinates?: [number, number];
  };
  in_vehicle: {
    distance_meters: number;
    stops_count: number;
    expected_travel_time_minutes: number;
    std_travel_time_seconds: number;
  };
  destination: {
    stop_id?: string;
    stop_name: string;
    latitude?: number | null;
    longitude?: number | null;
    total_distance_meters: number;
    expected_travel_time_minutes: number;
    expected_arrival: string;
    uncertainty_interval_80pct_minutes: [number, number];
    standard_deviation_seconds: number;
    corridor_percentile_bounds_minutes?: [number, number];
    implied_speed_kmh: number;
    coordinates?: [number, number];
  };
  route_path?: [number, number][] | null;
  route_path_type?: string | null;
  deadline_probability: {
    probability_on_time: number;
    probability_on_time_pct: number;
    probability_miss: number;
    probability_miss_pct: number;
    confidence_tier: string;
    slack_minutes: number;
  };
  route_reconstruction_confidence: number;
  evidence_samples: number;
}

export interface FastestEtaComparison {
  is_same_choice: boolean;
  divergence_explanation?: string;
  fastest_eta_baseline_choice?: {
    route_id: string;
    vehicle_id: string;
    expected_arrival: string;
    expected_travel_time_minutes: number;
    probability_on_time_pct: number;
    uncertainty_std_seconds: number;
  };
}

export interface JourneyRecommendResponse {
  status: 'success' | 'error';
  system_state:
    | 'RECOMMENDED'
    | 'ALTERNATIVE'
    | 'NO_RELIABLE_JOURNEY'
    | 'NO_CANDIDATE_BUS'
    | 'NO_DIRECT_ROUTE'
    | 'INSUFFICIENT_DATA'
    | string;
  message?: string;
  query: {
    origin_stop: string;
    destination_stop: string;
    reach_by_formatted: string;
    reach_by_unix: number;
    prediction_time_formatted: string;
    prediction_timestamp_unix: number;
    time_budget_minutes: number;
  };
  recommended_candidate: CandidateBus | null;
  alternative_candidates: CandidateBus[];
  unreliable_candidates?: CandidateBus[];
  comparison_with_fastest_eta?: FastestEtaComparison;
  summary: {
    candidate_routes_count: number;
    viable_candidates_count: number;
    rejected_candidates_count: number;
    execution_time_ms: number;
  };
  error_type?: string;
}

export interface HealthCheckResponse {
  status: string;
  service: string;
  version: string;
  uptime_seconds: number;
  network: {
    reconstructed_routes_indexed: number;
    route_segments_indexed: number;
    distinct_stop_keys_indexed: number;
  };
  timestamp_formatted: string;
  timestamp_unix: number;
}
