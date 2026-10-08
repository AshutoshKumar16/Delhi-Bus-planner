import React, { useEffect, useMemo, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { CandidateBus } from '../types';

// Fix Vite default marker icon paths if standard Leaflet icon is ever instantiated
delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

// Custom crisp SVG divIcons for origin, destination, and bus pins
const createFromIcon = (label: string) =>
  L.divIcon({
    className: 'leaflet-div-marker-wrapper',
    html: `<div class="transit-pin pin-from" title="Pickup: ${label}">
      <span class="pin-symbol">Pickup</span>
    </div>`,
    iconSize: [60, 24],
    iconAnchor: [30, 24],
  });

const createToIcon = (label: string) =>
  L.divIcon({
    className: 'leaflet-div-marker-wrapper',
    html: `<div class="transit-pin pin-to" title="Destination: ${label}">
      <span class="pin-symbol">Destination</span>
    </div>`,
    iconSize: [84, 24],
    iconAnchor: [42, 24],
  });

const createBusMarkerIcon = (vehicleId: string) =>
  L.divIcon({
    className: 'leaflet-div-marker-wrapper',
    html: `<div class="transit-pin pin-vehicle" title="Selected Bus: ${vehicleId}">
      <span class="pin-bus-icon">Bus</span>
      <span class="pin-bus-plate">${vehicleId}</span>
    </div>`,
    iconSize: [96, 24],
    iconAnchor: [48, 24],
  });

interface MapControllerProps {
  points: [number, number][];
}

const MapController: React.FC<MapControllerProps> = ({ points }) => {
  const map = useMap();
  const serialized = useMemo(() => JSON.stringify(points), [points]);

  useEffect(() => {
    // Invalidate size on initial mount and layout shifts
    map.invalidateSize();
    const timer = setTimeout(() => {
      map.invalidateSize();
    }, 250);

    return () => clearTimeout(timer);
  }, [map]);

  useEffect(() => {
    if (points.length > 1) {
      const bounds = L.latLngBounds(points.map(([lat, lng]) => [lat, lng]));
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 15 });
    } else if (points.length === 1) {
      map.setView(points[0], 13);
    }
  }, [map, serialized, points]);

  return null;
};

interface MapPanelProps {
  originName?: string;
  destinationName?: string;
  originCoords?: [number, number] | null;
  destinationCoords?: [number, number] | null;
  activeCandidate?: CandidateBus | null;
  routeGeometry?: [number, number][] | null;
  hasSearched?: boolean;
}

const DELHI_CENTER: [number, number] = [28.6139, 77.209];
const DEFAULT_ZOOM = 11;

export const MapPanel: React.FC<MapPanelProps> = ({
  originName,
  destinationName,
  originCoords,
  destinationCoords,
  activeCandidate,
  routeGeometry,
  hasSearched,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);

  // 1. Pickup coordinates from activeCandidate or override
  const pickupCoords = useMemo<[number, number] | null>(() => {
    if (
      activeCandidate?.pickup?.latitude != null &&
      activeCandidate?.pickup?.longitude != null &&
      !isNaN(activeCandidate.pickup.latitude) &&
      !isNaN(activeCandidate.pickup.longitude)
    ) {
      return [activeCandidate.pickup.latitude, activeCandidate.pickup.longitude];
    }
    if (
      originCoords &&
      originCoords.length >= 2 &&
      originCoords[0] != null &&
      originCoords[1] != null &&
      !isNaN(originCoords[0]) &&
      !isNaN(originCoords[1])
    ) {
      return originCoords;
    }
    return null;
  }, [activeCandidate, originCoords]);

  // 2. Destination coordinates from activeCandidate or override
  const destCoords = useMemo<[number, number] | null>(() => {
    if (
      activeCandidate?.destination?.latitude != null &&
      activeCandidate?.destination?.longitude != null &&
      !isNaN(activeCandidate.destination.latitude) &&
      !isNaN(activeCandidate.destination.longitude)
    ) {
      return [activeCandidate.destination.latitude, activeCandidate.destination.longitude];
    }
    if (
      destinationCoords &&
      destinationCoords.length >= 2 &&
      destinationCoords[0] != null &&
      destinationCoords[1] != null &&
      !isNaN(destinationCoords[0]) &&
      !isNaN(destinationCoords[1])
    ) {
      return destinationCoords;
    }
    return null;
  }, [activeCandidate, destinationCoords]);

  // 3. Selected bus position from vehicle_position (or fallback)
  const busCoords = useMemo<[number, number] | null>(() => {
    if (!activeCandidate) return null;
    if (
      activeCandidate.vehicle_position?.latitude != null &&
      activeCandidate.vehicle_position?.longitude != null &&
      !isNaN(activeCandidate.vehicle_position.latitude) &&
      !isNaN(activeCandidate.vehicle_position.longitude)
    ) {
      return [
        activeCandidate.vehicle_position.latitude,
        activeCandidate.vehicle_position.longitude,
      ];
    }
    if (
      activeCandidate.bus_position &&
      activeCandidate.bus_position.lat != null &&
      activeCandidate.bus_position.lon != null &&
      !isNaN(activeCandidate.bus_position.lat) &&
      !isNaN(activeCandidate.bus_position.lon)
    ) {
      return [activeCandidate.bus_position.lat, activeCandidate.bus_position.lon];
    }
    return null;
  }, [activeCandidate]);

  // 4. Route path geometry (stop-to-stop sequence)
  const routePoints = useMemo<[number, number][] | null>(() => {
    const raw = activeCandidate?.route_path || routeGeometry;
    if (!raw || !Array.isArray(raw) || raw.length === 0) return null;
    const valid = raw.filter(
      (pt): pt is [number, number] =>
        Array.isArray(pt) &&
        pt.length >= 2 &&
        pt[0] != null &&
        pt[1] != null &&
        !isNaN(pt[0]) &&
        !isNaN(pt[1])
    );
    return valid.length > 1 ? valid : null;
  }, [activeCandidate, routeGeometry]);

  // Aggregate points to fit bounds if any real coordinates exist
  const activePoints = useMemo<[number, number][]>(() => {
    const pts: [number, number][] = [];
    if (pickupCoords) pts.push(pickupCoords);
    if (destCoords) pts.push(destCoords);
    if (busCoords) pts.push(busCoords);
    if (routePoints && routePoints.length > 0) {
      pts.push(...routePoints);
    }
    return pts;
  }, [pickupCoords, destCoords, busCoords, routePoints]);

  const hasRealCoordinates = activePoints.length > 0;

  return (
    <div className="map-panel" ref={containerRef} aria-label="Delhi transit corridor map">
      <MapContainer
        center={DELHI_CENTER}
        zoom={DEFAULT_ZOOM}
        scrollWheelZoom={true}
        className="leaflet-map-root"
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          maxZoom={18}
        />

        <MapController points={activePoints} />

        {/* Pickup Marker if real coordinates exist */}
        {pickupCoords && (
          <Marker position={pickupCoords} icon={createFromIcon(originName || 'Pickup Stop')}>
            <Popup>
              <div className="map-popup">
                <div className="popup-badge popup-badge-from">Pickup Stop</div>
                <div className="popup-title">{originName || 'Pickup Stop'}</div>
                {activeCandidate?.pickup?.expected_pickup_eta && (
                  <div className="popup-sub">Expected arrival: {activeCandidate.pickup.expected_pickup_eta}</div>
                )}
                {activeCandidate?.pickup?.expected_wait_minutes != null && (
                  <div className="popup-sub">Wait: ~{activeCandidate.pickup.expected_wait_minutes} min</div>
                )}
              </div>
            </Popup>
          </Marker>
        )}

        {/* Destination Marker if real coordinates exist */}
        {destCoords && (
          <Marker position={destCoords} icon={createToIcon(destinationName || 'Destination Stop')}>
            <Popup>
              <div className="map-popup">
                <div className="popup-badge popup-badge-to">Destination Stop</div>
                <div className="popup-title">{destinationName || 'Destination Stop'}</div>
                {activeCandidate?.destination?.expected_arrival && (
                  <div className="popup-sub">Expected arrival: {activeCandidate.destination.expected_arrival}</div>
                )}
                {activeCandidate?.destination?.expected_travel_time_minutes != null && (
                  <div className="popup-sub">Travel time: ~{activeCandidate.destination.expected_travel_time_minutes} min</div>
                )}
              </div>
            </Popup>
          </Marker>
        )}

        {/* Selected Bus Marker if real coordinates exist */}
        {busCoords && activeCandidate && (
          <Marker position={busCoords} icon={createBusMarkerIcon(activeCandidate.vehicle_id)}>
            <Popup>
              <div className="map-popup">
                <div className="popup-badge popup-badge-vehicle">
                  {activeCandidate.recommendation_tier === 'PRIMARY_RECOMMENDATION'
                    ? 'Recommended Bus'
                    : 'Selected Bus'}
                </div>
                <div className="popup-title">Bus {activeCandidate.vehicle_id}</div>
                {activeCandidate.route_id && (
                  <div className="popup-sub">Route: {activeCandidate.route_id}</div>
                )}
                {activeCandidate.vehicle_position?.speed_kmh_or_null != null && (
                  <div className="popup-sub">Speed: {activeCandidate.vehicle_position.speed_kmh_or_null} km/h</div>
                )}
                {activeCandidate.data_freshness && (
                  <div className="popup-sub">
                    Telemetry: {activeCandidate.data_freshness.telemetry_age_seconds}s ago ({activeCandidate.data_freshness.status.toLowerCase()})
                  </div>
                )}
              </div>
            </Popup>
          </Marker>
        )}

        {/* Route Polyline if real geometry coordinates exist */}
        {routePoints && routePoints.length > 1 && (
          <Polyline
            positions={routePoints}
            pathOptions={{
              color: '#0f766e',
              weight: 4,
              opacity: 0.85,
              lineCap: 'round',
              lineJoin: 'round',
            }}
          >
            <Popup>
              <div className="map-popup">
                <div className="popup-title">Corridor: {originName} &rarr; {destinationName}</div>
                <div className="popup-sub">Route path &middot; stop sequence ({routePoints.length} stops)</div>
              </div>
            </Popup>
          </Polyline>
        )}
      </MapContainer>

      {/* Floating Neutral Status Caption */}
      <div className="map-caption-overlay" role="note">
        {!hasSearched ? (
          <span className="caption-text">
            Search for a journey to view corridor details on the map.
          </span>
        ) : hasRealCoordinates ? (
          <span className="caption-text">
            Corridor: <strong>{originName}</strong> &rarr; <strong>{destinationName}</strong>
            {routePoints && routePoints.length > 1 && (
              <span className="caption-subtext"> &bull; Route path &middot; stop sequence</span>
            )}
          </span>
        ) : (
          <span className="caption-text">
            Delhi Basemap &bull; {originName} &rarr; {destinationName} (Coordinate geometry will appear when provided by the transit feed)
          </span>
        )}
      </div>
    </div>
  );
};
