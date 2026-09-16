using System;
using System.Collections.Generic;

namespace UiEye
{
    // Договор между съёмщиком (Unity) и запускателем (Tools~ пакета). Поля — строчными буквами,
    // потому что их пишет и читает JsonUtility, а на той стороне — JavaScript.

    /// <summary>Запрос: файл <c>request.json</c>; результаты ложатся в ту же папку.</summary>
    [Serializable]
    public sealed class UiEyeRequest
    {
        public int version;

        public string panel;

        /// <summary>Пусто — все состояния панели.</summary>
        public string[] states;

        /// <summary>«ширинаxвысота», например <c>1920x1080</c>.</summary>
        public string[] sizes;

        /// <summary>Только перечислить панели и состояния, ничего не снимая.</summary>
        public bool list;

        public int watchdogSeconds;

        /// <summary>Коммит, на котором запущен снимок, — для подписи на листе. Пишет запускатель.</summary>
        public string head;
    }

    /// <summary>Ответ съёмщика: файл <c>result.json</c>.</summary>
    [Serializable]
    public sealed class UiEyeResult
    {
        /// <summary><c>shots</c> · <c>list</c> · <c>bad-request</c> · <c>panel</c> · <c>watchdog</c> · <c>exception</c>.</summary>
        public string status;

        public string message;

        public int exitCode;

        public string unityVersion;

        public string graphicsDevice;

        public string colorSpace;

        public string scaleMode;

        public string panel;

        public string[] states;

        public string[] sizes;

        public string head;

        /// <summary>Один хеш на все файлы разметки, темы и стилей, которые реально загружены.</summary>
        public string markupHash;

        public List<UiEyeAssetInfo> assets = new List<UiEyeAssetInfo>();

        public List<UiEyeShotInfo> shots = new List<UiEyeShotInfo>();

        public string sheet;

        public List<UiEyePanelInfo> knownPanels = new List<UiEyePanelInfo>();
    }

    [Serializable]
    public sealed class UiEyeAssetInfo
    {
        public string path;

        public string sha256;
    }

    [Serializable]
    public sealed class UiEyeShotInfo
    {
        public string state;

        public string size;

        public int width;

        public int height;

        /// <summary>Имена файлов относительно папки запроса.</summary>
        public string png;

        public string tree;

        public string pngSha256;

        public string treeSha256;

        /// <summary>Сколько раз читался кадр, пока два чтения подряд не совпали.</summary>
        public int reads;

        public bool settled;

        public int elements;

        /// <summary>Охват: элементов, видимых и потому проверенных.</summary>
        public int checkedElements;

        public int textElements;

        public List<UiEyeFinding> findings = new List<UiEyeFinding>();
    }

    [Serializable]
    public sealed class UiEyeFinding
    {
        /// <summary><c>текст-не-влез</c> · <c>за-краем</c> · <c>за-родителя</c> · <c>нулевой-размер</c> · <c>не-устоялся</c>.</summary>
        public string kind;

        public string element;

        public string detail;
    }

    [Serializable]
    public sealed class UiEyePanelInfo
    {
        public string name;

        public string description;

        public string markup;

        public List<UiEyeStateInfo> states = new List<UiEyeStateInfo>();
    }

    [Serializable]
    public sealed class UiEyeStateInfo
    {
        public string name;

        public string description;
    }
}
