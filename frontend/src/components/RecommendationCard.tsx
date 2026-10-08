import React from 'react';
import type { CandidateBus, JourneyRecommendResponse } from '../types';
import { formatArrivalWindow, formatTimeTo12Hour } from '../timeUtils';

interface RecommendationCardProps {
  candidate: CandidateBus;
  response: JourneyRecommendResponse;
  isSelected?: boolean;
  onSelect?: () => void;
}

export const RecommendationCard: React.FC<RecommendationCardProps> = ({
  candidate,
  response,
  isSelected,
  onSelect,
}) => {
  const probPct = candidate.deadline_probability.probability_on_time_pct;
  const slack = candidate.deadline_probability.slack_minutes;

  // Semantic reliability level with icon and text
  const reliability =
    probPct >= 80
      ? {
          tierClass: 'tier-high',
          badgeText: 'High chance',
          label: 'Estimated high reliability',
        }
      : probPct >= 50
      ? {
          tierClass: 'tier-medium',
          badgeText: 'Moderate risk',
          label: 'Estimated moderate risk',
        }
      : {
          tierClass: 'tier-low',
          badgeText: 'Low chance',
          label: 'High chance of arriving after deadline',
        };

  // Plain-language slack description
  const slackDescription =
    slack > 0
      ? `Arrives ${slack} min before your deadline`
      : slack === 0
      ? 'Arrives right on your deadline'
      : `Arrives ${Math.abs(slack)} min after your deadline`;

  // 80% Arrival Window if available
  const arrivalWindow = formatArrivalWindow(
    response.query.prediction_timestamp_unix,
    candidate.destination.uncertainty_interval_80pct_minutes
  );

  // One-sentence plain-language reason composed ONLY from returned numbers
  const composeWhyRecommended = (): string => {
    if (response.comparison_with_fastest_eta) {
      if (response.comparison_with_fastest_eta.is_same_choice) {
        return `Offers both the earliest arrival and highest estimated on-time likelihood (${probPct}%) among detected buses, with a ${Math.abs(slack)} min ${slack >= 0 ? 'safety margin' : 'deficit'}.`;
      }
      if (response.comparison_with_fastest_eta.divergence_explanation) {
        return response.comparison_with_fastest_eta.divergence_explanation;
      }
    }

    const candidateCount =
      response.summary.viable_candidates_count ||
      (response.alternative_candidates ? response.alternative_candidates.length + 1 : 1);

    if (candidateCount > 1) {
      return `Provides the highest estimated chance of arriving on time (${probPct}%) among ${candidateCount} active corridor buses, arriving ${slackDescription.toLowerCase()}.`;
    }

    return `Single active direct bus detected on this corridor, arriving ${slackDescription.toLowerCase()} with ${probPct}% estimated on-time probability.`;
  };

  return (
    <article
      className={`recommendation-card ${isSelected ? 'is-selected' : ''}`}
      onClick={onSelect}
      aria-label={`Recommended journey: Take bus ${candidate.vehicle_id}`}
    >
      {/* Card Header: Headline Answer & Route ID */}
      <div className="rec-top-row">
        <div className="rec-headline-block">
          <span className="rec-pill-badge">BEST OPTION</span>
          <h3 className="rec-headline">
            Take bus <span className="vehicle-id-highlight">{candidate.vehicle_id}</span>
          </h3>
          {candidate.route_id && (
            <div className="rec-route-chip">
              <span className="route-chip-label">Route</span>
              <span className="route-chip-number">{candidate.route_id}</span>
            </div>
          )}
        </div>

        {/* Large Probability Display */}
        <div className={`rec-probability-box ${reliability.tierClass}`}>
          <div className="prob-number-row">
            <span className="prob-number">{probPct}%</span>
          </div>
          <span className="prob-caption">estimated on-time chance</span>
          <span className="prob-tier-text">{reliability.label}</span>
        </div>
      </div>

      {/* Key Facts Grid */}
      <div className="rec-facts-grid">
        {/* Expected Arrival */}
        <div className="fact-item">
          <span className="fact-label">Expected Arrival</span>
          <span className="fact-value tabular">
            {formatTimeTo12Hour(candidate.destination.expected_arrival)}
          </span>
          {arrivalWindow ? (
            <span className="fact-subtext">Window: {arrivalWindow}</span>
          ) : (
            <span className="fact-subtext">At {candidate.destination.stop_name}</span>
          )}
        </div>

        {/* Remaining Travel Time */}
        <div className="fact-item">
          <span className="fact-label">Travel Time Remaining</span>
          <span className="fact-value tabular">
            ~{candidate.destination.expected_travel_time_minutes} min
          </span>
          <span className="fact-subtext">
            {(candidate.destination.total_distance_meters / 1000).toFixed(1)} km to destination
          </span>
        </div>

        {/* Safety Margin / Slack */}
        <div className="fact-item">
          <span className="fact-label">Deadline Margin</span>
          <span
            className={`fact-value tabular ${slack >= 0 ? 'margin-positive' : 'margin-negative'}`}
          >
            {slack > 0 ? `+${slack} min` : `${slack} min`}
          </span>
          <span className="fact-subtext">{slackDescription}</span>
        </div>
      </div>

      {/* Pickup / Wait Info (if provided) */}
      {candidate.pickup && (
        <div className="rec-pickup-strip">
          <div className="pickup-strip-icon" aria-hidden="true">
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          </div>
          <div className="pickup-strip-text">
            <span>Board at <strong>{candidate.pickup.stop_name}</strong></span>
            <span className="strip-dot">&bull;</span>
            <span>
              Bus reaches pickup in ~<strong>{candidate.pickup.expected_wait_minutes} min</strong>{' '}
              ({formatTimeTo12Hour(candidate.pickup.expected_pickup_eta)})
            </span>
          </div>
        </div>
      )}

      {/* Plain Language "Why Recommended" */}
      <div className="why-recommended-box">
        <span className="why-icon" aria-hidden="true">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </span>
        <p className="why-text">{composeWhyRecommended()}</p>
      </div>
    </article>
  );
};
