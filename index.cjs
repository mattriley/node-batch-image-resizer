'use strict';

/**
 * @mattriley/batch-image-resizer (library)
 * Recursive resize & convert with adaptive concurrency and safe fallbacks.
 */

const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const os = require('os');
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
  format: 'same', // 'same' | 'jpeg' | 'jpg' | 'png' | 'webp' | 'avif' | 'heif' | 'heic' | 'tiff'
  quality: 85,
  maxWidth: 1920,
  maxHeight: 1080,

  // performance (outer concurrency)
  auto: false,
  concurrency: null, // number | null
  minConcurrency: 1,
  maxConcurrency: Math.max(2, os.cpus()?.length || 4),
  targetLatencyMs: 450,
  windowMs: 1500,
  lagThresholdMs: 60,

  // sharp threads
  autoThreads: false,
  targetThreads: Math.max(1, os.cpus()?.length || 4),
  sharpThreads: null, // number | null (0 => sharp default)
  minSharpThreads: 1,
  maxSharpThreads: Math.max(2, os.cpus()?.length || 4),

  // compat
  includeExt: null,
  excludeExt: null,

  // hooks
  logger: null,
  onWindow: null,
  onFile: null
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

// Walk directory recursively
async function* walk(dir, baseOutDir, overwriting) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const inputPath = path.join(dir, entry.name);
    const outputPath = overwriting ? inputPath : path.join(baseOutDir, entry.name);
    if (entry.isDirectory()) {
      if (!overwriting) await fsp.mkdir(outputPath, { recursive: true });
      yield* walk(inputPath, outputPath, overwriting);
    } else {
      yield { inputPath, outputPath };
    }
  }
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

    if (backpressure) cap = Math.max(min, Math.ceil(cap * 0.7)); // MD
    else if (samples > 0 && avg <= targetLatencyMs) cap = Math.min(max, cap + 1); // AI

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
const DECODE_ALLOW_EXT = new Set(DEFAULT_ALLOW_EXT.map(e => e.toLowerCase()));

function normalizeFormat(fmt) {
  if (!fmt || fmt === 'same') return { mode: 'same' };
  const f = String(fmt).toLowerCase();
  if (f === 'jpg' || f === 'jpeg') return { mode: 'fixed', key: 'jpeg', outExt: '.jpg' };
  if (f === 'png')  return { mode: 'fixed', key: 'png',  outExt: '.png' };
  if (f === 'webp') return { mode: 'fixed', key: 'webp', outExt: '.webp' };
  if (f === 'avif') return { mode: 'fixed', key: 'avif', outExt: '.avif' };
  if (f === 'heif' || f === 'heic') return { mode: 'fixed', key: 'heif', outExt: (f === 'heic' ? '.heic' : '.heif') };
  if (f === 'tif' || f === 'tiff') return { mode: 'fixed', key: 'tiff', outExt: '.tiff' };
  throw new Error(`Unsupported format "${fmt}". Use one of: same,jpeg,jpg,png,webp,avif,heif,heic,tiff`);
}

function encoderKeyForExt(extLower) {
  if (extLower === '.jpg' || extLower === '.jpeg') return 'jpeg';
  if (extLower === '.png')  return 'png';
  if (extLower === '.webp') return 'webp';
  if (extLower === '.avif') return 'avif';
  if (extLower === '.heif' || extLower === '.heic') return 'heif';
  if (extLower === '.tif' || extLower === '.tiff') return 'tiff';
  return null;
}

function applyEncoder(pipeline, key, quality) {
  switch (key) {
    case 'jpeg': return pipeline.jpeg({ quality });
    case 'png':  return pipeline.png(); // lossless; ignore quality
    case 'webp': return pipeline.webp({ quality });
    case 'avif': return pipeline.avif({ quality });
    case 'heif': return pipeline.heif({ quality });
    case 'tiff': return pipeline.tiff({ quality });
    default: throw new Error(`No encoder for key: ${key}`);
  }
}

// ---------------- File processor ----------------
const processFileFactory = (cfg, allowSet, stats, log, onFile) => {
  const fmt = normalizeFormat(cfg.format);

  return async (inputPath, outputPath) => {
    const ext = path.extname(inputPath);
    const extLower = ext.toLowerCase();

    // Fast decode compatibility: if not in allow-set, copy/keep.
    if (!allowSet.has(extLower)) {
      if (!cfg.overwrite) {
        await copyAsIs(inputPath, outputPath);
        stats.copied++; onFile && onFile({ src: inputPath, dest: outputPath, action: 'copied' });
        log.info && log.info(`↪ ${inputPath} → ${outputPath} (incompatible ${extLower}, copied)`);
      } else {
        stats.kept++; onFile && onFile({ src: inputPath, dest: inputPath, action: 'kept' });
        log.info && log.info(`↪ ${inputPath} (incompatible ${extLower}, kept)`);
      }
      return;
    }

    // Decide target format
    let encoderKey, outExt;
    if (fmt.mode === 'same') {
      if (!ENCODE_SAME_OK.has(extLower)) {
        // Can't re-encode this format; copy/keep
        if (!cfg.overwrite) {
          await copyAsIs(inputPath, outputPath);
          stats.copied++; onFile && onFile({ src: inputPath, dest: outputPath, action: 'copied' });
          log.info && log.info(`↪ ${inputPath} → ${outputPath} (no same-format encoder ${extLower}, copied)`);
        } else {
          stats.kept++; onFile && onFile({ src: inputPath, dest: inputPath, action: 'kept' });
          log.info && log.info(`↪ ${inputPath} (no same-format encoder ${extLower}, kept)`);
        }
        return;
      }
      encoderKey = encoderKeyForExt(extLower);
      outExt = extLower;
    } else {
      encoderKey = fmt.key;
      outExt = fmt.outExt;
    }

    const base = path.basename(inputPath, ext);
    const outDir = cfg.overwrite ? path.dirname(inputPath) : path.dirname(outputPath);
    const outFile = path.join(outDir, `${base}${outExt}`);

    try {
      let pipeline = sharp(inputPath, { sequentialRead: true })
        .resize({
          width: cfg.maxWidth,
          height: cfg.maxHeight,
          fit: 'inside',
          withoutEnlargement: true,
          fastShrinkOnLoad: true
        });
      pipeline = applyEncoder(pipeline, encoderKey, cfg.quality);
      await pipeline.toFile(outFile);

      if (cfg.overwrite && outFile !== inputPath && outExt !== extLower) {
        try { await fsp.unlink(inputPath); } catch {}
      }

      stats.converted++; onFile && onFile({ src: inputPath, dest: outFile, action: 'converted' });
      const qStr = (encoderKey === 'png') ? '' : ` q=${cfg.quality}`;
      log.info && log.info(`✔ ${inputPath} → ${outFile} (${encoderKey}${qStr})`);
    } catch (err) {
      if (isTransientResourceError(err)) {
        stats.errors++; onFile && onFile({ src: inputPath, dest: outFile, action: 'error', error: String(err.message || err) });
        log.warn && log.warn(`⚠ ${inputPath}: transient error (${err.code || err.message})`);
        throw err;
      }
      // Non-transient → copy/keep
      if (!cfg.overwrite) {
        try {
          await copyAsIs(inputPath, outputPath);
          stats.copied++; onFile && onFile({ src: inputPath, dest: outputPath, action: 'copied' });
          log.info && log.info(`↪ ${inputPath} → ${outputPath} (failed convert, copied)`);
        } catch (copyErr) {
          stats.errors++; onFile && onFile({ src: inputPath, dest: outputPath, action: 'error', error: String(copyErr.message || copyErr) });
          log.error && log.error(`✖ ${inputPath}: failed to copy as-is: ${copyErr.message}`);
          throw copyErr;
        }
      } else {
        stats.kept++; onFile && onFile({ src: inputPath, dest: inputPath, action: 'kept' });
        log.info && log.info(`↪ ${inputPath}: failed convert, kept as-is`);
      }
    }
  };
};

// ---------------- Public API ----------------
const resizeImages = async (options = {}) => {
  const cfg = { ...DEFAULTS, ...options };

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
  if (!cfg.overwrite) await fsp.mkdir(outputAbs, { recursive: true });

  const stats = { converted: 0, copied: 0, kept: 0, errors: 0, results: [] };
  const onFile = cfg.onFile ? (x) => { stats.results.push(x); cfg.onFile(x); } : (x) => { stats.results.push(x); };
  const processFile = processFileFactory(cfg, allowSet, stats, log, onFile);

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

  // Queue & drain (allSettled to continue through transient errors)
  const tasks = [];
  for await (const { inputPath, outputPath } of walk(inputAbs, outputAbs || '', cfg.overwrite)) {
    tasks.push(limiter.schedule(() => processFile(inputPath, outputPath)));
  }

  const results = await Promise.allSettled(tasks);
  for (const r of results) {
    if (r.status === 'rejected') stats.errors++;
  }
  dispose();

  return stats;
};

module.exports = {
  resizeImages,
  DEFAULT_ALLOW_EXT
};
