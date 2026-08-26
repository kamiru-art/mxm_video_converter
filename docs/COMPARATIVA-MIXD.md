# MXM Studio vs. MIXD (mixd.uninspired.app)

MIXD es una herramienta web comercial que cubre el mismo flujo básico:
video → hoja de contacto → intervención física → escaneo → video. Cobra
**€30 (pago único)** por el flujo completo; la versión gratuita solo genera
hojas de contacto. MXM Studio hace todo eso **gratis, para siempre, con
código abierto** — y bastante más.

## Lo que MIXD hacía mejor que la app de escritorio (y ya copiamos)

| Ventaja de MIXD | Estado en MXM Studio |
|---|---|
| Corre en el navegador, sin instalar nada | ✅ Igual: Rust→WASM, 100 % en el navegador |
| Sin dependencia de Python/ffmpeg locales | ✅ WebCodecs para video, núcleo WASM autocontenido |
| Onboarding simple (subir video → hoja) | ✅ Flujo de 4 fases con arrastrar-y-soltar y valores por defecto sensatos |
| "Unlimited projects" como argumento | ✅ Trivialmente cierto: no hay servidor ni cuentas que limitar |

## Lo que MXM Studio tiene y MIXD no anuncia

- **Modo cianotipia completo**: negativos para acetato con curva de
  compensación calibrable (método Easy Digital Negatives con cartas de 21 y
  256 parches), color/degradado de tinta (ColorBlocker), modo ahorro de
  tinta con halos, borde bloqueador, espejado, triángulo testigo y
  simulación de la copia azul.
- **Calibración de impresora**: escala real medida y compensada, tamaños
  mínimos fiables de marcador/QR.
- **Deduplicación perceptual**: los dibujos sostenidos se pintan UNA vez.
- **Marcadores redundantes (4/8/12) + un QR por fotograma**: se puede pintar
  encima de marcadores y escanear en desorden; con 8 marcadores bastan 3.
- **Detección de espejo y polaridad automáticas**, escala de escaneo medida
  (cualquier DPI), corrección local para papel deformado por el agua,
  control de precisión con residuos en mm.
- **16 bits de punta a punta** en los escaneos.
- **Hojas de rescate**: reimprimir SOLO los fotogramas fallidos.
- **Informe** por escaneo con miniatura de diagnóstico de la alineación.
- **Compatibilidad** con los proyectos de la app de escritorio (layout v1/v2).
- **Privacidad real**: nada se sube a ningún servidor (en una web comercial
  el procesamiento pasa por sus máquinas o queda opaco).
- **Código abierto (MIT)**: cualquiera puede auditarlo, alojarlo o mejorarlo.

## Conclusión

La única ventaja estructural de MIXD era ser web. Esta versión elimina esa
diferencia y deja el resto del flujo — el que nació de práctica real de
taller — disponible para cualquiera, sin pagar.
