namespace UiEye
{
    /// <summary>
    /// Панель «probe» — калибровка ui-eye. Заодно образец регистрации: статический метод без параметров, который
    /// возвращает панель, с атрибутом <see cref="UiEyePanelAttribute"/>. Панель своего проекта регистрируется так же —
    /// своим файлом в своей сборке редактора; пакет не правится.
    /// </summary>
    public static class UiEyeProbe
    {
        /// <summary>
        /// Калибровка самого инструмента: положительный и отрицательный контроль в одной панели.
        /// </summary>
        /// <remarks>
        /// Ожидание, записанное ДО первого запуска, — по нему судят, исправен ли прибор:
        /// «short» — находок нет на обоих размерах; «long» — не влезли заголовок и значок, а абзац
        /// с переносом НЕ находка (иначе прибор путает перенос с обрезкой); «offscreen» — на 1920 панель
        /// выходит за экран, на 2560 нет.
        /// Добавлены после первого прогона, когда оказалось, что три проверки ни разу не краснели:
        /// «flattened» — нулевой размер у <c>#row</c>; «outside-parent» — значок и кнопка за рядом;
        /// «moving» — кадр не устаивается (переход стиля).
        /// Для «flattened» первое ожидание было только «нулевой размер» у <c>#row</c> — и кадр показал, что ошибся
        /// автор ожидания, а не прибор: дети ряда получают его нулевую высоту пределом, «12» на кадре не видно вовсе,
        /// кнопка сжата до 22 px. Поэтому там же честно стоят две находки «текст не влез».
        /// </remarks>
        [UiEyePanel]
        public static UiEyePanel Panel()
        {
            return new UiEyePanel(
                "probe",
                "ui-eye calibration: every state has its right answer known in advance",
                UiEyePanels.Folder + "/Probe/Probe.uxml",
                new UiEyeState(
                    "short",
                    "everything fits - there must be no findings",
                    root =>
                    {
                        UiEyeFill.Text(root, "title", "Probe");
                        UiEyeFill.Text(root, "body", "A short paragraph.");
                        UiEyeFill.Text(root, "badge", "12");
                    }),
                new UiEyeState(
                    "long",
                    "the heading and the badge do not fit; the long paragraph wraps and is not a finding",
                    root =>
                    {
                        UiEyeFill.Text(root, "title", "A heading that is certainly too wide to fit the width of this panel");
                        UiEyeFill.Text(
                            root,
                            "body",
                            "A long paragraph wraps by words and stretches the panel downwards. This is a negative "
                                + "control: wrapping must not be counted as text that does not fit.");
                        UiEyeFill.Text(root, "badge", "1 234 567 890 coins");
                    }),
                new UiEyeState(
                    "offscreen",
                    "the panel is pushed right: beyond the screen at 1920, inside it at 2560",
                    root =>
                    {
                        UiEyeFill.Text(root, "title", "Probe");
                        UiEyeFill.Text(root, "body", "The panel is pushed to the right.");
                        UiEyeFill.Text(root, "badge", "12");
                        UiEyeFill.AddClass(root, "panel", "probe--offscreen");
                    }),
                new UiEyeState(
                    "flattened",
                    "the row is flattened to zero height - zero size on #row; the badge and the button go with it, their text does not fit",
                    root =>
                    {
                        UiEyeFill.Text(root, "title", "Probe");
                        UiEyeFill.Text(root, "body", "The row below the paragraph is flattened.");
                        UiEyeFill.Text(root, "badge", "12");
                        UiEyeFill.AddClass(root, "row", "probe__row--flat");
                    }),
                new UiEyeState(
                    "outside-parent",
                    "the badge is wider than its row and does not shrink - the badge and the button leave the row",
                    root =>
                    {
                        UiEyeFill.Text(root, "title", "Probe");
                        UiEyeFill.Text(root, "body", "The badge is wider than its row.");
                        UiEyeFill.Text(root, "badge", "12");
                        UiEyeFill.AddClass(root, "badge", "probe__badge--wide");
                    }),
                new UiEyeState(
                    "moving",
                    "the panel moves slowly (a 10 s style transition) - the frame never settles",
                    root =>
                    {
                        UiEyeFill.Text(root, "title", "Probe");
                        UiEyeFill.Text(root, "body", "The panel is moving.");
                        UiEyeFill.Text(root, "badge", "12");
                        UiEyeFill.AddClass(root, "panel", "probe--moving");
                    }));
        }
    }
}
