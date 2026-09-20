const { detectWeatherChanges } = require("./services/weatherChangeDetector");

const strongRainWeather = {
  condition: "Clear",
  time_epoch: 1788539400,
};

const strongRainForecast = [
  {
    time: "2026-09-04 23:00",
    time_epoch: 1788543000,
    condition: "Heavy rain",
    precipitation_probability: 95,
    precipitation_mm: 2.0,
  },
  {
    time: "2026-09-05 00:00",
    time_epoch: 1788546600,
    condition: "Heavy rain",
    precipitation_probability: 90,
    precipitation_mm: 1.5,
  },
  {
    time: "2026-09-05 01:00",
    time_epoch: 1788550200,
    condition: "Rain",
    precipitation_probability: 85,
    precipitation_mm: 1.0,
  },
];

const strongCheck = detectWeatherChanges(
  strongRainWeather,
  strongRainForecast
);

console.dir(strongCheck, { depth: null });