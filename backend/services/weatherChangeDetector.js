function getRainType(condition) {
  if (!condition || typeof condition !== "string") {
    return null;
  }

  const text = condition.toLowerCase();

  if (
    text.includes("heavy rain") ||
    text.includes("torrential rain")
  ) {
    return "HEAVY_RAIN";
  }

  if (
    text.includes("light rain") ||
    text.includes("moderate rain") ||
    text === "rain" ||
    text.includes("rain shower") ||
    text.includes("showers")
  ) {
    return "RAIN";
  }

  if (
    text.includes("patchy rain") ||
    text.includes("rain nearby") ||
    text.includes("drizzle")
  ) {
    return "POSSIBLE_RAIN";
  }

  return null;
}

function isActualRain(condition) {
  const rainType = getRainType(condition);

  return (
    rainType === "RAIN" ||
    rainType === "HEAVY_RAIN"
  );
}

function calculateRainConfidence({
  rainProbability,
  precipitation,
  conditionChanged,
  consistency,
  hoursUntilRain,
}) {
  const probabilitySignal =
    Number(rainProbability || 0) / 100;

  const precipitationSignal = Math.min(
    Number(precipitation || 0) / 2,
    1
  );

  const conditionSignal = conditionChanged ? 1 : 0;

  const consistencySignal = Number(consistency || 0);

  let proximitySignal = 0;

  if (hoursUntilRain <= 1) {
    proximitySignal = 1;
  } else if (hoursUntilRain <= 2) {
    proximitySignal = 0.8;
  } else if (hoursUntilRain <= 3) {
    proximitySignal = 0.6;
  } else if (hoursUntilRain <= 4) {
    proximitySignal = 0.4;
  } else {
    proximitySignal = 0.2;
  }

  const score =
    probabilitySignal * 0.35 +
    conditionSignal * 0.25 +
    precipitationSignal * 0.15 +
    consistencySignal * 0.15 +
    proximitySignal * 0.10;

  return Math.min(
    Number(score.toFixed(2)),
    1
  );
}

function detectRainStart(currentWeather, forecast) {
  if (
    !currentWeather ||
    !Array.isArray(forecast)
  ) {
    return null;
  }

  const currentIsRainy = isActualRain(
    currentWeather.condition
  );

  if (currentIsRainy) {
    return null;
  }

  for (let i = 0; i < forecast.length; i++) {
    const hour = forecast[i];

    if (!hour) {
      continue;
    }

    const hoursUntilRain =
      (Number(hour.time_epoch) -
        Number(currentWeather.time_epoch)) /
      3600;

    if (
      !Number.isFinite(hoursUntilRain) ||
      hoursUntilRain <= 0 ||
      hoursUntilRain > 6
    ) {
      continue;
    }

    if (!isActualRain(hour.condition)) {
      continue;
    }

    const previousHour =
      i > 0 ? forecast[i - 1] : null;

    const comparisonWeather =
      previousHour || currentWeather;

    const conditionChanged =
      !isActualRain(
        comparisonWeather?.condition
      );

    const supportingHours =
      forecast.slice(i, i + 3);

    const rainyHours =
      supportingHours.filter((item) =>
        isActualRain(item?.condition)
      ).length;

    const consistency =
      supportingHours.length > 0
        ? rainyHours / supportingHours.length
        : 0;

    const confidence =
      calculateRainConfidence({
        rainProbability:
          hour.precipitation_probability,
        precipitation:
          hour.precipitation_mm,
        conditionChanged,
        consistency,
        hoursUntilRain,
      });

    const reasons = [];

    if (
      Number(hour.precipitation_probability || 0) >= 60
    ) {
      reasons.push(
        `Rain probability is ${hour.precipitation_probability}%`
      );
    }

    if (conditionChanged) {
      reasons.push(
        `Forecast changes from ${
          comparisonWeather?.condition || "current conditions"
        } to ${hour.condition || "rain"}`
      );
    }

    if (Number(hour.precipitation_mm || 0) > 0) {
      reasons.push(
        `${hour.precipitation_mm} mm of precipitation is expected`
      );
    }

    if (hoursUntilRain <= 1) {
      reasons.push(
        "Rain is expected within 1 hour"
      );
    } else {
      reasons.push(
        `Rain is expected in approximately ${Math.round(
          hoursUntilRain
        )} hours`
      );
    }

    if (consistency >= 0.67) {
      reasons.push(
        "Rain remains likely in nearby forecast hours"
      );
    }

    return {
      type: "RAIN_START",
      severity:
        confidence >= 0.9
          ? "HIGH"
          : "MODERATE",
      confidence,
      expectedAt: hour.time,
      reasons,
    };
  }

  return null;
}

function detectWeatherChanges(
  currentWeather,
  forecast
) {
  const events = [];

  const rainEvent = detectRainStart(
    currentWeather,
    forecast
  );

  if (rainEvent) {
    events.push(rainEvent);
  }

  return events;
}

module.exports = {
  detectWeatherChanges,
};