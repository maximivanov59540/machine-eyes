#!/usr/bin/env node
/**
 * ui-eye — линтер «разметка ↔ код»: командная строка. Unity не нужна, редактор может быть открыт.
 *
 *   node Tools~/lint.js                    все панели реестра
 *   node Tools~/lint.js --панель проба     одна панель
 *   node Tools~/lint.js --json             ответ целиком, JSON (для скриптов)
 *   node Tools~/lint.js --проект <папка>   проект Unity; без ключа — переменная UIEYE_PROJECT или поиск вверх
 *                                          от текущей папки
 *
 * Выход: 0 чисто · 1 находки · 5 плохой запрос (и проект не найден) · 7 сбой (и охват ноль). Что сверяется — шапка
 * linter.js.
 */

import process from "node:process";

import { lint } from "./linter.js";
import { CODES } from "./runner.js";

function parse(argv) {
  const input = {};
  let json = false;

  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];

    if (flag === "--json") {
      json = true;
    } else if ((flag === "--панель" || flag === "--panel") && index + 1 < argv.length) {
      input.panel = argv[++index];
    } else if ((flag === "--проект" || flag === "--project") && index + 1 < argv.length) {
      input.project = argv[++index];
    } else {
      throw new Error(`Не понял аргумент «${flag}». Флаги: --панель <имя> (--panel), --проект <папка> (--project), --json.`);
    }
  }

  return { input, json };
}

let parsed;
try {
  parsed = parse(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`ui-eye lint: ${error.message}\n`);
  process.exit(CODES.request);
}

const outcome = lint(parsed.input);
process.stdout.write((parsed.json ? JSON.stringify(outcome.result, null, 2) : outcome.report) + "\n");
process.exitCode = outcome.code;
