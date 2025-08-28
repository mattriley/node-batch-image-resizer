# @mattriley/batch-image-resizer

Recursively **resize images** and **convert formats** with **adaptive concurrency**, **smart Sharp/libvips thread pooling**, and **safe fallbacks**. Use it either as a **CLI** or as a **library** (CommonJS & ESM supported).

- Converts only compatible image types (configurable).
- Output **format** is selectable via `--format`. Default is `same` (preserve original format when possible).
- Unsupported/corrupt files are **copied as-is** (safe mode) or **kept as-is** (overwrite mode).
- Optional AIMD controller auto-tunes throughput.
- Optional auto-sizing of Sharp’s worker pool to match your CPU thread budget.

---

## Install

```bash
npm i -g @mattriley/batch-image-resizer      # CLI
# or project-local
npm i @mattriley/batch-image-resizer
```

The CLI is exposed as **`batch-image-resizer`**.

---

## Requirements

- **Node.js 16.17+** (18+ recommended)
- **sharp** is installed automatically as a dependency.
- For very large batches, consider raising your file descriptor limit:
  ```bash
  ulimit -n 4096
  ```

---

## CLI Usage

```bash
batch-image-resizer [INPUT_DIR] [OUTPUT_DIR] [flags...]
```

- **Minimum args:** none. Defaults to `INPUT_DIR=./images`, `OUTPUT_DIR=./output`.
- By default, runs in **safe mode** (does not overwrite originals).

### Quick start

```bash
# Default: ./images → ./output, 1920x1080, quality 85, format same
batch-image-resizer

# Specify input + output
batch-image-resizer ./photos ./resized

# Overwrite in place (⚠ destructive for originals that get converted)
batch-image-resizer ./photos --overwrite

# Auto-tune concurrency and Sharp threads
batch-image-resizer ./photos ./out --auto --auto-threads
```

### Options

| Flag | Type | Default | Description |
|---|---|---:|---|
| `--overwrite` | boolean | `false` | Overwrite originals. Converted files replace or create `basename.<ext>` in place. Non-convertible/failed files are left **as-is**. |
| `--quality` | 1–100 | `85` | Quality for lossy encoders (jpeg/webp/avif/heif/tiff). Ignored for PNG. |
| `--max-width` | int | `1920` | Resize bound (width, px). |
| `--max-height` | int | `1080` | Resize bound (height, px). |
| `--format` | string | `same` | Output format: `same`, `jpeg`/`jpg`, `png`, `webp`, `avif`, `heif`/`heic`, `tiff`. With `same`, if the original format isn’t encodable by Sharp, the file is copied/kept. |
| `--include-ext` | list | *(see below)* | Comma list of extensions to **attempt** converting (dot optional). Overrides default allow list. |
| `--exclude-ext` | list | `[]` | Comma list of extensions to **exclude** from conversion (will be copied/kept as-is). |
| `--auto` | boolean | `false` | Enable **adaptive** outer concurrency (AIMD). |
| `--min-concurrency` | int | `1` | Lower bound for adaptive concurrency. |
| `--max-concurrency` | int | `≈ CPU cores` | Upper bound for adaptive concurrency. |
| `--target-latency` | ms | `450` | Target average per-image latency (adaptive mode). |
| `--window` | ms | `1500` | Feedback window for adjustments. |
| `--lag-threshold` | ms | `60` | Event-loop lag that triggers backoff. |
| `--auto-threads` | boolean | `false` | Auto-size Sharp/libvips pool to keep `concurrency × threads ≈ --target-threads`. |
| `--target-threads` | int | `≈ CPU cores` | Total thread budget when `--auto-threads` is on. |
| `--sharp-threads` | int | *(unset)* | Manually pin Sharp pool size (`0` = Sharp default). Ignored if `--auto-threads`. |
| `--min-sharp-threads` | int | `1` | Floor for auto-sized Sharp threads. |
| `--max-sharp-threads` | int | `≈ CPU cores` | Ceiling for auto-sized Sharp threads. |

**Default convertible extensions** (allow-list):  
```.jpg .jpeg .png .webp .avif .heic .heif .tif .tiff .bmp .gif```

- Files with extensions **outside** the allow-list are **not processed**:
  - **Safe mode:** copied 1:1 to output.
  - **Overwrite mode:** kept as-is and logged.

### Examples

```bash
# Keep original format when possible (default)
batch-image-resizer ./photos ./out

# Force JPEG output
batch-image-resizer ./photos ./out --format jpeg --quality 80

# Produce WebP
batch-image-resizer ./photos ./out --format webp --quality 75

# Only convert png/jpg/jpeg/heic; copy everything else
batch-image-resizer ./photos ./out --include-ext png,jpg,jpeg,heic

# Convert defaults except GIF/BMP; copy those
batch-image-resizer ./photos ./out --exclude-ext gif,bmp

# Aggressive throughput on 16 cores (auto)
batch-image-resizer ./photos ./out --auto --auto-threads --target-threads 16

# Fixed 4 images in flight, auto-size Sharp threads
batch-image-resizer ./photos ./out --concurrency 4 --auto-threads

# Overwrite in place with tighter bounds
batch-image-resizer ./photos --overwrite --max-width 1600 --max-height 1600 --quality 80
```

### Exit codes

- `0` — success (no surfaced system errors)  
- `1` — completed with one or more **system** errors (e.g., EMFILE/ENOSPC); see logs

---

## Library Usage

### CommonJS

```js
const { resizeImages } = require('@mattriley/batch-image-resizer');

(async () => {
  const summary = await resizeImages({
    inputDir: './photos',
    outputDir: './out',
    auto: true,
    autoThreads: true,
    format: 'same' // or 'jpeg', 'png', 'webp', 'avif', 'heif', 'tiff'
  });
  console.log(summary);
})();
```

### ESM

```js
import { resizeImages } from '@mattriley/batch-image-resizer';

const summary = await resizeImages({
  inputDir: './photos',
  outputDir: './out',
  format: 'jpeg'
});
console.log(summary);
```

### API

#### `await resizeImages(options)`

Returns a summary object:

```ts
type Result = {
  converted: number;          // files converted
  copied: number;             // files copied as-is (safe mode)
  kept: number;               // files left as-is (overwrite mode)
  errors: number;             // number of surfaced system errors
  results: Array<{
    src: string;
    dest: string;
    action: 'converted' | 'copied' | 'kept' | 'error';
    error?: string;
  }>;
}
```

**Options** (all optional; shown with defaults):

```ts
type Options = {
  // IO
  inputDir?: string;           // './images'
  outputDir?: string;          // './output' (ignored when overwrite=true)
  overwrite?: boolean;         // false

  // Resize & encode
  format?: 'same'|'jpeg'|'jpg'|'png'|'webp'|'avif'|'heif'|'heic'|'tiff'; // 'same'
  quality?: number;            // 85 (1..100)
  maxWidth?: number;           // 1920
  maxHeight?: number;          // 1080

  // Concurrency (outer)
  auto?: boolean;              // false (enable adaptive AIMD controller)
  concurrency?: number | null; // null → pick a reasonable default when auto=false
  minConcurrency?: number;     // 1
  maxConcurrency?: number;     // ≈ CPU cores
  targetLatencyMs?: number;    // 450
  windowMs?: number;           // 1500
  lagThresholdMs?: number;     // 60

  // Sharp/libvips thread pool
  autoThreads?: boolean;       // false (auto-size sharp.concurrency())
  targetThreads?: number;      // ≈ CPU cores (overall thread budget)
  sharpThreads?: number | null;// null → leave default; 0 → sharp default
  minSharpThreads?: number;    // 1
  maxSharpThreads?: number;    // ≈ CPU cores

  // Compatibility
  includeExt?: string[] | null;// overrides default allow-list
  excludeExt?: string[] | null;// subtracts from allow-list

  // Hooks (optional)
  logger?: { info?: Function; warn?: Function; error?: Function } | Console;
  onWindow?: (e: { inFlightCap: number; avgLatency: number; lagMs: number }) => void;
  onFile?: (e: { src: string; dest: string; action: 'converted'|'copied'|'kept'|'error'; error?: string }) => void;
};
```

---

## How it works

1. **Walk** the input directory tree recursively.
2. **Compatibility pre-check**: by extension (configurable allow-list). Incompatible files are copied/kept without attempting conversion.
3. **Resize + encode** compatible images using Sharp/libvips:
   - Fits inside `maxWidth × maxHeight`
   - Keeps aspect ratio
   - No upscaling (`withoutEnlargement: true`)
   - Encoder chosen by `--format` (or preserved if `same`), with sensible defaults
4. **Concurrency control**:
   - **Fixed mode**: a small number of images in flight.
   - **Adaptive mode** (`--auto`): AIMD feedback loop increases/decreases in-flight jobs using avg latency & event-loop lag.
5. **Thread pool control** (optional): `--auto-threads` sizes Sharp’s worker pool so that `concurrency × threads ≈ targetThreads` (usually CPU cores).
6. **Fallbacks**:
   - Conversion failure (corrupt/unsupported/permissions): copy (safe mode) or keep (overwrite mode).
   - Transient system errors (EMFILE/ENOSPC/ENOMEM): surfaced; the run continues; non-zero exit code signals partial failure.

---

## Performance tips

- Keep **quality** around **70–85** for big speed wins (lossy formats).
- For multi-core boxes, use `--auto --auto-threads` (or fix `--concurrency` with `--auto-threads`).
- If you hit **EMFILE** (too many open files): lower concurrency or increase `ulimit -n`.
- HEIC/AVIF decode can be CPU-heavy; lower `--target-threads` if other processes need CPU.
- Use **include/exclude** to avoid attempting costly formats you don’t need.

---

## Troubleshooting

- **“too many open files / EMFILE”**: Lower `--max-concurrency` or increase `ulimit -n`.
- **“no space left / ENOSPC”**: Free disk or write to another volume; retry.
- **Some files unchanged**: They were incompatible by extension or failed conversion; in safe mode they were copied, in overwrite mode they were kept. Check logs.
- **High CPU usage**: Reduce `--target-threads` or disable `--auto-threads` and use `--sharp-threads 1..2`.

---

## Dual-module packaging (CJS + ESM)

The package ships both **CJS** and **ESM** entries and a CLI:

```jsonc
{
  "type": "module",
  "main": "./index.cjs",
  "module": "./index.mjs",
  "exports": {
    ".": { "import": "./index.mjs", "require": "./index.cjs" },
    "./cli": { "import": "./bin/cli.cjs", "require": "./bin/cli.cjs" }
  },
  "bin": { "batch-image-resizer": "./bin/cli.cjs" }
}
```

This lets you `require('@mattriley/batch-image-resizer')` **or** `import { resizeImages } from '@mattriley/batch-image-resizer'` without extra tooling.

---

## License

MIT
