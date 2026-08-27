// Aceleración WebGPU del enderezado de escaneos (fase ②).
//
// El paso dominante del procesado es el warp de perspectiva bicúbico de la
// imagen completa (decenas de megapíxeles): en WASM tarda segundos y obliga a
// mantener entrada Y salida en la memoria del módulo. Aquí se ejecuta como
// compute shader con el MISMO kernel Catmull-Rom (a = -0.5) que usa el núcleo
// Rust, así el resultado es visualmente idéntico y la memoria WASM baja a la
// mitad. Si WebGPU no está disponible (o la imagen excede los límites de la
// GPU), el llamador cae al camino todo-en-WASM sin pérdida de funcionalidad.

let devicePromise = null;

async function initDevice() {
  if (!navigator.gpu) return null;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return null;
    const want = (k, v) => Math.min(adapter.limits[k] ?? v, v);
    const device = await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: want('maxStorageBufferBindingSize', 1 << 30),
        maxBufferSize: want('maxBufferSize', 1 << 30),
        maxTextureDimension2D: want('maxTextureDimension2D', 16384),
      },
    });
    device.lost.then(() => { devicePromise = null; });
    return device;
  } catch {
    return null;
  }
}

export function getGpuDevice() {
  if (!devicePromise) devicePromise = initDevice();
  return devicePromise;
}

const SHADER = /* wgsl */ `
struct Params {
  minv0: vec4f,      // fila 0 de la homografía inversa (xyz) — w sin uso
  minv1: vec4f,
  minv2: vec4f,
  srcW: u32, srcH: u32,
  outW: u32, outH: u32,
  flipped: u32, _pad0: u32, _pad1: u32, _pad2: u32,
};
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<u32>;
@group(0) @binding(2) var<uniform> P: Params;

// Pesos Catmull-Rom (a = -0.5) para muestras en -1, 0, 1, 2 — como el Rust.
fn cubicW(t: f32) -> vec4f {
  let t2 = t * t;
  let t3 = t2 * t;
  return vec4f(
    -0.5 * t3 + t2 - 0.5 * t,
     1.5 * t3 - 2.5 * t2 + 1.0,
    -1.5 * t3 + 2.0 * t2 + 0.5 * t,
     0.5 * t3 - 0.5 * t2,
  );
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= P.outW || gid.y >= P.outH) { return; }
  let x = f32(gid.x);
  let y = f32(gid.y);
  let w = P.minv2.x * x + P.minv2.y * y + P.minv2.z;
  var sx = (P.minv0.x * x + P.minv0.y * y + P.minv0.z) / w;
  let sy = (P.minv1.x * x + P.minv1.y * y + P.minv1.z) / w;
  if (P.flipped == 1u) { sx = f32(P.srcW - 1u) - sx; }
  let fw = f32(P.srcW);
  let fh = f32(P.srcH);
  if (sx < -1.5 || sy < -1.5 || sx > fw + 0.5 || sy > fh + 0.5) {
    return; // fuera del original: queda el negro del buffer (como el Rust)
  }
  let x0 = floor(sx);
  let y0 = floor(sy);
  let wx = cubicW(sx - x0);
  let wy = cubicW(sy - y0);
  let xi = i32(x0);
  let yi = i32(y0);
  let maxX = i32(P.srcW) - 1;
  let maxY = i32(P.srcH) - 1;
  var acc = vec3f(0.0);
  for (var j = 0; j < 4; j++) {
    let yy = clamp(yi - 1 + j, 0, maxY);
    var row = vec3f(0.0);
    for (var i = 0; i < 4; i++) {
      let xx = clamp(xi - 1 + i, 0, maxX);
      row += wx[i] * textureLoad(src, vec2i(xx, yy), 0).rgb;
    }
    acc += wy[j] * row;
  }
  let c = vec3u(clamp(round(acc * 255.0), vec3f(0.0), vec3f(255.0)));
  dst[gid.y * P.outW + gid.x] = c.r | (c.g << 8u) | (c.b << 16u) | (255u << 24u);
}
`;

let pipelineCache = null;

function getPipeline(device) {
  if (!pipelineCache || pipelineCache.device !== device) {
    const module = device.createShaderModule({ code: SHADER });
    pipelineCache = {
      device,
      pipeline: device.createComputePipeline({
        layout: 'auto',
        compute: { module, entryPoint: 'main' },
      }),
    };
  }
  return pipelineCache.pipeline;
}

function invert3x3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!det || !Number.isFinite(det)) return null;
  return [
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ];
}

/**
 * Endereza `source` (ImageBitmap/OffscreenCanvas) con la homografía `m`
 * (escaneo→layout, la que devuelve scan_detect) al tamaño outW×outH.
 * `flipped`: el escaneo llegó espejado (la homografía se calculó sobre la
 * imagen volteada). Devuelve RGBA (Uint8Array) o null si la GPU no puede.
 */
export async function gpuWarpPerspective(source, m, flipped, outW, outH) {
  const device = await getGpuDevice();
  if (!device) return null;
  const minv = invert3x3(m);
  if (!minv) return null;
  const srcW = source.width, srcH = source.height;
  const outBytes = outW * outH * 4;
  const lim = device.limits;
  if (srcW > lim.maxTextureDimension2D || srcH > lim.maxTextureDimension2D) return null;
  if (outBytes > lim.maxStorageBufferBindingSize || outBytes > lim.maxBufferSize) return null;

  let tex, outBuf, readBuf, uni;
  try {
    tex = device.createTexture({
      size: [srcW, srcH],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    device.queue.copyExternalImageToTexture({ source }, { texture: tex }, [srcW, srcH]);

    outBuf = device.createBuffer({ size: outBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const params = new ArrayBuffer(80);
    const f32 = new Float32Array(params);
    const u32 = new Uint32Array(params);
    f32.set([minv[0], minv[1], minv[2], 0], 0);
    f32.set([minv[3], minv[4], minv[5], 0], 4);
    f32.set([minv[6], minv[7], minv[8], 0], 8);
    u32.set([srcW, srcH, outW, outH, flipped ? 1 : 0, 0, 0, 0], 12);
    uni = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(uni, 0, params);

    const pipeline = getPipeline(device);
    const bind = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: tex.createView() },
        { binding: 1, resource: { buffer: outBuf } },
        { binding: 2, resource: { buffer: uni } },
      ],
    });
    readBuf = device.createBuffer({ size: outBytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(Math.ceil(outW / 8), Math.ceil(outH / 8));
    pass.end();
    enc.copyBufferToBuffer(outBuf, 0, readBuf, 0, outBytes);
    device.queue.submit([enc.finish()]);

    await readBuf.mapAsync(GPUMapMode.READ);
    const rgba = new Uint8Array(readBuf.getMappedRange().slice(0));
    readBuf.unmap();
    return rgba;
  } catch (e) {
    console.warn('[webgpu] warp failed, falling back to WASM:', e);
    return null;
  } finally {
    tex?.destroy();
    outBuf?.destroy();
    readBuf?.destroy();
    uni?.destroy();
  }
}
