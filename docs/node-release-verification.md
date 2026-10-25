# Verificación del release de Node.js (mantenimiento)

Documento para **quien prepara un release de VIUrewards**. No aplica al usuario
final: el instalador (`install-tools.ps1`) y el launcher verifican el SHA-256
fijado y **nunca** necesitan GPG.

## Qué problema resuelve

`scripts/dist/config.ts` fija un SHA-256 para el ZIP de Node.js. Ese hash se
copió de `https://nodejs.org/dist/v<versión>/SHASUMS256.txt`, que se sirve desde
**el mismo servidor** que el ZIP. Un hash del mismo origen detecta corrupción y
cambios de archivo, pero **no prueba autoría**: si ese servidor se comprometiera,
el hash y el binario cambiarían juntos.

Node.js publica además `SHASUMS256.txt.sig`, una firma GPG de un responsable de
releases. Verificarla sí ata el hash a una clave concreta. Este procedimiento
comprueba esa cadena.

## Cadena de confianza, paso a paso

1. **Claves oficiales**: se usa el keyring del repositorio `nodejs/release-keys`
   (<https://github.com/nodejs/release-keys>), que es el repositorio que la
   documentación de Node.js indica para verificar releases.
2. **Firmantes autorizados**: `NODE_RELEASE_KEYS.fingerprints` en `config.ts`
   lista las huellas de las claves **activas** que ese repositorio publica. Una
   firma buena de una clave que no esté en esa lista se rechaza.
3. **Firma**: `gpg --verify` sobre `SHASUMS256.txt` con `--status-fd 1`, exigiendo
   `GOODSIG` y extrayendo la huella de `VALIDSIG`.
4. **Hash**: el `NODE_ASSET.sha256` de `config.ts` tiene que aparecer en el
   manifiesto **firmado** para `NODE_ASSET.file`.
5. **Archivo local** (opcional): si el ZIP ya está en la caché
   (`build/downloads/`), se comprueba que su SHA-256 real coincide.

## Forma automática

```powershell
npm run verify:node-release
# o, reutilizando un clon ya descargado y comprobando el ZIP de la caché:
npm run verify:node-release -- --keys-dir build/nodesig/release-keys --file build/downloads/node-v24.22.1-win-x64.zip
```

Requiere `gpg` y `git` en el PATH. Códigos de salida:

| Código | Significado |
| --- | --- |
| 0 | Firma buena de una clave autorizada y hash del manifiesto firmado igual al pin. |
| 1 | Algo no coincide: firma inválida, clave no autorizada, hash distinto, manifiesto sin el archivo. |
| 2 | Falta `gpg` o `git`: hay que usar el procedimiento manual. |

`verifyNodeRelease()` está exportada y acepta un `run` inyectable, así que los
tests cubren los fallos (firma inválida, clave ajena, hash distinto) **sin red**
(`tests/dist/license.test.ts`).

Ejemplo de salida correcta:

```
Firma buena de Antoine du Hamel <antoine.duhamel@platformatic.dev> (5BE8A3F6C8A5C01D106C0AD820B1A390B168D356), clave autorizada.
El hash fijado de node-v24.22.1-win-x64.zip aparece en el manifiesto firmado.
El archivo local build/downloads/node-v24.22.1-win-x64.zip coincide con el hash firmado.

Node 24.22.1: firma y hash verificados (Antoine du Hamel <antoine.duhamel@platformatic.dev>).
```

## Procedimiento manual (si no hay GPG)

1. Descargar de la versión **exacta** fijada en `config.ts`:

   ```
   https://nodejs.org/dist/v<versión>/SHASUMS256.txt
   https://nodejs.org/dist/v<versión>/SHASUMS256.txt.sig
   ```

2. Obtener las claves de <https://github.com/nodejs/release-keys> (clonar, o
   importar las claves del directorio `gpg/`).
3. Verificar:

   ```powershell
   gpg --no-default-keyring --keyring <ruta>/pubring.kbx --verify SHASUMS256.txt.sig SHASUMS256.txt
   ```

   Tiene que aparecer `Good signature`. Anotar la huella de `VALIDSIG`.
4. Compararla con `NODE_RELEASE_KEYS.fingerprints`. Si no está, **no** se
   actualiza el pin: se informa la diferencia.
5. Comparar a mano la línea de `node-v<versión>-win-x64.zip` en
   `SHASUMS256.txt` con `NODE_ASSET.sha256`. Si difieren, **no se cambia el pin**
   sin avisar.

## Limitación que queda abierta

El keyring se clona desde GitHub. Si se quiere una garantía contra un commit
malicioso en ese repositorio, hay que **comparar las huellas por un segundo
canal** (por ejemplo, las publicadas en el blog o en el sitio de Node.js) antes
de confiar en el keyring. El script detecta claves fuera de la lista y firmas
inválidas, pero no puede demostrar por sí solo que las huellas de la lista sean
las correctas. Eso queda **pendiente** como paso humano documentado, no como una
verificación automatizada.

Tampoco se verifica la firma de yt-dlp (no publica firmas) ni la de FFmpeg (gyan.dev
solo publica `.sha256` del mismo origen): en esos dos casos el hash fijado detecta
corrupción, **no** autentica al autor.
