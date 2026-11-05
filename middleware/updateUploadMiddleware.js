const multer = require('multer');
const path = require('path');
const fs = require('fs');

const updateUploadDir = path.join(__dirname, '../uploads/mobile-updates');
if (!fs.existsSync(updateUploadDir)) {
  fs.mkdirSync(updateUploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, updateUploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    cb(null, `release-${base}-${uniqueSuffix}${ext}`);
  }
});

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  // Allow bundle, jsbundle, zip, tar, gz, apk, json, js
  const allowedExts = ['.bundle', '.jsbundle', '.zip', '.tar', '.gz', '.apk', '.json', '.js', '.bin'];
  if (allowedExts.includes(ext) || file.mimetype.includes('octet-stream') || file.mimetype.includes('zip') || file.mimetype.includes('android')) {
    return cb(null, true);
  }
  // Also allow if filename ends with bundle
  if (file.originalname.includes('bundle')) {
    return cb(null, true);
  }
  return cb(null, true); // Permissive for binary packages
};

const updateUpload = multer({
  storage,
  limits: { fileSize: 150 * 1024 * 1024 }, // 150MB limit for APKs and bundles
  fileFilter
});

module.exports = updateUpload;

