# batch-image-resizer

Fast parallel batch image resizer/converter built on Sharp. Defaults to **flattened output**, safe atomic writes, and smart fallbacks.

## Install

```bash
npm i -g .   # from this folder
# or project-local: npm i .
```

## CLI

Run `batch-image-resizer --help` for all flags.

Example:

```bash
batch-image-resizer ./in ./out --format jpeg --quality 82 --max-width 2048 --max-height 2048 --prune-dsstore --prune-empty-dirs
```

- Converts HEIC/HEIF, JPEG, PNG, WebP, AVIF, TIFF, GIF, BMP.
- Uses atomic writes; if a conversion fails, no zero-byte files are left behind.
- If conversion fails, the original is copied (unless `--overwrite`).
- `.DS_Store` files are skipped by default; `--prune-dsstore` removes them after the run.
