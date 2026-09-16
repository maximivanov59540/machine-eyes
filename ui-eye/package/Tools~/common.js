/**
 * ui-eye — общее для запускателя (runner.js), линтера (linter.js), таблицы типов (types.js) и MCP: проект Unity, пакет,
 * который проект подключает, git от папки проекта, папки инструмента и коды итога.
 *
 * Отдельным модулем нарочно: запускатель зовёт линтер до снимка, и если бы линтер брал это из runner.js,
 * модули импортировали бы друг друга по кругу. runner.js переэкспортирует коды — прочие импорты
 * не меняются.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

/** Папка Tools~ пакета: подсказки печатают команды с этим путём, а не зашитым. */
export const TOOLS = dirname(fileURLToPath(import.meta.url));

/** Корень пакета — над Tools~: там package.json и Editor/. */
export const PACKAGE = dirname(TOOLS);

/** Коды итога — одинаковы для снимка и линтера, для командной строки и MCP. */
export const CODES = Object.freeze({
  clean: 0,
  findings: 1,
  compile: 2,
  refused: 3,
  timeout: 4,
  request: 5,
  panel: 6,
  failure: 7,
});

const VERSION_FILE = "ProjectSettings/ProjectVersion.txt";

/** Проект не найден, или ключ указывает не на проект: это плохой запрос (код 5), а не сбой. */
export class ProjectNotFound extends Error {}

/**
 * Проект Unity, с которым работает инструмент: ключ (--проект у командной строки, поле project у shoot, lint и MCP) →
 * переменная UIEYE_PROJECT → поиск вверх от текущей папки до ProjectSettings/ProjectVersion.txt.
 *
 * Ключ и переменная обязаны указывать на проект: иначе отказ, а не поиск дальше — опечатка в пути не должна тихо
 * увести снимок в соседний проект.
 *
 * @param {string | undefined | null} explicit
 * @returns {{ root: string, how: string }}
 */
export function findProject(explicit) {
  if (explicit !== undefined && explicit !== null) {
    if (typeof explicit !== "string" || explicit.trim() === "") {
      throw new ProjectNotFound("проект (--проект, поле project) — путь к папке проекта Unity, а не пустое место");
    }

    return checked(resolve(explicit.trim()), "ключ --проект (поле project)");
  }

  if (process.env.UIEYE_PROJECT) {
    return checked(resolve(process.env.UIEYE_PROJECT), "переменная UIEYE_PROJECT");
  }

  const start = resolve(process.cwd());
  for (let dir = start; ; dir = dirname(dir)) {
    if (isProject(dir)) {
      return { root: dir, how: `поиск вверх от ${start}` };
    }

    if (dirname(dir) === dir) {
      break;
    }
  }

  throw new ProjectNotFound(
    `проект Unity не найден: нет ключа --проект (поля project), нет переменной UIEYE_PROJECT, и ни в ${start}, ни выше нет ${VERSION_FILE}`,
  );
}

function checked(root, how) {
  if (!isProject(root)) {
    throw new ProjectNotFound(`${how}: ${root} — не проект Unity (нет ${VERSION_FILE})`);
  }

  return { root, how };
}

function isProject(dir) {
  return statSync(join(dir, ...VERSION_FILE.split("/")), { throwIfNoEntry: false })?.isFile() === true;
}

/**
 * Пакет ui-eye, который компилирует Unity этого проекта: встроенный Packages/<имя> → зависимость file: в
 * Packages/manifest.json (путь — от папки Packages) → иначе папка самого инструмента, и в remark — почему. Unity видит
 * файлы пакета под путями Packages/<имя>/…; так их зовут линтер и подпись снимка.
 *
 * @returns {{ name: string | null, dir: string | null, how: string, remark: string }} dir null — у пакета нет имени.
 */
export function findPackage(root) {
  const name = readJson(join(PACKAGE, "package.json"))?.name;

  if (typeof name !== "string" || name === "") {
    return { name: null, dir: null, how: "", remark: `в ${join(PACKAGE, "package.json")} нет имени пакета` };
  }

  const packages = join(root, "Packages");
  const isPackage = (dir) => readJson(join(dir, "package.json"))?.name === name;
  const manifest = readJson(join(packages, "manifest.json"));
  const dependency = manifest?.dependencies?.[name];
  const local = typeof dependency === "string" && dependency.startsWith("file:") ? resolve(packages, dependency.slice(5)) : null;

  if (isPackage(join(packages, name))) {
    const both = dependency === undefined ? "" : `пакет и встроен, и указан в manifest.json («${dependency}»): читается встроенный`;
    return { name, dir: join(packages, name), how: `встроенный, Packages/${name}`, remark: both };
  }

  if (local !== null && isPackage(local)) {
    return { name, dir: local, how: `manifest.json, «${dependency}»`, remark: "" };
  }

  const why =
    manifest === null
      ? "нет Packages/manifest.json или он не разобран"
      : dependency === undefined
        ? `в Packages/manifest.json нет ${name}`
        : local === null
          ? `${name} подключён не через file: («${dependency}») — Unity может компилировать другую версию`
          : `по «${dependency}» нет package.json пакета ${name}`;
  return { name, dir: PACKAGE, how: "папка инструмента", remark: why };
}

/** git от папки: проект или пакет не обязан лежать в корне репозитория. null — не git или git упал. */
export function git(dir, args) {
  const done = spawnSync("git", ["--literal-pathspecs", "-C", dir, "-c", "core.quotepath=off", ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  return done.status === 0 ? done.stdout : null;
}

/**
 * Какие файлы расходятся с HEAD своего репозитория: путь, как его видит Unity → «??» не добавлен, «M» изменён (и прочие
 * буквы git). Packages/<имя пакета>/… — от репозитория пакета, прочее — от репозитория проекта. Не git — пометок нет.
 */
export function markUncommitted(root, pkg, paths) {
  const top = pkg.dir === null ? null : `Packages/${pkg.name}/`;
  const own = top === null ? [] : paths.filter((path) => path.startsWith(top));
  const marks = gitMarks(root, paths.filter((path) => top === null || !path.startsWith(top)));

  for (const [path, mark] of Object.entries(gitMarks(pkg.dir, own.map((path) => path.slice(top.length))))) {
    marks[top + path] = mark;
  }

  return marks;
}

// git печатает пути от корня репозитория, а спрашиваем от папки: приставку папки (rev-parse --show-prefix) снимаем —
// иначе у проекта в подпапке репозитория пометки молча терялись бы.
function gitMarks(dir, paths) {
  if (paths.length === 0) {
    return {};
  }

  const prefix = git(dir, ["rev-parse", "--show-prefix"]);
  const out = prefix === null ? null : git(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...paths]);
  const marks = {};

  if (out === null) {
    return marks;
  }

  const base = prefix.trim();
  const records = out.split("\0");

  for (let index = 0; index < records.length; index++) {
    const record = records[index];

    if (record.length < 4) {
      continue;
    }

    const status = record.slice(0, 2);
    const path = record.slice(3);

    // У переименования и копии за новым путём идёт прежний — отдельной записью.
    if (/[RC]/.test(status)) {
      index++;
    }

    if (path.startsWith(base)) {
      marks[path.slice(base.length)] = status.trim();
    }
  }

  return marks;
}

function readJson(path) {
  try {
    const text = readFileSync(path, "utf8");
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return null;
  }
}
