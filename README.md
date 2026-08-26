# MXM Studio 💚☀️

**Herramienta libre y gratuita — para siempre — de animación *mixed media* y
cianotipia.** Corre **entera en tu navegador**: nada se sube a ningún
servidor, tus videos y escaneos no salen de tu máquina.

➡️ **Úsala ya: <https://mxm.sebastianlopez.me>**

```
🎬 video (o carpeta de imágenes)
   → 🖨️ hojas de contacto imprimibles (con marcadores de registro)
      → ✋ pintar sobre el papel  /  ☀️ exponer cianotipias desde acetatos
         → 📠 escanear todo (en cualquier orden y orientación)
            → 🤖 la app endereza, identifica y recorta cada fotograma sola
               → 🎬 video final reconstruido
```

Sin cuentas, sin pagos, sin límites, sin instalar nada. Hecho con cariño y
liberado al modo Robin Hood: si alguien te quiere cobrar por este flujo,
aquí lo tienes gratis, con código abierto y con más funciones.

## ✨ Qué hace

- **Hojas de contacto** desde un video o una carpeta de imágenes: cuadrícula
  libre, cualquier tamaño de papel y DPI, orientación automática de mejor
  ajuste, etiquetas, numerador de hoja, selección de fotogramas y de hojas.
- **Deduplicación perceptual**: los dibujos repetidos se imprimen una sola
  vez y se reutilizan al armar el video.
- **Marcadores de registro ArUco redundantes** (4/8/12) + **un QR por
  fotograma**: la hoja escaneada se alinea e identifica sola aunque esté
  rotada, de cabeza, en espejo o con varios marcadores pintados.
- **Modo cianotipia**: negativos para acetato con curva de compensación
  calibrable (método Easy Digital Negatives integrado), color o degradado de
  tinta, modo ahorro de tinta con halos, borde bloqueador, espejado y
  simulación de la copia azul final.
- **Procesador de escaneos**: homografía RANSAC con control de precisión,
  corrección local para papel deformado, escala automática, recuperación
  guiada de marcadores, 16 bits de punta a punta, informe con miniaturas y
  hojas de rescate para reimprimir solo lo fallido.
- **Calibración**: perfil de impresora (escala real, respuesta tonal,
  tamaños mínimos), curva de cianotipia (tira de 21 parches o carta EDN de
  256 tonos) y ColorBlocker (el color de tinta que mejor bloquea el UV en TU
  impresora).
- **Video final** reconstruido en tu navegador (MP4/WebM), respetando el
  orden original y los duplicados.

La lista completa, con la explicación técnica de cada función:
**[docs/FUNCIONALIDADES.md](docs/FUNCIONALIDADES.md)**.

## 🧱 Cómo está hecho

| Carpeta | Qué es |
|---|---|
| `rust-core/` | Todo el procesamiento de imagen en **Rust**, compilado a **WebAssembly**: composición de hojas, generación y **detección** de marcadores ArUco, QRs, homografía RANSAC, warp, cianotipia, calibración, PDF. |
| `web/` | La aplicación web (HTML/JS/CSS sin frameworks). Video vía WebCodecs. Todo el procesamiento ocurre en tu navegador, en workers. |
| `legacy-desktop/` | La app de escritorio original en Python (v2, jubilada pero funcional). |
| `docs/` | Documentación funcional y manual. |

No hay servidor: el sitio es 100 % estático (Cloudflare Workers con assets
estáticos) y funciona offline una vez cargado. Los proyectos, presets y perfiles de calibración se
guardan en tu propio navegador y se pueden exportar/importar como JSON.

Los `layout.json` generados por la versión de escritorio (v1 y v2) se
procesan sin cambios: los proyectos viejos siguen vivos.

## 🔧 Desarrollo

Requisitos: Rust (con target `wasm32-unknown-unknown`), `wasm-pack`, Node 18+.

```bash
cd rust-core && cargo test              # tests del núcleo (nativo, rápidos)
wasm-pack build --release --target web --out-dir ../web/src/wasm
cd ../web && npm install
npm run dev                             # desarrollo
npm run test:e2e                        # prueba de punta a punta en Chrome
npm run build                           # producción (web/dist)
npx wrangler deploy                     # publicar (Cloudflare Workers + assets)
```

## Licencia

Libre para todo el mundo, para siempre. Ver [LICENSE](LICENSE).
