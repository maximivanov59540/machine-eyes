#!/usr/bin/env node
/**
 * ui-eye MCP server — машинный глаз интерфейса как инструмент агента.
 *
 * Оборачивает запускатель из Tools~: модель просит снимок панели, сервер зовёт shoot() из runner.js и
 * возвращает ВЕРДИКТ ЧИСЛАМИ и КОНТАКТНЫЙ ЛИСТ КАРТИНКОЙ прямо в ответ. Без сервера глаз тоже работает
 * (node Tools~/ui-eye.js --панель …), но о команде надо помнить; с сервером инструмент просто есть
 * в списке, и им пользуется любой агент.
 * Линтер «разметка ↔ код» (lint() из linter.js) — тоже здесь: без Unity, около секунды, мимо очереди снимков.
 * Снимок и сам зовёт его первым: находки линтера останавливают снимок до Unity (код 6).
 *
 * Зависимостей нет намеренно, как у map-eye-mcp-server: протокол нужен на четыре метода — initialize,
 * tools/list, tools/call, ping, — и SDK ради них был бы лишней движущейся частью.
 *
 * Транспорт: JSON-RPC 2.0 построчно через stdin/stdout. В stdout — только протокол, шум — в stderr.
 * Unity запускатель зовёт без консоли (stdio "ignore"): её журнал уходит в файл, а не в поток.
 *
 * Вызов долгий: снимок — это запуск Unity, 25–60 с, после правки кода дольше. По документации Claude Code
 * (с 2.1.203) вызов stdio-сервера обрывается после 30 минут тишины, общий предел — около 28 часов; Unity
 * запускатель сам снимает через 600 с. Поэтому один вызов — один снимок, без опроса «готово ли».
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

// TOOLS пакета — папка Tools~; здесь это имя уже у списка инструментов MCP.
import { TOOLS as TOOLS_DIR } from "../common.js";
import { lint } from "../linter.js";
import { CODES, DEFAULT_SIZES, LINT_MODES, shoot } from "../runner.js";

// Картинку тяжелее этого в разговор не кладём — только путь (порог map-eye).
const IMAGE_LIMIT = 4 * 1024 * 1024;

// Кадров картинками сверх листа — не больше стольких. Картинки входят в предел вывода MCP
// (MAX_MCP_OUTPUT_TOKENS, по умолчанию 25 000), а как их считают, документация не говорит; остальные — путями.
// Замер на Claude Code 2.1.266: лист и 6 кадров — около 650 КБ base64 — прошли целиком, без обрезки.
const FRAME_LIMIT = 6;

const FRAMES = ["нет", "с-находками", "все"];

const HELP = [
  "ui-eye — машинный глаз интерфейса на UI Toolkit.",
  "",
  "Один холодный батч-запуск Unity снимает одну панель во всех запрошенных состояниях и размерах экрана. " +
    "Редактор Unity должен быть ЗАКРЫТ; снимки на машине идут по одному — калитка общая для всех инстансов, " +
    "проектов, командной строки и калибровки. Цена — 25–60 с на запуск; первый после перерыва — около полутора минут " +
    "(больше всего времени уходит на открытие проекта, сама съёмка — секунды).",
  "",
  "Проект Unity: поле project (путь к папке проекта) → переменная UIEYE_PROJECT в настройках сервера → поиск вверх от " +
    "папки, из которой запущен сервер, до ProjectSettings/ProjectVersion.txt. Путь в project или UIEYE_PROJECT, который " +
    "не ведёт в проект, — отказ, код 5: соседний проект молча не берётся.",
  "",
  "Что приходит:",
  "- вердикт числами — главное, судить по нему;",
  "- контактный лист PNG: строка — состояние, столбец — размер, у всех миниатюр один масштаб;",
  "- кадры PNG и дерево элементов (.tree.txt): тип, #имя, .классы, рамка, шрифт, цвета, видимость, текст и сколько ему нужно места;",
  "- подпись: HEAD, Unity, графическое устройство, цветовое пространство, хеши загруженной разметки и стилей — и какие из этих файлов не в коммите.",
  "",
  "Находки (охват проверок):",
  "- текст-не-влез — тексту нужно больше рамки содержимого: без переноса — по ширине и высоте, с переносом — по высоте. " +
    "Обрезан текст или вылез поверх соседей, числами не различить — смотреть кадр;",
  "- за-краем — видимый элемент выходит за экран (называется самый внешний);",
  "- за-родителя — элемент в потоке вышел за рамку родителя (абсолютные не проверяются: они выходят нарочно);",
  "- нулевой-размер — именованный элемент нулевой ширины или высоты;",
  "- не-устоялся — кадр менялся все 15 чтений подряд (анимация, переход стиля).",
  "НЕ проверяются: наложения соседей и «красиво ли» — это решает человек по листу. " +
    "Проверено только снятое: состояние или размер без снимка — не «в порядке», а не проверены.",
  "",
  "Сперва снимок сам зовёт линтер «разметка ↔ код» — до калитки и до Unity: его находки останавливают снимок (код 6, ответ " +
    "за полсекунды с файлом и строкой, Unity не запускалась). Если ошибся линтер — lint: «предупредить»: снимать всё равно, " +
    "находки строками в отчёте. Что линтер проверить не смог (неизвестная панель, сверено 0), снимок не останавливает — " +
    "в отчёте строка «линтер: не проверил», ответ даёт Unity.",
  "",
  "Коды итога: 0 чисто · 1 находки · 2 не собралось — ошибки компиляции с файлом и строкой (батч-запуск заодно " +
    "компилирует и сборки проекта, которых вне Unity не собрать) · 3 отказ — проект открыт в Unity или идёт другой " +
    "снимок · 4 сторож или таймаут · 5 плохой запрос — неизвестная панель, состояние, размер или режим линтера, или не собран реестр; ответ перечисляет реестр · " +
    "6 панель не сходится — не загрузилась разметка или состоянию не хватает элемента; или то же нашёл линтер до Unity · 7 сбой.",
  "",
  "Поля ui_eye_shot: panel — имя из реестра (калибровочная — «probe»); states — какие состояния, пусто — все; " +
    "sizes — «ширинаxвысота» от 320 до 7680, по умолчанию 1920x1080 и 2560x1080 (16:9 и 21:9); " +
    `frames — кадры картинками сверх листа: «нет» (по умолчанию), «с-находками», «все» — не больше ${FRAME_LIMIT}, остальные путями; ` +
    "lint — «стоп» (по умолчанию) или «предупредить».",
  "Сторож съёмщика — 180 с на всю пачку от входа в Play Mode (12 кадров «probe» вместе с запуском Unity — 55 с): большой запрос делить.",
  "",
  `Линтер «разметка ↔ код» — ui_eye_lint (или node "${join(TOOLS_DIR, "lint.js")}" [--панель имя] [--проект папка]): без Unity, ` +
    "около секунды, редактор может быть открыт. Сверяет имена и классы, по которым код панели ищет элементы (Q, Query и " +
    "помощники вроде UiEyeFill.Text — их линтер выводит сам), с UXML этой панели из реестра, с шаблонами; код — из Assets и из " +
    "пакета ui-eye, который подключает проект; типы — по таблице, снятой с Unity: UserSettings/ui-eye/uitk-types.json проекта; " +
    `её снимает попутно каждый снимок, явно — node "${join(TOOLS_DIR, "types.js")}" --проект папка. ` +
    "Находки: нет-в-разметке (с похожими именами) · не-тот-тип · имя-не-одно (для Q) · класса-нет · разметки-нет · разметка-не-разобрана. " +
    "Не проверенное — списком, не молча: имя-вычисляется · не-с-чем-сверить (вызов вне реестра) · тип-неизвестен · вызов-не-разрешён · " +
    "разбор-кода. Коды: 0 чисто · 1 находки · 5 плохой запрос · 7 сбой, в том числе «сверено 0». Снимок зовёт его сам; отдельно — " +
    "после правки .uxml или кода панели, для всех панелей сразу и ради полного списка не проверенного. НЕ проверяет селекторы USS " +
    "и то, как дерево перестраивается в игре.",
  "",
  "Файлы запуска: <проект>/Logs/ui-eye/<дата-время>/ — request.json, result.json (ответ съёмщика), verdict.txt, runner.json, " +
    "unity.log, report.txt, кадры, деревья, sheet.png. Снимок, остановленный линтером, папки не заводит.",
  "Новая панель — статический метод без параметров с атрибутом [UiEyePanel], который возвращает new UiEyePanel(имя, описание, " +
    "путь UXML, состояния), — своим файлом в сборке редактора проекта, пакет не правится (образец — Editor/Probe/UiEyeProbe.cs " +
    "пакета); своя тема — .WithTheme(путь). Одно имя у двух методов или ни одного метода — отказ реестра, код 5. " +
    "Состояние — код, наполняющий разметку " +
    "(UiEyeFill.Text, UiEyeFill.AddClass) или ведущий настоящий вид панели с поддельным источником данных: промах по имени элемента — " +
    "громкий код 6, а не пустое место; линтер в снимке ловит его до Unity.",
  `Исправен ли сам глаз: node "${join(TOOLS_DIR, "calibrate.js")}" всё — нарочные поломки с заранее записанным ответом ` +
    "(линтер отдельно и без Unity — calibrate.js линтер).",
  "Побочное: Unity, выходя, убирает папку Temp/ проекта — что другие инструменты держали там, после снимка пропадёт.",
].join("\n");

// --- очередь ------------------------------------------------------------------

// Вызовы этого сервера идут по одному. Claude Code шлёт параллельные tools/call разом, а Unity не откроет
// проект дважды: без очереди второй получил бы отказ калитки (код 3) и повторял бы сам, с очередью — ждёт.
// Между процессами — другой инстанс, командная строка, калибровка — стережёт калитка запускателя (takeGate
// в runner.js): ждать там некого, и чужой снимок получает честный отказ.
let tail = Promise.resolve();

function queued(work) {
  const turn = tail.then(() => work());
  tail = turn.catch(() => {});
  return turn;
}

// --- инструменты --------------------------------------------------------------

function problemWithShot(input) {
  if (typeof input.panel !== "string" || input.panel.trim() === "") {
    return "нужно имя панели в поле panel. Калибровочная — «probe»; реестр — ui_eye_help с panels: true.";
  }

  for (const key of ["states", "sizes"]) {
    const value = input[key];

    if (value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== "string"))) {
      return `поле ${key} — список строк.`;
    }
  }

  if (input.frames !== undefined && !FRAMES.includes(input.frames)) {
    return `поле frames — одно из: ${FRAMES.join(", ")}.`;
  }

  if (input.lint !== undefined && !LINT_MODES.includes(input.lint)) {
    return `поле lint — одно из: ${LINT_MODES.join(", ")}.`;
  }

  return problemWithProject(input);
}

/** Поле project необязательно; если есть — непустой путь. Ведёт ли он в проект, скажут запускатель и линтер (код 5). */
function problemWithProject(input) {
  return input.project !== undefined && (typeof input.project !== "string" || input.project.trim() === "")
    ? "поле project — путь к папке проекта Unity; не указывать — UIEYE_PROJECT сервера или поиск вверх от его папки."
    : null;
}

async function shot(input) {
  const problem = problemWithShot(input);
  if (problem) {
    return { isError: true, content: [{ type: "text", text: `ui-eye: ${problem}` }] };
  }

  const outcome = await queued(() =>
    shoot({
      panel: input.panel.trim(),
      states: input.states ?? [],
      sizes: input.sizes?.length ? input.sizes : DEFAULT_SIZES,
      lint: input.lint,
      project: input.project,
    }),
  );

  const lines = [outcome.report];

  if (outcome.shots.length > 0) {
    lines.push("кадры (дерево элементов — рядом, .tree.txt вместо .png):");

    for (const frame of outcome.shots) {
      lines.push(`  ${frame.state}  ${frame.size}  находок ${frame.findings.length}  ${frame.png}`);
    }
  }

  const frames = input.frames ?? "нет";
  const wanted =
    frames === "все"
      ? outcome.shots
      : frames === "с-находками"
        ? outcome.shots.filter((frame) => frame.findings.length > 0)
        : [];
  const attached = wanted.slice(0, FRAME_LIMIT);

  if (attached.length < wanted.length) {
    lines.push(`картинками приложено кадров ${attached.length} из ${wanted.length}; остальные — по путям выше.`);
  }

  const content = [{ type: "text", text: lines.join("\n") }];
  attach(content, outcome.sheet, "лист");

  for (const frame of attached) {
    content.push({ type: "text", text: `кадр: ${frame.state} · ${frame.size} · находок ${frame.findings.length}` });
    attach(content, frame.png, "кадр");
  }

  // Находки (код 1) — удачный снимок с ответом, а не сбой инструмента; ошибка — всё, что от 2.
  return outcome.code >= CODES.compile ? { isError: true, content } : { content };
}

function lintPanels(input) {
  if (input.panel !== undefined && (typeof input.panel !== "string" || input.panel.trim() === "")) {
    return { isError: true, content: [{ type: "text", text: "ui-eye: поле panel — имя панели из реестра; не указывать — все панели." }] };
  }

  const problem = problemWithProject(input);
  if (problem) {
    return { isError: true, content: [{ type: "text", text: `ui-eye: ${problem}` }] };
  }

  // Линтеру Unity не нужна: мимо очереди снимков, ответ сразу. Находки (код 1) — ответ, а не сбой.
  const outcome = lint({ panel: input.panel?.trim(), project: input.project });
  const content = [{ type: "text", text: outcome.report }];
  return outcome.code >= CODES.compile ? { isError: true, content } : { content };
}

async function help(input) {
  const content = [{ type: "text", text: HELP }];

  if (input.panels !== true) {
    return { content };
  }

  const problem = problemWithProject(input);
  if (problem) {
    return { isError: true, content: [...content, { type: "text", text: `ui-eye: ${problem}` }] };
  }

  const listed = await queued(() => shoot({ list: true, project: input.project }));
  content.push({ type: "text", text: listed.report });
  return listed.code >= CODES.compile ? { isError: true, content } : { content };
}

function attach(content, path, what) {
  if (!path || !existsSync(path)) {
    return;
  }

  const bytes = readFileSync(path);

  if (bytes.length > IMAGE_LIMIT) {
    content.push({ type: "text", text: `${what} тяжёлый (${Math.round(bytes.length / 1024)} КБ) — открыть по пути: ${path}` });
    return;
  }

  content.push({ type: "image", data: bytes.toString("base64"), mimeType: "image/png" });
}

// --- описание инструментов --------------------------------------------------

const PROJECT_FIELD = {
  type: "string",
  description: "Папка проекта Unity. Не указывать — переменная UIEYE_PROJECT сервера или поиск вверх от папки, из которой запущен сервер.",
};

const TOOLS = [
  {
    name: "ui_eye_shot",
    description:
      "Снимок панели интерфейса на UI Toolkit без открытого редактора: один холодный батч-запуск Unity " +
      "снимает панель во всех запрошенных состояниях и размерах экрана (25–60 с; после правки кода дольше). " +
      "Возвращает вердикт числами — какой текст не влез, что вышло за край экрана или за родителя, что нулевого " +
      "размера, какой кадр не устоялся, — подпись (HEAD, хеши загруженной разметки, что из неё не в коммите) и " +
      "контактный лист картинкой. Вердикт дают числа; лист — посмотреть и показать человеку: «красиво ли» решает он. " +
      "Заодно это компилятор и тех сборок проекта, которых вне Unity не собрать: ошибки придут с файлом и строкой (код 2). " +
      "Только при закрытом редакторе Unity; снимки на машине идут по одному. Сперва сам зовёт линтер «разметка ↔ код»: " +
      "его находки останавливают снимок до Unity — код 6, ответ за секунду с файлом и строкой; lint: «предупредить» — " +
      "снимать всё равно. Коды, охват проверок, реестр панелей — ui_eye_help.",
    inputSchema: {
      type: "object",
      properties: {
        panel: {
          type: "string",
          description: "Имя панели из реестра ui-eye (методы с [UiEyePanel]). Калибровочная — «probe».",
        },
        states: {
          type: "array",
          items: { type: "string" },
          description: "Какие состояния снять. Пусто — все состояния панели.",
        },
        sizes: {
          type: "array",
          items: { type: "string" },
          description: "Размеры экрана «ширинаxвысота», от 320 до 7680. По умолчанию 1920x1080 и 2560x1080 (16:9 и 21:9).",
        },
        frames: {
          type: "string",
          enum: FRAMES,
          description: `Кадры картинками сверх листа: «нет» (по умолчанию), «с-находками», «все» — не больше ${FRAME_LIMIT}, остальные путями.`,
        },
        lint: {
          type: "string",
          enum: LINT_MODES,
          description:
            "Линтер перед снимком: «стоп» (по умолчанию) — его находки останавливают снимок до Unity, код 6 с файлом и строкой; " +
            "«предупредить» — снимать всё равно, находки строками в отчёте (если ошибся линтер).",
        },
        project: PROJECT_FIELD,
      },
      required: ["panel"],
    },
  },
  {
    name: "ui_eye_lint",
    description:
      "Линтер «разметка ↔ код» без Unity: около секунды, редактор может быть открыт. Сверяет имена и классы, по которым код " +
      "панели ищет элементы (Q, Query и помощники вроде UiEyeFill.Text — выводятся сами), с UXML этой панели из реестра ui-eye, " +
      "с шаблонами. Находки с файлом и строкой: имени нет в разметке (с похожими именами), элемент не того типа, Q по " +
      "неединственному имени, класса нет, разметки нет или она не разобрана. Не проверенное — списком: вычисляемые имена, " +
      "обращения вне реестра, неизвестные типы. Подпись — HEAD и хеши файлов, из которых сложен ответ. ui_eye_shot зовёт его " +
      "сам; отдельно — после правки .uxml или кода панели, для всех панелей сразу и ради полного списка не проверенного.",
    inputSchema: {
      type: "object",
      properties: {
        panel: {
          type: "string",
          description: "Имя панели из реестра ui-eye (методы с [UiEyePanel]). Не указывать — все панели.",
        },
        project: PROJECT_FIELD,
      },
    },
  },
  {
    name: "ui_eye_help",
    description:
      "Как пользоваться ui-eye: что снимает, что проверяет и чего не проверяет, коды итога, где файлы, как добавить " +
      "панель и как проверить исправность самого глаза. С panels: true — ещё и реестр панелей со всеми состояниями " +
      "(это запуск Unity, от 25 с до полутора минут, при закрытом редакторе). Спросить перед первым снимком, если не знаешь имён.",
    inputSchema: {
      type: "object",
      properties: {
        panels: {
          type: "boolean",
          description: "true — запустить Unity и перечислить панели реестра с их состояниями.",
        },
        project: PROJECT_FIELD,
      },
    },
  },
];

// --- протокол ---------------------------------------------------------------

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(message) {
  const { id, method, params } = message;
  const isRequest = id !== undefined && id !== null;

  switch (method) {
    case "initialize": {
      const asked = typeof params?.protocolVersion === "string" ? params.protocolVersion : "2024-11-05";
      reply(id, {
        protocolVersion: asked,
        capabilities: { tools: {} },
        serverInfo: { name: "ui-eye", version: "0.1.0" },
      });
      return;
    }

    case "tools/list":
      reply(id, { tools: TOOLS });
      return;

    case "tools/call": {
      const name = params?.name;
      const input = params?.arguments ?? {};

      try {
        if (name === "ui_eye_shot") {
          reply(id, await shot(input));
        } else if (name === "ui_eye_lint") {
          reply(id, lintPanels(input));
        } else if (name === "ui_eye_help") {
          reply(id, await help(input));
        } else {
          replyError(id, -32602, `Нет такого инструмента: ${name}`);
        }
      } catch (error) {
        reply(id, { isError: true, content: [{ type: "text", text: `ui-eye: ${error?.stack ?? error}` }] });
      }

      return;
    }

    case "ping":
      reply(id, {});
      return;

    default:
      // Уведомления (без id) ответа не требуют — молча пропускаем.
      if (isRequest) {
        replyError(id, -32601, `Метод не поддержан: ${method}`);
      }
  }
}

// Сервер не зовёт process.exit. Снимок идёт до минуты, и stdin может закрыться раньше: работа доделывается,
// ответ пишется, и процесс гаснет сам, когда делать больше нечего. process.exit не ждёт асинхронной записи
// в stdout, а в ответе — картинка в сотни килобайт.
process.stdout.on("error", (error) => {
  // Клиент ушёл, не дождавшись ответа: писать некуда, а файлы снимка уже на диске.
  if (error.code !== "EPIPE") {
    process.stderr.write(`ui-eye: ${error}\n`);
  }
});

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let cut;

  while ((cut = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, cut).trim();
    buffer = buffer.slice(cut + 1);

    if (!line) {
      continue;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      process.stderr.write(`ui-eye: не разобрал строку: ${error}\n`);
      continue;
    }

    handle(message).catch((error) => process.stderr.write(`ui-eye: ${error?.stack ?? error}\n`));
  }
});
