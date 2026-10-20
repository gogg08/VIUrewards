# Límites de descarga (duración y tamaño)

Este documento explica cómo se aplican los límites de **duración** y **tamaño**
a las descargas por link (yt-dlp + ffmpeg) y por qué el filtro de duración es
tolerante a un valor desconocido.

## Los límites

Los límites salen de Ajustes → Biblioteca y descargas y el módulo de media los
relee **en cada descarga**:

- `maxVideoDurationSec` (duración máxima, en segundos).
- `maxVideoBytes` (tamaño máximo, en bytes).

## Por qué el filtro de duración es tolerante (`duration <=? N`)

yt-dlp acepta un filtro `--match-filter` para rechazar videos antes de
descargarlos. La forma obvia sería:

```
--match-filter "duration <= 90"
```

El problema: **`duration` no siempre existe**. En algunos reels de Instagram el
extractor devuelve la duración como ausente/`null`. Según la documentación oficial
de yt-dlp (sección *Filtering Formats*):

> Formats for which the value is not known are excluded unless you put a question
> mark (`?`) after the operator. […] `-f "bv[height<=?720][tbr>500]"` selects up
> to 720p videos (or videos where the height is not known).

Es decir, con `duration <= 90` a secas, **un video con `duration` desconocido se
excluye** y yt-dlp termina con un error `does not pass filter`, aunque el video
dure pocos segundos. Por eso usamos la forma tolerante:

```
--match-filter "duration <=? 90"
```

Con el `?`, un video con duración desconocida **no** se rechaza por el filtro; se
descarga y la duración real se valida después (ver abajo).

> Nota: la investigación de este bug intentó reproducirlo con `yt-dlp -J` sobre
> URLs reales de reels, pero Instagram respondió *"empty media response"*
> (requiere login) desde el entorno de desarrollo. La corrección se basa en el
> comportamiento documentado del filtro y se cubre con tests que simulan la
> extracción sin `duration`.

## Validación con la duración real (ffprobe)

Cuando el filtro tolerante deja pasar un video (típicamente porque la duración
era desconocida), el límite se aplica igual **después de convertir**, midiendo el
archivo real con **ffprobe**:

- Si la duración real **supera** el límite, se borra el archivo convertido y la
  descarga falla con `TOO_LONG`, mostrando la duración real y el límite
  (`El video dura M s y el límite es N s`).
- Si la duración **sigue siendo desconocida** (ffprobe no la puede medir), **no
  se rechaza**: nunca se descarta por un dato que no pudimos conocer.

La duración que queda en la biblioteca es la **real** (ffprobe), no la del
`info.json` de yt-dlp.

## Tamaño (`--max-filesize`)

`--max-filesize SIZE` aborta la descarga **solo cuando yt-dlp conoce el tamaño
de antemano**. Cuando el tamaño es desconocido, yt-dlp no aborta; por eso el
tamaño se valida igual **después de descargar** con `statSync` del archivo
`<id>.src.<ext>`:

- Si el archivo descargado supera `maxVideoBytes`, se borra y la descarga falla
  con `TOO_BIG`.

## Motivos reales de fallo

Un fallo de yt-dlp no se mapea ciegamente al mensaje de duración. Solo se trata
como `TOO_LONG` cuando la salida menciona el filtro **de duración**; un
`does not pass filter` genérico cae a `DOWNLOAD_FAILED`. Así, motivos reales como
**login requerido** o **rate limit** de Instagram muestran su propio mensaje (y el
detalle crudo queda en `logs/`), en vez de un engañoso "dura más de N s".
