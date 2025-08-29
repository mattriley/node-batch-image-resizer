export type FileAction = 'converted' | 'copied' | 'kept' | 'error';

export interface ResizeResult {
  src: string;
  dest: string;
  action: FileAction;
  error?: string;
}

export interface ResizeSummary {
  converted: number;
  copied: number;
  kept: number;
  errors: number;
  results: ResizeResult[];
}

export type OutputFormat = 'same'|'jpeg'|'jpg'|'png'|'webp'|'avif'|'heif'|'heic'|'tiff';

export interface Options {
  inputDir?: string;
  outputDir?: string;
  overwrite?: boolean;

  format?: OutputFormat;
  fallbackFormat?: Exclude<OutputFormat, 'same'> | null;
  flatten?: boolean;
  flattenStrategy?: 'hash' | 'path';
  flattenSep?: string;
  maxFilenameBytes?: number;
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;

  auto?: boolean;
  concurrency?: number | null;
  minConcurrency?: number;
  maxConcurrency?: number;
  targetLatencyMs?: number;
  windowMs?: number;
  lagThresholdMs?: number;

  autoThreads?: boolean;
  targetThreads?: number;
  sharpThreads?: number | null;
  minSharpThreads?: number;
  maxSharpThreads?: number;

  includeExt?: string[] | null;
  excludeExt?: string[] | null;

  logger?: { info?: Function; warn?: Function; error?: Function } | Console;
  onWindow?: (e: { inFlightCap: number; avgLatency: number; lagMs: number }) => void;
  onFile?: (e: { src: string; dest: string; action: FileAction; error?: string }) => void;
}

export declare function resizeImages(options?: Options): Promise<ResizeSummary>;
export declare const DEFAULT_ALLOW_EXT: string[];
declare const _default: { resizeImages: typeof resizeImages; DEFAULT_ALLOW_EXT: typeof DEFAULT_ALLOW_EXT };
export default _default;
