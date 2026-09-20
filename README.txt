# WeatherSense final notification code

Replace these files in your project:

- desktop/src/App.tsx
- backend/server.js
- backend/services/notificationEngine.js
- backend/test/run.js

The App.tsx keeps the already-fixed async Tauri listener cleanup and adds:
- Test Automatic Alert button
- end-to-end synthetic rain alert test
- use of the normal notification decision path

server.js keeps /api/test/rain-event compatible with the existing test:
- /api/test/rain-event -> evaluates the event as before
- /api/test/rain-event?evaluate=false -> returns the event without consuming it,
  so the desktop app can send that event through /api/notifications/evaluate.

notificationEngine.js:
- keeps the 0.80 threshold
- keeps deduplication
- handles ISO timestamps from WeatherAPI
- formats notification time
- validates confidence range

backend/test/run.js:
- regression tests threshold, deduplication, detector integration,
  malformed input, already-raining behavior, and time formatting.

Run:
  cd backend
  npm test

Then start backend:
  npm run dev

Then in another terminal:
  cd desktop
  npx tauri dev

In WeatherSense, click:
  Test Automatic Alert

Expected:
  Windows native notification: "Rain expected soon"
  message includes "WeatherSense confidence: 96%."

Do not copy .env or API keys into this package.
