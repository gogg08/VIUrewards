/**
 * Trabajos de descarga en segundo plano (Fase 3).
 *
 * Reemplaza el comportamiento temporal de `POST /api/enqueue` por URL: el
 * dashboard pide una descarga y recibe un id de trabajo, y consulta su estado
 * mientras corre. Nada de una request que quede esperando minutos.
 */

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { processVideo, type Clip, type MediaOptions } from "../media/index.ts";
import { ingestLocalFile, type IngestLocalFileOptions } from "../media/ingest.ts";
import { generateThumbnail, thumbExists } from "../media/thumbs.ts";
import type { MediaOperationJournal } from "../media/pending-media.ts";
import { isTemporaryForClip } from "../media/temp-patterns.ts";

export type DownloadStatus = "queued" | "downloading" | "converting" | "ready" | "error";

export type DownloadKind = "link" | "local" | "thumbs";

export interface DownloadJob {
  id: string;
  /** `link`: descarga por URL. `local`: archivo subido/arrastrado. */
  kind: DownloadKind;
  /** URL para los trabajos de link; vacío para los locales. */
  url: string;
  /** Nombre original del archivo, para los trabajos locales. */
  filename?: string;
  status: DownloadStatus;
  clipId?: string;
  title?: string;
  message?: string;
  /** ¿Ya existía un clip con este contenido? (duplicados por contenido). */
  duplicate?: boolean;
  /** Etiqueta opcional del trabajo. */
  tag?: string;
  /** Progreso de una tarea por lotes (miniaturas): hechas sobre el total. */
  processed?: number;
  total?: number;
  createdAt: number;
  updatedAt: number;
  /**
   * Temporal de la subida que pertenece a este trabajo (interno: no sale en
   * `snapshot`). Lo borra el `cancel()` o el `finally` del runner, nunca otro.
   */
  tempPath?: string;
  /** Interno: el trabajo ya se marcó como terminado (evita dobles cierres). */
  finished?: boolean;
}

/** Recorte de las opciones de media que el servidor reenvía al descargar. */
export type MediaPassthroughOptions = Partial<
  Pick<
    MediaOptions,
    | "allowedDomains"
    | "maxUrlLength"
    | "maxDurationSec"
    | "maxBytes"
    | "timeoutMs"
    | "maxHeight"
    | "logsDir"
    | "binarySearch"
    | "jsRuntime"
  >
> & {
  /**
   * Directorio de herramientas administradas (Fase de distribución, Etapa 1).
   * En modo configurado es `<VIUREWARDS_DATA_DIR>/bin` (absoluto); si no viene,
   * la detección usa el histórico `bin` relativo al directorio de trabajo.
   */
  binDir?: string;
  /**
   * Ruta del Node que yt-dlp debe usar como runtime JS (`--js-runtimes
   * node:<ruta>`) cuando se conoce (distribución portable). Si no viene, el
   * comportamiento es el histórico: se usa el Node que corre la app.
   */
  nodeRuntime?: string;
};

/** Clip candidato a miniaturas (lo arma el servidor con la base). */
export interface ThumbBackfillClip {
  id: string;
  file: string;
  durationSec: number;
  hasVideo: boolean;
}

export interface DownloadJobManagerOptions {
  mediaDir: string;
  media?: MediaPassthroughOptions;
  /**
 * Se evalúa en cada descarga y se mezcla sobre `media`. Permite leer los
 * límites desde la configuración vigente sin reiniciar el servidor.
 */
  resolve?: () => MediaPassthroughOptions;
  /**
   * Opciones de la ingesta de archivos locales, evaluadas en cada trabajo (para
   * leer los límites vigentes). Se mezclan con `run`.
   */
  localResolve?: () => Omit<IngestLocalFileOptions, "mediaDir" | "run">;
  /** Se llama cuando el clip queda listo (para registrarlo en la base). */
  onReady?: (clip: Clip, job: DownloadJob) => void;
  /**
   * Libro de operaciones de media (opcional). Marca las subidas activas (para no
   * limpiar un `.upload` en uso) y las operaciones de conversión (para que la
   * limpieza de arranque reconozca una conversión interrumpida).
   */
  journal?: MediaOperationJournal;
  /** Ejecutor de procesos, inyectable en tests. */
  run?: MediaOptions["run"];
  /** Máximo de trabajos en memoria; se descartan los terminados más viejos. */
  maxJobs?: number;
  /** Tareas simultáneas; el resto queda en cola. Por defecto 2. */
  maxConcurrent?: number;
}

export interface CreateJobOptions {
  /** Etiqueta opcional para identificar el trabajo por fuera. */
  tag?: string;
  /** Se llama cuando el trabajo termina (listo o con error). */
  onDone?: (job: DownloadJob) => void;
}

const DEFAULT_MAX_JOBS = 50;
const DEFAULT_MAX_CONCURRENT = 2;

/** Resultado del cierre de los trabajos (para el log de apagado). */
export interface DownloadStopResult {
  /** Trabajos cancelados por el cierre. */
  cancelled: number;
  /** `true` si no terminaron dentro del plazo. */
  timedOut: boolean;
}

/** Se lanza si se intenta crear un trabajo después de cerrar el gestor. */
export class JobManagerClosedError extends Error {
  constructor() {
    super("El servidor se está cerrando: no se aceptan descargas nuevas.");
    this.name = "JobManagerClosedError";
  }
}

function snapshot(job: DownloadJob): DownloadJob {
  // Los campos internos (temporal, cierre) no salen del gestor.
  const { tempPath: _tempPath, finished: _finished, ...publicJob } = job;
  return { ...publicJob };
}

export class DownloadJobManager {
  private readonly jobs = new Map<string, DownloadJob>();
  private readonly mediaDir: string;
  private readonly media: MediaPassthroughOptions;
  private readonly resolve?: () => MediaPassthroughOptions;
  private readonly localResolve?: () => Omit<IngestLocalFileOptions, "mediaDir" | "run">;
  private readonly onReady?: (clip: Clip, job: DownloadJob) => void;
  private readonly journal?: MediaOperationJournal;
  private readonly run?: MediaOptions["run"];
  private readonly maxJobs: number;
  private readonly maxConcurrent: number;
  private readonly onDone = new Map<string, (job: DownloadJob) => void>();
  private readonly cancelled = new Set<string>();
  /** Canceladores de los trabajos activos (abortan sus procesos externos). */
  private readonly aborts = new Map<string, AbortController>();
  /** Resolvers de los runners en vuelo, para poder esperarlos al cerrar. */
  private readonly running = new Map<string, Promise<void>>();
  /**
   * Trabajos que RECIBEN o CONVIERTEN un archivo (subida o preparación local):
   * mientras haya uno, el cierre no barre `media/` ni `.uploads/`.
   */
  private readonly fileWork = new Set<string>();
  /** `true` cuando se cerró: no se aceptan trabajos nuevos. */
  private stopped = false;
  /** Cierre en curso (idempotente). */
  private stopping: Promise<DownloadStopResult> | null = null;
  /** Runners esperando un turno (mientras ya hay el máximo de tareas activas). */
  private readonly pendingRunners: Array<() => void> = [];
  /** Ids de trabajos que ya tomaron un turno (para no liberar de más). */
  private readonly holdingSlot = new Set<string>();
  private active = 0;

  constructor(options: DownloadJobManagerOptions) {
    this.mediaDir = options.mediaDir;
    this.media = options.media ?? {};
    this.resolve = options.resolve;
    this.localResolve = options.localResolve;
    this.onReady = options.onReady;
    this.journal = options.journal;
    this.run = options.run;
    this.maxJobs = options.maxJobs ?? DEFAULT_MAX_JOBS;
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  }

  /** Crea un trabajo y arranca la descarga en segundo plano. */
  create(url: string, options: CreateJobOptions = {}): DownloadJob {
    this.assertOpen();
    const now = Date.now();
    const job: DownloadJob = {
      id: randomUUID(),
      kind: "link",
      url,
      status: "queued",
      tag: options.tag,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    if (options.onDone) this.onDone.set(job.id, options.onDone);
    this.schedule(job.id, () => void this.runLinkJob(job));
    return snapshot(job);
  }

  /**
   * Crea un trabajo para un archivo local ya volcado a disco (temporal). Lo
   * valida por contenido y lo normaliza. El temporal se limpia al terminar.
   */
  createLocal(
    tempPath: string,
    filename: string,
    options: CreateJobOptions = {},
  ): DownloadJob {
    this.assertOpen();
    const now = Date.now();
    const job: DownloadJob = {
      id: randomUUID(),
      kind: "local",
      url: "",
      filename,
      status: "queued",
      tag: options.tag,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    if (options.onDone) this.onDone.set(job.id, options.onDone);
    this.schedule(job.id, () => void this.runLocalJob(job, tempPath));
    return snapshot(job);
  }

  /** Clave del temporal de una subida en el libro de operaciones (uuid). */
  private journalUploadKey(tempPath: string): string {
    const name = tempPath.slice(Math.max(tempPath.lastIndexOf("/"), tempPath.lastIndexOf("\\")) + 1);
    return name.endsWith(".upload") ? name.slice(0, -".upload".length) : name;
  }

  /**
   * Genera en segundo plano las miniaturas faltantes de un lote de clips YA
   * normalizados. Procesa de a uno (así no compite con las descargas) y reporta
   * progreso. Nunca modifica el clip: ffmpeg solo lee.
   */
  createThumbBackfill(
    clips: readonly ThumbBackfillClip[],
    options: CreateJobOptions = {},
  ): DownloadJob {
    this.assertOpen();
    const now = Date.now();
    const job: DownloadJob = {
      id: randomUUID(),
      kind: "thumbs",
      url: "",
      status: "queued",
      tag: options.tag,
      processed: 0,
      total: clips.length,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    if (options.onDone) this.onDone.set(job.id, options.onDone);
    this.schedule(job.id, () => void this.runThumbBackfill(job, clips));
    return snapshot(job);
  }

  /**
   * Cancela un trabajo en curso: aborta su proceso externo (el archivo parcial se
   * borra) y lo marca como error de inmediato. El trabajo NO se da por listo
   * aunque el proceso haya terminado bien justo antes.
   */
  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status === "ready" || job.status === "error") return true;
    this.cancelled.add(id);
    this.aborts.get(id)?.abort();
    // Un temporal de subida pertenece SOLO a este trabajo: se borra ya (el runner
    // cancelado puede salir sin pasar por su `finally`).
    if (job.tempPath) {
      rmSync(job.tempPath, { force: true });
      this.journal?.end("uploads", this.journalUploadKey(job.tempPath));
      delete job.tempPath;
    }
    this.finish(job, { status: "error", message: "Cancelado." });
    return true;
  }

  /**
   * Cierre ordenado para el apagado del servidor.
   *
   * 1. Deja de aceptar trabajos nuevos.
   * 2. Cancela los activos: aborta yodl-dlp/ffmpeg y borra sus parciales.
   * 3. Espera a que terminen (hasta `timeoutMs`).
   *
   * Es idempotente: dos llamadas comparten la misma promesa. Los trabajos
   * cancelados quedan como error (nunca como `ready`).
   */
  stop(options: { timeoutMs?: number } = {}): Promise<DownloadStopResult> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    const timeoutMs = options.timeoutMs ?? 10_000;

    const cancelledIds: string[] = [];
    for (const job of [...this.jobs.values()]) {
      if (job.status === "ready" || job.status === "error") continue;
      if (this.cancel(job.id)) cancelledIds.push(job.id);
    }

    const active = [...this.running.values()];
    const all = Promise.allSettled(active).then(() => undefined);

    this.stopping = new Promise<DownloadStopResult>((resolve) => {
      let done = false;
      const finish = (timedOut: boolean): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({
          cancelled: cancelledIds.length,
          timedOut,
        });
      };
      const timer = setTimeout(() => finish(true), timeoutMs);
      timer.unref?.();
      void all.then(() => finish(false));
    });
    return this.stopping;
  }

  /** ¿Se cerró? A partir de acá no se aceptan trabajos nuevos. */
  isStopped(): boolean {
    return this.stopped;
  }

  /**
   * Quita un trabajo TERMINADO (listo o con error) de la lista. Un trabajo en
   * curso o en cola no se quita (para eso está `cancel`). Devuelve `false` si no
   * existe; `"active"` si existe pero todavía no terminó.
   */
  remove(id: string): "ok" | "missing" | "active" {
    const job = this.jobs.get(id);
    if (!job) return "missing";
    if (job.status !== "ready" && job.status !== "error") return "active";
    this.jobs.delete(id);
    this.onDone.delete(id);
    return "ok";
  }

  /** Quita todos los trabajos terminados. Devuelve cuántos quitó. */
  clearFinished(): number {
    let removed = 0;
    for (const job of [...this.jobs.values()]) {
      if (job.status === "ready" || job.status === "error") {
        this.jobs.delete(job.id);
        this.onDone.delete(job.id);
        removed += 1;
      }
    }
    return removed;
  }

  get(id: string): DownloadJob | null {
    const job = this.jobs.get(id);
    return job ? snapshot(job) : null;
  }

  /** Trabajos más recientes primero. */
  list(): DownloadJob[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map(snapshot);
  }

  private runLinkJob(job: DownloadJob): Promise<void> {
    // El controlador se registra ANTES de arrancar el trabajo: `cancel()` tiene
    // que poder abortar este trabajo aunque ya haya salido del mapa.
    const abort = this.track(job.id);
    const work = this.doLinkJob(job, abort.signal);
    this.running.set(job.id, work);
    return work;
  }

  private async doLinkJob(job: DownloadJob, signal: AbortSignal): Promise<void> {
    const update = (patch: Partial<DownloadJob>): void => {
      Object.assign(job, patch);
      job.updatedAt = Date.now();
    };

    try {
      const result = await processVideo(job.url, {
        mediaDir: this.mediaDir,
        ...this.media,
        ...(this.resolve?.() ?? {}),
        run: this.run,
        onStage: (stage) => update({ status: stage }),
        signal,
        journal: this.journal,
      });
      if (this.cancelled.has(job.id)) return;
      if (result.ok) {
        update({ status: "ready", clipId: result.clip.id, title: result.clip.title });
        this.onReady?.(result.clip, job);
      } else {
        update({ status: "error", message: result.message });
      }
    } catch (error) {
      if (this.cancelled.has(job.id)) return;
      update({
        status: "error",
        message: error instanceof Error ? error.message : "Error inesperado al descargar.",
      });
    } finally {
      this.finish(job);
    }
  }

  private runLocalJob(job: DownloadJob, tempPath: string): Promise<void> {
    job.tempPath = tempPath;
    // La subida está «en curso» mientras se procesa: la limpieza de arranque no
    // debe tocar su `.upload` si por algún motivo sigue ahí. También marca el
    // trabajo como "archivo en curso" para el barrido de cierre.
    this.journal?.begin("uploads", this.journalUploadKey(tempPath));
    this.fileWork.add(job.id);
    const abort = this.track(job.id);
    const work = this.doLocalJob(job, tempPath, abort.signal);
    this.running.set(job.id, work);
    return work;
  }

  private async doLocalJob(job: DownloadJob, tempPath: string, signal: AbortSignal): Promise<void> {
    const update = (patch: Partial<DownloadJob>): void => {
      Object.assign(job, patch);
      job.updatedAt = Date.now();
    };

    try {
      const localOptions = this.localResolve?.() ?? {};
      const result = await ingestLocalFile(tempPath, {
        mediaDir: this.mediaDir,
        originalName: job.filename,
        ...(localOptions ?? {}),
        run: this.run,
        onStage: (stage) => update({ status: stage === "converting" ? "converting" : "downloading" }),
        signal,
        journal: this.journal,
      });
      if (this.cancelled.has(job.id)) return;
      if (result.ok) {
        update({
          status: "ready",
          clipId: result.clip.id,
          title: result.clip.title,
          duplicate: result.clip.duplicate,
        });
        this.onReady?.(result.clip, job);
      } else {
        update({ status: "error", message: result.message });
      }
    } catch (error) {
      if (this.cancelled.has(job.id)) return;
      update({
        status: "error",
        message: error instanceof Error ? error.message : "Error inesperado al agregar el archivo.",
      });
    } finally {
      // El archivo temporal se limpia siempre (el original del usuario no se toca).
      if (job.tempPath) {
        rmSync(job.tempPath, { force: true });
        this.journal?.end("uploads", this.journalUploadKey(job.tempPath));
        delete job.tempPath;
      }
      this.finish(job);
    }
  }

  private runThumbBackfill(job: DownloadJob, clips: readonly ThumbBackfillClip[]): Promise<void> {
    const abort = this.track(job.id);
    const work = this.doThumbBackfill(job, clips, abort.signal);
    this.running.set(job.id, work);
    return work;
  }

  private async doThumbBackfill(
    job: DownloadJob,
    clips: readonly ThumbBackfillClip[],
    signal: AbortSignal,
  ): Promise<void> {
    const update = (patch: Partial<DownloadJob>): void => {
      Object.assign(job, patch);
      job.updatedAt = Date.now();
    };

    let done = 0;
    try {
      for (const clip of clips) {
        if (this.cancelled.has(job.id) || signal.aborted) return;
        if (!clip.hasVideo || thumbExists(this.mediaDir, clip.id)) {
          done += 1;
          update({ processed: done });
          continue;
        }
        update({ status: "converting" });
        // Un fallo puntual no corta el lote: se registra y se sigue.
        await generateThumbnail(join(this.mediaDir, clip.file), clip.id, {
          mediaDir: this.mediaDir,
          durationSec: clip.durationSec,
          binarySearch: this.media.binarySearch,
          logsDir: this.media.logsDir,
          run: this.run,
          signal,
        });
        done += 1;
        update({ processed: done });
      }
      if (this.cancelled.has(job.id)) return;
      update({ status: "ready", message: `${done} de ${clips.length} listas.` });
    } catch (error) {
      if (this.cancelled.has(job.id)) return;
      update({
        status: "error",
        message: error instanceof Error ? error.message : "Error inesperado al generar miniaturas.",
      });
    } finally {
      this.finish(job);
    }
  }

  /** Arranca el runner ya mismo si hay lugar; si no, lo deja en cola. */
  private schedule(id: string, runner: () => void): void {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      this.holdingSlot.add(id);
      this.startTracked(id, runner);
      return;
    }
    this.pendingRunners.push(() => {
      this.holdingSlot.add(id);
      this.startTracked(id, runner);
    });
  }

  /**
   * Corre el runner y registra su promesa para poder esperarla al cerrar
   * (`stop()`). El runner arranca SIEMPRE de forma síncrona: así el turno queda
   * tomado antes de encolar el siguiente.
   */
  private startTracked(id: string, runner: () => void): void {
    runner();
    const running = this.running.get(id);
    if (running) {
      void running.finally(() => {
        this.running.delete(id);
      });
    }
  }

  /** Registra el cancelador del trabajo y devuelve su señal. */
  private track(id: string): AbortController {
    const abort = new AbortController();
    this.aborts.set(id, abort);
    return abort;
  }

  private assertOpen(): void {
    if (this.stopped) throw new JobManagerClosedError();
  }

  /**
   * ¿Hay una operación de limpieza en curso (subida recibida o conversión de un
   * archivo)? Esas tocan `media/` y `.uploads/`: el barrido de cierre no debe
   * correr debajo. No cuenta descargas ni trabajo en cola (`running`).
   */
  hasActiveFileWork(): boolean {
    return this.fileWork.size > 0;
  }

  /** ¿Queda algún trabajo activo (en vuelo)? Lo usa el cierre antes de limpiar. */
  hasActive(): boolean {
    return this.running.size > 0;
  }

  /** Libera un turno y arranca el siguiente runner en cola. */
  private releaseSlot(id: string): void {
    if (!this.holdingSlot.delete(id)) return;
    this.active = Math.max(0, this.active - 1);
    // Cerrando: no se promueve nada de la cola (los pendientes ya se cancelaron y
    // arrancar uno nuevo iniciaría un proceso externo durante el apagado).
    if (this.stopped) return;
    const next = this.pendingRunners.shift();
    if (next) {
      this.active += 1;
      next();
    }
  }

  private finish(job: DownloadJob, patch?: Partial<DownloadJob>): void {
    // `cancel()` puede marcar el trabajo como terminado antes de que el runner
    // salga; el segundo aviso no debe repetir onDone ni liberar el turno otra vez.
    if (job.finished) return;
    job.finished = true;
    this.fileWork.delete(job.id);
    if (patch) {
      Object.assign(job, patch);
      job.updatedAt = Date.now();
    }
    const onDone = this.onDone.get(job.id);
    if (onDone) {
      this.onDone.delete(job.id);
      onDone(snapshot(job));
    }
    this.cancelled.delete(job.id);
    this.aborts.delete(job.id);
    this.prune();
    this.releaseSlot(job.id);
  }

  private prune(): void {
    if (this.jobs.size <= this.maxJobs) return;
    const finished = [...this.jobs.values()]
      .filter((job) => job.status === "ready" || job.status === "error")
      .sort((a, b) => a.updatedAt - b.updatedAt);
    while (this.jobs.size > this.maxJobs && finished.length > 0) {
      const oldest = finished.shift();
      if (oldest) this.jobs.delete(oldest.id);
    }
  }
}