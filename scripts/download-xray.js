'use strict';
// Download a pinned Xray-core Linux binary at build time (postinstall),
// so a cold start on Cloady does not have to download it again.
// Falls back to the system `unzip` when available, otherwise extracts
// the single `xray` entry with a small central-directory ZIP reader.
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const VERSION = process.env.XRAY_VERSION || 'v1.8.24';
const URL = `https://github.com/XTLS/Xray-core/releases/download/${VERSION}/Xray-linux-64.zip`;
const DIR = path.join(__dirname, '..');
const ZIP = path.join(DIR, 'Xray-linux-64.zip');
const BIN = path.join(DIR, 'xray');

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'cloady-xray' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`download failed: HTTP ${res.statusCode} from ${url}`));
      }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
    });
    req.on('error', reject);
  });
}

function extractWithCentralDirectory(zipPath, outPath) {
  const buf = fs.readFileSync(zipPath);
  // Find End Of Central Directory (EOCD) by scanning backwards.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP EOCD not found');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    if (name === 'xray') {
      const lh = localOff;
      if (buf.readUInt32LE(lh) !== 0x04034b50) throw new Error('bad local header');
      const lhNameLen = buf.readUInt16LE(lh + 26);
      const lhExtraLen = buf.readUInt16LE(lh + 28);
      const dataOff = lh + 30 + lhNameLen + lhExtraLen;
      const data = buf.subarray(dataOff, dataOff + compSize);
      const raw = method === 8 ? zlib.inflateRawSync(data) : method === 0 ? data : null;
      if (!raw) throw new Error(`unsupported ZIP method ${method}`);
      fs.writeFileSync(outPath, raw, { mode: 0o755 });
      return;
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('xray entry not found in ZIP');
}

async function main() {
  if (fs.existsSync(BIN)) {
    console.log('xray binary already present, skipping download');
    return;
  }
  console.log(`downloading ${URL}`);
  await download(URL, ZIP);
  try {
    execFileSync('unzip', ['-o', ZIP, 'xray', '-d', DIR], { stdio: 'inherit' });
  } catch {
    console.log('unzip not available, using built-in extractor');
    extractWithCentralDirectory(ZIP, BIN);
  }
  fs.chmodSync(BIN, 0o755);
  try { fs.unlinkSync(ZIP); } catch {}
  console.log('xray ready:', BIN);
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
module.exports = { extractWithCentralDirectory };
