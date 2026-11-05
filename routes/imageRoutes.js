const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { getOptimizedImage } = require('../services/imageService');

/**
 * GET /api/images/optimize
 * Public high-speed image optimization & resizing endpoint
 * Query parameters:
 *  - url (required): local /uploads path or external image URL
 *  - w / width: target width in pixels (16 to 2400)
 *  - h / height: target height in pixels
 *  - q / quality: compression quality (40 to 95, default 80)
 *  - fmt / format: 'webp', 'avif', 'jpeg', 'png', or 'auto' (default 'auto')
 *  - fit: 'cover', 'contain', 'inside' (default: inside if only w, cover if w+h)
 */
router.get('/optimize', async (req, res) => {
  const { url, w, width, h, height, q, quality, fmt, format, fit } = req.query;

  if (!url || typeof url !== 'string' || url.trim() === '') {
    return res.status(400).json({
      success: false,
      message: 'Parameter "url" is required for image optimization.'
    });
  }

  const cleanUrl = url.trim();

  // If already an SVG or data URI, redirect or serve directly without rasterizing
  if (cleanUrl.toLowerCase().endsWith('.svg') || cleanUrl.startsWith('data:')) {
    if (cleanUrl.startsWith('http')) {
      return res.redirect(cleanUrl);
    }
    return res.redirect(cleanUrl.startsWith('/') ? cleanUrl : `/${cleanUrl}`);
  }

  try {
    const targetW = w || width || 600;
    const targetH = h || height || null;
    const targetQ = q || quality || 80;
    const targetFmt = fmt || format || 'auto';
    const clientAccept = req.headers.accept || '';

    const optimized = await getOptimizedImage({
      url: cleanUrl,
      width: targetW,
      height: targetH,
      quality: targetQ,
      format: targetFmt,
      fit: fit || null,
      clientAccept
    });

    // Check ETag for HTTP 304 Not Modified (instant client cache)
    const clientEtag = req.headers['if-none-match'];
    if (clientEtag && clientEtag === `"${optimized.etag}"`) {
      return res.status(304).end();
    }

    res.setHeader('Content-Type', optimized.contentType);
    res.setHeader('ETag', `"${optimized.etag}"`);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Vary', 'Accept');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');

    const stream = fs.createReadStream(optimized.filePath);
    stream.on('error', (streamErr) => {
      console.warn('[ImageOptimizer] Read stream error:', streamErr.message);
      if (!res.headersSent) {
        res.status(500).json({ success: false, message: 'Error streaming image.' });
      }
    });

    stream.pipe(res);
  } catch (err) {
    console.warn(`[ImageOptimizer] Optimization failed for ${cleanUrl}: ${err.message}. Falling back to original.`);
    // Safe graceful fallback: if local path or external URL, redirect directly
    if (cleanUrl.startsWith('http://') || cleanUrl.startsWith('https://')) {
      return res.redirect(cleanUrl);
    }
    return res.redirect(cleanUrl.startsWith('/') ? cleanUrl : `/${cleanUrl}`);
  }
});

module.exports = router;

