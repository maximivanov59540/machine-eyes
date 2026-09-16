using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;

using UnityEngine.UIElements;

namespace UiEye
{
    /// <summary>Состояние панели для снимка: имя, зачем оно, и чем наполнить разметку.</summary>
    public sealed class UiEyeState
    {
        public UiEyeState(string name, string description, Action<VisualElement> apply)
        {
            Name = name;
            Description = description;
            Apply = apply;
        }

        public string Name { get; }

        public string Description { get; }

        /// <summary>Получает корень документа сразу после того, как разметка развёрнута.</summary>
        public Action<VisualElement> Apply { get; }
    }

    /// <summary>Панель, которую умеет снимать ui-eye: разметка, тема и список состояний.</summary>
    public sealed class UiEyePanel
    {
        public UiEyePanel(string name, string description, string markup, params UiEyeState[] states)
        {
            Name = name;
            Description = description;
            Markup = markup;
            States = states;
        }

        public string Name { get; }

        public string Description { get; }

        /// <summary>Путь UXML от корня проекта: <c>Assets/…/*.uxml</c> или <c>Packages/…/*.uxml</c>.</summary>
        public string Markup { get; }

        /// <summary>
        /// Путь темы (TSS) от корня проекта. По умолчанию — тема ui-eye (тема Unity по умолчанию); панель игры ставит
        /// тему игры через <see cref="WithTheme"/>, чтобы снимок видел те же стили, что игра.
        /// </summary>
        public string Theme { get; private set; } = UiEyePanels.DefaultTheme;

        /// <summary>Поставить панели свою тему и вернуть ту же панель — один вызов конструктора на панель.</summary>
        /// <remarks>
        /// Тот же объект, а не копия: копия — второй вызов конструктора панели, и линтер ui-eye счёл бы его ещё одной
        /// панелью реестра.
        /// </remarks>
        public UiEyePanel WithTheme(string theme)
        {
            Theme = theme;
            return this;
        }

        public IReadOnlyList<UiEyeState> States { get; }

        public UiEyeState FindState(string name)
        {
            foreach (var state in States)
            {
                if (state.Name == name)
                {
                    return state;
                }
            }

            return null;
        }
    }

    /// <summary>
    /// Регистрирует панель ui-eye. Ставится на статический метод без параметров, который возвращает
    /// <see cref="UiEyePanel"/>; такие методы съёмщик находит во всех сборках редактора проекта сам
    /// (<see cref="UiEyePanels.Registry"/>) — пакет не правится.
    /// </summary>
    /// <remarks>
    /// Файл и строку, где стоит атрибут, подставляет компилятор: по ним отказ реестра называет место. Руками их не пишут.
    /// </remarks>
    [AttributeUsage(AttributeTargets.Method, AllowMultiple = false, Inherited = false)]
    public sealed class UiEyePanelAttribute : Attribute
    {
        public UiEyePanelAttribute([CallerFilePath] string filePath = "", [CallerLineNumber] int lineNumber = 0)
        {
            FilePath = filePath;
            LineNumber = lineNumber;
        }

        public string FilePath { get; }

        public int LineNumber { get; }
    }

    /// <summary>Реестр, собранный из методов с <see cref="UiEyePanelAttribute"/>: годные панели и отказы.</summary>
    public sealed class UiEyeRegistry
    {
        public UiEyeRegistry(IReadOnlyList<UiEyePanel> panels, IReadOnlyList<string> problems)
        {
            Panels = panels;
            Problems = problems;
        }

        /// <summary>Панели, чьё имя в реестре одно, — по имени, порядковым сравнением.</summary>
        public IReadOnlyList<UiEyePanel> Panels { get; }

        /// <summary>Отказы реестра, каждый с местом; пусто — реестр собран.</summary>
        public IReadOnlyList<string> Problems { get; }

        public UiEyePanel Find(string name)
        {
            foreach (var panel in Panels)
            {
                if (panel.Name == name)
                {
                    return panel;
                }
            }

            return null;
        }
    }

    /// <summary>
    /// Реестр панелей ui-eye: статические методы с <see cref="UiEyePanelAttribute"/> во всех сборках редактора проекта.
    /// Новая панель — такой метод в своём файле.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Состояния — код, а не файлы данных, и это решение: заполнитель сегодня пишет текст в метку,
    /// а завтра поведёт настоящий контроллер панели с поддельным источником данных — и снимок покажет
    /// то, что сделает игра, а не то, что вписано руками. Цена — неизвестное имя панели узнаётся
    /// только в Unity; съёмщик ловит его до входа в Play Mode и называет известные.
    /// </para>
    /// <para>
    /// Панель игры описывается своим файлом в сборке редактора игры: её состояния ведут настоящий вид панели
    /// с поддельным источником данных, тема — игры. Образец регистрации — «проба», <c>Editor/Probe/UiEyeProbe.cs</c>.
    /// </para>
    /// <para>
    /// Ошибка регистрации молча не пропадает: метод не той формы, бросивший, вернувший <c>null</c>, панель без имени,
    /// одно имя у нескольких методов, ни одного метода с атрибутом — отказ реестра с местом, и съёмщик отвечает на него
    /// кодом 5, ничего не снимая. Панели идут по имени, а не в том порядке, в каком методы отдала Unity.
    /// </para>
    /// <para>
    /// Сборка только для редактора: ни реестр, ни «проба» в игру не попадают.
    /// </para>
    /// </remarks>
    public static class UiEyePanels
    {
        /// <summary>
        /// Имя пакета — то же, что в его <c>package.json</c>: ассеты пакета Unity адресует как
        /// <c>Packages/&lt;имя&gt;/…</c>.
        /// </summary>
        public const string PackageName = "com.machine-eyes.ui-eye";

        public const string Folder = "Packages/" + PackageName + "/Editor";

        public const string DefaultTheme = Folder + "/UiEyeTheme.tss";

        private static UiEyeRegistry _registry;

        /// <summary>
        /// Реестр проекта. Собирается при первом обращении; вход в Play Mode перезагружает домен и обнуляет статику —
        /// тогда реестр собирается заново из тех же методов.
        /// </summary>
        public static UiEyeRegistry Registry
        {
            get
            {
                if (_registry == null)
                {
                    _registry = Collect(
                        UnityEditor.TypeCache.GetMethodsWithAttribute<UiEyePanelAttribute>(),
                        Path.GetDirectoryName(UnityEngine.Application.dataPath));
                }

                return _registry;
            }
        }

        /// <summary>
        /// Собирает реестр из методов с атрибутом: вызывает каждый и проверяет, что вышло. Unity здесь не нужна — так
        /// реестр проверяется и вне редактора.
        /// </summary>
        /// <param name="methods">Методы с <see cref="UiEyePanelAttribute"/>, в любом порядке.</param>
        /// <param name="projectRoot">
        /// Корень проекта: пути в отказах — от него; <c>null</c> — как их назвал компилятор. Файлы самого пакета — всегда
        /// <c>Packages/&lt;имя&gt;/…</c>.
        /// </param>
        public static UiEyeRegistry Collect(IEnumerable<MethodInfo> methods, string projectRoot)
        {
            var ordered = new List<MethodInfo>(methods);
            ordered.Sort(CompareMethods);

            var problems = new List<string>();
            var places = new Dictionary<string, List<string>>(StringComparer.Ordinal);
            var found = new Dictionary<string, UiEyePanel>(StringComparer.Ordinal);

            foreach (var method in ordered)
            {
                var place = Place(method, projectRoot);
                var shape = ShapeProblems(method);

                if (shape.Count > 0)
                {
                    problems.Add(place + ": [UiEyePanel] ждёт статический метод без параметров, который возвращает UiEyePanel, — а этот "
                        + string.Join(", ", shape));
                    continue;
                }

                UiEyePanel panel;

                try
                {
                    panel = (UiEyePanel)method.Invoke(null, null);
                }
                catch (Exception exception)
                {
                    var cause = exception is TargetInvocationException && exception.InnerException != null
                        ? exception.InnerException
                        : exception;
                    problems.Add(place + ": бросил " + cause.GetType().Name + ": " + cause.Message);
                    continue;
                }

                if (panel == null)
                {
                    problems.Add(place + ": вернул null");
                    continue;
                }

                if (string.IsNullOrWhiteSpace(panel.Name))
                {
                    problems.Add(place + ": у панели пустое имя");
                    continue;
                }

                List<string> same;

                if (!places.TryGetValue(panel.Name, out same))
                {
                    same = new List<string>();
                    places.Add(panel.Name, same);
                    found.Add(panel.Name, panel);
                }

                same.Add(place);
            }

            var names = new List<string>(places.Keys);
            names.Sort(StringComparer.Ordinal);
            var panels = new List<UiEyePanel>();

            foreach (var name in names)
            {
                if (places[name].Count == 1)
                {
                    panels.Add(found[name]);
                }
                else
                {
                    problems.Add("имя панели «" + name + "» — у " + places[name].Count + " методов: " + string.Join("; ", places[name]));
                }
            }

            if (ordered.Count == 0)
            {
                problems.Add("ни одного метода с [UiEyePanel]: панель регистрируется статическим методом без параметров, который "
                    + "возвращает UiEyePanel и помечен [UiEyePanel], — образец: " + Folder + "/Probe/UiEyeProbe.cs");
            }

            return new UiEyeRegistry(panels, problems);
        }

        private static List<string> ShapeProblems(MethodInfo method)
        {
            var shape = new List<string>();

            if (!method.IsStatic)
            {
                shape.Add("не статический");
            }

            if (method.ContainsGenericParameters)
            {
                shape.Add("обобщённый");
            }

            if (method.GetParameters().Length > 0)
            {
                shape.Add("с параметрами");
            }

            if (method.ReturnType != typeof(UiEyePanel))
            {
                shape.Add("возвращает " + method.ReturnType.Name);
            }

            return shape;
        }

        /// <summary>
        /// «Тип.Метод (файл:строка)»; файл самого пакета — так, как его зовёт Unity (<c>Packages/&lt;имя&gt;/…</c>), прочий — от
        /// корня проекта, если он внутри.
        /// </summary>
        private static string Place(MethodInfo method, string projectRoot)
        {
            var mark = method.GetCustomAttribute<UiEyePanelAttribute>();
            var where = mark == null || string.IsNullOrEmpty(mark.FilePath)
                ? "файл неизвестен"
                : FromRoot(mark.FilePath, projectRoot) + ":" + mark.LineNumber;

            return TypeName(method) + "." + method.Name + " (" + where + ")";
        }

        private static string FromRoot(string path, string projectRoot)
        {
            var forward = Forward(path);
            var editor = EditorSource();

            // Сперва пакет: пакет из file: лежит вне проекта, а встроенный и Library/PackageCache — внутри, и от корня проекта
            // путь вышел бы не тем, каким Unity зовёт файл.
            if (editor.Length > 0 && forward.StartsWith(editor, StringComparison.OrdinalIgnoreCase))
            {
                return Folder + "/" + forward.Substring(editor.Length);
            }

            if (string.IsNullOrEmpty(projectRoot))
            {
                return forward;
            }

            var root = Forward(projectRoot).TrimEnd('/') + "/";
            return forward.StartsWith(root, StringComparison.OrdinalIgnoreCase) ? forward.Substring(root.Length) : forward;
        }

        /// <summary>
        /// Папка <c>Editor/</c> пакета — так, как компилятор назвал этот файл, с «/» на конце; пусто — компилятор пути не дал.
        /// Путь того же вида, что у атрибута панели в файле пакета.
        /// </summary>
        /// <remarks>Файл лежит в корне <c>Editor/</c>: перенос его в подпапку сдвинет и эту папку.</remarks>
        private static string EditorSource([CallerFilePath] string path = "")
        {
            var forward = Forward(path);
            var slash = forward.LastIndexOf('/');
            return slash > 0 ? forward.Substring(0, slash + 1) : string.Empty;
        }

        private static string Forward(string path) => path.Replace(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);

        private static string TypeName(MethodInfo method) =>
            method.DeclaringType == null ? "?" : method.DeclaringType.FullName ?? method.DeclaringType.Name;

        private static int CompareMethods(MethodInfo left, MethodInfo right)
        {
            var byType = string.CompareOrdinal(TypeName(left), TypeName(right));

            if (byType != 0)
            {
                return byType;
            }

            var byName = string.CompareOrdinal(left.Name, right.Name);

            if (byName != 0)
            {
                return byName;
            }

            var byAssembly = string.CompareOrdinal(left.Module.Assembly.GetName().Name, right.Module.Assembly.GetName().Name);
            return byAssembly != 0 ? byAssembly : left.MetadataToken.CompareTo(right.MetadataToken);
        }
    }

    /// <summary>Заполнители состояний: промах по имени элемента — громкая ошибка, а не пустое место.</summary>
    public static class UiEyeFill
    {
        public static void Text(VisualElement root, string name, string text)
        {
            Find<TextElement>(root, name).text = text;
        }

        public static void AddClass(VisualElement root, string name, string className)
        {
            Find<VisualElement>(root, name).AddToClassList(className);
        }

        private static T Find<T>(VisualElement root, string name)
            where T : VisualElement
        {
            var element = root.Q(name);

            if (element == null)
            {
                throw new UiEyeFixtureException("в разметке нет элемента #" + name);
            }

            var typed = element as T;

            if (typed == null)
            {
                throw new UiEyeFixtureException(
                    "#" + name + " — это " + element.GetType().Name + ", а состояние ждёт " + typeof(T).Name);
            }

            return typed;
        }
    }

    /// <summary>Состояние не сходится с разметкой: элемента нет или он другого типа.</summary>
    public sealed class UiEyeFixtureException : Exception
    {
        public UiEyeFixtureException(string message)
            : base(message)
        {
        }
    }
}
