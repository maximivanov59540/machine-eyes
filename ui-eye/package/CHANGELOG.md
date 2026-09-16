# Changelog

Notable changes to the `com.machine-eyes.ui-eye` package. Versions follow Semantic Versioning.

## [0.1.0] - Unreleased

The first public version.

### Added

- Shots of UI Toolkit panels: one cold batch run of Unity shoots a panel in every requested state and screen size.
  The verdict is in numbers: text does not fit, off the screen, outside the parent, zero size, frame not settled.
  The shot also saves frames, element trees and a contact sheet, with a signature: HEAD, Unity version, and the hashes
  of the markup and styles that were loaded.
- The panel registry: `[UiEyePanel]` on a static method in the project's Editor code. Registry errors name the place
  and answer code 5.
- `UiEyeFill.Text` and `UiEyeFill.AddClass` for states: a missing element fails loudly with code 6.
- The markup ↔ code linter. It needs no Unity, runs before every shot, and its findings stop the shot with code 6.
- The UI Toolkit type table, snapped from the project's own Unity into `UserSettings/ui-eye/uitk-types.json`: every
  shot refreshes it, and `types.js` snaps it explicitly.
- The command line: `ui-eye.js`, `lint.js`, `types.js`. Flags are Russian, with English aliases. The project comes from
  `--project`, the `UIEYE_PROJECT` variable, or a search upwards from the current folder.
- The MCP server with `ui_eye_shot`, `ui_eye_lint` and `ui_eye_help`.
- The calibration, `calibrate.js`, on the minimal calibration project: 129 checks with answers written before the first
  run, some of them on deliberate breakages.
- One shot at a time on the machine; code 3 while the project is open in Unity.
- Windows only; tested on Unity 6000.4.7f1.
