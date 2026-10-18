const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const UPLOADS_DIR = path.join(__dirname, '../uploads');
const AVATARS_DIR = path.join(UPLOADS_DIR, 'avatars');
const THUMBS_DIR = path.join(UPLOADS_DIR, 'thumbnails');

// Ensure directories exist
[UPLOADS_DIR, AVATARS_DIR, THUMBS_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

/**
 * Process and optimize an uploaded avatar / profile image:
 * - Square center-crop (512x512) for profile view
 * - Square thumbnail (128x128) for rosters, leaderboards, comments
 * - Convert to WebP format with 82% quality
 * - Strip EXIF metadata
 * - Correct orientation
 * - Return web-accessible URLs and metadata
 */
async function processAvatarImage(inputFilePath, customFilename = null) {
  if (!fs.existsSync(inputFilePath)) {
    throw new Error('Image file not found for processing.');
  }

  const baseName = customFilename || `avatar-${Date.now()}-${Math.round(Math.random() * 1e8)}`;
  const avatarFilename = `${baseName}.webp`;
  const thumbFilename = `${baseName}-thumb.webp`;

  const avatarDestPath = path.join(AVATARS_DIR, avatarFilename);
  const thumbDestPath = path.join(THUMBS_DIR, thumbFilename);

  // 1. Validate image format and integrity
  let metadata;
  try {
    const image = sharp(inputFilePath);
    metadata = await image.metadata();
  } catch (err) {
    // Malformed or non-image file
    throw new Error(`Invalid or corrupted image file: ${err.message}`);
  }

  // Allowed formats
  const allowedFormats = ['jpeg', 'png', 'webp', 'jpg', 'gif', 'avif', 'tiff'];
  if (!metadata.format || !allowedFormats.includes(metadata.format.toLowerCase())) {
    throw new Error(`Unsupported image format (${metadata.format}). Allowed: JPEG, PNG, WEBP.`);
  }

  // 2. Generate 512x512 Square Profile Image
  await sharp(inputFilePath)
    .rotate() // auto-orient based on EXIF before stripping
    .resize(512, 512, {
      fit: 'cover',
      position: 'centre'
    })
    .webp({ quality: 82, effort: 4 })
    .toFile(avatarDestPath);

  // 3. Generate 128x128 Roster / Comment Thumbnail
  await sharp(inputFilePath)
    .rotate()
    .resize(128, 128, {
      fit: 'cover',
      position: 'centre'
    })
    .webp({ quality: 80, effort: 4 })
    .toFile(thumbDestPath);

  const avatarStats = fs.statSync(avatarDestPath);
  const thumbStats = fs.statSync(thumbDestPath);

  return {
    url: `/uploads/avatars/${avatarFilename}`,
    thumbnailUrl: `/uploads/thumbnails/${thumbFilename}`,
    format: 'webp',
    width: 512,
    height: 512,
    sizeBytes: avatarStats.size,
    thumbSizeBytes: thumbStats.size,
    originalFormat: metadata.format,
    originalWidth: metadata.width,
    originalHeight: metadata.height
  };
}

/**
 * General purpose sports image compressor (e.g. for banners, court photos)
 */
async function processGeneralImage(inputFilePath, maxDimension = 1200) {
  if (!fs.existsSync(inputFilePath)) {
    throw new Error('Image file not found for processing.');
  }

  const baseName = `img-${Date.now()}-${Math.round(Math.random() * 1e8)}`;
  const outFilename = `${baseName}.webp`;
  const outDestPath = path.join(UPLOADS_DIR, outFilename);

  await sharp(inputFilePath)
    .rotate()
    .resize({
      width: maxDimension,
      height: maxDimension,
      fit: 'inside',
      withoutEnlargement: true
    })
    .webp({ quality: 84 })
    .toFile(outDestPath);

  const stats = fs.statSync(outDestPath);

  return {
    url: `/uploads/${outFilename}`,
    format: 'webp',
    sizeBytes: stats.size
  };
}

module.exports = {
  processAvatarImage,
  processGeneralImage
};
