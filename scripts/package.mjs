/** Deterministic ZIP with Unix executable modes; no platform zip binary needed. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { releaseFiles, publicCheck, root } from './release-files.mjs';

const scan = publicCheck();
const table = Array.from({ length: 256 }, (_, byte) => {
  let value = byte;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
const crc32 = bytes => {
  let value = 0xffffffff;
  for (const byte of bytes) value = table[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
};
const local = [], central = []; let offset = 0;
for (const relative of releaseFiles()) {
  const name = Buffer.from(`dsh-plugins/${relative}`, 'utf8');
  const data = fs.readFileSync(path.join(root, relative));
  const compressed = deflateRawSync(data, { level: 9 });
  const checksum = crc32(data);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6); header.writeUInt16LE(8, 8);
  header.writeUInt16LE(33, 12); // Stable DOS date: 1980-01-01.
  header.writeUInt32LE(checksum, 14); header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
  const directory = Buffer.alloc(46);
  directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(0x0314, 4);
  directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x0800, 8);
  directory.writeUInt16LE(8, 10); directory.writeUInt16LE(33, 14);
  directory.writeUInt32LE(checksum, 16); directory.writeUInt32LE(compressed.length, 20);
  directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(name.length, 28);
  directory.writeUInt32LE(((relative.endsWith('.command') ? 0o100755 : 0o100644) * 65536) >>> 0, 38);
  directory.writeUInt32LE(offset, 42);
  local.push(header, name, compressed); central.push(directory, name);
  offset += header.length + name.length + compressed.length;
}
const index = Buffer.concat(central), end = Buffer.alloc(22), count = central.length / 2;
end.writeUInt32LE(0x06054b50); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
const zip = Buffer.concat([...local, index, end]);
const destination = path.join(root, 'dist'); fs.mkdirSync(destination, { recursive: true });
fs.writeFileSync(path.join(destination, 'dsh-plugins-mac.zip'), zip);
const receipt = { filename: 'dsh-plugins-mac.zip', bytes: zip.length, entries: count,
  sha256: createHash('sha256').update(zip).digest('hex'), scan,
  macNativeInstallation: 'pending; required native preflight runs during installation' };
fs.writeFileSync(path.join(destination, 'package-verification.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt));
