/**
 * Minimal ZIP writer (store only, no compression, no dependencies).
 * Good enough for PNGs, which are already compressed. Names are UTF-8.
 */
const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[n] = c >>> 0;
    }
    return table;
})();

/**
 * @param {Uint8Array} bytes
 * @returns {number}
 */
export function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i += 1) {
        c = crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
}

/**
 * @param {{ name: string, data: Uint8Array }[]} files
 * @param {Date} [date]
 * @returns {Uint8Array}
 */
export function buildZip(files, date = new Date()) {
    if (files.length > 0xFFFF) {
        throw new Error('Too many files for a plain ZIP (max 65535).');
    }

    const enc = new TextEncoder();
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const dosDate = ((Math.max(date.getFullYear(), 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();

    const entries = files.map((f) => ({ nameBytes: enc.encode(f.name), data: f.data, crc: crc32(f.data), offset: 0 }));

    let total = 22; // end-of-central-directory record
    for (const e of entries) {
        total += 30 + e.nameBytes.length + e.data.length; // local header + data
        total += 46 + e.nameBytes.length; // central directory header
    }

    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    let p = 0;
    const u16 = (v) => { view.setUint16(p, v, true); p += 2; };
    const u32 = (v) => { view.setUint32(p, v, true); p += 4; };

    for (const e of entries) {
        e.offset = p;
        u32(0x04034b50); u16(20); u16(0x0800); u16(0); u16(dosTime); u16(dosDate);
        u32(e.crc); u32(e.data.length); u32(e.data.length); u16(e.nameBytes.length); u16(0);
        out.set(e.nameBytes, p); p += e.nameBytes.length;
        out.set(e.data, p); p += e.data.length;
    }

    const cdStart = p;
    for (const e of entries) {
        u32(0x02014b50); u16(20); u16(20); u16(0x0800); u16(0); u16(dosTime); u16(dosDate);
        u32(e.crc); u32(e.data.length); u32(e.data.length); u16(e.nameBytes.length);
        u16(0); u16(0); u16(0); u16(0); u32(0); u32(e.offset);
        out.set(e.nameBytes, p); p += e.nameBytes.length;
    }
    const cdSize = p - cdStart;

    u32(0x06054b50); u16(0); u16(0); u16(entries.length); u16(entries.length); u32(cdSize); u32(cdStart); u16(0);
    return out;
}
