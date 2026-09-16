/**
 * ui-eye — линтер «разметка ↔ код», без Unity: имена и классы, по которым код ищет элементы, против UXML своей панели.
 *
 * Код разбирается своим лексером и лёгким разбором (lint/cslex.js, lint/csparse.js); обращения к разметке и помощники,
 * через которые они идут, выводятся в lint/analyze.js; разметка — lint/uxml.js. Пара «код ↔ разметка» — через реестр
 * ui-eye, то есть каждое new UiEyePanel(…): что вызывается из него и из типов, на которые оттуда ссылаются, сверяется с
 * разметкой этой панели (с шаблонами). Типы — по таблице, снятой с самой Unity (UserSettings/ui-eye/uitk-types.json
 * проекта: снимается попутно каждым снимком, явно — node Tools~/types.js); нет таблицы или она с другой версии Unity — типы
 * не проверяются, и отчёт говорит это громко.
 *
 * Находки: нет-в-разметке · не-тот-тип · имя-не-одно (Q, не Query) · класса-нет · разметки-нет · разметка-не-разобрана.
 * Не проверено — списком, не молча: имя-вычисляется · не-с-чем-сверить · тип-неизвестен · путь-вычисляется ·
 * вызов-не-разрешён · разбор-кода.
 * Сканируются .cs под Assets и исходники пакета ui-eye, который подключает проект (там «проба» и помощники UiEyeFill), —
 * кроме папок на «~» и «.» и сборок с noEngineReferences: true: им UI Toolkit не виден компилятором. Проект — поле
 * project, переменная UIEYE_PROJECT или поиск вверх от текущей папки (common.js). Коды — как у запускателя: 0 чисто ·
 * 1 находки · 5 плохой запрос (и проект не найден) · 7 сбой (и охват ноль).
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";

import { analyzeCode } from "./lint/analyze.js";
import { parseUxml } from "./lint/uxml.js";
import { CODES, ProjectNotFound, TOOLS, findPackage, findProject, git, markUncommitted } from "./common.js";
import { TYPES_TABLE } from "./typestable.js";

const VISUAL_ELEMENT = "UnityEngine.UIElements.VisualElement";
const VERSION_PATH = "ProjectSettings/ProjectVersion.txt";
const MAX_TEMPLATE_DEPTH = 8;
const LIST_CAP = 60;

// Без годной таблицы типы не проверяются, но «where T : VisualElement» и свои элементы от VisualElement узнаются.
const FALLBACK_TABLE = { unityVersion: "", types: [{ name: VISUAL_ELEMENT, bases: [], uxmlName: "" }] };

const VERDICTS = { 0: "ЧИСТО", 1: "НАХОДКИ", 5: "ПЛОХОЙ ЗАПРОС", 7: "СБОЙ" };

class BadRequest extends Error {}

/**
 * @param {{ panel?: string, project?: string, overlay?: Record<string, string>, remove?: string[], typesTable?: object }} input
 *   panel — только эта панель реестра; project — папка проекта Unity (иначе UIEYE_PROJECT или поиск вверх, common.js);
 *   overlay — путь, как его видит Unity (Assets/…, Packages/<имя пакета>/…), → текст вместо файла (или новый файл);
 *   remove — пути, которых «нет»; typesTable — таблица типов вместо таблицы проекта. overlay, remove и typesTable — для
 *   калибровки: диск не трогается.
 * @returns {{ code: number, headline: string, report: string, result: object }}
 */
export function lint(input = {}) {
  const run = {
    started: Date.now(),
    seconds: 0,
    request: null,
    head: "",
    sources: null,
    types: null,
    analysis: null,
    panels: [],
    findings: [],
    notChecked: [],
    lookups: [],
    problems: [],
    signature: [],
    typesSkipped: 0,
  };

  try {
    run.request = validate(input);
  } catch (error) {
    return conclude(run, error instanceof BadRequest ? CODES.request : CODES.failure, error.message);
  }

  try {
    return lintUnder(run);
  } catch (error) {
    return conclude(run, CODES.failure, `сбой линтера: ${error?.stack ?? error}`);
  }
}

function validate(input) {
  if (input === null || typeof input !== "object") {
    throw new BadRequest("запрос линтера — объект");
  }

  if (input.panel !== undefined && input.panel !== null && (typeof input.panel !== "string" || input.panel.trim() === "")) {
    throw new BadRequest("panel — непустая строка (или не указывать: все панели реестра)");
  }

  const overlay = {};
  for (const [path, text] of Object.entries(input.overlay ?? {})) {
    if (typeof text !== "string") {
      throw new BadRequest(`overlay «${path}» — не текст`);
    }

    overlay[normalize(path)] = text;
  }

  if (input.remove !== undefined && !Array.isArray(input.remove)) {
    throw new BadRequest("remove — список путей");
  }

  let project;
  try {
    project = findProject(input.project);
  } catch (error) {
    throw error instanceof ProjectNotFound ? new BadRequest(error.message) : error;
  }

  return {
    panel: typeof input.panel === "string" ? input.panel.trim() : null,
    overlay,
    remove: new Set((input.remove ?? []).map(normalize)),
    typesTable: input.typesTable ?? null,
    project,
    root: project.root,
    package: findPackage(project.root),
  };
}

function lintUnder(run) {
  const { request } = run;
  const hashes = new Map();
  const read = reader(request, hashes);

  run.head = (git(request.root, ["rev-parse", "HEAD"]) ?? "").trim();
  run.sources = collectSources(request, read);
  run.problems.push(...run.sources.problems);

  if (run.sources.files.length === 0) {
    return conclude(run, CODES.failure, "не нашлось ни одного .cs для сканирования — охват ноль, это отказ прибора, а не чистота");
  }

  run.types = loadTypes(request, read);
  let resolver = null;
  const isElementType = (name, models) => {
    resolver ??= typeResolver(run.types.table, models);
    const resolved = resolver.resolve(name);
    return !resolved.error && resolved.chain.includes(VISUAL_ELEMENT);
  };

  const analysis = analyzeCode(run.sources.files, { isElementType });
  run.analysis = analysis;
  resolver ??= typeResolver(run.types.table, analysis.models);

  if (!analysis.converged) {
    return conclude(run, CODES.failure, "вывод помощников не сошёлся за 12 кругов — сверка была бы неполной");
  }

  if (analysis.registry.length === 0) {
    return conclude(
      run,
      CODES.failure,
      "в сканируемом коде нет ни одного new UiEyePanel(…) — сверять не с чем (панель регистрируется методом с атрибутом [UiEyePanel])",
    );
  }

  if (request.panel !== null && !analysis.registry.some((entry) => entry.panel === request.panel)) {
    const known = analysis.registry.map((entry) => (entry.panel !== null ? `«${entry.panel}»` : `(имя вычисляется: ${entry.panelText})`));
    return conclude(run, CODES.request, `нет панели «${request.panel}» в реестре ui-eye; есть: ${known.join(", ")}`);
  }

  const firstPlace = new Map();
  for (const entry of analysis.registry) {
    if (entry.panel !== null && firstPlace.has(entry.panel)) {
      run.problems.push({
        file: entry.file,
        line: entry.line,
        message: `панель «${entry.panel}» встречается второй раз (первая — ${firstPlace.get(entry.panel)}); два метода с [UiEyePanel] под одним именем — отказ реестра в съёмщике, код 5`,
      });
    } else if (entry.panel !== null) {
      firstPlace.set(entry.panel, `${entry.file}:${entry.line}`);
    }
  }

  analysis.registry.forEach((entry, entryIndex) => {
    if (request.panel === null || entry.panel === request.panel) {
      run.panels.push(loadPanel(entry, entryIndex, read, run));
    }
  });

  checkLookups(run, resolver);

  for (const model of analysis.models) {
    for (const problem of model.problems) {
      run.notChecked.push({ kind: "разбор-кода", panel: null, file: model.path, line: problem.line, call: "", reason: problem.message });
    }
  }

  for (const item of analysis.unresolved) {
    run.notChecked.push({
      kind: "вызов-не-разрешён",
      panel: null,
      file: item.file,
      line: item.line,
      call: item.call,
      reason: `похоже на вызов помощника ${item.sinks.join(" / ")}, но не признан: через переменную в файле, где тип помощника не назван, или из чужого типа`,
    });
  }

  run.findings.sort(byPlace);
  run.notChecked.sort(byPlace);
  run.signature = sign(run, hashes);

  run.checksRan = true;
  const checked = run.panels.reduce((sum, panel) => sum + panel.checked, 0);
  const withFindings = new Set(run.findings.map((finding) => finding.entryIndex)).size;
  const blind = run.types.ok ? "" : "; ТИПЫ НЕ ПРОВЕРЯЛИСЬ — см. подпись";

  if (run.findings.length > 0) {
    return conclude(run, CODES.findings, `находок ${run.findings.length} (панелей с находками ${withFindings}); сверено обращений ${checked}${blind}`);
  }

  if (checked === 0) {
    return conclude(
      run,
      CODES.failure,
      "сверено обращений 0 — охват ноль: у панели нет обращений по имени или классу, либо линтер их не видит (списки ниже)",
    );
  }

  const skipped = run.notChecked.length > 0 ? `; не проверено ${run.notChecked.length} — списком ниже` : "";
  return conclude(run, CODES.clean, `находок нет; сверено обращений ${checked}${skipped}${blind}`);
}

function normalize(path) {
  return String(path).replace(/\\/g, "/").replace(/^\.\//, "");
}

function hidden(name) {
  return name.endsWith("~") || name.startsWith(".");
}

/**
 * Чтение по пути, как его видит Unity (Assets/…, ProjectSettings/…, Packages/<имя пакета>/…): overlay, затем диск; null —
 * файла нет. Хеш — от байтов, как у съёмщика.
 */
function reader(request, hashes) {
  const locate = locator(request);

  return (path) => {
    if (request.remove.has(path)) {
      return null;
    }

    if (Object.hasOwn(request.overlay, path)) {
      const text = request.overlay[path];
      hashes.set(path, sha(Buffer.from(text, "utf8")));
      return text;
    }

    const full = locate(path);
    if (!statSync(full, { throwIfNoEntry: false })?.isFile()) {
      return null;
    }

    const bytes = readFileSync(full);
    hashes.set(path, sha(bytes));
    const text = bytes.toString("utf8");
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  };
}

/** Путь, как его видит Unity, → путь на диске: Packages/<имя пакета>/… — в папке пакета (findPackage), прочее — от корня проекта. */
function locator(request) {
  const { name, dir } = request.package;
  const top = dir === null ? null : `Packages/${name}`;

  return (path) =>
    top !== null && (path === top || path.startsWith(`${top}/`))
      ? join(dir, ...path.slice(top.length).split("/").filter(Boolean))
      : join(request.root, ...path.split("/"));
}

/** .cs под Assets и в пакете ui-eye, видимые Unity, с их сборками; сборки без движка — только счётом. */
function collectSources(request, read) {
  const found = new Set();
  const pattern = /\.(cs|asmdef|asmref)$/i;
  const locate = locator(request);
  const tops = ["Assets", ...(request.package.dir === null ? [] : [`Packages/${request.package.name}`])];

  const walk = (relative) => {
    for (const entry of readdirSync(locate(relative), { withFileTypes: true })) {
      if (hidden(entry.name)) {
        continue;
      }

      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile() && pattern.test(entry.name)) {
        found.add(path);
      }
    }
  };

  // Нет Assets или папки пакета — не сбой, а ноль файлов оттуда: охват скажет это сам.
  for (const top of tops) {
    if (statSync(locate(top), { throwIfNoEntry: false })?.isDirectory()) {
      walk(top);
    }
  }

  for (const path of Object.keys(request.overlay)) {
    if (tops.some((top) => path.startsWith(`${top}/`)) && pattern.test(path) && !path.split("/").some(hidden)) {
      found.add(path);
    }
  }

  const paths = [...found].filter((path) => !request.remove.has(path)).sort();
  const problems = [];
  const asmdefs = new Map();

  for (const path of paths.filter((item) => /\.asmdef$/i.test(item))) {
    try {
      const json = JSON.parse(read(path));
      asmdefs.set(posix.dirname(path), { name: json.name ?? posix.basename(path, ".asmdef"), noEngine: json.noEngineReferences === true });
    } catch (error) {
      problems.push({ file: path, line: 1, message: `asmdef не разобран (${error.message}) — файлы папки отнесены к сборке выше` });
    }
  }

  for (const path of paths.filter((item) => /\.asmref$/i.test(item))) {
    problems.push({ file: path, line: 1, message: "asmref линтер не читает — файлы папки отнесены к ближайшему asmdef выше" });
  }

  const assemblyOf = (path) => {
    for (let dir = posix.dirname(path); dir !== "." && dir !== ""; dir = posix.dirname(dir)) {
      if (asmdefs.has(dir)) {
        return asmdefs.get(dir);
      }
    }

    return { name: defaultAssembly(path), noEngine: false };
  };

  const rows = new Map();
  const files = [];
  let total = 0;

  for (const path of paths.filter((item) => /\.cs$/i.test(item))) {
    total++;
    const assembly = assemblyOf(path);
    const row = rows.get(assembly.name) ?? { name: assembly.name, scanned: 0, excluded: 0 };
    rows.set(assembly.name, row);

    if (assembly.noEngine) {
      row.excluded++;
      continue;
    }

    row.scanned++;
    files.push({ path, text: read(path) ?? "", assembly: assembly.name });
  }

  const packageTop = request.package.dir === null ? null : `Packages/${request.package.name}/`;
  const packageCs = packageTop === null ? 0 : paths.filter((path) => /\.cs$/i.test(path) && path.startsWith(packageTop)).length;

  return { total, files, assemblies: [...rows.values()].sort((a, b) => b.scanned + b.excluded - (a.scanned + a.excluded)), problems, packageCs };
}

/** Сборка по умолчанию для файла вне asmdef — как в Unity: Editor и Plugins дают свои. */
function defaultAssembly(path) {
  const folders = path.split("/").slice(1, -1);
  const firstpass = ["Plugins", "Standard Assets", "Pro Standard Assets"].includes(folders[0]);
  return `Assembly-CSharp${folders.includes("Editor") ? "-Editor" : ""}${firstpass ? "-firstpass" : ""}`;
}

function loadTypes(request, read) {
  const projectVersion = /m_EditorVersion:\s*(\S+)/.exec(read(VERSION_PATH) ?? "")?.[1] ?? null;
  const refuse = (reason) => ({ ok: false, reason, projectVersion, unityVersion: null, count: 0, table: FALLBACK_TABLE });
  let table = request.typesTable;

  if (table === null) {
    const text = read(TYPES_TABLE);
    if (text === null) {
      return refuse(`нет ${TYPES_TABLE} — снимется первым снимком; сразу: ${typesCommand(request.root)} (Unity в батче, редактор закрыт)`);
    }

    try {
      table = JSON.parse(text);
    } catch (error) {
      return refuse(`${TYPES_TABLE} не разобран: ${error.message}`);
    }
  }

  if (!Array.isArray(table?.types) || table.types.length === 0) {
    return refuse("в таблице типов нет ни одного типа");
  }

  if (projectVersion === null) {
    return refuse(`версия Unity проекта не прочитана из ${VERSION_PATH}`);
  }

  if (table.unityVersion !== projectVersion) {
    return refuse(`таблица типов снята с Unity ${table.unityVersion}, а проект — ${projectVersion}; переснимется следующим снимком; сразу: ${typesCommand(request.root)}`);
  }

  return { ok: true, reason: "", projectVersion, unityVersion: table.unityVersion, count: table.types.length, table };
}

/** Команда таблицы типов с настоящим путём инструмента и проектом: подсказку копируют в терминал, где текущая папка — любая. */
function typesCommand(root) {
  return `node "${join(TOOLS, "types.js")}" --проект "${root}"`;
}

/**
 * Типы по имени из кода (краткому, полному, обобщённому) и по тегу разметки → полное имя и цепочка предков.
 * Свои элементы проекта — по первому базовому типу из разбора; двусмысленность — ошибка, не догадка.
 */
function typeResolver(table, models) {
  const tableFull = new Map();
  const tableShort = new Map();
  const tableUxml = new Map();

  for (const type of table.types) {
    tableFull.set(type.name, type);
    const short = type.name.slice(type.name.lastIndexOf(".") + 1);
    tableShort.set(short, tableShort.has(short) ? null : type);

    if (type.uxmlName) {
      tableUxml.set(type.uxmlName, type);
    }
  }

  const projectFull = new Map();
  const projectShort = new Map();

  for (const model of models) {
    for (const type of model.parsed.types) {
      if (type.kind === "class" || type.kind === "record") {
        projectFull.set(type.fullName, type);
        projectShort.set(type.name, [...(projectShort.get(type.name) ?? []), type]);
      }
    }
  }

  const cache = new Map();
  const fromTable = (type) => ({ full: type.name, chain: [type.name, ...(type.bases ?? [])] });

  const fromProject = (type) => {
    const parent = type.bases.length > 0 ? resolve(type.bases[0]) : null;
    return { full: type.fullName, chain: parent && !parent.error ? [type.fullName, ...parent.chain] : [type.fullName] };
  };

  function resolve(raw) {
    const key = cleanTypeName(raw);

    if (cache.has(key)) {
      return cache.get(key);
    }

    cache.set(key, { error: `цепочка предков «${raw}» замыкается на себя` });
    const plain = key.replace(/`\d+$/, "");
    const dot = key.lastIndexOf(".");
    let result;

    if (dot >= 0 && tableFull.has(key)) {
      result = fromTable(tableFull.get(key));
    } else if (dot >= 0 && projectFull.has(plain)) {
      result = fromProject(projectFull.get(plain));
    } else {
      const short = dot >= 0 ? key.slice(dot + 1) : key;
      const inTable = tableShort.get(short);
      const own = projectShort.get(short.replace(/`\d+$/, "")) ?? [];

      if (inTable === null) {
        result = { error: `в таблице UI Toolkit несколько типов «${short}»` };
      } else if (inTable && own.length > 0) {
        result = { error: `«${short}» есть и в UI Toolkit, и в коде проекта — чей, линтер не решает` };
      } else if (inTable) {
        result = fromTable(inTable);
      } else if (own.length === 1) {
        result = fromProject(own[0]);
      } else if (own.length > 1) {
        result = { error: `в коде проекта ${own.length} типа с именем «${short}»` };
      } else {
        result = { error: `тип «${raw}» не найден ни в таблице UI Toolkit, ни в сканируемом коде` };
      }
    }

    cache.set(key, result);
    return result;
  }

  const resolveMarkup = (tag) => {
    if (tableFull.has(tag)) {
      return fromTable(tableFull.get(tag));
    }

    if (projectFull.has(tag)) {
      return fromProject(projectFull.get(tag));
    }

    if (tableUxml.has(tag)) {
      return fromTable(tableUxml.get(tag));
    }

    return { error: `тег «${tag}» не найден ни в таблице UI Toolkit, ни в сканируемом коде` };
  };

  return { resolve, resolveMarkup };
}

/** «global::A.B<int, C<D>>?» → «A.B`2». */
function cleanTypeName(raw) {
  const name = String(raw).replace(/^global::/, "").replace(/\s+/g, "").replace(/\?$/, "");
  const open = name.indexOf("<");

  if (open < 0) {
    return name;
  }

  let depth = 0;
  let arity = 1;

  for (let index = open + 1; index < name.length; index++) {
    if (name[index] === "<") {
      depth++;
    } else if (name[index] === ">") {
      depth--;
    } else if (name[index] === "," && depth === 0) {
      arity++;
    }
  }

  return `${name.slice(0, open)}\`${arity}`;
}

/** Разметка панели с шаблонами: плоский список элементов (дети экземпляра шаблона — его дети). */
function loadPanel(entry, entryIndex, read, run) {
  const panel = {
    entryIndex,
    name: entry.panel ?? `(имя вычисляется: ${entry.panelText})`,
    markup: entry.markup,
    file: entry.file,
    line: entry.line,
    status: "ok",
    reason: "",
    elements: [],
    files: [],
    added: new Set(),
    addedComputed: 0,
    checked: 0,
    findingCount: 0,
  };

  if (entry.markup === null) {
    panel.status = "путь-вычисляется";
    panel.reason = `путь разметки вычисляется (${entry.markupText}) — сверять не с чем`;
    return panel;
  }

  const fail = (kind, file, line, message) => {
    if (panel.status === "ok") {
      panel.status = kind;
      panel.reason = `разметка не загружена: ${message}`;
    }

    run.findings.push({ kind, entryIndex, panel: panel.name, markup: panel.markup, file, line, call: "", message, suggestions: [] });
  };

  const loading = new Set();

  const load = (path, origin, parent, depth) => {
    if (loading.has(path) || depth > MAX_TEMPLATE_DEPTH) {
      fail("разметка-не-разобрана", origin.file, origin.line, `шаблоны вложены по кругу или глубже ${MAX_TEMPLATE_DEPTH}: ${path}`);
      return;
    }

    const text = read(path);
    if (text === null) {
      fail("разметки-нет", origin.file, origin.line, `${origin.what} «${path}» — такого файла нет`);
      return;
    }

    panel.files.push(path);
    const parsed = parseUxml(text);

    if (parsed.problems.length > 0) {
      fail("разметка-не-разобрана", path, parsed.problems[0].line, parsed.problems.map((problem) => `строка ${problem.line}: ${problem.message}`).join("; "));
      return;
    }

    loading.add(path);
    const start = panel.elements.length;

    for (const element of parsed.elements) {
      panel.elements.push({ ...element, file: path, parent: element.parent < 0 ? parent : element.parent + start });
    }

    parsed.elements.forEach((element, index) => {
      if (element.template === null) {
        return;
      }

      const template = parsed.templates.find((item) => item.alias === element.template);
      if (!template) {
        fail("разметка-не-разобрана", path, element.line, `Instance template="${element.template}" — шаблона с таким именем в файле нет`);
        return;
      }

      load(templatePath(path, template.src), { file: path, line: template.line, what: `шаблон «${template.alias}»` }, start + index, depth + 1);
    });

    loading.delete(path);
  };

  load(entry.markup, { file: entry.file, line: entry.line, what: `разметка панели «${panel.name}»` }, -1, 0);
  return panel;
}

/** src шаблона — как у Unity: относительно файла; «/…» — от корня проекта; project://database/… — из UI Builder. */
function templatePath(from, src) {
  const project = /^project:\/\/database\/([^?#]*)/.exec(src.trim());
  const path = project ? decodeURIComponent(project[1]) : src.trim().replace(/[?#].*$/, "");

  if (project) {
    return posix.normalize(path);
  }

  return path.startsWith("/") ? posix.normalize(path.slice(1)) : posix.normalize(posix.join(posix.dirname(from), path));
}

function checkLookups(run, resolver) {
  const { analysis, request } = run;
  const panels = new Map(run.panels.map((panel) => [panel.entryIndex, panel]));

  // Классы, которые код панели добавляет сам: их поиск по классу находкой не будет.
  for (const use of analysis.uses) {
    if (use.role !== "add-class" || use.status === "forwarded") {
      continue;
    }

    for (const entryIndex of use.entries) {
      const panel = panels.get(entryIndex);

      if (panel && use.status === "literal") {
        panel.added.add(use.value);
      } else if (panel && use.status === "computed") {
        panel.addedComputed++;
      }
    }
  }

  // Один вызов-поиск = одно обращение: имя и классы одного Q(…) сверяются вместе.
  const groups = new Map();
  for (const use of analysis.uses) {
    if (use.role === "add-class" || use.status === "forwarded" || use.status === "null") {
      continue;
    }

    const key = `${use.fileIndex}:${use.callIndex}`;
    groups.set(key, [...(groups.get(key) ?? []), use]);
  }

  for (const group of groups.values()) {
    const name = group.find((use) => use.role === "name") ?? null;
    const classes = group.filter((use) => use.role === "class");
    const lead = name ?? classes[0];
    const where = { file: lead.file, line: lead.line, call: lead.call };
    const shown = group.map((use) => `${use.role === "name" ? "#" : "."}${use.status === "literal" ? use.value : use.argText}`).join(" ");

    if (lead.entries.length === 0) {
      if (request.panel === null) {
        run.notChecked.push({
          kind: "не-с-чем-сверить",
          panel: null,
          ...where,
          reason: `${shown}: вызов не достижим из реестра ui-eye (new UiEyePanel) — с какой разметкой сверять, неизвестно`,
        });
      }

      continue;
    }

    for (const entryIndex of lead.entries) {
      const panel = panels.get(entryIndex);

      if (!panel) {
        continue;
      }

      if (panel.status !== "ok") {
        run.notChecked.push({ kind: panel.status, panel: panel.name, ...where, reason: `${shown}: ${panel.reason}` });
        continue;
      }

      const computed = group.filter((use) => use.status !== "literal");
      if (computed.length > 0) {
        run.notChecked.push({
          kind: "имя-вычисляется",
          panel: panel.name,
          ...where,
          reason: `${shown}: значение известно только при запуске (${computed.map((use) => use.argText).join(", ")})`,
        });
        continue;
      }

      panel.checked++;
      const outcome = checkOne(run, resolver, panel, name, classes, where);
      run.lookups.push({ panel: panel.name, ...where, name: name?.value ?? null, classes: classes.map((use) => use.value), type: lead.type, single: lead.single, outcome });
    }
  }

  for (const panel of run.panels) {
    panel.findingCount = run.findings.filter((finding) => finding.entryIndex === panel.entryIndex).length;
  }
}

/** Одно обращение против разметки одной панели. Возвращает виды находок («ок» — чисто). */
function checkOne(run, resolver, panel, name, classes, where) {
  const kinds = [];
  const found = (kind, message, suggestions = []) => {
    run.findings.push({ kind, entryIndex: panel.entryIndex, panel: panel.name, markup: panel.markup, ...where, message, suggestions });
    kinds.push(kind);
  };
  const skip = (reason) => run.notChecked.push({ kind: "тип-неизвестен", panel: panel.name, ...where, reason });
  const lead = name ?? classes[0];
  let candidates = panel.elements;

  if (name) {
    candidates = candidates.filter((element) => element.name === name.value);

    if (candidates.length === 0) {
      found("нет-в-разметке", `#${name.value} нет в разметке «${panel.name}»`, similar(name.value, panel.elements.map((element) => element.name)));
      return kinds;
    }
  }

  for (const use of classes) {
    const carrying = candidates.filter((element) => element.classes.includes(use.value));

    if (carrying.length > 0) {
      candidates = carrying;
      continue;
    }

    if (panel.added.has(use.value)) {
      continue;
    }

    const holder = name ? `у #${name.value}` : "ни у одного элемента";
    const hint = panel.addedComputed > 0 ? `; код панели добавляет и вычисляемые классы (${panel.addedComputed}) — класс мог прийти оттуда` : "";
    const pool = [...panel.elements.flatMap((element) => element.classes), ...panel.added];
    found("класса-нет", `.${use.value} ${holder} в разметке «${panel.name}» нет, и код панели его не добавляет${hint}`, similar(use.value, pool));
    return kinds;
  }

  if (lead.single && name && candidates.length > 1) {
    found("имя-не-одно", `#${name.value} в разметке «${panel.name}» не одно: ${candidates.length} (${candidates.map(place).join(", ")}) — Q вернёт первое`);
  }

  if (lead.type === null) {
    skip(`${label(name, classes)}: тип элемента выводится компилятором из аргументов — линтер его не знает`);
    return kinds;
  }

  if (!run.types.ok) {
    if (cleanTypeName(lead.type).split(".").pop() !== "VisualElement") {
      run.typesSkipped++;
    }

    return kinds;
  }

  const expected = resolver.resolve(lead.type);
  if (expected.error) {
    skip(`${label(name, classes)}: ${expected.error}`);
    return kinds;
  }

  if (expected.full === VISUAL_ELEMENT) {
    return kinds;
  }

  const unknown = [];
  const fitting = candidates.filter((element) => {
    const actual = resolver.resolveMarkup(element.type);

    if (actual.error) {
      unknown.push(`${place(element)}: ${actual.error}`);
      return false;
    }

    return actual.chain.includes(expected.full);
  });

  if (fitting.length === 0 && unknown.length === 0) {
    const actual = candidates.map((element) => `${shortType(element.type)} (${place(element)})`).join(", ");
    found("не-тот-тип", `${label(name, classes)} в разметке «${panel.name}» — ${actual}, а код ждёт ${shortType(expected.full)}`);
  } else if (unknown.length > 0) {
    skip(`${label(name, classes)}: ${unknown.join("; ")}`);
  }

  return kinds;
}

function label(name, classes) {
  return [name ? `#${name.value}` : "", ...classes.map((use) => `.${use.value}`)].filter(Boolean).join("");
}

function place(element) {
  return `${element.file.split("/").pop()}:${element.line}`;
}

function shortType(name) {
  return name.slice(name.lastIndexOf(".") + 1);
}

/** Похожие имена для подсказки: без учёта регистра, перестановка соседних букв — одна правка. */
function similar(value, pool) {
  const target = value.toLowerCase();
  const limit = Math.max(1, Math.floor(value.length / 3));

  return [...new Set(pool)]
    .filter((candidate) => candidate && candidate !== value)
    .map((candidate) => ({ candidate, distance: editDistance(target, candidate.toLowerCase()) }))
    .filter((item) => item.distance <= limit)
    .sort((a, b) => a.distance - b.distance || (a.candidate < b.candidate ? -1 : 1))
    .slice(0, 3)
    .map((item) => item.candidate);
}

function editDistance(a, b) {
  const table = Array.from({ length: a.length + 1 }, (_, row) => Array.from({ length: b.length + 1 }, (_, column) => (row === 0 ? column : column === 0 ? row : 0)));

  for (let row = 1; row <= a.length; row++) {
    for (let column = 1; column <= b.length; column++) {
      const cost = a[row - 1] === b[column - 1] ? 0 : 1;
      table[row][column] = Math.min(table[row - 1][column] + 1, table[row][column - 1] + 1, table[row - 1][column - 1] + cost);

      if (row > 1 && column > 1 && a[row - 1] === b[column - 2] && a[row - 2] === b[column - 1]) {
        table[row][column] = Math.min(table[row][column], table[row - 2][column - 2] + 1);
      }
    }
  }

  return table[a.length][b.length];
}

/** Подпись: из каких файлов сложен ответ — хеш и расхождение с HEAD (или «наложено» калибровкой). */
function sign(run, hashes) {
  const paths = new Set();

  for (const panel of run.panels) {
    paths.add(panel.file);
    panel.files.forEach((file) => paths.add(file));
  }

  run.lookups.forEach((lookup) => paths.add(lookup.file));
  run.analysis.sinks.forEach((sink) => paths.add(sink.file));

  const list = [...paths].filter(Boolean).sort();
  const onDisk = list.filter((path) => !Object.hasOwn(run.request.overlay, path));
  const marks = markUncommitted(run.request.root, run.request.package, onDisk);

  return list.map((path) => ({
    path,
    sha256: hashes.get(path) ?? "",
    mark: Object.hasOwn(run.request.overlay, path) ? "наложено" : (marks[path] ?? ""),
  }));
}

function conclude(run, code, headline) {
  run.seconds = (Date.now() - run.started) / 1000;
  return { code, headline, report: format(run, code, headline), result: summarize(run, code, headline) };
}

/** Строка находки — одна и в отчёте линтера, и в отчёте снимка (runner.js). */
export function findingLine(finding) {
  const hint = finding.suggestions.length > 0 ? ` — похожие: ${finding.suggestions.join(", ")}` : "";
  return `${finding.kind}  ${finding.file}:${finding.line}  ${finding.message}${hint}${finding.call ? `  ⇐ ${finding.call}` : ""}`;
}

/** Строка подписи: путь, хеш и расхождение с HEAD — или «наложено» калибровкой. */
export function signatureLine(item) {
  const mark = item.mark === "наложено" ? "  — НАЛОЖЕНО (не с диска)" : item.mark ? `  — НЕ В КОММИТЕ (${item.mark})` : "";
  return `${item.path}  ${item.sha256.slice(0, 16)}${mark}`;
}

/** Строка «исходники пакета»: откуда, сколько .cs и замечание, если они не те, что проект подключает через манифест. */
function packageLine(pkg, sources) {
  if (pkg.dir === null) {
    return `исходники пакета: не читались — ${pkg.remark}`;
  }

  const count = sources ? ` · .cs ${sources.packageCs}` : "";
  return `исходники пакета: ${pkg.dir} (${pkg.how})${count}${pkg.remark ? ` — ${pkg.remark}` : ""}`;
}

function format(run, code, headline) {
  const lines = [];
  const scope = run.request?.panel ? `панель «${run.request.panel}»` : "все панели реестра";
  lines.push(`ui-eye · линтер «разметка ↔ код» · ${scope}`);
  lines.push(`итог: ${VERDICTS[code]} — ${headline} (код ${code})`);

  if (run.request) {
    lines.push(`проект: ${run.request.root} (${run.request.project.how})`);
    lines.push(packageLine(run.request.package, run.sources));
  }

  if (!run.sources) {
    return lines.join("\n");
  }

  const types = run.types
    ? run.types.ok
      ? `таблица типов Unity ${run.types.unityVersion} = проект (${run.types.count} типов)`
      : `ТИПЫ НЕ ПРОВЕРЯЛИСЬ — ${run.types.reason}`
    : "таблица типов не читалась";
  lines.push(`подпись: HEAD ${run.head.slice(0, 16) || "?"} · ${types} · ${run.seconds.toFixed(1)} с`);

  for (const item of run.signature) {
    lines.push(`  ${signatureLine(item)}`);
  }

  const { sources } = run;
  const excluded = sources.assemblies.filter((row) => row.excluded > 0).map((row) => `${row.name} ${row.excluded}`);
  const broken = run.analysis ? run.analysis.models.filter((model) => model.problems.length > 0).length : 0;
  lines.push(
    `охват кода: .cs сканировано ${sources.files.length} из ${sources.total}` +
      (excluded.length > 0 ? ` (сборки без движка не сканируются: ${excluded.join(", ")})` : "") +
      ` · файлов с ошибками разбора ${broken}`,
  );

  if (run.analysis) {
    const sinks = run.analysis.sinks.map(
      (sink) => `${sink.method}(${sink.slots.map((slot) => `${slot.param} → ${slot.role === "add-class" ? "добавляет класс" : `${slot.role === "class" ? "класс, " : ""}${slot.type}`}`).join("; ")})`,
    );
    lines.push(`помощники, выведенные из кода: ${sinks.join(" · ") || "нет"}`);
  }

  if (run.panels.length > 0) {
    lines.push("панели (сверено = вызовов-поисков × панель):");

    for (const panel of run.panels) {
      const state =
        panel.status === "ok"
          ? `элементов ${panel.elements.length} · сверено ${panel.checked} · находок ${panel.findingCount}`
          : `НЕ СВЕРЕНА (${panel.status}) · находок ${panel.findingCount}`;
      const added = panel.added.size + panel.addedComputed > 0 ? ` · код добавляет классов ${panel.added.size}${panel.addedComputed ? ` + вычисляемых ${panel.addedComputed}` : ""}` : "";
      lines.push(`  «${panel.name}» — ${panel.markup ?? "путь вычисляется"} · ${state}${added}`);
    }
  }

  if (run.findings.length > 0) {
    lines.push("находки:");
    capped(lines, run.findings, (finding) => `  ${findingLine(finding)}`);
  }

  if (run.checksRan) {
    const typesSkipped = run.typesSkipped > 0 ? ` · тип не проверен у ${run.typesSkipped} обращений (нет годной таблицы типов)` : "";
    lines.push(`не проверено: ${run.notChecked.length}${typesSkipped}`);
    capped(lines, run.notChecked, (item) => `  ${item.kind}  ${item.file}:${item.line}  ${item.reason}${item.call ? `  ⇐ ${item.call}` : ""}`);
  }

  if (run.problems.length > 0) {
    lines.push("замечания:");
    capped(lines, run.problems, (problem) => `  ${problem.file}:${problem.line}  ${problem.message}`);
  }

  if (run.checksRan) {
    lines.push(
      "охват проверок: имя есть в разметке панели · тип элемента подходит коду · Q ищет по одному имени · класс есть в разметке или его добавляет " +
        "код панели. НЕ проверяются: селекторы USS, вычисляемые имена и обращения вне реестра (они в «не проверено»), перестройка дерева в игре.",
    );
  }

  return lines.join("\n");
}

function capped(lines, items, render) {
  items.slice(0, LIST_CAP).forEach((item) => lines.push(render(item)));

  if (items.length > LIST_CAP) {
    lines.push(`  … и ещё ${items.length - LIST_CAP} — всё в ответе JSON (lint.js --json)`);
  }
}

function summarize(run, code, headline) {
  return {
    code,
    verdict: VERDICTS[code],
    headline,
    panel: run.request?.panel ?? null,
    project: run.request && { root: run.request.root, how: run.request.project.how },
    head: run.head,
    seconds: run.seconds,
    types: run.types && { ok: run.types.ok, reason: run.types.reason, unityVersion: run.types.unityVersion, projectVersion: run.types.projectVersion, count: run.types.count },
    coverage: run.sources && {
      csTotal: run.sources.total,
      csScanned: run.sources.files.length,
      assemblies: run.sources.assemblies,
      filesWithParseProblems: run.analysis ? run.analysis.models.filter((model) => model.problems.length > 0).length : null,
      checked: run.panels.reduce((sum, panel) => sum + panel.checked, 0),
      notChecked: run.notChecked.length,
      typesSkipped: run.typesSkipped,
      package: { ...run.request.package, cs: run.sources.packageCs },
    },
    panels: run.panels.map((panel) => ({
      name: panel.name,
      markup: panel.markup,
      file: panel.file,
      line: panel.line,
      status: panel.status,
      reason: panel.reason,
      elements: panel.elements.length,
      checked: panel.checked,
      findings: panel.findingCount,
      addedClasses: [...panel.added].sort(),
      addedComputed: panel.addedComputed,
    })),
    findings: run.findings.map(({ entryIndex, ...finding }) => finding),
    notChecked: run.notChecked,
    lookups: run.lookups,
    sinks: run.analysis?.sinks ?? [],
    signature: run.signature,
    problems: run.problems,
  };
}

function byPlace(a, b) {
  return a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0);
}

function sha(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
