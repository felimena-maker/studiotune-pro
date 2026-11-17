# StudioTune Pro

App Android (Capacitor) con dos herramientas para guitarristas:

- **Afinador cromático** de alta precisión (autocorrelación, calibración A4, afinaciones alternativas).
- **Transcribir acordes**, estilo reproductor: importa un archivo de audio o graba lo que suena en el teléfono, detecta los
  acordes, los coloca sobre la letra sincronizada (LRCLIB), muestra diagramas de guitarra, y permite cambiar el tono y la
  velocidad del audio.

Todo el procesamiento de audio ocurre en el teléfono. Solo se usa internet para buscar la letra (LRCLIB) y leer el título de
un enlace de YouTube/Spotify. La app **no descarga audio de YouTube ni de Spotify**.

## Estructura

| Ruta | Contenido |
|---|---|
| `src/index.html` | Interfaz (Tailwind) |
| `src/chords.js` | Motor de acordes: picos espectrales, afinación, plantillas, Viterbi, alineación con la letra |
| `src/pcm.js` | FFT y análisis de una grabación completa |
| `src/shapes.js` | Posiciones de guitarra y dibujo SVG |
| `src/pitch.entry.mjs` | Cambio de tono con SoundTouch (se empaqueta con esbuild) |
| `src/transcribe.js` | Pantallas de biblioteca, añadir canción y reproductor |
| `android/app/src/main/java/com/studiotune/pro/` | Servicio de captura en segundo plano (`CaptureService`) y plugin (`AudioCapturePlugin`) |
| `test/` | Pruebas del motor con audio sintético (`node test/chords.test.js`, `shapes.test.js`, `pcm.test.js`, `bench.js`) |

## Compilar

Requisitos: Node 20+, JDK 17 y Android SDK (`android/local.properties` con `sdk.dir=...`).

```bash
npm install
npm run build:web          # genera www/ (CSS, fuentes, SoundTouch)
npx cap sync android
cd android
./gradlew assembleDebug    # APK de depuración
```

Para un APK `release` firmado, crea tu propia clave y un `signing/keystore.properties` con `storeFile`, `storePassword`,
`keyAlias` y `keyPassword` (esa carpeta está en `.gitignore` y no debe subirse nunca).

## Pruebas

```bash
node test/chords.test.js
node test/shapes.test.js
node test/pcm.test.js
node test/pitch.test.mjs
node test/bench.js        # banco con canciones sintéticas difíciles (tarda unos minutos)
```

## Límites conocidos

- Con grabaciones reales con voz y batería la detección no es perfecta: se pueden corregir los acordes tocándolos.
- La captura de «Audio del teléfono» depende de que la app que reproduce permita ser capturada.
- Las pruebas de precisión usan audio sintético y no garantizan el resultado con canciones reales.

## Licencias

Cambio de tono: [SoundTouchJS](https://github.com/cutterbl/SoundTouchJS) (LGPL-2.1). Fuentes Inter y JetBrains Mono (OFL).
Letras: [LRCLIB](https://lrclib.net).
