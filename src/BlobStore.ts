import {
  MaybeWait,
  SeqNum,
  SeqNumGenerator,
  ToPathSafeName,
} from '@freik/core-utils';
import { FileUtil, PathUtil } from '@freik/node-utils';
import { promises as fs } from 'fs';
import path from 'path';

export type BlobStore<T> = {
  get(key: T): Promise<Buffer | void>;
  put(data: Buffer, key: T): Promise<void>;
  putMany(data: Buffer, key: Iterable<T>): Promise<void>;
  clear(): Promise<void>;
};

// TODO: Add testing!
export async function MakeBlobStore<T>(
  keyLookup: (key: T) => Promise<string> | string,
  storeLocation: string,
): Promise<BlobStore<T>> {
  // The directory of the blob store
  const blobStoreDir = PathUtil.trailingSlash(storeLocation);
  // The index of string-keys to blob files
  const blobIndex = path.join(blobStoreDir, 'index.txt');
  // We're using Sequence Numbers for blob names
  // so this gets a "path safe" file name for the blob
  function getPath(seqNum: string): string {
    return path.join(blobStoreDir, ToPathSafeName(seqNum));
  }
  let sn: SeqNumGenerator;
  // hash key to filename lookup
  let theMap: Map<string, string>;

  try {
    const index = await FileUtil.textFileToArrayAsync(blobIndex);
    sn = SeqNum('blob-', index[0]);
    const mapVal: [string, string][] = [];
    for (let i = 1; i < index.length; i += 2) {
      mapVal.push([index[i], index[i + 1]]);
    }
    theMap = new Map(mapVal);
  } catch (e) {
    sn = SeqNum('blob-');
    theMap = new Map<string, string>();
  }

  // Save the index file back to disk
  async function saveIndex(lastSeqNum: string): Promise<void> {
    // TODO: Debounce this
    const data = [lastSeqNum];
    for (const [key, name] of theMap) {
      data.push(key);
      data.push(name);
    }
    await FileUtil.arrayToTextFileAsync(data, blobIndex);
  }

  // Get the buffer from the disk store
  async function get(key: T): Promise<Buffer | void> {
    try {
      const hashKey = await MaybeWait(() => keyLookup(key));
      const filepath = theMap.get(hashKey);
      if (filepath) {
        return await fs.readFile(filepath);
      }
    } catch (e) {
      // No file found...
    }
  }

  // Put a buffer on disk, with a set of keys (allowing many to one references)
  async function putMany(data: Buffer, keys: Iterable<T>): Promise<void> {
    const filename = sn();
    const thePath = getPath(filename);
    await fs.writeFile(thePath, data);
    for (const key of keys) {
      theMap.set(await MaybeWait(() => keyLookup(key)), filename);
    }
    await saveIndex(filename);
  }

  // Does what it says :D
  async function clear(): Promise<void> {
    for (const [, file] of theMap) {
      await fs.rm(getPath(file));
    }
    theMap.clear();
    await saveIndex(sn());
  }

  // TODO: Add a 'deduplication' function? Hash the buffers or something?

  return {
    get,
    put: (data: Buffer, key: T): Promise<void> => putMany(data, [key]),
    putMany,
    clear,
  };
}
