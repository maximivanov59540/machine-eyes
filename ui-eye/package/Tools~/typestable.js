/**
 * ui-eye — таблица типов UI Toolkit: где она лежит у проекта, сходится ли сама с собой, её ровный вид, разница с прежней
 * и запись в проект. Снимает таблицу Unity — попутно каждым снимком (runner.js) и явно (types.js); читает линтер.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Путь от корня проекта: таблица снята с Unity этого проекта и принадлежит ему, а не инструменту. */
export const TYPES_TABLE = "UserSettings/ui-eye/uitk-types.json";

/**
 * Годную таблицу — в проект, ровным видом. Файл уже побайтно такой — не переписывать; always — писать всё равно (явный
 * пересъём). Сверку с собой делает вызывающий. → { path, normalized, same, difference }
 */
export function storeTable(root, table, { always = false } = {}) {
  const path = join(root, ...TYPES_TABLE.split("/"));
  const normalized = normalizeTable(table);
  const text = JSON.stringify(normalized, null, 2) + "\n";
  let previous = null;

  try {
    previous = readFileSync(path, "utf8");
  } catch {
    previous = null;
  }

  const same = previous === text;

  if (!same || always) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, "utf8");
  }

  return { path, normalized, same, difference: tableDifference(parsed(previous), normalized) };
}

function parsed(text) {
  try {
    return text === null ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

const VISUAL_ELEMENT = "UnityEngine.UIElements.VisualElement";

/** Таблица обязана сходиться сама с собой: иначе линтер судил бы по сломанному прибору. */
export function validateTable(table) {
  const problems = [];

  if (typeof table?.unityVersion !== "string" || table.unityVersion === "") {
    problems.push("нет версии Unity");
  }

  if (!Array.isArray(table?.types) || table.types.length === 0) {
    problems.push("список типов пуст");
    return problems;
  }

  const names = new Set();

  for (const type of table.types) {
    if (typeof type?.name !== "string" || type.name === "") {
      problems.push("тип без имени");
      continue;
    }

    if (names.has(type.name)) {
      problems.push(`тип дважды: ${type.name}`);
    }

    names.add(type.name);

    if (!Array.isArray(type.bases)) {
      problems.push(`${type.name}: нет списка предков`);
      continue;
    }

    // У самого VisualElement предки — не элементы (Focusable, CallbackEventHandler); у остальных цепочка кончается им.
    if (type.name !== VISUAL_ELEMENT && type.bases[type.bases.length - 1] !== VISUAL_ELEMENT) {
      problems.push(`${type.name}: цепочка предков не кончается на VisualElement — [${type.bases.join(", ")}]`);
    }
  }

  if (!names.has(VISUAL_ELEMENT)) {
    problems.push("в таблице нет самого VisualElement");
  }

  return problems.slice(0, 20);
}

/** Ровный вид: у каждого типа все поля, типы — по имени; разница с прежней — тогда разница типов, а не записи. */
export function normalizeTable(table) {
  const types = table.types
    .map((type) => ({
      name: type.name,
      bases: type.bases,
      uxmlName: type.uxmlName ?? "",
      legacyFactory: Boolean(type.legacyFactory),
      isAbstract: Boolean(type.isAbstract),
      isGeneric: Boolean(type.isGeneric),
      editorOnly: Boolean(type.editorOnly),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return { unityVersion: table.unityVersion, types };
}

/** Разница с прежней таблицей строками: сколько добавлено, убрано, изменено — и первые имена. */
export function tableDifference(before, after) {
  if (!before?.types) {
    return ["прежней таблицы не было"];
  }

  const index = (table) => new Map(table.types.map((type) => [type.name, JSON.stringify(type)]));
  const was = index(before);
  const now = index(after);
  const added = [...now.keys()].filter((name) => !was.has(name));
  const removed = [...was.keys()].filter((name) => !now.has(name));
  const changed = [...now.keys()].filter((name) => was.has(name) && was.get(name) !== now.get(name));
  const lines = [
    `против прежней (Unity ${before.unityVersion}): добавлено ${added.length}, убрано ${removed.length}, изменено ${changed.length}`,
  ];

  for (const [label, list] of [
    ["добавлено", added],
    ["убрано", removed],
    ["изменено", changed],
  ]) {
    if (list.length > 0) {
      lines.push(`${label}: ${list.slice(0, 12).join(", ")}${list.length > 12 ? " …" : ""}`);
    }
  }

  return lines;
}
