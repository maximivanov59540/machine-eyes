using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;

using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.UIElements;

namespace UiEye
{
    /// <summary>
    /// Съёмщик ui-eye: один батч-запуск редактора снимает панель во всех запрошенных состояниях и
    /// размерах — кадры PNG, дерево с числами, находки, контактный лист — и сам выходит из Unity.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Запускает его не человек, а запускатель из <c>Tools~</c> пакета:
    /// <c>Unity.exe -batchmode -projectPath … -logFile … -executeMethod UiEye.UiEyeShooter.Run
    /// -uieyeRequest &lt;папка&gt;/request.json -uieyeTypesOut &lt;папка&gt;/types.json</c> — без <c>-quit</c>: выход
    /// делает съёмщик, когда закончил или сработал сторож. Ответ — <c>result.json</c> рядом с запросом; договор —
    /// <see cref="UiEyeResult"/>. Таблица типов UI Toolkit — попутно, в самом начале (<see cref="UiEyeTypes.Snap"/>).
    /// </para>
    /// <para>
    /// ⚠️ При входе в Play Mode домен перезагружается (<c>EditorSettings: m_EnterPlayModeOptions: 0</c>), и вся
    /// статика здесь обнуляется. Переживает перезагрузку только <see cref="SessionState"/>: в нём путь запроса,
    /// время старта и сторож; остальное после входа читается из запроса заново. В обычном редакторе
    /// ключей нет — статический конструктор ничего не делает.
    /// </para>
    /// </remarks>
    [InitializeOnLoad]
    public static class UiEyeShooter
    {
        public const int ExitShots = 0;
        public const int ExitWatchdog = 14;
        public const int ExitBadRequest = 15;
        public const int ExitPanel = 16;
        public const int ExitException = 17;

        private const string RequestKey = "UiEye.Request";
        private const string StartKey = "UiEye.StartTicks";
        private const string WatchdogKey = "UiEye.WatchdogSeconds";
        private const int DefaultWatchdogSeconds = 180;
        private const string DefaultSize = "1920x1080";

        // Шрифтовой атлас наполняется лениво: кадр читается, пока два чтения подряд
        // не совпадут и пикселями, и деревом.
        private const int FirstReadAfterFrames = 3;
        private const int ReadEveryFrames = 2;
        private const int MaxReads = 15;

        private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);
        private static readonly List<Job> Jobs = new List<Job>();
        private static readonly List<UiEyeState> States = new List<UiEyeState>();
        private static readonly List<Vector2Int> Sizes = new List<Vector2Int>();
        private static readonly List<UiEyeSheetCell> Cells = new List<UiEyeSheetCell>();

        private static Phase _phase;
        private static string _requestPath;
        private static UiEyeRequest _request;
        private static UiEyePanel _panel;
        private static UiEyeResult _result;
        private static int _index;
        private static int _mark;
        private static int _reads;
        private static bool _settled;
        private static string _previousPixels;
        private static string _previousTree;
        private static GameObject _host;
        private static UIDocument _document;
        private static PanelSettings _settings;
        private static RenderTexture _texture;
        private static Texture2D _readback;
        private static UiEyeTreeReport _tree;

        static UiEyeShooter()
        {
            if (string.IsNullOrEmpty(SessionState.GetString(RequestKey, string.Empty)))
            {
                return;
            }

            EditorApplication.update -= Tick;
            EditorApplication.update += Tick;
        }

        private enum Phase
        {
            Start,
            Apply,
            Settle,
            SheetSettle,
            Done,
        }

        /// <summary>
        /// Таблица типов UI Toolkit попутно: запускатель передал <c>-uieyeTypesOut</c> — снять и записать до разбора запроса,
        /// чтобы таблица была и у плохого запроса. Сверяет её и кладёт в проект запускатель; сбой снимок не останавливает.
        /// </summary>
        private static void SnapTypes()
        {
            var path = Argument("-uieyeTypesOut");

            if (string.IsNullOrEmpty(path))
            {
                return;
            }

            try
            {
                var dump = UiEyeTypes.Snap();
                UiEyeTypes.Write(dump, path);
                Note("таблица типов: " + dump.types.Count + " типов, Unity " + dump.unityVersion);
            }
            catch (Exception exception)
            {
                Note("таблица типов не снята: " + exception.GetType().Name + ": " + exception.Message);
            }
        }

        public static void Run()
        {
            var path = Argument("-uieyeRequest");

            if (string.IsNullOrEmpty(path))
            {
                Debug.LogError("ui-eye: нет аргумента -uieyeRequest <путь к request.json>");
                EditorApplication.Exit(ExitBadRequest);
                return;
            }

            try
            {
                _requestPath = Path.GetFullPath(path);
                File.WriteAllText(ReportPath(), string.Empty, Utf8);
                Note("запуск: Unity " + Application.unityVersion + ", батч " + Application.isBatchMode + ", устройство "
                    + SystemInfo.graphicsDeviceType + ", цвет " + QualitySettings.activeColorSpace);
                SnapTypes();

                if (!Prepare())
                {
                    return;
                }

                if (_request.list)
                {
                    Finish("list", ExitShots, "панелей в реестре: " + UiEyePanels.Registry.Panels.Count);
                    return;
                }

                var watchdog = _request.watchdogSeconds > 0 ? _request.watchdogSeconds : DefaultWatchdogSeconds;
                SessionState.SetString(RequestKey, _requestPath);
                SessionState.SetString(StartKey, DateTime.UtcNow.Ticks.ToString(CultureInfo.InvariantCulture));
                SessionState.SetInt(WatchdogKey, watchdog);

                EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
                EditorApplication.EnterPlaymode();
                Note("запуск: запрошен вход в Play Mode, кадров к съёмке " + Jobs.Count + ", сторож " + watchdog + " с");
            }
            catch (Exception exception)
            {
                Finish("exception", ExitException, "запуск: " + exception);
            }
        }

        private static void Tick()
        {
            if (_phase == Phase.Done)
            {
                return;
            }

            try
            {
                var watchdog = SessionState.GetInt(WatchdogKey, DefaultWatchdogSeconds);

                if (Elapsed().TotalSeconds > watchdog)
                {
                    Finish("watchdog", ExitWatchdog, "сторож: " + watchdog + " с истекли; фаза " + _phase + ", кадр "
                        + (_index + 1) + " из " + Jobs.Count + ", Play Mode " + EditorApplication.isPlaying);
                    return;
                }

                if (!EditorApplication.isPlaying)
                {
                    return;
                }

                switch (_phase)
                {
                    case Phase.Start:
                        _requestPath = SessionState.GetString(RequestKey, string.Empty);
                        Note("play mode: вход через " + (long)Elapsed().TotalMilliseconds + " мс");

                        if (Prepare())
                        {
                            _index = 0;
                            BuildShot();
                        }

                        break;

                    case Phase.Apply:
                        if (Time.frameCount - _mark >= 1)
                        {
                            try
                            {
                                Jobs[_index].State.Apply(_document.rootVisualElement);
                            }
                            catch (UiEyeFixtureException exception)
                            {
                                Finish("panel", ExitPanel, "состояние «" + Jobs[_index].State.Name + "» панели «" + _panel.Name
                                    + "» не сходится с разметкой: " + exception.Message);
                                return;
                            }

                            StartReading();
                            _phase = Phase.Settle;
                        }

                        break;

                    case Phase.Settle:
                        if (Read(withTree: true))
                        {
                            SaveShot();
                            Teardown();
                            _index++;

                            if (_index < Jobs.Count)
                            {
                                BuildShot();
                            }
                            else
                            {
                                BuildSheet();
                            }
                        }

                        break;

                    case Phase.SheetSettle:
                        if (Read(withTree: false))
                        {
                            SaveSheet();
                            Teardown();
                            var withFindings = 0;

                            foreach (var shot in _result.shots)
                            {
                                withFindings += shot.findings.Count > 0 ? 1 : 0;
                            }

                            Finish("shots", ExitShots, "кадров " + _result.shots.Count + ", из них с находками " + withFindings);
                        }

                        break;
                }
            }
            catch (Exception exception)
            {
                Finish("exception", ExitException, "фаза " + _phase + ": " + exception);
            }
        }

        /// <summary>Читает и проверяет запрос; при ошибке пишет ответ и выходит. Зовётся до Play Mode и после входа.</summary>
        private static bool Prepare()
        {
            _result = new UiEyeResult
            {
                unityVersion = Application.unityVersion,
                graphicsDevice = SystemInfo.graphicsDeviceType + " / " + SystemInfo.graphicsDeviceName,
                colorSpace = QualitySettings.activeColorSpace.ToString(),
                scaleMode = "ConstantPixelSize x1",
            };

            var registry = UiEyePanels.Registry;

            foreach (var known in registry.Panels)
            {
                _result.knownPanels.Add(Describe(known));
            }

            try
            {
                _request = JsonUtility.FromJson<UiEyeRequest>(File.ReadAllText(_requestPath, Utf8));
            }
            catch (Exception exception)
            {
                Finish("bad-request", ExitBadRequest, "запрос не прочитан (" + _requestPath + "): " + exception.Message);
                return false;
            }

            if (_request == null)
            {
                Finish("bad-request", ExitBadRequest, "запрос пуст: " + _requestPath);
                return false;
            }

            _result.head = _request.head;

            if (registry.Problems.Count > 0)
            {
                Finish("bad-request", ExitBadRequest, "реестр ui-eye не собран: " + string.Join(" · ", registry.Problems));
                return false;
            }

            if (_request.list)
            {
                return true;
            }

            _panel = registry.Find(_request.panel);

            if (_panel == null)
            {
                Finish("bad-request", ExitBadRequest, "нет панели «" + _request.panel + "». Известные: " + PanelNames() + ".");
                return false;
            }

            _result.panel = _panel.Name;
            States.Clear();

            if (_request.states == null || _request.states.Length == 0)
            {
                States.AddRange(_panel.States);
            }
            else
            {
                foreach (var name in _request.states)
                {
                    var state = _panel.FindState(name);

                    if (state == null)
                    {
                        Finish("bad-request", ExitBadRequest, "у панели «" + _panel.Name + "» нет состояния «" + name
                            + "». Есть: " + StateNames(_panel) + ".");
                        return false;
                    }

                    States.Add(state);
                }
            }

            Sizes.Clear();
            var sizeTexts = _request.sizes == null || _request.sizes.Length == 0 ? new[] { DefaultSize } : _request.sizes;

            foreach (var text in sizeTexts)
            {
                Vector2Int size;

                if (!TryParseSize(text, out size))
                {
                    Finish("bad-request", ExitBadRequest, "размер «" + text + "» не понят: нужно «ширинаxвысота», от 320 до 7680.");
                    return false;
                }

                Sizes.Add(size);
            }

            if (AssetDatabase.LoadAssetAtPath<VisualTreeAsset>(_panel.Markup) == null)
            {
                Finish("panel", ExitPanel, "разметка панели «" + _panel.Name + "» не загрузилась: " + _panel.Markup);
                return false;
            }

            if (AssetDatabase.LoadAssetAtPath<ThemeStyleSheet>(_panel.Theme) == null)
            {
                Finish("panel", ExitPanel, "тема панели «" + _panel.Name + "» не загрузилась: " + _panel.Theme);
                return false;
            }

            HashAssets();

            Jobs.Clear();
            var stateNames = new List<string>();
            var sizeNames = new List<string>();

            foreach (var state in States)
            {
                stateNames.Add(state.Name);

                foreach (var size in Sizes)
                {
                    Jobs.Add(new Job(state, size));
                }
            }

            foreach (var size in Sizes)
            {
                sizeNames.Add(size.x + "x" + size.y);
            }

            _result.states = stateNames.ToArray();
            _result.sizes = sizeNames.ToArray();
            return true;
        }

        /// <summary>Хеш файлов, которые реально загружены: разметка, её стили, тема. Это и есть подпись вида.</summary>
        private static void HashAssets()
        {
            var paths = new List<string>(AssetDatabase.GetDependencies(new[] { _panel.Markup, _panel.Theme }, true));
            paths.Sort(StringComparer.Ordinal);
            var root = Path.GetDirectoryName(Application.dataPath);
            var combined = new StringBuilder();

            foreach (var path in paths)
            {
                var full = Path.Combine(root, path);
                var sha = File.Exists(full) ? Sha(File.ReadAllBytes(full)) : "встроенный";
                _result.assets.Add(new UiEyeAssetInfo { path = path, sha256 = sha });
                combined.Append(path).Append(' ').Append(sha).Append('\n');
            }

            _result.markupHash = Sha(Utf8.GetBytes(combined.ToString()));
        }

        private static void BuildShot()
        {
            BuildDocument(Jobs[_index].Size, null);
            _mark = Time.frameCount;
            _phase = Phase.Apply;
        }

        private static void BuildSheet()
        {
            var header = "ui-eye · «" + _panel.Name + "» · HEAD " + Short(_request.head) + " · разметка "
                + Short(_result.markupHash) + " · Unity " + Application.unityVersion + " · масштаб 1:1";
            int width;
            int height;
            var sheet = UiEyeSheet.Build(header, States.Count, Sizes, Cells, out width, out height);

            BuildDocument(new Vector2Int(width, height), sheet);
            StartReading();
            _phase = Phase.SheetSettle;
        }

        private static void BuildDocument(Vector2Int size, VisualElement content)
        {
            var linear = QualitySettings.activeColorSpace == ColorSpace.Linear;
            // Буфер глубины 24 бита — с ним у Unity есть и трафарет: им UI Toolkit обрезает overflow: hidden со скруглением.
            // Без трафарета такая маска выходит белым прямоугольником, а в игре (рисует на экран) — нет.
            _texture = new RenderTexture(size.x, size.y, 24, RenderTextureFormat.ARGB32,
                linear ? RenderTextureReadWrite.sRGB : RenderTextureReadWrite.Linear);
            _texture.Create();
            _readback = new Texture2D(size.x, size.y, TextureFormat.RGBA32, false);

            _settings = ScriptableObject.CreateInstance<PanelSettings>();
            _settings.themeStyleSheet = AssetDatabase.LoadAssetAtPath<ThemeStyleSheet>(_panel.Theme);
            _settings.targetTexture = _texture;
            _settings.scaleMode = PanelScaleMode.ConstantPixelSize;
            _settings.scale = 1f;
            _settings.clearColor = true;
            _settings.colorClearValue = new Color(0.05f, 0.05f, 0.05f, 1f);

            _host = new GameObject("UiEye");
            _host.SetActive(false);
            _document = _host.AddComponent<UIDocument>();
            _document.panelSettings = _settings;

            if (content == null)
            {
                _document.visualTreeAsset = AssetDatabase.LoadAssetAtPath<VisualTreeAsset>(_panel.Markup);
            }

            _host.SetActive(true);

            if (content != null)
            {
                _document.rootVisualElement.Add(content);
            }
        }

        private static void StartReading()
        {
            _mark = Time.frameCount;
            _reads = 0;
            _settled = false;
            _previousPixels = null;
            _previousTree = null;
        }

        /// <returns>true — кадр устоялся или попытки кончились (<see cref="_settled"/> скажет, что именно).</returns>
        private static bool Read(bool withTree)
        {
            if (Time.frameCount - _mark < (_reads == 0 ? FirstReadAfterFrames : ReadEveryFrames))
            {
                return false;
            }

            _mark = Time.frameCount;
            _reads++;

            var previous = RenderTexture.active;
            RenderTexture.active = _texture;
            _readback.ReadPixels(new Rect(0, 0, _texture.width, _texture.height), 0, 0, false);
            RenderTexture.active = previous;

            var pixels = Sha(_readback.GetRawTextureData());
            var tree = string.Empty;

            if (withTree)
            {
                _tree = UiEyeTree.Capture(_document.rootVisualElement, _texture.width, _texture.height);
                tree = Sha(Utf8.GetBytes(_tree.Text));
            }

            _settled = pixels == _previousPixels && tree == _previousTree;
            _previousPixels = pixels;
            _previousTree = tree;
            return _settled || _reads >= MaxReads;
        }

        private static void SaveShot()
        {
            var job = Jobs[_index];
            var size = job.Size.x + "x" + job.Size.y;
            var name = FileName(job.State.Name) + "_" + size;
            var png = _readback.EncodeToPNG();
            var treeBytes = Utf8.GetBytes(_tree.Text);

            File.WriteAllBytes(Path.Combine(OutputDirectory(), name + ".png"), png);
            File.WriteAllBytes(Path.Combine(OutputDirectory(), name + ".tree.txt"), treeBytes);

            var shot = new UiEyeShotInfo
            {
                state = job.State.Name,
                size = size,
                width = job.Size.x,
                height = job.Size.y,
                png = name + ".png",
                tree = name + ".tree.txt",
                pngSha256 = Sha(png),
                treeSha256 = Sha(treeBytes),
                reads = _reads,
                settled = _settled,
                elements = _tree.Elements,
                checkedElements = _tree.Checked,
                textElements = _tree.TextElements,
            };

            shot.findings.AddRange(_tree.Findings);

            if (!_settled)
            {
                shot.findings.Add(new UiEyeFinding
                {
                    kind = "не-устоялся",
                    element = "кадр",
                    detail = "два чтения подряд не совпали за " + MaxReads + " чтений (переход стиля? анимация?)",
                });
            }

            _result.shots.Add(shot);

            // Кадр переходит листу: там он рисуется как картинка и нужен на видеокарте. Clamp — иначе выборка
            // у левого края миниатюры цепляет правый край кадра (на листе — полоска цвета панели, которой в кадре нет).
            _readback.wrapMode = TextureWrapMode.Clamp;
            _readback.Apply(false);
            Cells.Add(new UiEyeSheetCell
            {
                Caption = job.State.Name + " · " + size + " · "
                    + (shot.findings.Count == 0 ? "находок нет" : "находок: " + shot.findings.Count),
                Image = _readback,
            });
            _readback = null;

            Note("кадр " + name + ": находок " + shot.findings.Count + ", элементов " + shot.elements + ", проверено "
                + shot.checkedElements + ", чтений " + _reads + (_settled ? string.Empty : " (НЕ устоялся)"));
        }

        private static void SaveSheet()
        {
            File.WriteAllBytes(Path.Combine(OutputDirectory(), "sheet.png"), _readback.EncodeToPNG());
            _result.sheet = "sheet.png";
            Note("лист: " + _texture.width + "x" + _texture.height + ", чтений " + _reads + (_settled ? string.Empty : " (НЕ устоялся)"));

            UnityEngine.Object.DestroyImmediate(_readback);
            _readback = null;

            foreach (var cell in Cells)
            {
                UnityEngine.Object.DestroyImmediate(cell.Image);
            }

            Cells.Clear();
        }

        private static void Teardown()
        {
            if (_host != null)
            {
                UnityEngine.Object.DestroyImmediate(_host);
            }

            if (_settings != null)
            {
                UnityEngine.Object.DestroyImmediate(_settings);
            }

            if (_texture != null)
            {
                _texture.Release();
                UnityEngine.Object.DestroyImmediate(_texture);
            }

            _host = null;
            _document = null;
            _settings = null;
            _texture = null;
        }

        private static void Finish(string status, int code, string message)
        {
            _phase = Phase.Done;
            EditorApplication.update -= Tick;
            SessionState.EraseString(RequestKey);
            SessionState.EraseString(StartKey);
            SessionState.EraseInt(WatchdogKey);

            try
            {
                if (_result == null)
                {
                    _result = new UiEyeResult();
                }

                _result.status = status;
                _result.exitCode = code;
                _result.message = message;
                Note("итог: " + status + ", код " + code + " — " + message);
                File.WriteAllText(Path.Combine(OutputDirectory(), "result.json"), JsonUtility.ToJson(_result, true), Utf8);
            }
            catch (Exception exception)
            {
                Debug.LogError("ui-eye: ответ не записан: " + exception);
            }

            EditorApplication.Exit(code);
        }

        private static UiEyePanelInfo Describe(UiEyePanel panel)
        {
            var info = new UiEyePanelInfo { name = panel.Name, description = panel.Description, markup = panel.Markup };

            foreach (var state in panel.States)
            {
                info.states.Add(new UiEyeStateInfo { name = state.Name, description = state.Description });
            }

            return info;
        }

        private static string PanelNames()
        {
            var names = new List<string>();

            foreach (var panel in UiEyePanels.Registry.Panels)
            {
                names.Add("«" + panel.Name + "»");
            }

            return string.Join(", ", names);
        }

        private static string StateNames(UiEyePanel panel)
        {
            var names = new List<string>();

            foreach (var state in panel.States)
            {
                names.Add("«" + state.Name + "»");
            }

            return string.Join(", ", names);
        }

        private static bool TryParseSize(string text, out Vector2Int size)
        {
            size = default(Vector2Int);
            var parts = (text ?? string.Empty).Split('x', 'X', '×');
            int width;
            int height;

            if (parts.Length != 2
                || !int.TryParse(parts[0], NumberStyles.None, CultureInfo.InvariantCulture, out width)
                || !int.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out height)
                || width < 320 || height < 320 || width > 7680 || height > 7680)
            {
                return false;
            }

            size = new Vector2Int(width, height);
            return true;
        }

        private static string FileName(string name)
        {
            var builder = new StringBuilder(name);

            foreach (var invalid in Path.GetInvalidFileNameChars())
            {
                builder.Replace(invalid, '_');
            }

            return builder.ToString();
        }

        private static string Argument(string key)
        {
            var arguments = Environment.GetCommandLineArgs();

            for (var index = 0; index < arguments.Length - 1; index++)
            {
                if (arguments[index] == key)
                {
                    return arguments[index + 1];
                }
            }

            return null;
        }

        private static string OutputDirectory() => Path.GetDirectoryName(_requestPath);

        private static string ReportPath() => Path.Combine(OutputDirectory(), "report.txt");

        private static void Note(string line)
        {
            Debug.Log("ui-eye: " + line);

            try
            {
                File.AppendAllText(ReportPath(),
                    DateTime.UtcNow.ToString("HH:mm:ss.fff", CultureInfo.InvariantCulture) + "  " + line + "\n", Utf8);
            }
            catch (Exception)
            {
                // Журнал Unity строку уже получил; отчёт — удобство, не договор.
            }
        }

        private static TimeSpan Elapsed()
        {
            long ticks;
            var stored = SessionState.GetString(StartKey, string.Empty);

            return long.TryParse(stored, NumberStyles.Integer, CultureInfo.InvariantCulture, out ticks) && ticks > 0
                ? DateTime.UtcNow - new DateTime(ticks, DateTimeKind.Utc)
                : TimeSpan.Zero;
        }

        private static string Short(string value) =>
            string.IsNullOrEmpty(value) ? "?" : value.Substring(0, Math.Min(12, value.Length));

        private static string Sha(byte[] bytes)
        {
            using (var sha = SHA256.Create())
            {
                return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", string.Empty).ToLowerInvariant();
            }
        }

        private sealed class Job
        {
            public Job(UiEyeState state, Vector2Int size)
            {
                State = state;
                Size = size;
            }

            public UiEyeState State { get; }

            public Vector2Int Size { get; }
        }
    }
}
