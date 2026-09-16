using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

using UnityEditor;
using UnityEngine;
using UnityEngine.UIElements;

namespace UiEye
{
    /// <summary>
    /// Таблица типов UI Toolkit для линтера ui-eye: какой элемент чей потомок и как он зовётся в UXML.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Линтер (<c>Tools~/linter.js</c>) сверяет имена в разметке с обращениями кода без Unity. Чтобы сказать
    /// «код ждёт <c>Label</c>, а в разметке <c>Button</c>», ему нужны предки каждого элемента — и такие, какие знает
    /// эта версия Unity, а не написанные по памяти. Поэтому таблицу снимает сама Unity.
    /// </para>
    /// <para>
    /// Снимается попутно каждым снимком: <see cref="UiEyeShooter"/> в начале <c>Run</c> зовёт <see cref="Snap"/> и
    /// <see cref="Write"/>, если запускатель передал <c>-uieyeTypesOut</c>; в проект таблицу кладёт запускатель, когда
    /// она новая или другая. Явно — <c>node Tools~/types.js</c>: <c>Unity.exe -batchmode -projectPath … -executeMethod
    /// UiEye.UiEyeTypes.Dump -uieyeTypesOut &lt;файл&gt;</c>; из Unity выходит сам метод.
    /// </para>
    /// </remarks>
    public static class UiEyeTypes
    {
        public const int ExitDone = 0;
        public const int ExitBadRequest = 15;
        public const int ExitException = 17;

        private static readonly string[] Namespaces = { "UnityEngine.UIElements", "UnityEditor.UIElements" };

        public static void Dump()
        {
            var path = Argument("-uieyeTypesOut");

            if (string.IsNullOrEmpty(path))
            {
                Debug.LogError("ui-eye: нет аргумента -uieyeTypesOut <путь к файлу таблицы>");
                EditorApplication.Exit(ExitBadRequest);
                return;
            }

            try
            {
                var dump = Snap();
                Write(dump, path);
                Debug.Log("ui-eye: таблица типов UI Toolkit — " + dump.types.Count + " типов, Unity " + dump.unityVersion + " → " + path);
                EditorApplication.Exit(ExitDone);
            }
            catch (Exception exception)
            {
                Debug.LogError("ui-eye: таблица типов не снята: " + exception);
                EditorApplication.Exit(ExitException);
            }
        }

        /// <summary>Таблица этой Unity: публичные элементы UI Toolkit с предками, по имени.</summary>
        public static UiEyeTypesDump Snap()
        {
            var dump = new UiEyeTypesDump { unityVersion = Application.unityVersion };
            var types = new List<Type>(TypeCache.GetTypesDerivedFrom(typeof(VisualElement))) { typeof(VisualElement) };

            foreach (var type in types)
            {
                if (IsListed(type))
                {
                    dump.types.Add(Describe(type));
                }
            }

            dump.types.Sort((a, b) => string.CompareOrdinal(a.name, b.name));
            return dump;
        }

        /// <summary>Записать таблицу в файл: JSON, UTF-8 без BOM.</summary>
        public static void Write(UiEyeTypesDump dump, string path)
        {
            File.WriteAllText(Path.GetFullPath(path), JsonUtility.ToJson(dump, true), new UTF8Encoding(false));
        }

        private static bool IsListed(Type type)
        {
            var visible = type.IsNested ? type.IsNestedPublic : type.IsPublic;

            if (!visible)
            {
                return false;
            }

            var space = type.Namespace ?? string.Empty;

            foreach (var prefix in Namespaces)
            {
                if (space == prefix || space.StartsWith(prefix + ".", StringComparison.Ordinal))
                {
                    return true;
                }
            }

            return false;
        }

        private static UiEyeTypeInfo Describe(Type type)
        {
            var bases = new List<string>();

            for (var current = type.BaseType; current != null && current != typeof(object); current = current.BaseType)
            {
                bases.Add(Name(current));

                if (current == typeof(VisualElement))
                {
                    break;
                }
            }

            var element = (UxmlElementAttribute)Attribute.GetCustomAttribute(type, typeof(UxmlElementAttribute), false);

            return new UiEyeTypeInfo
            {
                name = Name(type),
                bases = bases.ToArray(),
                uxmlName = element == null ? string.Empty : (string.IsNullOrEmpty(element.name) ? type.Name : element.name),
                legacyFactory = type.GetNestedType("UxmlFactory") != null,
                isAbstract = type.IsAbstract,
                isGeneric = type.IsGenericTypeDefinition,
                editorOnly = (type.Namespace ?? string.Empty).StartsWith("UnityEditor", StringComparison.Ordinal),
            };
        }

        /// <summary>Полное имя без сборки; у обобщённого — имя определения (<c>BaseField`1</c>), у вложенного — через точку.</summary>
        private static string Name(Type type)
        {
            var definition = type.IsGenericType ? type.GetGenericTypeDefinition() : type;
            return (definition.FullName ?? definition.Name).Replace('+', '.');
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
    }

    /// <summary>Ответ <see cref="UiEyeTypes.Dump"/>. Поля строчными: пишет JsonUtility, читает JavaScript.</summary>
    [Serializable]
    public sealed class UiEyeTypesDump
    {
        public string unityVersion;

        public List<UiEyeTypeInfo> types = new List<UiEyeTypeInfo>();
    }

    [Serializable]
    public sealed class UiEyeTypeInfo
    {
        /// <summary>Полное имя: <c>UnityEngine.UIElements.Label</c>.</summary>
        public string name;

        /// <summary>Предки от ближнего до <c>VisualElement</c> включительно.</summary>
        public string[] bases;

        /// <summary>Имя в UXML по <c>[UxmlElement]</c>; пусто — атрибута нет.</summary>
        public string uxmlName;

        /// <summary>Есть вложенный <c>UxmlFactory</c> — старый способ объявить элемент для UXML.</summary>
        public bool legacyFactory;

        public bool isAbstract;

        public bool isGeneric;

        /// <summary>Из <c>UnityEditor.UIElements</c>: в игре недоступен.</summary>
        public bool editorOnly;
    }
}
