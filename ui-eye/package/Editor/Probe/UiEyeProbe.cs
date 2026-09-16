namespace UiEye
{
    /// <summary>
    /// Панель «проба» — калибровка ui-eye. Заодно образец регистрации: статический метод без параметров, который
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
        /// «короткий» — находок нет на обоих размерах; «длинный» — не влезли заголовок и значок, а абзац
        /// с переносом НЕ находка (иначе прибор путает перенос с обрезкой); «за-краем» — на 1920 панель
        /// выходит за экран, на 2560 нет.
        /// Добавлены после первого прогона, когда оказалось, что три проверки ни разу не краснели:
        /// «сплющенный» — нулевой размер у <c>#row</c>; «вне-родителя» — значок и кнопка за рядом;
        /// «в-движении» — кадр не устаивается (переход стиля).
        /// Для «сплющенного» первое ожидание было только «нулевой размер» у <c>#row</c> — и кадр показал, что ошибся
        /// автор ожидания, а не прибор: дети ряда получают его нулевую высоту пределом, «12» на кадре не видно вовсе,
        /// кнопка сжата до 22 px. Поэтому там же честно стоят две находки «текст не влез».
        /// </remarks>
        [UiEyePanel]
        public static UiEyePanel Panel()
        {
            return new UiEyePanel(
                "проба",
                "калибровка ui-eye: у каждого состояния заранее известен правильный ответ",
                UiEyePanels.Folder + "/Probe/Probe.uxml",
                new UiEyeState(
                    "короткий",
                    "всё помещается — находок быть не должно",
                    root =>
                    {
                        UiEyeFill.Text(root, "title", "Probe");
                        UiEyeFill.Text(root, "body", "A short paragraph.");
                        UiEyeFill.Text(root, "badge", "12");
                    }),
                new UiEyeState(
                    "длинный",
                    "заголовок и значок не влезают; длинный абзац переносится и находкой не считается",
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
                    "за-краем",
                    "панель сдвинута вправо: на 1920 выходит за край экрана, на 2560 помещается",
                    root =>
                    {
                        UiEyeFill.Text(root, "title", "Probe");
                        UiEyeFill.Text(root, "body", "The panel is pushed to the right.");
                        UiEyeFill.Text(root, "badge", "12");
                        UiEyeFill.AddClass(root, "panel", "probe--offscreen");
                    }),
                new UiEyeState(
                    "сплющенный",
                    "ряд сплющен в ноль по высоте — «нулевой размер» у #row; значок и кнопка сплющены с ним, их текст не влезает",
                    root =>
                    {
                        UiEyeFill.Text(root, "title", "Probe");
                        UiEyeFill.Text(root, "body", "The row below the paragraph is flattened.");
                        UiEyeFill.Text(root, "badge", "12");
                        UiEyeFill.AddClass(root, "row", "probe__row--flat");
                    }),
                new UiEyeState(
                    "вне-родителя",
                    "значок шире своего ряда и не сжимается — значок и кнопка выходят за ряд",
                    root =>
                    {
                        UiEyeFill.Text(root, "title", "Probe");
                        UiEyeFill.Text(root, "body", "The badge is wider than its row.");
                        UiEyeFill.Text(root, "badge", "12");
                        UiEyeFill.AddClass(root, "badge", "probe__badge--wide");
                    }),
                new UiEyeState(
                    "в-движении",
                    "панель медленно едет (переход стиля на 10 с) — кадр не устаивается",
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
