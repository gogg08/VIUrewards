/**
 * Verificación estática de los assets del dashboard (Tarea 0).
 *
 * No hay navegador en los tests, así que comprobamos leyendo el HTML:
 * (a) los scripts que definen los componentes se cargan ANTES de alpine.min.js
 *     (Alpine arranca en un microtask apenas se ejecuta);
 * (b) cada `src`/`href` que apunta a /web corresponde a un archivo existente.
 *
 * No reemplaza una prueba real de navegador: ver docs/dashboard.md.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const webDir = fileURLToPath(new URL("../../web", import.meta.url));
const overlayDir = fileURLToPath(new URL("../../overlay", import.meta.url));

interface Page {
  file: string;
  componentScript: string;
}

const PAGES: Page[] = [
  { file: "login.html", componentScript: "/web/login.js" },
  { file: "index.html", componentScript: "/web/app.js" },
];

function read(file: string): string {
  return readFileSync(join(webDir, file), "utf8");
}

function scriptSources(html: string): Array<{ src: string; index: number }> {
  return [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((match) => ({
    src: match[1],
    index: match.index ?? -1,
  }));
}

describe("assets del dashboard", () => {
  for (const page of PAGES) {
    it(`${page.file}: Alpine se carga después del script del componente`, () => {
      const html = read(page.file);
      const scripts = scriptSources(html);
      const alpine = scripts.find((script) => script.src.endsWith("/alpine.min.js"));
      const component = scripts.find((script) => script.src === page.componentScript);

      expect(alpine, "falta el script de Alpine").toBeDefined();
      expect(component, `falta el script ${page.componentScript}`).toBeDefined();
      // El componente debe aparecer ANTES que Alpine en el documento.
      expect(component!.index).toBeLessThan(alpine!.index);

      // Ningún script propio puede quedar después de Alpine.
      for (const script of scripts) {
        if (script.src.endsWith("/alpine.min.js")) continue;
        expect(script.index).toBeLessThan(alpine!.index);
      }
    });

    it(`${page.file}: todos los src/href de /web existen`, () => {
      const html = read(page.file);
      const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
        .map((match) => match[1])
        .filter((ref) => ref.startsWith("/web/"));

      expect(refs.length).toBeGreaterThan(0);
      for (const ref of refs) {
        const relative = ref.slice("/web/".length);
        expect(existsSync(join(webDir, relative)), `no existe ${ref}`).toBe(true);
      }
    });

    it(`${page.file}: incluye favicon (evita el 404 de /favicon.ico)`, () => {
      expect(read(page.file)).toMatch(/<link\s+rel="icon"/);
    });
  }

  it("login.html usa los scripts propios y no referencia CDNs", () => {
    const refs = [...read("login.html").matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    for (const ref of refs) {
      expect(ref.startsWith("http"), `no debe haber recursos externos: ${ref}`).toBe(false);
    }
  });

  it("el logo está en los dos formatos y se carga en dashboard y login", () => {
    expect(existsSync(join(webDir, "assets/VIUrewards.png"))).toBe(true);
    expect(existsSync(join(webDir, "assets/VIUrewards.webp"))).toBe(true);
    for (const page of PAGES) {
      const html = read(page.file);
      expect(html, `${page.file} no usa el logo`).toContain("logoBadge()");
      expect(html, `${page.file} no apunta al PNG del logo`).toContain("/web/assets/VIUrewards.png");
      expect(html, `${page.file} no tiene el alt del logo`).toContain('alt="VIUrewards"');
    }
  });

  it("logo.js se carga antes del script del componente en cada página", () => {
    for (const page of PAGES) {
      const scripts = scriptSources(read(page.file));
      const logo = scripts.find((script) => script.src === "/web/logo.js");
      const component = scripts.find((script) => script.src === page.componentScript);
      expect(logo, `${page.file} no carga /web/logo.js`).toBeDefined();
      expect(logo!.index).toBeLessThan(component!.index);
    }
  });
});

describe("overlay (Browser Source)", () => {
  const html = readFileSync(join(overlayDir, "index.html"), "utf8");

  it("incluye favicon (evita el 404 dentro del Browser Source)", () => {
    expect(html).toMatch(/<link\s+rel="icon"/);
  });

  it("usa la URL del mensaje (con key) y no arma /media ni fija .mp4", () => {
    // Regresión del bug B3 / solo audio: el overlay hardcodeaba `/media/<id>.mp4`
    // sin `?key=` (→ 401) y con extensión fija (→ 404 en clips .m4a). El servidor
    // resuelve la URL (mp4 o m4a, con la clave) y la manda en `play` y `state`.
    // Se comprueba sobre las cadenas literales (no sobre los comentarios).
    expect(html).not.toMatch(/"\/media\//);
    expect(html).not.toMatch(/\.mp4"/);
    expect(html).toMatch(/function mediaUrl\(explicitUrl\)/);
    expect(html).toMatch(/play\(message\.item,\s*message\.url\)/);
    expect(html).toMatch(/play\(st\.current,\s*message\.url\)/);
  });

  it("el modo 'solo audio' oculta la imagen sin usar display: none ni display: none en CSS", () => {
    // El video se oculta con `visibility: hidden` (sigue sonando el audio, el
    // recorte y la duración máxima aplican y llegan `ended`/`error`).
    expect(html).toMatch(/item\.params\.audioOnly\s*\?\s*"hidden"\s*:\s*"visible"/);
    expect(html).toMatch(/style\.visibility\s*=/);
    // Nunca se oculta la imagen de solo audio con `display: none`.
    expect(html).not.toMatch(/audioOnly[^;]*display\s*[:=]\s*"?none/i);
    // Sin animación de entrada/salida en solo audio.
    expect(html).toMatch(/params\.audioOnly\)\s*return;\s*\n\s*if \(anim\) anim\.cancel/);
  });
});

describe("biblioteca de clips (Etapa 3A)", () => {
  const html = read("index.html");
  const app = read("app.js");

  it("la biblioteca usa tarjetas simples (el detalle vive en la ventana)", () => {
    // La tarjeta abre el detalle; el recorte/renombrar/borrar viven en la ventana.
    expect(html).toMatch(/class="clip clip-card"/);
    expect(html).toMatch(/@click="openClip\(clip\)"/);
    // Sin imagen: ícono de audio grande y centrado en la tarjeta.
    expect(html).toMatch(/clip-audio-icon/);
    // El botón de probar reproduce sin abrir el detalle (stop de la propagación).
    expect(html).toMatch(/@click\.stop="play\(clip\)"/);
    // La tarjeta no tiene los controles que se movieron a la ventana.
    const card = html.slice(html.indexOf("x-for=\"clip in filteredClips"), html.indexOf("Panel derecho"));
    expect(card).not.toMatch(/role="switch"/);
    expect(card).not.toMatch(/Renombrar/);
    expect(card).not.toMatch(/Guardar recorte/);
  });

  it("la tarjeta muestra la miniatura real con loading lazy y respaldo", () => {
    const card = html.slice(html.indexOf("x-for=\"clip in filteredClips"), html.indexOf("Panel derecho"));
    // La miniatura es una imagen real servida por la app.
    expect(card).toMatch(/clip-thumb-img/);
    expect(card).toMatch(/loading="lazy"/);
    expect(card).toMatch(/:src="clip\.thumbUrl/);
    // Respaldo: si la imagen falla, se oculta y queda el fondo neutro.
    expect(card).toMatch(/@error=/);
    // Los clips sin imagen no llevan miniatura: ícono de audio.
    expect(card).toMatch(/clip\.hasVideo === false/);
    // Ancho/alto los define el CSS (aspect-ratio) para no saltar el layout.
    const css = read("style.css");
    expect(css).toMatch(/\.clip-thumb-img/);
    expect(css).toMatch(/\.clip-thumb[\s\S]*aspect-ratio/);
    // El ícono de audio grande reemplaza a la insignia chica de la esquina.
    expect(css).toMatch(/\.clip-audio-icon[\s\S]*width:/);
    expect(css).not.toMatch(/\.clip-audio-badge/);
  });

  it("el filtro de la biblioteca clasifica por hasVideo (video/audio)", () => {
    // La lógica pura está en `filteredClips`.
    expect(app).toMatch(/hasVideo !== false/);
    expect(app).toMatch(/hasVideo === false/);
    expect(app).toMatch(/setLibraryFilter/);
  });

  it("la ventana de detalle existe y ofrece recorte, renombrar, probar y borrar", () => {
    expect(html).toContain("Detalle del clip");
    expect(html).toMatch(/@click="useClipTime\('start'\)"/);
    expect(html).toMatch(/@click="resetClipTrim\(\)"/);
    expect(html).toMatch(/@click="saveClipDetail\(\)"/);
    expect(html).toMatch(/@click="testClipDetail\(\)"/);
    expect(html).toMatch(/@click="askDeleteClip\(\)"/);
  });

  it("no queda código muerto del interruptor de solo audio del clip", () => {
    // Se quitó la antigua ruta /api/clips/:id/audio-only y su acción.
    expect(app).not.toMatch(/audio-only/);
    expect(app).not.toMatch(/setAudioOnly|toggleAudioOnly|saveAudioOnly/);
  });

  it("la tarjeta avisa si falta el archivo del clip (missing)", () => {
    // La reconciliación marca `missing` en vez de borrar la fila; la tarjeta lo
    // muestra con un aviso y el clip se puede borrar a mano.
    const card = html.slice(html.indexOf("x-for=\"clip in filteredClips"), html.indexOf("Panel derecho"));
    expect(card).toMatch(/clip\.missing === true/);
    expect(card).toContain("Falta el archivo");
  });
});

describe("archivos locales y descargas (Etapa 3B)", () => {
  const html = read("index.html");
  const app = read("app.js");
  const css = read("style.css");

  it("el botón + abre el selector de un archivo local", () => {
    expect(html).toMatch(/@click="openFilePicker\(\)"/);
    expect(html).toMatch(/x-ref="fileInput"/);
    expect(html).toMatch(/@change="onFilePicked\(\$event\)"/);
  });

  it("arrastrar y soltar cubre la página y muestra el aviso", () => {
    expect(html).toMatch(/@dragenter\.window="onDragEnter\(\$event\)"/);
    expect(html).toMatch(/@dragover\.window="onDragOver\(\$event\)"/);
    expect(html).toMatch(/@drop\.window="onDrop\(\$event\)"/);
    expect(html).toContain("Soltá para agregar a la biblioteca");
    // Se ignora si Ajustes está abierto.
    expect(app).toMatch(/onDrop\(event\)\s*\{[^}]*settingsOpen/s);
  });

  it("la subida va por /api/uploads con FormData y tope de dos en paralelo", () => {
    expect(app).toMatch(/\/api\/uploads/);
    expect(app).toMatch(/new FormData\(\)/);
    // Tope de dos subidas a la vez; el resto queda en cola (uploadQueue).
    expect(app).toMatch(/uploadingCount \+ this\.uploadQueue\.length >= UPLOAD_MAX_CONCURRENT/);
    expect(app).toContain("UPLOAD_MAX_CONCURRENT = 2");
  });

  it("el panel Descargas lista los trabajos con sus acciones", () => {
    expect(html).toContain("Descargas de esta sesión");
    expect(html).toMatch(/@click="clearFinishedJobs\(\)"/);
    expect(html).toMatch(/@click="retryJob\(job\)"/);
    expect(html).toMatch(/@click="cancelJob\(job\)"/);
    expect(html).toMatch(/@click="viewJobClip\(job\)"/);
    expect(html).toMatch(/@click="openYtdlpSettings\(\)"/);
  });

  it("el aviso de arrastrar y soltar no usa un color literal", () => {
    expect(css).toMatch(/\.drop-overlay\s*\{/);
    const block = css.slice(css.indexOf(".drop-overlay {"), css.indexOf(".visually-hidden"));
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});