/**
 * Разбор UXML для линтера ui-eye: элементы (тип, имя, классы, строка, родитель) и объявления шаблонов.
 *
 * Зависимостей нет: UXML — простой XML, и полный разборщик ради него был бы лишней движущейся частью.
 * Разбор терпимый, но не молчаливый: всё, что не удалось понять, попадает в problems со строкой.
 */

// Служебные теги UXML — не элементы интерфейса. У Bindings и AttributeOverrides дети — тоже не элементы.
const SERVICE = new Set(["UXML", "Style", "Template"]);
const SUBTREE_SKIP = new Set(["Bindings", "AttributeOverrides"]);

const TEMPLATE_CONTAINER = "UnityEngine.UIElements.TemplateContainer";

/**
 * @returns {{
 *   elements: { type: string, name: string, classes: string[], line: number, parent: number, template: string | null }[],
 *   templates: { alias: string, src: string, line: number }[],
 *   problems: { line: number, message: string }[],
 * }}
 */
export function parseUxml(text) {
  const result = { elements: [], templates: [], problems: [] };
  const lineOf = lineIndex(text);
  const stack = [];
  const tagName = /<\s*([^\s/>]+)/y;
  const attribute = /\s*([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
  const tagEnd = /\s*(\/?)>/y;
  const endTag = /<\/\s*([^\s>]+)\s*>/y;
  let index = 0;

  const problem = (at, message) => result.problems.push({ line: lineOf(at), message });

  while (index < text.length) {
    const open = text.indexOf("<", index);
    if (open < 0) {
      break;
    }

    index = open;

    const skipTo = (prefix, closer) => {
      const close = text.indexOf(closer, index + prefix.length);
      if (close < 0) {
        problem(index, `не закрыто «${prefix}»`);
        return text.length;
      }

      return close + closer.length;
    };

    if (text.startsWith("<!--", index)) {
      index = skipTo("<!--", "-->");
      continue;
    }

    if (text.startsWith("<![CDATA[", index)) {
      index = skipTo("<![CDATA[", "]]>");
      continue;
    }

    if (text.startsWith("<?", index)) {
      index = skipTo("<?", "?>");
      continue;
    }

    if (text.startsWith("<!", index)) {
      index = skipTo("<!", ">");
      continue;
    }

    if (text.startsWith("</", index)) {
      endTag.lastIndex = index;
      const match = endTag.exec(text);

      if (!match) {
        problem(index, "закрывающий тег не разобран");
        index += 2;
        continue;
      }

      const top = stack.pop();
      if (!top) {
        problem(index, `лишний закрывающий тег </${match[1]}>`);
      } else if (top.qualified !== match[1]) {
        problem(index, `закрывающий тег </${match[1]}> не парный к <${top.qualified}> (строка ${top.line})`);
      }

      index = endTag.lastIndex;
      continue;
    }

    tagName.lastIndex = index;
    const name = tagName.exec(text);

    if (!name) {
      problem(index, "тег не разобран");
      index += 1;
      continue;
    }

    const attributes = {};
    let cursor = tagName.lastIndex;

    for (;;) {
      attribute.lastIndex = cursor;
      const match = attribute.exec(text);
      if (!match) {
        break;
      }

      attributes[match[1]] = decode(match[2] ?? match[3]);
      cursor = attribute.lastIndex;
    }

    tagEnd.lastIndex = cursor;
    const end = tagEnd.exec(text);

    if (!end) {
      problem(index, `тег <${name[1]}> не закрыт или атрибут не разобран`);
      index = cursor + 1;
      continue;
    }

    index = tagEnd.lastIndex;
    const selfClosing = end[1] === "/";
    const parent = stack[stack.length - 1] ?? null;
    const scope = new Map(parent?.scope ?? []);

    for (const [key, value] of Object.entries(attributes)) {
      if (key === "xmlns") {
        scope.set("", value);
      } else if (key.startsWith("xmlns:")) {
        scope.set(key.slice(6), value);
      }
    }

    const qualified = name[1];
    const colon = qualified.indexOf(":");
    const prefix = colon >= 0 ? qualified.slice(0, colon) : "";
    const local = colon >= 0 ? qualified.slice(colon + 1) : qualified;
    const line = lineOf(open);
    const skipping = Boolean(parent?.skipping) || SUBTREE_SKIP.has(local);
    let elementIndex = parent?.elementIndex ?? -1;

    if (!skipping) {
      if (local === "Template") {
        result.templates.push({ alias: attributes.name ?? "", src: attributes.src ?? attributes.path ?? "", line });
      } else if (!SERVICE.has(local)) {
        const space = scope.get(prefix);

        if (prefix !== "" && space === undefined) {
          problem(open, `префикс «${prefix}» не объявлен (xmlns:${prefix})`);
        }

        const isInstance = local === "Instance";
        result.elements.push({
          type: isInstance ? TEMPLATE_CONTAINER : space ? `${space}.${local}` : local,
          name: attributes.name ?? "",
          classes: (attributes.class ?? "").split(/\s+/).filter(Boolean),
          line,
          parent: parent?.elementIndex ?? -1,
          template: isInstance ? attributes.template ?? "" : null,
        });
        elementIndex = result.elements.length - 1;
      }
    }

    if (!selfClosing) {
      stack.push({ qualified, line, scope, skipping, elementIndex });
    }
  }

  for (const open of stack) {
    result.problems.push({ line: open.line, message: `тег <${open.qualified}> не закрыт до конца файла` });
  }

  return result;
}

function decode(value) {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (whole, entity) => {
    switch (entity) {
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "amp":
        return "&";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default:
        return String.fromCodePoint(entity[1] === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10));
    }
  });
}

/** Номер строки (с 1) по смещению в тексте — двоичным поиском по началам строк. */
export function lineIndex(text) {
  const starts = [0];

  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) {
    starts.push(at + 1);
  }

  return (offset) => {
    let low = 0;
    let high = starts.length - 1;

    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle] <= offset) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }

    return low + 1;
  };
}
