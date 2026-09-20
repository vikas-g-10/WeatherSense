import { useState } from "react";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import "./App.css";

const BACKEND_URL = "http://localhost:5000";

// --------------------------------------------------
// Manual notification test events
// --------------------------------------------------

const HIGH_CONFIDENCE_EVENT = {
  type: "RAIN_START",
  severity: "HIGH",
  confidence: 0.98,
  expectedAt: "2026-09-04 23:00",
  reasons: [
    "Rain probability is 95%",
    "Forecast changes from Clear to Heavy rain",
    "2 mm of precipitation is expected",
    "Rain is expected within 1 hour",
    "Rain remains likely in nearby forecast hours",
  ],
};

const LOW_CONFIDENCE_EVENT = {
  type: "RAIN_START",
  severity: "LOW",
  confidence: 0.79,
  expectedAt: "2026-09-05 06:00",
  reasons: [
    "Rain probability is 40%",
    "Forecast changes from Cloudy to Light rain",
    "Confidence has not yet crossed the notification threshold",
  ],
};

// --------------------------------------------------
// Types
// --------------------------------------------------

type WeatherEvent = {
  type: string;
  severity: string;
  confidence: number;
  expectedAt: string;
  reasons: string[];
};

type NotificationDecision = {
  shouldNotify: boolean;
  reason?: string;
  eventId?: string;
  title?: string;
  message?: string;
  confidence?: number;
  event?: WeatherEvent | null;
};

type TestOutcome =
  | { status: "sent"; decision: NotificationDecision }
  | { status: "rejected"; decision: NotificationDecision }
  | { status: "error"; message: string };

type CurrentWeather = {
  city: string;
  region?: string;
  country?: string;
  temperature_c: number;
  feels_like_c: number;
  condition: string;
  humidity: number;
  wind_kph: number;
  pressure_mb: number;
  last_updated: string;
  time_epoch: number;
};

type ForecastHour = {
  time: string;
  time_epoch: number;
  temperature_c: number;
  feels_like_c: number;
  condition: string;
  precipitation_probability: number;
  precipitation_mm: number;
  humidity: number;
  wind_kph: number;
  wind_gust_kph: number;
  cloud: number;
};

type LiveWeatherResult = {
  city: string;
  region?: string;
  country?: string;
  checkedAt: string;
  currentWeather?: {
    condition: string;
    time_epoch: number;
  };
  events: WeatherEvent[];
  decisions: NotificationDecision[];
};

// --------------------------------------------------
// Helper
// --------------------------------------------------

function describeRejection(
  decision: NotificationDecision
): string {
  switch (decision.reason) {
    case "DUPLICATE_EVENT":
      return "This event was already notified during this session. No duplicate notification was sent.";

    case "CONFIDENCE_BELOW_THRESHOLD":
      return "Confidence is below the 0.80 threshold. No notification was sent.";

    case "INVALID_EVENT":
    case "MISSING_EVENT_TYPE":
    case "MISSING_EXPECTED_AT":
    case "MISSING_OR_INVALID_CONFIDENCE":
      return "The event was missing required data, so no notification was sent.";

    default:
      return "The notification engine rejected this event.";
  }
}

function getWeatherIcon(condition: string) {
  const text = condition.toLowerCase();

  if (
    text.includes("heavy rain") ||
    text.includes("moderate rain") ||
    text.includes("light rain") ||
    text.includes("rain")
  ) {
    return "🌧️";
  }

  if (
    text.includes("cloudy") ||
    text.includes("overcast")
  ) {
    return "☁️";
  }

  if (
    text.includes("partly cloudy")
  ) {
    return "🌤️";
  }

  if (
    text.includes("thunder")
  ) {
    return "⛈️";
  }

  if (
    text.includes("mist") ||
    text.includes("fog")
  ) {
    return "🌫️";
  }

  if (
    text.includes("snow")
  ) {
    return "❄️";
  }

  return "☀️";
}

function formatHour(time: string) {
  const date = new Date(
    time.replace(" ", "T")
  );

  if (Number.isNaN(date.getTime())) {
    return time;
  }

  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

// --------------------------------------------------
// App
// --------------------------------------------------

function App() {
  const [isSending, setIsSending] = useState(false);

  const [outcome, setOutcome] =
    useState<TestOutcome | null>(null);

  const [city] = useState("Bengaluru");

  const [isCheckingWeather, setIsCheckingWeather] =
    useState(false);

  const [liveWeather, setLiveWeather] =
    useState<LiveWeatherResult | null>(null);

  const [liveWeatherError, setLiveWeatherError] =
    useState<string | null>(null);

  const [currentWeather, setCurrentWeather] =
    useState<CurrentWeather | null>(null);

  const [hourlyForecast, setHourlyForecast] =
    useState<ForecastHour[]>([]);

  // ------------------------------------------------
  // Existing manual notification pipeline
  // ------------------------------------------------

  async function runNotificationPipeline(
    sampleEvent:
      | typeof HIGH_CONFIDENCE_EVENT
      | typeof LOW_CONFIDENCE_EVENT
  ) {
    setIsSending(true);
    setOutcome(null);

    try {
      const response = await fetch(
        `${BACKEND_URL}/api/notifications/evaluate`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            event: sampleEvent,
          }),
        }
      );

      if (!response.ok) {
        throw new Error(
          `Backend responded with status ${response.status}`
        );
      }

      const decision: NotificationDecision =
        await response.json();

      if (!decision.shouldNotify) {
        setOutcome({
          status: "rejected",
          decision,
        });
        return;
      }

      let granted =
        await isPermissionGranted();

      if (!granted) {
        const permission =
          await requestPermission();

        granted = permission === "granted";
      }

      if (!granted) {
        setOutcome({
          status: "error",
          message:
            "Notification permission was denied.",
        });
        return;
      }

      await sendNotification({
        title:
          decision.title ?? "WeatherSense",
        body:
          decision.message ??
          "Weather update from WeatherSense.",
      });

      setOutcome({
        status: "sent",
        decision,
      });
    } catch (error) {
      console.error(
        "Notification pipeline test failed:",
        error
      );

      setOutcome({
        status: "error",
        message:
          "Could not reach the backend or send the notification. Is the backend running on http://localhost:5000?",
      });
    } finally {
      setIsSending(false);
    }
  }

  // ------------------------------------------------
  // Real weather dashboard + change detection
  // ------------------------------------------------

  async function checkLiveWeather() {
    setIsCheckingWeather(true);
    setLiveWeather(null);
    setLiveWeatherError(null);

    try {
      const encodedCity =
        encodeURIComponent(city.trim());

      // Fetch current weather, forecast and
      // WeatherSense change detection together.
      const [
        weatherResponse,
        forecastResponse,
        checkResponse,
      ] = await Promise.all([
        fetch(
          `${BACKEND_URL}/weather/${encodedCity}`
        ),

        fetch(
          `${BACKEND_URL}/forecast/${encodedCity}`
        ),

        fetch(
          `${BACKEND_URL}/api/weather/${encodedCity}/check`
        ),
      ]);

      if (!weatherResponse.ok) {
        throw new Error(
          "Unable to fetch current weather."
        );
      }

      if (!forecastResponse.ok) {
        throw new Error(
          "Unable to fetch hourly forecast."
        );
      }

      if (!checkResponse.ok) {
        throw new Error(
          "Unable to run WeatherSense weather analysis."
        );
      }

      const weather: CurrentWeather =
        await weatherResponse.json();

      const forecastData =
        await forecastResponse.json();

      const result: LiveWeatherResult =
        await checkResponse.json();

      setCurrentWeather(weather);

      setHourlyForecast(
        forecastData.forecast ?? []
      );

      setLiveWeather(result);

      // --------------------------------------------
      // Send accepted notifications
      // --------------------------------------------

      const notifyDecisions =
        result.decisions.filter(
          (decision) =>
            decision.shouldNotify
        );

      for (const decision of notifyDecisions) {
        let granted =
          await isPermissionGranted();

        if (!granted) {
          const permission =
            await requestPermission();

          granted =
            permission === "granted";
        }

        if (!granted) {
          console.warn(
            "Notification permission denied."
          );
          continue;
        }

        await sendNotification({
          title:
            decision.title ??
            "WeatherSense Weather Alert",
          body:
            decision.message ??
            "Weather change detected.",
        });
      }
    } catch (error) {
      console.error(
        "Live weather check failed:",
        error
      );

      setLiveWeatherError(
        error instanceof Error
          ? error.message
          : "Unable to check live weather."
      );
    } finally {
      setIsCheckingWeather(false);
    }
  }

  // ------------------------------------------------
  // Select next five forecast hours
  // ------------------------------------------------

  const nextHours =
    hourlyForecast
      .filter(
        (hour) =>
          hour.time_epoch >
          Math.floor(Date.now() / 1000)
      )
      .slice(0, 5);

  // ------------------------------------------------
  // Find notification-worthy event
  // ------------------------------------------------

  const detectedEvent =
    liveWeather?.events.find(
      (_, index) =>
        liveWeather.decisions[index]
          ?.shouldNotify
    ) ?? null;

  // ------------------------------------------------
  // UI
  // ------------------------------------------------

  return (
    <div className="app">

      {/* ------------------------------------------ */}
      {/* Top Bar */}
      {/* ------------------------------------------ */}

      <header className="topbar">
        <div className="brand">
          <div className="brand-icon">
            ☁
          </div>

          <div>
            <h1>WeatherSense</h1>
            <p>
              Smart weather monitoring
            </p>
          </div>
        </div>

        <button className="settings-button">
          ⚙
        </button>
      </header>

      <main className="dashboard">

        {/* ---------------------------------------- */}
        {/* Location */}
        {/* ---------------------------------------- */}

        <section className="location-section">

          <div>
            <p className="eyebrow">
              CURRENT WEATHER
            </p>

            <h2>
              {currentWeather?.city ??
                city}

              {currentWeather?.region
                ? `, ${currentWeather.region}`
                : ", Karnataka"}
            </h2>

            <p className="date">
              WeatherSense Live Monitoring
            </p>
          </div>

          <button
            className="search-button"
            onClick={checkLiveWeather}
            disabled={isCheckingWeather}
          >
            🔍 {city}
          </button>

        </section>

        {/* ---------------------------------------- */}
        {/* Live Weather Monitor */}
        {/* ---------------------------------------- */}

        <section className="notification-test">

          <div className="section-heading">
            <div>
              <p className="eyebrow">
                LIVE WEATHER
              </p>

              <h3>
                Weather Change Monitor
              </h3>
            </div>
          </div>

          <p className="notification-test-description">
            WeatherSense checks the real forecast,
            detects significant weather changes,
            calculates its own confidence score,
            and sends a Windows notification only
            when the confidence reaches 0.80 or higher.
          </p>

          <div className="notification-test-buttons">

            <button
              className="test-btn test-btn-primary"
              onClick={checkLiveWeather}
              disabled={
                isCheckingWeather ||
                !city.trim()
              }
            >
              {isCheckingWeather
                ? "Checking weather..."
                : `Check ${city} weather`}
            </button>

          </div>

          {liveWeatherError && (
            <div className="test-result test-result-error">

              <p className="test-result-heading">
                ⚠️ Weather check failed
              </p>

              <p>
                {liveWeatherError}
              </p>

            </div>
          )}

          {liveWeather && (
            <div className="test-result test-result-sent">

              <p className="test-result-heading">
                ✅ Weather check completed
              </p>

              <p>
                Current condition:{" "}
                <strong>
                  {liveWeather.currentWeather
                    ?.condition ??
                    "Unknown"}
                </strong>
              </p>

              {liveWeather.events.length ===
                0 ? (
                <p>
                  No significant weather change
                  requiring a notification was
                  detected.
                </p>
              ) : (
                liveWeather.events.map(
                  (event, index) => {

                    const decision =
                      liveWeather.decisions[
                        index
                      ];

                    return (
                      <div
                        key={`${event.type}-${event.expectedAt}`}
                        className="test-result-reasons"
                      >

                        <p>
                          <strong>
                            {event.type}
                          </strong>
                        </p>

                        <p>
                          Confidence:{" "}
                          <strong>
                            {Math.round(
                              event.confidence *
                                100
                            )}
                            %
                          </strong>
                        </p>

                        <p>
                          Expected:{" "}
                          {event.expectedAt}
                        </p>

                        <ul>
                          {event.reasons.map(
                            (reason) => (
                              <li key={reason}>
                                {reason}
                              </li>
                            )
                          )}
                        </ul>

                        <p>
                          {decision?.shouldNotify
                            ? "🔔 Notification sent"
                            : `🚫 Notification not sent: ${
                                decision?.reason ??
                                "rejected"
                              }`}
                        </p>

                      </div>
                    );
                  }
                )
              )}

            </div>
          )}

        </section>

        {/* ---------------------------------------- */}
        {/* LIVE Current Weather */}
        {/* ---------------------------------------- */}

        <section className="current-weather">

          <div className="weather-icon">
            {getWeatherIcon(
              currentWeather?.condition ??
                "Clear"
            )}
          </div>

          <div className="temperature">

            <span>
              {currentWeather
                ? Math.round(
                    currentWeather.temperature_c
                  )
                : "--"}
            </span>

            <sup>°C</sup>

          </div>

          <div className="condition">
            {currentWeather?.condition ??
              "Check weather to load"}
          </div>

          <div className="feels-like">
            {currentWeather
              ? `Feels like ${Math.round(
                  currentWeather.feels_like_c
                )}°C`
              : "WeatherSense"}
          </div>

        </section>

        {/* ---------------------------------------- */}
        {/* LIVE Weather Stats */}
        {/* ---------------------------------------- */}

        <section className="weather-stats">

          <div className="stat">
            <span>💧</span>

            <div>
              <small>
                Humidity
              </small>

              <strong>
                {currentWeather
                  ? `${currentWeather.humidity}%`
                  : "--"}
              </strong>
            </div>
          </div>

          <div className="stat">
            <span>💨</span>

            <div>
              <small>
                Wind
              </small>

              <strong>
                {currentWeather
                  ? `${Math.round(
                      currentWeather.wind_kph
                    )} km/h`
                  : "--"}
              </strong>
            </div>
          </div>

          <div className="stat">
            <span>🌡️</span>

            <div>
              <small>
                Pressure
              </small>

              <strong>
                {currentWeather
                  ? `${Math.round(
                      currentWeather.pressure_mb
                    )} hPa`
                  : "--"}
              </strong>
            </div>
          </div>

        </section>

        {/* ---------------------------------------- */}
        {/* LIVE Hourly Forecast */}
        {/* ---------------------------------------- */}

        <section className="forecast-section">

          <div className="section-heading">

            <div>
              <p className="eyebrow">
                NEXT FEW HOURS
              </p>

              <h3>
                Hourly Forecast
              </h3>
            </div>

          </div>

          <div className="hourly-forecast">

            {nextHours.length > 0 ? (
              nextHours.map((hour) => (

                <div
                  className="hour"
                  key={hour.time_epoch}
                >

                  <span>
                    {formatHour(hour.time)}
                  </span>

                  <strong>
                    {getWeatherIcon(
                      hour.condition
                    )}
                  </strong>

                  <b>
                    {Math.round(
                      hour.temperature_c
                    )}°
                  </b>

                </div>

              ))
            ) : (
              <div className="hour">
                <span>
                  Check weather
                </span>

                <strong>
                  🌤️
                </strong>

                <b>
                  --
                </b>
              </div>
            )}

          </div>

        </section>

        {/* ---------------------------------------- */}
        {/* Dynamic Weather Alert */}
        {/* ---------------------------------------- */}

        {detectedEvent && (
          <section className="alert-card">

            <div className="alert-icon">
              ⚠️
            </div>

            <div className="alert-content">

              <p className="eyebrow">
                WEATHER CHANGE DETECTED
              </p>

              <h3>
                {detectedEvent.type ===
                "RAIN_START"
                  ? `Rain may begin around ${formatHour(
                      detectedEvent.expectedAt
                    )}`
                  : detectedEvent.type}
              </h3>

              <p>
                WeatherSense detected a
                significant change in the
                upcoming forecast.
              </p>

            </div>

            <div className="confidence">

              <span>
                Confidence
              </span>

              <strong>
                {Math.round(
                  detectedEvent.confidence *
                    100
                )}
                %
              </strong>

            </div>

          </section>
        )}

        {/* ---------------------------------------- */}
        {/* No Alert State */}
        {/* ---------------------------------------- */}

        {liveWeather &&
          !detectedEvent && (
            <section className="alert-card">

              <div className="alert-icon">
                ✓
              </div>

              <div className="alert-content">

                <p className="eyebrow">
                  WEATHER STATUS
                </p>

                <h3>
                  No high-confidence weather
                  change detected
                </h3>

                <p>
                  WeatherSense is monitoring
                  the upcoming forecast.
                </p>

              </div>

              <div className="confidence">

                <span>
                  Threshold
                </span>

                <strong>
                  80%
                </strong>

              </div>

            </section>
          )}

        {/* ---------------------------------------- */}
        {/* Manual Notification Tests */}
        {/* ---------------------------------------- */}

        <section className="notification-test">

          <div className="section-heading">

            <div>
              <p className="eyebrow">
                DEVELOPMENT TEST
              </p>

              <h3>
                Notification Pipeline Test
              </h3>
            </div>

          </div>

          <p className="notification-test-description">
            These controlled events are only for
            testing the notification engine,
            threshold, deduplication, and native
            Windows notification.
          </p>

          <div className="notification-test-buttons">

            <button
              className="test-btn test-btn-primary"
              onClick={() =>
                runNotificationPipeline(
                  HIGH_CONFIDENCE_EVENT
                )
              }
              disabled={isSending}
            >
              Send Sample Event
              (0.98 confidence)
            </button>

            <button
              className="test-btn test-btn-secondary"
              onClick={() =>
                runNotificationPipeline(
                  LOW_CONFIDENCE_EVENT
                )
              }
              disabled={isSending}
            >
              Send Sample Event
              (0.79 confidence)
            </button>

          </div>

          {outcome && (
            <div
              className={`test-result test-result-${outcome.status}`}
            >

              {outcome.status === "sent" && (
                <>
                  <p className="test-result-heading">
                    ✅ Notification sent
                  </p>

                  <p>
                    <strong>
                      {outcome.decision.title}
                    </strong>
                  </p>

                  <p>
                    {outcome.decision.message}
                  </p>

                  {outcome.decision.event
                    ?.reasons && (
                    <ul className="test-result-reasons">

                      {outcome.decision.event.reasons.map(
                        (reason) => (
                          <li key={reason}>
                            {reason}
                          </li>
                        )
                      )}

                    </ul>
                  )}

                </>
              )}

              {outcome.status ===
                "rejected" && (
                <>
                  <p className="test-result-heading">
                    🚫 Notification not sent
                  </p>

                  <p>
                    {describeRejection(
                      outcome.decision
                    )}
                  </p>
                </>
              )}

              {outcome.status === "error" && (
                <>
                  <p className="test-result-heading">
                    ⚠️ Error
                  </p>

                  <p>
                    {outcome.message}
                  </p>
                </>
              )}

            </div>
          )}

        </section>

      </main>
    </div>
  );
}

export default App;