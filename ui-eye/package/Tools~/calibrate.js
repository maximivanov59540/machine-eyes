#!/usr/bin/env node
/**
 * ui-eye — калибровка: исправен ли сам глаз.
 *
 * Каждая проверка сравнивает ответ инструмента с ожиданием, записанным ДО первого прогона, и печатает
 * «верно» или «НЕВЕРНО». Поломки нарочные: прибор, который ни разу не покраснел, — не прибор.
 * Ответы записаны на Unity 6000.4.7f1: на другой версии калибровка предупреждает, что матрица «пробы» может законно
 * разойтись.
 *
 *   node Tools~/calibrate.js всё [ключи]           все проверки по очереди: линтер, затем четыре запуска Unity; таблица типов не
 *                                                   годна (свежий клон: UserSettings/ вне git) — сперва снимает её types.js
 *   node Tools~/calibrate.js линтер [ключи]        линтер «разметка ↔ код» без Unity: настоящее дерево и нарочные поломки в памяти;
 *                                                   снимок с поломкой имени → код 6 до калитки и до Unity; плохой режим линтера → код 5;
 *                                                   без годной таблицы типов его проверки типов — НЕВЕРНО, причина — первой строкой и под итогом
 *   node Tools~/calibrate.js замок [ключи]         проект «открыт» — замок держит этот процесс → отказ, Unity не запускается; строка
 *                                                   линтера в отчёте; «предупредить» и отказ линтера снимок не останавливают
 *   node Tools~/calibrate.js панель [ключи]        неизвестная панель → код 5, ответ Unity называет её и известную «пробу»; линтер
 *                                                   панели не знает, но снимок не останавливает
 *   node Tools~/calibrate.js матрица [ключи]       «проба» целиком на 16:9 и 21:9 → точная матрица находок; пока идёт
 *                                                   съёмка, второй снимок из другого процесса получает отказ калитки
 *   node Tools~/calibrate.js повтор [A B] [ключи]  один запрос дважды (или две готовые папки) → кадры и деревья побайтово равны
 *   node Tools~/calibrate.js компиляция [ключи]    ошибка в сборке-мишени → код 2 с файлом, строкой и CS0029; файл убран
 *
 * Ключи:
 *   --проект <папка>             проект Unity; без ключа — переменная UIEYE_PROJECT или поиск вверх от текущей папки.
 *                                Калибровочный проект пакета — ui-eye/calibration.
 *   --сборка-ошибки <папка>      папка сборки с движком (ровно один .asmdef), куда часть «компиляция» кладёт нарочную
 *                                ошибку; по умолчанию Assets/Calibration/Game
 *   --сборка-без-движка <папка>  папка сборки с noEngineReferences: её файлы линтер только считает; по умолчанию
 *                                Assets/Calibration/NoEngine
 *
 * Выход: 0 — всё верно · 1 — есть НЕВЕРНО · 2 — не понял команду или ключ · 3 — калибровать сейчас нельзя (проект открыт
 * в Unity или идёт другой снимок) · 5 — нет проекта, пакета или сборки-мишени · 7 — сбой самой калибровки (например, не
 * убрался нарочный файл).
 *
 * НЕВЕРНО — ещё не приговор прибору: сперва кадр и дерево из папки прогона. Однажды расхождение кадр рассудил в пользу
 * прибора — ошибся автор ожидания («сплющенный», см. ожидание ниже), и исправлено было ожидание, с записью причины. Правка
 * ожидания без такой записи превращает калибровку в эхо.
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { CODES, ProjectNotFound, findPackage, findProject } from "./common.js";
import { lex } from "./lint/cslex.js";
import { lint } from "./linter.js";
import { openExclusive } from "./platform.js";
import { gateState, lockState, shoot, takeGate } from "./runner.js";
import { TYPES_TABLE } from "./typestable.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// Версия Unity, на которой записаны ответы калибровки.
const RECORDED_UNITY = "6000.4.7f1";

// Сборки-мишени калибровочного проекта пакета; в другом проекте — ключами.
const DEFAULT_BROKEN = "Assets/Calibration/Game";
const DEFAULT_NO_ENGINE = "Assets/Calibration/NoEngine";

const PROBE_ALL = { panel: "проба", states: [], sizes: ["1920x1080", "2560x1080"] };
const PROBE_ONE = { panel: "проба", states: ["короткий"], sizes: ["1920x1080"] };

// Имя, которого в реестре не будет никогда.
const UNKNOWN_PANEL = "нет-такой-панели";

const BROKEN_FILE = "UiEyeDeliberatelyBroken.cs";
const BROKEN_SOURCE =
  "namespace UiEyeCalibration\n{\n    internal static class UiEyeDeliberatelyBroken\n    {\n" +
  "        // Нарочная ошибка калибровки ui-eye: строка в int. Файл удаляется сразу после прогона.\n" +
  "        private static readonly int Broken = \"не число\";\n    }\n}\n";

/**
 * Ответ «пробы», записанный до первого прогона (UiEyeProbe.Panel): состояние → размер → находки «вид элемент»
 * по порядку сортировки. Три последних состояния добавлены после первого прогона, когда оказалось, что
 * «за-родителя», «нулевой-размер» и «не-устоялся» ни разу не краснели.
 */
const PROBE_EXPECTED = {
  короткий: { "1920x1080": [], "2560x1080": [] },
  длинный: {
    "1920x1080": ["текст-не-влез Label #badge", "текст-не-влез Label #title"],
    "2560x1080": ["текст-не-влез Label #badge", "текст-не-влез Label #title"],
  },
  "за-краем": { "1920x1080": ["за-краем VisualElement #panel"], "2560x1080": [] },
  // Исправлено после первого прогона. Первое ожидание было только «нулевой-размер #row». Кадр рассудил в пользу
  // прибора: под рядом нулевой высоты Unity кладёт детей с этой высотой пределом — рамка значка 8 px (одни отступы),
  // его «12» не видно вовсе; кнопка сжата до 22 px. Оба текста правда не влезли.
  сплющенный: {
    "1920x1080": ["нулевой-размер VisualElement #row", "текст-не-влез Button #action", "текст-не-влез Label #badge"],
    "2560x1080": ["нулевой-размер VisualElement #row", "текст-не-влез Button #action", "текст-не-влез Label #badge"],
  },
  "вне-родителя": {
    "1920x1080": ["за-родителя Button #action", "за-родителя Label #badge"],
    "2560x1080": ["за-родителя Button #action", "за-родителя Label #badge"],
  },
  "в-движении": { "1920x1080": ["не-устоялся кадр"], "2560x1080": ["не-устоялся кадр"] },
};

// Ключи командной строки → поле настроек.
const KEYS = {
  "--проект": "project",
  "--project": "project",
  "--сборка-ошибки": "broken",
  "--broken-assembly": "broken",
  "--сборка-без-движка": "noEngine",
  "--no-engine-assembly": "noEngine",
};

const tally = { right: 0, wrong: 0 };

class CannotCalibrate extends Error {}

/** Нет проекта, пакета или сборки-мишени: калибровать нечего — плохой запрос, а не сбой. */
class BadSetup extends Error {}

/** Ключ не понят или без значения. */
class BadArguments extends Error {}

function check(ok, what) {
  console.log(`${ok ? "верно" : "НЕВЕРНО"}: ${what}`);

  if (ok) {
    tally.right++;
  } else {
    tally.wrong++;
  }

  return ok;
}

/** Калибровать можно только при закрытом редакторе и когда никто не снимает. */
function preflight(ctx) {
  if (lockState(ctx.root) === "held") {
    throw new CannotCalibrate("проект открыт в Unity (Temp/UnityLockfile держит живой процесс) — калибровка только при закрытом редакторе");
  }

  if (gateState() === "busy") {
    throw new CannotCalibrate("идёт другой снимок ui-eye — калибровать после его конца");
  }
}

function takeGateOrRefuse(ctx) {
  const gate = takeGate({ project: ctx.root, what: "калибровка" });

  if (gate === null) {
    throw new CannotCalibrate("идёт другой снимок ui-eye — калибровать после его конца");
  }

  return gate;
}

/** Проект «открыт»: замок Unity держит этот процесс так же, как держала бы его живая Unity. */
async function lock(ctx) {
  preflight(ctx);
  const markup = readUnity(ctx, ctx.paths.markup);

  if (markup === null) {
    throw new Error(`«проба» пакета не найдена: ${ctx.paths.markup}`);
  }

  const gate = takeGateOrRefuse(ctx);
  const temp = join(ctx.root, "Temp");
  const file = join(temp, "UnityLockfile");
  const hadTemp = existsSync(temp);
  const hadFile = existsSync(file);
  let result;
  let warned;
  let blind;
  let seconds = 0;
  // Поломка имени для линтера перед снимком — наложением, диск не трогается (та же, что в части «линтер»).
  const renamed = markup.replace('name="title"', 'name="titel"');

  try {
    mkdirSync(temp, { recursive: true });
    const fd = openExclusive(file, true);

    if (fd === null) {
      throw new CannotCalibrate("Temp/UnityLockfile держит другой процесс — проект открыт");
    }

    try {
      check(lockState(ctx.root) === "held", "пока замок держит этот процесс, запускатель видит проект открытым");
      const input = { ...PROBE_ONE, project: ctx.root };
      const started = Date.now();
      result = await shoot(input, { gate });
      seconds = (Date.now() - started) / 1000;
      // Линтер перед снимком: «предупредить» с поломкой имени и линтер, которому не с чем сверять, снимок не
      // останавливают — он доходит до замка и получает его отказ. Unity не запускается и здесь.
      warned = await shoot({ ...input, lint: "предупредить" }, { gate, lintInput: { overlay: { [ctx.paths.markup]: renamed } } });
      // «Не с чем сверять» — убраны все файлы, где заводятся панели: «проба» пакета и панели проекта.
      blind = await shoot(input, { gate, lintInput: { remove: registryFiles(ctx) } });
    } finally {
      closeSync(fd);
    }
  } finally {
    // unlinkSync и rmdirSync, НЕ rmSync: на Node v24.11.1 rmSync молча не удаляет по пути с кириллицей.
    if (!hadFile && existsSync(file)) {
      unlinkSync(file);
    }

    if (!hadTemp && existsSync(temp)) {
      rmdirSync(temp);
    }

    gate.release();
    const left = [!hadFile && existsSync(file) ? file : null, !hadTemp && existsSync(temp) ? temp : null].filter(Boolean);
    console.log(left.length === 0 ? "уборка: всё, что заводила проверка, убрано" : `уборка: ОСТАЛОСЬ ${left.join(", ")}`);

    if (left.length > 0) {
      throw new Error(`уборка не удалась — убрать руками: ${left.join(", ")}`);
    }
  }

  console.log(result.report);
  check(result.code === CODES.refused, `код ${result.code}, ждали ${CODES.refused} (отказ)`);
  check(/держит живой процесс/.test(result.headline), `причина — живой замок проекта: «${result.headline}»`);
  check(result.directory === null && seconds < 5, `Unity не запускалась: папки прогона нет, ответ за ${seconds.toFixed(2)} с`);
  check(
    /^линтер: чисто — сверено обращений 22, не проверено 0 · /m.test(result.report) && result.lint?.stops === false,
    "в отчёте снимка — строка линтера: чисто, сверено 22, не проверено 0",
  );

  console.log(`\n--- снимок с lint «предупредить» и #titel\n${warned.report}`);
  check(
    warned.code === CODES.refused && warned.lint?.code === CODES.findings && warned.lint.stops === false && warned.directory === null,
    `код ${warned.code}, ждали ${CODES.refused}: снимок прошёл линтер (код ${warned.lint?.code}, находок ${warned.lint?.result?.findings.length}) и упёрся в замок`,
  );
  check(
    /^линтер: находок 6; сверено обращений 22 · снимок идёт по запросу \(lint: «предупредить»\)/m.test(warned.report),
    "отчёт: находки линтера строками и «снимок идёт по запросу»",
  );

  console.log(`\n--- снимок, когда линтеру не с чем сверять (реестр убран наложением)\n${blind.report}`);
  check(
    blind.code === CODES.refused && blind.lint?.code === CODES.failure && /^линтер: не проверил \(код 7\) — /m.test(blind.report),
    `код ${blind.code}, линтер — код ${blind.lint?.code}: отказ линтера снимок не остановил, строка «не проверил» в отчёте`,
  );
}

async function panel(ctx) {
  preflight(ctx);
  const result = await shoot({ panel: UNKNOWN_PANEL, sizes: ["1920x1080"], project: ctx.root });
  console.log(result.report);
  check(result.code === CODES.request, `код ${result.code}, ждали ${CODES.request} (плохой запрос)`);
  // В отчёте есть и строка линтера, где тоже «нет панели» и «проба», — поэтому ищем в словах Unity (итог и список
  // реестра), иначе проверку выполнял бы за неё линтер.
  check(result.headline.includes(`нет панели «${UNKNOWN_PANEL}»`), "ответ Unity называет неизвестную панель");
  check(/^ {2}«проба» — /m.test(result.report), "ответ Unity перечисляет реестр — в нём «проба»");
  check(
    result.lint?.code === CODES.request && result.lint.stops === false && result.directory !== null,
    `линтер панели не знает (код ${result.lint?.code}), но снимок не остановил — ответ дала Unity (папка прогона ${result.directory ? "есть" : "нет"})`,
  );
}

async function matrix(ctx) {
  preflight(ctx);

  // Калитку shoot() берёт синхронно, до первого ожидания: к следующей строке она уже взята.
  const run = shoot({ ...PROBE_ALL, project: ctx.root });
  run.catch(() => {});
  check(gateState() === "busy", "пока идёт съёмка, калитка занята");

  const rival = await cli(ctx, ["--панель", "проба", "--состояния", "короткий", "--размеры", "1920x1080"]);
  console.log(rival.stdout.trim());
  check(rival.code === CODES.refused, `второй снимок из другого процесса: код ${rival.code}, ждали ${CODES.refused}`);
  check(/идёт другой снимок ui-eye/.test(rival.stdout), "причина отказа — калитка");
  check(!/папка:/.test(rival.stdout) && rival.seconds < 5, `второй Unity не запускал: папки нет, ответ за ${rival.seconds.toFixed(2)} с`);

  const result = await run;
  console.log(result.report);
  verifyMatrix(result);
  return result;
}

function verifyMatrix(outcome) {
  const shots = outcome.result?.shots ?? [];
  const sizes = outcome.result?.sizes ?? [];
  const want = (outcome.result?.states?.length ?? 0) * sizes.length;
  check(outcome.code === CODES.findings, `код ${outcome.code}, ждали ${CODES.findings} (находки)`);
  check(want > 0 && shots.length === want, `кадров ${shots.length}, ждали ${want}`);
  check(
    /^линтер: чисто — сверено обращений 22, не проверено 0 · /m.test(outcome.report) && outcome.lint?.stops === false,
    "в отчёте настоящего снимка — строка линтера: чисто, сверено 22, не проверено 0",
  );

  // Охват числом: каждое ожидание обязано найти свой кадр, иначе пропавшее состояние прошло бы молча.
  const missing = [];
  for (const [state, bySize] of Object.entries(PROBE_EXPECTED)) {
    for (const size of Object.keys(bySize)) {
      if (!shots.some((shot) => shot.state === state && shot.size === size)) {
        missing.push(`${state} ${size}`);
      }
    }
  }

  check(missing.length === 0, `сняты все ожидаемые кадры${missing.length ? `; нет: ${missing.join(", ")}` : ""}`);

  for (const shot of shots) {
    const got = shot.findings.map((finding) => `${finding.kind} ${finding.element}`).sort();
    const expected = PROBE_EXPECTED[shot.state]?.[shot.size] ?? ["<ожидания нет>"];
    const settled = shot.state !== "в-движении";
    check(
      JSON.stringify(got) === JSON.stringify(expected),
      `${shot.state} ${shot.size}: [${got.join("; ")}], ждали [${expected.join("; ")}]`,
    );
    check(shot.settled === settled, `${shot.state} ${shot.size}: устоялся ${shot.settled} за ${shot.reads} чтений, ждали ${settled}`);
  }
}

async function repeat(ctx, first, second) {
  if (first && second) {
    compare(readResult(first), readResult(second));
    return;
  }

  preflight(ctx);
  const a = await shoot({ ...PROBE_ALL, project: ctx.root });
  console.log(`первый: ${a.headline} — ${a.directory}`);
  const b = await shoot({ ...PROBE_ALL, project: ctx.root });
  console.log(`второй: ${b.headline} — ${b.directory}`);
  compare(a.result, b.result);
}

function compare(a, b) {
  if (!a || !b) {
    check(false, "у одного из прогонов нет ответа съёмщика (result.json)");
    return;
  }

  const count = Math.min(a.shots.length, b.shots.length);
  check(
    a.panel === b.panel && a.shots.length > 0 && a.shots.length === b.shots.length,
    `та же панель «${a.panel}» / «${b.panel}», кадров ${a.shots.length} и ${b.shots.length}`,
  );

  let skipped = 0;
  for (let index = 0; index < count; index++) {
    const x = a.shots[index];
    const y = b.shots[index];
    check(x.state === y.state && x.size === y.size, `#${index}: тот же кадр ${x.state} ${x.size}`);

    // Неустоявшийся кадр — сам по себе находка, повторяться он не обязан; сказать об этом, а не пропустить молча.
    if (!x.settled || !y.settled) {
      skipped++;
      console.log(`пропуск: #${index} ${x.state} ${x.size} не устоялся (${x.settled}/${y.settled}) — не случай повторяемости`);
      continue;
    }

    check(x.pngSha256 === y.pngSha256, `#${index} PNG ${x.pngSha256.slice(0, 16)} и ${y.pngSha256.slice(0, 16)}`);
    check(x.treeSha256 === y.treeSha256, `#${index} дерево ${x.treeSha256.slice(0, 16)} и ${y.treeSha256.slice(0, 16)}`);
  }

  console.log(`сравнено устоявшихся кадров ${count - skipped} из ${count}, пропущено неустоявшихся ${skipped}`);
  check(a.markupHash === b.markupHash, `разметка ${a.markupHash.slice(0, 16)} и ${b.markupHash.slice(0, 16)}`);
}

async function compile(ctx) {
  preflight(ctx);
  const broken = join(ctx.broken.dir, BROKEN_FILE);

  if (existsSync(broken) || existsSync(broken + ".meta")) {
    throw new Error(`${broken} или его .meta уже лежит — прошлая калибровка не убрала за собой? Не перезаписываю: проверить и убрать руками`);
  }

  const gate = takeGateOrRefuse(ctx);
  let result;

  try {
    writeFileSync(broken, BROKEN_SOURCE, "utf8");
    result = await shoot({ ...PROBE_ONE, project: ctx.root }, { gate });
  } finally {
    // unlinkSync, НЕ rmSync: на Node v24.11.1 rmSync молча не удаляет по пути с кириллицей — так однажды сломанный
    // файл остался в сборке. Калитка отпускается только после уборки: пока файл лежит, чужой снимок
    // скомпилировал бы его и получил чужую ошибку.
    if (existsSync(broken) && readFileSync(broken, "utf8") === BROKEN_SOURCE) {
      unlinkSync(broken);
    }

    if (existsSync(broken + ".meta")) {
      unlinkSync(broken + ".meta");
    }

    gate.release();
    const left = [broken, broken + ".meta"].filter((path) => existsSync(path));
    console.log(left.length === 0 ? "уборка: нарочный файл и его .meta убраны" : `уборка: ОСТАЛОСЬ ${left.join(", ")}`);

    if (left.length > 0) {
      throw new Error(`уборка не удалась — проект не соберётся, убрать руками: ${left.join(", ")}`);
    }
  }

  console.log(result.report);
  check(result.code === CODES.compile, `код ${result.code}, ждали ${CODES.compile} (не собралось)`);
  check(/UiEyeDeliberatelyBroken\.cs\(6,\d+\): error CS0029/.test(result.report), "ответ называет файл, строку 6 и CS0029");
}

// Поломки линтера накладываются в памяти (overlay) — на диск ничего не пишется.
const LINT_ANCHOR = 'UiEyeFill.Text(root, "badge", "12");';
const LINT_INDENT = "\n                        ";

/**
 * Линтер «разметка ↔ код» без Unity. Ожидания записаны до первого прогона: «проба» на настоящем дереве — сверено 22 =
 * 18 Text + 4 AddClass, не проверено 0; у каждой поломки — свой вид и число находок. Строки находок ищутся в тексте
 * UiEyeProbe.cs, а не вписаны числами; сколько их и какого вида — вписано здесь.
 * В реестре проекта могут быть и свои панели: поломки «пробы» сверяются в её срезе (panel: «проба») — их числа от других
 * панелей не зависят; настоящее дерево — целиком: «проба» в нём ищется по имени, у всех панелей реестра разметка
 * загружена, находок и непроверенного нет.
 */
async function linter(ctx) {
  const { paths } = ctx;
  const problem = typesProblem(ctx);

  if (problem !== null) {
    console.log(`ВНИМАНИЕ: таблица типов не годна — ${problem}. Без неё проверки типов линтера — НЕВЕРНО; «всё» снимает таблицу сама, до линтера`);
  }

  const panels = readUnity(ctx, paths.panels);
  const markup = readUnity(ctx, paths.markup);

  if (panels === null || markup === null) {
    throw new Error(`«проба» пакета не найдена: ${[panels === null ? paths.panels : "", markup === null ? paths.markup : ""].filter(Boolean).join(", ")}`);
  }

  const titleLines = linesOf(panels, 'UiEyeFill.Text(root, "title"');
  const badgeLines = linesOf(panels, 'UiEyeFill.Text(root, "badge"');
  const rowLines = linesOf(panels, 'UiEyeFill.AddClass(root, "row"');
  const badgeAddLines = linesOf(panels, 'UiEyeFill.AddClass(root, "badge"');
  const registryLines = linesOf(panels, "new UiEyePanel(");
  const shape = [titleLines, badgeLines, rowLines, badgeAddLines, registryLines].map((lines) => lines.length).join(", ");
  check(shape === "6, 6, 1, 1, 1", `«проба» такая, какой её знает калибровка: Text #title, Text #badge, AddClass #row, AddClass #badge, панелей — ${shape}; ждали 6, 6, 1, 1, 1`);

  const real = lintCase(ctx, "настоящее дерево", {});
  const r = real.result;
  const probe = r.panels.find((item) => item.name === "проба");
  const through = (prefix) => r.lookups.filter((lookup) => lookup.panel === "проба" && lookup.call.startsWith(prefix)).length;
  const noEngineRow = (result) => result.coverage.assemblies.find((row) => row.name === ctx.noEngine.name);
  check(real.code === CODES.clean, `код ${real.code}, ждали ${CODES.clean} (чисто)`);
  check(
    probe?.status === "ok" && probe.elements === 6 && r.panels.every((item) => item.status === "ok"),
    `«проба» в реестре, разметка загружена, элементов 6; у всех панелей реестра разметка загружена: ${r.panels.map((item) => `«${item.name}» ${item.status} ${item.elements}`).join("; ")}`,
  );
  check(
    probe?.checked === 22 && through("UiEyeFill.Text →") === 18 && through("UiEyeFill.AddClass →") === 4,
    `у «пробы» сверено ${probe?.checked} = через Text ${through("UiEyeFill.Text →")} + через AddClass ${through("UiEyeFill.AddClass →")}; ждали 22 = 18 + 4`,
  );
  check(r.findings.length === 0 && r.notChecked.length === 0, `у всего дерева находок ${r.findings.length}, не проверено ${r.notChecked.length}; ждали 0 и 0`);
  check(
    sameList(r.sinks.map((sink) => sink.method), ["UiEyeFill.AddClass", "UiEyeFill.Find", "UiEyeFill.Text"]),
    `помощники выведены из кода: ${r.sinks.map((sink) => sink.method).join(", ")}; ждали UiEyeFill.AddClass, Find, Text`,
  );
  check(
    sameList(probe?.addedClasses ?? [], ["probe--moving", "probe--offscreen", "probe__badge--wide", "probe__row--flat"]),
    `классы, которые добавляет код «пробы»: ${(probe?.addedClasses ?? []).join(", ")}; ждали четыре из состояний`,
  );
  check(
    r.types.ok && r.coverage.filesWithParseProblems === 0,
    `таблица типов годна (${r.types.ok ? `Unity ${r.types.unityVersion}` : r.types.reason}), файлов с ошибками разбора ${r.coverage.filesWithParseProblems}`,
  );
  check(
    r.coverage.csScanned > 0 && noEngineRow(r)?.scanned === 0 && noEngineRow(r).excluded > 0,
    `сканировано .cs ${r.coverage.csScanned} из ${r.coverage.csTotal}; сборка без движка ${ctx.noEngine.name} не сканируется (исключено ${noEngineRow(r)?.excluded ?? "?"})`,
  );
  check(stable(lint({ project: ctx.root }).result) === stable(r), "повтор: тот же запрос — тот же ответ (кроме времени)");

  // Лексер на всех .cs, которые видит линтер (Assets и пакет), и на несканируемых сборках тоже: файл покрыт целиком, проблем нет.
  const files = sources(ctx);
  const troubled = [];
  let tokens = 0;

  for (const file of files) {
    const lexed = lex(readText(file.full));
    tokens += lexed.tokens.length;

    if (lexed.problems.length > 0) {
      troubled.push(`${file.path}: ${lexed.problems[0].message}`);
    }
  }

  check(files.length === r.coverage.csTotal, `свой обход калибровки нашёл .cs ${files.length}, линтер — ${r.coverage.csTotal}`);
  check(
    troubled.length === 0 && tokens > 0,
    `лексер на всех ${files.length} .cs: токенов ${tokens}, файлов с проблемами ${troubled.length}${troubled.length ? ` — ${troubled.slice(0, 3).join("; ")}` : ""}`,
  );

  const renamed = markup.replace('name="title"', 'name="titel"');
  const c = lintCase(ctx, "#title в разметке переименован в #titel", { panel: "проба", overlay: { [paths.markup]: renamed } }, renamed !== markup);
  check(c.code === CODES.findings, `код ${c.code}, ждали ${CODES.findings} (находки)`);
  check(
    sameList(linesWith(c.result, "нет-в-разметке"), titleLines) && c.result.findings.length === 6,
    `нет-в-разметке на строках [${linesWith(c.result, "нет-в-разметке").join(", ")}] из ${c.result.findings.length} находок; ждали ровно Text #title [${titleLines.join(", ")}]`,
  );
  check(c.result.findings.length > 0 && c.result.findings.every((finding) => finding.suggestions.includes("titel")), "каждая находка подсказывает похожее имя «titel»");
  check(
    c.result.coverage.checked === 22 && c.result.signature.some((item) => item.path === paths.markup && item.mark === "наложено"),
    `сверено по-прежнему ${c.result.coverage.checked} (ждали 22); разметка в подписи помечена «наложено»`,
  );

  const retyped = markup.replace('<ui:Label name="badge"', '<ui:VisualElement name="badge"');
  const d = lintCase(ctx, "#badge в разметке: Label → VisualElement", { panel: "проба", overlay: { [paths.markup]: retyped } }, retyped !== markup);
  check(d.code === CODES.findings, `код ${d.code}, ждали ${CODES.findings} (находки)`);
  check(
    sameList(linesWith(d.result, "не-тот-тип"), badgeLines) && d.result.findings.length === 6,
    `не-тот-тип на строках [${linesWith(d.result, "не-тот-тип").join(", ")}] из ${d.result.findings.length} находок; ждали ровно Text #badge [${badgeLines.join(", ")}]`,
  );
  check(
    d.result.findings.length > 0 && d.result.findings.every((finding) => finding.message.includes("VisualElement") && finding.message.includes("TextElement")),
    "сообщение называет, что в разметке (VisualElement) и чего ждёт код (TextElement)",
  );
  check(d.result.findings.length > 0 && !d.result.findings.some((finding) => badgeAddLines.includes(finding.line)), `AddClass #badge (строка ${badgeAddLines[0]}, ждёт VisualElement) — не находка`);

  const doubled = markup.replace('<ui:Button name="action"', '<ui:VisualElement name="row" /><ui:Button name="action"');
  const e = lintCase(ctx, "в разметке второй #row", { panel: "проба", overlay: { [paths.markup]: doubled } }, doubled !== markup);
  check(
    e.code === CODES.findings && e.result.findings.length === 1 && e.result.findings[0].kind === "имя-не-одно" && e.result.findings[0].line === rowLines[0],
    `одна находка имя-не-одно на строке AddClass #row ${rowLines[0]}: ${describeFindings(e.result)}`,
  );

  const traps = [
    'const string Badge = "badge";',
    'UiEyeFill.Text(root, Badge, "константа");',
    'var suffix = "tle";',
    'UiEyeFill.Text(root, "ti" + suffix, "вычисляется");',
    '// UiEyeFill.Text(root, "призрак-в-комментарии", "x");',
    'var trap = "UiEyeFill.Text(root, \\"призрак-в-строке\\", \\"x\\")";',
    'root.Q(className: "probe__row");',
    'root.Q<Label>(className: "probe__rov");',
  ];
  // Прямой Q линтер берёт только в файле, который видит UnityEngine.UIElements (lint/analyze.js), а у UiEyeProbe.cs
  // своего using нет: без этой строки обе ловушки поиска по классу для линтера не существуют.
  const withTraps = panels.replace(LINT_ANCHOR, LINT_ANCHOR + traps.map((line) => LINT_INDENT + line).join(""));
  const trapped = "using UnityEngine.UIElements;\n" + withTraps;
  const f = lintCase(ctx, "константа, вычисляемое имя, ловушки комментария и строки, поиск по классу", { panel: "проба", overlay: { [paths.panels]: trapped } }, withTraps !== panels);
  const missing = f.result.findings.find((finding) => finding.kind === "класса-нет");
  check(
    f.code === CODES.findings && f.result.findings.length === 1 && Boolean(missing?.message.includes(".probe__rov")) && missing.suggestions.includes("probe__row"),
    `одна находка — класса-нет .probe__rov с подсказкой probe__row: ${describeFindings(f.result)}`,
  );
  check(
    f.result.notChecked.length === 1 && f.result.notChecked[0].kind === "имя-вычисляется" && f.result.notChecked[0].reason.includes('"ti" + suffix'),
    `не проверено ровно одно — имя-вычисляется "ti" + suffix: ${f.result.notChecked.map((item) => `${item.kind} ${item.reason}`).join("; ") || "нет"}`,
  );
  check(f.result.coverage.checked === 25, `сверено ${f.result.coverage.checked}, ждали 25 = 22 + константа Badge + два поиска по классу`);
  check(!JSON.stringify(f.result).includes("призрак"), "имя из комментария и из строки не стало обращением");

  const templated = markup
    .replace('<Style src="Probe.uss" />', '<Style src="Probe.uss" />\n    <ui:Template name="Badge" src="ProbeBadge.uxml" />')
    .replace('<ui:Label name="badge" text="12" class="probe__badge" />', '<ui:Instance template="Badge" name="badge-slot" />');
  const badgeTemplate = '<ui:UXML xmlns:ui="UnityEngine.UIElements">\n    <ui:Label name="badge" text="12" class="probe__badge" />\n</ui:UXML>\n';
  const g = lintCase(
    ctx,
    "#badge переехал в шаблон",
    { panel: "проба", overlay: { [paths.markup]: templated, [paths.template]: badgeTemplate } },
    templated.includes("<ui:Template") && templated.includes("<ui:Instance") && !templated.includes('<ui:Label name="badge"'),
  );
  check(
    g.code === CODES.clean && g.result.coverage.checked === 22 && g.result.findings.length === 0,
    `код ${g.code}, сверено ${g.result.coverage.checked}, находок ${g.result.findings.length}; ждали 0, 22, 0`,
  );
  check(g.result.panels[0]?.elements === 7, `элементов ${g.result.panels[0]?.elements}, ждали 7 = 6 − метка + Instance + метка из шаблона`);
  check(g.result.signature.some((item) => item.path === paths.template && item.mark === "наложено"), "шаблон попал в подпись и помечен «наложено»");

  const typo = templated.replace('src="ProbeBadge.uxml"', 'src="ProbeBadg.uxml"');
  const g2 = lintCase(ctx, "шаблон с опечаткой в src", { panel: "проба", overlay: { [paths.markup]: typo, [paths.template]: badgeTemplate } }, typo !== templated);
  const lost = g2.result.findings[0];
  check(
    g2.code === CODES.findings && g2.result.findings.length === 1 && lost.kind === "разметки-нет" && lost.file === paths.markup && lost.line === 3 && lost.message.includes("ProbeBadg.uxml"),
    `одна находка разметки-нет в Probe.uxml:3 про ProbeBadg.uxml: ${describeFindings(g2.result)}`,
  );
  check(
    g2.result.coverage.checked === 0 && g2.result.notChecked.length === 22 && g2.result.notChecked.every((item) => item.kind === "разметки-нет"),
    `сверено ${g2.result.coverage.checked}, не проверено ${g2.result.notChecked.length}; ждали 0 и 22, все «разметки-нет» — не выданы за чистоту`,
  );

  const controller = [
    "using UnityEngine.UIElements;",
    "",
    "namespace UiEye",
    "{",
    "    internal sealed class ProbeController",
    "    {",
    "        public ProbeController(VisualElement root)",
    "        {",
    '            root.Q<Button>("title");',
    '            root.Q<Button>("action");',
    "        }",
    "    }",
    "}",
    "",
  ].join("\n");
  const withController = panels.replace(LINT_ANCHOR, LINT_ANCHOR + LINT_INDENT + "new ProbeController(root);");
  const h = lintCase(ctx, 'контроллер через new: Q<Button>("title")', { panel: "проба", overlay: { [paths.panels]: withController, [paths.controller]: controller } }, withController !== panels);
  const wrongType = h.result.findings[0];
  check(
    h.code === CODES.findings && h.result.findings.length === 1 && wrongType.kind === "не-тот-тип" && wrongType.file === paths.controller && wrongType.line === 9,
    `одна находка не-тот-тип в ProbeController.cs:9: ${describeFindings(h.result)}`,
  );
  check(h.result.coverage.checked === 24, `сверено ${h.result.coverage.checked}, ждали 24 = 22 + два поиска контроллера (#action — Button, чисто)`);

  const orphan = [
    "using UnityEngine.UIElements;",
    "",
    "namespace UiEye",
    "{",
    "    internal static class ProbeOrphan",
    "    {",
    "        public static void Touch(VisualElement root)",
    "        {",
    '            root.Q<Label>("orphan");',
    "        }",
    "    }",
    "}",
    "",
  ].join("\n");
  const i = lintCase(ctx, "обращение вне реестра", { overlay: { [paths.orphan]: orphan } });
  const alone = i.result.notChecked[0];
  check(
    i.code === CODES.clean &&
      i.result.coverage.checked === r.coverage.checked &&
      i.result.notChecked.length === 1 &&
      alone.kind === "не-с-чем-сверить" &&
      alone.file === paths.orphan &&
      alone.line === 9,
    `код ${i.code}, сверено ${i.result.coverage.checked} (у настоящего дерева ${r.coverage.checked}); не проверено одно — не-с-чем-сверить в ProbeOrphan.cs:9: ` +
      `${i.result.notChecked.map((item) => `${item.kind} ${item.file}:${item.line}`).join("; ") || "нет"}`,
  );
  const scoped = lint({ panel: "проба", overlay: { [paths.orphan]: orphan }, project: ctx.root });
  check(scoped.code === CODES.clean && scoped.result.notChecked.length === 0, `с панелью «проба» чужое обращение не в её списке: код ${scoped.code}, не проверено ${scoped.result.notChecked.length}`);

  const pathTypo = panels.replace('Folder + "/Probe/Probe.uxml"', 'Folder + "/Probe/Prob.uxml"');
  const j = lintCase(ctx, "опечатка в пути разметки в реестре", { panel: "проба", overlay: { [paths.panels]: pathTypo } }, pathTypo !== panels);
  const noMarkup = j.result.findings[0];
  check(
    j.code === CODES.findings && j.result.findings.length === 1 && noMarkup.kind === "разметки-нет" && noMarkup.file === paths.panels && noMarkup.line === registryLines[0],
    `одна находка разметки-нет на строке реестра ${registryLines[0]}: ${describeFindings(j.result)}`,
  );
  check(j.result.coverage.checked === 0 && j.result.notChecked.length === 22, `сверено ${j.result.coverage.checked}, не проверено ${j.result.notChecked.length}; ждали 0 и 22`);

  const noEngineProbe = [
    "using UnityEngine.UIElements;",
    "",
    "internal static class UiEyeLintProbe",
    "{",
    '    public static void Touch(VisualElement root) => root.Q<Label>("ghost");',
    "}",
    "",
  ].join("\n");
  const k = lintCase(ctx, `файл с Q() в сборке без движка (${ctx.noEngine.name})`, { overlay: { [paths.noEngineProbe]: noEngineProbe } });
  check(
    k.code === CODES.clean && k.result.coverage.csScanned === r.coverage.csScanned && noEngineRow(k.result)?.excluded === noEngineRow(r)?.excluded + 1,
    `код ${k.code}; сканировано ${k.result.coverage.csScanned} (было ${r.coverage.csScanned}); ${ctx.noEngine.name} исключено ${noEngineRow(k.result)?.excluded} (было ${noEngineRow(r)?.excluded})`,
  );
  check(!JSON.stringify(k.result).includes("ghost"), "его обращение не видно нигде в ответе");

  const tableText = readUnity(ctx, TYPES_TABLE);
  let table = null;
  try {
    table = tableText === null ? null : JSON.parse(tableText);
  } catch {
    table = null;
  }

  if (table === null) {
    check(false, `таблица типов проекта ${TYPES_TABLE} ${tableText === null ? "не снята" : "не разбирается"} — случай «таблица с чужой версии Unity» не проверен; таблицу снимает каждый снимок, явно — types.js`);
  } else {
    const l = lintCase(ctx, "таблица типов с чужой версии Unity (и #badge — VisualElement)", { panel: "проба", overlay: { [paths.markup]: retyped }, typesTable: { ...table, unityVersion: "0000.0.0f0" } });
    check(l.code === CODES.clean && l.result.types.ok === false && l.result.types.reason.includes("0000.0.0f0"), `код ${l.code}; таблица не годна: ${l.result.types.reason}`);
    check(
      l.result.findings.length === 0 && l.result.coverage.typesSkipped === 18,
      `не-тот-тип не выдан; тип не проверен у ${l.result.coverage.typesSkipped} обращений, ждали 18 (все Text)`,
    );
    check(l.report.includes("ТИПЫ НЕ ПРОВЕРЯЛИСЬ") && l.headline.includes("ТИПЫ НЕ ПРОВЕРЯЛИСЬ"), "итог и подпись говорят об этом громко");
  }

  const unknown = lint({ panel: UNKNOWN_PANEL, project: ctx.root });
  console.log(`\n--- линтер: неизвестная панель\n${unknown.report}`);
  check(
    unknown.code === CODES.request && unknown.report.includes(`«${UNKNOWN_PANEL}»`) && unknown.report.includes("«проба»"),
    `код ${unknown.code}, ждали ${CODES.request}; ответ называет неизвестную панель и «пробу»`,
  );
  const blank = lint({ panel: "  ", project: ctx.root });
  check(blank.code === CODES.request, `пустое имя панели: код ${blank.code}, ждали ${CODES.request}`);

  const registry = registryFiles(ctx);
  const none = lintCase(ctx, `реестр удалён: все файлы, где заводятся панели (${registry.join(", ")})`, { remove: registry });
  check(none.code === CODES.failure && none.headline.includes("нет ни одного new UiEyePanel"), `код ${none.code}, ждали ${CODES.failure}: реестра нет — отказ, а не чистота`);

  // Снимок зовёт линтер сам — до калитки и до Unity. Калитку держит калибровка, как держал бы её чужой снимок: остановка
  // линтером обязана прийти раньше отказа калитки. Ожидания записаны до прогона: код 6, те же 6 нет-в-разметке на строках
  // Text #title, папки прогона нет, ответ быстрее 5 с, отчёт называет файл и строку, режим «предупредить» и подпись линтера.
  const held = takeGate({ project: ctx.root, what: "калибровка" });
  let stopped;
  let stopSeconds = 0;

  try {
    const started = Date.now();
    stopped = await shoot({ ...PROBE_ONE, project: ctx.root }, { lintInput: { overlay: { [paths.markup]: renamed } } });
    stopSeconds = (Date.now() - started) / 1000;
  } finally {
    held?.release();
  }

  console.log(`\n--- снимок с #titel: линтер до калитки и до Unity (калитку держит ${held ? "калибровка" : "чужой снимок"})\n${stopped.report}`);
  const stopLines = linesWith(stopped.lint?.result ?? { findings: [] }, "нет-в-разметке");
  check(stopped.code === CODES.panel && stopped.lint?.stops === true, `код ${stopped.code}, ждали ${CODES.panel}; остановил линтер: ${stopped.lint?.stops}`);
  check(
    sameList(stopLines, titleLines) && stopped.lint?.result?.findings.length === 6,
    `в снимке — нет-в-разметке на строках [${stopLines.join(", ")}] из ${stopped.lint?.result?.findings.length} находок; ждали ровно Text #title [${titleLines.join(", ")}]`,
  );
  check(stopped.directory === null && stopSeconds < 5, `Unity не запускалась: папки прогона нет, ответ за ${stopSeconds.toFixed(2)} с при занятой калитке`);
  check(
    stopped.report.includes(`${paths.panels}:${titleLines[0]}`) && stopped.report.includes("«предупредить»") && stopped.report.includes("подпись линтера"),
    "отчёт снимка называет файл и строку, как снимать всё равно и подпись линтера",
  );

  const badMode = await shoot({ ...PROBE_ONE, project: ctx.root, lint: "не-знаю" });
  check(
    badMode.code === CODES.request && badMode.directory === null && badMode.lint === null && badMode.headline.includes("«стоп» или «предупредить»"),
    `lint «не-знаю»: код ${badMode.code}, ждали ${CODES.request} — до линтера и до Unity: ${badMode.headline}`,
  );
}

function lintCase(ctx, name, input, applied = true) {
  console.log(`\n--- линтер: ${name}`);

  if (!applied) {
    check(false, `поломка «${name}» не наложилась — текст не изменился, проверка была бы пустой`);
  }

  const outcome = lint({ ...input, project: ctx.root });
  console.log(outcome.report);
  return outcome;
}

function describeFindings(result) {
  return result.findings.map((finding) => `${finding.kind} ${finding.file.split("/").pop()}:${finding.line}`).join("; ") || "нет";
}

/** Путь, как его видит Unity, → путь на диске: Packages/<имя пакета>/… — в папке пакета, прочее — от корня проекта. */
function diskPath(ctx, path) {
  const top = `Packages/${ctx.pkg.name}`;
  return path === top || path.startsWith(`${top}/`)
    ? join(ctx.pkg.dir, ...path.slice(top.length).split("/").filter(Boolean))
    : join(ctx.root, ...path.split("/"));
}

/** Текст файла по пути, как его видит Unity; null — файла нет. */
function readUnity(ctx, path) {
  const full = diskPath(ctx, path);
  return statSync(full, { throwIfNoEntry: false })?.isFile() ? readText(full) : null;
}

/** .cs, которые видит линтер: под Assets и в папке пакета — путями, как их видит Unity; скрытые папки («~», «.») — мимо. */
function sources(ctx) {
  const tops = [
    { dir: join(ctx.root, "Assets"), prefix: "Assets" },
    { dir: ctx.pkg.dir, prefix: `Packages/${ctx.pkg.name}` },
  ];

  return tops
    .filter((top) => statSync(top.dir, { throwIfNoEntry: false })?.isDirectory())
    .flatMap((top) => csFiles(top.dir).map((full) => ({ full, path: `${top.prefix}/${relative(top.dir, full).split("\\").join("/")}` })));
}

/**
 * Файлы, где заводятся панели ui-eye: все .cs, которые видит линтер, с «new UiEyePanel(» в тексте — своим обходом, а не
 * ответом линтера (прибор не готовит себе контроль). Их может быть несколько: «проба» пакета и панели проекта своими файлами.
 */
function registryFiles(ctx) {
  return sources(ctx)
    .filter((file) => readText(file.full).includes("new UiEyePanel("))
    .map((file) => file.path);
}

function readText(file) {
  const text = readFileSync(file, "utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function linesOf(text, needle) {
  return text.split("\n").flatMap((line, index) => (line.includes(needle) ? [index + 1] : []));
}

function linesWith(result, kind) {
  return result.findings.filter((finding) => finding.kind === kind).map((finding) => finding.line);
}

function sameList(a, b) {
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}

function stable(result) {
  return JSON.stringify({ ...result, seconds: 0 });
}

function csFiles(directory) {
  const found = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.endsWith("~") || entry.name.startsWith(".")) {
      continue;
    }

    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...csFiles(full));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".cs")) {
      found.push(full);
    }
  }

  return found;
}

/** Почему таблица типов проекта не годна линтеру — его же словами (нет, не разобрана, снята с другой Unity), или null. */
function typesProblem(ctx) {
  const types = lint({ project: ctx.root }).result?.types;
  return types && !types.ok ? types.reason : null;
}

/**
 * Для «всё»: таблица типов не годна — снять её types.js до линтера (один батч-запуск Unity). Не снялась (редактор открыт,
 * идёт снимок, Unity не собрала) — только сказать: часть «линтер» назовёт причину своими НЕВЕРНО, а отказ с кодом 3 при
 * открытом редакторе даст, как прежде, preflight перед частями с Unity.
 */
async function typesFirst(ctx) {
  if (typesProblem(ctx) === null) {
    return;
  }

  console.log("\nтаблица типов не годна — снимаю до линтера: types.js, один батч-запуск Unity");
  const snap = await cli(ctx, [], "types.js");
  console.log(snap.stdout.trimEnd().split("\n").map((line) => `  ${line}`).join("\n"));
  console.log(
    snap.code === CODES.clean
      ? `таблица типов снята · ${snap.seconds.toFixed(1)} с`
      : `таблица типов НЕ снята (код ${snap.code}) — проверки типов в части «линтер» будут НЕВЕРНО`,
  );
}

async function all(ctx) {
  // Таблица типов — до линтера: без неё его проверки типов НЕВЕРНО, а в свежем клоне её нет (UserSettings/ вне git).
  await typesFirst(ctx);
  // Линтер первым из проверок: Unity ему не нужна, и ответ не зависит от того, открыт ли редактор.
  await part("линтер", () => linter(ctx));
  preflight(ctx);
  await part("замок", () => lock(ctx));
  await part("панель", () => panel(ctx));
  const first = await part("матрица", () => matrix(ctx));
  await part("повтор", async () => {
    preflight(ctx);
    const second = await shoot({ ...PROBE_ALL, project: ctx.root });
    console.log(`второй прогон матрицы: ${second.headline} — ${second.directory}`);
    compare(first.result, second.result);
  });
  // Последней: упавшая компиляция оставляет мёртвый замок, и следующий запуск Unity перекомпилирует всё.
  await part("компиляция", () => compile(ctx));
}

async function part(name, work) {
  console.log(`\n=== ${name} ===`);
  const before = { ...tally };
  const started = Date.now();
  const value = await work();
  console.log(
    `=== ${name}: верно ${tally.right - before.right}, НЕВЕРНО ${tally.wrong - before.wrong} · ${((Date.now() - started) / 1000).toFixed(1)} с`,
  );
  return value;
}

function cli(ctx, args, script = "ui-eye.js") {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(process.execPath, [join(HERE, script), ...args, "--проект", ctx.root], {
      stdio: ["ignore", "pipe", "inherit"],
      windowsHide: true,
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", (error) => done({ code: -1, stdout: String(error), seconds: (Date.now() - started) / 1000 }));
    child.on("close", (code) => done({ code, stdout, seconds: (Date.now() - started) / 1000 }));
  });
}

function readResult(directory) {
  const text = readFileSync(join(directory, "result.json"), "utf8");
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

function parseArgs(argv) {
  const words = [];
  const options = {};

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const key = KEYS[arg];

    if (key) {
      if (index + 1 >= argv.length) {
        throw new BadArguments(`у ключа ${arg} нет значения`);
      }

      options[key] = argv[++index];
    } else if (arg.startsWith("--")) {
      throw new BadArguments(`не понял ключ «${arg}»; ключи: ${Object.keys(KEYS).join(", ")}`);
    } else {
      words.push(arg);
    }
  }

  return { words, options };
}

/** Проект, пакет и сборки-мишени — всё, что калибровка берёт у проекта, до первой проверки. */
function setup(options) {
  const project = findProject(options.project);
  const pkg = findPackage(project.root);

  if (pkg.dir === null || pkg.how === "папка инструмента") {
    throw new BadSetup(`проект ${project.root} не подключает пакет ui-eye (${pkg.remark}) — Unity не соберёт съёмщика`);
  }

  const broken = assemblyAt(project.root, options.broken ?? DEFAULT_BROKEN, false, "--сборка-ошибки");
  const noEngine = assemblyAt(project.root, options.noEngine ?? DEFAULT_NO_ENGINE, true, "--сборка-без-движка");
  const probe = `Packages/${pkg.name}/Editor/Probe`;

  return {
    root: project.root,
    how: project.how,
    pkg,
    broken,
    noEngine,
    paths: {
      panels: `${probe}/UiEyeProbe.cs`,
      markup: `${probe}/Probe.uxml`,
      template: `${probe}/ProbeBadge.uxml`,
      controller: `${probe}/ProbeController.cs`,
      orphan: `${probe}/ProbeOrphan.cs`,
      noEngineProbe: `${noEngine.path}/UiEyeLintProbe.cs`,
    },
  };
}

/** Сборка-мишень: папка под Assets с ровно одним .asmdef; noEngine — каким обязан быть его noEngineReferences. */
function assemblyAt(root, folder, noEngine, key) {
  const path = folder.split("\\").join("/").replace(/\/+$/, "");

  if (!/^Assets(\/|$)/.test(path)) {
    throw new BadSetup(`${key} — папка от корня проекта, под Assets/, а не «${folder}»`);
  }

  const dir = join(root, ...path.split("/"));
  const asmdefs = statSync(dir, { throwIfNoEntry: false })?.isDirectory()
    ? readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".asmdef"))
    : [];

  if (asmdefs.length !== 1) {
    throw new BadSetup(`${key} ${path}: ${asmdefs.length === 0 ? "нет .asmdef" : `.asmdef не один (${asmdefs.join(", ")})`} — нужна папка ровно одной сборки`);
  }

  let json;
  try {
    json = JSON.parse(readText(join(dir, asmdefs[0])));
  } catch (error) {
    throw new BadSetup(`${key} ${path}/${asmdefs[0]} не разобран: ${error.message}`);
  }

  if ((json?.noEngineReferences === true) !== noEngine) {
    throw new BadSetup(
      `${key} ${path}: у сборки ${json?.name} noEngineReferences — ${json?.noEngineReferences === true}, а нужна сборка ${noEngine ? "без движка" : "с движком"}`,
    );
  }

  const name = typeof json?.name === "string" && json.name !== "" ? json.name : asmdefs[0].slice(0, -".asmdef".length);
  return { path, dir, name };
}

function describe(ctx) {
  const version = /m_EditorVersion:\s*(\S+)/.exec(readUnity(ctx, "ProjectSettings/ProjectVersion.txt") ?? "")?.[1] ?? "?";
  console.log(`калибровка: проект ${ctx.root} (${ctx.how}); Unity проекта ${version}, ответы записаны на ${RECORDED_UNITY}`);

  if (version !== RECORDED_UNITY) {
    console.log(`ВНИМАНИЕ: Unity проекта ${version}, а ответы записаны на ${RECORDED_UNITY} — матрица «пробы» может законно разойтись; НЕВЕРНО сверять с кадром`);
  }

  console.log(
    `пакет ${ctx.pkg.name} — ${ctx.pkg.how}${ctx.pkg.remark ? ` (${ctx.pkg.remark})` : ""}; сборка ошибки ${ctx.broken.name} (${ctx.broken.path}); ` +
      `сборка без движка ${ctx.noEngine.name} (${ctx.noEngine.path})`,
  );
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    console.log(`калибровка: ${error.message}`);
    return 2;
  }

  const [command, ...rest] = parsed.words;
  const commands = {
    "всё": all,
    "все": all,
    all,
    "линтер": linter,
    lint: linter,
    "замок": lock,
    lock,
    "панель": panel,
    panel,
    "матрица": matrix,
    matrix,
    "повтор": (ctx) => repeat(ctx, rest[0], rest[1]),
    repeat: (ctx) => repeat(ctx, rest[0], rest[1]),
    "компиляция": compile,
    compile,
  };

  const work = commands[command];
  if (!work) {
    console.log("команды: всё · линтер · замок · панель · матрица · повтор [папкаA папкаB] · компиляция; ключи: --проект, --сборка-ошибки, --сборка-без-движка — см. шапку calibrate.js");
    return 2;
  }

  const started = Date.now();
  let ctx;

  try {
    ctx = setup(parsed.options);
  } catch (error) {
    if (error instanceof ProjectNotFound || error instanceof BadSetup) {
      console.log(`калибровать нечего: ${error.message}`);
      return CODES.request;
    }

    console.log(`СБОЙ калибровки: ${error?.stack ?? error}`);
    return 7;
  }

  describe(ctx);

  try {
    await work(ctx);
  } catch (error) {
    if (error instanceof CannotCalibrate) {
      console.log(`калибровать сейчас нельзя: ${error.message}`);
      return 3;
    }

    console.log(`СБОЙ калибровки: ${error?.stack ?? error}`);
    return 7;
  }

  const total = tally.right + tally.wrong;
  console.log(
    `\nкалибровка: верно ${tally.right} из ${total}${tally.wrong ? `, НЕВЕРНО ${tally.wrong}` : ""} · ${((Date.now() - started) / 1000).toFixed(1)} с`,
  );

  // Причина — и под итогом: первая строка линтера с ней осталась далеко вверху выдачи.
  const problem = tally.wrong > 0 && (work === linter || work === all) ? typesProblem(ctx) : null;
  if (problem !== null) {
    console.log(`таблица типов не годна — ${problem}`);
  }

  return tally.wrong === 0 && total > 0 ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
