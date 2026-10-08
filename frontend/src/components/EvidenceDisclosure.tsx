import React from 'react';
import type { CandidateBus, FastestEtaComparison } from '../types';

interface EvidenceDisclosureProps {
  candidate: CandidateBus;
  comparison?: FastestEtaComparison;
}

export const EvidenceDisclosure: React.FC<EvidenceDisclosureProps> = ({
  candidate,
  comparison,
}) => {
  return (
    <details className="evidence-disclosure">
      <summary className="evidence-summary">
        <span className="summary-title">How this was estimated</span>
        <span className="summary-badge">{candidate.evidence_samples} GPS samples</span>
      </summary>

      <div className="evidence-content">
        <p className="evidence-caption">
          Estimated based on archived GPS observations and empirical corridor segment travel-time distributions. Not a static schedule guarantee.
        </p>

        <div className="evidence-grid">
          <div className="evidence-item">
            <span className="evidence-label">Telemetry Freshness</span>
            <span className="evidence-value">
              {candidate.data_freshness.telemetry_age_seconds}s ago ({candidate.data_freshness.status.toLowerCase()})
            </span>
          </div>

          <div className="evidence-item">
            <span className="evidence-label">Empirical Evidence</span>
            <span className="evidence-value">
              {candidate.evidence_samples} historical observations
            </span>
          </div>

          <div className="evidence-item">
            <span className="evidence-label">Route Confidence</span>
            <span className="evidence-value">
              {Math.round(candidate.route_reconstruction_confidence * 100)}%
            </span>
          </div>

          <div className="evidence-item">
            <span className="evidence-label">Implied Corridor Speed</span>
            <span className="evidence-value">
              {candidate.destination.implied_speed_kmh} km/h
            </span>
          </div>

          <div className="evidence-item">
            <span className="evidence-label">Travel Time Variance</span>
            <span className="evidence-value">
              &plusmn;{Math.round(candidate.destination.standard_deviation_seconds)}s std dev
            </span>
          </div>

          {candidate.in_vehicle && (
            <div className="evidence-item">
              <span className="evidence-label">Transit Intermediate Stops</span>
              <span className="evidence-value">
                {candidate.in_vehicle.stops_count} stops ({(candidate.in_vehicle.distance_meters / 1000).toFixed(1)} km)
              </span>
            </div>
          )}
        </div>

        {comparison && (
          <div className="evidence-comparison-note">
            <span className="comparison-tag">ETA Comparison</span>
            <span className="comparison-text">
              {comparison.is_same_choice
                ? 'Selected bus matches the earliest-ETA baseline candidate while offering highest deadline reliability.'
                : comparison.divergence_explanation || 'Differs from naive earliest-ETA choice to protect against traffic variance.'}
            </span>
          </div>
        )}
      </div>
    </details>
  );
};
