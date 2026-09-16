using System.Collections.Generic;
using System.Globalization;
using System.Text;

using UnityEngine;
using UnityEngine.UIElements;

namespace UiEye
{
    internal sealed class UiEyeTreeReport
    {
        public string Text;

        public int Elements;

        public int Checked;

        public int TextElements;

        public readonly List<UiEyeFinding> Findings = new List<UiEyeFinding>();
    }

    /// <summary>
    /// Дерево панели числами и находки по нему — то, чем ui-eye выносит вердикт; кадр — приложение.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Текст дерева обязан быть детерминированным: одинаковый запрос дважды — те же байты. Поэтому здесь
    /// нет времени, счётчиков кадров и адресов, а числа печатаются инвариантной культурой.
    /// </para>
    /// <para>
    /// Что проверяется (охват): «текст не влез» — у каждого видимого текстового элемента; без переноса —
    /// по ширине и высоте, с переносом — только по высоте при заданной ширине (перенос — не обрезка);
    /// «за краем» — рамка видимого элемента против экрана, только самый внешний вылезший; «за родителя» —
    /// только элементы в потоке (<c>position: relative</c>): абсолютные выходят за родителя нарочно;
    /// «нулевой размер» — только именованные элементы. Наложения соседей НЕ проверяются.
    /// </para>
    /// <para>
    /// «Текст не влез» значит: тексту нужно больше, чем рамка содержимого. Обрезан он (<c>overflow: hidden</c>) или
    /// вылез поверх отступов и соседей — числами не различается: <c>overflow</c> в <c>resolvedStyle</c> нет. Это видно
    /// на кадре («проба», состояние «сплющенный»: «12» значка обрезано целиком, «Действие» кнопки вылезло и читается).
    /// </para>
    /// </remarks>
    internal static class UiEyeTree
    {
        private const float Tolerance = 0.5f;

        public static UiEyeTreeReport Capture(VisualElement root, int width, int height)
        {
            var report = new UiEyeTreeReport();
            var text = new StringBuilder();
            Walk(root, null, 0, true, false, new Rect(0, 0, width, height), text, report);
            report.Text = text.ToString();
            return report;
        }

        private static void Walk(
            VisualElement element,
            VisualElement parent,
            int depth,
            bool parentShown,
            bool ancestorOutside,
            Rect screen,
            StringBuilder text,
            UiEyeTreeReport report)
        {
            report.Elements++;

            var style = element.resolvedStyle;
            var bound = element.worldBound;
            var content = element.contentRect;
            var shown = parentShown
                && style.display == DisplayStyle.Flex
                && style.visibility == Visibility.Visible
                && style.opacity > 0f;
            var who = Who(element);
            var firstFinding = report.Findings.Count;
            var outside = false;

            text.Append(' ', depth * 2).Append(element.GetType().Name);

            if (!string.IsNullOrEmpty(element.name))
            {
                text.Append(" #").Append(element.name);
            }

            foreach (var className in element.GetClasses())
            {
                text.Append(" .").Append(className);
            }

            text.Append(" rect=(").Append(Box(bound)).Append(')')
                .Append(F(" content={0:0.##}x{1:0.##} font={2:0.##}", content.width, content.height, style.fontSize))
                .Append(" color=").Append(ColorUtility.ToHtmlStringRGBA(style.color))
                .Append(" bg=").Append(ColorUtility.ToHtmlStringRGBA(style.backgroundColor))
                .Append(" pos=").Append(style.position)
                .Append(" display=").Append(style.display)
                .Append(" visibility=").Append(style.visibility)
                .Append(F(" opacity={0:0.##}", style.opacity));

            if (shown)
            {
                report.Checked++;
                var sized = bound.width > Tolerance && bound.height > Tolerance;

                if (!ancestorOutside && sized && !Inside(bound, screen))
                {
                    outside = true;
                    Add(report, "за-краем", who, F("рамка ({0}) выходит за экран {1}x{2}", Box(bound), screen.width, screen.height));
                }
                else if (!ancestorOutside && sized && parent != null && style.position == Position.Relative
                    && parent.worldBound.width > Tolerance && parent.worldBound.height > Tolerance
                    && !Inside(bound, parent.worldBound))
                {
                    Add(report, "за-родителя", who, F("рамка ({0}) выходит за родителя ({1})", Box(bound), Box(parent.worldBound)));
                }

                if (!string.IsNullOrEmpty(element.name) && !sized)
                {
                    Add(report, "нулевой-размер", who, F("рамка {0:0.##}x{1:0.##}", bound.width, bound.height));
                }
            }

            var textElement = element as TextElement;

            if (textElement != null)
            {
                report.TextElements++;
                var value = textElement.text ?? string.Empty;
                var wraps = style.whiteSpace == WhiteSpace.Normal || style.whiteSpace == WhiteSpace.PreWrap;

                text.Append(" text=\"").Append(Escape(value)).Append('"').Append(" wrap=").Append(style.whiteSpace);

                if (style.textOverflow == TextOverflow.Ellipsis)
                {
                    text.Append(" overflow=Ellipsis");
                }

                if (wraps)
                {
                    var need = textElement.MeasureTextSize(
                        value, content.width, VisualElement.MeasureMode.Exactly, 0, VisualElement.MeasureMode.Undefined);
                    text.Append(F(" need-height={0:0.##}", need.y));

                    if (shown && need.y > content.height + Tolerance)
                    {
                        Add(report, "текст-не-влез", who, F("по высоте: нужно {0:0.##}, есть {1:0.##}", need.y, content.height));
                    }
                }
                else
                {
                    var need = textElement.MeasureTextSize(
                        value, 0, VisualElement.MeasureMode.Undefined, 0, VisualElement.MeasureMode.Undefined);
                    text.Append(F(" need={0:0.##}x{1:0.##}", need.x, need.y));

                    if (shown && need.x > content.width + Tolerance)
                    {
                        Add(report, "текст-не-влез", who, F("по ширине: нужно {0:0.##}, есть {1:0.##}", need.x, content.width));
                    }

                    if (shown && need.y > content.height + Tolerance)
                    {
                        Add(report, "текст-не-влез", who, F("по высоте: нужно {0:0.##}, есть {1:0.##}", need.y, content.height));
                    }
                }
            }

            for (var index = firstFinding; index < report.Findings.Count; index++)
            {
                text.Append("  !! ").Append(report.Findings[index].kind).Append(": ").Append(report.Findings[index].detail);
            }

            text.Append('\n');

            foreach (var child in element.Children())
            {
                Walk(child, element, depth + 1, shown, ancestorOutside || outside, screen, text, report);
            }
        }

        private static void Add(UiEyeTreeReport report, string kind, string element, string detail)
        {
            report.Findings.Add(new UiEyeFinding { kind = kind, element = element, detail = detail });
        }

        private static bool Inside(Rect inner, Rect outer)
        {
            return inner.xMin >= outer.xMin - Tolerance
                && inner.yMin >= outer.yMin - Tolerance
                && inner.xMax <= outer.xMax + Tolerance
                && inner.yMax <= outer.yMax + Tolerance;
        }

        private static string Who(VisualElement element)
        {
            if (!string.IsNullOrEmpty(element.name))
            {
                return element.GetType().Name + " #" + element.name;
            }

            foreach (var className in element.GetClasses())
            {
                return element.GetType().Name + " ." + className;
            }

            return element.GetType().Name;
        }

        private static string Box(Rect rect)
        {
            return F("{0:0.##},{1:0.##} {2:0.##}x{3:0.##}", rect.x, rect.y, rect.width, rect.height);
        }

        private static string Escape(string value)
        {
            return value.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n");
        }

        private static string F(string format, params object[] arguments)
        {
            return string.Format(CultureInfo.InvariantCulture, format, arguments);
        }
    }
}
