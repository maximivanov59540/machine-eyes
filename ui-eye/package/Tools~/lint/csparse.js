/**
 * Лёгкий разбор C# поверх лексера (cslex.js) для линтера ui-eye: using, пространства имён, типы, методы с
 * параметрами, строковые константы, вызовы и создания объектов с аргументами.
 *
 * Не компилятор и не притворяется им: скобки сверяются, а что не легло в разбор, не выдумывается — у вызова
 * просто не будет понятых аргументов, и линтер назовёт такое обращение «не проверено».
 */

const KEYWORDS = new Set(
  (
    "abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum " +
    "event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace " +
    "new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc " +
    "static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while"
  ).split(" "),
);

const TYPE_KEYWORDS = new Set("bool byte char decimal double float int long object sbyte short string uint ulong ushort void dynamic nint nuint".split(" "));

// После этих слов «имя(» — не объявление и не вызов, который нужен линтеру.
const NOT_CALLABLE = new Set(
  [...KEYWORDS].filter((word) => !TYPE_KEYWORDS.has(word)).concat(["nameof", "when", "await", "var", "yield", "global", "where"]),
);

const CTOR_MODIFIERS = new Set(["public", "private", "protected", "internal", "static", "extern", "unsafe"]);
const PARAM_MODIFIERS = new Set(["this", "ref", "out", "in", "params", "scoped", "readonly"]);
const GENERIC_PUNCT = new Set([",", ".", "?", "[", "]", "::", "*"]);
const AFTER_GENERIC = new Set(["(", ")", ".", "[", "{"]);

/**
 * @param {object[]} tokens — из lex()
 * @returns {{ tokens, partner, usings, namespaces, types, methods, consts, calls, problems }}
 */
export function parseCSharp(tokens) {
  const { partner, problems } = matchBrackets(tokens);
  const out = { tokens, partner, usings: [], namespaces: [], types: [], methods: [], consts: [], calls: [], problems };
  const declarationParens = new Set();

  const is = (index, text) => tokens[index]?.kind === "punct" && tokens[index].text === text;
  const isId = (index) => tokens[index]?.kind === "id";
  const word = (index, text) => isId(index) && tokens[index].text === text;
  const opens = (index) => (is(index, "(") || is(index, "[") || is(index, "{")) && partner[index] > index;

  const text = (from, to) => {
    let result = "";
    for (let index = from; index < to; index++) {
      if (result && tokens[index].kind === "id" && tokens[index - 1].kind === "id") {
        result += " ";
      }

      result += tokens[index].text;
    }

    return result;
  };

  const skipGeneric = (index) => {
    let depth = 0;
    for (let at = index; at < tokens.length && at < index + 96; at++) {
      const token = tokens[at];
      if (token.kind === "punct") {
        if (token.text === "<") {
          depth++;
        } else if (token.text === ">") {
          depth--;
          if (depth === 0) {
            return at + 1;
          }
        } else if (!GENERIC_PUNCT.has(token.text)) {
          return -1;
        }
      } else if (token.kind !== "id") {
        return -1;
      }
    }

    return -1;
  };

  const genericBack = (index) => {
    let depth = 0;
    for (let at = index; at >= 0 && at > index - 96; at--) {
      const token = tokens[at];
      if (token.kind === "punct") {
        if (token.text === ">") {
          depth++;
        } else if (token.text === "<") {
          depth--;
          if (depth === 0) {
            return at;
          }
        } else if (!GENERIC_PUNCT.has(token.text)) {
          return -1;
        }
      } else if (token.kind !== "id") {
        return -1;
      }
    }

    return -1;
  };

  const splitTopLevel = (from, to) => {
    const parts = [];
    let start = from;

    for (let index = from; index < to; index++) {
      if (opens(index)) {
        index = partner[index];
        continue;
      }

      if (is(index, "<") && isId(index - 1)) {
        const after = skipGeneric(index);
        if (after > 0 && after <= to && (after === to || AFTER_GENERIC.has(tokens[after]?.text))) {
          index = after - 1;
          continue;
        }
      }

      if (is(index, ",")) {
        parts.push([start, index]);
        start = index + 1;
      }
    }

    if (to > start || parts.length > 0) {
      parts.push([start, to]);
    }

    return parts;
  };

  const statementEnd = (from) => {
    for (let index = from; index < tokens.length; index++) {
      if (opens(index)) {
        index = partner[index];
      } else if (is(index, ";")) {
        return index;
      }
    }

    return tokens.length - 1;
  };

  const parseUsing = (index) => {
    let at = index + 1;
    const isStatic = word(at, "static");
    if (isStatic) {
      at++;
    }

    let alias = null;
    if (isId(at) && is(at + 1, "=")) {
      alias = tokens[at].text;
      at += 2;
    }

    const parts = [];
    while (isId(at) || is(at, ".") || is(at, "::")) {
      parts.push(tokens[at].text);
      at++;
    }

    if (is(at, ";") && parts.length > 0) {
      out.usings.push({ name: parts.join("").replace(/^global::/, ""), global: word(index - 1, "global"), isStatic, alias, line: tokens[index].line });
    }
  };

  const parseNamespace = (index) => {
    const parts = [];
    let at = index + 1;
    while (isId(at) || is(at, ".")) {
      parts.push(tokens[at].text);
      at++;
    }

    if (is(at, "{") && partner[at] > at) {
      out.namespaces.push({ name: parts.join(""), start: at, end: partner[at] });
    } else if (is(at, ";")) {
      out.namespaces.push({ name: parts.join(""), start: at, end: tokens.length - 1 });
    }
  };

  const parseType = (index) => {
    const kind = tokens[index].text;
    let at = index + 1;

    if (kind === "record" && (word(at, "class") || word(at, "struct"))) {
      at++;
    }

    if (is(index - 1, ".") || !isId(at) || KEYWORDS.has(tokens[at].text)) {
      return;
    }

    const name = tokens[at].text;
    const nameIndex = at;
    at++;

    if (is(at, "<")) {
      const after = skipGeneric(at);
      if (after < 0) {
        return;
      }

      at = after;
    }

    if (is(at, "(") && partner[at] > at) {
      declarationParens.add(at);
      at = partner[at] + 1;
    }

    const bases = [];
    if (is(at, ":")) {
      at++;
      let current = [];

      while (at < tokens.length && !is(at, "{") && !is(at, ";") && !word(at, "where")) {
        if (is(at, "(") && partner[at] > at) {
          at = partner[at] + 1;
          continue;
        }

        if (is(at, ",")) {
          bases.push(current.join(""));
          current = [];
        } else {
          current.push(tokens[at].text);
        }

        at++;
      }

      if (current.length > 0) {
        bases.push(current.join(""));
      }
    }

    while (at < tokens.length && !is(at, "{") && !is(at, ";")) {
      at++;
    }

    const end = is(at, "{") && partner[at] > at ? partner[at] : at;
    out.types.push({ kind, name, nameIndex, bases, start: at, end, line: tokens[index].line, outer: -1, namespace: "", fullName: name });
  };

  const parseFields = (index) => {
    const end = statementEnd(index);
    if (!is(end, ";")) {
      return;
    }

    for (const [from, to] of splitTopLevel(index + 1, end)) {
      for (let at = from; at < to; at++) {
        if (opens(at)) {
          at = partner[at];
          continue;
        }

        if (is(at, "=")) {
          if (isId(at - 1)) {
            out.consts.push({ name: tokens[at - 1].text, nameIndex: at - 1, start: at + 1, end: to, line: tokens[at - 1].line, isConst: word(index, "const") });
          }

          break;
        }
      }
    }
  };

  const parseParams = (open, close) => {
    const params = [];
    const add = (from, to) => {
      let at = from;
      if (is(at, "[") && partner[at] > at && partner[at] < to) {
        at = partner[at] + 1;
      }

      const modifiers = [];
      while (at < to && isId(at) && PARAM_MODIFIERS.has(tokens[at].text)) {
        modifiers.push(tokens[at].text);
        at++;
      }

      let equals = -1;
      for (let scan = at; scan < to; scan++) {
        if (is(scan, "=")) {
          equals = scan;
          break;
        }
      }

      const nameIndex = (equals < 0 ? to : equals) - 1;
      if (nameIndex >= at && isId(nameIndex)) {
        params.push({
          name: tokens[nameIndex].text,
          type: text(at, nameIndex),
          isThis: modifiers.includes("this"),
          isParams: modifiers.includes("params"),
          hasDefault: equals >= 0,
        });
      }
    };

    let start = open + 1;
    let angle = 0;

    for (let at = open + 1; at < close; at++) {
      if (opens(at)) {
        at = partner[at];
      } else if (is(at, "<")) {
        angle++;
      } else if (is(at, ">")) {
        angle--;
      } else if (is(at, ",") && angle <= 0) {
        add(start, at);
        start = at + 1;
      }
    }

    if (close > start) {
      add(start, close);
    }

    return params;
  };

  const parseMethod = (index) => {
    const name = tokens[index].text;
    if (KEYWORDS.has(name) || NOT_CALLABLE.has(name) || is(index - 1, ".") || is(index - 1, "?.")) {
      return;
    }

    let at = index + 1;
    let typeParams = [];

    if (is(at, "<")) {
      const after = skipGeneric(at);
      if (after < 0) {
        return;
      }

      typeParams = tokens.slice(at + 1, after - 1).filter((token) => token.kind === "id").map((token) => token.text);
      at = after;
    }

    if (!is(at, "(") || partner[at] < 0) {
      return;
    }

    const open = at;
    const close = partner[at];
    let after = close + 1;
    const constraints = {};

    // where T : VisualElement, new() — ограничения нужны линтеру: обобщённый помощник Find<T> ждёт элемент типа T.
    while (word(after, "where") && isId(after + 1)) {
      const param = tokens[after + 1].text;
      const list = [];
      after += 3;

      while (after < tokens.length && !word(after, "where") && !is(after, "{") && !is(after, "=>") && !is(after, ";")) {
        if (isId(after) && !KEYWORDS.has(tokens[after].text)) {
          list.push(tokens[after].text);
        }

        after++;
      }

      constraints[param] = list;
    }

    let initializer = false;
    if (is(after, ":") && (word(after + 1, "base") || word(after + 1, "this")) && is(after + 2, "(") && partner[after + 2] > 0) {
      after = partner[after + 2] + 1;
      initializer = true;
    }

    if (!is(after, "{") && !is(after, "=>")) {
      return;
    }

    const before = tokens[index - 1];
    const typeEnd =
      before !== undefined &&
      ((before.kind === "id" && (!KEYWORDS.has(before.text) || TYPE_KEYWORDS.has(before.text)) && !NOT_CALLABLE.has(before.text)) ||
        (before.kind === "punct" && (before.text === ">" || before.text === "]" || before.text === "?" || before.text === "*")));
    const constructor = before !== undefined && before.kind === "id" && CTOR_MODIFIERS.has(before.text);

    if (!typeEnd && !constructor && !initializer) {
      return;
    }

    declarationParens.add(open);
    out.methods.push({
      name,
      nameIndex: index,
      typeParams,
      constraints,
      params: parseParams(open, close),
      bodyStart: after,
      bodyEnd: is(after, "{") ? partner[after] : statementEnd(after),
      line: tokens[index].line,
      constructorCandidate: constructor || initializer,
      typeIndex: -1,
      outer: -1,
    });
  };

  const parseCall = (open) => {
    let nameIndex = open - 1;
    let genericArgs = [];

    if (is(nameIndex, ">")) {
      const less = genericBack(nameIndex);
      if (less < 1) {
        return;
      }

      genericArgs = splitTopLevel(less + 1, nameIndex).map(([from, to]) => text(from, to));
      nameIndex = less - 1;
    }

    if (!isId(nameIndex)) {
      return;
    }

    const name = tokens[nameIndex].text;
    if (NOT_CALLABLE.has(name) || TYPE_KEYWORDS.has(name)) {
      return;
    }

    let receiver = false;
    let qualifier = null;
    let isNew = false;
    let typeName = null;

    if (is(nameIndex - 1, ".") || is(nameIndex - 1, "?.")) {
      receiver = true;
      qualifier = isId(nameIndex - 2) ? tokens[nameIndex - 2].text : null;

      let head = nameIndex;
      while (is(head - 1, ".") && isId(head - 2)) {
        head -= 2;
      }

      if (word(head - 1, "new")) {
        isNew = true;
        receiver = false;
        typeName = text(head, nameIndex + 1);
      }
    } else if (word(nameIndex - 1, "new")) {
      isNew = true;
      typeName = name;
    }

    const close = partner[open];
    const args =
      close < 0
        ? null
        : splitTopLevel(open + 1, close).map(([from, to]) => {
            let start = from;
            let label = null;

            if (isId(start) && is(start + 1, ":")) {
              label = tokens[start].text;
              start += 2;
            }

            while (start < to && (word(start, "ref") || word(start, "out") || word(start, "in"))) {
              start++;
            }

            return { label, start, end: to };
          });

    out.calls.push({ name, nameIndex, open, close, line: tokens[nameIndex].line, genericArgs, receiver, qualifier, isNew, typeName, args, typeIndex: -1, methodIndex: -1 });
  };

  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].kind !== "id") {
      continue;
    }

    switch (tokens[index].text) {
      case "using":
        parseUsing(index);
        break;
      case "namespace":
        parseNamespace(index);
        break;
      case "class":
      case "struct":
      case "interface":
      case "record":
      case "enum":
        parseType(index);
        break;
      case "const":
      case "readonly":
        parseFields(index);
        break;
      default:
        parseMethod(index);
    }
  }

  for (let index = 0; index < tokens.length; index++) {
    if (is(index, "(") && !declarationParens.has(index)) {
      parseCall(index);
    }
  }

  assignOwners(out);
  return out;
}

/** Кто чей: тип и метод-хозяин у каждого токена — внутренние перекрывают внешние. */
function assignOwners(out) {
  const size = out.tokens.length;
  const ownerType = new Int32Array(size).fill(-1);
  const ownerMethod = new Int32Array(size).fill(-1);
  const bySize = (list, from, to) => [...list.keys()].sort((a, b) => list[b][to] - list[b][from] - (list[a][to] - list[a][from]));

  for (const index of bySize(out.types, "start", "end")) {
    const type = out.types[index];
    type.outer = ownerType[type.nameIndex];
    ownerType.fill(index, type.nameIndex, type.end + 1);
  }

  for (const type of out.types) {
    const space = out.namespaces.filter((item) => item.start <= type.nameIndex && type.nameIndex <= item.end).map((item) => item.name);
    type.namespace = space.join(".");

    const chain = [type.name];
    for (let outer = type.outer; outer >= 0; outer = out.types[outer].outer) {
      chain.unshift(out.types[outer].name);
    }

    type.fullName = [type.namespace, chain.join(".")].filter(Boolean).join(".");
  }

  for (const index of bySize(out.methods, "nameIndex", "bodyEnd")) {
    const method = out.methods[index];
    method.outer = ownerMethod[method.nameIndex];
    ownerMethod.fill(index, method.nameIndex, method.bodyEnd + 1);
  }

  for (const method of out.methods) {
    method.typeIndex = ownerType[method.nameIndex];
    method.isConstructor = method.constructorCandidate && method.typeIndex >= 0 && out.types[method.typeIndex].name === method.name;
  }

  for (const item of out.consts) {
    item.typeIndex = ownerType[item.nameIndex];
    item.methodIndex = ownerMethod[item.nameIndex];
  }

  for (const call of out.calls) {
    call.typeIndex = ownerType[call.nameIndex];
    call.methodIndex = ownerMethod[call.nameIndex];
  }
}

function matchBrackets(tokens) {
  const partner = new Int32Array(tokens.length).fill(-1);
  const problems = [];
  const stack = [];
  const closerOf = { "(": ")", "[": "]", "{": "}" };

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind !== "punct") {
      continue;
    }

    if (closerOf[token.text]) {
      stack.push(index);
    } else if (token.text === ")" || token.text === "]" || token.text === "}") {
      const open = stack.pop();

      if (open === undefined || closerOf[tokens[open].text] !== token.text) {
        problems.push({ line: token.line, message: `скобка «${token.text}» без пары` });
        if (open !== undefined) {
          stack.push(open);
        }

        continue;
      }

      partner[open] = index;
      partner[index] = open;
    }
  }

  for (const open of stack) {
    problems.push({ line: tokens[open].line, message: `скобка «${tokens[open].text}» не закрыта` });
  }

  return { partner, problems };
}
