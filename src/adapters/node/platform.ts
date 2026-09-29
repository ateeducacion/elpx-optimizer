import { copyFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import type { ByteSource } from '../../core/io/byte-source.js';
import { streamRange } from '../../core/io/byte-source.js';
import type { Limits } from '../../core/limits.js';
import type { OutputTarget, Platform } from '../../core/optimize/optimize.js';
import { AtomicFileSink } from './file-sink.js';
import { FileByteSource } from './file-source.js';
import { NativeMediaEngine, type NativeEngineOptions } from './native-media-engine.js';
import { NodeResourceStore } from './resource-store.js';

/** Output written next to its final path and renamed into place on commit. */
export class NodeOutputTarget implements OutputTarget {
  private reader: FileByteSource | undefined;

  private constructor(private sinkImpl: AtomicFileSink) {}

  static async create(finalPath: string): Promise<NodeOutputTarget> {
    return new NodeOutputTarget(await AtomicFileSink.create(finalPath));
  }

  get sink(): AtomicFileSink {
    return this.sinkImpl;
  }

  get tempPath(): string {
    return this.sinkImpl.tempPath;
  }

  async finish(): Promise<ByteSource> {
    await this.sinkImpl.close();
    this.reader = await FileByteSource.open(this.sinkImpl.tempPath);
    return this.reader;
  }

  /** Replaces the temporary output with a copy of the input bytes. */
  async useOriginal(source: ByteSource): Promise<ByteSource> {
    await this.reader?.close();
    this.reader = undefined;
    const finalPath = this.sinkImpl.finalPath;
    await this.sinkImpl.discard();
    this.sinkImpl = await AtomicFileSink.create(finalPath);
    if (source instanceof FileByteSource && source.path) {
      await this.sinkImpl.close();
      await copyFile(source.path, this.sinkImpl.tempPath);
    } else {
      for await (const chunk of streamRange(source, 0, source.size)) await this.sinkImpl.write(chunk);
      await this.sinkImpl.close();
    }
    this.reader = await FileByteSource.open(this.sinkImpl.tempPath);
    return this.reader;
  }

  /** Moves the verified output to its final path. */
  async commit(overwrite: boolean): Promise<void> {
    await this.reader?.close();
    this.reader = undefined;
    await this.sinkImpl.commit(overwrite);
  }

  async discard(): Promise<void> {
    await this.reader?.close().catch(() => undefined);
    this.reader = undefined;
    await this.sinkImpl.discard();
  }
}

/** Options for the native platform. */
export interface NodePlatformOptions extends NativeEngineOptions {
  limits: Limits;
  outputPath: string;
  tempRoot?: string;
  imageConcurrency?: number;
}

/** A platform whose output target can be committed. */
export interface NodePlatform extends Platform {
  readonly store: NodeResourceStore;
  readonly engine: NativeMediaEngine;
  lastOutput(): NodeOutputTarget | undefined;
}

/** Creates the native platform (temp store, engine, atomic output). */
export async function createNodePlatform(options: NodePlatformOptions): Promise<NodePlatform> {
  const store = await NodeResourceStore.create(options.tempRoot ? { tempRoot: options.tempRoot } : {});
  const engine = new NativeMediaEngine(store, options);
  let last: NodeOutputTarget | undefined;
  return {
    engine,
    store,
    limits: options.limits,
    imageConcurrency: options.imageConcurrency ?? Math.max(1, Math.min(4, cpus().length - 1)),
    async createOutput() {
      last = await NodeOutputTarget.create(options.outputPath);
      return last;
    },
    lastOutput: () => last,
  };
}
