/**
 * SHA-256 y HMAC-SHA256 en JavaScript puro.
 *
 * ¿Por qué a mano? El sandbox de scripts de Prolibu NO expone Buffer, crypto,
 * TextEncoder, atob ni btoa (verificado con la sonda `gensys-probe`). Lo único
 * que hay de bajo nivel son los typed arrays de V8. Así que el UTF-8 también se
 * codifica a mano, igual que el base64 de gensys-factura/lib/pdfBytes.js.
 *
 * Lo usa el sello de Facturación (reglas-negocio/lib/sello.js): gensys-factura
 * firma y el hook de Deal verifica. Como son dos scripts distintos, los dos
 * lados tienen que producir exactamente los mismos bytes: por eso el mensaje se
 * codifica siempre como UTF-8 (lo mismo que hace `crypto.createHmac(...).update(str)`
 * en Node, que es contra lo que se prueba en test/hmac.test.js).
 *
 * No es para volúmenes grandes: procesa todo en memoria. Para firmar un sello de
 * ~150 bytes sobra.
 */

// Primeros 32 bits de la parte fraccionaria de las raíces cúbicas de los 64
// primeros primos (FIPS 180-4 §4.2.2). Van escritos y no calculados con
// Math.cbrt porque la precisión de cbrt no está garantizada entre motores.
const K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const H0 = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

const BLOCK_SIZE = 64;

/**
 * String → bytes UTF-8, sin TextEncoder.
 *
 * Recorre code points (no unidades UTF-16) para que los emoji y demás
 * caracteres fuera del plano básico salgan en 4 bytes y no como dos
 * surrogates de 3 bytes cada uno. Un surrogate suelto se reemplaza por U+FFFD,
 * igual que TextEncoder y Buffer: si no, este lado y Node firmarían bytes
 * distintos para el mismo string.
 */
function utf8Encode(str) {
  const s = String(str);
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let cp = s.charCodeAt(i);

    if (cp >= 0xd800 && cp <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else {
        cp = 0xfffd;
      }
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      cp = 0xfffd;
    }

    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

// Acepta string (se codifica UTF-8) o bytes ya armados (Uint8Array / array de
// 0-255). Los bytes crudos existen para poder correr los vectores del RFC 4231,
// cuyas claves (0x0b…, 0xaa…) no son UTF-8 válido.
function toBytes(input) {
  if (typeof input === 'string') return utf8Encode(input);
  // isView y no `instanceof Uint8Array`: un typed array creado en otro realm
  // (la VM del sandbox, un test con vm) no pasa el instanceof.
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (Array.isArray(input)) return Uint8Array.from(input);
  if (input === undefined || input === null) return new Uint8Array(0);
  return utf8Encode(String(input));
}

/**
 * SHA-256 de bytes → Uint8Array(32).
 */
function sha256Bytes(input) {
  const bytes = toBytes(input);
  const len = bytes.length;

  // Relleno: 0x80, ceros, y el largo en BITS como entero de 64 bits big-endian.
  // El largo se parte en dos mitades de 32 bits porque los operadores de bits
  // de JS truncan a 32: `len << 3` desbordaría pasando los 512 MB.
  const total = Math.ceil((len + 9) / BLOCK_SIZE) * BLOCK_SIZE;
  const p = new Uint8Array(total);
  p.set(bytes);
  p[len] = 0x80;
  const bitsHi = Math.floor(len / 0x20000000);
  const bitsLo = (len * 8) >>> 0;
  p[total - 8] = bitsHi >>> 24;
  p[total - 7] = (bitsHi >>> 16) & 0xff;
  p[total - 6] = (bitsHi >>> 8) & 0xff;
  p[total - 5] = bitsHi & 0xff;
  p[total - 4] = bitsLo >>> 24;
  p[total - 3] = (bitsLo >>> 16) & 0xff;
  p[total - 2] = (bitsLo >>> 8) & 0xff;
  p[total - 1] = bitsLo & 0xff;

  const H = new Int32Array(H0);
  const W = new Int32Array(64);

  for (let off = 0; off < total; off += BLOCK_SIZE) {
    for (let t = 0; t < 16; t++) {
      const j = off + t * 4;
      W[t] = (p[j] << 24) | (p[j + 1] << 16) | (p[j + 2] << 8) | p[j + 3];
    }
    for (let t = 16; t < 64; t++) {
      const x2 = W[t - 2];
      const x15 = W[t - 15];
      const s1 = ((x2 >>> 17) | (x2 << 15)) ^ ((x2 >>> 19) | (x2 << 13)) ^ (x2 >>> 10);
      const s0 = ((x15 >>> 7) | (x15 << 25)) ^ ((x15 >>> 18) | (x15 << 14)) ^ (x15 >>> 3);
      W[t] = (s1 + W[t - 7] + s0 + W[t - 16]) | 0;
    }

    let a = H[0];
    let b = H[1];
    let c = H[2];
    let d = H[3];
    let e = H[4];
    let f = H[5];
    let g = H[6];
    let h = H[7];

    for (let t = 0; t < 64; t++) {
      // `| 0` después de cada suma: mantiene todo en int32 y replica el mod 2^32.
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const T1 = (h + S1 + ch + K[t] + W[t]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const T2 = (S0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + T1) | 0;
      d = c;
      c = b;
      b = a;
      a = (T1 + T2) | 0;
    }

    H[0] = (H[0] + a) | 0;
    H[1] = (H[1] + b) | 0;
    H[2] = (H[2] + c) | 0;
    H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0;
    H[5] = (H[5] + f) | 0;
    H[6] = (H[6] + g) | 0;
    H[7] = (H[7] + h) | 0;
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    out[i * 4] = H[i] >>> 24;
    out[i * 4 + 1] = (H[i] >>> 16) & 0xff;
    out[i * 4 + 2] = (H[i] >>> 8) & 0xff;
    out[i * 4 + 3] = H[i] & 0xff;
  }
  return out;
}

function toHex(bytes) {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  }
  return hex;
}

/**
 * HMAC-SHA256 (RFC 2104) → Uint8Array(32).
 */
function hmacSha256Bytes(key, message) {
  let k = toBytes(key);
  // Clave más larga que el bloque: se reemplaza por su hash (RFC 2104 §2).
  // Ojo que el corte es > 64, no >= 64: una clave de exactamente 64 bytes va tal cual.
  if (k.length > BLOCK_SIZE) k = sha256Bytes(k);

  const msg = toBytes(message);
  const inner = new Uint8Array(BLOCK_SIZE + msg.length);
  const outer = new Uint8Array(BLOCK_SIZE + 32);
  for (let i = 0; i < BLOCK_SIZE; i++) {
    const kb = i < k.length ? k[i] : 0;
    inner[i] = kb ^ 0x36;
    outer[i] = kb ^ 0x5c;
  }
  inner.set(msg, BLOCK_SIZE);
  outer.set(sha256Bytes(inner), BLOCK_SIZE);
  return sha256Bytes(outer);
}

/**
 * SHA-256 en hex minúsculas. `str` se codifica UTF-8 (también acepta bytes).
 */
function sha256Hex(str) {
  return toHex(sha256Bytes(str));
}

/**
 * HMAC-SHA256 en hex minúsculas. Clave y mensaje se codifican UTF-8 cuando son
 * strings; también aceptan Uint8Array / array de bytes.
 */
function hmacSha256Hex(keyStr, messageStr) {
  return toHex(hmacSha256Bytes(keyStr, messageStr));
}

/**
 * Comparación de strings en tiempo constante respecto del contenido.
 *
 * Con `===` un atacante podría ir adivinando la firma carácter por carácter
 * midiendo cuánto tarda el rechazo. Acá se recorre siempre el largo completo de
 * `a` y las diferencias se acumulan con OR, sin salir antes. Si los largos no
 * coinciden el resultado es false, pero igual se recorre todo: el largo en sí no
 * es secreto (una firma hex siempre mide 64), lo que no se filtra es DÓNDE difiere.
 *
 * Cualquier cosa que no sea string → false (nunca se compara "undefined" con "undefined").
 */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const lenA = a.length;
  const lenB = b.length;
  let diff = lenA ^ lenB;
  for (let i = 0; i < lenA; i++) {
    // Con largos distintos se compara contra b "circular"; da igual el valor,
    // `diff` ya es distinto de 0. Lo que importa es no cortar el bucle.
    const cb = lenB ? b.charCodeAt(i % lenB) : 0;
    diff |= a.charCodeAt(i) ^ cb;
  }
  return diff === 0;
}

module.exports = {
  sha256Hex,
  hmacSha256Hex,
  timingSafeEqual,
  sha256Bytes,
  hmacSha256Bytes,
  utf8Encode,
  toHex,
};
