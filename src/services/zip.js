/**
 * Minimal ZIP reader/writer, on Node's built-in zlib. No new dependency.
 *
 * WHY THIS EXISTS
 *
 * Data has to move between a desktop install and a self-hosted server, and the
 * obvious container for that is a single .zip the operator can download, keep
 * and re-import. No archive library is a dependency of this project, and adding
 * one for a single feature is a larger change than warranted — so this is a
 * small, purpose-built implementation of exactly the subset ZIP needs:
 * stored entries (method 0) and deflated entries (method 8), no encryption,
 * no ZIP64, no multi-disk archives.
 *
 * DEFLATE IS USED ONLY FOR THE SQL DUMP. Uploaded images are already WebP,
 * which is a compressed format, so deflating them costs CPU and saves nothing.
 * They are stored verbatim, which also means a byte-for-byte round trip.
 *
 * SCOPE LIMITS, DELIBERATE
 *
 *   * No ZIP64. An export above 4 GB or with more than 65535 entries fails.
 *     A single-user costume collection is orders of magnitude below that.
 *   * Single-disk only, which is what every real ZIP produced by a desktop OS
 *     is.
 *   * `crc32` is the standard IEEE polynomial, needed because the format
 *     requires a checksum even though content is also verified on read.
 */
const fs = require('fs');
const zlib = require('zlib');

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

// Fixed MS-DOS timestamp (2024-01-01 00:00:00). Every entry carrying the
// current time would make two exports of identical data differ byte-for-byte,
// which makes "did anything actually change?" unanswerable by comparing files.
// The mtime is metadata, not content, and nothing reads it back.
const DOS_TIME = 0;
const DOS_DATE = ((2024 - 1980) << 9) | (1 << 5) | 1;

// ---------------------------------------------------------------------------
// CRC32
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32Update(crc, buf) {
  let c = ~crc;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function crc32(buf) {
  return crc32Update(0, buf);
}

// Bounds shared by the reader and the transfer service. An import accepts a
// file from outside, so these are a trust boundary: a zip bomb declares a
// plausible size and expands to gigabytes, and without a ceiling one upload
// would exhaust the disk.
const LIMITS = {
  maxEntries: 50000,
  maxEntryBytes: 256 * 1024 * 1024, // 256 MB — one image, generously
  maxTotalBytes: 2 * 1024 * 1024 * 1024
};


// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------
class ZipWriter {
  /** @param {number} fd open file descriptor, positioned at 0 */
  constructor(fd) {
    this.fd = fd;
    this.offset = 0;
    this.entries = [];
  }

  /** Write at the current position, or at an explicit offset when patching. */
  _write(buf, position) {
    if (position === undefined) {
      this.offset += fs.writeSync(this.fd, buf, 0, buf.length, this.offset);
    } else {
      fs.writeSync(this.fd, buf, 0, buf.length, position);
    }
  }

  /** Build the 30-byte local file header. */
  _localHeader(nameLen, method, checksum, compSize, size) {
    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL_SIG, 0);
    header.writeUInt16LE(20, 4);            // version needed
    header.writeUInt16LE(0, 6);             // flags
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(DOS_TIME, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(compSize, 18);
    header.writeUInt32LE(size, 22);
    header.writeUInt16LE(nameLen, 26);
    header.writeUInt16LE(0, 28);            // extra length
    return header;
  }

  /** Write one entry from a buffer, deflating it when that is actually smaller. */
  addBuffer(name, data) {
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const checksum = crc32(data);
    const nameBuf = Buffer.from(name, 'utf8');

    const localOffset = this.offset;
    this._write(this._localHeader(nameBuf.length, method, checksum, body.length, data.length));
    this._write(nameBuf);
    this._write(body);

    this.entries.push({ name, nameBuf, method, checksum, compSize: body.length, size: data.length, localOffset });
  }

  /**
   * Write one entry from a file on disk, in a single read pass.
   *
   * The local header is written with a placeholder CRC, then patched afterwards.
   * That is what allows one pass over the file: the alternative reads every
   * image twice (once to checksum, once to copy), doubling the IO of the
   * largest part of an export. The central directory written by close() always
   * carries the real values, and readers use those.
   */
  addFile(name, filePath) {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error(`Not a regular file: ${name}`);
    const size = stat.size;
    const nameBuf = Buffer.from(name, 'utf8');

    const localOffset = this.offset;
    this._write(this._localHeader(nameBuf.length, 0, 0, size, size));
    this._write(nameBuf);

    const chunk = Buffer.alloc(64 * 1024);
    let crc = 0;
    let remaining = size;
    const src = fs.openSync(filePath, 'r');
    try {
      while (remaining > 0) {
        const read = fs.readSync(src, chunk, 0, Math.min(chunk.length, remaining), null);
        if (read <= 0) throw new Error(`Unexpected end of file reading ${name}`);
        crc = crc32Update(crc, chunk.subarray(0, read));
        this._write(chunk.subarray(0, read));
        remaining -= read;
      }
    } finally {
      fs.closeSync(src);
    }

    const crcPatch = Buffer.alloc(4);
    crcPatch.writeUInt32LE(crc >>> 0, 0);
    this._write(crcPatch, localOffset + 14);

    this.entries.push({ name, nameBuf, method: 0, checksum: crc >>> 0, compSize: size, size, localOffset });
  }

  /** Write the central directory and end-of-central-directory record. */
  close() {
    const cdStart = this.offset;
    for (const e of this.entries) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(CENTRAL_SIG, 0);
      header.writeUInt16LE(20, 4);          // version made by
      header.writeUInt16LE(20, 6);          // version needed
      header.writeUInt16LE(0, 8);           // flags
      header.writeUInt16LE(e.method, 10);
      header.writeUInt16LE(DOS_TIME, 12);
      header.writeUInt16LE(DOS_DATE, 14);
      header.writeUInt32LE(e.checksum, 16);
      header.writeUInt32LE(e.compSize, 20);
      header.writeUInt32LE(e.size, 24);
      header.writeUInt16LE(e.nameBuf.length, 28);
      header.writeUInt16LE(0, 30);          // extra
      header.writeUInt16LE(0, 32);          // comment
      header.writeUInt16LE(0, 34);          // disk number start
      header.writeUInt16LE(0, 36);          // internal attrs
      header.writeUInt32LE(0, 38);          // external attrs
      header.writeUInt32LE(e.localOffset, 42);
      this._write(header);
      this._write(e.nameBuf);
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIG, 0);
    eocd.writeUInt16LE(0, 4);                // this disk
    eocd.writeUInt16LE(0, 6);                // disk with central directory
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(this.offset - cdStart, 12);
    eocd.writeUInt32LE(cdStart, 16);
    eocd.writeUInt16LE(0, 20);               // comment length
    this._write(eocd);

    return { entries: this.entries.length, bytes: this.offset };
  }
}

/** Build a .zip at `outPath` from entries of {name, buffer} or {name, file}. */
function createZip(outPath, entries) {
  const fd = fs.openSync(outPath, 'w');
  try {
    const writer = new ZipWriter(fd);
    for (const entry of entries) {
      if (entry.buffer !== undefined) writer.addBuffer(entry.name, entry.buffer);
      else writer.addFile(entry.name, entry.file);
    }
    return writer.close();
  } finally {
    fs.closeSync(fd);
  }
}


// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/**
 * Open an archive and return every entry's metadata.
 *
 * The end-of-central-directory record sits at the very end unless there is an
 * archive comment, so it is found by scanning backwards over the last 64 KB —
 * the maximum comment length the format allows, plus the record itself.
 *
 * The returned `fd` is owned by the caller and must be released with
 * closeZip(), including on the error paths.
 */
function readZip(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size < 22) throw new Error('Not a ZIP file: too small to contain a directory');

  const fd = fs.openSync(filePath, 'r');
  try {
    const tailLength = Math.min(stat.size, 22 + 0xffff);
    const tail = Buffer.alloc(tailLength);
    fs.readSync(fd, tail, 0, tailLength, stat.size - tailLength);

    let eocdPos = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) { eocdPos = i; break; }
    }
    if (eocdPos === -1) throw new Error('Not a ZIP file: no end-of-central-directory record');

    const entryCount = tail.readUInt16LE(eocdPos + 10);
    const cdSize = tail.readUInt32LE(eocdPos + 12);
    const cdOffset = tail.readUInt32LE(eocdPos + 16);

    if (entryCount > LIMITS.maxEntries) {
      throw new Error(`Archive declares ${entryCount} entries; the limit is ${LIMITS.maxEntries}.`);
    }

    // ZIP64 saturates the 32-bit fields rather than lying about them, so a
    // 0xffffffff here means "look elsewhere" and reading from it would seek to
    // a nonsense offset. Refuse rather than misread.
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff || entryCount === 0xffff) {
      throw new Error('ZIP64 archives are not supported. Re-export with ZIP64 disabled.');
    }

    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);

    const entries = [];
    let p = 0;
    for (let i = 0; i < entryCount; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== CENTRAL_SIG) {
        throw new Error('Corrupt ZIP: central directory entry is malformed.');
      }
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const checksum = cd.readUInt32LE(p + 16);
      const compSize = cd.readUInt32LE(p + 20);
      const size = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOffset = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');

      // Bit 0 is encryption. There is no use case here for an encrypted
      // collection, and ignoring the flag would silently yield garbage.
      if (flags & 0x1) throw new Error(`Entry "${name}" is encrypted, which is not supported.`);
      if (method !== 0 && method !== 8) {
        throw new Error(`Entry "${name}" uses unsupported compression method ${method}.`);
      }
      if (size > LIMITS.maxEntryBytes) {
        throw new Error(`Entry "${name}" declares ${size} bytes, over the ${LIMITS.maxEntryBytes} byte limit.`);
      }

      // The local header repeats the name and extra field, and its own extra
      // length may differ from the central one, so the data offset is only
      // knowable by reading it rather than by arithmetic.
      const localHeader = Buffer.alloc(30);
      fs.readSync(fd, localHeader, 0, 30, localOffset);
      if (localHeader.readUInt32LE(0) !== LOCAL_SIG) {
        throw new Error(`Corrupt ZIP: local header for "${name}" is malformed.`);
      }
      const dataOffset = localOffset
        + 30
        + localHeader.readUInt16LE(26)
        + localHeader.readUInt16LE(28);

      entries.push({ name, method, checksum, compSize, size, dataOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }

    return { fd, size: stat.size, entries };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

/** Read one entry into a buffer, verifying its declared size and CRC. */
function readEntry(archive, entry) {
  const raw = Buffer.alloc(entry.compSize);
  fs.readSync(archive.fd, raw, 0, entry.compSize, entry.dataOffset);

  let data;
  if (entry.method === 0) {
    data = raw;
  } else {
    try {
      data = zlib.inflateRawSync(raw, { maxOutputLength: LIMITS.maxEntryBytes });
    } catch (error) {
      throw new Error(`Could not decompress "${entry.name}": ${error.message}`);
    }
  }

  if (data.length !== entry.size) {
    throw new Error(`Corrupt ZIP: "${entry.name}" is ${data.length} bytes but declares ${entry.size}.`);
  }
  if (crc32(data) !== entry.checksum) {
    throw new Error(`Corrupt ZIP: "${entry.name}" failed its checksum. The file is truncated or edited.`);
  }
  return data;
}

function closeZip(archive) {
  fs.closeSync(archive.fd);
}

module.exports = { createZip, readZip, readEntry, closeZip, crc32, LIMITS };
