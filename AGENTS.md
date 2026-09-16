# AGENTS.md

Instructions for AI agents that work in this repository or connect ui-eye to a Unity project. For people:
[README.md](README.md).

## What is here

- `ui-eye/package`: the Unity package `com.machine-eyes.ui-eye`. `Editor/` holds the shooter that runs inside Unity, the
  panel registry, and the calibration panel `probe`. `Tools~/` holds the Node tools: the command line (`ui-eye.js`), the
  linter (`lint.js`), the type table (`types.js`), the calibration (`calibrate.js`) and the MCP server (`mcp/index.js`).
- `ui-eye/calibration`: a minimal Unity project that uses the package through `file:../../package`. The calibration runs
  on it.

## Rules

1. **Judge by the numbers; show the sheet to a person.** Findings and exit codes are the verdict. Whether a panel looks
   good is a person's decision.
2. **Close the editor before a shot.** Code 3 means the project is open in Unity or another shot is running. Wait or ask
   the person; do not kill a Unity process you did not start.
3. **One shot at a time on the machine.** Do not start shots in parallel. An MCP server queues its own calls.
4. **Zero is not clean.** A linter that checked nothing answers code 7. The "not checked" lists are part of the answer:
   report them.
5. **Do not edit calibration answers to make a check green.** A red check is first a question to the frame and the tree
   in the run folder. If the written answer turns out to be wrong, correct it and write the reason next to it (see the
   header of `Tools~/calibrate.js`).
6. **Linter first.** After editing `.uxml` or panel code, run the linter: it needs no Unity and takes about a second. If
   you are sure the linter is wrong, shoot with `--lint warn` and say so.
7. **Messages are in Russian.** Exit codes are the same everywhere; the README explains the findings and codes in
   English.

## Connecting ui-eye to a project

Each step has a command and the answer that means the step is done. `<tools>` is the package's `Tools~` folder,
`<project>` is the Unity project folder.

1. **Node.** `node --version` prints `v18` or newer.
2. **Package.** Add `com.machine-eyes.ui-eye` to `<project>/Packages/manifest.json` (README, Install). Check:
   `node <tools>/lint.js --project <project>` exits with 0 or 1, and in the list after `панели (сверено = вызовов-поисков ×
   панель):` the report has a line that starts with
   `«probe» — Packages/com.machine-eyes.ui-eye/Editor/Probe/Probe.uxml · элементов 6 · сверено 22 · находок 0`.
   Code 5: the project was not found. Code 7: nothing was checked.
3. **Unity.** The editor of the version in `<project>/ProjectSettings/ProjectVersion.txt` is at
   `C:\Program Files\Unity\Hub\Editor\<version>\Editor\Unity.exe`, or `UIEYE_UNITY` points to it. Checked by step 4:
   without it the answer is code 7 with `Unity не найдена: <path>`.
4. **Registry.** With the editor closed: `node <tools>/ui-eye.js --list --project <project>` exits with 0, and under
   `панели в реестре:` the report lists `«probe»` with six states. Your panels appear here after step 6.
5. **A shot.** `node <tools>/ui-eye.js --panel probe --states short --sizes 1920x1080 --project <project>` prints
   `итог: ЧИСТО — кадров 1, из них с находками 0 (код 0)` and a `лист:` line with the path to the sheet.
6. **Your panel.** Register it (README, Registering your panels). Check the pairing first:
   `node <tools>/lint.js --panel <name> --project <project>` exits with 0, `сверено` is above zero, and `не проверено: 0`
   (or every line of that list is explained to the person). Then shoot:
   `node <tools>/ui-eye.js --panel <name> --project <project>` exits with 0 or 1. Code 6 names the state and the element
   that do not match.
7. **The tool itself** (optional, in this repository):
   `node ui-eye/package/Tools~/calibrate.js всё --project ui-eye/calibration` ends with a line that starts with
   `калибровка: верно 129 из 129` (the time follows) and exits with 0. Fewer than 129 right is a finding to report with
   the part and the `НЕВЕРНО` lines, not something to fix by editing the answers.

## MCP

The server is `<tools>/mcp/index.js`: stdio, no dependencies, tools `ui_eye_shot`, `ui_eye_lint` and `ui_eye_help`.
Configuration: README, MCP server. Before the first shot in an unfamiliar project, call `ui_eye_help` with
`panels: true` to learn the panel names.

## Where things are

- Run folders: `<project>/Logs/ui-eye/<date-time>/`.
- The type table: `<project>/UserSettings/ui-eye/uitk-types.json`, outside git.
- The full usage text: `ui_eye_help`, or `HELP` in `Tools~/mcp/index.js`.

## Changing this repository

- UTF-8 without BOM, LF line endings (`.editorconfig`, `.gitattributes`).
- Never commit Unity DLLs or `uitk-types.json`.
- Unity writes the `.meta` files. A new file in `ui-eye/package` needs its `.meta` committed: a package installed from
  git is read-only, and Unity ignores a file without one there.
- After changing the package, run the calibration (step 7) and report the result with its numbers.
