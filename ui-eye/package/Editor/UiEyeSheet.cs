using System;
using System.Collections.Generic;

using UnityEngine;
using UnityEngine.UIElements;

namespace UiEye
{
    internal sealed class UiEyeSheetCell
    {
        public string Caption;

        public Texture2D Image;
    }

    /// <summary>
    /// Контактный лист: строка — состояние, столбец — размер экрана. Картинка для человека, не вердикт.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Собран тем же UI Toolkit, что и снимки: подписи по-русски рисуются тем же шрифтом, а лишнего
    /// рисовальщика в инструменте нет.
    /// </para>
    /// <para>
    /// Масштаб один на весь лист, по самому широкому экрану. Первая версия ужимала каждый столбец
    /// до одной ширины — и на 21:9 панель выглядела меньше, чем на 16:9, хотя в пикселях она та же.
    /// Лист, который врёт о размере, для разговора о виде хуже, чем никакого листа.
    /// </para>
    /// </remarks>
    internal static class UiEyeSheet
    {
        private const int WidestCell = 800;
        private const int Gap = 16;
        private const int HeaderHeight = 40;
        private const int CaptionHeight = 28;

        /// <param name="cells">Построчно: <c>rows × columns</c> клеток.</param>
        public static VisualElement Build(
            string header,
            int rows,
            IReadOnlyList<Vector2Int> sizes,
            IReadOnlyList<UiEyeSheetCell> cells,
            out int width,
            out int height)
        {
            var columns = sizes.Count;
            var widest = 0;

            foreach (var size in sizes)
            {
                widest = Math.Max(widest, size.x);
            }

            var scale = (double)WidestCell / widest;
            var imageHeight = 0;
            width = Gap;

            foreach (var size in sizes)
            {
                imageHeight = Math.Max(imageHeight, Scaled(size.y, scale));
                width += Scaled(size.x, scale) + Gap;
            }

            var root = new VisualElement();
            root.style.flexGrow = 1;
            root.style.paddingLeft = Gap;
            root.style.paddingTop = Gap;
            root.style.backgroundColor = new Color(0.08f, 0.08f, 0.08f, 1f);

            var title = new Label(header);
            title.style.height = HeaderHeight;
            title.style.fontSize = 20;
            title.style.color = new Color(0.92f, 0.9f, 0.86f, 1f);
            title.style.whiteSpace = WhiteSpace.NoWrap;
            root.Add(title);

            for (var row = 0; row < rows; row++)
            {
                var line = new VisualElement();
                line.style.flexDirection = FlexDirection.Row;
                line.style.height = CaptionHeight + imageHeight;
                line.style.marginBottom = Gap;

                for (var column = 0; column < columns; column++)
                {
                    var cell = cells[row * columns + column];
                    var imageWidth = Scaled(sizes[column].x, scale);

                    var box = new VisualElement();
                    box.style.width = imageWidth;
                    box.style.marginRight = Gap;

                    var caption = new Label(cell.Caption);
                    caption.style.height = CaptionHeight;
                    caption.style.fontSize = 16;
                    caption.style.color = new Color(0.85f, 0.83f, 0.78f, 1f);
                    caption.style.whiteSpace = WhiteSpace.NoWrap;

                    var image = new Image { image = cell.Image, scaleMode = ScaleMode.ScaleToFit };
                    image.style.width = imageWidth;
                    image.style.height = Scaled(sizes[column].y, scale);

                    box.Add(caption);
                    box.Add(image);
                    line.Add(box);
                }

                root.Add(line);
            }

            height = Gap + HeaderHeight + rows * (CaptionHeight + imageHeight + Gap);
            return root;
        }

        private static int Scaled(int pixels, double scale)
        {
            return (int)Math.Round(pixels * scale);
        }
    }
}
