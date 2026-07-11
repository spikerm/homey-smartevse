# Changelog
All notable changes to this project will be documented in this file.

This project follows a pragmatic versioning approach aligned with Homey App Store submissions.

## [2.0.0] - 2026-02-06
### Added
- BESEN driver added.

## [1.2.5] - 2025-12-29
### Changed
- Improved driver images (higher contrast) so the device icon is clearly visible in Homey tiles.
- Kept white background requirement for driver images while improving readability.

## [1.2.4] - 2025-12-29
### Added
- Added Homey Community Topic ID: `147883`.

## [1.2.3] - 2025-12-29
### Added
- Added `communityTopicId` field for Homey App Store requirements.

## [1.2.2] - 2025-12-29
### Changed
- Updated `homepage`, `supportUrl`, and `bugs.url` to GitHub:
  - Homepage: `https://github.com/spikerm/homey-smartevse`
  - Issues: `https://github.com/spikerm/homey-smartevse/issues`

## [1.2.1] - 2025-12-29
### Changed
- App Store: improved one-line description (tagline style).
- Replaced app icon with a more appealing, colored icon.
- Replaced driver images with a unique device-style image on a white background.
- Ensured app icon and driver images are not identical.

## [1.2.0] - 2025-12-29
### Added
- Homey notifications when charging starts and stops (configurable in App Settings).
- App Settings toggles:
  - Notify on charging start
  - Notify on charging stop
  - Include power in notifications

## [1.1.5] - 2025-12-29
### Fixed
- Fixed a startup crash caused by invalid JavaScript in `device.js`.

## [1.1.4] - 2025-12-29
### Fixed
- Fixed a syntax error introduced during cleanup in `device.js`.

## [1.1.3] - 2025-12-29
### Changed
- Removed the separate current (A) sensor device and current measurement to keep the app focused on EV charging power/energy and Homey Energy integration.

## [1.1.2] - 2025-12-29
### Fixed
- Charging state mapping improved:
  - `state_id = 1` (Connected / Waiting) now maps to Connected (not Charging).
  - Stopped states no longer “stick” to Charging.

## [1.1.1] - 2025-12-29
### Fixed
- Charging state detection corrected so “Ready to Charge” is not misclassified as Charging.

## [1.1.0] - 2025-12-29
### Added
- Improved EV charger state mapping for Homey Energy dashboard.
- (Later removed in 1.1.3) Introduced an optional separate current sensor tile.

## [1.0.9] - 2025-12-29
### Fixed
- Prevented overwriting current measurements with temporary 0A values during charging.

## [1.0.8] - 2025-12-29
### Fixed
- Correct current scaling (0.1A values converted to A).
- Prefer real meter values for power and energy when available:
  - `ev_meter.import_active_power` (kW → W)
  - `ev_meter.total_kwh` / `charged_kwh` / `import_active_energy`

## [1.0.0] - 2025-12-29
### Added
- Initial Homey integration for SmartEVSE via REST `/settings`.
- EV charger device class integration for Homey Energy dashboard.
