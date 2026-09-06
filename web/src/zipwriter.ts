// Escritor de ZIP propio, en streaming y con ZIP64. Solo almacena (sin
// comprimir): lo que entra ya viene comprimido (PNG, PDF, TIFF con LZW…).
//
// Por qué propio: fflate escribe tamaños y desplazamientos de 32 bits, así
// que un ZIP de más de 4 GB (o una entrada de más de 4 GB, el PDF de un
// proyecto largo) sale corrupto en silencio; y este ZIP existe justo para
// proyectos de decenas de GB. ZIP64 (APPNOTE 4.5) va siempre, en todas las
// entradas, para que haya un solo camino: cabecera local con el campo extra
// ZIP64 y tamaños en el descriptor de datos de 8 bytes, directorio central
// con el extra ZIP64 (tamaños y desplazamiento), y el registro EOCD64 con su
// localizador delante del EOCD clásico. Lo leen unzip 6, 7-Zip, el Finder,
// el Explorador de Windows y `zipfile` de Python.
//
// No depende de nada: se prueba en Node con `zipfile` y `unzip -t`.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(crc: number, data: Uint8Array): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/** Fecha y hora en formato DOS (2 s de resolución), para las cabeceras. */
function dosDateTime(d: Date): [number, number] {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date =
    ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return [time, date];
}

class Bytes {
  private buf: number[] = [];
  u16(v: number): this {
    this.buf.push(v & 0xff, (v >>> 8) & 0xff);
    return this;
  }
  u32(v: number): this {
    this.buf.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
    return this;
  }
  /** 64 bits desde un número (exacto hasta 2^53: 9 PB, de sobra). */
  u64(v: number): this {
    const lo = v % 0x100000000;
    const hi = Math.floor(v / 0x100000000);
    return this.u32(lo).u32(hi);
  }
  bytes(b: Uint8Array): this {
    for (let i = 0; i < b.length; i++) this.buf.push(b[i]);
    return this;
  }
  done(): Uint8Array {
    return Uint8Array.from(this.buf);
  }
}

const VERSION_ZIP64 = 45;
const FLAG_DESCRIPTOR = 1 << 3; // tamaños y CRC detrás de los datos
const FLAG_UTF8 = 1 << 11;

interface Entry {
  name: Uint8Array;
  offset: number;
  crc: number;
  size: number;
  time: number;
  date: number;
}

/** Escribe un ZIP entrada a entrada: `begin(nombre)`, uno o más `write`,
 *  `end()`; y al final `finish()`. Cada trozo sale por `out` en cuanto se
 *  produce, en orden; el escritor solo retiene el directorio central (unos
 *  100 bytes por entrada). */
export class ZipWriter {
  private readonly out: (chunk: Uint8Array) => Promise<void>;
  private offset = 0;
  private readonly entries: Entry[] = [];
  private current: Entry | null = null;

  constructor(out: (chunk: Uint8Array) => Promise<void>) {
    this.out = out;
  }

  private async emit(chunk: Uint8Array): Promise<void> {
    await this.out(chunk);
    this.offset += chunk.length;
  }

  async begin(name: string): Promise<void> {
    if (this.current) throw new Error(`ZIP entry "${name}" started before the previous one ended.`);
    const [time, date] = dosDateTime(new Date());
    const nameBytes = new TextEncoder().encode(name);
    const entry: Entry = { name: nameBytes, offset: this.offset, crc: 0, size: 0, time, date };
    // cabecera local: tamaños a 0 y descriptor detrás; el extra ZIP64 (con
    // ceros) es lo que hace que el descriptor lleve tamaños de 8 bytes
    const header = new Bytes()
      .u32(0x04034b50)
      .u16(VERSION_ZIP64)
      .u16(FLAG_DESCRIPTOR | FLAG_UTF8)
      .u16(0) // almacenado
      .u16(time)
      .u16(date)
      .u32(0) // crc
      .u32(0xffffffff) // tamaño comprimido: en el extra
      .u32(0xffffffff) // tamaño original: en el extra
      .u16(nameBytes.length)
      .u16(20) // extra
      .bytes(nameBytes)
      .u16(0x0001)
      .u16(16)
      .u64(0)
      .u64(0)
      .done();
    this.current = entry;
    await this.emit(header);
  }

  async write(data: Uint8Array): Promise<void> {
    const e = this.current;
    if (!e) throw new Error('ZIP write without an open entry.');
    e.crc = crc32(e.crc, data);
    e.size += data.length;
    await this.emit(data);
  }

  async end(): Promise<void> {
    const e = this.current;
    if (!e) throw new Error('ZIP end without an open entry.');
    this.current = null;
    await this.emit(new Bytes().u32(0x08074b50).u32(e.crc).u64(e.size).u64(e.size).done());
    this.entries.push(e);
  }

  /** Directorio central, EOCD64, localizador y EOCD. */
  async finish(): Promise<void> {
    if (this.current) throw new Error('ZIP finished with an entry still open.');
    const cdStart = this.offset;
    for (const e of this.entries) {
      const rec = new Bytes()
        .u32(0x02014b50)
        .u16(VERSION_ZIP64) // hecho por
        .u16(VERSION_ZIP64) // necesario
        .u16(FLAG_DESCRIPTOR | FLAG_UTF8)
        .u16(0)
        .u16(e.time)
        .u16(e.date)
        .u32(e.crc)
        .u32(0xffffffff)
        .u32(0xffffffff)
        .u16(e.name.length)
        .u16(28) // extra
        .u16(0) // comentario
        .u16(0) // disco
        .u16(0) // atributos internos
        .u32(0) // atributos externos
        .u32(0xffffffff) // desplazamiento: en el extra
        .bytes(e.name)
        .u16(0x0001)
        .u16(24)
        .u64(e.size)
        .u64(e.size)
        .u64(e.offset)
        .done();
      await this.emit(rec);
    }
    const cdSize = this.offset - cdStart;
    const eocd64Offset = this.offset;
    const n = this.entries.length;
    const tail = new Bytes()
      // EOCD64
      .u32(0x06064b50)
      .u64(44) // tamaño del registro sin estos 12 bytes
      .u16(VERSION_ZIP64)
      .u16(VERSION_ZIP64)
      .u32(0)
      .u32(0)
      .u64(n)
      .u64(n)
      .u64(cdSize)
      .u64(cdStart)
      // localizador
      .u32(0x07064b50)
      .u32(0)
      .u64(eocd64Offset)
      .u32(1)
      // EOCD clásico, con marcas de "mirar el ZIP64"
      .u32(0x06054b50)
      .u16(0)
      .u16(0)
      .u16(0xffff)
      .u16(0xffff)
      .u32(0xffffffff)
      .u32(0xffffffff)
      .u16(0)
      .done();
    await this.emit(tail);
  }
}
