import React, { useEffect, useMemo, useState } from 'react';
import { fetchHealth, fetchJourneyRecommendation } from './api';
import type {
  CandidateBus,
  HealthCheckResponse,
  JourneyRecommendResponse,
} from './types';
import {
  combineDateAndTimeToUnix,
  getDefaultReachByTime,
  getHumanDeadlinePreview,
  toLocalDateString,
} from './timeUtils';
import { useMediaQuery } from './hooks/useMediaQuery';
import { TopBar } from './components/TopBar';
import { PlannerForm } from './components/PlannerForm';
import { RecommendationCard } from './components/RecommendationCard';
import { EvidenceDisclosure } from './components/EvidenceDisclosure';
import { AlternativesList } from './components/AlternativesList';
import { MapPanel } from './components/MapPanel';
import './App.css';

export const App: React.FC = () => {
  // Screen size check: desktop is >= 1024px
  const isDesktop = useMediaQuery('(min-width: 1024px)');

  // Form State
  const [fromStop, setFromStop] = useState<string>('Mahindra Park');
  const [toStop, setToStop] = useState<string>('Azadpur');
  const [reachByDate, setReachByDate] = useState<string>(() => toLocalDateString());
  const [reachByTime, setReachByTime] = useState<string>(() => getDefaultReachByTime());

  // Telemetry Mode ('live' | 'replay')
  const [telemetryMode, setTelemetryMode] = useState<'live' | 'replay'>('live');

  // Async States
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<JourneyRecommendResponse | null>(null);

  // Selected candidate vehicle ID override (when user clicks an alternative)
  const [selectedIdOverride, setSelectedIdOverride] = useState<string | null>(null);

  // Health Status
  const [health, setHealth] = useState<HealthCheckResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  // Derived selected vehicle ID: defaults to recommended bus, or first candidate
  const selectedVehicleId =
    selectedIdOverride ??
    result?.recommended_candidate?.vehicle_id ??
    result?.alternative_candidates?.[0]?.vehicle_id ??
    '';

  // Human-friendly preview of selected deadline (e.g. "Today · 8:15 PM")
  const humanDeadlinePreview = useMemo(() => {
    return getHumanDeadlinePreview(reachByDate, reachByTime);
  }, [reachByDate, reachByTime]);

  // Load system health on mount
  useEffect(() => {
    fetchHealth()
      .then((data) => setHealth(data))
      .catch((err) => setHealthError(err.message));
  }, []);

  const handleSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();

    if (!fromStop.trim() || !toStop.trim()) {
      setError('Please enter both an origin stop and a destination stop.');
      return;
    }

    const parsed = combineDateAndTimeToUnix(reachByDate, reachByTime, new Date());
    if (parsed.error || !parsed.unixSeconds) {
      setError(parsed.error || 'Please provide a valid reach-by date and time.');
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);
    setSelectedIdOverride(null);

    try {
      const response = await fetchJourneyRecommendation({
        from: fromStop.trim(),
        to: toStop.trim(),
        reach_by: parsed.unixSeconds,
      });
      setResult(response);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unable to plan journey. Please verify your connection.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleSwapStops = () => {
    const temp = fromStop;
    setFromStop(toStop);
    setToStop(temp);
    setResult(null);
    setError(null);
    setSelectedIdOverride(null);
  };

  // Find currently selected candidate bus
  const activeCandidate: CandidateBus | null = useMemo(() => {
    if (!result) return null;
    if (result.recommended_candidate?.vehicle_id === selectedVehicleId) {
      return result.recommended_candidate;
    }
    const foundAlt = result.alternative_candidates?.find(
      (c) => c.vehicle_id === selectedVehicleId
    );
    if (foundAlt) return foundAlt;
    const foundUnrel = result.unreliable_candidates?.find(
      (c) => c.vehicle_id === selectedVehicleId
    );
    if (foundUnrel) return foundUnrel;
    return result.recommended_candidate || null;
  }, [result, selectedVehicleId]);

  const rec = result?.recommended_candidate;

  // Extract coordinate geometry from activeCandidate
  const originCoords = useMemo<[number, number] | null>(() => {
    if (
      activeCandidate?.pickup?.latitude != null &&
      activeCandidate?.pickup?.longitude != null &&
      !isNaN(activeCandidate.pickup.latitude) &&
      !isNaN(activeCandidate.pickup.longitude)
    ) {
      return [activeCandidate.pickup.latitude, activeCandidate.pickup.longitude];
    }
    return null;
  }, [activeCandidate]);

  const destinationCoords = useMemo<[number, number] | null>(() => {
    if (
      activeCandidate?.destination?.latitude != null &&
      activeCandidate?.destination?.longitude != null &&
      !isNaN(activeCandidate.destination.latitude) &&
      !isNaN(activeCandidate.destination.longitude)
    ) {
      return [activeCandidate.destination.latitude, activeCandidate.destination.longitude];
    }
    return null;
  }, [activeCandidate]);

  const routeGeometry = useMemo<[number, number][] | null>(() => {
    if (
      activeCandidate?.route_path &&
      Array.isArray(activeCandidate.route_path) &&
      activeCandidate.route_path.length > 0
    ) {
      return activeCandidate.route_path;
    }
    return null;
  }, [activeCandidate]);

  // Shared map element props
  const mapProps = {
    originName: activeCandidate?.pickup?.stop_name || (result ? result.query.origin_stop : fromStop),
    destinationName: activeCandidate?.destination?.stop_name || (result ? result.query.destination_stop : toStop),
    originCoords,
    destinationCoords,
    activeCandidate,
    routeGeometry,
    hasSearched: !!result,
  };

  return (
    <div className="planner-root">
      {/* Slim Top Bar */}
      <TopBar
        telemetryMode={telemetryMode}
        onModeChange={setTelemetryMode}
        health={health}
        healthError={healthError}
      />

      {/* Main Viewport Area */}
      <main className="planner-viewport">
        <div className="planner-container">
          {/* LEFT Column: Planner Form + Results (Internally scrollable on desktop) */}
          <div className="planner-column">
            {/* 1. Journey Planner Form */}
            <PlannerForm
              fromStop={fromStop}
              setFromStop={setFromStop}
              toStop={toStop}
              setToStop={setToStop}
              reachByDate={reachByDate}
              setReachByDate={setReachByDate}
              reachByTime={reachByTime}
              setReachByTime={setReachByTime}
              humanDeadlinePreview={humanDeadlinePreview}
              loading={loading}
              onSearch={handleSearch}
              onSwap={handleSwapStops}
              telemetryMode={telemetryMode}
              replayTimestampContext={result?.query.prediction_time_formatted}
            />

            {/* Error Notification */}
            {error && (
              <div className="action-notification error-banner" role="alert">
                <div className="notification-icon" aria-hidden="true">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                </div>
                <div className="notification-text">
                  <strong>Unable to plan journey</strong>
                  <p>{error}</p>
                </div>
              </div>
            )}

            {/* Loading State */}
            {loading && (
              <div className="loading-state-card" role="status" aria-live="polite">
                <div className="loading-spinner-ring" aria-hidden="true" />
                <div className="loading-copy">
                  <h3 className="loading-title">Evaluating Corridor Telemetry</h3>
                  <p className="loading-subtitle">
                    Projecting vehicle positions and computing arrival probabilities...
                  </p>
                </div>
              </div>
            )}

            {/* Non-Desktop Map (Tablet & Mobile: positioned after planner card if no results) */}
            {!isDesktop && !result && !loading && (
              <div className="mobile-map-slot">
                <MapPanel {...mapProps} />
              </div>
            )}

            {/* Results Presentation */}
            {result && (
              <div className="results-container" aria-live="polite">
                {/* Boundary State Notices */}
                {result.system_state === 'NO_DIRECT_ROUTE' && (
                  <div className="status-notice-card" role="status">
                    <div className="notice-icon" aria-hidden="true">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
                      </svg>
                    </div>
                    <div className="notice-content">
                      <h3 className="notice-title">No Direct Route Found</h3>
                      <p className="notice-desc">
                        No direct bus route was found connecting <strong>{result.query.origin_stop}</strong> and{' '}
                        <strong>{result.query.destination_stop}</strong> in the network.
                      </p>
                      <p className="direct-only-note">Showing direct buses only. Transfers are not supported yet.</p>
                    </div>
                  </div>
                )}

                {result.system_state === 'NO_CANDIDATE_BUS' && (
                  <div className="status-notice-card" role="status">
                    <div className="notice-icon" aria-hidden="true">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" />
                        <polyline points="12 6 12 12 16 14" />
                      </svg>
                    </div>
                    <div className="notice-content">
                      <h3 className="notice-title">No Buses Currently Upstream</h3>
                      <p className="notice-desc">
                        Direct routes connect <strong>{result.query.origin_stop}</strong> to{' '}
                        <strong>{result.query.destination_stop}</strong>, but there are no active buses currently traveling upstream between the depot and your pickup stop.
                      </p>
                      <p className="direct-only-note">Showing direct buses only. Transfers are not supported yet.</p>
                    </div>
                  </div>
                )}

                {result.system_state === 'NO_RELIABLE_JOURNEY' && (
                  <div className="status-notice-card status-notice-warning" role="status">
                    <div className="notice-icon" aria-hidden="true">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                        <line x1="12" y1="9" x2="12" y2="13" />
                        <line x1="12" y1="17" x2="12.01" y2="17" />
                      </svg>
                    </div>
                    <div className="notice-content">
                      <h3 className="notice-title">Deadline Cannot Be Reliably Met</h3>
                      <p className="notice-desc">
                        None of the active buses are estimated to reach{' '}
                        <strong>{result.query.destination_stop}</strong> before your deadline.
                      </p>
                      <p className="direct-only-note">Showing direct buses only. Transfers are not supported yet.</p>
                    </div>
                  </div>
                )}

                {result.system_state === 'INSUFFICIENT_DATA' && (
                  <div className="status-notice-card" role="status">
                    <div className="notice-icon" aria-hidden="true">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="16" x2="12" y2="12" />
                        <line x1="12" y1="8" x2="12.01" y2="8" />
                      </svg>
                    </div>
                    <div className="notice-content">
                      <h3 className="notice-title">Insufficient Historical Evidence</h3>
                      <p className="notice-desc">
                        Empirical segment observations for this corridor are insufficient to compute arrival probabilities defensibly.
                      </p>
                      <p className="direct-only-note">Showing direct buses only. Transfers are not supported yet.</p>
                    </div>
                  </div>
                )}

                {/* 2. Results Header (Title + Direct-Only Note) */}
                {rec && (
                  <div className="results-header-block">
                    <h2 className="results-header-title">Recommended journey</h2>
                    <p className="direct-only-note">
                      Showing direct buses only. Transfers are not supported yet.
                    </p>
                  </div>
                )}

                {/* 3. Recommended Journey Card */}
                {rec && (
                  <RecommendationCard
                    candidate={rec}
                    response={result}
                    isSelected={selectedVehicleId === rec.vehicle_id}
                    onSelect={() => setSelectedIdOverride(rec.vehicle_id)}
                  />
                )}

                {/* Non-Desktop Map (Tablet & Mobile: positioned right after recommended card) */}
                {!isDesktop && (
                  <div className="mobile-map-slot">
                    <MapPanel {...mapProps} />
                  </div>
                )}

                {/* 4. Collapsible Technical Disclosure */}
                {rec && (
                  <EvidenceDisclosure
                    candidate={rec}
                    comparison={result.comparison_with_fastest_eta}
                  />
                )}

                {/* 5. Alternatives List */}
                <AlternativesList
                  alternatives={result.alternative_candidates}
                  unreliableCandidates={result.unreliable_candidates}
                  selectedVehicleId={selectedVehicleId}
                  onSelectCandidate={(cand) => setSelectedIdOverride(cand.vehicle_id)}
                />
              </div>
            )}
          </div>

          {/* RIGHT Column: MapPanel (Desktop >= 1024px: fills 100% height, zero overlay) */}
          {isDesktop && (
            <div className="map-column">
              <MapPanel {...mapProps} />
            </div>
          )}
        </div>
      </main>
    </div>
  );
};

export default App;
