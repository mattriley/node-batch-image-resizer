#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const realCliPath = fs.realpathSync(__filename);
const ROOT = path.resolve(path.dirname(realCliPath), '..');
const pkg = require(path.join(ROOT, 'package.json'));
const { resizeImages, DEFAULT_ALLOW_EXT } = require(path.join(ROOT, 'index.cjs'));

// simple flag parsing (supports --key value and --key=value)
const parseArgs = (argv) => {
    const args = argv.slice(2);
    const positionals = [];
    const flags = new Map();
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (!a.startsWith('-')) { positionals.push(a); continue; }
        if (a.startsWith('--')) {
            const eq = a.indexOf('=');
            if (eq !== -1) flags.set(a.slice(2, eq), a.slice(eq + 1));
            else {
                const key = a.slice(2);
                const next = args[i + 1];
                if (next && !next.startsWith('-')) { flags.set(key, next); i++; }
                else flags.set(key, true);
            }
        } else {
            positionals.push(a);
        }
    }
    return { positionals, flags };
};
const getInt = (m, k, d, min = 1) => m.has(k) ? Math.max(min, parseInt(m.get(k), 10)) : d;
const getBool = (m, k) => m.has(k) && String(m.get(k)) !== 'false';
const getStr = (m, k, d = null) => m.has(k) ? String(m.get(k)) : d;
const getList = (m, k) => m.has(k) ? String(m.get(k)).split(',').map(s => s.trim()).filter(Boolean) : null;

(async () => {
    const { positionals, flags } = parseArgs(process.argv);

    // --version
    if (getBool(flags, 'version') || getBool(flags, 'v')) {
        console.log(`batch-image-resizer v${pkg.version}`);
        process.exit(0);
    }

    // Help
    if (getBool(flags, 'help') || getBool(flags, 'h')) {
        console.log(`batch-image-resizer (v${pkg.version})
Usage: batch-image-resizer [INPUT_DIR] [OUTPUT_DIR] [flags...]

Positionals:
  INPUT_DIR                 Source directory (default: ./images)
  OUTPUT_DIR                Destination directory (default: ./output; ignored with --overwrite)

Defaults (macOS):
  format=jpeg, prune-dsstore=true, prune-empty-dirs=true, verbose-errors=true
  heic-fallback=auto, jpeg-fallback=auto

Core:
  --overwrite               Overwrite in place (⚠ destructive)
  --quality <1..100>        JPEG/WEBP/AVIF/HEIF/TIFF quality (default: 85)
  --max-width <px>          Resize bound width (default: 1920)
  --max-height <px>         Resize bound height (default: 1080)
  --format <fmt>            Output format: same|jpeg|jpg|png|webp|avif|heif|heic|tiff (default: jpeg)
  --fallback-format <fmt>   If primary encode fails/unsupported, try this format (e.g., jpeg)

Compatibility:
  --include-ext a,b,c       Override allow-list (dot optional)
  --exclude-ext a,b,c       Remove from allow-list

Performance (fixed vs adaptive):
  --concurrency <n>         Fixed images in flight (omit to use default)
  --auto                    Enable adaptive concurrency (AIMD)
  --min-concurrency <n>     Lower bound (default: 1)
  --max-concurrency <n>     Upper bound (default: ≈ cores)
  --target-latency <ms>     Target avg latency per image (default: 450)
  --window <ms>             Feedback window (default: 1500)
  --lag-threshold <ms>      Event-loop lag threshold (default: 60)

Sharp thread pool:
  --auto-threads            Auto-size sharp.concurrency() based on current in-flight
  --target-threads <n>      Thread budget (default: ≈ cores)
  --sharp-threads <n>       Manually pin pool size (0 = sharp default)
  --min-sharp-threads <n>   Lower bound when auto-sizing (default: 1)
  --max-sharp-threads <n>   Upper bound when auto-sizing (default: ≈ cores)

Flatten:
  --flatten                 Write outputs into a single flat directory (no subfolders) [default: true]
                            Pass '--flatten false' to keep original subfolders
  --flatten-strategy <s>    'hash' (default) or 'path'
  --flatten-sep <s>         Separator for 'path' strategy (default: _)
  --max-filename-bytes <n>  Max UTF-8 bytes for a single filename (default: 200)

macOS helpers:
  --skip-dsstore            Skip '.DS_Store' files (default: true)
  --prune-dsstore           After processing, remove '.DS_Store' files (input & output) [default: true]
  --prune-empty-dirs        Remove empty directories from the OUTPUT tree after run [default: true]
  --heic-fallback <none|sips|auto>  Try 'sips' if HEIC→JPEG via sharp fails (default auto on macOS; none elsewhere)
  --jpeg-fallback <none|sips|auto>  Try 'sips' if JPEG→JPEG via sharp fails (default auto on macOS; none elsewhere)
  --verbose-errors          Include underlying error messages in logs [default: true]

Examples:
  batch-image-resizer ./photos ./out --auto --auto-threads
  batch-image-resizer ./photos ./out --format heic --fallback-format jpeg
  batch-image-resizer ./photos ./out --format jpeg --quality 80
`);
        process.exit(0);
    }

    // Positionals: INPUT_DIR [OUTPUT_DIR]
    const overwrite = getBool(flags, 'overwrite');
    const inputDir = path.resolve(positionals[0] || './images');
    const outputDir = overwrite ? undefined : path.resolve(positionals[1] || './output');

    // flatten handling: undefined means "use default (true)"
    const flattenFlag = flags.has('flatten') ? getBool(flags, 'flatten') : undefined;
    const effectiveFlatten = (flattenFlag === undefined) ? true : !!flattenFlag;

    if (overwrite && effectiveFlatten) {
        console.error('Error: --flatten cannot be used with --overwrite. Choose one.');
        process.exit(1);
    }

    const options = {
        inputDir,
        outputDir,
        overwrite,

        // format & quality
        format: getStr(flags, 'format', 'jpeg'),
        fallbackFormat: getStr(flags, 'fallback-format', null),
        quality: getInt(flags, 'quality', 85, 1),
        maxWidth: getInt(flags, 'max-width', 1920, 1),
        maxHeight: getInt(flags, 'max-height', 1080, 1),

        // concurrency
        auto: getBool(flags, 'auto'),
        concurrency: flags.has('concurrency') ? getInt(flags, 'concurrency', 2, 1) : null,
        minConcurrency: getInt(flags, 'min-concurrency', 1, 1),
        maxConcurrency: getInt(flags, 'max-concurrency', Math.max(2, os.cpus()?.length || 4), 1),
        targetLatencyMs: getInt(flags, 'target-latency', 450, 10),
        windowMs: getInt(flags, 'window', 1500, 200),
        lagThresholdMs: getInt(flags, 'lag-threshold', 60, 5),

        // threads
        autoThreads: getBool(flags, 'auto-threads'),
        targetThreads: getInt(flags, 'target-threads', os.cpus()?.length || 4, 1),
        sharpThreads: flags.has('sharp-threads') ? parseInt(flags.get('sharp-threads'), 10) : null,
        minSharpThreads: getInt(flags, 'min-sharp-threads', 1, 1),
        maxSharpThreads: getInt(flags, 'max-sharp-threads', Math.max(2, os.cpus()?.length || 4), 1),

        includeExt: getList(flags, 'include-ext'),
        excludeExt: getList(flags, 'exclude-ext'),

        // flatten (omit property when user didn't pass it, so library default applies)
        ...(flattenFlag !== undefined ? { flatten: flattenFlag } : {}),
        flattenStrategy: getStr(flags, 'flatten-strategy', 'hash'),
        flattenSep: getStr(flags, 'flatten-sep', '_'),
        maxFilenameBytes: getInt(flags, 'max-filename-bytes', 200, 50),

        // DS_Store & cleanup (library defaults are true; only override if flags present)
        ...(flags.has('skip-dsstore') ? { skipDSStore: getBool(flags, 'skip-dsstore') } : {}),
        ...(flags.has('prune-dsstore') ? { pruneDSStore: getBool(flags, 'prune-dsstore') } : {}),
        ...(flags.has('prune-empty-dirs') ? { pruneEmptyDirs: getBool(flags, 'prune-empty-dirs') } : {}),

        // macOS fallbacks
        heicFallback: (flags.has('heic-fallback') ? String(flags.get('heic-fallback')) : ((process.platform === 'darwin') ? 'auto' : 'none')),
        jpegFallback: (flags.has('jpeg-fallback') ? String(flags.get('jpeg-fallback')) : ((process.platform === 'darwin') ? 'auto' : 'none')),
        ...(flags.has('verbose-errors') ? { verboseErrors: getBool(flags, 'verbose-errors') } : {}),

        logger: console,
        onWindow: ({ inFlightCap, avgLatency, lagMs }) => {
            if (getBool(flags, 'auto')) {
                console.log(`↻ window: inflight cap=${inFlightCap}, avg=${avgLatency.toFixed(0)}ms, lag=${lagMs}ms`);
            }
        }
    };

    console.log(`batch-image-resizer v${pkg.version}`);
    console.log(`→ Input: ${options.inputDir}`);
    console.log(`→ Mode: ${options.overwrite ? 'OVERWRITE IN PLACE' : `Output → ${options.outputDir}`}`);
    console.log(`→ Bounds: ${options.maxWidth}×${options.maxHeight}, format=${options.format}${options.fallbackFormat ? ` (fallback=${options.fallbackFormat})` : ''}, quality=${options.quality}`);
    console.log(`→ Flatten: ${effectiveFlatten ? 'ENABLED (flat output)' : 'DISABLED (preserve dirs)'}`);
    console.log(`→ DS_Store: ${flags.has('skip-dsstore') ? (getBool(flags, 'skip-dsstore') ? 'SKIP' : 'INCLUDE') : 'SKIP (default)'}${(flags.has('prune-dsstore') ? getBool(flags, 'prune-dsstore') : true) ? ', PRUNE after run (default)' : ''}`);
    console.log(`→ Empty dirs: ${(flags.has('prune-empty-dirs') ? getBool(flags, 'prune-empty-dirs') : true) ? 'PRUNE' : 'KEEP'}`);
    console.log(`→ Verbose errors: ${(flags.has('verbose-errors') ? getBool(flags, 'verbose-errors') : true) ? 'ON' : 'OFF'}`);
    if (!options.includeExt && !options.excludeExt) {
        console.log(`→ Convertible extensions: ${DEFAULT_ALLOW_EXT.join(' ')}`);
    }

    try {
        const summary = await resizeImages(options);
        const code = summary.errors > 0 ? 1 : 0;
        console.log(`\nDone. converted=${summary.converted} copied=${summary.copied} kept=${summary.kept} errors=${summary.errors}`);
        process.exit(code);
    } catch (err) {
        console.error('Fatal:', err.message || err);
        process.exit(1);
    }
})();
