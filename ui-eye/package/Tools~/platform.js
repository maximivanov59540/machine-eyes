/**
 * ui-eye — всё, что зависит от операционной системы: исключительное открытие файла (калитка, замок проекта), путь к Unity
 * по умолчанию, снятие процесса со всем деревом.
 *
 * Версия 1 — только Windows: на другой ОС снимок и таблица типов отказывают (unsupported), линтер работает везде.
 * Другая ОС добавляется здесь, без правки остального.
 */

import { spawnSync } from "node:child_process";
import { constants, openSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

// UV_FS_O_EXLOCK из libuv: открыть с нулевым режимом совместного доступа. В fs.constants его нет,
// но Node передаёт флаг в libuv как есть. Замер: чужой хэндл даже с общим доступом на
// чтение и запись — EBUSY; без хэндлов — открывается. Пока файл так открыт, другой процесс не откроет его
// и на чтение.
export const EXLOCK = 0x10000000;

/** null — эта ОС поддержана; иначе — причина отказа. */
export function unsupported() {
  return process.platform === "win32"
    ? null
    : `ui-eye версии 1 работает только в Windows, а здесь ${process.platform}: снимок и таблица типов не запускаются (линтер работает)`;
}

/**
 * Открыть файл исключительно: пока дескриптор открыт, другой процесс не откроет файл вовсе.
 *
 * @returns {number | null} дескриптор; null — файл держит другой хэндл (EBUSY). Прочие ошибки бросаются.
 */
export function openExclusive(path, create) {
  try {
    return openSync(path, constants.O_RDWR | (create ? constants.O_CREAT : 0) | EXLOCK);
  } catch (error) {
    if (error.code === "EBUSY") {
      return null;
    }

    throw error;
  }
}

/** Unity нужной версии там, куда её ставит Unity Hub по умолчанию. */
export function defaultUnity(version) {
  return join("C:\\Program Files\\Unity\\Hub\\Editor", version, "Editor", "Unity.exe");
}

/** Снять процесс вместе со всеми дочерними. */
export function killTree(pid) {
  spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
}
