# @mattriley/batch-image-resizer

Recursively **resize images** and **convert formats** with **adaptive concurrency**, **smart Sharp/libvips thread pooling**, and **safe fallbacks**. Use it either as a **CLI** or as a **library** (CommonJS & ESM supported).

- Output **format** is selectable via `--format`. Default is `same` (preserve original format when possible).
- New: `--fallback-format` (e.g., `jpeg`) to re-attempt encoding if the primary format fails or is unsupported per-file.
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

## CLI Usage

```bash
batch-image-resizer [INPUT_DIR] [OUTPUT_DIR] [flags...]
```

- **Minimum args:** none. Defaults to `INPUT_DIR=./images`, `OUTPUT_DIR=./output`.
- By default, runs in **safe mode** (does not overwrite originals).

### Quick start

> **Note:** By default, outputs are **flattened** into a single folder using collision-safe names. Use `--flatten false` to keep the original directory tree.

```bash
# Default: ./images → ./output, 1920x1080, quality 85, format same
batch-image-resizer

# Force HEIC, but fall back to JPEG if HEIC fails
batch-image-resizer ./photos ./out --format heic --fallback-format jpeg

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
| `--format` | string | `same` | Output format: `same`, `jpeg`/`jpg`, `png`, `webp`, `avif`, `heif`/`heic`, `tiff`. With `same`, if the original format isn’t encodable by Sharp, the file is copied/kept—unless `--fallback-format` is set. |
| `--fallback-format` | string | *(unset)* | If the primary encode fails or is unsupported for a file, **re-attempt** with this format (e.g., `jpeg`). |
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
| `--flatten` | boolean | `true` | Write all outputs directly into the **output root** (no subfolders). Pass `--flatten false` to preserve subfolders. Mutually exclusive with `--overwrite`. |
| `--flatten-strategy` | string | `hash` | Filename collision policy when flattening: `hash` (append short hash of relative path), or `path` (encode the path with a separator). |
| `--flatten-sep` | string | `_` | Separator when using `path` strategy (e.g., `Album_Sub_Img123.jpg`). |
| `--max-filename-bytes` | int | `200` | Max UTF‑8 bytes for a single filename (leave headroom for extension to avoid macOS 255‑byte limit). |

**Default convertible extensions** (allow-list):  
```.jpg .jpeg .png .webp .avif .heic .heif .tif .tiff .bmp .gif```

---

## Library Usage

**ESM**
```js
import { resizeImages } from '@mattriley/batch-image-resizer';

await resizeImages({
  inputDir: './photos',
  outputDir: './out',
  format: 'heic',
  fallbackFormat: 'jpeg',   // <= new
  auto: true,
  autoThreads: true
});
```

**CommonJS**
```js
const { resizeImages } = require('@mattriley/batch-image-resizer');

resizeImages({
  inputDir: './photos',
  outputDir: './out',
  format: 'jpeg'
}).then(console.log);
```

### API (additions)
```ts
export interface Options {
  // ...
  format?: 'same'|'jpeg'|'jpg'|'png'|'webp'|'avif'|'heif'|'heic'|'tiff';
  fallbackFormat?: Exclude<Options['format'], 'same'> | null; // try if primary fails/unsupported
}
```

---

## License

MIT


---

## Flattening examples

Write everything into one folder, ensuring unique filenames via a short hash of the original relative path:

```bash
batch-image-resizer ./in ./out --flatten --format jpeg --quality 80
```

Use path-encoded names instead of hashes (e.g., `Holidays_2020_IMG1234.jpg`):

```bash
batch-image-resizer ./in ./out --flatten --flatten-strategy path --flatten-sep _
```

**Notes**
- `--flatten` cannot be combined with `--overwrite`.
- When `--flatten` is on and two files would produce the same name even after hashing/path-encoding, the tool auto-appends `~1`, `~2`, … until the name is unique.
- To stay under macOS' 255-byte per-segment limit, the base filename is truncated to `--max-filename-bytes` UTF‑8 bytes before adding the extension.
