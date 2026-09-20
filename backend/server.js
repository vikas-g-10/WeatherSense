require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");

const {
  shouldNotifyEvent,
} = require("./services/notificationEngine");

const {
  detectWeatherChanges,
} = require("./services/weatherChangeDetector");

const app = express();

app.use(cors());
app.use(express.json());

// --------------------------------------------------
// Basic routes
// --------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    message: "WeatherSense Backend API",
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    service: "WeatherSense Backend",
  });
});

// --------------------------------------------------
// Current weather
// --------------------------------------------------

app.get("/weather/:city", async (req, res) => {
  try {
    const city = req.params.city.trim();

    if (!city) {
      return res.status(400).json({
        error: "City name is required",
      });
    }

    const response = await axios.get(
      "https://api.weatherapi.com/v1/current.json",
      {
        params: {
          key: process.env.WEATHER_API_KEY,
          q: city,
        },
      }
    );

    const weather = response.data;

    const formattedWeather = {
      city: weather.location.name,
      region: weather.location.region,
      country: weather.location.country,

      temperature_c: weather.current.temp_c,
      feels_like_c: weather.current.feelslike_c,
      condition: weather.current.condition.text,

      humidity: weather.current.humidity,
      wind_kph: weather.current.wind_kph,
      pressure_mb: weather.current.pressure_mb,

      last_updated: weather.current.last_updated,
      time_epoch: weather.current.last_updated_epoch,
    };

    res.json(formattedWeather);
  } catch (error) {
    console.error(
      "Weather API error:",
      error.message
    );

    if (error.response?.status === 400) {
      return res.status(404).json({
        error: "City not found",
      });
    }

    res.status(500).json({
      error: "Unable to fetch weather data",
    });
  }
});

// --------------------------------------------------
// Hourly forecast
// --------------------------------------------------

app.get("/forecast/:city", async (req, res) => {
  try {
    const city = req.params.city.trim();

    if (!city) {
      return res.status(400).json({
        error: "City name is required",
      });
    }

    const response = await axios.get(
      "https://api.weatherapi.com/v1/forecast.json",
      {
        params: {
          key: process.env.WEATHER_API_KEY,
          q: city,
          days: 2,
          aqi: "no",
          alerts: "yes",
        },
      }
    );

    const forecast = response.data;

    const hourlyForecast =
      forecast.forecast.forecastday
        .flatMap((day) => day.hour)
        .map((hour) => ({
          time: hour.time,
          time_epoch: hour.time_epoch,

          temperature_c: hour.temp_c,
          feels_like_c: hour.feelslike_c,

          condition: hour.condition.text,

          precipitation_probability:
            hour.chance_of_rain,

          precipitation_mm:
            hour.precip_mm,

          humidity: hour.humidity,
          wind_kph: hour.wind_kph,
          wind_gust_kph: hour.gust_kph,
          cloud: hour.cloud,
        }));

    res.json({
      city: forecast.location.name,
      region: forecast.location.region,
      country: forecast.location.country,

      forecast: hourlyForecast,

      alerts:
        forecast.alerts?.alert || [],
    });
  } catch (error) {
    console.error(
      "Forecast API error:",
      error.message
    );

    if (error.response?.status === 400) {
      return res.status(404).json({
        error: "City not found",
      });
    }

    res.status(500).json({
      error: "Unable to fetch forecast data",
    });
  }
});

// --------------------------------------------------
// Manual notification evaluation
// --------------------------------------------------

app.post(
  "/api/notifications/evaluate",
  (req, res) => {
    const event = req.body?.event;

    const decision =
      shouldNotifyEvent(event);

    res.json(decision);
  }
);

// --------------------------------------------------
// REAL WEATHER CHANGE CHECK
// --------------------------------------------------

app.get(
  "/api/weather/:city/check",
  async (req, res) => {
    try {
      const city = req.params.city.trim();

      if (!city) {
        return res.status(400).json({
          error: "City name is required",
        });
      }

      // --------------------------------------------
      // Fetch real WeatherAPI forecast
      // --------------------------------------------

      const response = await axios.get(
        "https://api.weatherapi.com/v1/forecast.json",
        {
          params: {
            key: process.env.WEATHER_API_KEY,
            q: city,
            days: 2,
            aqi: "no",
            alerts: "yes",
          },
        }
      );

      const forecast = response.data;

      // --------------------------------------------
      // Current weather
      // --------------------------------------------

      const currentWeather = {
        condition:
          forecast.current.condition.text,

        time_epoch:
          forecast.current.last_updated_epoch,
      };

      // --------------------------------------------
      // Convert WeatherAPI hourly forecast
      // --------------------------------------------

      const hourlyForecast =
        forecast.forecast.forecastday
          .flatMap((day) => day.hour)
          .map((hour) => ({
            time: hour.time,

            time_epoch:
              hour.time_epoch,

            temperature_c:
              hour.temp_c,

            feels_like_c:
              hour.feelslike_c,

            condition:
              hour.condition.text,

            precipitation_probability:
              hour.chance_of_rain,

            precipitation_mm:
              hour.precip_mm,

            humidity:
              hour.humidity,

            wind_kph:
              hour.wind_kph,

            wind_gust_kph:
              hour.gust_kph,

            cloud:
              hour.cloud,
          }));

      // --------------------------------------------
      // Detect significant weather changes
      // --------------------------------------------

      const events =
        detectWeatherChanges(
          currentWeather,
          hourlyForecast
        );

      // --------------------------------------------
      // Run every detected event through
      // the notification decision engine
      // --------------------------------------------

      const decisions =
        events.map((event) =>
          shouldNotifyEvent(event)
        );

      // --------------------------------------------
      // Return complete result to desktop app
      // --------------------------------------------

      res.json({
        city:
          forecast.location.name,

        region:
          forecast.location.region,

        country:
          forecast.location.country,

        currentWeather,

        checkedAt:
          new Date().toISOString(),

        events,

        decisions,
      });
    } catch (error) {
      console.error(
        "Weather change check error:",
        error.message
      );

      if (error.response?.status === 400) {
        return res.status(404).json({
          error: "City not found",
        });
      }

      res.status(500).json({
        error:
          "Unable to check weather changes",
      });
    }
  }
);

// --------------------------------------------------
// TEST: Strong rain event
// --------------------------------------------------

app.get(
  "/api/test/rain-event",
  (req, res) => {
    const now =
      Math.floor(Date.now() / 1000);

    const currentWeather = {
      condition: "Clear",
      time_epoch: now,
    };

    const testForecast = [
      {
        time:
          new Date(
            (now + 3600) * 1000
          ).toISOString(),

        time_epoch:
          now + 3600,

        condition:
          "Heavy rain",

        precipitation_probability: 90,

        precipitation_mm: 2,

        temperature_c: 24,

        humidity: 85,

        wind_kph: 20,

        cloud: 95,
      },

      {
        time:
          new Date(
            (now + 7200) * 1000
          ).toISOString(),

        time_epoch:
          now + 7200,

        condition:
          "Heavy rain",

        precipitation_probability: 85,

        precipitation_mm: 3,

        temperature_c: 23,

        humidity: 88,

        wind_kph: 22,

        cloud: 100,
      },

      {
        time:
          new Date(
            (now + 10800) * 1000
          ).toISOString(),

        time_epoch:
          now + 10800,

        condition:
          "Rain",

        precipitation_probability: 80,

        precipitation_mm: 2,

        temperature_c: 23,

        humidity: 90,

        wind_kph: 18,

        cloud: 95,
      },
    ];

    const events =
      detectWeatherChanges(
        currentWeather,
        testForecast
      );

    const evaluate =
      req.query.evaluate !== "false";

    const decisions = evaluate
      ? events.map((event) =>
          shouldNotifyEvent(event)
        )
      : [];

    res.json({
      test: "Strong rain event",

      currentWeather,

      forecast: testForecast,

      events,

      decisions,

      evaluated: evaluate,
    });
  }
);

// --------------------------------------------------
// Start server
// --------------------------------------------------

const PORT =
  process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(
    `WeatherSense backend running on http://localhost:${PORT}`
  );
});