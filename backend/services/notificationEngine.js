// notificationEngine.js
//
// Decides whether a weather event coming out of weatherChangeDetector.js
// should be turned into a user-facing notification.
//
// This module does NOT touch the network, the filesystem, or any database.
// It is pure decision logic plus an in-memory duplicate guard.

"use strict";

const NOTIFICATION_CONFIDENCE_THRESHOLD = 0.8;

// Tracks events that have already produced a notification during the
// current backend process lifetime.
const notifiedEvents = new Set();

function createEventId(event) {
  return `${event.type}_${event.expectedAt}`;
}

function getValidationError(event) {
  if (
    event === null ||
    event === undefined ||
    typeof event !== "object"
  ) {
    return "INVALID_EVENT";
  }

  if (!event.type || typeof event.type !== "string") {
    return "MISSING_EVENT_TYPE";
  }

  if (
    !event.expectedAt ||
    typeof event.expectedAt !== "string"
  ) {
    return "MISSING_EXPECTED_AT";
  }

  if (
    typeof event.confidence !== "number" ||
    !Number.isFinite(event.confidence)
  ) {
    return "MISSING_OR_INVALID_CONFIDENCE";
  }

  if (
    event.confidence < 0 ||
    event.confidence > 1
  ) {
    return "CONFIDENCE_OUT_OF_RANGE";
  }

  return null;
}

/**
 * Formats both the detector's legacy
 * "YYYY-MM-DD HH:mm" value and ISO timestamps such as
 * "2026-09-20T11:45:12.000Z".
 *
 * ISO timestamps are converted to the machine's local time,
 * which is the same local environment in which WeatherSense
 * is running.
 */
function formatExpectedTime(expectedAt) {
  const legacyMatch =
    /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(
      expectedAt
    );

  if (legacyMatch) {
    const hour24 = Number(legacyMatch[4]);
    const minute = legacyMatch[5];
    const period = hour24 >= 12 ? "PM" : "AM";

    let hour12 = hour24 % 12;
    if (hour12 === 0) {
      hour12 = 12;
    }

    return `${hour12}:${minute} ${period}`;
  }

  const parsed = new Date(expectedAt);

  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  }

  return expectedAt;
}

function buildNotificationContent(event) {
  const time = formatExpectedTime(
    event.expectedAt
  );

  const confidencePercent = Math.round(
    event.confidence * 100
  );

  if (event.type === "RAIN_START") {
    return {
      title: "Rain expected soon",
      message:
        `Rain may begin around ${time}. ` +
        `WeatherSense confidence: ${confidencePercent}%.`,
    };
  }

  const readableType = event.type
    .replace(/_/g, " ")
    .toLowerCase();

  return {
    title: "Weather update",
    message:
      `Expect ${readableType} around ${time}. ` +
      `WeatherSense confidence: ${confidencePercent}%.`,
  };
}

function shouldNotifyEvent(event) {
  const validationError =
    getValidationError(event);

  if (validationError) {
    return {
      shouldNotify: false,
      reason: validationError,
      event: event ?? null,
    };
  }

  if (
    event.confidence <
    NOTIFICATION_CONFIDENCE_THRESHOLD
  ) {
    return {
      shouldNotify: false,
      reason: "CONFIDENCE_BELOW_THRESHOLD",
      event,
    };
  }

  const eventId = createEventId(event);

  if (notifiedEvents.has(eventId)) {
    return {
      shouldNotify: false,
      reason: "DUPLICATE_EVENT",
      eventId,
      event,
    };
  }

  notifiedEvents.add(eventId);

  const {
    title,
    message,
  } = buildNotificationContent(event);

  return {
    shouldNotify: true,
    eventId,
    title,
    message,
    confidence: event.confidence,
    event,
  };
}

function clearNotificationHistory() {
  notifiedEvents.clear();
}

module.exports = {
  shouldNotifyEvent,
  createEventId,
  clearNotificationHistory,
  NOTIFICATION_CONFIDENCE_THRESHOLD,
  formatExpectedTime,
  buildNotificationContent,
};
