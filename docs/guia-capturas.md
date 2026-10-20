# Capturas de la guía de Kick (`/guia`)

La página pública `/guia` tiene un lugar para una captura por paso. Las imágenes son
**opcionales**: si no están, su lugar no se muestra (ni hueco ni marcador) y no hay 404 ni
errores en consola. El servidor lista **solo** los archivos que existen en
`web/assets/guide/` (`GET /api/guide-shots`) y la página muestra esos.

## Nombres exactos de archivo

Los archivos van en **`web/assets/guide/`** con estos nombres (elegí uno de los tres
formatos: `.png`, `.webp` o `.jpg`):

| Nombre base | Paso |
|---|---|
| `guia-01-kick-developer` | Paso 1 — entrar a la configuración de desarrollador |
| `guia-02-crear-app` | Paso 2 — crear la app |
| `guia-03-redirect-url` | Paso 2 — pegar la redirect URI |
| `guia-04-credenciales` | Paso 3 — copiar el Client ID y el Client Secret |
| `guia-05-ajustes-kick` | Paso 4 — cargar las credenciales en VIUrewards |
| `guia-06-permisos` | Paso 5 — aceptar los permisos |
| `guia-07-conectado` | Paso 6 — verificar que quedó conectado |

Ejemplos válidos: `guia-02-crear-app.webp`, `guia-03-redirect-url.png`.

> El patrón aceptado es `^guia-\d\d-[a-z0-9-]+\.(png|webp|jpg)$`. Cualquier otro archivo
> en esa carpeta se ignora.

## Tamaño recomendado

- **Ancho:** unos **1200 px** (la página lo muestra al ancho de la columna, ~760 px, y lo
  amplía con el lightbox).
- **Peso:** razonable para que la página cargue rápido (idealmente **< 300 KB** por imagen;
  WebP suele dar la mejor relación).
- **Formato:** `.webp` preferido, luego `.png`; `.jpg` para fotos.

## Importante antes de guardar una captura

- **Tapá el Client ID y el Client Secret** en cualquier captura (Paso 3). El secreto es
  como una contraseña: no debe quedar en ninguna imagen que subas.
- Revisá también que no se vea tu correo, tu token ni datos personales innecesarios.

## Cómo se ven (comportamiento)

- Si la imagen del paso existe, se muestra con **pie de foto** y **clic para ampliar**
  (lightbox accesible, se cierra con **Esc**).
- Si no existe, el bloque no se renderiza: la guía se ve igual, solo sin la imagen.
