/**
 * Frontend API client communicating with Flask backend.
 */

import type {
  HealthCheckResponse,
  JourneyRecommendRequest,
  JourneyRecommendResponse,
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
