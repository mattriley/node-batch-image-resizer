'use strict';

/**
 * batch-image-resizer
 * v1.4.5
 * - Atomic writes to avoid 0-byte outputs
 * - Robust HEIC handling (tolerant decode, colorspace normalize, flatten alpha for JPEG)
 * - Flatten default on; DS_Store skip/prune; prune-empty-dirs
 */

const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const sharp = require('sharp');

// ---------------- Defaults ----------------
const DEFAULT_ALLOW_EXT = [
  '.jpg', '.jpeg', '.png', '.webp', '.avif',
  '.heic', '.heif', '.tif', '.tiff', '.bmp', '.gif'
];

const DEFAULTS = {
  inputDir: './images',
  outputDir: './output',
  overwrite: false,

  // format & quality
  format: 'same',
  fallbackFormat: null,
  quality: 85,
  maxWidth: 1920,
  maxHeight: 1080,

  // performance (outer concurrency)
  auto: false,
  concurrency: null,
  minConcurrency: 1,
  maxConcurrency: Math.max(2, os.cpus()?.length || 4),
  targetLatencyMs: 450,
  windowMs: 1500,
  lagThresholdMs: 60,

  // sharp threads
  autoThreads: false,
  targetThreads: Math.max(1, os.cpus()?.length || 4),
  sharpThreads: null,
  minSharpThreads: 1,
  maxSharpThreads: Math.max(2, os.cpus()?.length || 4),

  // flatten
  flatten: true,
  flattenStrategy: 'hash', // 'hash' | 'path'
  flattenSep: '_',
  maxFilenameBytes: 200,

  // macOS metadata
  skipDSStore: true,
  pruneDSStore: false,

  // cleanup
  pruneEmptyDirs: false,

  // compat
  includeExt: null,
  excludeExt: null,

  // hooks
  logger: null,
  onWindow: null,
  onFile: null,

  // platform fallbacks
  heicFallback: (process.platform === 'darwin') ? 'auto' : 'none', // 'none' | 'sips' | 'auto'
  jpegFallback: (process.platform === 'darwin') ? 'auto' : 'none', // 'none' | 'sips' | 'auto'
  verboseErrors: false
};

// ---------------- Utils ----------------
const exists = async (p) => { try { await fsp.access(p); return true; } catch { return false; } };
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const lowerDot = (s) => (s.startsWith('.') ? s : '.' + s).toLowerCase();

const isTransientResourceError = (err) => {
  const code = err?.code;
  const msg = String(err?.message || '').toLowerCase();
  return code === 'EMFILE' || code === 'ENFILE' || code === 'ENOSPC' || code === 'ENOMEM' ||
         msg.includes('emfile') || msg.includes('too many open files') ||
         msg.includes('no space left') || msg.includes('out of memory');
};

const copyAsIs = async (from, to) => {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.copyFile(from, to);
};

const utf8Truncate = (str, maxBytes) => {
  const buf = Buffer.from(str, 'utf8');
  if (buf.length <= maxBytes) return str;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xC0) === 0x80) end--;
  return buf.slice(0, end).toString('utf8');
};

const sanitizeSeg = (s) => s.replace(/[\\/:*?"<>|]+/g, '_');
const makeFlatName = ({ relDir, base, outExt, strategy, sep, maxBytes }) => {
  let nameBase;
  if (strategy === 'path') {
    const pathPart = relDir ? relDir.split(path.sep).filter(Boolean).map(sanitizeSeg).join(sep) : '';
    nameBase = pathPart ? `${pathPart}${sep}${base}` : base;
  } else {
    const h = crypto.createHash('sha1').update(String(relDir || '') + '/' + base).digest('hex').slice(0,8);
    nameBase = `${base}~${h}`;
  }
  nameBase = sanitizeSeg(nameBase);
  nameBase = utf8Truncate(nameBase, Math.max(20, maxBytes));
  return `${nameBase}${outExt}`;
};

async function uniquify(destDir, filename) {
  let candidate = path.join(destDir, filename);
  if (!(await exists(candidate))) return candidate;
  const dot = filename.lastIndexOf('.');
  const stem = dot === -1 ? filename : filename.slice(0, dot);
  const ext = dot === -1 ? '' : filename.slice(dot);
  let i = 1;
  while (true) {
    const next = path.join(destDir, `${stem}~${i}${ext}`);
    if (!(await exists(next))) return next;
    i++;
  }
}

// Walk directory recursively (skip only .DS_Store if configured)
async function* walk(dir, baseOutDir, overwriting, skipDSStore, flatten) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (skipDSStore && entry.isFile() && entry.name === '.DS_Store') continue;
    const inputPath = path.join(dir, entry.name);
    const outputPath = overwriting ? inputPath : path.join(baseOutDir, entry.name);
    if (entry.isDirectory()) {
      if (!overwriting && !flatten) await fsp.mkdir(outputPath, { recursive: true });
      yield* walk(inputPath, outputPath, overwriting, skipDSStore, flatten);
    } else {
      yield { inputPath, outputPath };
    }
  }
}

// Remove .DS_Store files from a tree
async function pruneDSStore(dir) {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await pruneDSStore(p);
      } else if (entry.name === '.DS_Store') {
        try { await fsp.rm(p, { force: true }); } catch {}
      }
    }
  } catch {}
}

// Remove empty directories from a tree
async function pruneEmptyDirs(dir) {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await pruneEmptyDirs(p);
        const still = await fsp.readdir(p);
        if (still.length === 0) {
          try { await fsp.rmdir(p); } catch {}
        }
      }
    }
  } catch {}
}

// External HEIC fallback on macOS via 'sips'
async function sipsConvert(src, outFile, quality, maxDim /* optional */) {
  // only on macOS where sips exists
  try {
    await fsp.access('/usr/bin/sips');
  } catch {
    throw new Error('sips not available');
  }
  const { spawn } = require('child_process');
  await fsp.mkdir(path.dirname(outFile), { recursive: true });
  const args = ['-s', 'format', 'jpeg'];
  if (typeof quality === 'number') {
    args.push('-s', 'formatOptions', String(quality));
  }
  if (maxDim && Number(maxDim) > 0) {
    args.push('-Z', String(Number(maxDim)));
  }
  args.push(src, '--out', outFile);
  if (typeof quality === 'number') {
    // sips uses 0..100 for JPEG formatOptions
    args.unshift('formatOptions', String(quality));
    args.unshift('-s');
  }
  await new Promise((resolve, reject) => {
    const p = spawn('/usr/bin/sips', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let errOut = ''; let out = '';
    p.stdout.on('data', d => { out += String(d); });
    p.stderr.on('data', d => { errOut += String(d); });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(errOut.trim() || `sips exit ${code}`));
    });
  });
}

async function pruneEmptyDirs(dir) {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await pruneEmptyDirs(p);
        const still = await fsp.readdir(p);
        if (still.length === 0) {
          try { await fsp.rmdir(p); } catch {}
        }
      }
    }
  } catch {}
}

// Adaptive limiter (AIMD)
const createAdaptiveLimiter = ({ initial, min, max, windowMs, targetLatencyMs, lagThresholdMs, onWindow }) => {
  let cap = Math.min(max, Math.max(min, initial));
  let inFlight = 0;
  const q = [];
  let sumLatency = 0, samples = 0, emfileCount = 0;
  let lastTick = process.hrtime.bigint();

  const timer = setInterval(() => {
    const now = process.hrtime.bigint();
    const elapsedMs = Number(now - lastTick) / 1e6;
    const lagMs = elapsedMs - windowMs;
    lastTick = now;

    const avg = samples ? (sumLatency / samples) : 0;
    const backpressure = (lagMs > lagThresholdMs) || (emfileCount > 0) || (avg > targetLatencyMs * 1.25);

    if (backpressure) cap = Math.max(min, Math.ceil(cap * 0.7));
    else if (samples > 0 && avg <= targetLatencyMs) cap = Math.min(max, cap + 1);

    onWindow && onWindow({ inFlightCap: cap, avgLatency: avg, lagMs: Math.max(0, lagMs | 0) });

    sumLatency = 0; samples = 0; emfileCount = 0;
    pump();
  }, windowMs);

  const pump = () => {
    while (inFlight < cap && q.length) {
      const { fn, start, resolve, reject } = q.shift();
      inFlight++;
      fn()
        .then((res) => { resolve(res); sumLatency += (Date.now() - start); samples++; })
        .catch((err) => {
          reject(err);
          sumLatency += (Date.now() - start); samples++;
          if (isTransientResourceError(err)) emfileCount++;
        })
        .finally(() => { inFlight--; pump(); });
    }
  };

  const schedule = (fn) => new Promise((resolve, reject) => { q.push({ fn, start: Date.now(), resolve, reject }); pump(); });
  const dispose = () => clearInterval(timer);
  return { schedule, dispose };
};

// --------- Format helpers ---------
const ENCODE_SAME_OK = new Set(['.jpg','.jpeg','.png','.webp','.avif','.heif','.heic','.tif','.tiff']);
function normalizeFormat(fmt) {
  if (!fmt || fmt === 'same') return { mode: 'same' };
  const f = String(fmt).toLowerCase();
  if (f === 'jpg' || f === 'jpeg') return { mode: 'fixed', key: 'jpeg', outExt: '.jpg' };
  if (f === 'png')  return { mode: 'fixed', key: 'png',  outExt: '.png' };
  if (f === 'webp') return { mode: 'fixed', key: 'webp', outExt: '.webp' };
  if (f === 'avif') return { mode: 'fixed', key: 'avif', outExt: '.avif' };
  if (f === 'heif') return { mode: 'fixed', key: 'heif', outExt: '.heif', heifCompression: undefined };
  if (f === 'heic') return { mode: 'fixed', key: 'heif', outExt: '.heic', heifCompression: 'hevc' };
  if (f === 'tif' || f === 'tiff') return { mode: 'fixed', key: 'tiff', outExt: '.tiff' };
  throw new Error(`Unsupported format "${fmt}". Use one of: same,jpeg,jpg,png,webp,avif,heif,heic,tiff`);
}
function encoderForExt(extLower) {
  if (extLower === '.jpg' || extLower === '.jpeg') return { key: 'jpeg' };
  if (extLower === '.png')  return { key: 'png'  };
  if (extLower === '.webp') return { key: 'webp' };
  if (extLower === '.avif') return { key: 'avif' };
  if (extLower === '.heif') return { key: 'heif', heifCompression: undefined };
  if (extLower === '.heic') return { key: 'heif', heifCompression: 'hevc' };
  if (extLower === '.tif' || extLower === '.tiff') return { key: 'tiff' };
  return null;
}
function applyEncoder(pipeline, key, quality, opts = {}) {
  switch (key) {
    case 'jpeg': return pipeline.jpeg({ quality });
    case 'png':  return pipeline.png();
    case 'webp': return pipeline.webp({ quality });
    case 'avif': return pipeline.avif({ quality });
    case 'heif': return pipeline.heif({ quality, compression: opts.heifCompression });
    case 'tiff': return pipeline.tiff({ quality });
    default: throw new Error(`No encoder for key: ${key}`);
  }
}

// ---------------- File processor ----------------
const processFileFactory = (cfg, allowSet, stats, log, onFile, inputRoot, outputRoot) => {
  const fmt = normalizeFormat(cfg.format);
  const fb = cfg.fallbackFormat ? normalizeFormat(cfg.fallbackFormat) : null;

  const computeOut = async (inputPath, outputPath, base, outExt) => {
    if (cfg.flatten && !cfg.overwrite) {
      const relDir = path.relative(inputRoot, path.dirname(inputPath));
      const flatName = makeFlatName({
        relDir, base, outExt,
        strategy: cfg.flattenStrategy, sep: cfg.flattenSep, maxBytes: cfg.maxFilenameBytes
      });
      const outFile = await uniquify(outputRoot, flatName);
      return { outDir: outputRoot, outFile };
    } else {
      const outDir = cfg.overwrite ? path.dirname(inputPath) : path.dirname(outputPath);
      const outFile = path.join(outDir, `${base}${outExt}`);
      return { outDir, outFile };
    }
  };

  const attemptEncodeTo = async (src, outFile, encoderKey, quality, heifCompression) => {
    // Tolerant decode options help with some HEIC variants
    let pipeline = sharp(src, { sequentialRead: true, limitInputPixels: false, failOn: 'none', pages: 1 })
      .rotate()
      .resize({
        width: cfg.maxWidth,
        height: cfg.maxHeight,
        fit: 'inside',
        withoutEnlargement: true,
        fastShrinkOnLoad: true
      })
      .toColorspace('srgb');
    if (encoderKey === 'jpeg') {
      // Ensure no alpha channel for JPEG targets
      pipeline = pipeline.flatten({ background: { r: 255, g: 255, b: 255 } });
    }
    pipeline = applyEncoder(pipeline, encoderKey, quality, { heifCompression });
    await pipeline.toFile(outFile);
  };

  return async (inputPath, outputPath) => {
    const ext = path.extname(inputPath);
    const extLower = ext.toLowerCase();
    const base = path.basename(inputPath, ext);

    // Fast decode compatibility: if not allowed, copy/keep
    if (!allowSet.has(extLower)) {
      if (!cfg.overwrite) {
        const { outFile } = await computeOut(inputPath, outputPath, path.basename(inputPath, ext), extLower);
        await copyAsIs(inputPath, outFile);
        stats.copied++; onFile && onFile({ src: inputPath, dest: outFile, action: 'copied' });
        log.info && log.info(`↪ ${inputPath} → ${outFile} (incompatible ${extLower || 'unknown'}, copied)`);
      } else {
        stats.kept++; onFile && onFile({ src: inputPath, dest: inputPath, action: 'kept' });
        log.info && log.info(`↪ ${inputPath} (incompatible ${extLower || 'unknown'}, kept)`);
      }
      return;
    }

    // Choose primary target
    let target;
    if (fmt.mode === 'same') {
      if (!ENCODE_SAME_OK.has(extLower)) {
        if (fb) {
          target = fb;
        } else {
          if (!cfg.overwrite) {
            const { outFile } = await computeOut(inputPath, outputPath, base, extLower);
            await copyAsIs(inputPath, outFile);
            stats.copied++; onFile && onFile({ src: inputPath, dest: outFile, action: 'copied' });
            log.info && log.info(`↪ ${inputPath} → ${outFile} (no same-format encoder ${extLower}, copied)`);
          } else {
            stats.kept++; onFile && onFile({ src: inputPath, dest: inputPath, action: 'kept' });
            log.info && log.info(`↪ ${inputPath} (no same-format encoder ${extLower}, kept)`);
          }
          return;
        }
      } else {
        const ek = encoderForExt(extLower);
        target = { key: ek.key, outExt: extLower, heifCompression: ek.heifCompression };
      }
    } else {
      target = fmt;
    }

    // Encode (with fallback)
    const doEncode = async (tgt) => {
      const { outFile } = await computeOut(inputPath, outputPath, base, tgt.outExt ?? extLower);
      const tmpFile = outFile + `.tmp-${process.pid}-${Math.random().toString(36).slice(2,8)}`;
      try {
        await attemptEncodeTo(inputPath, tmpFile, tgt.key || encoderForExt(extLower)?.key, cfg.quality, tgt.heifCompression);
        await fsp.mkdir(path.dirname(outFile), { recursive: true });
        await fsp.rename(tmpFile, outFile);
      } catch (e) {
        try { await fsp.rm(tmpFile, { force: true }); } catch {}
        throw e;
      }
      if (cfg.overwrite && outFile !== inputPath && path.extname(outFile).toLowerCase() !== extLower) {
        try { await fsp.unlink(inputPath); } catch {}
      }
      stats.converted++; onFile && onFile({ src: inputPath, dest: outFile, action: 'converted' });
      const encName = tgt.key || encoderForExt(extLower)?.key;
      const qStr = (encName === 'png') ? '' : ` q=${cfg.quality}`;
      log.info && log.info(`✔ ${inputPath} → ${outFile} (${encName}${qStr}${tgt === fb ? ', fallback' : ''})`);
    };

    try {
      await doEncode(target);
    } catch (err) {
      if (isTransientResourceError(err)) {
        stats.errors++; onFile && onFile({ src: inputPath, dest: inputPath, action: 'error', error: String(err.message || err) });
        log.warn && log.warn(`⚠ ${inputPath}: transient error (${err.code || err.message})`);
        throw err;
      }

      // Optional HEIC/HEIF external fallback (macOS 'sips')
      const trySipsHeic = (cfg.heicFallback === 'sips') || (cfg.heicFallback === 'auto' && process.platform === 'darwin');
      const trySipsJpeg = (cfg.jpegFallback === 'sips') || (cfg.jpegFallback === 'auto' && process.platform === 'darwin');
      const isHeicLike = (extLower === '.heic' || extLower === '.heif');
      const isJpegLike = (extLower === '.jpg' || extLower === '.jpeg');
      const wantJpeg = (fmt.mode === 'fixed' && fmt.key === 'jpeg') || (fmt.mode === 'same' && !ENCODE_SAME_OK.has(extLower) && (!fb || fb.key === 'jpeg')) || (fb && fb.key === 'jpeg');

      if (trySipsHeic && isHeicLike && wantJpeg) {
        try {
          const { outFile } = await computeOut(inputPath, outputPath, base, '.jpg');
          const tmpFile = outFile + `.sips-tmp-${process.pid}-${Math.random().toString(36).slice(2,8)}`;
          await sipsConvert(inputPath, tmpFile, cfg.quality, Math.max(cfg.maxWidth, cfg.maxHeight));
          await fsp.rename(tmpFile, outFile);
          stats.converted++; onFile && onFile({ src: inputPath, dest: outFile, action: 'converted', via: 'sips' });
          log.info && log.info(`✔ ${inputPath} → ${outFile} (jpeg via sips)`);
          return;
        } catch (sipsErr) {
          log.warn && log.warn(`↪ ${inputPath}: sharp failed${cfg.verboseErrors ? ` (${err.message})` : ''}; sips failed${cfg.verboseErrors ? ` (${sipsErr.message})` : ''}`);
        }
      }

      if (trySipsJpeg && isJpegLike && wantJpeg) {
        try {
          const { outFile } = await computeOut(inputPath, outputPath, base, '.jpg');
          const tmpFile = outFile + `.sips-tmp-${process.pid}-${Math.random().toString(36).slice(2,8)}`;
          await sipsConvert(inputPath, tmpFile, cfg.quality, Math.max(cfg.maxWidth, cfg.maxHeight));
          await fsp.rename(tmpFile, outFile);
          stats.converted++; onFile && onFile({ src: inputPath, dest: outFile, action: 'converted', via: 'sips' });
          log.info && log.info(`✔ ${inputPath} → ${outFile} (jpeg via sips)`);
          return;
        } catch (sipsErr) {
          log.warn && log.warn(`↪ ${inputPath}: sharp failed${cfg.verboseErrors ? ` (${err.message})` : ''}; sips (jpeg) failed${cfg.verboseErrors ? ` (${sipsErr.message})` : ''}`);
        }
      }

      if (fb && (fmt.mode !== 'fixed' || (fb.key !== fmt.key || fb.outExt !== fmt.outExt))) {
        try { await doEncode(fb); return; }
        catch (fbErr) { log.warn && log.warn(`↪ ${inputPath}: primary failed${cfg.verboseErrors ? ` (${err.message})` : ''}; fallback ${fb.key} failed${cfg.verboseErrors ? ` (${fbErr.message})` : ''}`); }
      }
      if (!cfg.overwrite) {
        const { outFile } = await computeOut(inputPath, outputPath, base, extLower);
        try { const st = await fsp.stat(outFile); if (st.size === 0) { try { await fsp.rm(outFile, { force: true }); } catch {} } } catch {}
        try {
          await copyAsIs(inputPath, outFile);
          stats.copied++; onFile && onFile({ src: inputPath, dest: outFile, action: 'copied' });
          log.info && log.info(`↪ ${inputPath} → ${outFile} (failed convert, copied${cfg.verboseErrors ? `; reason: ${err.message}` : ''})`);
        } catch (copyErr) {
          stats.errors++; onFile && onFile({ src: inputPath, dest: outFile, action: 'error', error: String(copyErr.message || copyErr) });
          log.error && log.error(`✖ ${inputPath}: failed to copy as-is to ${outFile}: ${copyErr.message}`);
          throw copyErr;
        }
      } else {
        stats.kept++; onFile && onFile({ src: inputPath, dest: inputPath, action: 'kept' });
        log.info && log.info(`↪ ${inputPath}: failed convert, kept as-is${cfg.verboseErrors ? `; reason: ${err.message}` : ''}`);
      }
    }
  };
};

// ---------------- Public API ----------------
const resizeImages = async (options = {}) => {
  const cfg = { ...DEFAULTS, ...options };
  if (options && options.flatten === undefined) cfg.flatten = DEFAULTS.flatten;

  const log = cfg.logger || { info: () => {}, warn: () => {}, error: () => {} };
  const allowSet = new Set(
    (cfg.includeExt ? cfg.includeExt.map(lowerDot) : DEFAULT_ALLOW_EXT)
      .filter(Boolean)
      .map((e) => e.toLowerCase())
  );
  if (cfg.excludeExt) {
    for (const e of cfg.excludeExt.map(lowerDot)) allowSet.delete(e);
  }

  // sharp pool sizing (initial)
  if (cfg.autoThreads) {
    // defer sizing to limiter setup
  } else {
    let t = cfg.sharpThreads != null ? cfg.sharpThreads : Math.max(1, Math.floor((os.cpus()?.length || 4) / 2));
    if (t === 0) sharp.concurrency(0); else sharp.concurrency(t);
  }

  // FS prep
  const inputAbs = path.resolve(cfg.inputDir);
  const outputAbs = cfg.overwrite ? null : path.resolve(cfg.outputDir);
  if (!(await exists(inputAbs))) throw new Error(`Input not found: ${inputAbs}`);
  if (cfg.flatten && cfg.overwrite) throw new Error('Cannot use flatten with overwrite. Choose one.');
  if (!cfg.overwrite) await fsp.mkdir(outputAbs, { recursive: true });

  const stats = { converted: 0, copied: 0, kept: 0, errors: 0, results: [] };
  const onFile = cfg.onFile ? (x) => { stats.results.push(x); cfg.onFile(x); } : (x) => { stats.results.push(x); };
  const processFile = processFileFactory(cfg, allowSet, stats, log, onFile, inputAbs, outputAbs || '');

  // Limiter
  let limiter, dispose = () => {};
  if (cfg.auto) {
    const initial = Math.min(2, cfg.maxConcurrency);
    if (cfg.autoThreads) {
      const desired = clamp(Math.floor(cfg.targetThreads / Math.max(1, initial)), cfg.minSharpThreads, cfg.maxSharpThreads);
      sharp.concurrency(desired === 0 ? 0 : desired);
    }
    limiter = createAdaptiveLimiter({
      initial,
      min: cfg.minConcurrency,
      max: cfg.maxConcurrency,
      windowMs: cfg.windowMs,
      targetLatencyMs: cfg.targetLatencyMs,
      lagThresholdMs: cfg.lagThresholdMs,
      onWindow: ({ inFlightCap, avgLatency, lagMs }) => {
        cfg.onWindow && cfg.onWindow({ inFlightCap, avgLatency, lagMs });
        if (cfg.autoThreads) {
          const desired = clamp(Math.floor(cfg.targetThreads / Math.max(1, inFlightCap)), cfg.minSharpThreads, cfg.maxSharpThreads);
          sharp.concurrency(desired === 0 ? 0 : desired);
        }
      }
    });
    dispose = limiter.dispose;
  } else {
    const fixed = cfg.concurrency ?? Math.max(2, Math.floor((os.cpus()?.length || 4) / 2));
    if (cfg.autoThreads) {
      const desired = clamp(Math.floor(cfg.targetThreads / Math.max(1, fixed)), cfg.minSharpThreads, cfg.maxSharpThreads);
      sharp.concurrency(desired === 0 ? 0 : desired);
    }
    let inFlight = 0; const q = [];
    const pump = () => {
      while (inFlight < fixed && q.length) {
        const { fn, resolve, reject } = q.shift();
        inFlight++;
        fn().then(resolve, reject).finally(() => { inFlight--; pump(); });
      }
    };
    limiter = { schedule: (fn) => new Promise((res, rej) => { q.push({ fn, resolve: res, reject: rej }); pump(); }) };
  }

  // Queue & drain
  const tasks = [];
  for await (const { inputPath, outputPath } of walk(inputAbs, outputAbs || '', cfg.overwrite, cfg.skipDSStore, cfg.flatten)) {
    tasks.push(limiter.schedule(() => processFile(inputPath, outputPath)));
  }

  const results = await Promise.allSettled(tasks);
  for (const r of results) {
    if (r.status === 'rejected') stats.errors++;
  }
  dispose();

  // Optional cleanup
  if (cfg.pruneDSStore) {
    try { await pruneDSStore(inputAbs); } catch {}
    if (outputAbs) { try { await pruneDSStore(outputAbs); } catch {} }
  }
  if (cfg.pruneEmptyDirs && outputAbs) {
    try { await pruneEmptyDirs(outputAbs); } catch {}
  }

  return stats;
};

module.exports = {
  resizeImages,
  DEFAULT_ALLOW_EXT
};
