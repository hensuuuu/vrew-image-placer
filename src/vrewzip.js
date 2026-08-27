// ============================================================
// .vrew ZIP 읽기/쓰기 — 외부 라이브러리 없음
// .vrew 안의 항목은 전부 STORED(무압축)라 바이트를 잘라내면 된다.
// ============================================================

export function readZip(buf) {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);

  let eocd = -1;
  const floor = Math.max(0, buf.byteLength - 66000);
  for (let i = buf.byteLength - 22; i >= floor; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP 구조를 읽지 못했습니다');

  let count = dv.getUint16(eocd + 10, true);
  let cdOff = dv.getUint32(eocd + 16, true);

  if (cdOff === 0xffffffff || count === 0xffff) {
    for (let i = eocd - 20; i >= 0; i--) {
      if (dv.getUint32(i, true) === 0x07064b50) {
        const z64 = Number(dv.getBigUint64(i + 8, true));
        count = Number(dv.getBigUint64(z64 + 32, true));
        cdOff = Number(dv.getBigUint64(z64 + 48, true));
        break;
      }
    }
  }

  const dec = new TextDecoder('utf-8');
  const entries = [];
  let p = cdOff;

  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extLen = dv.getUint16(p + 30, true);
    const cmtLen = dv.getUint16(p + 32, true);
    let compSize = dv.getUint32(p + 20, true);
    let rawSize = dv.getUint32(p + 24, true);
    let localOff = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));

    if (compSize === 0xffffffff || rawSize === 0xffffffff || localOff === 0xffffffff) {
      let e = p + 46 + nameLen;
      const endExt = e + extLen;
      while (e < endExt) {
        const hid = dv.getUint16(e, true);
        const hsz = dv.getUint16(e + 2, true);
        if (hid === 0x0001) {
          let q = e + 4;
          if (rawSize === 0xffffffff) { rawSize = Number(dv.getBigUint64(q, true)); q += 8; }
          if (compSize === 0xffffffff) { compSize = Number(dv.getBigUint64(q, true)); q += 8; }
          if (localOff === 0xffffffff) { localOff = Number(dv.getBigUint64(q, true)); q += 8; }
          break;
        }
        e += 4 + hsz;
      }
    }

    entries.push({ name, method, compSize, rawSize, localOff });
    p += 46 + nameLen + extLen + cmtLen;
  }

  for (const en of entries) {
    const lp = en.localOff;
    if (dv.getUint32(lp, true) !== 0x04034b50) {
      throw new Error('ZIP 항목이 손상되었습니다: ' + en.name);
    }
    en.dataOff = lp + 30 + dv.getUint16(lp + 26, true) + dv.getUint16(lp + 28, true);
  }
  return entries;
}

export function entryBytes(buf, en) {
  if (en.method !== 0) throw new Error('압축된 항목은 지원하지 않습니다: ' + en.name);
  return new Uint8Array(buf, en.dataOff, en.compSize);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) {
    c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const Z64 = 0xffffffff;

// items: [{name, bytes}] — 전부 STORED로 기록한다.
export function writeZip(items) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const it of items) {
    const nameBytes = enc.encode(it.name);
    const size = it.bytes.length;
    const crc = crc32(it.bytes);
    const big = size >= Z64 || offset >= Z64;

    const lh = new Uint8Array(30 + nameBytes.length + (big ? 20 : 0));
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, big ? 45 : 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, big ? Z64 : size, true);
    lv.setUint32(22, big ? Z64 : size, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, big ? 20 : 0, true);
    lh.set(nameBytes, 30);
    if (big) {
      const ev = new DataView(lh.buffer, 30 + nameBytes.length);
      ev.setUint16(0, 0x0001, true);
      ev.setUint16(2, 16, true);
      ev.setBigUint64(4, BigInt(size), true);
      ev.setBigUint64(12, BigInt(size), true);
    }

    parts.push(lh, it.bytes);
    central.push({ nameBytes, crc, size, offset, big });
    offset += lh.length + size;
  }

  const cdStart = offset;
  for (const c of central) {
    const big = c.big || c.offset >= Z64;
    const extra = big ? 28 : 0;
    const ch = new Uint8Array(46 + c.nameBytes.length + extra);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 45, true);
    cv.setUint16(6, big ? 45 : 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(16, c.crc, true);
    cv.setUint32(20, big ? Z64 : c.size, true);
    cv.setUint32(24, big ? Z64 : c.size, true);
    cv.setUint16(28, c.nameBytes.length, true);
    cv.setUint16(30, extra, true);
    cv.setUint32(42, big ? Z64 : c.offset, true);
    ch.set(c.nameBytes, 46);
    if (big) {
      const ev = new DataView(ch.buffer, 46 + c.nameBytes.length);
      ev.setUint16(0, 0x0001, true);
      ev.setUint16(2, 24, true);
      ev.setBigUint64(4, BigInt(c.size), true);
      ev.setBigUint64(12, BigInt(c.size), true);
      ev.setBigUint64(20, BigInt(c.offset), true);
    }
    parts.push(ch);
    offset += ch.length;
  }
  const cdSize = offset - cdStart;

  if (cdStart >= Z64 || central.length >= 0xffff || cdSize >= Z64) {
    const z64 = new Uint8Array(76);
    const zv = new DataView(z64.buffer);
    zv.setUint32(0, 0x06064b50, true);
    zv.setBigUint64(4, BigInt(44), true);
    zv.setUint16(12, 45, true);
    zv.setUint16(14, 45, true);
    zv.setBigUint64(24, BigInt(central.length), true);
    zv.setBigUint64(32, BigInt(central.length), true);
    zv.setBigUint64(40, BigInt(cdSize), true);
    zv.setBigUint64(48, BigInt(cdStart), true);
    zv.setUint32(56, 0x07064b50, true);
    zv.setBigUint64(64, BigInt(offset), true);
    zv.setUint32(72, 1, true);
    parts.push(z64);
  }

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, Math.min(central.length, 0xffff), true);
  ev.setUint16(10, Math.min(central.length, 0xffff), true);
  ev.setUint32(12, Math.min(cdSize, Z64), true);
  ev.setUint32(16, Math.min(cdStart, Z64), true);
  parts.push(eocd);

  return new Blob(parts, { type: 'application/octet-stream' });
}
