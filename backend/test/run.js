const {
  detectWeatherChanges,
} = require("../services/weatherChangeDetector");

const {
  shouldNotifyEvent,
  clearNotificationHistory,
  formatExpectedTime,
  buildNotificationContent,
  NOTIFICATION_CONFIDENCE_THRESHOLD,
} = require("../services/notificationEngine");

function assert(condition, message) {
  if (!condition) {
    console.error("FAIL:", message);
    process.exitCode = 1;
  } else {
    console.log("PASS:", message);
  }
}

console.log("WeatherSense backend regression tests");
console.log("--------------------------------------");

assert(
  NOTIFICATION_CONFIDENCE_THRESHOLD === 0.8,
  "notification threshold is exactly 0.80"
);

// Scenario 1: strong rain event.
clearNotificationHistory();

const now = Math.floor(Date.now() / 1000);

const currentWeather = {
  condition: "Clear",
  time_epoch: now,
};

const testForecast = [
  {
    time: new Date(
      (now + 3600) * 1000
    ).toISOString(),
    time_epoch: now + 3600,
    condition: "Heavy rain",
    precipitation_probability: 90,
    precipitation_mm: 2,
    temperature_c: 24,
    humidity: 85,
    wind_kph: 20,
    cloud: 95,
  },
  {
    time: new Date(
      (now + 7200) * 1000
    ).toISOString(),
    time_epoch: now + 7200,
    condition: "Heavy rain",
    precipitation_probability: 85,
    precipitation_mm: 3,
    temperature_c: 23,
    humidity: 88,
    wind_kph: 22,
    cloud: 100,
  },
  {
    time: new Date(
      (now + 10800) * 1000
    ).toISOString(),
    time_epoch: now + 10800,
    condition: "Rain",
    precipitation_probability: 80,
    precipitation_mm: 2,
    temperature_c: 23,
    humidity: 90,
    wind_kph: 18,
    cloud: 95,
  },
];

const events = detectWeatherChanges(
  currentWeather,
  testForecast
);

assert(
  events.length === 1,
  "exactly one RAIN_START event detected"
);

assert(
  events[0].confidence >= 0.8,
  `strong rain confidence ${events[0].confidence} is >= 0.80`
);

const decision1 =
  shouldNotifyEvent(events[0]);

assert(
  decision1.shouldNotify === true,
  "strong rain event qualifies for notification"
);

assert(
  decision1.confidence === events[0].confidence,
  "notification decision preserves event confidence"
);

assert(
  typeof decision1.title === "string" &&
    decision1.title.length > 0,
  "notification decision has a title"
);

assert(
  typeof decision1.message === "string" &&
    decision1.message.includes(
      "WeatherSense confidence"
    ),
  "notification decision has a confidence message"
);

// Same event must be deduplicated.
const decision2 =
  shouldNotifyEvent(events[0]);

assert(
  decision2.shouldNotify === false &&
    decision2.reason === "DUPLICATE_EVENT",
  "same event is deduplicated"
);

// Scenario 2: below threshold.
clearNotificationHistory();

const weakEvent = {
  type: "RAIN_START",
  severity: "MODERATE",
  confidence: 0.79,
  expectedAt: "2026-09-12 20:00",
  reasons: [],
};

const decision3 =
  shouldNotifyEvent(weakEvent);

assert(
  decision3.shouldNotify === false &&
    decision3.reason ===
      "CONFIDENCE_BELOW_THRESHOLD",
  "0.79 confidence does not notify"
);

// Scenario 3: exact threshold.
const borderlineEvent = {
  type: "RAIN_START",
  severity: "MODERATE",
  confidence: 0.8,
  expectedAt: "2026-09-12 20:00",
  reasons: [],
};

const decision4 =
  shouldNotifyEvent(borderlineEvent);

assert(
  decision4.shouldNotify === true,
  "exactly 0.80 confidence does notify"
);

// Scenario 4: already raining.
const rainyNow = {
  condition: "Light rain",
  time_epoch: now,
};

const eventsWhileRaining =
  detectWeatherChanges(
    rainyNow,
    testForecast
  );

assert(
  eventsWhileRaining.length === 0,
  "already-raining conditions do not create RAIN_START"
);

// Scenario 5: malformed/null events.
clearNotificationHistory();

const malformed = {
  type: "RAIN_START",
};

const decision5 =
  shouldNotifyEvent(malformed);

assert(
  decision5.shouldNotify === false &&
    decision5.reason ===
      "MISSING_EXPECTED_AT",
  "malformed event is rejected safely"
);

let threw = false;

try {
  shouldNotifyEvent(null);
} catch {
  threw = true;
}

assert(
  !threw,
  "null event does not throw"
);

// Scenario 6: confidence range validation.
const invalidConfidence = {
  type: "RAIN_START",
  expectedAt: "2026-09-12 20:00",
  confidence: 1.5,
};

const decision6 =
  shouldNotifyEvent(invalidConfidence);

assert(
  decision6.shouldNotify === false &&
    decision6.reason ===
      "CONFIDENCE_OUT_OF_RANGE",
  "confidence above 1 is rejected safely"
);

// Scenario 7: expected-time formatting.
assert(
  formatExpectedTime("2026-09-12 20:00") ===
    "8:00 PM",
  "legacy expectedAt time is formatted correctly"
);

const isoFormatted =
  formatExpectedTime(
    "2026-09-20T11:45:12.000Z"
  );

assert(
  typeof isoFormatted === "string" &&
    isoFormatted.length > 0 &&
    isoFormatted !==
      "2026-09-20T11:45:12.000Z",
  "ISO expectedAt is formatted for notification"
);

// Scenario 8: notification content.
const content =
  buildNotificationContent({
    type: "RAIN_START",
    confidence: 0.96,
    expectedAt:
      "2026-09-12 20:00",
  });

assert(
  content.title === "Rain expected soon",
  "RAIN_START notification title is correct"
);

assert(
  content.message.includes("96%"),
  "notification message includes confidence percentage"
);

console.log("--------------------------------------");
console.log("Done.");
