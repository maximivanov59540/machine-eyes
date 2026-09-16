/**
 * ui-eye — запускатель: один холодный батч-запуск Unity = пачка снимков одной панели.
 *
 * Съёмщик живёт внутри Unity (Editor/UiEyeShooter.cs пакета) и умеет только снимать.
 * Здесь всё, что вокруг: сперва линтер «разметка ↔ код» (linter.js) — его находки останавливают снимок
 * до Unity; не пускать при открытом редакторе, запустить Unity, снять её по таймауту, прочесть ответ
 * съёмщика, а если ответа нет — назвать причину по журналу Unity (ошибки компиляции с файлом и строкой),
 * и подписать вердикт: HEAD, хеши загруженной разметки, какие из этих файлов не закоммичены.
 *
 * Проект — ключом, переменной UIEYE_PROJECT или поиском вверх от текущей папки (common.js); папки прогонов — у проекта,
 * в Logs/ui-eye/; калитка — одна на машину; всё, что зависит от ОС, — в platform.js.
 *
 * Зависимостей нет намеренно — как у map-eye-mcp-server, который будет звать shoot() напрямую.
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

import { CODES, ProjectNotFound, TOOLS, findPackage, findProject, git, markUncommitted } from "./common.js";
import { findingLine, lint, signatureLine } from "./linter.js";
import { EXLOCK, defaultUnity, killTree, openExclusive, unsupported } from "./platform.js";
import { storeTable, validateTable } from "./typestable.js";

// Коды живут в common.js (там же — почему отдельно), флаг исключительного открытия — в platform.js; отсюда их
// по-прежнему берут командная строка, MCP, калибровка.
export { CODES, EXLOCK };

export const DEFAULT_SIZES = ["1920x1080", "2560x1080"];

/** Линтер перед снимком: «стоп» (по умолчанию) — его находки останавливают снимок до Unity; «предупредить» — снимать всё равно. */
export const LINT_MODES = Object.freeze(["стоп", "предупредить"]);

// Находок линтера в отчёте снимка — не больше стольких; весь список отдаёт сам линтер.
const LINT_SHOWN = 10;

const VERDICTS = {
  0: "ЧИСТО",
  1: "НАХОДКИ",
  2: "НЕ СОБРАЛОСЬ",
  3: "ОТКАЗ",
  4: "СТОРОЖ",
  5: "ПЛОХОЙ ЗАПРОС",
  6: "ПАНЕЛЬ НЕ СХОДИТСЯ",
  7: "СБОЙ",
};

// Статусы съёмщика (UiEyeResult.status) → коды запускателя; «shots» решается по находкам.
const STATUS_CODES = {
  list: CODES.clean,
  "bad-request": CODES.request,
  panel: CODES.panel,
  watchdog: CODES.timeout,
  exception: CODES.failure,
};

const SHOOTER = "UiEye.UiEyeShooter.Run";

/** Папка прогонов — у проекта: стандартный .gitignore проекта Unity исключает Logs/, и прогоны не уходят с обновлением пакета. */
export function outDirectory(root) {
  return join(root, "Logs", "ui-eye");
}

/**
 * Калитка «один снимок за раз» — одна на машину, для всех проектов: командная строка, MCP любого агента, калибровка,
 * таблица типов. Лежит в папке временных файлов пользователя.
 *
 * Unity не откроет проект дважды, но замок проекта живая Unity берёт не сразу (замер: около секунды
 * после старта), и в это окно второй запуск прошёл бы проверку замка. Калитка — файл, открытый
 * исключительно на всё время снимка. Держит её дескриптор процесса, а не память: она общая для всех
 * процессов и отпускается сама, если держатель умер. Замер на Node v24.11.1: пока файл открыт,
 * второе исключительное открытие — EBUSY и в том же процессе, и в дочернем; после закрытия — открывается.
 *
 * Хозяин — рядом, в gate.json: проект, PID, время, что снимается. В саму калитку, пока она занята, другой процесс не
 * заглянет даже на чтение; отказ называет хозяина, только если его процесс жив.
 *
 * @param {{ project: string, what: string }} [owner] кто берёт; без него хозяин не пишется (взятие на миг — gateState).
 * @returns {{ release: () => void } | null} null — калитку держит другой снимок.
 */
export function takeGate(owner) {
  const directory = gateDirectory();
  mkdirSync(directory, { recursive: true });

  const fd = openExclusive(join(directory, "gate.lock"), true);
  if (fd === null) {
    return null;
  }

  if (owner) {
    try {
      const record = { project: owner.project, what: owner.what, pid: process.pid, since: new Date().toISOString() };
      writeFileSync(join(directory, "gate.json"), JSON.stringify(record, null, 2) + "\n", "utf8");
    } catch {
      // Хозяин — подсказка для чужого отказа, а не условие снимка.
    }
  }

  let held = true;
  return {
    release() {
      if (held) {
        held = false;
        closeSync(fd);
      }
    },
  };
}

/**
 * «free» или «busy» — для наблюдения (калибровка). Берёт калитку на миг и отпускает; в этот миг чужой
 * снимок получил бы отказ, поэтому звать только там, где соперников нет.
 */
export function gateState() {
  const gate = takeGate();
  if (gate === null) {
    return "busy";
  }

  gate.release();
  return "free";
}

/** Отказ занятой калитки — с хозяином из gate.json, если его процесс жив. */
export function gateBusy() {
  const owner = gateOwner();
  const who = owner ? ` (${owner.what}, проект ${owner.project}, PID ${owner.pid}, с ${owner.since})` : "";
  return (
    `идёт другой снимок ui-eye${who}: на машине снимки идут по одному — командная строка, MCP любого инстанса, ` +
    "калибровка и таблица типов. Повторить, когда он кончится"
  );
}

function gateOwner() {
  try {
    const owner = JSON.parse(readFileSync(join(gateDirectory(), "gate.json"), "utf8"));
    return Number.isInteger(owner?.pid) && alive(owner.pid) ? owner : null;
  } catch {
    return null;
  }
}

function alive(pid) {
  try {
    return process.kill(pid, 0);
  } catch (error) {
    return error.code === "EPERM";
  }
}

function gateDirectory() {
  return join(os.tmpdir(), "ui-eye");
}

/** Путь к Unity той версии, на которой стоит проект; иной — переменной UIEYE_UNITY. */
export function unityExecutable(root) {
  if (process.env.UIEYE_UNITY) {
    return process.env.UIEYE_UNITY;
  }

  const text = readText(join(root, "ProjectSettings", "ProjectVersion.txt")) ?? "";
  const version = /m_EditorVersion:\s*(\S+)/.exec(text)?.[1] ?? "?";
  return defaultUnity(version);
}

/**
 * «free» — замка нет; «stale» — файл есть, но его никто не держит (упавший запуск оставил);
 * «held» — держит живой процесс, то есть проект открыт.
 *
 * Существование файла НЕ означает открытый редактор: батч-запуск, упавший на компиляции, оставляет
 * замок 0 байт (замер), и проверка по существованию отказала бы ложно.
 */
export function lockState(root) {
  const lock = join(root, "Temp", "UnityLockfile");
  if (!existsSync(lock)) {
    return "free";
  }

  try {
    const fd = openExclusive(lock, false);
    if (fd === null) {
      return "held";
    }

    closeSync(fd);
    return "stale";
  } catch (error) {
    return error.code === "ENOENT" ? "free" : "held";
  }
}

/** Разбор журнала Unity: то, что называет причину, когда съёмщик не ответил. */
export function parseLog(text) {
  const lines = (text ?? "").split(/\r?\n/);
  const unique = (list) => [...new Set(list.map((line) => line.trim()))];
  const compile = unique(lines.filter((line) => /\(\d+,\d+\): error CS\d+:/.test(line)));

  return {
    exists: text != null,
    compile,
    compileFailed: compile.length > 0 || /Scripts have compiler errors/.test(text ?? ""),
    otherInstance: /another Unity instance is running|Multiple Unity instances cannot open the same project/i.test(text ?? ""),
    markup: unique(
      lines.filter(
        (line) => /\.(uxml|uss|tss)\b/i.test(line) && /\b(warning|error)\b/i.test(line) && !line.startsWith("Start importing"),
      ),
    ).slice(0, 20),
    shooter: lines.filter((line) => line.startsWith("ui-eye:")),
    tail: lines.filter((line) => line.trim()).slice(-25),
  };
}

/**
 * Снять панель. Вход: { panel, states[], sizes[], list, lint, watchdogSeconds, timeoutSeconds, out, project }.
 * Выход: { code, headline, report, directory, sheet, shots, result, lint }.
 *
 * Проект — input.project, переменная UIEYE_PROJECT или поиск вверх от текущей папки (common.js); не нашёлся — код 5,
 * без линтера и без Unity.
 *
 * Сперва — линтер «разметка ↔ код» (кроме списка панелей), до калитки и до замка: про имена ответ приходит, даже
 * когда идёт чужой снимок или открыт редактор. Его находки при lint «стоп» (по умолчанию) останавливают снимок — код 6,
 * ответ за полсекунды с файлом и строкой, Unity не запускается; «предупредить» — снимать всё равно, находки строками
 * в отчёте. Что линтер проверить не смог (код 5, 7), снимок не останавливает: последнее слово — у Unity.
 *
 * Снимок идёт под калиткой (takeGate). options.gate — калитка, уже взятая вызывающим: калибровка держит её
 * дольше снимка, пока в проекте лежит нарочно сломанный файл, чтобы его не скомпилировал чужой снимок.
 * Свою калитку shoot() берёт синхронно, до первого ожидания: когда обещание вернулось, она уже взята — или нет.
 * options.lintInput — наложения для линтера (overlay, remove, typesTable): только для калибровки, диск не трогается.
 */
export async function shoot(input = {}, options = {}) {
  let project = null;
  let missing = null;

  try {
    project = findProject(input.project);
  } catch (error) {
    if (!(error instanceof ProjectNotFound)) {
      throw error;
    }

    missing = error.message;
  }

  const run = newRun(input, project);

  if (missing !== null) {
    return conclude(run, CODES.request, missing);
  }

  if (!run.request.list) {
    if (input.lint !== undefined && !LINT_MODES.includes(input.lint)) {
      return conclude(run, CODES.request, `lint — «${LINT_MODES.join("» или «")}», а не «${input.lint}»`);
    }

    run.lint = lintFirst(run.request.panel, input.lint ?? "стоп", options.lintInput, project.root);

    if (run.lint.stops) {
      return conclude(
        run,
        CODES.panel,
        `линтер нашёл до Unity: находок ${run.lint.result.findings.length} — снимок не делался, Unity не запускалась`,
      );
    }
  }

  const platform = unsupported();
  if (platform !== null) {
    return conclude(run, CODES.failure, platform);
  }

  const what = run.request.list ? "список панелей" : `снимок «${run.request.panel}»`;
  const gate = options.gate ?? takeGate({ project: project.root, what });

  try {
    return await shootUnderGate(run, input, gate);
  } finally {
    if (gate !== null && gate !== options.gate) {
      gate.release();
    }
  }
}

/** Линтер перед снимком. stops — находки при режиме «стоп»; сбой самого линтера снимок не останавливает. */
function lintFirst(panel, mode, extra, root) {
  try {
    const outcome = lint({ ...(extra ?? {}), panel, project: root });
    return {
      mode,
      code: outcome.code,
      headline: outcome.headline,
      result: outcome.result,
      stops: mode === "стоп" && outcome.code === CODES.findings,
    };
  } catch (error) {
    return { mode, code: CODES.failure, headline: `сбой линтера: ${error?.message ?? error}`, result: null, stops: false };
  }
}

function newRun(input, project) {
  const root = project?.root ?? null;

  return {
    project,
    request: {
      version: 1,
      panel: input.panel ?? "",
      states: input.states ?? [],
      sizes: input.sizes?.length ? input.sizes : DEFAULT_SIZES,
      list: Boolean(input.list),
      watchdogSeconds: input.watchdogSeconds ?? 180,
      head: root === null ? "" : (git(root, ["rev-parse", "HEAD"]) ?? "").trim(),
    },
    unity: root === null ? "" : unityExecutable(root),
    lint: null,
    lock: null,
    directory: null,
    seconds: 0,
    exit: null,
    result: null,
    log: null,
    dirty: {},
    types: null,
  };
}

async function shootUnderGate(run, input, gate) {
  const request = run.request;
  const root = run.project.root;
  const timeoutSeconds = input.timeoutSeconds ?? 600;
  run.lock = gate === null ? null : lockState(root);

  if (!existsSync(run.unity)) {
    return conclude(run, CODES.failure, `Unity не найдена: ${run.unity} (версия — из ProjectSettings/ProjectVersion.txt; иной путь — UIEYE_UNITY)`);
  }

  if (gate === null) {
    return conclude(run, CODES.refused, gateBusy());
  }

  if (run.lock === "held") {
    return conclude(
      run,
      CODES.refused,
      "проект открыт в Unity: Temp/UnityLockfile держит живой процесс. Снимок — только при закрытом редакторе (или после конца другого снимка)",
    );
  }

  run.directory = input.out ? resolve(input.out) : newRunDirectory(root);
  mkdirSync(run.directory, { recursive: true });
  const requestPath = join(run.directory, "request.json");
  writeFileSync(requestPath, JSON.stringify(request, null, 2) + "\n", "utf8");

  // Таблицу типов съёмщик пишет сюда в начале запуска (АР-28, АР-33). Файл прошлого раза в заданной папке приняли бы за
  // снятый сейчас — убрать. unlinkSync, НЕ rmSync: на Node v24.11.1 rmSync молча не удаляет по пути с кириллицей.
  const typesPath = join(run.directory, "types.json");
  if (existsSync(typesPath)) {
    unlinkSync(typesPath);
  }

  const started = Date.now();
  run.exit = await runUnity(
    run.unity,
    [
      "-batchmode",
      "-projectPath",
      root,
      "-logFile",
      join(run.directory, "unity.log"),
      "-executeMethod",
      SHOOTER,
      "-uieyeRequest",
      requestPath,
      "-uieyeTypesOut",
      typesPath,
    ],
    timeoutSeconds * 1000,
    root,
  );
  run.seconds = (Date.now() - started) / 1000;
  run.result = readJson(join(run.directory, "result.json"));
  run.log = parseLog(readText(join(run.directory, "unity.log")));
  run.types = typesAlong(root, typesPath);

  if (run.exit.timedOut) {
    return conclude(run, CODES.timeout, `Unity не уложилась в ${timeoutSeconds} с — процесс снят; замок мог остаться мёртвым`);
  }

  if (run.log.otherInstance) {
    return conclude(run, CODES.refused, "сама Unity отказала: проект уже открыт другим экземпляром");
  }

  // Ответ съёмщика признаётся, только если Unity вышла с тем кодом, который он в ответ записал:
  // иначе после записи что-то упало, и ответ не последнее слово.
  if (run.result && run.result.exitCode === run.exit.code) {
    run.dirty = uncommitted(run.result.assets, root);

    if (run.result.status === "shots") {
      const findings = run.result.shots.some((shot) => shot.findings.length > 0);
      return conclude(run, findings ? CODES.findings : CODES.clean, run.result.message);
    }

    return conclude(run, STATUS_CODES[run.result.status] ?? CODES.failure, run.result.message);
  }

  if (run.log.compileFailed) {
    return conclude(run, CODES.compile, "Unity не компилирует скрипты — съёмщик не запускался");
  }

  return conclude(
    run,
    CODES.failure,
    `Unity вышла с кодом ${run.exit.code} без ответа съёмщика${run.exit.error ? ` (${run.exit.error})` : ""}`,
  );
}

/**
 * Запустить Unity и дождаться выхода; по таймауту процесс снимается целиком. Зовут снимок и таблица типов (types.js).
 * cwd — корень проекта.
 */
export function runUnity(executable, args, timeoutMs, cwd) {
  return new Promise((done) => {
    let timedOut = false;
    let child;

    try {
      child = spawn(executable, args, { cwd, stdio: "ignore", windowsHide: true });
    } catch (error) {
      done({ code: -1, timedOut, error: String(error) });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      done({ code: -1, timedOut, error: String(error) });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, timedOut });
    });
  });
}

function conclude(run, code, headline) {
  const report = format(run, code, headline);
  const shots = (run.result?.shots ?? []).map((shot) => ({
    state: shot.state,
    size: shot.size,
    png: join(run.directory, shot.png),
    tree: join(run.directory, shot.tree),
    findings: shot.findings,
  }));
  const sheet = run.result?.sheet ? join(run.directory, run.result.sheet) : null;

  if (run.directory) {
    writeFileSync(join(run.directory, "verdict.txt"), report + "\n", "utf8");
    writeFileSync(
      join(run.directory, "runner.json"),
      JSON.stringify(
        {
          code,
          verdict: VERDICTS[code],
          headline,
          seconds: run.seconds,
          lock: run.lock,
          exit: run.exit,
          request: run.request,
          lint: run.lint && {
            mode: run.lint.mode,
            code: run.lint.code,
            headline: run.lint.headline,
            stops: run.lint.stops,
            seconds: run.lint.result?.seconds ?? null,
            checked: run.lint.result?.coverage?.checked ?? null,
            findings: run.lint.result?.findings.length ?? null,
            notChecked: run.lint.result?.coverage?.notChecked ?? null,
          },
          uncommitted: run.dirty,
          types: run.types,
          compileErrors: run.log?.compile ?? [],
          markupMessages: run.log?.markup ?? [],
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
  }

  return { code, headline, report, directory: run.directory, sheet, shots, result: run.result, lint: run.lint };
}

/**
 * Таблица типов попутно (АР-28, АР-33): съёмщик пишет types.json в начале запуска. Годную кладём в проект, если она новая
 * или другая; строка отчёта называет исход. Исход снимка таблица не меняет.
 */
function typesAlong(root, path) {
  const text = readText(path);

  if (text === null) {
    return { state: "не снята (types.json нет)", lines: [] };
  }

  let table;
  try {
    table = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    return { state: "не сходится сама с собой — не записана", lines: [`types.json не читается как JSON: ${error.message}`] };
  }

  const problems = validateTable(table);
  if (problems.length > 0) {
    return { state: "не сходится сама с собой — не записана", lines: problems };
  }

  const stored = storeTable(root, table);
  const summary = `типов ${stored.normalized.types.length}, Unity ${stored.normalized.unityVersion}`;
  return stored.same ? { state: `та же (${summary})`, lines: [] } : { state: `записана — ${summary}`, lines: stored.difference };
}

function format(run, code, headline) {
  const result = run.result;
  const request = run.request;
  const lines = [];

  // Съёмщик, отказавший до разбора запроса, пишет пустые списки — тогда показываем то, что просили.
  const states = result?.states?.length ? result.states : request.states;
  const sizes = result?.sizes?.length ? result.sizes : request.sizes;
  const what = request.list
    ? "список панелей"
    : `«${request.panel}» · состояния: ${states.join(", ") || "все"} · размеры: ${sizes.join(", ")}`;
  lines.push(`ui-eye · ${what}`);
  lines.push(`итог: ${VERDICTS[code]} — ${headline} (код ${code})`);

  if (run.project) {
    lines.push(`проект: ${run.project.root} (${run.project.how})`);
  }

  if (run.lint) {
    lintLines(lines, run.lint, request.panel, run.project.root);
  }

  if (run.seconds) {
    lines.push(`время: ${run.seconds.toFixed(1)} с от запуска Unity до выхода`);
  }

  if (run.types) {
    lines.push(`таблица типов: ${run.types.state}`);

    for (const line of run.types.lines) {
      lines.push(`  ${line}`);
    }
  }

  if (run.lock === "stale") {
    lines.push("замок: мёртвый Temp/UnityLockfile от прошлого упавшего запуска — не помеха");
  }

  if (result?.unityVersion) {
    lines.push(
      `подпись: HEAD ${short(request.head)} · Unity ${result.unityVersion} · ${result.graphicsDevice} · ${result.colorSpace} · ${result.scaleMode}` +
        (result.markupHash ? ` · разметка ${short(result.markupHash)}` : ""),
    );

    for (const asset of result.assets ?? []) {
      const mark = run.dirty[asset.path];
      lines.push(`  ${asset.path}  ${short(asset.sha256)}${mark ? `  — НЕ В КОММИТЕ (${mark})` : ""}`);
    }
  }

  if (code === CODES.compile) {
    for (const line of run.log.compile) {
      lines.push(`  ${line}`);
    }
  }

  if (result?.status === "shots") {
    lines.push(`кадры: ${result.shots.length} из ${result.states.length * result.sizes.length}`);

    for (const shot of result.shots) {
      const verdict = shot.findings.length === 0 ? "чисто" : `находок ${shot.findings.length}`;
      lines.push(
        `  ${shot.state}  ${shot.size}  ${verdict} · элементов ${shot.elements}, проверено ${shot.checkedElements}, ` +
          `текстовых ${shot.textElements} · чтений ${shot.reads}${shot.settled ? "" : " — НЕ УСТОЯЛСЯ"}`,
      );

      for (const finding of shot.findings) {
        lines.push(`      ${finding.kind}  ${finding.element}  ${finding.detail}`);
      }
    }

    lines.push(
      "охват проверок: текст не влез · за краем экрана · за родителя (элементы в потоке) · нулевой размер (именованные) · " +
        "кадр не устоялся. НЕ проверяются: наложения соседей и «красиво ли».",
    );
  }

  if (result?.status === "list" || result?.status === "bad-request") {
    const known = result.knownPanels ?? [];
    // Отказ реестра приходит без панелей: «нет» — ответ, а голый заголовок читался бы как оборванный список.
    lines.push(known.length > 0 ? "панели в реестре:" : "панели в реестре: нет");

    for (const panel of known) {
      lines.push(`  «${panel.name}» — ${panel.description} (${panel.markup})`);

      for (const state of panel.states) {
        lines.push(`      ${state.name} — ${state.description}`);
      }
    }
  }

  if (run.log?.markup.length) {
    lines.push("журнал Unity о разметке и стилях:");

    for (const line of run.log.markup) {
      lines.push(`  ${line}`);
    }
  }

  if (code === CODES.failure || code === CODES.timeout) {
    for (const line of run.log?.shooter ?? []) {
      lines.push(`  ${line}`);
    }

    if (run.log?.tail.length) {
      lines.push("хвост журнала Unity:");

      for (const line of run.log.tail) {
        lines.push(`  ${line}`);
      }
    }
  }

  if (run.directory) {
    lines.push(`папка: ${run.directory}`);
  }

  if (result?.sheet) {
    lines.push(`лист: ${join(run.directory, result.sheet)}`);
  }

  return lines.join("\n");
}

/**
 * Строки линтера в отчёте снимка: чисто или «не проверил» — одна строка; находки — ещё и они (не больше LINT_SHOWN);
 * остановил снимок — ещё «что делать» и подпись линтера: без Unity другой подписи у ответа нет.
 */
function lintLines(lines, lint, panel, root) {
  const result = lint.result;
  const seconds = result ? ` · ${result.seconds.toFixed(1)} с` : "";

  if (lint.code === CODES.clean) {
    lines.push(`линтер: чисто — сверено обращений ${result.coverage.checked}, не проверено ${result.coverage.notChecked}${seconds}`);
  } else if (lint.code === CODES.findings) {
    const going = lint.stops ? "" : ` · снимок идёт по запросу (lint: «${lint.mode}»)`;
    lines.push(`линтер: находок ${result.findings.length}; сверено обращений ${result.coverage.checked}${going}${seconds}`);
    result.findings.slice(0, LINT_SHOWN).forEach((finding) => lines.push(`  ${findingLine(finding)}`));

    if (result.findings.length > LINT_SHOWN) {
      lines.push(`  … и ещё ${result.findings.length - LINT_SHOWN} — весь список: ui_eye_lint или ${lintCommand(panel, root)}`);
    }
  } else {
    lines.push(`линтер: не проверил (код ${lint.code}) — ${lint.headline.split("\n")[0]}${seconds}`);
  }

  if (result?.types && !result.types.ok && (lint.code === CODES.clean || lint.code === CODES.findings)) {
    lines.push(`линтер: ТИПЫ НЕ ПРОВЕРЯЛИСЬ — ${result.types.reason}`);
  }

  if (lint.stops) {
    lines.push(
      "что делать: поправить имя в коде или разметке и снять снова; если ошибся линтер — снимать с lint: «предупредить» " +
        `(командная строка: --линтер предупредить); весь ответ линтера — ui_eye_lint или ${lintCommand(panel, root)}`,
    );
    lines.push(`подпись линтера: HEAD ${short(result.head)}`);

    for (const item of result.signature) {
      lines.push(`  ${signatureLine(item)}`);
    }
  }
}

/** Команда линтера с настоящим путём инструмента и проектом: подсказку копируют в терминал, где текущая папка — любая. */
function lintCommand(panel, root) {
  const name = /\s/.test(panel) ? `"${panel}"` : panel;
  return `node "${join(TOOLS, "lint.js")}" --проект "${root}" --панель ${name}`;
}

/**
 * Какие из загруженных файлов расходятся с HEAD: «??» — не добавлен, «M» — изменён. Файлы пакета ui-eye — от его
 * репозитория (common.js, markUncommitted).
 */
function uncommitted(assets, root) {
  const paths = (assets ?? []).map((asset) => asset.path).filter((path) => path.startsWith("Assets/") || path.startsWith("Packages/"));
  return markUncommitted(root, findPackage(root), paths);
}

function newRunDirectory(root) {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  const base = outDirectory(root);
  let directory = join(base, stamp);
  for (let suffix = 2; existsSync(directory); suffix++) {
    directory = join(base, `${stamp}-${suffix}`);
  }

  return directory;
}

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function readJson(path) {
  const text = readText(path);
  if (text == null) {
    return null;
  }

  try {
    // Съёмщик пишет JSON из C#: знак порядка байтов в начале возможен — снять его до разбора.
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return null;
  }
}

function short(value) {
  return value ? value.slice(0, 12) : "?";
}
