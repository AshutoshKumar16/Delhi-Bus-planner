/**
 * Frontend API client communicating with Flask backend.
 */

import type {
  HealthCheckResponse,
  JourneyRecommendRequest,
  JourneyRecommendResponse,
  ReachableDestinationsResponse,
  StopSearchResponse,
} from './types';

export interface ApiError extends Error {
  errorType?: string;
}

export async function fetchHealth(): Promise<HealthCheckResponse> {
  const res = await fetch('/api/health');
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(
      errorData.message || `Health check failed with status ${res.status}`
    );
  }
  return res.json();
}

export async function fetchStopSearch(
  query: string,
  limit: number = 10,
  signal?: AbortSignal
): Promise<StopSearchResponse> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  const res = await fetch(`/api/stops/search?${params.toString()}`, { signal });
  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const msg = data?.message || `Stop search failed with status ${res.status}`;
    const err: ApiError = new Error(msg);
    err.errorType = data?.error_type;
    throw err;
  }

  return data as StopSearchResponse;
}

export async function fetchReachableDestinations(
  originId: string,
  limit: number = 50,
  signal?: AbortSignal
): Promise<ReachableDestinationsResponse> {
  const params = new URLSearchParams({ origin_id: originId, limit: String(limit) });
  const res = await fetch(`/api/stops/destinations?${params.toString()}`, { signal });
  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const msg =
      data?.message || `Destination lookup failed with status ${res.status}`;
    const err: ApiError = new Error(msg);
    err.errorType = data?.error_type;
    throw err;
  }

  return data as ReachableDestinationsResponse;
}

export async function fetchJourneyRecommendation(
  params: JourneyRecommendRequest
): Promise<JourneyRecommendResponse> {
  const res = await fetch('/api/journey/recommend', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  });

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const msg = data?.message || `Request failed with HTTP status ${res.status}`;
    const err: ApiError = new Error(msg);
    err.errorType = data?.error_type;
    throw err;
  }

  return data as JourneyRecommendResponse;
}
