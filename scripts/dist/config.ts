/**
 * Configuración de la distribución (Fase de distribución, Etapa 2 y 2C).
 *
 * Es el **único lugar** donde se fijan las versiones y los hashes de todo lo
 * que la instalación necesita. El script de empaquetado (`scripts/package.ts`),
 * los tests de distribución y el instalador futuro leen de acá; **nunca**
 * consultan `latest`.
 *
 * ## La estrategia (Etapa 2C)
 *
 * VIUrewards **no redistribuye** ejecutables de terceros: el paquete es solo la
 * aplicación (código TS, recursos estáticos y `node_modules` de producción).
 * `node.exe`, `yt-dlp.exe`, `ffmpeg.exe` y `ffprobe.exe` los descarga el
 * instalador **desde la fuente de cada proveedor**, verifica su SHA-256 y los
 * deja en el directorio de datos:
 *
 * ```
 * <VIUREWARDS_DATA_DIR>/
 *   runtime/node.exe          Node.js: lo controla el instalador/actualizador
 *   bin/yt-dlp.exe            herramientas administradas (el dashboard lo actualiza)
 *   bin/ffmpeg.exe
 *   bin/ffprobe.exe
 * ```
 *
 * Por eso este archivo describe **descargas fijadas** (`ManagedTool`), no
 * "assets incluidos en el ZIP".
 *
 * ## Reglas que sostiene este archivo
 *
 * - El runtime de compilación y el que se instala son la MISMA versión
 *   (`NODE_VERSION`): así `better-sqlite3` (binario precompilado, ligado al ABI)
 *   y el soporte nativo de `.ts` se comportan igual. El workflow usa esta misma
 *   versión.
 * - Todo artefacto se verifica contra un **hash fijado acá**, copiado del canal
 *   de publicación del proveedor. Si el hash no coincide, la descarga se
 *   descarta: no hay "última descarga disponible".
 * - **El hash fijado no es una firma digital.** Detecta corrupción y cambios de
 *   archivo respecto de lo que este repositorio fijó; no prueba autoría ni
 *   autenticidad por sí mismo. Ver `docs/distribution.md` §4.
 */

/** Versión de Node.js: runtime de compilación Y runtime que se instala. */
export const NODE_VERSION = "24.22.1";

/** Arquitectura y plataforma soportada (única en esta etapa). */
export const TARGET = { platform: "win32", arch: "x64", label: "win-x64" } as const;

/**
 * ABI de Node (`process.versions.modules`) que corresponde a `NODE_VERSION`.
 *
 * `better-sqlite3` distribuye un binario nativo por ABI: si el `node.exe`
 * instalado no es de este ABI, el binding `win32-x64.node` no carga. Se declara
 * explícitamente y se **comprueba** al empaquetar y en los tests.
 */
export const NODE_ABI = "137";

/**
 * Versión del contrato que el instalador consume (`manifest.json`).
 *
 * El instalador futuro compara este número antes de interpretar
 * `managedTools`: un manifiesto con otra versión no se instala a ciegas.
 */
export const PACKAGE_CONTRACT_VERSION = 1;

export interface PinnedAsset {
  /** Nombre del archivo tal como lo publica el proveedor. */
  file: string;
  /** URL https absoluta y fija (sin `latest`). */
  url: string;
  /** SHA-256 fijado por este repositorio para ese archivo concreto. */
  sha256: string;
  /** De dónde se obtuvo el hash (para la auditoría del manifiesto). */
  checksumSource: string;
}

/** Identificador estable de cada herramienta administrada. */
export type ManagedToolId = "node" | "yt-dlp" | "ffmpeg";

/**
 * Política de instalación cuando el destino ya existe.
 *
 * - `if-missing`: nunca se sobrescribe. Es la política de las herramientas que
 *   el usuario puede haber actualizado (yt-dlp desde el dashboard).
 * - `match-manifest`: se reemplaza solo si el archivo instalado no coincide con
 *   la versión/hash del manifiesto. Lo controla la aplicación (Node).
 */
export type InstallPolicy = "if-missing" | "match-manifest";

export interface ManagedTool {
  id: ManagedToolId;
  /** Versión exacta que debe quedar instalada. */
  version: string;
  /** Descarga fijada (archivo, URL y SHA-256). */
  asset: PinnedAsset;
  /**
   * Archivos que se extraen del artefacto y su ruta relativa **dentro del
   * directorio de datos**. Nunca se extrae el archivo completo.
   */
  install: { from: string; to: string }[];
  /** Archivos de aviso/licencia que se dejan junto a los binarios instalados. */
  notices: { from: string; to: string }[];
  /** Qué hace la instalación si el destino ya existe. */
  policy: InstallPolicy;
  /**
   * SHA-256 de cada archivo **instalado** (destino → hash), para las políticas
   * que necesitan comparar el estado real con el esperado.
   *
   * `asset.sha256` es el hash del ARTEFACTO descargado (el ZIP), y uno de los
   * archivos extraídos (por ejemplo `node.exe`) nunca coincide con él. Sin este
   * mapa, `match-manifest` rechazaba una instalación válida en cada reintento.
   * Es obligatorio para `match-manifest` y opcional para `if-missing`.
   */
  installedSha256?: Record<string, string>;
  /** Qué componente de VIUrewards actualiza la herramienta después. */
  updatedBy: "installer" | "dashboard";
  /**
   * Si la descarga directa del proveedor no elimina las obligaciones de
   * licencia del artefacto. Se documenta en el manifiesto y en el README.
   */
  licenseNote: string;
}

const GITHUB_YTDLP = "https://github.com/yt-dlp/yt-dlp/releases/download";

/** yt-dlp: ejecutable único de Windows x64 (release inmutable). */
export const YTDLP_VERSION = "2026.10.21";

export const YTDLP_ASSET: PinnedAsset = {
  file: "yt-dlp.exe",
  url: `${GITHUB_YTDLP}/${YTDLP_VERSION}/yt-dlp.exe`,
  // Tomado de https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.21/SHA2-256SUMS
  sha256: "33121d192d706e62f684a06f80918e3f3a8ba52ac3a65213b6951c39c7d9f555",
  checksumSource: `${GITHUB_YTDLP}/${YTDLP_VERSION}/SHA2-256SUMS`,
};

/**
 * FFmpeg: compilación **externa** de Windows («release essentials») publicada
 * por **gyan.dev**, un sitio de terceros que la página de descargas de
 * FFmpeg.org enlaza. **No es el repositorio upstream de FFmpeg.**
 *
 * Se mantiene exactamente la compilación que ya se probó con VIUrewards
 * (`libx264` + `aac` + `loudnorm` + `scale`, que es lo que usan
 * `src/media/args.ts`). No se cambia de proveedor ni de configuración de codecs.
 *
 * El `.sha256` de gyan se sirve desde el MISMO origen que el ZIP: sirve para
 * fijar la versión y detectar corrupción, **no** como firma independiente.
 */
export const FFMPEG_VERSION = "9.0.2";

export const FFMPEG_ASSET: PinnedAsset = {
  file: "ffmpeg-9.0.2-essentials_build.zip",
  url: "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip",
  sha256: "60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba",
  checksumSource: "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip.sha256",
};

/** Runtime de Node: ZIP oficial para Windows x64. */
export const NODE_ASSET: PinnedAsset = {
  file: `node-v${NODE_VERSION}-${TARGET.label}.zip`,
  url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${TARGET.label}.zip`,
  // https://nodejs.org/dist/v24.22.1/SHASUMS256.txt
  // (nodejs.org publica además SHASUMS256.txt.sig/.asc: una firma GPG que este
  // instalador todavía NO verifica; ver docs/distribution.md §4.)
  sha256: "d2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5",
  checksumSource: `https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`,
};

const NODE_ARCHIVE_ROOT = `node-v${NODE_VERSION}-${TARGET.label}`;
const FFMPEG_ARCHIVE_ROOT = "ffmpeg-9.0.2-essentials_build";

/**
 * Herramientas que el instalador descarga e instala en el directorio de datos.
 *
 * Orden: primero el runtime (lo necesita todo lo demás), después las
 * herramientas de medios.
 */
export const MANAGED_TOOLS: readonly ManagedTool[] = [
  {
    id: "node",
    version: NODE_VERSION,
    asset: NODE_ASSET,
    install: [{ from: `${NODE_ARCHIVE_ROOT}/node.exe`, to: "runtime/node.exe" }],
    notices: [{ from: `${NODE_ARCHIVE_ROOT}/LICENSE`, to: "runtime/LICENSE" }],
    // Hash del `node.exe` ya extraído (el del ZIP no sirve para comparar el
    // archivo instalado). Obtenido de la misma descarga verificada por
    // `asset.sha256`, así que ambos hashes describen el mismo artefacto.
    installedSha256: {
      "runtime/node.exe": "d702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5",
    },
    // El runtime es de la aplicación: se alinea con el manifiesto.
    policy: "match-manifest",
    updatedBy: "installer",
    licenseNote:
      "Node.js se distribuye bajo la licencia MIT. Se descarga del sitio oficial y se instala junto con su archivo LICENSE.",
  },
  {
    id: "yt-dlp",
    version: YTDLP_VERSION,
    asset: YTDLP_ASSET,
    install: [{ from: "yt-dlp.exe", to: "bin/yt-dlp.exe" }],
    // El .exe de PyInstaller incluye CPython y otras bibliotecas.
    notices: [],
    // NUNCA se sobrescribe: el usuario puede haberlo actualizado con el botón
    // del dashboard (Ajustes → Biblioteca y descargas), que es el mecanismo
    // principal.
    policy: "if-missing",
    updatedBy: "dashboard",
    licenseNote:
      "yt-dlp es Unlicense, pero su ejecutable se empaqueta con PyInstaller e incluye componentes con otras licencias: " +
      "con los avisos de https://github.com/yt-dlp/yt-dlp/blob/master/THIRD_PARTY_LICENSES.txt. " +
      "La instalación deja los avisos junto al binario.",
  },
  {
    id: "ffmpeg",
    version: FFMPEG_VERSION,
    asset: FFMPEG_ASSET,
    install: [
      { from: `${FFMPEG_ARCHIVE_ROOT}/bin/ffmpeg.exe`, to: "bin/ffmpeg.exe" },
      { from: `${FFMPEG_ARCHIVE_ROOT}/bin/ffprobe.exe`, to: "bin/ffprobe.exe" },
    ],
    // El ZIP de gyan trae el texto GPLv3 y un README con la procedencia, el
    // commit de FFmpeg y las versiones de las bibliotecas externas.
    notices: [
      { from: `${FFMPEG_ARCHIVE_ROOT}/LICENSE`, to: "bin/ffmpeg-LICENSE.txt" },
      { from: `${FFMPEG_ARCHIVE_ROOT}/README.txt`, to: "bin/ffmpeg-PROCEDENCIA.txt" },
    ],
    policy: "if-missing",
    updatedBy: "installer",
    licenseNote:
      "Compilación externa de gyan.dev (sitio de terceros enlazado por FFmpeg.org; NO es el upstream de FFmpeg), " +
      "GPLv3, estática y con bibliotecas externas incluidas en el binario. El hash fijado NO es una firma digital: " +
      "descargar el binario del proveedor no elimina por sí solo las obligaciones de la GPLv3 para quien lo redistribuya. " +
      "La instalación conserva junto a los binarios el texto GPLv3 y la información de procedencia del paquete original.",
  },
];

/** Busca una herramienta administrada por id (error claro si no existe). */
export function managedTool(id: ManagedToolId): ManagedTool {
  const tool = MANAGED_TOOLS.find((candidate) => candidate.id === id);
  if (!tool) throw new Error(`Herramienta administrada desconocida: ${id}`);
  return tool;
}

/** Nombre del paquete y del ZIP. */
export const PACKAGE_NAME = "VIUrewards";
export const PACKAGE_FLAVOR = `portable-${TARGET.label}`;

/** Nombre del ZIP: `VIUrewards-<version>-portable-win-x64.zip`. */
export function packageFileName(version: string): string {
  return `${PACKAGE_NAME}-${version}-${PACKAGE_FLAVOR}.zip`;
}

/** Nombres del manifiesto, del checksum y del directorio de staging. */
export const MANIFEST_FILE = "manifest.json";
export const CHECKSUM_FILE = "SHA256SUMS.txt";

/**
 * Nombre del arnés IPC de cierre ordenado que se incluye en `app/scripts/dist/`.
 *
 * El test de distribución lo importa con el `node.exe` instalado y es el ÚNICO
 * camino automático para ejercer el cierre ordenado en Windows (ver
 * `docs/distribution.md`).
 */
export const SHUTDOWN_HARNESS_FILE = "shutdown-harness.mjs";

/**
 * Variable que habilita el canal de control del arnés.
 *
 * El arnés solo acepta la orden de cierre si su token coincide EXACTAMENTE con
 * el valor que pasa el test. En el uso normal de VIUrewards nadie define esta
 * variable, así que el canal no es alcanzable: no se agrega ninguna ruta HTTP
 * ni ningún archivo que el usuario pueda disparar.
 */
export const IPC_TOKEN_ENV = "VIUREWARDS_TEST_IPC_TOKEN";

/**
 * Ejecutables que el paquete **nunca** debe contener.
 *
 * La estrategia es que los binarios externos se descarguen al instalar; si
 * alguno se colara en el ZIP, volveríamos a redistribuirlos sin querer.
 */
export const FORBIDDEN_EXECUTABLES = ["node.exe", "yt-dlp.exe", "ffmpeg.exe", "ffprobe.exe"] as const;

/**
 * Segmentos de ruta que el paquete NUNCA debe incluir (datos de usuario, estado
 * de desarrollo o secretos). La verificación los busca en el staging y en el ZIP.
 */
export const FORBIDDEN_PATH_SEGMENTS = [
  ".git",
  ".env",
  ".viurewards.lock",
  "instance.lock",
] as const;

/** Nombres de carpeta de datos que no deben existir dentro del paquete. */
export const FORBIDDEN_TOP_LEVEL = ["data", "media", ".uploads", "logs", "bin", "runtime", "seed-tools"] as const;

/**
 * Rutas que se eliminan de `node_modules` después de `npm ci`.
 *
 * Lista **explícita** y conservadora: nada de globs ni de "borrar carpetas con
 * cierto nombre". Cada entrada se justifica y, si rompe el runtime, el build y
 * los tests de distribución fallan (ver `docs/distribution.md` §2.2).
 *
 * Regla: solo se elimina lo que NO se usa en tiempo de ejecución. Los paquetes
 * que cargan con `require()` o `import` deben quedar completos.
 */
export const NODE_MODULES_PRUNE: readonly string[] = [
  // better-sqlite3: 8 binarios precompilados (uno por plataforma). Windows x64
  // usa `prebuilds/win32-x64.node`; los demás son ~15 MB de otras plataformas.
  "better-sqlite3/prebuilds/darwin-arm64.node",
  "better-sqlite3/prebuilds/darwin-x64.node",
  "better-sqlite3/prebuilds/linux-arm64.node",
  "better-sqlite3/prebuilds/linux-x64.node",
  "better-sqlite3/prebuilds/linuxmusl-arm64.node",
  "better-sqlite3/prebuilds/linuxmusl-x64.node",
  "better-sqlite3/prebuilds/win32-arm64.node",
  // better-sqlite3: fuente de SQLite y archivos de compilación. Solo se usan
  // para construir el módulo; el binario precompilado ya lo contiene.
  "better-sqlite3/deps",
  "better-sqlite3/src",
  "better-sqlite3/build",
  // Tests, documentación, ejemplos y benchmarks de las dependencias:
  // `require()` nunca los carga (se verificó que ningún `.js` de runtime los
  // referenced). Se listan uno por uno, sin patrones.
  "avvio/test",
  "fastify/test",
  "fastify/docs",
  "fastify-plugin/test",
  "fast-json-stringify/test",
  "fastq/test",
  "fast-uri/test",
  "find-my-way/test",
  "find-my-way/benchmark",
  "light-my-request/test",
  "pino/test",
  "pino/docs",
  "pino-abstract-transport/test",
  "pino-std-serializers/test",
  "process-warning/test",
  "sonic-boom/test",
  "thread-stream/test",
  "secure-json-parse/test",
  "secure-json-parse/benchmarks",
  "rfdc/test",
  "reusify/benchmarks",
  "@fastify/send/test",
  "@fastify/static/test",
  "@fastify/multipart/test",
  "ws/test",
  "ws/examples",
];
