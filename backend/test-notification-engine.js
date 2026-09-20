// test-notification-engine.js
//
// Simple Node.js test suite for notificationEngine.js using only the
// built-in "assert" module - no extra test dependency needed for a suite
// this small.
//
// Run with:  node test-notification-engine.js

"use strict";

const assert = require("assert");
const {
  shouldNotifyEvent,
  createEventId,
  clearNotificationHistory,
} = require("./services/notificationEngine");

let passed = 0;
let failed = 0;

/**
 * Runs a single named test. Catches and reports failures without stopping
 * the rest of the suite, so one failing test doesn't hide the others.
 */
function test(name, fn) {
  try {
    fn();
    console.log(`PASS - ${name}`);
    passed++;
  } catch (err) {
    console.log(`FAIL - ${name}`);
    console.log(`       ${err.message}`);
    failed++;
  }
}

function makeRainEvent(overrides = {}) {
  return {
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
    ...overrides,
  };
}

console.log("Running notificationEngine tests...\n");

// Each test starts from a clean slate so tests can't affect each other
// through the shared in-memory duplicate set.

test("A. confidence 0.98 -> notification allowed", () => {
  clearNotificationHistory();
  const result = shouldNotifyEvent(makeRainEvent({ confidence: 0.98 }));
  assert.strictEqual(result.shouldNotify, true);
  assert.strictEqual(result.title, "Rain expected soon");
  assert.ok(result.message.includes("98%"));
});

test("B. confidence exactly 0.80 -> notification allowed", () => {
  clearNotificationHistory();
  const result = shouldNotifyEvent(makeRainEvent({ confidence: 0.8 }));
  assert.strictEqual(result.shouldNotify, true);
});

test("C. confidence 0.79 -> notification rejected", () => {
  clearNotificationHistory();
  const result = shouldNotifyEvent(makeRainEvent({ confidence: 0.79 }));
  assert.strictEqual(result.shouldNotify, false);
  assert.strictEqual(result.reason, "CONFIDENCE_BELOW_THRESHOLD");
});

test("D. same event twice -> first allowed, second rejected as duplicate", () => {
  clearNotificationHistory();
  const event = makeRainEvent();
  const first = shouldNotifyEvent(event);
  const second = shouldNotifyEvent(event);

  assert.strictEqual(first.shouldNotify, true);
  assert.strictEqual(second.shouldNotify, false);
  assert.strictEqual(second.reason, "DUPLICATE_EVENT");
  assert.strictEqual(second.eventId, createEventId(event));
});

test("E. two different event IDs -> both can notify", () => {
  clearNotificationHistory();
  const eventOne = makeRainEvent({ expectedAt: "2026-09-04 23:00" });
  const eventTwo = makeRainEvent({ expectedAt: "2026-09-05 06:00" });

  const resultOne = shouldNotifyEvent(eventOne);
  const resultTwo = shouldNotifyEvent(eventTwo);

  assert.strictEqual(resultOne.shouldNotify, true);
  assert.strictEqual(resultTwo.shouldNotify, true);
  assert.notStrictEqual(resultOne.eventId, resultTwo.eventId);
});

test("F. invalid event -> handled safely without crashing", () => {
  clearNotificationHistory();

  const nullResult = shouldNotifyEvent(null);
  assert.strictEqual(nullResult.shouldNotify, false);
  assert.strictEqual(nullResult.reason, "INVALID_EVENT");

  const undefinedResult = shouldNotifyEvent(undefined);
  assert.strictEqual(undefinedResult.shouldNotify, false);
  assert.strictEqual(undefinedResult.reason, "INVALID_EVENT");

  const missingType = shouldNotifyEvent(
    makeRainEvent({ type: undefined })
  );
  assert.strictEqual(missingType.shouldNotify, false);
  assert.strictEqual(missingType.reason, "MISSING_EVENT_TYPE");

  const missingExpectedAt = shouldNotifyEvent(
    makeRainEvent({ expectedAt: undefined })
  );
  assert.strictEqual(missingExpectedAt.shouldNotify, false);
  assert.strictEqual(missingExpectedAt.reason, "MISSING_EXPECTED_AT");

  const missingConfidence = shouldNotifyEvent(
    makeRainEvent({ confidence: undefined })
  );
  assert.strictEqual(missingConfidence.shouldNotify, false);
  assert.strictEqual(missingConfidence.reason, "MISSING_OR_INVALID_CONFIDENCE");

  const nonNumericConfidence = shouldNotifyEvent(
    makeRainEvent({ confidence: "0.98" })
  );
  assert.strictEqual(nonNumericConfidence.shouldNotify, false);
  assert.strictEqual(
    nonNumericConfidence.reason,
    "MISSING_OR_INVALID_CONFIDENCE"
  );
});

test("G. clearNotificationHistory() allows a previously notified event to be notified again", () => {
  clearNotificationHistory();
  const event = makeRainEvent();

  const first = shouldNotifyEvent(event);
  assert.strictEqual(first.shouldNotify, true);

  const duplicate = shouldNotifyEvent(event);
  assert.strictEqual(duplicate.shouldNotify, false);

  clearNotificationHistory();

  const afterClear = shouldNotifyEvent(event);
  assert.strictEqual(afterClear.shouldNotify, true);
});

console.log(`\n${passed} passed, ${failed} failed (${passed + failed} total)`);

if (failed > 0) {
  process.exitCode = 1;
}
