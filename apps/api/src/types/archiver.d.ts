/**
 * Minimal ambient declaration for the `archiver` slice used by the data-room
 * download-what's-new endpoint. archiver 5.x ships no bundled types and
 * @types/archiver is not installed; rather than add a dependency (which would
 * mutate package.json / the lockfile — out of scope for this deliverable), we
 * declare exactly the surface we call: append(buffer, {name}), pipe(stream),
 * finalize(), and on('error', cb). Kept intentionally narrow.
 */
declare module 'archiver' {
  import type { Writable } from 'node:stream';

  interface Archiver {
    append(source: Buffer | NodeJS.ReadableStream | string, opts: { name: string }): this;
    pipe(dest: Writable): Writable;
    finalize(): Promise<void>;
    on(event: 'error', cb: (err: Error) => void): this;
    on(event: string, cb: (...args: unknown[]) => void): this;
  }

  interface ArchiverOptions {
    zlib?: { level?: number };
  }

  function archiver(format: 'zip' | 'tar', options?: ArchiverOptions): Archiver;
  export = archiver;
}
