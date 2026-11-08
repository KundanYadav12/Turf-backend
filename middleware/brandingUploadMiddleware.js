const multer = require('multer');
const path = require('path');
const fs = require('fs');

const uploadDir = path.join(__dirname, '../uploads/branding');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `tmp-${file.fieldname}-${uniqueSuffix}${ext}`);
  }
});

const fileFilter = (req, file, cb) => {
  const allowedExts = /jpeg|jpg|png|webp|svg|ico/;
  const extname = allowedExts.test(path.extname(file.originalname).toLowerCase());
  const isSvg = file.mimetype === 'image/svg+xml' || path.extname(file.originalname).toLowerCase() === '.svg';
  const isIco = file.mimetype === 'image/x-icon' || file.mimetype === 'image/vnd.microsoft.icon' || path.extname(file.originalname).toLowerCase() === '.ico';
  const mimetype = allowedExts.test(file.mimetype) || isSvg || isIco;

  if (extname && mimetype) {
    return cb(null, true);
  } else {
    cb(new Error('Only image files (PNG, JPG, JPEG, WEBP, SVG, ICO) are allowed for branding.'));
  }
};

const brandingUpload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter
});

module.exports = brandingUpload;

