const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const UPLOADS_DIR = path.join(__dirname, '../uploads');
const THUMBS_DIR = path.join(UPLOADS_DIR, 'thumbnails');

if (!fs.existsSync(THUMBS_DIR)) {
  fs.mkdirSync(THUMBS_DIR, { recursive: true });
}

async function optimizeFolder(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name !== 'cache' && entry.name !== 'thumbnails') {
        await optimizeFolder(fullPath);
      }
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();
    if (!['.jpg', '.jpeg', '.png'].includes(ext)) {
      continue;
    }

    const baseName = path.basename(entry.name, ext);
    const webpPath = path.join(dir, `${baseName}.webp`);
    const thumbPath = path.join(THUMBS_DIR, `${baseName}-thumb.webp`);

    try {
      // 1. Generate optimized WebP if not exists
      if (!fs.existsSync(webpPath)) {
        await sharp(fullPath)
          .rotate()
          .resize({ width: 1200, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 82, effort: 4 })
          .toFile(webpPath);
        console.log(`[Optimized] Converted ${entry.name} -> ${baseName}.webp`);
      }

      // 2. Generate thumbnail if not exists
      if (!fs.existsSync(thumbPath)) {
        await sharp(fullPath)
          .rotate()
          .resize({ width: 300, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 80, effort: 4 })
          .toFile(thumbPath);
        console.log(`[Thumbnail] Created ${baseName}-thumb.webp`);
      }
    } catch (err) {
      console.warn(`[Warning] Could not optimize ${entry.name}:`, err.message);
    }
  }
}

async function run() {
  console.log('--- Starting Optimization of Existing Uploads ---');
  await optimizeFolder(UPLOADS_DIR);
  console.log('--- Optimization Scan Complete ---');
  process.exit(0);
}

run();

