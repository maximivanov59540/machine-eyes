/**
 * Лексер C# для линтера ui-eye: токены без пробелов, комментариев и директив, с номером строки.
 *
 * Весь C# не нужен — нужно, чтобы имя в комментарии или внутри чужой строки не сошло за обращение к разметке, а
 * обращение внутри $"…{…}" не потерялось (токены выражений из дыр идут сразу за токеном строки).
 * Проверка себя: пропущенное и токены верхнего уровня обязаны покрыть файл целиком — иначе запись в problems.
 *
 * Токен: { kind: "id" | "str" | "istr" | "chr" | "num" | "punct", text, value?, start, end, line }.
 * У "str" value — значение строки; у "istr" (интерполированная) значения нет: имя в ней вычисляется.
 */

const PUNCT2 = new Set(["=>", "==", "!=", "<=", "&&", "||", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "??", "?.", "::", "->"]);

const IDENTIFIER = /@?[\p{L}\p{Nl}_][\p{L}\p{Mn}\p{Mc}\p{Nd}\p{Nl}\p{Pc}\p{Cf}]*/uy;
const NUMBER = /(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|[0-9][0-9_]*(?:\.[0-9][0-9_]*)?(?:[eE][+-]?[0-9_]+)?|\.[0-9][0-9_]*(?:[eE][+-]?[0-9_]+)?)[uUlLfFdDmM]*/y;

/** @returns {{ tokens: object[], problems: { line: number, message: string }[] }} */
export function lex(text, firstLine = 1, offset = 0) {
  const tokens = [];
  const problems = [];
  const length = text.length;
  let index = 0;
  let line = firstLine;
  let covered = 0;

  const lineAt = (from, to, start) => {
    let result = start;
    for (let at = from; at < to; at++) {
      if (text.charCodeAt(at) === 10) {
        result++;
      }
    }

    return result;
  };

  const consume = (to) => {
    line = lineAt(index, to, line);
    covered += to - index;
    index = to;
  };

  const push = (kind, end, extra = {}) => {
    tokens.push({ kind, text: text.slice(index, end), start: index + offset, end: end + offset, line, ...extra });
    consume(end);
  };

  while (index < length) {
    const code = text.charCodeAt(index);
    const char = text[index];

    if (isSpace(code)) {
      consume(index + 1);
      continue;
    }

    if (char === "#" && atLineStart(text, index)) {
      consume(endOfLine(text, index));
      continue;
    }

    if (char === "/" && text[index + 1] === "/") {
      consume(endOfLine(text, index));
      continue;
    }

    if (char === "/" && text[index + 1] === "*") {
      const close = text.indexOf("*/", index + 2);
      if (close < 0) {
        problems.push({ line, message: "комментарий /* не закрыт до конца файла" });
        consume(length);
      } else {
        consume(close + 2);
      }

      continue;
    }

    const string = char === '"' || char === "$" || char === "@" ? readString(text, index) : null;
    if (string) {
      if (string.unterminated) {
        problems.push({ line, message: "строка не закрыта" });
      }

      const startLine = line;
      push(string.interpolated ? "istr" : "str", string.end, string.interpolated ? {} : { value: string.value });

      for (const hole of string.holes) {
        const inner = lex(text.slice(hole.start, hole.end), lineAt(0, hole.start, 1) - lineAt(0, string.start, 1) + startLine, offset + hole.start);
        tokens.push(...inner.tokens);
        problems.push(...inner.problems);
      }

      continue;
    }

    if (char === "'") {
      push("chr", readChar(text, index));
      continue;
    }

    if ((code >= 48 && code <= 57) || (char === "." && isDigit(text.charCodeAt(index + 1)))) {
      NUMBER.lastIndex = index;
      const match = NUMBER.exec(text);
      push("num", match ? NUMBER.lastIndex : index + 1);
      continue;
    }

    IDENTIFIER.lastIndex = index;
    const identifier = IDENTIFIER.exec(text);
    if (identifier) {
      const end = IDENTIFIER.lastIndex;
      const name = identifier[0].startsWith("@") ? identifier[0].slice(1) : identifier[0];
      tokens.push({ kind: "id", text: name, start: index + offset, end: end + offset, line });
      consume(end);
      continue;
    }

    const pair = text.slice(index, index + 2);
    push("punct", PUNCT2.has(pair) ? index + 2 : index + 1);
  }

  if (covered !== length) {
    problems.push({ line: firstLine, message: `лексер покрыл ${covered} знаков из ${length}` });
  }

  return { tokens, problems };
}

/**
 * Строка любого вида с этого места или null: "…", @"…", $"…", $@"…", @$"…", сырая """…""" (с $ впереди — тоже).
 * @returns {{ start, end, value, interpolated, holes: { start, end }[], unterminated } | null}
 */
function readString(text, at) {
  let cursor = at;
  let dollars = 0;
  let verbatim = false;

  while (text[cursor] === "$" || text[cursor] === "@") {
    if (text[cursor] === "$") {
      dollars++;
    } else {
      verbatim = true;
    }

    cursor++;
  }

  if (text[cursor] !== '"' || cursor - at > 2 + Math.max(0, dollars - 1)) {
    return null;
  }

  const result = { start: at, end: text.length, value: "", interpolated: dollars > 0, holes: [], unterminated: true };

  let quotes = 0;
  while (text[cursor + quotes] === '"') {
    quotes++;
  }

  if (quotes >= 3 && !verbatim) {
    const closer = '"'.repeat(quotes);
    const close = text.indexOf(closer, cursor + quotes);
    if (close >= 0) {
      result.end = suffix(text, close + quotes);
      result.unterminated = false;
      result.value = text.slice(cursor + quotes, close);
    }

    return result;
  }

  let value = "";
  let index = cursor + 1;

  while (index < text.length) {
    const char = text[index];

    if (!verbatim && char === "\\") {
      value += text.slice(index, index + 2);
      index += 2;
      continue;
    }

    if (char === '"') {
      if (verbatim && text[index + 1] === '"') {
        value += '"';
        index += 2;
        continue;
      }

      result.end = suffix(text, index + 1);
      result.unterminated = false;
      break;
    }

    if (!verbatim && char === "\n") {
      result.end = index;
      break;
    }

    if (dollars > 0 && (char === "{" || char === "}")) {
      if (text[index + 1] === char) {
        value += char;
        index += 2;
        continue;
      }

      if (char === "{") {
        const close = skipExpression(text, index + 1);
        result.holes.push({ start: index + 1, end: close });
        index = close + 1;
        continue;
      }
    }

    value += char;
    index++;
  }

  result.value = verbatim ? value : unescape(value);
  return result;
}

/** Конец выражения в дыре интерполяции: закрывающая } на нулевой глубине; строки, символы и комментарии — насквозь. */
function skipExpression(text, from) {
  let depth = 0;
  let index = from;

  while (index < text.length) {
    const char = text[index];
    const string = readString(text, index);

    if (string) {
      index = string.end;
      continue;
    }

    if (char === "'") {
      index = readChar(text, index);
      continue;
    }

    if (char === "/" && text[index + 1] === "*") {
      const close = text.indexOf("*/", index + 2);
      index = close < 0 ? text.length : close + 2;
      continue;
    }

    if (char === "(" || char === "[" || char === "{") {
      depth++;
    } else if (char === ")" || char === "]") {
      depth--;
    } else if (char === "}") {
      if (depth === 0) {
        return index;
      }

      depth--;
    }

    index++;
  }

  return text.length;
}

function readChar(text, at) {
  let index = at + 1;

  if (text[index] === "\\") {
    index += 2;
  } else {
    index += 1;
  }

  while (index < text.length && text[index] !== "'" && text[index] !== "\n") {
    index++;
  }

  return text[index] === "'" ? index + 1 : index;
}

function suffix(text, at) {
  return (text[at] === "u" || text[at] === "U") && text[at + 1] === "8" ? at + 2 : at;
}

const SIMPLE_ESCAPES = { "'": "'", '"': '"', "\\": "\\", 0: "\0", a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };

function unescape(raw) {
  let result = "";

  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];

    if (char !== "\\") {
      result += char;
      continue;
    }

    const next = raw[index + 1];

    if (next in SIMPLE_ESCAPES) {
      result += SIMPLE_ESCAPES[next];
      index++;
      continue;
    }

    const width = next === "u" ? 4 : next === "U" ? 8 : next === "x" ? -1 : 0;

    if (width === 0) {
      result += next ?? "";
      index++;
      continue;
    }

    const digits = /^[0-9a-fA-F]+/.exec(raw.slice(index + 2, index + 2 + (width < 0 ? 4 : width)))?.[0] ?? "";
    result += digits ? String.fromCodePoint(parseInt(digits, 16)) : "";
    index += 1 + digits.length;
  }

  return result;
}

function isDigit(code) {
  return code >= 48 && code <= 57;
}

function isSpace(code) {
  return (
    code === 32 ||
    (code >= 9 && code <= 13) ||
    code === 0xa0 ||
    code === 0xfeff ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}

function atLineStart(text, index) {
  for (let at = index - 1; at >= 0; at--) {
    const code = text.charCodeAt(at);
    if (code === 10) {
      return true;
    }

    if (code !== 32 && code !== 9 && code !== 13) {
      return false;
    }
  }

  return true;
}

function endOfLine(text, index) {
  const newline = text.indexOf("\n", index);
  return newline < 0 ? text.length : newline;
}
