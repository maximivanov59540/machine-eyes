namespace Calibration.NoEngine
{
    /// <summary>
    /// Сборка без движка (<c>noEngineReferences</c>): UI Toolkit ей не виден, и линтер ui-eye её файлы только считает, не
    /// сканирует. Калибровка проверяет это наложением файла с <c>Q()</c> (<c>calibrate.js --сборка-без-движка</c>). Тип
    /// нужен, чтобы сборка не была пустой.
    /// </summary>
    internal static class NoEngineMarker
    {
    }
}
