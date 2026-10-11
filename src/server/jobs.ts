/**
 * Trabajos de descarga en segundo plano (Fase 3).
 *
 * Reemplaza el comportamiento temporal de `POST /api/enqueue` por URL: el
 * dashboard pide una descarga y recibe un id de trabajo, y consulta su estado
 * mientras corre. Nada de una request que quede esperando minutos.
 */

import { randomUUID } from "node:crypto";

import { processVideo, type Clip, type MediaOptions } from "../media/index.ts";

export type DownloadStatus = "queued" | "downloading" | "converting" | "ready" | "error";

export interface DownloadJob {
  id: string;
  url: string;
  status: DownloadStatus;
  clipId?: string;
  title?: string;
  message?: string;
  /** Etiqueta opcional del trabajo. */
  tag?: string;
  createdAt: number;
  updatedAt: number;
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
>;

export interface DownloadJobManagerOptions {
  mediaDir: string;
  media?: MediaPassthroughOptions;
  /**
   * Se evalúa en cada descarga y se mezcla sobre `media`. Permite leer los
   * límites desde la configuración vigente sin reiniciar el servidor.
   */
  resolve?: () => MediaPassthroughOptions;
  /** Se llama cuando el clip queda listo (para registrarlo en la base). */
  onReady?: (clip: Clip, job: DownloadJob) => void;
  /** Ejecutor de procesos, inyectable en tests. */
  run?: MediaOptions["run"];
  /** Máximo de trabajos en memoria; se descartan los terminados más viejos. */
  maxJobs?: number;
}

export interface CreateJobOptions {
  /** Etiqueta opcional para identificar el trabajo por fuera. */
  tag?: string;
  /** Se llama cuando el trabajo termina (listo o con error). */
  onDone?: (job: DownloadJob) => void;
}

const DEFAULT_MAX_JOBS = 50;

function snapshot(job: DownloadJob): DownloadJob {
  return { ...job };
}

export class DownloadJobManager {
  private readonly jobs = new Map<string, DownloadJob>();
  private readonly mediaDir: string;
  private readonly media: MediaPassthroughOptions;
  private readonly resolve?: () => MediaPassthroughOptions;
  private readonly onReady?: (clip: Clip, job: DownloadJob) => void;
  private readonly run?: MediaOptions["run"];
  private readonly maxJobs: number;
  private readonly onDone = new Map<string, (job: DownloadJob) => void>();

  constructor(options: DownloadJobManagerOptions) {
    this.mediaDir = options.mediaDir;
    this.media = options.media ?? {};
    this.resolve = options.resolve;
    this.onReady = options.onReady;
    this.run = options.run;
    this.maxJobs = options.maxJobs ?? DEFAULT_MAX_JOBS;
  }

  /** Crea un trabajo y arranca la descarga en segundo plano. */
  create(url: string, options: CreateJobOptions = {}): DownloadJob {
    const now = Date.now();
    const job: DownloadJob = {
      id: randomUUID(),
      url,
      status: "queued",
      tag: options.tag,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    if (options.onDone) this.onDone.set(job.id, options.onDone);
    void this.runJob(job);
    return snapshot(job);
  }

  get(id: string): DownloadJob | null {
    const job = this.jobs.get(id);
    return job ? snapshot(job) : null;
  }

  /** Trabajos más recientes primero. */
  list(): DownloadJob[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map(snapshot);
  }

  private async runJob(job: DownloadJob): Promise<void> {
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
      });
      if (result.ok) {
        update({ status: "ready", clipId: result.clip.id, title: result.clip.title });
        this.onReady?.(result.clip, job);
      } else {
        update({ status: "error", message: result.message });
      }
    } catch (error) {
      update({
        status: "error",
        message: error instanceof Error ? error.message : "Error inesperado al descargar.",
      });
    } finally {
      const onDone = this.onDone.get(job.id);
      if (onDone) {
        this.onDone.delete(job.id);
        onDone(snapshot(job));
      }
      this.prune();
    }
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