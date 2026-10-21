# Capturas de la guía de Kick (`/guia`)

La página pública `/guia` tiene un lugar para capturas en cada paso. Las imágenes son
**opcionales**: si no están, su lugar no se muestra (ni hueco ni marcador) y no hay 404 ni
errores en consola. El servidor lista **solo** los archivos que existen en
`web/assets/guide/` (`GET /api/guide-shots`) y la página muestra esos.

## Convención de nombres

```
guia-NN-<resto>.<ext>
```

- **`NN` es el NÚMERO DE PASO** de la página, con dos dígitos (`01` … `06`). Las
  preguntas frecuentes serían `guia-07-…` (hoy no tienen bloque de capturas).
- Puede haber **varias capturas por paso**: se muestran en el **orden alfabético** del
  resto del nombre (`guia-02-crear-app` antes que `guia-02-redirect-url`).
- El resto va en **minúsculas**, números y guiones. La extensión es `.png`, `.webp` o
  `.jpg` (en minúsculas).
- El patrón aceptado es `^guia-\d\d-[a-z0-9-]+\.(png|webp|jpg)$`. Cualquier otro
  archivo en esa carpeta se ignora (por ejemplo `kick-app-preview.png`).

| Nombre | Paso |
|---|---|
| `guia-01-kick-developer` | Paso 1 — entrar a la configuración de desarrollador |
| `guia-02-crear-app` | Paso 2 — crear la app (con los tres scopes tildados) |
| `guia-02-redirect-url` | Paso 2 — pegar la redirect URI |
| `guia-03-credenciales` | Paso 3 — copiar el Client ID y el Client Secret |
| `guia-04-ajustes-kick` | Paso 4 — cargar las credenciales en VIUrewards |
| `guia-05-permisos` | Paso 5 — aceptar los permisos |
| `guia-06-conectado` | Paso 6 — verificar que quedó conectado |

Hoy existe **`guia-03-credenciales.png`** (la pantalla "Tu aplicación" de Kick).

## Tamaño recomendado

- **Ancho:** unos **1200 px** (la página lo muestra al ancho de la columna, ~760 px, y lo
  amplía con el visor).
- **Peso:** razonable para que la página cargue rápido (idealmente **< 300 KB** por imagen;
  WebP suele dar la mejor relación).
- **Formato:** `.webp` preferido, luego `.png`; `.jpg` para fotos.

## Importante antes de guardar una captura

- **TAPÁ el Client ID y el Client Secret** en cualquier captura (sobre todo en la del
  Paso 3). El secreto es como una contraseña: no debe quedar en ninguna imagen que
  subas. Reemplazalos por textos como `[CLIENT_ID]` y `[SECRET]`.
- Revisá también que no se vea tu correo, tu token ni datos personales innecesarios.

## Cómo se ven (comportamiento)

- Si el paso tiene capturas, se muestran con **pie de foto** y **clic para ampliar**
  (visor accesible: se cierra con **Esc**, el botón X o un clic afuera, y el foco vuelve
  a la captura).
- Si no existe ninguna para el paso, el bloque no se renderiza: la guía se ve igual, solo
  sin la imagen.
