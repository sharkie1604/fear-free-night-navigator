import { useEffect, useMemo, useRef, useState } from "react";
import * as turf from "@turf/turf";
import Map, { Layer, Marker, NavigationControl, Source } from "react-map-gl";
import {
  AlertTriangle,
  Bike,
  Car,
  CircleDashed,
  X,
  LocateFixed,
  LoaderCircle,
  MapPinned,
  Plus,
  Radar,
  Route,
  Search,
  ShieldAlert,
  Footprints,
} from "lucide-react";
import "mapbox-gl/dist/mapbox-gl.css";

const MAPBOX_TOKEN = "pk.eyJ1Ijoic2hhcmtpZTA0MDUiLCJhIjoiY21uaXA2cHdnMDJ0aTMzczRnbjBuendmOSJ9.03hlRvqiZCiiRwkzVCaOwg";
const GEOCODING_API_BASE_URL = "https://api.mapbox.com/geocoding/v5/mapbox.places";
const REVIEW_API_URL = "http://localhost:5002/api/v2/review";
const BENGALURU_BBOX = [77.4, 12.8, 77.8, 13.1];
const ROUTE_VIEW_MODES = {
  standard: "standard",
  navigator: "navigator",
};
const ROUTE_LINE_LAYER_ID = "route-line";
const ROUTE_GLOW_LAYER_ID = "route-glow";

const routeLineLayer = {
  id: ROUTE_LINE_LAYER_ID,
  type: "line",
  paint: {
    "line-color": [
      "interpolate",
      ["linear"],
      ["coalesce", ["get", "total_score"], 50],
      0,
      "#ef4444",
      40,
      "#f97316",
      70,
      "#22c55e",
      100,
      "#16a34a",
    ],
    "line-width": 8,
    "line-opacity": 0.98,
    "line-blur": 0.15,
  },
  layout: {
    "line-cap": "round",
    "line-join": "round",
  },
};

const routeGlowLayer = {
  id: ROUTE_GLOW_LAYER_ID,
  type: "line",
  paint: {
    "line-color": [
      "interpolate",
      ["linear"],
      ["coalesce", ["get", "total_score"], 50],
      0,
      "#ef4444",
      40,
      "#f59e0b",
      70,
      "#34d399",
      100,
      "#22c55e",
    ],
    "line-width": 15,
    "line-opacity": 0.26,
    "line-blur": 1.1,
  },
  layout: {
    "line-cap": "round",
    "line-join": "round",
  },
};

const emptyFeatureCollection = {
  type: "FeatureCollection",
  features: [],
};
const transportModes = [
  { id: "walking", label: "Walking", speedKmh: 5, icon: Footprints },
  { id: "cycling", label: "Cycling", speedKmh: 15, icon: Bike },
  { id: "driving", label: "Driving", speedKmh: 30, icon: Car },
];
const emptyRouteStats = {
  totalLengthKm: 0,
  averageScore: 0,
  safeZoneCount: 0,
  footfallText: "Low",
};

function summarizeRoute(routePayload) {
  const geojson =
    routePayload?.geojson?.type === "FeatureCollection"
      ? routePayload.geojson
      : emptyFeatureCollection;
  const scores = geojson.features.map((feature) => Number(feature?.properties?.total_score ?? 0));
  const fallbackAverageScore =
    scores.reduce((sum, score) => sum + score, 0) / Math.max(scores.length, 1);
  const averageScore = Number(routePayload?.metrics?.average_safety_score ?? fallbackAverageScore);
  const totalLengthKm = Number(routePayload?.metrics?.total_length_meters ?? 0) / 1000;
  const safeZoneCount = scores.filter((score) => score >= 80).length;
  const footfallText = averageScore >= 70 ? "High" : averageScore >= 50 ? "Moderate" : "Low";

  return {
    geojson,
    stats: {
      totalLengthKm,
      averageScore,
      safeZoneCount,
      footfallText,
    },
  };
}

function App() {
  const [standardRoute, setStandardRoute] = useState(emptyFeatureCollection);
  const [safeRoute, setSafeRoute] = useState(emptyFeatureCollection);
  const [routeStatus, setRouteStatus] = useState("Idle");
  const [routeError, setRouteError] = useState("");
  const [reviewText, setReviewText] = useState("");
  const [reviewStatus, setReviewStatus] = useState("Awaiting AI safety report");
  const [reviewError, setReviewError] = useState("");
  const [isRouteLoading, setIsRouteLoading] = useState(false);
  const [isReviewLoading, setIsReviewLoading] = useState(false);
  const [startLocation, setStartLocation] = useState(null);
  const [endLocation, setEndLocation] = useState(null);
  const [mapCenter, setMapCenter] = useState({
    latitude: 12.9716,
    longitude: 77.6245,
  });
  const [selectedMode, setSelectedMode] = useState(transportModes[0]);
  const [standardRouteStats, setStandardRouteStats] = useState(emptyRouteStats);
  const [safeRouteStats, setSafeRouteStats] = useState(emptyRouteStats);
  const [isPinging, setIsPinging] = useState(false);
  const [isFeedbackOpen, setIsFeedbackOpen] = useState(false);
  const [reviewStep, setReviewStep] = useState("compose");
  const [selectedRouteView, setSelectedRouteView] = useState(ROUTE_VIEW_MODES.navigator);
  const [hoveredAlert, setHoveredAlert] = useState(null);
  const [selectedStreetReview, setSelectedStreetReview] = useState(null);
  const mapRef = useRef(null);
  const startInputRef = useRef(null);
  const endInputRef = useRef(null);

  const viewport = useMemo(
    () => ({
      latitude: 12.9716,
      longitude: 77.6245,
      zoom: 12.4,
      bearing: 8,
      pitch: 48,
    }),
    [],
  );

  const visibleRouteData =
    selectedRouteView === ROUTE_VIEW_MODES.standard ? standardRoute : safeRoute;
  const visibleRouteStats =
    selectedRouteView === ROUTE_VIEW_MODES.standard ? standardRouteStats : safeRouteStats;
  const routeDistanceKm = visibleRouteStats.totalLengthKm || null;
  const routeEtaMinutes = routeDistanceKm
    ? Math.max(1, Math.round((routeDistanceKm / selectedMode.speedKmh) * 60))
    : null;
  const safetyScoreGapPercent = safeRouteStats.averageScore
    ? ((safeRouteStats.averageScore - standardRouteStats.averageScore) / safeRouteStats.averageScore) * 100
    : 0;
  const extraDistanceKm = safeRouteStats.totalLengthKm - standardRouteStats.totalLengthKm;

  function updateHoveredAlert(event) {
    if (!event.features || event.features.length === 0) {
      setHoveredAlert(null);
      return;
    }

    const hoveredFeature = event.features.find(
      (feature) =>
        feature.layer?.id === ROUTE_LINE_LAYER_ID || feature.layer?.id === ROUTE_GLOW_LAYER_ID,
    );

    if (!hoveredFeature) {
      setHoveredAlert(null);
      return;
    }

    const totalScore = Number(hoveredFeature?.properties?.total_score ?? 0);
    const reportSummary = hoveredFeature?.properties?.report_summary;
    const timeContext = hoveredFeature?.properties?.time_context;

    if (hoveredFeature && totalScore < 40 && reportSummary) {
      setHoveredAlert({
        x: event.point.x,
        y: event.point.y,
        reportSummary,
        timeContext: timeContext || "Unknown",
      });
      return;
    }

    setHoveredAlert(null);
  }

  function handleRouteClick(event) {
    const clickedFeature = event.features?.find(
      (feature) =>
        feature.layer?.id === ROUTE_LINE_LAYER_ID || feature.layer?.id === ROUTE_GLOW_LAYER_ID,
    );

    if (!clickedFeature) {
      setSelectedStreetReview(null);
      return;
    }

    setSelectedStreetReview({
      reportSummary: clickedFeature.properties?.report_summary || null,
      timeContext: clickedFeature.properties?.time_context || "Unknown",
      totalScore: Number(clickedFeature.properties?.total_score ?? 0),
    });
  }

  async function fetchSafeRoute({
    start = startLocation,
    end = endLocation,
    } = {}) {
    if (!start || !end) {
      setRouteError("Choose both a start and end location inside Bengaluru.");
      setRouteStatus("Route unavailable");
      return;
    }

    setIsRouteLoading(true);
    setRouteError("");
    setRouteStatus("Querying Night Navigator engine");

    try {
      const response = await fetch(
        `http://localhost:5002/api/v2/route?start=${start.latitude},${start.longitude}&end=${end.latitude},${end.longitude}`,
      );
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Route request failed");
      }

      const standard = summarizeRoute(payload.standard);
      const safe = summarizeRoute(payload.safe);

      setStandardRoute(standard.geojson);
      setSafeRoute(safe.geojson);
      setStandardRouteStats(standard.stats);
      setSafeRouteStats(safe.stats);
      setRouteStatus("Route comparison ready");
    } catch (error) {
      setStandardRoute(emptyFeatureCollection);
      setSafeRoute(emptyFeatureCollection);
      setStandardRouteStats(emptyRouteStats);
      setSafeRouteStats(emptyRouteStats);
      setRouteError(error.message || "Unable to load route");
      setRouteStatus("Route unavailable");
    } finally {
      setIsRouteLoading(false);
    }
  }

  async function submitDangerPing() {
    if (!reviewText.trim()) {
      setReviewError("Add a safety report before submitting.");
      return;
    }

    const liveCenter = mapRef.current?.getMap?.().getCenter();
    const reportCoordinates = liveCenter
      ? { lat: liveCenter.lat, lon: liveCenter.lng }
      : { lat: mapCenter.latitude, lon: mapCenter.longitude };

    setIsReviewLoading(true);
    setIsPinging(true);
    setReviewError("");
    setReviewStatus("Dispatching danger ping");
    setReviewStep("submitting");

    try {
      const response = await fetch(REVIEW_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          lat: reportCoordinates.lat,
          lon: reportCoordinates.lon,
          review: reviewText.trim(),
          is_safe: false,
        }),
      });

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Safety report failed");
      }

      setReviewStatus("Danger ping accepted.");
      setReviewStep("success");
    } catch (error) {
      setReviewError(error.message || "Unable to submit safety report");
      setReviewStatus("Danger ping rejected");
      setReviewStep("compose");
    } finally {
      setIsReviewLoading(false);
      setIsPinging(false);
    }
  }

  async function handleRerouteFromPing() {
    const rerouteStart = {
      label: "Current location",
      latitude: mapCenter.latitude,
      longitude: mapCenter.longitude,
    };

    setStartLocation(rerouteStart);
    setIsFeedbackOpen(false);
    setSelectedStreetReview(null);
    setReviewText("");
    setReviewStep("compose");
    await fetchSafeRoute({ start: rerouteStart, end: endLocation });
  }

  async function handleKeepGoing() {
    const currentStart = startLocation;
    const currentEnd = endLocation;

    setIsFeedbackOpen(false);
    setSelectedStreetReview(null);
    setReviewText("");
    setReviewError("");
    setReviewStep("compose");
    setReviewStatus("Awaiting AI safety report");

    if (currentStart && currentEnd) {
      await fetchSafeRoute({ start: currentStart, end: currentEnd });
    }
  }

  useEffect(() => {
    if (!visibleRouteData.features.length) {
      return;
    }
    const [minLon, minLat, maxLon, maxLat] = turf.bbox(visibleRouteData);
    mapRef.current?.fitBounds(
      [
        [minLon, minLat],
        [maxLon, maxLat],
      ],
      {
        padding: 80,
        pitch: 50,
        bearing: 0,
        duration: 2000,
      },
    );
  }, [visibleRouteData]);

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-slate-950 text-slate-100">
      <Map
        ref={mapRef}
        initialViewState={viewport}
        mapboxAccessToken={MAPBOX_TOKEN}
        mapStyle="mapbox://styles/mapbox/dark-v11"
        attributionControl={false}
        interactiveLayerIds={[ROUTE_LINE_LAYER_ID, ROUTE_GLOW_LAYER_ID]}
        onMove={(event) =>
          setMapCenter({
            latitude: event.viewState.latitude,
            longitude: event.viewState.longitude,
          })
        }
        onClick={handleRouteClick}
        onMouseMove={updateHoveredAlert}
        onMouseLeave={() => setHoveredAlert(null)}
      >
        <NavigationControl position="top-right" />

        {startLocation ? (
          <Marker
            latitude={startLocation.latitude}
            longitude={startLocation.longitude}
            anchor="bottom"
          >
            <div className="grid h-11 w-11 place-items-center rounded-full border border-cyan-300/60 bg-cyan-400/15 shadow-[0_0_30px_rgba(34,211,238,0.55)] backdrop-blur">
              <MapPinned className="h-5 w-5 text-cyan-200" />
            </div>
          </Marker>
        ) : null}

        {endLocation ? (
          <Marker
            latitude={endLocation.latitude}
            longitude={endLocation.longitude}
            anchor="bottom"
          >
            <div className="grid h-11 w-11 place-items-center rounded-full border border-emerald-300/60 bg-emerald-400/15 shadow-[0_0_30px_rgba(74,222,128,0.45)] backdrop-blur">
              <Route className="h-5 w-5 text-emerald-200" />
            </div>
          </Marker>
        ) : null}

        <Source id="safe-route-source" type="geojson" data={visibleRouteData}>
          <Layer {...routeGlowLayer} />
          <Layer {...routeLineLayer} />
        </Source>
      </Map>

      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.16),transparent_24%),radial-gradient(circle_at_bottom_right,rgba(16,185,129,0.14),transparent_26%)]" />
      {hoveredAlert ? (
        <div
          className="pointer-events-none absolute z-20 max-w-xs rounded-2xl border border-rose-300/30 bg-slate-950/92 px-4 py-3 text-sm text-white shadow-[0_20px_50px_rgba(15,23,42,0.5)] backdrop-blur-xl"
          style={{
            left: hoveredAlert.x + 18,
            top: hoveredAlert.y - 18,
          }}
        >
          <p className="font-medium text-rose-200">
            ⚠️ Safety Alert: {hoveredAlert.reportSummary}
          </p>
          <p className="mt-1 text-xs text-slate-300">
            Reported at {hoveredAlert.timeContext}
          </p>
        </div>
      ) : null}
      {selectedStreetReview ? (
        <div
          className="absolute inset-0 z-30 flex items-center justify-center bg-slate-950/35 backdrop-blur-[2px]"
          onClick={() => setSelectedStreetReview(null)}
        >
          <div
            className="pointer-events-auto w-[min(440px,calc(100vw-2rem))] rounded-[28px] border border-white/15 bg-white/10 p-6 shadow-[0_24px_80px_rgba(15,23,42,0.48)] backdrop-blur-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-[0.28em] text-cyan-200/80">
                  Community Reviews
                </p>
                <h3 className="mt-2 text-2xl font-semibold text-white">Street Safety Reports</h3>
              </div>
              <button
                type="button"
                onClick={() => setSelectedStreetReview(null)}
                className="rounded-full border border-white/10 bg-black/20 p-2 text-slate-300 transition hover:border-white/20 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {selectedStreetReview.reportSummary ? (
              <div className="mt-6 rounded-3xl border border-rose-300/20 bg-rose-500/10 p-5">
                <div className="flex items-center gap-3 text-sm text-rose-100">
                  <AlertTriangle className="h-4 w-4 text-rose-300" />
                  Active community report
                </div>
                <p className="mt-4 text-sm leading-6 text-slate-100">
                  {selectedStreetReview.reportSummary}
                </p>
                <p className="mt-3 text-xs uppercase tracking-[0.18em] text-slate-300">
                  Reported at {selectedStreetReview.timeContext}
                </p>
              </div>
            ) : (
              <div className="mt-6 rounded-3xl border border-emerald-300/15 bg-emerald-500/10 p-5 text-center">
                <div className="mx-auto grid h-14 w-14 place-items-center rounded-full border border-emerald-300/25 bg-emerald-400/10">
                  <CircleDashed className="h-6 w-6 text-emerald-200" />
                </div>
                <p className="mt-4 text-sm font-medium text-emerald-100">
                  No community reviews for this street yet. Safe travels!
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedStreetReview(null);
                    setIsFeedbackOpen(true);
                    setReviewStep("compose");
                  }}
                  className="mt-5 inline-flex items-center justify-center rounded-2xl border border-cyan-300/35 bg-cyan-400/15 px-4 py-3 text-sm font-medium text-cyan-50 transition hover:border-cyan-200/60 hover:bg-cyan-300/20"
                >
                  Be the first to report
                </button>
              </div>
            )}
          </div>
        </div>
      ) : null}
      {routeDistanceKm && routeEtaMinutes ? (
        <div className="pointer-events-none absolute right-6 top-6 z-10">
          <div className="rounded-3xl border border-white/15 bg-white/10 px-5 py-4 shadow-[0_20px_60px_rgba(15,23,42,0.38)] backdrop-blur-2xl">
            <p className="text-[11px] uppercase tracking-[0.24em] text-cyan-200/80">
              Live Route Snapshot
            </p>
            <div className="mt-3 flex items-end gap-6">
              <div>
                <p className="text-[11px] uppercase tracking-[0.2em] text-slate-400">Distance</p>
                <p className="mt-1 text-2xl font-semibold text-white">{routeDistanceKm.toFixed(2)} km</p>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-[0.2em] text-slate-400">ETA</p>
                <p className="mt-1 text-2xl font-semibold text-white">{routeEtaMinutes} min</p>
              </div>
            </div>
            <p className="mt-2 text-xs text-slate-400">{selectedMode.label} profile</p>
          </div>
        </div>
      ) : null}
      <div className="pointer-events-none absolute inset-0 z-[5] flex items-center justify-center">
        <div className="relative grid h-14 w-14 place-items-center">
          {isPinging ? (
            <>
              <div className="absolute inset-[-30px] rounded-full bg-[radial-gradient(circle,rgba(251,113,133,0.38),rgba(251,113,133,0.12),transparent_70%)]" />
              <div className="absolute inset-0 rounded-full border border-rose-300/60 bg-rose-500/12 animate-ping" />
            </>
          ) : null}
          <div className="grid h-14 w-14 place-items-center rounded-full border border-rose-300/45 bg-rose-500/10 shadow-[0_0_45px_rgba(251,113,133,0.22)] backdrop-blur-sm">
          <Plus className="h-7 w-7 text-rose-200 drop-shadow-[0_0_12px_rgba(251,113,133,0.75)]" />
          </div>
        </div>
      </div>

      <aside className="pointer-events-auto absolute left-6 top-6 z-10 max-h-[calc(100vh-3rem)] w-[min(420px,calc(100vw-3rem))] overflow-y-auto rounded-[28px] border border-white/15 bg-white/10 p-6 shadow-[0_20px_80px_rgba(15,23,42,0.45)] backdrop-blur-2xl">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.38em] text-cyan-200/80">
              Enterprise Safety Dashboard
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">
              Night Navigator
            </h1>
          </div>
          <div className="rounded-full border border-cyan-300/40 bg-cyan-400/10 px-3 py-1 text-xs font-medium text-cyan-100">
            Track 2
          </div>
        </div>

        {routeEtaMinutes ? (
          <div className="mb-6 rounded-3xl border border-white/10 bg-white/8 p-4 shadow-[0_16px_40px_rgba(8,15,30,0.32)] backdrop-blur-xl">
            <p className="text-xs uppercase tracking-[0.24em] text-cyan-200/80">
              Safety Impact
            </p>
            <div className="mt-4 grid grid-cols-2 gap-2 rounded-2xl border border-white/10 bg-slate-950/35 p-1">
              <button
                type="button"
                onClick={() => setSelectedRouteView(ROUTE_VIEW_MODES.standard)}
                className={`rounded-xl px-3 py-2 text-sm font-medium transition ${
                  selectedRouteView === ROUTE_VIEW_MODES.standard
                    ? "bg-rose-500/20 text-rose-100"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                Standard Route
              </button>
              <button
                type="button"
                onClick={() => setSelectedRouteView(ROUTE_VIEW_MODES.navigator)}
                className={`rounded-xl px-3 py-2 text-sm font-medium transition ${
                  selectedRouteView === ROUTE_VIEW_MODES.navigator
                    ? "bg-emerald-500/20 text-emerald-100"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                Night Navigator
              </button>
            </div>
            <div className="mt-4 rounded-2xl border border-rose-300/15 bg-rose-500/8 p-4">
              <div className="flex items-center justify-between gap-4">
                <span className="text-sm font-medium text-slate-100">Standard Route</span>
                <span className="text-sm text-slate-300">
                  {Math.max(
                    1,
                    Math.round((standardRouteStats.totalLengthKm / selectedMode.speedKmh) * 60),
                  )} min
                </span>
              </div>
              <p className="mt-2 text-sm font-medium text-rose-300">
                Safety Score: {Math.round(standardRouteStats.averageScore)} / 100
              </p>
            </div>
            <div className="mt-3 rounded-2xl border border-emerald-300/15 bg-emerald-500/8 p-4">
              <div className="flex items-center justify-between gap-4">
                <span className="text-sm font-medium text-slate-100">Night Navigator Route</span>
                <span className="text-sm text-slate-300">
                  {Math.max(1, Math.round((safeRouteStats.totalLengthKm / selectedMode.speedKmh) * 60))} min
                </span>
              </div>
              <p className="mt-2 text-sm font-medium text-emerald-300">
                Safety Score: {Math.round(safeRouteStats.averageScore)} / 100
              </p>
            </div>
            <div className="mt-4 rounded-2xl border border-white/10 bg-slate-950/35 p-4">
              <p className="text-xs uppercase tracking-[0.22em] text-slate-400">Comparison</p>
              <div className="mt-4 grid gap-3 text-sm text-slate-200">
                <div className="flex items-center justify-between gap-4">
                  <span>Distance Tradeoff</span>
                  <span className="font-medium">
                    {extraDistanceKm > 0
                      ? `Standard is ${extraDistanceKm.toFixed(2)} km shorter`
                      : `Night Navigator is ${Math.abs(extraDistanceKm).toFixed(2)} km shorter`}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <span>Safety Tradeoff</span>
                  <span className="font-medium text-emerald-300">
                    {safetyScoreGapPercent > 0
                      ? `Standard is ${Math.round(safetyScoreGapPercent)}% lower`
                      : `Night Navigator is ${Math.abs(Math.round(safetyScoreGapPercent))}% lower`}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <span>Visible Route</span>
                  <span className="font-medium">
                    {selectedRouteView === ROUTE_VIEW_MODES.standard ? "Standard" : "Night Navigator"}
                  </span>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-3">
          <StatusCard
            icon={Radar}
            label="Routing Core"
            value={routeStatus}
            tone="cyan"
          />
          <StatusCard
            icon={AlertTriangle}
            label="Danger Ping"
            value={reviewStatus}
            tone="rose"
          />
          <StatusCard
            icon={Route}
            label="Feedback Loop"
            value="Live reroute"
            tone="emerald"
          />
        </div>

        <div className="mt-6 rounded-3xl border border-white/10 bg-slate-950/35 p-4">
          <div className="flex items-center gap-3 text-sm text-slate-200">
            <Search className="h-4 w-4 text-cyan-300" />
            Dynamic route request
          </div>
          <div className="mt-4 space-y-4">
            <LocationSearchField
              label="Start Location"
              value={startLocation}
              onSelect={setStartLocation}
              mapboxToken={MAPBOX_TOKEN}
              inputRef={startInputRef}
              placeholder="Enter starting location..."
            />
            <LocationSearchField
              label="End Location"
              value={endLocation}
              onSelect={setEndLocation}
              mapboxToken={MAPBOX_TOKEN}
              inputRef={endInputRef}
              placeholder="Enter destination..."
            />
          </div>
          <div className="mt-4 grid grid-cols-3 gap-2">
            {transportModes.map((mode) => {
              const Icon = mode.icon;
              const isActive = selectedMode.id === mode.id;

              return (
                <button
                  key={mode.id}
                  type="button"
                  onClick={() => setSelectedMode(mode)}
                  className={`inline-flex items-center justify-center gap-2 rounded-full border px-3 py-2 text-sm font-medium transition ${
                    isActive
                      ? "border-cyan-200/70 bg-cyan-300/20 text-cyan-50"
                      : "border-white/10 bg-black/20 text-slate-300 hover:border-cyan-300/40 hover:text-white"
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {mode.label}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => fetchSafeRoute({ start: startLocation, end: endLocation })}
            disabled={isRouteLoading}
            className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-cyan-300/40 bg-cyan-400/15 px-4 py-3 text-sm font-medium text-cyan-50 transition hover:border-cyan-200/70 hover:bg-cyan-300/20 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isRouteLoading ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <Route className="h-4 w-4" />
            )}
            Calculate Route
          </button>
          <p className="mt-3 text-xs leading-5 text-slate-400">
            Search is restricted to Bengaluru using the bounding box 77.4, 12.8, 77.8, 13.1.
          </p>
          {routeError ? <p className="mt-3 text-sm text-rose-300">{routeError}</p> : null}
        </div>

      </aside>

      <section className="pointer-events-auto absolute bottom-8 right-8 z-10 max-w-[calc(100vw-2rem)]">
        {!isFeedbackOpen ? (
          <button
            type="button"
            onClick={() => {
              setIsFeedbackOpen(true);
              setReviewStep("compose");
            }}
            className="rounded-full border border-rose-300/35 bg-gray-900/85 px-5 py-3 text-sm font-medium text-rose-50 shadow-2xl backdrop-blur-md transition hover:border-rose-200/60 hover:bg-gray-900"
          >
            ⚠️ Report Street / Safety Feedback
          </button>
        ) : (
          <div className="w-96 rounded-2xl border border-gray-700 bg-gray-900/80 p-5 shadow-2xl backdrop-blur-md">
            <div className="flex items-center gap-3 text-sm text-slate-200">
              <ShieldAlert className="h-4 w-4 text-rose-300" />
              Danger Ping AI demo
            </div>
            {reviewStep === "success" ? (
              <>
                <p className="mt-4 text-sm leading-6 text-emerald-200">
                  ✅ Thanks for the review! Your report helps keep the community safe.
                </p>
                <div className="mt-5 grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={handleRerouteFromPing}
                    className="rounded-2xl border border-cyan-300/40 bg-cyan-400/15 px-4 py-3 text-sm font-medium text-cyan-50 transition hover:border-cyan-200/70 hover:bg-cyan-300/20"
                  >
                    Reroute
                  </button>
                  <button
                    type="button"
                    onClick={handleKeepGoing}
                    className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-medium text-slate-200 transition hover:border-white/20 hover:bg-white/10"
                  >
                    Keep Going
                  </button>
                </div>
              </>
            ) : (
              <>
                <textarea
                  value={reviewText}
                  onChange={(event) => setReviewText(event.target.value)}
                  rows={5}
                  className="mt-4 w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-white outline-none ring-0 placeholder:text-slate-500 focus:border-rose-300/60"
                  placeholder="Describe the safety concern..."
                />
                <button
                  type="button"
                  onClick={submitDangerPing}
                  disabled={isReviewLoading}
                  className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-rose-300/40 bg-rose-500/15 px-4 py-3 text-sm font-medium text-rose-50 transition hover:border-rose-200/70 hover:bg-rose-400/20 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isReviewLoading ? (
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                  ) : (
                    <ShieldAlert className="h-4 w-4" />
                  )}
                  Submit AI Safety Report
                </button>
                <p className="mt-3 text-xs font-medium tracking-[0.16em] text-rose-200/85">
                  Drop Point: {mapCenter.latitude.toFixed(5)}, {mapCenter.longitude.toFixed(5)}
                </p>
                <p className="mt-3 text-xs leading-5 text-slate-400">
                  The crosshair stays locked to the center of the screen while you drag the map.
                  Submit the report to mark the current street segment.
                </p>
                {reviewError ? <p className="mt-3 text-sm text-rose-300">{reviewError}</p> : null}
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function StatusCard({ icon: Icon, label, value, tone }) {
  const toneClasses = {
    cyan: "border-cyan-300/20 bg-cyan-400/10 text-cyan-50",
    rose: "border-rose-300/20 bg-rose-400/10 text-rose-50",
    emerald: "border-emerald-300/20 bg-emerald-400/10 text-emerald-50",
  };

  return (
    <div className={`rounded-2xl border p-3 ${toneClasses[tone]}`}>
      <div className="flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-white/70">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <p className="mt-3 text-sm font-medium leading-5">{value}</p>
    </div>
  );
}

function LocationSearchField({ label, value, onSelect, mapboxToken, inputRef, placeholder }) {
  const [query, setQuery] = useState(value?.label ?? "");
  const [results, setResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState("");
  const blurTimeoutRef = useRef(null);

  useEffect(() => {
    setQuery(value?.label ?? "");
  }, [value]);

  useEffect(() => {
    if (!mapboxToken || mapboxToken === "YOUR_MAPBOX_TOKEN") {
      setResults([]);
      return;
    }

    const trimmedQuery = query.trim();
    if (trimmedQuery.length < 3) {
      setResults([]);
      setError("");
      return;
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(async () => {
      setIsSearching(true);
      setError("");

      try {
        const searchParams = new URLSearchParams({
          access_token: mapboxToken,
          autocomplete: "true",
          limit: "5",
          country: "IN",
          bbox: BENGALURU_BBOX.join(","),
          types: "place,postcode,address,poi,neighborhood,locality",
        });

        const response = await fetch(
          `${GEOCODING_API_BASE_URL}/${encodeURIComponent(trimmedQuery)}.json?${searchParams.toString()}`,
          { signal: controller.signal },
        );
        const payload = await response.json();

        if (!response.ok) {
          throw new Error(payload.message || "Search request failed");
        }

        const nextResults = (payload.features || []).map((feature) => ({
          id: feature.id,
          label: feature.place_name,
          latitude: feature.center[1],
          longitude: feature.center[0],
        }));

        setResults(nextResults);
      } catch (searchError) {
        if (searchError.name !== "AbortError") {
          setError(searchError.message || "Search failed");
          setResults([]);
        }
      } finally {
        setIsSearching(false);
      }
    }, 250);

    return () => {
      controller.abort();
      window.clearTimeout(timeoutId);
    };
  }, [mapboxToken, query]);

  function handleSelect(result) {
    onSelect(result);
    setQuery(result.label);
    setResults([]);
    setError("");
  }

  function handleBlur() {
    blurTimeoutRef.current = window.setTimeout(() => {
      setResults([]);
    }, 150);
  }

  function handleFocus() {
    if (blurTimeoutRef.current) {
      window.clearTimeout(blurTimeoutRef.current);
    }
  }

  return (
    <div className="relative">
      <label className="mb-2 block text-xs uppercase tracking-[0.24em] text-slate-400">
        {label}
      </label>
      <div className="relative">
        <LocateFixed className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onBlur={handleBlur}
          onFocus={handleFocus}
          className="w-full rounded-2xl border border-white/10 bg-black/25 py-3 pl-11 pr-11 text-sm text-white outline-none placeholder:text-slate-500 focus:border-cyan-300/60"
          placeholder={placeholder}
        />
        {isSearching ? (
          <LoaderCircle className="absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-cyan-300" />
        ) : null}
      </div>
      {results.length > 0 ? (
        <div className="absolute z-20 mt-2 w-full overflow-hidden rounded-2xl border border-white/10 bg-slate-950/95 shadow-[0_20px_50px_rgba(2,6,23,0.65)] backdrop-blur-xl">
          {results.map((result) => (
            <button
              key={result.id}
              type="button"
              onMouseDown={() => handleSelect(result)}
              className="block w-full border-b border-white/5 px-4 py-3 text-left text-sm text-slate-200 transition hover:bg-white/5 last:border-b-0"
            >
              {result.label}
            </button>
          ))}
        </div>
      ) : null}
      {error ? <p className="mt-2 text-xs text-rose-300">{error}</p> : null}
      {value ? (
        <p className="mt-2 text-xs text-slate-500">
          Selected: {value.latitude.toFixed(4)}, {value.longitude.toFixed(4)}
        </p>
      ) : null}
    </div>
  );
}

export default App;
