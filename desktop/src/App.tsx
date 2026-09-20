import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

const BACKEND_URL = "http://localhost:5000";
const DEFAULT_CITY = "Bengaluru";
const DEFAULT_MONITOR_INTERVAL = 15;
const NOTIFICATION_THRESHOLD = 0.8;
const SETTINGS_STORAGE_KEY = "weathersense-settings";
const SCHEDULER_SYNC_KEY =
  "weathersense-scheduler-initialized";

type WeatherData = {
  city: string;
  region: string;
  country: string;
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

type WeatherEvent = {
  type: string;
  severity: string;
  confidence: number;
  expectedAt: string;
  reasons: string[];
};

type NotificationDecision = {
  shouldNotify: boolean;
  eventId?: string;
  title?: string;
  message?: string;
  confidence?: number;
  reason?: string;
  event?: WeatherEvent;
};

type Settings = {
  city: string;
  automaticMonitoring: boolean;
  monitoringInterval: number;
  notificationsEnabled: boolean;
};

const DEFAULT_SETTINGS: Settings = {
  city: DEFAULT_CITY,
  automaticMonitoring: true,
  monitoringInterval: DEFAULT_MONITOR_INTERVAL,
  notificationsEnabled: true,
};

function loadSettings(): Settings {
  try {
    const saved = localStorage.getItem(
      SETTINGS_STORAGE_KEY
    );

    if (!saved) {
      return DEFAULT_SETTINGS;
    }

    const parsed = JSON.parse(saved);

    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function TemperatureChart({
  forecast,
}: {
  forecast: ForecastHour[];
}) {
  if (!forecast.length) {
    return null;
  }

  const visibleForecast = forecast.slice(0, 12);

  const temperatures = visibleForecast.map(
    (hour) => hour.temperature_c
  );

  const minTemp = Math.min(...temperatures);
  const maxTemp = Math.max(...temperatures);

  const range = Math.max(maxTemp - minTemp, 1);

  return (
    <div
      style={{
        marginTop: 24,
        padding: 20,
        borderRadius: 16,
        background: "#f8fafc",
        border: "1px solid #e2e8f0",
      }}
    >
      <h3 style={{ marginTop: 0 }}>
        Temperature Trend
      </h3>

      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          gap: 8,
          height: 180,
          overflowX: "auto",
        }}
      >
        {visibleForecast.map((hour) => {
          const height =
            ((hour.temperature_c - minTemp) / range) *
              120 +
            30;

          const time = new Date(
            hour.time
          ).toLocaleTimeString([], {
            hour: "numeric",
          });

          return (
            <div
              key={hour.time_epoch}
              style={{
                minWidth: 55,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "flex-end",
                height: "100%",
              }}
            >
              <span
                style={{
                  fontSize: 12,
                  marginBottom: 6,
                  fontWeight: 600,
                }}
              >
                {Math.round(
                  hour.temperature_c
                )}
                °
              </span>

              <div
                style={{
                  width: 26,
                  height,
                  borderRadius: 8,
                  background: "#0f172a",
                }}
              />

              <span
                style={{
                  fontSize: 11,
                  marginTop: 6,
                  color: "#64748b",
                }}
              >
                {time}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function App() {
  const [settings, setSettings] =
    useState<Settings>(loadSettings);

  const [weather, setWeather] =
    useState<WeatherData | null>(null);

  const [forecast, setForecast] =
    useState<ForecastHour[]>([]);

  const [loading, setLoading] =
    useState(false);

  const [error, setError] =
    useState("");

  const [lastChecked, setLastChecked] =
    useState<Date | null>(null);

  const [monitoringStatus, setMonitoringStatus] =
    useState("Monitoring inactive");

  const [notificationStatus, setNotificationStatus] =
    useState("");

  const [showSettings, setShowSettings] =
    useState(false);

  const [draftSettings, setDraftSettings] =
    useState<Settings>(settings);

  /*
   * Refs allow Tauri events to call the latest
   * versions of these functions without repeatedly
   * registering listeners.
   */
  const checkLiveWeatherRef =
    useRef<() => void>(() => {});

  const openSettingsRef =
    useRef<() => void>(() => {});

  /*
   * Save settings to localStorage and synchronize
   * monitoring settings with the Rust scheduler.
   *
   * This is the ONLY place that updates the Rust
   * scheduler when the user changes Settings.
   */
  async function saveSettings(
    nextSettings: Settings
  ) {
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify(nextSettings)
    );

    setSettings(nextSettings);

    try {
      await invoke("update_scheduler", {
        intervalMinutes:
          nextSettings.monitoringInterval,
        monitoringEnabled:
          nextSettings.automaticMonitoring,
      });

      console.log(
        "WeatherSense scheduler settings sent to Rust:",
        {
          intervalMinutes:
            nextSettings.monitoringInterval,
          monitoringEnabled:
            nextSettings.automaticMonitoring,
        }
      );
    } catch (error) {
      console.error(
        "Failed to update Rust scheduler:",
        error
      );

      setError(
        "Settings saved, but the background scheduler could not be updated."
      );
    }
  }

  /*
   * Request permission for desktop notifications.
   */
  async function ensureNotificationPermission() {
    try {
      let permissionGranted =
        await isPermissionGranted();

      if (!permissionGranted) {
        const permission =
          await requestPermission();

        permissionGranted =
          permission === "granted";
      }

      return permissionGranted;
    } catch (error) {
      console.error(
        "Notification permission error:",
        error
      );

      return false;
    }
  }

  /*
   * Send a native Windows notification when the
   * backend notification engine allows it.
   */
  async function sendWeatherNotification(
    decision: NotificationDecision
  ) {
    if (!decision.shouldNotify) {
      return;
    }

    if (!settings.notificationsEnabled) {
      console.log(
        "Notification skipped because notifications are disabled"
      );

      return;
    }

    if (
      typeof decision.confidence === "number" &&
      decision.confidence <
        NOTIFICATION_THRESHOLD
    ) {
      console.log(
        "Notification skipped because confidence is below threshold"
      );

      return;
    }

    const permissionGranted =
      await ensureNotificationPermission();

    if (!permissionGranted) {
      console.warn(
        "Notification permission not granted"
      );

      return;
    }

    try {
      await sendNotification({
        title:
          decision.title ||
          "WeatherSense Alert",
        body:
          decision.message ||
          "Weather change detected.",
      });

      setNotificationStatus(
        "Weather notification sent"
      );
    } catch (error) {
      console.error(
        "Notification error:",
        error
      );

      setNotificationStatus(
        "Unable to send notification"
      );
    }
  }

  /*
   * Send a detected weather event to the backend
   * notification engine for threshold + deduplication.
   */
  async function evaluateEvent(
    event: WeatherEvent
  ) {
    try {
      const response = await fetch(
        `${BACKEND_URL}/api/notifications/evaluate`,
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json",
          },
          body: JSON.stringify({
            event,
          }),
        }
      );

      if (!response.ok) {
        throw new Error(
          "Notification evaluation failed"
        );
      }

      const decision: NotificationDecision =
        await response.json();

      console.log(
        "WeatherSense notification decision:",
        decision
      );

      await sendWeatherNotification(
        decision
      );

      return decision;
    } catch (error) {
      console.error(
        "Event evaluation error:",
        error
      );

      return null;
    }
  }

  /*
   * Fetch current weather, forecast and weather-change
   * detection from the backend.
   */
  async function checkLiveWeather() {
    if (loading) {
      console.log(
        "WeatherSense check skipped because another check is running"
      );

      return;
    }

    const city = settings.city.trim();

    if (!city) {
      setError(
        "Please enter a city name."
      );

      return;
    }

    try {
      setLoading(true);
      setError("");

      console.log(
        `WeatherSense checking weather for ${city}`
      );

      /*
       * Current weather
       */
      const weatherResponse =
        await fetch(
          `${BACKEND_URL}/weather/${encodeURIComponent(
            city
          )}`
        );

      if (!weatherResponse.ok) {
        throw new Error(
          "Unable to fetch current weather"
        );
      }

      const weatherData: WeatherData =
        await weatherResponse.json();

      setWeather(weatherData);

      /*
       * Forecast
       */
      const forecastResponse =
        await fetch(
          `${BACKEND_URL}/forecast/${encodeURIComponent(
            city
          )}`
        );

      if (!forecastResponse.ok) {
        throw new Error(
          "Unable to fetch forecast"
        );
      }

      const forecastData =
        await forecastResponse.json();

      setForecast(
        forecastData.forecast || []
      );

      setLastChecked(new Date());

      setMonitoringStatus(
        settings.automaticMonitoring
          ? `Monitoring ${weatherData.city} every ${settings.monitoringInterval} minutes`
          : "Automatic monitoring disabled"
      );

      console.log(
        "WeatherSense weather check completed"
      );

      /*
       * Weather change detection
       */
      try {
        const checkResponse =
          await fetch(
            `${BACKEND_URL}/api/weather/${encodeURIComponent(
              city
            )}/check`
          );

        if (checkResponse.ok) {
          const checkData =
            await checkResponse.json();

          console.log(
            "WeatherSense change detection result:",
            checkData
          );

          if (
            Array.isArray(
              checkData.events
            ) &&
            checkData.events.length > 0
          ) {
            for (const event of checkData.events) {
              await evaluateEvent(
                event
              );
            }
          }
        }
      } catch (changeError) {
        console.error(
          "Weather change detection error:",
          changeError
        );
      }
    } catch (error) {
      console.error(
        "WeatherSense weather error:",
        error
      );

      setError(
        error instanceof Error
          ? error.message
          : "Unable to load weather"
      );
    } finally {
      setLoading(false);
    }
  }

  /*
   * Keep the latest weather-check function
   * available to Tauri events.
   */
  checkLiveWeatherRef.current =
    checkLiveWeather;

  /*
   * Open Settings.
   */
  function openSettings() {
    setDraftSettings(settings);
    setShowSettings(true);
  }

  openSettingsRef.current =
    openSettings;

  function closeSettings() {
    setShowSettings(false);
  }

  /*
   * Save Settings modal.
   */
  async function saveSettingsFromModal() {
    await saveSettings(draftSettings);

    setShowSettings(false);

    console.log(
      "WeatherSense settings saved:",
      draftSettings
    );
  }

  /*
   * Initial weather load.
   */
  useEffect(() => {
    checkLiveWeatherRef.current();
  }, []);

  /*
   * Synchronize the saved Settings with the
   * Rust scheduler once when WeatherSense starts.
   *
   * sessionStorage prevents React development
   * remounts / Strict Mode from sending the same
   * startup synchronization multiple times.
   *
   * If the synchronization fails, the flag is
   * removed so the next startup can retry.
   */
  useEffect(() => {
    if (
      sessionStorage.getItem(
        SCHEDULER_SYNC_KEY
      ) === "true"
    ) {
      console.log(
        "WeatherSense scheduler already synchronized for this session"
      );

      return;
    }

    sessionStorage.setItem(
      SCHEDULER_SYNC_KEY,
      "true"
    );

    async function synchronizeScheduler() {
      try {
        await invoke("update_scheduler", {
          intervalMinutes:
            settings.monitoringInterval,
          monitoringEnabled:
            settings.automaticMonitoring,
        });

        console.log(
          "WeatherSense initial scheduler settings synchronized"
        );
      } catch (error) {
        sessionStorage.removeItem(
          SCHEDULER_SYNC_KEY
        );

        console.error(
          "WeatherSense scheduler synchronization failed:",
          error
        );
      }
    }

    synchronizeScheduler();
  }, []);

  /*
   * Update monitoring status when the user changes
   * monitoring settings.
   *
   * IMPORTANT:
   * There is NO React setInterval here.
   *
   * Rust/Tauri owns the automatic monitoring timer.
   */
  useEffect(() => {
    if (!settings.automaticMonitoring) {
      setMonitoringStatus(
        "Automatic monitoring disabled"
      );

      return;
    }

    setMonitoringStatus(
      `Monitoring every ${settings.monitoringInterval} minutes`
    );
  }, [
    settings.automaticMonitoring,
    settings.monitoringInterval,
  ]);

  /*
   * Tauri tray + Rust background scheduler listeners.
   *
   * IMPORTANT:
   * listen() is asynchronous. React cleanup can happen
   * before listen() resolves, especially under React
   * StrictMode's development mount/cleanup/remount cycle.
   *
   * The isCancelled flag prevents a listener created
   * after cleanup from remaining registered.
   *
   * Only confirmed active listeners are stored in
   * unlistenFns and cleaned up on unmount.
   */
  useEffect(() => {
    let isCancelled = false;

    const unlistenFns: Array<() => void> = [];

    async function setupTrayListeners() {
      console.log(
        "WeatherSense event listeners initializing"
      );

      /*
       * Tray → Check Now
       */
      const unlistenCheck = await listen(
        "tray-check-now",
        () => {
          console.log(
            "WeatherSense tray Check Now triggered"
          );

          checkLiveWeatherRef.current();
        }
      );

      if (isCancelled) {
        unlistenCheck();
      } else {
        unlistenFns.push(unlistenCheck);
      }

      /*
       * Tray → Settings
       */
      const unlistenSettings = await listen(
        "tray-open-settings",
        () => {
          console.log(
            "WeatherSense tray Settings triggered"
          );

          openSettingsRef.current();
        }
      );

      if (isCancelled) {
        unlistenSettings();
      } else {
        unlistenFns.push(
          unlistenSettings
        );
      }

      /*
       * Rust scheduler → frontend
       */
      const unlistenBackground = await listen(
        "background-weather-check",
        () => {
          console.log(
            "WeatherSense background check triggered"
          );

          checkLiveWeatherRef.current();
        }
      );

      if (isCancelled) {
        unlistenBackground();
      } else {
        unlistenFns.push(
          unlistenBackground
        );
      }

      if (!isCancelled) {
        console.log(
          "WeatherSense event listeners ready"
        );
      }
    }

    setupTrayListeners();

    return () => {
      isCancelled = true;

      unlistenFns.forEach(
        (unlisten) => unlisten()
      );

      unlistenFns.length = 0;
    };
  }, []);

  /*
   * Manual notification test.
   */
  /*
   * Development-only end-to-end automatic alert test.
   *
   * This does NOT call sendNotification() directly.
   * It gets a synthetic weather event from the backend,
   * sends that event through the same notification engine
   * used by real weather checks, and then uses the normal
   * Tauri notification path.
   */
  async function testAutomaticAlert() {
    setNotificationStatus(
      "Testing automatic weather alert..."
    );

    try {
      const response = await fetch(
        `${BACKEND_URL}/api/test/rain-event?evaluate=false`
      );

      if (!response.ok) {
        throw new Error(
          "Automatic alert test endpoint failed"
        );
      }

      const data = await response.json();

      if (
        !Array.isArray(data.events) ||
        data.events.length === 0
      ) {
        throw new Error(
          "Automatic alert test did not produce an event"
        );
      }

      console.log(
        "WeatherSense automatic alert test event:",
        data.events[0]
      );

      const decision = await evaluateEvent(
        data.events[0]
      );

      if (!decision?.shouldNotify) {
        setNotificationStatus(
          decision?.reason === "DUPLICATE_EVENT"
            ? "Automatic alert test was deduplicated"
            : "Automatic alert test did not qualify for notification"
        );

        return;
      }

      setNotificationStatus(
        `Automatic alert test sent (${Math.round(
          (decision.confidence || 0) * 100
        )}% confidence)`
      );
    } catch (error) {
      console.error(
        "Automatic alert test failed:",
        error
      );

      setNotificationStatus(
        "Automatic alert test failed"
      );
    }
  }

  async function testNotification() {
    setNotificationStatus(
      "Testing notification..."
    );

    try {
      const permissionGranted =
        await ensureNotificationPermission();

      if (!permissionGranted) {
        setNotificationStatus(
          "Notification permission not granted"
        );

        return;
      }

      await sendNotification({
        title: "WeatherSense",
        body:
          "Test notification sent successfully.",
      });

      setNotificationStatus(
        "Test notification sent"
      );
    } catch (error) {
      console.error(
        "Test notification failed:",
        error
      );

      setNotificationStatus(
        "Test notification failed"
      );
    }
  }

  const currentTemperature =
    weather?.temperature_c;

  return (
    <div
      style={{
        minHeight: "100vh",
        background:
          "linear-gradient(135deg, #f8fafc, #e2e8f0)",
        padding: 32,
        fontFamily:
          "Inter, system-ui, sans-serif",
        color: "#0f172a",
      }}
    >
      <div
        style={{
          maxWidth: 1100,
          margin: "0 auto",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 28,
          }}
        >
          <div>
            <h1
              style={{
                margin: 0,
                fontSize: 32,
              }}
            >
              WeatherSense
            </h1>

            <p
              style={{
                marginTop: 6,
                color: "#64748b",
              }}
            >
              Intelligent desktop weather monitoring
            </p>
          </div>

          <button
            onClick={openSettings}
            style={{
              border: "none",
              borderRadius: 10,
              padding: "10px 16px",
              background: "#0f172a",
              color: "white",
              cursor: "pointer",
            }}
          >
            Settings
          </button>
        </div>

        {/* Status */}
        <div
          style={{
            display: "flex",
            gap: 12,
            flexWrap: "wrap",
            marginBottom: 20,
          }}
        >
          <div
            style={{
              padding: "8px 12px",
              borderRadius: 999,
              background:
                settings.automaticMonitoring
                  ? "#dcfce7"
                  : "#f1f5f9",
              color:
                settings.automaticMonitoring
                  ? "#166534"
                  : "#475569",
              fontSize: 13,
            }}
          >
            {monitoringStatus}
          </div>

          {lastChecked && (
            <div
              style={{
                padding: "8px 12px",
                borderRadius: 999,
                background: "#e2e8f0",
                color: "#475569",
                fontSize: 13,
              }}
            >
              Last checked{" "}
              {lastChecked.toLocaleTimeString()}
            </div>
          )}
        </div>

        {/* Error */}
        {error && (
          <div
            style={{
              padding: 14,
              marginBottom: 20,
              borderRadius: 12,
              background: "#fee2e2",
              color: "#991b1b",
            }}
          >
            {error}
          </div>
        )}

        {/* Main Weather Card */}
        {weather && (
          <div
            style={{
              background: "white",
              borderRadius: 20,
              padding: 28,
              boxShadow:
                "0 10px 30px rgba(15,23,42,0.08)",
              marginBottom: 24,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 20,
                flexWrap: "wrap",
              }}
            >
              <div>
                <h2
                  style={{
                    margin: 0,
                    fontSize: 28,
                  }}
                >
                  {weather.city}
                </h2>

                <p
                  style={{
                    margin: "6px 0",
                    color: "#64748b",
                  }}
                >
                  {weather.region},{" "}
                  {weather.country}
                </p>

                <p
                  style={{
                    fontSize: 18,
                    marginTop: 20,
                  }}
                >
                  {weather.condition}
                </p>
              </div>

              <div
                style={{
                  textAlign: "right",
                }}
              >
                <div
                  style={{
                    fontSize: 56,
                    fontWeight: 700,
                  }}
                >
                  {currentTemperature}°
                </div>

                <div
                  style={{
                    color: "#64748b",
                  }}
                >
                  Feels like{" "}
                  {weather.feels_like_c}°
                </div>
              </div>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns:
                  "repeat(auto-fit, minmax(160px, 1fr))",
                gap: 12,
                marginTop: 28,
              }}
            >
              <div
                style={{
                  padding: 16,
                  background: "#f8fafc",
                  borderRadius: 12,
                }}
              >
                <strong>Humidity</strong>
                <div>
                  {weather.humidity}%
                </div>
              </div>

              <div
                style={{
                  padding: 16,
                  background: "#f8fafc",
                  borderRadius: 12,
                }}
              >
                <strong>Wind</strong>
                <div>
                  {weather.wind_kph} km/h
                </div>
              </div>

              <div
                style={{
                  padding: 16,
                  background: "#f8fafc",
                  borderRadius: 12,
                }}
              >
                <strong>Pressure</strong>
                <div>
                  {weather.pressure_mb} mb
                </div>
              </div>

              <div
                style={{
                  padding: 16,
                  background: "#f8fafc",
                  borderRadius: 12,
                }}
              >
                <strong>Updated</strong>
                <div>
                  {weather.last_updated}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Forecast */}
        {forecast.length > 0 && (
          <div
            style={{
              background: "white",
              borderRadius: 20,
              padding: 28,
              boxShadow:
                "0 10px 30px rgba(15,23,42,0.08)",
              marginBottom: 24,
            }}
          >
            <h2
              style={{
                marginTop: 0,
              }}
            >
              Hourly Forecast
            </h2>

            <div
              style={{
                display: "flex",
                gap: 12,
                overflowX: "auto",
                paddingBottom: 8,
              }}
            >
              {forecast
                .slice(0, 12)
                .map((hour) => (
                  <div
                    key={hour.time_epoch}
                    style={{
                      minWidth: 130,
                      padding: 16,
                      borderRadius: 14,
                      background: "#f8fafc",
                    }}
                  >
                    <strong>
                      {new Date(
                        hour.time
                      ).toLocaleTimeString(
                        [],
                        {
                          hour: "numeric",
                        }
                      )}
                    </strong>

                    <div
                      style={{
                        fontSize: 24,
                        fontWeight: 700,
                        marginTop: 8,
                      }}
                    >
                      {Math.round(
                        hour.temperature_c
                      )}
                      °
                    </div>

                    <div
                      style={{
                        fontSize: 13,
                        color: "#64748b",
                        marginTop: 4,
                      }}
                    >
                      {hour.condition}
                    </div>

                    <div
                      style={{
                        fontSize: 12,
                        marginTop: 10,
                      }}
                    >
                      Rain:{" "}
                      {
                        hour.precipitation_probability
                      }
                      %
                    </div>
                  </div>
                ))}
            </div>

            <TemperatureChart
              forecast={forecast}
            />
          </div>
        )}

        {/* Controls */}
        <div
          style={{
            background: "white",
            borderRadius: 20,
            padding: 24,
            boxShadow:
              "0 10px 30px rgba(15,23,42,0.08)",
          }}
        >
          <div
            style={{
              display: "flex",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <button
              onClick={() =>
                checkLiveWeatherRef.current()
              }
              disabled={loading}
              style={{
                border: "none",
                borderRadius: 10,
                padding: "12px 18px",
                background: loading
                  ? "#94a3b8"
                  : "#0f172a",
                color: "white",
                cursor: loading
                  ? "not-allowed"
                  : "pointer",
              }}
            >
              {loading
                ? "Checking..."
                : "Check Weather Now"}
            </button>

            <button
              onClick={testNotification}
              style={{
                border:
                  "1px solid #cbd5e1",
                borderRadius: 10,
                padding: "12px 18px",
                background: "white",
                color: "#0f172a",
                cursor: "pointer",
              }}
            >
              Test Notification
            </button>

            <button
              onClick={testAutomaticAlert}
              style={{
                border:
                  "1px solid #cbd5e1",
                borderRadius: 10,
                padding: "12px 18px",
                background: "white",
                color: "#0f172a",
                cursor: "pointer",
              }}
            >
              Test Automatic Alert
            </button>
          </div>

          {notificationStatus && (
            <p
              style={{
                marginBottom: 0,
                marginTop: 14,
                color: "#475569",
              }}
            >
              {notificationStatus}
            </p>
          )}
        </div>
      </div>

      {/* Settings Modal */}
      {showSettings && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background:
              "rgba(15,23,42,0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
          }}
        >
          <div
            style={{
              width: "100%",
              maxWidth: 500,
              background: "white",
              borderRadius: 20,
              padding: 28,
              boxShadow:
                "0 20px 50px rgba(0,0,0,0.2)",
            }}
          >
            <h2
              style={{
                marginTop: 0,
              }}
            >
              WeatherSense Settings
            </h2>

            <label
              style={{
                display: "block",
                marginBottom: 8,
                fontWeight: 600,
              }}
            >
              City
            </label>

            <input
              value={draftSettings.city}
              onChange={(event) =>
                setDraftSettings({
                  ...draftSettings,
                  city: event.target.value,
                })
              }
              placeholder="Enter city"
              style={{
                width: "100%",
                boxSizing:
                  "border-box",
                padding: 12,
                borderRadius: 10,
                border:
                  "1px solid #cbd5e1",
                marginBottom: 20,
              }}
            />

            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginBottom: 18,
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={
                  draftSettings.automaticMonitoring
                }
                onChange={(event) =>
                  setDraftSettings({
                    ...draftSettings,
                    automaticMonitoring:
                      event.target.checked,
                  })
                }
              />

              Automatic monitoring
            </label>

            <label
              style={{
                display: "block",
                marginBottom: 8,
                fontWeight: 600,
              }}
            >
              Monitoring interval
            </label>

            <select
              value={
                draftSettings.monitoringInterval
              }
              onChange={(event) =>
                setDraftSettings({
                  ...draftSettings,
                  monitoringInterval:
                    Number(
                      event.target.value
                    ),
                })
              }
              style={{
                width: "100%",
                padding: 12,
                borderRadius: 10,
                border:
                  "1px solid #cbd5e1",
                marginBottom: 20,
              }}
            >
              {[5, 10, 15, 30, 60].map(
                (minutes) => (
                  <option
                    key={minutes}
                    value={minutes}
                  >
                    Every {minutes} minutes
                  </option>
                )
              )}
            </select>

            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginBottom: 24,
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={
                  draftSettings.notificationsEnabled
                }
                onChange={(event) =>
                  setDraftSettings({
                    ...draftSettings,
                    notificationsEnabled:
                      event.target.checked,
                  })
                }
              />

              Enable desktop notifications
            </label>

            <div
              style={{
                display: "flex",
                justifyContent:
                  "flex-end",
                gap: 10,
              }}
            >
              <button
                onClick={closeSettings}
                style={{
                  padding:
                    "10px 16px",
                  borderRadius: 10,
                  border:
                    "1px solid #cbd5e1",
                  background: "white",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>

              <button
                onClick={
                  saveSettingsFromModal
                }
                style={{
                  padding:
                    "10px 16px",
                  borderRadius: 10,
                  border: "none",
                  background:
                    "#0f172a",
                  color: "white",
                  cursor: "pointer",
                }}
              >
                Save Settings
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;