// Builds every app icon from apps/desktop/assets/icon-source.png (transparent, square):
// a rounded tile in the brand purple with the block centered on it.
// Run: node scripts/make-icons.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const SOURCE = 'apps/desktop/assets/icon-source.png';
const BACKGROUND = '#2d0043';

async function tile(size) {
  const radius = Math.round(size * 0.22);
  const bg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="${BACKGROUND}"/></svg>`);
  const inner = Math.round(size * 0.84);
  const art = await sharp(SOURCE).trim().resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  const offset = Math.round((size - inner) / 2);
  return sharp(bg).composite([{ input: art, left: offset, top: offset }]).png({ compressionLevel: 9 }).toBuffer();
}

/** ICO with PNG entries (supported since Windows Vista). */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach(({ size, png }, i) => {
    const e = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, e);
    dir.writeUInt8(size >= 256 ? 0 : size, e + 1);
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(png.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...images.map((i) => i.png)]);
}

await mkdir('apps/desktop/assets', { recursive: true });
await mkdir('packages/web/public', { recursive: true });

const sizes = [16, 24, 32, 48, 64, 128, 256, 512];
const pngs = Object.fromEntries(await Promise.all(sizes.map(async (s) => [s, await tile(s)])));

await writeFile('apps/desktop/assets/icon.png', pngs[512]);
await writeFile('apps/desktop/assets/tray.png', pngs[32]);
await writeFile('apps/desktop/assets/tray@2x.png', pngs[64]);
await writeFile('apps/desktop/assets/icon.ico', ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: pngs[size] }))));
await writeFile('packages/web/public/favicon.png', pngs[64]);
await writeFile('packages/web/public/brand.png', pngs[128]);

// 16×16 dirt tile darkened like the background of Minecraft's server list (used by the MOTD preview).
const DIRT = [
  [134, 96, 67],
  [121, 85, 58],
  [89, 61, 41],
  [155, 118, 83],
  [104, 74, 52],
];
let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const dirt = Buffer.alloc(16 * 16 * 3);
for (let i = 0; i < 256; i++) {
  const [r, g, b] = DIRT[Math.floor(rand() * DIRT.length)];
  dirt[i * 3] = Math.round(r * 0.27);
  dirt[i * 3 + 1] = Math.round(g * 0.27);
  dirt[i * 3 + 2] = Math.round(b * 0.27);
}
await writeFile('packages/web/public/mc-dirt.png', await sharp(dirt, { raw: { width: 16, height: 16, channels: 3 } }).png().toBuffer());
console.log('Ikony hotové: apps/desktop/assets, packages/web/public');
