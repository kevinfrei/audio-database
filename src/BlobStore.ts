import {
  MakeMultiMap,
  MaybeWait,
  OnlyOneActive,
  SeqNum,
  SeqNumGenerator,
  ToPathSafeName,
  Type,
} from '@freik/core-utils';
import { FileUtil, PathUtil } from '@freik/node-utils';
import { promises as fs } from 'fs';
import path from 'path';

export type BlobStore<T> = {
  get(key: T): Promise<Buffer | void>;
  put(data: Buffer, key: T): Promise<void>;
  putMany(data: Buffer, key: Iterable<T>): Promise<void>;
  delete(key: T | T[]): Promise<void>;
  clear(): Promise<void>;
  flush(): Promise<void>;
};

// TODO: Add testing!
export async function MakeBlobStore<T>(
  keyLookup: (key: T) => Promise<string> | string,
  storeLocation: string,
): Promise<BlobStore<T>> {
  // The directory of the blob store
  const blobStoreDir = PathUtil.trailingSlash(path.resolve(storeLocation));
  // The index of string-keys to blob files
  const blobIndex = path.join(blobStoreDir, 'index.txt');
  // We're using Sequence Numbers for blob names
  // so this gets a "path safe" file name for the blob
  function getPath(seqNum: string): string {
    return path.join(blobStoreDir, ToPathSafeName(seqNum));
  }
  let sn: SeqNumGenerator;
  // hash key to filename lookup
  const keyToPath = new Map<string, string>();
  const pathToKeys = MakeMultiMap<string, string>();

  async function xlate(key: T): Promise<string> {
    return await MaybeWait(() => keyLookup(key));
  }

  try {
    const index = await FileUtil.textFileToArrayAsync(blobIndex);
    sn = SeqNum('BLOB-', index[0]);
    for (let i = 1; i < index.length; i += 2) {
      keyToPath.set(index[i], index[i + 1]);
      pathToKeys.set(index[i + 1], index[i]);
    }
  } catch (e) {
    sn = SeqNum('BLOB-');
    keyToPath.clear();
    pathToKeys.clear();
  }

  let lastSeqNumSave = '';

  const saveIndexInTheFuture = OnlyOneActive(async () => {
    const data = [lastSeqNumSave, ...keyToPath].flat();
    await FileUtil.arrayToTextFileAsync(data, blobIndex);
  }, 250);

  // Save the index file back to disk
  function saveIndex(lastSeqNum: string) {
    lastSeqNumSave = lastSeqNum;
    void saveIndexInTheFuture();
  }

  // Get the buffer from the disk store
  async function get(key: T): Promise<Buffer | void> {
    try {
      const hashKey = await xlate(key);
      const filepath = keyToPath.get(hashKey);
      if (filepath) {
        return await fs.readFile(getPath(filepath));
      }
    } catch (e) {
      // No file found...
    }
  }

  // Put a buffer on disk, with a set of keys (allowing many to one references)
  async function putMany(data: Buffer, keys: Iterable<T>): Promise<void> {
    const filename = sn();
    await fs.writeFile(getPath(filename), data);
    for (const key of keys) {
      const xlateKey = await xlate(key);
      keyToPath.set(xlateKey, filename);
      pathToKeys.set(filename, xlateKey);
    }
    saveIndex(filename);
  }

  // Does what it says :D
  async function clear(): Promise<void> {
    for (const [, file] of keyToPath) {
      await fs.rm(getPath(file));
    }
    keyToPath.clear();
    pathToKeys.clear();
    lastSeqNumSave = sn();
    await saveIndexInTheFuture.trigger();
  }

  async function del(key: T | T[]): Promise<void> {
    const keys = Type.isArray(key) ? key : [key];
    for (const k of keys) {
      const realKey = await xlate(k);
      const filename = keyToPath.get(realKey);
      if (filename) {
        keyToPath.delete(realKey);
        pathToKeys.remove(filename, realKey);
        if (pathToKeys.get(filename) === undefined) {
          await fs.rm(getPath(filename));
        }
      }
    }
    saveIndex(sn());
  }

  async function flush() {
    await saveIndexInTheFuture.trigger();
  }
  // TODO: Add a 'deduplication' function? Hash the buffers or something?

  return {
    get,
    put: (data: Buffer, key: T): Promise<void> => putMany(data, [key]),
    putMany,
    delete: del,
    clear,
    flush,
  };
}
