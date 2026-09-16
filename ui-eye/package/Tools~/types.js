#!/usr/bin/env node
/**
 * ui-eye — таблица типов UI Toolkit для линтера: какой элемент чей потомок.
 *
 *   node Tools~/types.js [--проект <папка проекта>]
 *
 * Один батч-запуск Unity зовёт UiEye.UiEyeTypes.Dump (Editor/UiEyeTypes.cs пакета) и пишет таблицу проекта —
 * UserSettings/ui-eye/uitk-types.json. Таблица снимается с самой Unity, а не пишется по памяти: линтер без Unity должен
 * знать, что Label — это TextElement, а Button — не Label, ровно так, как это знает версия Unity проекта. Нужна
 * заново только при смене версии Unity — линтер сам скажет, что таблица снята с другой.
 *
 * Проект — ключ --проект (--project), переменная UIEYE_PROJECT или поиск вверх от текущей папки. Условия те же, что у
 * снимка: редактор закрыт, калитка одна на машину. Журнал и сырой ответ — <проект>/Logs/ui-eye/типы/.
 *
 * Выход: 0 — таблица записана · 2 — Unity не компилирует скрипты · 3 — отказ (проект открыт или идёт снимок) ·
 * 4 — таймаут · 5 — плохой запрос (проект не найден, непонятный ключ) · 7 — сбой.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import { CODES, ProjectNotFound, findProject } from "./common.js";
import { unsupported } from "./platform.js";
import { gateBusy, lockState, outDirectory, parseLog, runUnity, takeGate, unityExecutable } from "./runner.js";
import { TYPES_TABLE, storeTable, validateTable } from "./typestable.js";

const METHOD = "UiEye.UiEyeTypes.Dump";
const TIMEOUT_SECONDS = 600;

const VERDICTS = {
  0: "ЗАПИСАНА",
  2: "НЕ СОБРАЛОСЬ",
  3: "ОТКАЗ",
  4: "ТАЙМАУТ",
  5: "ПЛОХОЙ ЗАПРОС",
  7: "СБОЙ",
};

class BadArguments extends Error {}

async function main(argv) {
  let project;

  try {
    project = findProject(parse(argv));
  } catch (error) {
    if (error instanceof BadArguments || error instanceof ProjectNotFound) {
      return say(CODES.request, error.message);
    }

    throw error;
  }

  const places = {
    table: join(project.root, ...TYPES_TABLE.split("/")),
    directory: join(outDirectory(project.root), "типы"),
  };

  // Строка «журнал» — только когда Unity запускалась: до запуска файла нет или он от прошлого раза.
  const platform = unsupported();
  if (platform !== null) {
    return say(CODES.failure, platform);
  }

  const gate = takeGate({ project: project.root, what: "таблица типов" });

  if (gate === null) {
    return say(CODES.refused, gateBusy());
  }

  try {
    return await dumpUnderGate(project, places);
  } finally {
    gate.release();
  }
}

function parse(argv) {
  let project;

  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];

    if ((flag === "--проект" || flag === "--project") && index + 1 < argv.length) {
      project = argv[++index];
    } else {
      throw new BadArguments(`Не понял аргумент «${flag}». Флаги: --проект <папка проекта> (--project).`);
    }
  }

  return project;
}

async function dumpUnderGate(project, places) {
  if (lockState(project.root) === "held") {
    return say(CODES.refused, "проект открыт в Unity: Temp/UnityLockfile держит живой процесс. Таблица — только при закрытом редакторе");
  }

  const unity = unityExecutable(project.root);
  if (!existsSync(unity)) {
    return say(CODES.failure, `Unity не найдена: ${unity} (версия — из ProjectSettings/ProjectVersion.txt; иной путь — UIEYE_UNITY)`);
  }

  const dump = join(places.directory, "types.json");
  const logFile = join(places.directory, "unity.log");
  mkdirSync(places.directory, { recursive: true });

  // unlinkSync, НЕ rmSync: на Node v24.11.1 rmSync молча не удаляет по пути с кириллицей.
  for (const stale of [dump, logFile]) {
    if (existsSync(stale)) {
      unlinkSync(stale);
    }
  }

  const started = Date.now();
  const exit = await runUnity(
    unity,
    ["-batchmode", "-projectPath", project.root, "-logFile", logFile, "-executeMethod", METHOD, "-uieyeTypesOut", dump],
    TIMEOUT_SECONDS * 1000,
    project.root,
  );
  const seconds = (Date.now() - started) / 1000;
  const log = parseLog(readText(logFile));

  if (exit.timedOut) {
    return say(CODES.timeout, `Unity не уложилась в ${TIMEOUT_SECONDS} с — процесс снят; замок мог остаться мёртвым`, [], seconds, places);
  }

  if (log.otherInstance) {
    return say(CODES.refused, "сама Unity отказала: проект уже открыт другим экземпляром", [], seconds, places);
  }

  const text = readText(dump);

  if (exit.code !== 0 || text === null) {
    if (log.compileFailed) {
      return say(CODES.compile, "Unity не компилирует скрипты — таблица не снята", log.compile, seconds, places);
    }

    return say(
      CODES.failure,
      `Unity вышла с кодом ${exit.code}${text === null ? " без таблицы" : ""}`,
      [...log.shooter, "хвост журнала Unity:", ...log.tail],
      seconds,
      places,
    );
  }

  let table;
  try {
    table = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    return say(CODES.failure, `таблица не читается как JSON: ${error.message}`, [], seconds, places);
  }

  const problems = validateTable(table);
  if (problems.length > 0) {
    return say(CODES.failure, "таблица снята, но не сходится сама с собой — не записана", problems, seconds, places);
  }

  // Явный пересъём пишет всегда (always); разница с прежней — как и у таблицы попутно.
  const stored = storeTable(project.root, table, { always: true });
  return say(
    CODES.clean,
    `типов ${stored.normalized.types.length}, Unity ${stored.normalized.unityVersion}`,
    stored.difference,
    seconds,
    places,
  );
}

function say(code, headline, details = [], seconds = 0, places = null) {
  const lines = ["ui-eye · таблица типов UI Toolkit", `итог: ${VERDICTS[code] ?? code} — ${headline} (код ${code})`];

  if (seconds) {
    lines.push(`время: ${seconds.toFixed(1)} с от запуска Unity до выхода`);
  }

  for (const detail of details) {
    lines.push(`  ${detail}`);
  }

  if (places) {
    lines.push(code === CODES.clean ? `файл: ${places.table}` : `журнал: ${join(places.directory, "unity.log")}`);
  }

  process.stdout.write(lines.join("\n") + "\n");
  return code;
}

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

process.exitCode = await main(process.argv.slice(2));
