// 签名层基础：HMAC（对应 Python live_trace.hmac_by_rule）。
// 关键约定：返回值是「十六进制摘要字符串的 UTF-8 字节」，
// 而非原始摘要字节 —— 对齐 Python `hexdigest().encode("utf-8")`。

// ---- 字节 / 字符串 / 十六进制 工具 ----

export function utf8Encode(str) {
  return new TextEncoder().encode(str);
}

export function utf8Decode(bytes) {
  return new TextDecoder().decode(bytes);
}

export function bytesToHex(bytes) {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function concatBytes(...arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

// ---- 32 位运算助手（MD5/SHA-2 都需模拟 32 位无符号）----

const mask = 0xffffffff;

function rotl32(x, n) {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

function ror32(x, n) {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

// ---- MD5（RFC 1321），返回 16 字节原始摘要 ----

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const MD5_K = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a,
  0xa8304613, 0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
  0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340,
  0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8,
  0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
  0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa,
  0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92,
  0xffeff47d, 0x85845dd1, 0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
  0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];

export function md5Raw(data) {
  const origLen = data.length;
  // 填充：0x80，然后 0，直到 length ≡ 56 (mod 64)，末尾 8 字节为 bit 长度（小端）
  const padLen = (56 - ((origLen + 1) % 64) + 64) % 64;
  const padded = new Uint8Array(origLen + 1 + padLen + 8);
  padded.set(data);
  padded[origLen] = 0x80;
  const bitLen = BigInt(origLen) * 8n;
  const dv = new DataView(padded.buffer);
  dv.setUint32(origLen + 1 + padLen, Number(bitLen & 0xffffffffn), true);
  dv.setUint32(origLen + 1 + padLen + 4, Number((bitLen >> 32n) & 0xffffffffn), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let off = 0; off < padded.length; off += 64) {
    const M = new Uint32Array(16);
    for (let j = 0; j < 16; j++) {
      M[j] = dv.getUint32(off + j * 4, true); // 小端
    }
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + MD5_K[i] + M[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + rotl32(F, MD5_S[i])) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, a0, true);
  ov.setUint32(4, b0, true);
  ov.setUint32(8, c0, true);
  ov.setUint32(12, d0, true);
  return out;
}

// ---- SHA-256 核心（FIPS 180-4），可换 IV → SHA-224，截断输出 ----

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

// SHA-256 IV
const SHA256_H = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

// SHA-224 IV
const SHA224_H = [
  0xc1059ed8, 0x367cd507, 0x3070dd17, 0xf70e5939,
  0xffc00b31, 0x68581511, 0x64f98fa7, 0xbefa4fa4,
];

function sha256Core(data, iv, outputBytes) {
  const origLen = data.length;
  const padLen = (56 - ((origLen + 1) % 64) + 64) % 64;
  const padded = new Uint8Array(origLen + 1 + padLen + 8);
  padded.set(data);
  padded[origLen] = 0x80;
  const bitLen = BigInt(origLen) * 8n;
  const dv = new DataView(padded.buffer);
  dv.setUint32(origLen + 1 + padLen, Number((bitLen >> 32n) & 0xffffffffn), false); // 大端
  dv.setUint32(origLen + 1 + padLen + 4, Number(bitLen & 0xffffffffn), false);

  let H = iv.slice();

  for (let off = 0; off < padded.length; off += 64) {
    const W = new Array(64);
    for (let j = 0; j < 16; j++) {
      W[j] = dv.getUint32(off + j * 4, false); // 大端
    }
    for (let j = 16; j < 64; j++) {
      const s0 = ror32(W[j - 15], 7) ^ ror32(W[j - 15], 18) ^ (W[j - 15] >>> 3);
      const s1 = ror32(W[j - 2], 17) ^ ror32(W[j - 2], 19) ^ (W[j - 2] >>> 10);
      W[j] = (W[j - 16] + s0 + W[j - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = ror32(e, 6) ^ ror32(e, 11) ^ ror32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA256_K[i] + W[i]) >>> 0;
      const S0 = ror32(a, 2) ^ ror32(a, 13) ^ ror32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    H = [
      (H[0] + a) >>> 0, (H[1] + b) >>> 0, (H[2] + c) >>> 0, (H[3] + d) >>> 0,
      (H[4] + e) >>> 0, (H[5] + f) >>> 0, (H[6] + g) >>> 0, (H[7] + h) >>> 0,
    ];
  }

  const out = new Uint8Array(outputBytes);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < outputBytes / 4; i++) {
    ov.setUint32(i * 4, H[i], false); // 大端
  }
  return out;
}

export function sha224Raw(data) {
  return sha256Core(data, SHA224_H, 28);
}

// ---- HMAC（手动实现，支持任意上面的 hash）----

function hmacRaw(hashFn, blockSize, data, keyBytes) {
  let k = keyBytes;
  if (k.length > blockSize) k = hashFn(k);
  const kPadded = new Uint8Array(blockSize);
  kPadded.set(k);
  const ipad = new Uint8Array(blockSize);
  const opad = new Uint8Array(blockSize);
  for (let i = 0; i < blockSize; i++) {
    ipad[i] = kPadded[i] ^ 0x36;
    opad[i] = kPadded[i] ^ 0x5c;
  }
  const inner = hashFn(concatBytes(ipad, data));
  return hashFn(concatBytes(opad, inner));
}

// rule -> {algo for SubtleCrypto} 或 {manual: hashFn, blockSize}
const RULE_TO_SUBTLE = { 1: "SHA-1", 2: "SHA-256", 4: "SHA-512", 5: "SHA-384" };

/**
 * 单轮 HMAC，返回「十六进制摘要字符串的 UTF-8 字节」。
 * rule: 0=MD5 1=SHA1 2=SHA256 3=SHA224 4=SHA512 5=SHA384
 */
export async function hmacOnce(data, key, rule) {
  const keyBytes = utf8Encode(key);
  let rawDigest;
  const subtleAlgo = RULE_TO_SUBTLE[rule];
  if (subtleAlgo) {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "HMAC", hash: subtleAlgo },
      false,
      ["sign"],
    );
    rawDigest = new Uint8Array(
      await crypto.subtle.sign("HMAC", cryptoKey, data),
    );
  } else if (rule === 0) {
    rawDigest = hmacRaw(md5Raw, 64, data, keyBytes);
  } else if (rule === 3) {
    rawDigest = hmacRaw(sha224Raw, 64, data, keyBytes);
  } else {
    throw new Error(`unsupported secret_rule: ${rule}`);
  }
  return utf8Encode(bytesToHex(rawDigest));
}

/**
 * 多轮 HMAC（对齐 build_x25kn_signature 里对 secret_rule 的迭代）。
 * ruleOrRules: number | number[]
 */
export async function hmacByRule(data, key, ruleOrRules) {
  const rules = Array.isArray(ruleOrRules) ? ruleOrRules : [ruleOrRules];
  let current = data;
  for (const r of rules) {
    current = await hmacOnce(current, key, r);
  }
  return current;
}
