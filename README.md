# batch-image-resizer

Fast, parallel batch image resizer/converter built on **Sharp**. Defaults to a **flat output folder**, **atomic writes** (no 0‑byte files), and macOS-friendly ergonomics.

- Converts: HEIC/HEIF, JPEG, PNG, WebP, AVIF, TIFF, GIF, BMP
- Resizes to *fit inside* your max width/height, preserving aspect ratio
- **Flatten** by default (filenames only; avoids deep directory trees)
- Skips `.DS_Store` and **prunes** them afterwards (default)
- **Prunes empty directories** after the run (default)
- **macOS fallbacks**: if Sharp can’t re-encode HEIC/JPEG, uses Apple’s `sips` (default)
- **Atomic writes**: never publish partial/empty files

## Install

```bash
# Global (CLI)
npm i -g .

# Project local
npm i .
```

> Requires **Node 18+** and installs **sharp** as a dependency.

## Quick start (defaults tuned for macOS)

```bash
batch-image-resizer "./in" "./out" --max-width 2048 --max-height 2048
```

### Defaults
- `format=jpeg`
- `prune-dsstore=true` (skip + prune `.DS_Store`)
- `prune-empty-dirs=true`
- `verbose-errors=true`
- macOS only: `heic-fallback=auto`, `jpeg-fallback=auto` (use `sips` if Sharp fails)

### Override examples

```bash
# Keep original formats where possible
batch-image-resizer ./in ./out --format same

# Keep directory structure
batch-image-resizer ./in ./out --flatten false

# Turn off pruning or verbose logs
batch-image-resizer ./in ./out --prune-empty-dirs false --prune-dsstore false --verbose-errors false

# HEIC → JPEG with JPEG fallback if needed
batch-image-resizer ./in ./out --format jpeg

# Force HEIC output with JPEG fallback if HEIC fails
batch-image-resizer ./in ./out --format heic --fallback-format jpeg
```

## CLI

Run `batch-image-resizer --help` to see all flags. Highlights:

- **Core**: `--quality`, `--max-width`, `--max-height`, `--format`, `--fallback-format`
- **Performance**: `--auto` adaptive concurrency, `--concurrency <n>` fixed, plus `--auto-threads`
- **Flattening**: `--flatten` (default true), `--flatten-strategy hash|path`, `--flatten-sep _`
- **macOS helpers**: `--heic-fallback none|sips|auto`, `--jpeg-fallback none|sips|auto`
- **Cleanup**: `--prune-dsstore`, `--prune-empty-dirs`
- **Diagnostics**: `--verbose-errors`, `--version`

## Library usage

```js
const { resizeImages } = require('batch-image-resizer');

(async () => {
  const summary = await resizeImages({
    inputDir: './in',
    outputDir: './out',
    maxWidth: 2048,
    maxHeight: 2048,
    // Defaults apply:
    // format: 'jpeg', flatten: true,
    // pruneDSStore: true, pruneEmptyDirs: true, verboseErrors: true,
  });
  console.log(summary);
})();
```

### Summary structure

```ts
type Result = {
  src: string;
  dest: string;
  action: 'converted' | 'copied' | 'kept' | 'error';
  via?: 'sips';
  error?: string;
}

type Summary = {
  converted: number;
  copied: number;
  kept: number;
  errors: number;
  results: Result[];
}
```

## How it handles tricky files

- If an image can’t be decoded or re-encoded by Sharp, the tool:
  1. (macOS) tries `sips` when targeting **JPEG** (`heic-fallback` / `jpeg-fallback`)
  2. If that still fails (or on non‑macOS), **copies the original** (unless `--overwrite`)
- Writes are **atomic**: encode to a temp file and rename on success.
- JPEG targets automatically **remove alpha** and convert to **sRGB**.

## Notes

- `--flatten` can’t be combined with `--overwrite` (by design).
- Very long filenames are made collision-safe using a short hash suffix.
- To see the underlying reasons for a fallback or copy: use `--verbose-errors`.

MIT © mattriley
