#!/usr/bin/env node
/**
 * ui-eye — командная строка запускателя.
 *
 *   node Tools~/ui-eye.js --панель проба [--состояния короткий,длинный]
 *        [--размеры 1920x1080,2560x1080] [--линтер стоп|предупредить] [--сторож 180] [--таймаут 600] [--папка <dir>]
 *        [--проект <папка проекта>]
 *   node Tools~/ui-eye.js --список [--проект <папка проекта>]
 *
 * Проект — ключ --проект, переменная UIEYE_PROJECT или поиск вверх от текущей папки до ProjectSettings/ProjectVersion.txt.
 * Сперва линтер «разметка ↔ код»: его находки останавливают снимок до Unity (код 6); --линтер предупредить —
 * снимать всё равно, находки строками в отчёте.
 * Печатает вердикт и выходит с кодом запускателя (см. CODES в common.js):
 * 0 чисто · 1 находки · 2 не собралось · 3 отказ (проект открыт) · 4 сторож/таймаут ·
 * 5 плохой запрос (и проект не найден) · 6 панель не сходится (и находки линтера до Unity) · 7 прочий отказ.
 */

import process from "node:process";

import { CODES, DEFAULT_SIZES, shoot } from "./runner.js";

const FLAGS = {
  "--панель": "panel",
  "--panel": "panel",
  "--состояния": "states",
  "--states": "states",
  "--размеры": "sizes",
  "--sizes": "sizes",
  "--линтер": "lint",
  "--lint": "lint",
  "--сторож": "watchdogSeconds",
  "--watchdog": "watchdogSeconds",
  "--таймаут": "timeoutSeconds",
  "--timeout": "timeoutSeconds",
  "--папка": "out",
  "--out": "out",
  "--проект": "project",
  "--project": "project",
};

// Режим линтера по-английски — для --lint; незнакомое значение запускатель вернёт кодом 5 с подсказкой.
const LINT_VALUES = { stop: "стоп", warn: "предупредить" };

function parse(argv) {
  const input = { sizes: DEFAULT_SIZES, states: [] };

  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];

    if (flag === "--список" || flag === "--list") {
      input.list = true;
      continue;
    }

    const key = FLAGS[flag];
    if (!key || index + 1 >= argv.length) {
      throw new Error(`Не понял аргумент «${flag}». Флаги: ${Object.keys(FLAGS).join(", ")}, --список.`);
    }

    const value = argv[++index];
    if (key === "states" || key === "sizes") {
      input[key] = value.split(",").map((part) => part.trim()).filter(Boolean);
    } else if (key === "watchdogSeconds" || key === "timeoutSeconds") {
      input[key] = Number(value);
    } else if (key === "lint") {
      input.lint = LINT_VALUES[value] ?? value;
    } else {
      input[key] = value;
    }
  }

  if (!input.list && !input.panel) {
    throw new Error("Нужна --панель <имя> или --список.");
  }

  return input;
}

let input;
try {
  input = parse(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`ui-eye: ${error.message}\n`);
  process.exit(CODES.request);
}

const result = await shoot(input);
process.stdout.write(result.report + "\n");
process.exit(result.code);
