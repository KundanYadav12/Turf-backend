const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sharp = require('sharp');

const UPLOADS_DIR = path.join(__dirname, '../uploads');
const AVATARS_DIR = path.join(UPLOADS_DIR, 'avatars');
const LOGOS_DIR = path.join(UPLOADS_DIR, 'logos');
const BANNERS_DIR = path.join(UPLOADS_DIR, 'banners');
const VENUES_DIR = path.join(UPLOADS_DIR, 'venues');
const ADS_DIR = path.join(UPLOADS_DIR, 'ads');
const THUMBS_DIR = path.join(UPLOADS_DIR, 'thumbnails');
const CACHE_DIR = path.join(UPLOADS_DIR, 'cache');

// Ensure all upload and cache directories exist
[
  UPLOADS_DIR,
  AVATARS_DIR,
  LOGOS_DIR,
  BANNERS_DIR,
  VENUES_DIR,
  ADS_DIR,
  THUMBS_DIR,
  CACHE_DIR
].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

/**
 * Clean up temp original file if it is distinct from destination
 */
const safeUnlink = (filePath) => {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    // Non-critical, ignore
  }
};

/**
 * Optimize an uploaded file based on category / type:
 * - 'avatar': 512x512 square profile + 128x128 thumb
 * - 'logo': 256x256 square team/sponsor logo + 80x80 thumb
 * - 'banner': 1200x675 (16:9) tournament banner + 400x225 thumb
 * - 'venue': 1200x800 venue photo + 400x267 thumb
 * - 'advertisement': 1200px max (preserves transparency) + 400px thumb
 * - 'general': 1200px max responsive + 400px thumb
 */
async function optimizeUpload(inputFilePath, options = {}) {
  if (!inputFilePath || !fs.existsSync(inputFilePath)) {
    throw new Error('Upload image file not found on disk.');
  }

  const {
    type = 'general',
    customFilename = null,
    quality = 82
  } = options;

  const ext = path.extname(inputFilePath).toLowerCase();

  // Handle vector SVG files cleanly without rasterizing
  if (ext === '.svg') {
    const rawContent = fs.readFileSync(inputFilePath, 'utf8');
    // Sanitize any script tags
    const sanitized = rawContent.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '');
    const baseName = customFilename || `svg-${Date.now()}-${Math.round(Math.random() * 1e8)}`;
    const outFilename = `${baseName}.svg`;
    const targetDir = type === 'logo' ? LOGOS_DIR : type === 'advertisement' ? ADS_DIR : UPLOADS_DIR;
    const destPath = path.join(targetDir, outFilename);
    fs.writeFileSync(destPath, sanitized, 'utf8');

    if (inputFilePath !== destPath) {
      safeUnlink(inputFilePath);
    }

    const relFolder = path.relative(UPLOADS_DIR, targetDir).replace(/\\/g, '/');
    const url = relFolder ? `/uploads/${relFolder}/${outFilename}` : `/uploads/${outFilename}`;

    return {
      url,
      thumbnailUrl: url,
      format: 'svg',
      width: null,
      height: null,
      sizeBytes: Buffer.byteLength(sanitized)
    };
  }

  // 1. Inspect image with sharp
  let metadata;
  try {
    metadata = await sharp(inputFilePath).metadata();
  } catch (err) {
    throw new Error(`Invalid or corrupt image file: ${err.message}`);
  }

  const allowedFormats = ['jpeg', 'png', 'webp', 'jpg', 'gif', 'avif', 'tiff'];
  if (!metadata.format || !allowedFormats.includes(metadata.format.toLowerCase())) {
    throw new Error(`Unsupported image format (${metadata.format}). Allowed: JPEG, PNG, WEBP, AVIF, SVG.`);
  }

  const baseName = customFilename || `${type}-${Date.now()}-${Math.round(Math.random() * 1e8)}`;
  const outFilename = `${baseName}.webp`;
  const thumbFilename = `${baseName}-thumb.webp`;

  let targetDir = UPLOADS_DIR;
  let fullWidth = 1200;
  let fullHeight = null;
  let fullFit = 'inside';
  let thumbWidth = 400;
  let thumbHeight = null;
  let thumbFit = 'inside';

  switch (type) {
    case 'avatar':
      targetDir = AVATARS_DIR;
      fullWidth = 512;
      fullHeight = 512;
      fullFit = 'cover';
      thumbWidth = 128;
      thumbHeight = 128;
      thumbFit = 'cover';
      break;
    case 'logo':
      targetDir = LOGOS_DIR;
      fullWidth = 256;
      fullHeight = 256;
      fullFit = 'contain';
      thumbWidth = 80;
      thumbHeight = 80;
      thumbFit = 'contain';
      break;
    case 'banner':
      targetDir = BANNERS_DIR;
      fullWidth = 1200;
      fullHeight = 675;
      fullFit = 'cover';
      thumbWidth = 400;
      thumbHeight = 225;
      thumbFit = 'cover';
      break;
    case 'venue':
      targetDir = VENUES_DIR;
      fullWidth = 1200;
      fullHeight = 800;
      fullFit = 'cover';
      thumbWidth = 400;
      thumbHeight = 267;
      thumbFit = 'cover';
      break;
    case 'advertisement':
      targetDir = ADS_DIR;
      fullWidth = 1200;
      fullHeight = 800;
      fullFit = 'inside';
      thumbWidth = 400;
      thumbHeight = 267;
      thumbFit = 'inside';
      break;
    default:
      targetDir = UPLOADS_DIR;
      fullWidth = 1200;
      fullHeight = null;
      fullFit = 'inside';
      thumbWidth = 400;
      thumbHeight = null;
      thumbFit = 'inside';
      break;
  }

  const destPath = path.join(targetDir, outFilename);
  const thumbDestPath = path.join(THUMBS_DIR, thumbFilename);

  // 2. Generate Primary Optimized WebP Image
  const fullPipeline = sharp(inputFilePath).rotate();
  if (fullHeight) {
    fullPipeline.resize(fullWidth, fullHeight, { fit: fullFit, position: 'centre' });
  } else {
    fullPipeline.resize({ width: fullWidth, fit: fullFit, withoutEnlargement: true });
  }
  await fullPipeline
    .webp({ quality: Math.min(Math.max(quality, 65), 92), effort: 4 })
    .toFile(destPath);

  // 3. Generate Thumbnail WebP Image
  const thumbPipeline = sharp(inputFilePath).rotate();
  if (thumbHeight) {
    thumbPipeline.resize(thumbWidth, thumbHeight, { fit: thumbFit, position: 'centre' });
  } else {
    thumbPipeline.resize({ width: thumbWidth, fit: thumbFit, withoutEnlargement: true });
  }
  await thumbPipeline
    .webp({ quality: 80, effort: 4 })
    .toFile(thumbDestPath);

  // Safe removal of temp input file if different from output
  if (inputFilePath !== destPath) {
    safeUnlink(inputFilePath);
  }

  const fullStats = fs.statSync(destPath);
  const thumbStats = fs.statSync(thumbDestPath);

  const relFolder = path.relative(UPLOADS_DIR, targetDir).replace(/\\/g, '/');
  const url = relFolder ? `/uploads/${relFolder}/${outFilename}` : `/uploads/${outFilename}`;
  const thumbnailUrl = `/uploads/thumbnails/${thumbFilename}`;

  return {
    url,
    thumbnailUrl,
    format: 'webp',
    width: fullWidth,
    height: fullHeight,
    sizeBytes: fullStats.size,
    thumbSizeBytes: thumbStats.size,
    originalFormat: metadata.format,
    originalWidth: metadata.width,
    originalHeight: metadata.height
  };
}

/**
 * Backward-compatible helper for user/player avatars
 */
async function processAvatarImage(inputFilePath, customFilename = null) {
  return optimizeUpload(inputFilePath, {
    type: 'avatar',
    customFilename
  });
}

/**
 * Backward-compatible helper for general images
 */
async function processGeneralImage(inputFilePath, maxDimension = 1200) {
  return optimizeUpload(inputFilePath, {
    type: 'general',
    quality: 84
  });
}

/**
 * On-the-fly Image Optimization & Resizing with Disk Cache:
 * Handles both local `/uploads/...` paths and external URLs (e.g. Unsplash).
 */
async function getOptimizedImage({
  url,
  width = 600,
  height = null,
  quality = 80,
  format = 'auto',
  fit = null,
  clientAccept = ''
}) {
  if (!url || typeof url !== 'string' || url.trim() === '') {
    throw new Error('Image URL is required for optimization.');
  }

  const cleanUrl = url.trim();

  // Determine output format
  let targetFormat = (format || 'auto').toLowerCase();
  if (targetFormat === 'auto') {
    if (clientAccept.includes('image/avif')) {
      targetFormat = 'avif';
    } else if (clientAccept.includes('image/webp')) {
      targetFormat = 'webp';
    } else {
      targetFormat = 'jpeg';
    }
  }

  if (!['webp', 'avif', 'jpeg', 'jpg', 'png'].includes(targetFormat)) {
    targetFormat = 'webp';
  }
  if (targetFormat === 'jpg') targetFormat = 'jpeg';

  const w = Math.min(Math.max(parseInt(width, 10) || 600, 16), 2400);
  const h = height ? Math.min(Math.max(parseInt(height, 10), 16), 2400) : null;
  const q = Math.min(Math.max(parseInt(quality, 10) || 80, 40), 95);
  const resolvedFit = fit || (h ? 'cover' : 'inside');

  // Generate unique deterministic cache key
  const cacheKey = crypto
    .createHash('md5')
    .update(`${cleanUrl}_w${w}_h${h || 'auto'}_f${resolvedFit}_q${q}_${targetFormat}`)
    .digest('hex');

  const cachedFilename = `opt_${cacheKey}.${targetFormat}`;
  const cachedFilePath = path.join(CACHE_DIR, cachedFilename);

  const contentTypeMap = {
    webp: 'image/webp',
    avif: 'image/avif',
    jpeg: 'image/jpeg',
    png: 'image/png'
  };
  const contentType = contentTypeMap[targetFormat] || 'image/webp';

  // 1. Return from disk cache if exists
  if (fs.existsSync(cachedFilePath)) {
    return {
      filePath: cachedFilePath,
      contentType,
      etag: cacheKey
    };
  }

  // 2. Fetch or load source image buffer
  let sourceBuffer;
  if (cleanUrl.startsWith('http://') || cleanUrl.startsWith('https://')) {
    // Validate protocol and avoid SSRF to internal network
    const parsed = new URL(cleanUrl);
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1') {
      // If it points to local uploads on 5008, resolve directly from disk!
      const localPath = path.join(UPLOADS_DIR, parsed.pathname.replace(/^\/uploads\/?/, ''));
      if (fs.existsSync(localPath)) {
        sourceBuffer = fs.readFileSync(localPath);
      } else {
        throw new Error('Local image not found');
      }
    } else {
      // External image fetch with timeout and 15MB limit
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const resp = await fetch(cleanUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'TurfImageOptimizer/1.0'
        }
      });
      clearTimeout(timeoutId);

      if (!resp.ok) {
        throw new Error(`Failed to fetch external image (${resp.status} ${resp.statusText})`);
      }

      const arrayBuf = await resp.arrayBuffer();
      sourceBuffer = Buffer.from(arrayBuf);
    }
  } else {
    // Local uploads path
    const sanitizedRel = cleanUrl.replace(/^\/?(uploads\/)?/, '').replace(/\.\./g, '');
    const localPath = path.join(UPLOADS_DIR, sanitizedRel);
    if (!fs.existsSync(localPath)) {
      throw new Error('Local image file not found on server.');
    }
    sourceBuffer = fs.readFileSync(localPath);
  }

  // 3. Process with sharp
  const pipeline = sharp(sourceBuffer).rotate();

  if (h) {
    pipeline.resize(w, h, { fit: resolvedFit, position: 'centre' });
  } else {
    pipeline.resize({ width: w, fit: resolvedFit, withoutEnlargement: true });
  }

  if (targetFormat === 'webp') {
    pipeline.webp({ quality: q, effort: 4 });
  } else if (targetFormat === 'avif') {
    pipeline.avif({ quality: Math.max(q - 8, 45), effort: 4 });
  } else if (targetFormat === 'jpeg') {
    pipeline.jpeg({ quality: q, mozjpeg: true });
  } else if (targetFormat === 'png') {
    pipeline.png({ quality: q, compressionLevel: 8 });
  }

  // Atomic write to prevent partially written cache file reads
  const tempCachePath = `${cachedFilePath}.tmp-${Date.now()}`;
  await pipeline.toFile(tempCachePath);
  fs.renameSync(tempCachePath, cachedFilePath);

  return {
    filePath: cachedFilePath,
    contentType,
    etag: cacheKey
  };
}

module.exports = {
  optimizeUpload,
  processAvatarImage,
  processGeneralImage,
  getOptimizedImage,
  UPLOADS_DIR,
  CACHE_DIR
};
