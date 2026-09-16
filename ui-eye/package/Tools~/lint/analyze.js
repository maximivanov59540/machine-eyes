/**
 * Анализ кода для линтера ui-eye: где код обращается к разметке по имени и с какой разметкой это сверять.
 *
 * Корни — вызовы UI Toolkit: Q/Query и шаги их цепочки (Name, Class, OfType, Children, Descendents) — только в файлах, где
 * виден UnityEngine.UIElements (иначе расширения не вызвать), — и добавление класса (AddToClassList и соседи).
 * Помощники выводятся: метод, чей параметр уходит в корень, сам становится «стоком», и его вызовы — тоже обращения
 * (так UiEyeFill.Text виден без списка имён). Пары с разметкой — через реестр ui-eye: обращения внутри new UiEyePanel(…),
 * в методах своего типа, названных там, и в типах, на которые оттуда ссылаются (new X, X.), — до четырёх шагов.
 *
 * Не компилятор: вызов через переменную признаётся вызовом помощника, только если файл называет тип помощника
 * (расширение — если виден его namespace). Похожие, но не признанные вызовы возвращаются списком unresolved, не молча.
 */

import { lex } from "./cslex.js";
import { parseCSharp } from "./csparse.js";

const UI_NAMESPACE = "UnityEngine.UIElements";
const LOOKUPS = new Set(["Q", "Query"]);
const CHAIN_LOOKUPS = new Set(["OfType", "Children", "Descendents"]);
const CHAIN_FILTERS = new Set(["Name", "Class"]);
const CHAIN_PASS = new Set(
  "Where Active NotActive Visible NotVisible Checked NotChecked Enabled NotEnabled Focused NotFocused Hovered NotHovered Selected NotSelected SingleBaseType".split(" "),
);
const CLASS_ADDERS = new Set(["AddToClassList", "EnableInClassList", "ToggleInClassList"]);
const REGISTRY_TYPES = new Set(["UiEyePanel", "UiEyeState"]);
const NOT_NAMES = new Set(["null", "true", "false", "this", "base", "default"]);
const NOT_DECLARATORS = new Set("return new in case is as await yield throw else out ref goto when and or not nameof typeof sizeof default".split(" "));
const CAST_WORDS = new Set(["typeof", "default", "nameof", "sizeof"]);
const SPACED = new Set(["+", "-", "*", "/", "%", "?", ":", "??", "==", "!=", "=>", "&&", "||", "="]);
const NO = { ok: false };
const MAX_ROUNDS = 12;
const MAX_REACH = 4;

/**
 * @param {{ path: string, text: string, assembly: string }[]} files
 * @param {{ isElementType?: (name: string, models: object[]) => boolean }} options — элемент ли тип с таким именем
 *   (для where T : …); models — разобранные файлы, чтобы свои элементы узнавались по цепочке предков
 * @returns {{ models, uses, sinks, registry, unresolved, converged: boolean }}
 */
export function analyzeCode(files, options = {}) {
  const elementPredicate = options.isElementType ?? ((name) => name === "VisualElement" || name === "UnityEngine.UIElements.VisualElement");
  const models = files.map((file, fileIndex) => {
    const lexed = lex(file.text);
    const parsed = parseCSharp(lexed.tokens);
    const idents = new Set(lexed.tokens.filter((token) => token.kind === "id").map((token) => token.text));
    return { ...file, fileIndex, parsed, idents, problems: [...lexed.problems, ...parsed.problems] };
  });

  const isElementType = (name) => elementPredicate(name, models);
  markNamespaces(models);
  const context = { models, typesByName: indexTypes(models) };
  const roots = rootUses(models);
  const sinks = new Map();
  let uses = roots;
  let converged = false;

  for (let round = 0; round < MAX_ROUNDS && !converged; round++) {
    uses = dedupe([...roots, ...sinkCallUses(context, sinks)]);
    converged = !growSinks(context, uses, sinks, isElementType);
  }

  classify(context, uses, sinks);
  const registry = findRegistry(context);
  pair(context, uses, registry);

  return { models, uses, sinks: describeSinks(context, sinks), registry, unresolved: unresolvedCalls(context, sinks, uses), converged };
}

/** Какие пространства имён файл видит: using (и global using своей сборки) и собственные namespace с предками. */
function markNamespaces(models) {
  const globals = new Map();

  for (const model of models) {
    for (const using of model.parsed.usings) {
      if (using.global && !using.isStatic && !using.alias) {
        if (!globals.has(model.assembly)) {
          globals.set(model.assembly, new Set());
        }

        globals.get(model.assembly).add(using.name);
      }
    }
  }

  for (const model of models) {
    const { usings, namespaces } = model.parsed;
    const plain = usings.filter((using) => !using.isStatic && !using.alias).map((using) => using.name);
    model.opened = new Set([...(globals.get(model.assembly) ?? []), ...plain]);
    model.enclosing = new Set();

    for (const space of namespaces) {
      const parts = namespaces.filter((outer) => outer.start <= space.start && space.end <= outer.end).flatMap((outer) => outer.name.split("."));

      for (let count = 1; count <= parts.length; count++) {
        model.enclosing.add(parts.slice(0, count).join("."));
      }
    }

    model.importsUi = sees(model, UI_NAMESPACE);
  }
}

function sees(model, namespace) {
  return namespace === "" || model.opened.has(namespace) || model.enclosing.has(namespace);
}

function indexTypes(models) {
  const index = new Map();

  for (const model of models) {
    model.parsed.types.forEach((type, typeIndex) => {
      if (!index.has(type.name)) {
        index.set(type.name, []);
      }

      index.get(type.name).push({ fileIndex: model.fileIndex, typeIndex });
    });
  }

  return index;
}

/** Прямые вызовы UI Toolkit. */
function rootUses(models) {
  const uses = [];

  for (const model of models) {
    const { calls, partner, tokens } = model.parsed;
    const byOpen = new Map(calls.map((call, callIndex) => [call.open, callIndex]));

    // Предыдущий шаг цепочки: …Query(…).Name(…) — перед именем точка, перед точкой закрытая скобка вызова.
    const previous = (call) => {
      const dot = tokens[call.nameIndex - 1]?.text;
      if ((dot !== "." && dot !== "?.") || tokens[call.nameIndex - 2]?.text !== ")") {
        return null;
      }

      const index = byOpen.get(partner[call.nameIndex - 2]);
      return index === undefined ? null : calls[index];
    };

    calls.forEach((call, callIndex) => {
      if (call.isNew || !call.args) {
        return;
      }

      const push = (argIndex, role, type, single, via) => uses.push({ fileIndex: model.fileIndex, callIndex, argIndex, role, type, single, via: [via] });

      if (CLASS_ADDERS.has(call.name)) {
        const argIndex = argumentAt(call, 0, "className");
        if (argIndex >= 0) {
          push(argIndex, "add-class", null, false, display(call));
        }

        return;
      }

      if (LOOKUPS.has(call.name)) {
        if (call.receiver && (model.importsUi || call.qualifier === "UQueryExtensions")) {
          const type = call.genericArgs[0] ?? "VisualElement";
          const shift = call.qualifier === "UQueryExtensions" ? 1 : 0;
          lookupArguments(call, shift, (argIndex, role) => push(argIndex, role, type, call.name === "Q", display(call)));
        }

        return;
      }

      if (!model.importsUi || !(CHAIN_FILTERS.has(call.name) || CHAIN_LOOKUPS.has(call.name))) {
        return;
      }

      let type = CHAIN_LOOKUPS.has(call.name) ? (call.genericArgs[0] ?? "VisualElement") : null;
      let head = null;

      for (let step = previous(call), guard = 0; step && guard < 32; step = previous(step), guard++) {
        if (step.name === "Query") {
          head = step;
          break;
        }

        if (!CHAIN_FILTERS.has(step.name) && !CHAIN_LOOKUPS.has(step.name) && !CHAIN_PASS.has(step.name)) {
          break;
        }

        if (type === null && CHAIN_LOOKUPS.has(step.name)) {
          type = step.genericArgs[0] ?? "VisualElement";
        }
      }

      if (!head?.receiver) {
        return;
      }

      type ??= head.genericArgs[0] ?? "VisualElement";
      const via = `${display(head)}(…).${display({ ...call, qualifier: null, receiver: false })}`;

      if (CHAIN_FILTERS.has(call.name)) {
        if (call.args.length >= 1 && call.args[0].label === null) {
          push(0, call.name === "Name" ? "name" : "class", type, false, via);
        }
      } else {
        lookupArguments(call, 0, (argIndex, role) => push(argIndex, role, type, false, via));
      }
    });
  }

  return uses;
}

/** Аргументы поиска: (name, className) и (name, params classes); shift 1 — статический вызов с элементом первым. */
function lookupArguments(call, shift, add) {
  call.args.forEach((arg, argIndex) => {
    const position = argIndex - shift;
    const role =
      arg.label === "name"
        ? "name"
        : arg.label === "className" || arg.label === "classes"
          ? "class"
          : arg.label === null && position === 0
            ? "name"
            : arg.label === null && position > 0
              ? "class"
              : null;

    if (role) {
      add(argIndex, role);
    }
  });
}

/** Параметр, переданный в обращение, делает метод стоком. true — стоков прибавилось. */
function growSinks(context, uses, sinks, isElementType) {
  let grown = false;

  for (const use of uses) {
    const model = context.models[use.fileIndex];
    const call = model.parsed.calls[use.callIndex];
    const owner = parameterOwner(model, call.methodIndex, bareIdentifier(model, call.args[use.argIndex]));

    if (!owner) {
      continue;
    }

    const method = model.parsed.methods[owner.methodIndex];
    const key = `${use.fileIndex}:${owner.methodIndex}`;
    const slots = sinks.get(key) ?? new Map();
    const slotKey = `${owner.paramIndex}:${use.role}`;

    if (slots.has(slotKey)) {
      continue;
    }

    let genericIndex = use.type === null ? -1 : method.typeParams.indexOf(use.type);

    // Нетипизированный Q(name) внутри Find<T>(…) where T : VisualElement, который приводит к T, ждёт элемент типа T.
    if (genericIndex < 0 && use.type === "VisualElement") {
      genericIndex = method.typeParams.findIndex(
        (param) => (method.constraints[param] ?? []).some(isElementType) && castsTo(model, method, param),
      );
    }

    slots.set(slotKey, { paramIndex: owner.paramIndex, role: use.role, type: use.type, genericIndex, single: use.single, via: use.via });
    sinks.set(key, slots);
    grown = true;
  }

  return grown;
}

/** Чей это параметр: ближайший метод (или внешний для локальной функции), где имя — параметр, а не локальная переменная. */
function parameterOwner(model, methodIndex, name) {
  if (name === null) {
    return null;
  }

  for (let index = methodIndex; index >= 0; index = model.parsed.methods[index].outer) {
    const method = model.parsed.methods[index];
    const paramIndex = method.params.findIndex((param) => param.name === name);

    if (paramIndex >= 0) {
      return { methodIndex: index, paramIndex };
    }

    if (declaresLocal(model, method, name)) {
      return null;
    }
  }

  return null;
}

/** Объявлено ли имя в теле метода локальной переменной или параметром лямбды — грубо, по соседним токенам. */
function declaresLocal(model, method, name) {
  const { tokens } = model.parsed;

  for (let index = method.bodyStart + 1; index < method.bodyEnd; index++) {
    const token = tokens[index];
    if (token.kind !== "id" || token.text !== name) {
      continue;
    }

    const before = tokens[index - 1];
    const after = tokens[index + 1]?.text;

    if (after === "=>") {
      return true;
    }

    const typed =
      (before.kind === "id" && !NOT_DECLARATORS.has(before.text)) ||
      (before.kind === "punct" && (before.text === ">" || before.text === "]" || before.text === "?"));

    if (typed && (after === "=" || after === ";" || after === "," || after === ")" || after === "in")) {
      return true;
    }
  }

  return false;
}

/** Приводит ли метод что-то к своему параметру-типу: as T, is T, (T)x. */
function castsTo(model, method, param) {
  const { tokens } = model.parsed;

  for (let index = method.bodyStart + 1; index < method.bodyEnd; index++) {
    if (tokens[index].kind !== "id" || tokens[index].text !== param) {
      continue;
    }

    const before = tokens[index - 1];

    if (before.kind === "id" && (before.text === "as" || before.text === "is")) {
      return true;
    }

    if (before.text === "(" && tokens[index + 1]?.text === ")" && !CAST_WORDS.has(tokens[index - 2]?.text)) {
      return true;
    }
  }

  return false;
}

/** Вызовы стоков — тоже обращения: аргумент на месте «именного» параметра. */
function sinkCallUses(context, sinks) {
  const uses = [];

  for (const sink of sinkList(context, sinks)) {
    for (const caller of context.models) {
      caller.parsed.calls.forEach((call, callIndex) => {
        const shift = resolveCall(context, caller, call, sink);
        if (shift < 0) {
          return;
        }

        for (const slot of sink.slots.values()) {
          const argIndex = argumentFor(call, sink.method, slot.paramIndex, shift);
          if (argIndex < 0) {
            continue;
          }

          uses.push({
            fileIndex: caller.fileIndex,
            callIndex,
            argIndex,
            role: slot.role,
            type: slot.genericIndex >= 0 ? (call.genericArgs[slot.genericIndex] ?? null) : slot.type,
            single: slot.single,
            via: [display(call), ...slot.via],
          });
        }
      });
    }
  }

  return uses;
}

/** Вызов ли это стока: -1 — нет, иначе сдвиг аргументов (1 — расширение, вызванное через получателя). */
function resolveCall(context, caller, call, sink) {
  const { model, method, owner, extension } = sink;

  if (!call.args) {
    return -1;
  }

  if (method.isConstructor) {
    return call.isNew && (call.typeName ?? "").split(".").pop() === owner?.name && arityFits(call, method, 0) ? 0 : -1;
  }

  if (call.isNew || call.name !== method.name) {
    return -1;
  }

  const qualifier = call.qualifier;
  let shift = 0;

  if (qualifier !== null && qualifier !== "this" && qualifier !== "base" && context.typesByName.has(qualifier)) {
    if (qualifier !== owner?.name) {
      return -1;
    }
  } else if (call.receiver && qualifier !== "this") {
    if (extension) {
      if (!sees(caller, owner?.namespace ?? "")) {
        return -1;
      }

      shift = 1;
    } else if (!owner || !caller.idents.has(owner.name)) {
      return -1;
    }
  } else if (!inScope(caller, call, model, method, owner)) {
    return -1;
  }

  return arityFits(call, method, shift) ? shift : -1;
}

/** Вызов без квалификатора видит метод: изнутри его типа (и вложенных) или из наследника. */
function inScope(caller, call, model, method, owner) {
  if (caller.fileIndex === model.fileIndex && insideType(caller, call.typeIndex, method.typeIndex)) {
    return true;
  }

  for (let type = call.typeIndex; type >= 0 && owner; type = caller.parsed.types[type].outer) {
    if (caller.parsed.types[type].bases.some((base) => base.replace(/<.*$/, "").split(".").pop() === owner.name)) {
      return true;
    }
  }

  return false;
}

function arityFits(call, method, shift) {
  const provided = call.args.length + shift;
  const required = method.params.filter((param) => !param.hasDefault && !param.isParams).length;
  const variadic = method.params.some((param) => param.isParams);
  return provided >= required && (variadic || provided <= method.params.length);
}

/** Какой аргумент вызова стоит на месте параметра: по метке, иначе по позиции. -1 — такого нет. */
function argumentFor(call, method, paramIndex, shift) {
  const param = method.params[paramIndex];
  const named = call.args.findIndex((arg) => arg.label === param.name);

  if (named >= 0) {
    return named;
  }

  const position = paramIndex - shift;
  return position >= 0 && position < call.args.length && call.args[position].label === null ? position : -1;
}

function argumentAt(call, position, label) {
  const named = call.args.findIndex((arg) => arg.label === label);

  if (named >= 0) {
    return named;
  }

  return position < call.args.length && call.args[position].label === null ? position : -1;
}

function classify(context, uses, sinks) {
  for (const use of uses) {
    const model = context.models[use.fileIndex];
    const call = model.parsed.calls[use.callIndex];
    const arg = call.args[use.argIndex];
    use.file = model.path;
    use.assembly = model.assembly;
    use.line = call.line;
    use.call = use.via.join(" → ");
    use.argText = argumentText(model, arg);

    const owner = parameterOwner(model, call.methodIndex, bareIdentifier(model, arg));

    if (owner && sinks.get(`${use.fileIndex}:${owner.methodIndex}`)?.has(`${owner.paramIndex}:${use.role}`)) {
      use.status = "forwarded";
      continue;
    }

    const value = evaluate(context, model, arg.start, arg.end, { typeIndex: call.typeIndex, methodIndex: call.methodIndex }, 0);

    if (value.ok && value.value === null) {
      use.status = "null";
    } else if (value.ok && typeof value.value === "string") {
      use.status = "literal";
      use.value = value.value;
    } else {
      use.status = "computed";
    }
  }
}

/** Значение выражения, если оно известно без запуска: литерал, null, константа, nameof, сцепление через +. */
function evaluate(context, model, start, end, scope, depth) {
  const { tokens, partner } = model.parsed;

  if (depth > 8 || end <= start) {
    return NO;
  }

  const first = tokens[start];

  if (end - start === 1) {
    if (first.kind === "str") {
      return { ok: true, value: first.value };
    }

    if (first.kind === "id" && first.text === "null") {
      return { ok: true, value: null };
    }

    return first.kind === "id" ? constant(context, model, first.text, scope, depth) : NO;
  }

  if (first.kind === "punct" && first.text === "(" && partner[start] === end - 1) {
    return evaluate(context, model, start + 1, end - 1, scope, depth + 1);
  }

  if (first.kind === "id" && first.text === "nameof" && tokens[start + 1]?.text === "(" && partner[start + 1] === end - 1) {
    const names = tokens.slice(start + 2, end - 1).filter((token) => token.kind === "id");
    return names.length > 0 ? { ok: true, value: names[names.length - 1].text } : NO;
  }

  if (end - start === 3 && first.kind === "id" && tokens[start + 1].text === "." && tokens[start + 2].kind === "id") {
    if ((first.text === "string" || first.text === "String") && tokens[start + 2].text === "Empty") {
      return { ok: true, value: "" };
    }

    for (const ref of context.typesByName.get(first.text) ?? []) {
      const value = constantOfType(context, context.models[ref.fileIndex], ref.typeIndex, tokens[start + 2].text, depth);
      if (value.ok) {
        return value;
      }
    }

    return NO;
  }

  const parts = [];
  let from = start;

  for (let index = start; index < end; index++) {
    const token = tokens[index];

    if (token.kind === "punct" && (token.text === "(" || token.text === "[" || token.text === "{") && partner[index] > index) {
      index = partner[index];
    } else if (token.kind === "punct" && token.text === "+") {
      parts.push([from, index]);
      from = index + 1;
    }
  }

  if (parts.length === 0) {
    return NO;
  }

  parts.push([from, end]);
  let text = "";

  for (const [a, b] of parts) {
    const value = evaluate(context, model, a, b, scope, depth + 1);

    if (!value.ok || typeof value.value !== "string") {
      return NO;
    }

    text += value.value;
  }

  return { ok: true, value: text };
}

/** Константа по простому имени: локальная const, затем члены типа и внешних типов; параметр или локальная переменная её заслоняют. */
function constant(context, model, name, scope, depth) {
  const { consts, methods, types } = model.parsed;

  for (let index = scope.methodIndex; index >= 0; index = methods[index].outer) {
    const local = consts.find((item) => item.methodIndex === index && item.isConst && item.name === name);

    if (local) {
      return evaluate(context, model, local.start, local.end, { typeIndex: scope.typeIndex, methodIndex: index }, depth + 1);
    }

    if (methods[index].params.some((param) => param.name === name) || declaresLocal(model, methods[index], name)) {
      return NO;
    }
  }

  for (let type = scope.typeIndex; type >= 0; type = types[type].outer) {
    const value = constantOfType(context, model, type, name, depth);
    if (value.ok) {
      return value;
    }
  }

  return NO;
}

function constantOfType(context, model, typeIndex, name, depth) {
  const item = model.parsed.consts.find((candidate) => candidate.typeIndex === typeIndex && candidate.methodIndex < 0 && candidate.name === name);
  return item ? evaluate(context, model, item.start, item.end, { typeIndex, methodIndex: -1 }, depth + 1) : NO;
}

/** Реестр ui-eye: каждое new UiEyePanel(name, description, markup, states…) с известными (или нет) именем и путём. */
function findRegistry(context) {
  const registry = [];

  for (const model of context.models) {
    model.parsed.calls.forEach((call, callIndex) => {
      if (!call.isNew || !call.args || (call.typeName ?? "").split(".").pop() !== "UiEyePanel") {
        return;
      }

      const scope = { typeIndex: call.typeIndex, methodIndex: call.methodIndex };
      const read = (position, label) => {
        const index = argumentAt(call, position, label);

        if (index < 0) {
          return { value: null, text: "" };
        }

        const arg = call.args[index];
        const value = evaluate(context, model, arg.start, arg.end, scope, 0);
        return { value: value.ok && typeof value.value === "string" ? value.value : null, text: argumentText(model, arg) };
      };

      const panel = read(0, "name");
      const markup = read(2, "markup");

      registry.push({
        fileIndex: model.fileIndex,
        callIndex,
        file: model.path,
        line: call.line,
        open: call.open,
        close: call.close,
        panel: panel.value,
        panelText: panel.text,
        markup: markup.value,
        markupText: markup.text,
      });
    });
  }

  return registry;
}

/** Какие обращения с какой панелью реестра сверять. */
function pair(context, uses, registry) {
  for (const entry of registry) {
    const model = context.models[entry.fileIndex];
    const own = new Set();

    for (let type = model.parsed.calls[entry.callIndex].typeIndex; type >= 0; type = model.parsed.types[type].outer) {
      own.add(type);
    }

    const types = new Set();
    const methods = new Set();
    let frontier = [{ model, from: entry.open, to: entry.close, own: true }];

    for (let step = 0; step < MAX_REACH && frontier.length > 0; step++) {
      const next = [];

      for (const span of frontier) {
        for (const ref of typeReferences(context, span.model, span.from, span.to)) {
          const key = `${ref.fileIndex}:${ref.typeIndex}`;

          if (types.has(key) || (ref.fileIndex === entry.fileIndex && own.has(ref.typeIndex))) {
            continue;
          }

          types.add(key);
          const holder = context.models[ref.fileIndex];
          const type = holder.parsed.types[ref.typeIndex];
          next.push({ model: holder, from: type.start, to: type.end, own: false });
        }

        // Метод своего типа, названный по имени (состояние = FillShort рядом с методом панели), — тоже код этой панели.
        if (span.own) {
          for (const methodIndex of ownMethodReferences(model, span.from, span.to, own)) {
            if (!methods.has(methodIndex)) {
              methods.add(methodIndex);
              const method = model.parsed.methods[methodIndex];
              next.push({ model, from: method.nameIndex, to: method.bodyEnd, own: true });
            }
          }
        }
      }

      frontier = next;
    }

    entry.reachedTypes = types;
    entry.reachedMethods = methods;
    entry.reach = [
      ...[...types].map((key) => {
        const [fileIndex, typeIndex] = key.split(":").map(Number);
        return context.models[fileIndex].parsed.types[typeIndex].fullName;
      }),
      ...[...methods].map((methodIndex) => {
        const method = model.parsed.methods[methodIndex];
        return `${model.parsed.types[method.typeIndex]?.name ?? ""}.${method.name}()`;
      }),
    ];
  }

  for (const use of uses) {
    const model = context.models[use.fileIndex];
    const call = model.parsed.calls[use.callIndex];
    use.entries = [];

    registry.forEach((entry, entryIndex) => {
      let hit = use.fileIndex === entry.fileIndex && call.nameIndex > entry.open && call.nameIndex < entry.close;

      for (let type = call.typeIndex; type >= 0 && !hit; type = model.parsed.types[type].outer) {
        hit = entry.reachedTypes.has(`${use.fileIndex}:${type}`);
      }

      for (let method = call.methodIndex; use.fileIndex === entry.fileIndex && method >= 0 && !hit; method = model.parsed.methods[method].outer) {
        hit = entry.reachedMethods.has(method);
      }

      if (hit) {
        use.entries.push(entryIndex);
      }
    });
  }
}

/** Типы из сканируемого кода, на которые ссылается отрезок: new X(…) / new A.X(…) и X.член. */
function typeReferences(context, model, from, to) {
  const found = [];
  const { tokens } = model.parsed;

  for (let index = from + 1; index < to; index++) {
    const token = tokens[index];

    if (token.kind !== "id" || !context.typesByName.has(token.text) || REGISTRY_TYPES.has(token.text)) {
      continue;
    }

    let head = index;
    while (tokens[head - 1]?.text === "." && tokens[head - 2]?.kind === "id") {
      head -= 2;
    }

    const created = tokens[head - 1]?.kind === "id" && tokens[head - 1].text === "new";
    const member = tokens[index + 1]?.text === "." && head === index;

    if (created || member) {
      found.push(...context.typesByName.get(token.text));
    }
  }

  return found;
}

/** Методы своих типов, названные в отрезке простым именем (или через this.). */
function ownMethodReferences(model, from, to, own) {
  const { tokens, methods } = model.parsed;
  const found = [];

  for (let index = from + 1; index < to; index++) {
    const token = tokens[index];
    const before = tokens[index - 1]?.text;

    if (token.kind !== "id" || ((before === "." || before === "?.") && tokens[index - 2]?.text !== "this")) {
      continue;
    }

    methods.forEach((method, methodIndex) => {
      if (method.name === token.text && !method.isConstructor && own.has(method.typeIndex) && method.nameIndex !== index) {
        found.push(methodIndex);
      }
    });
  }

  return found;
}

/** Вызовы, похожие на вызов стока (имя, число аргументов, строка на месте именного параметра), но не признанные. */
function unresolvedCalls(context, sinks, uses) {
  const seen = new Set(uses.map((use) => `${use.fileIndex}:${use.callIndex}`));
  const byName = new Map();

  for (const sink of sinkList(context, sinks)) {
    const name = sink.method.isConstructor ? sink.owner?.name : sink.method.name;

    if (!byName.has(name)) {
      byName.set(name, []);
    }

    byName.get(name).push(sink);
  }

  const list = [];

  for (const model of context.models) {
    model.parsed.calls.forEach((call, callIndex) => {
      const candidates = call.args && !seen.has(`${model.fileIndex}:${callIndex}`) ? byName.get(call.name) : undefined;

      if (!candidates) {
        return;
      }

      if (call.qualifier !== null && context.typesByName.has(call.qualifier) && !candidates.some((sink) => sink.owner?.name === call.qualifier)) {
        return;
      }

      if (!call.receiver && !call.isNew && model.parsed.methods.some((method) => method.name === call.name && insideType(model, call.typeIndex, method.typeIndex))) {
        return;
      }

      const looksLike = candidates.some((sink) =>
        [0, 1].some(
          (shift) =>
            (shift === 0 || sink.extension) &&
            arityFits(call, sink.method, shift) &&
            [...sink.slots.values()].some((slot) => {
              const argIndex = argumentFor(call, sink.method, slot.paramIndex, shift);
              return argIndex >= 0 && isStringLiteral(model, call.args[argIndex]);
            }),
        ),
      );

      if (looksLike) {
        list.push({
          file: model.path,
          line: call.line,
          call: display(call),
          sinks: candidates.map((sink) => `${sink.owner ? sink.owner.name + "." : ""}${sink.method.name}`),
        });
      }
    });
  }

  return list;
}

function sinkList(context, sinks) {
  return [...sinks].map(([key, slots]) => {
    const [fileIndex, methodIndex] = key.split(":").map(Number);
    const model = context.models[fileIndex];
    const method = model.parsed.methods[methodIndex];
    return { model, method, owner: model.parsed.types[method.typeIndex] ?? null, extension: method.params[0]?.isThis === true, slots };
  });
}

function describeSinks(context, sinks) {
  return sinkList(context, sinks)
    .map((sink) => ({
      method: `${sink.owner ? sink.owner.name + "." : ""}${sink.method.name}`,
      file: sink.model.path,
      line: sink.method.line,
      slots: [...sink.slots.values()].map((slot) => ({
        param: sink.method.params[slot.paramIndex].name,
        role: slot.role,
        type: slot.genericIndex >= 0 ? `<${sink.method.typeParams[slot.genericIndex]}>` : slot.type,
        via: slot.via.join(" → "),
      })),
    }))
    .sort((a, b) => (a.method < b.method ? -1 : a.method > b.method ? 1 : 0));
}

function dedupe(uses) {
  const seen = new Set();
  return uses.filter((use) => {
    const key = `${use.fileIndex}:${use.callIndex}:${use.argIndex}:${use.role}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function insideType(model, typeIndex, target) {
  for (let type = typeIndex; type >= 0; type = model.parsed.types[type].outer) {
    if (type === target) {
      return true;
    }
  }

  return false;
}

function bareIdentifier(model, arg) {
  if (!arg || arg.end - arg.start !== 1) {
    return null;
  }

  const token = model.parsed.tokens[arg.start];
  return token.kind === "id" && !NOT_NAMES.has(token.text) ? token.text : null;
}

function isStringLiteral(model, arg) {
  return arg.end - arg.start === 1 && model.parsed.tokens[arg.start].kind === "str";
}

function display(call) {
  const head = call.isNew ? "new " : call.qualifier !== null ? `${call.qualifier}.` : call.receiver ? "…." : "";
  return `${head}${call.name}${call.genericArgs.length > 0 ? `<${call.genericArgs.join(", ")}>` : ""}`;
}

function argumentText(model, arg) {
  if (!arg) {
    return "";
  }

  let text = "";
  let previous = null;

  for (const token of model.parsed.tokens.slice(arg.start, arg.end)) {
    const shown = token.kind === "str" ? JSON.stringify(token.value) : token.text;
    const spaced =
      previous !== null &&
      ((previous.kind !== "punct" && token.kind !== "punct") || SPACED.has(previous.text) || SPACED.has(token.text));
    text += (spaced ? " " : "") + shown;
    previous = token;
  }

  return text.length > 80 ? text.slice(0, 77) + "…" : text;
}
