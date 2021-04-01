import { MakeError, MakeLogger, Type } from '@freik/core-utils';
import { SongKey } from '@freik/media-core';
import { ForFiles, MakeStringWatcher, StringWatcher } from '@freik/node-utils';
import {
  MakeFileIndex,
  pathCompare,
  SortedArrayDiff,
} from '@freik/node-utils/lib/FileIndex';
import { promises as fsp } from 'fs';
import path from 'path';
import { h32 } from 'xxhashjs';

// eslint-disable-next-line
const log = MakeLogger('AudioFileIndex', true);
const err = MakeError('AudioFileIndex-err');

const audioTypes = MakeStringWatcher().addToWatchList(
  '.flac',
  '.mp3',
  '.aac',
  '.m4a',
);
const imageTypes = MakeStringWatcher().addToWatchList('.png', '.jpg', '.jpeg');
function watchTypes(pathName: string) {
  if (path.basename(pathName).startsWith('.')) {
    return imageTypes(pathName);
  }
  return audioTypes(pathName) || imageTypes(pathName);
}

function isOfType(
  filename: string,
  types: Set<string>,
  hidden?: boolean,
): boolean {
  return (
    (hidden || !path.basename(filename).startsWith('.')) &&
    types.has(path.extname(filename).toLowerCase())
  );
}

function getSharedPrefix(paths: string[]): string {
  let curPrefix: string | null = null;
  for (const filePath of paths) {
    if (curPrefix === null) {
      curPrefix = filePath;
    } else {
      while (!filePath.startsWith(curPrefix)) {
        curPrefix = curPrefix.substr(0, curPrefix.length - 1);
      }
      if (curPrefix.length === 0) {
        return '';
      }
    }
  }
  return curPrefix || '';
}

// An "audio data fragment" is a list of files and metadata info.
// The idea is that it should be a handful of files to read, instead of an
// entire directory structure to scan (i.e. fast, and easy to update)

// An ADF should be fed into the Music Scanner,
// which adds the fragment to the database.

// For cache's, song-specific preferences, and metadata overrides,
// they should be routed to the appropriate MDF to update.

type PathHandler = (pathName: string) => void;

export type AudioFileIndex = {
  indexForKey(key: SongKey): AudioFileIndex;
  getHash(): number;
  getLocation(): string;
  songKeyForPath(pathName: string): SongKey | void;
  pathForSongKey(key: SongKey): string | void;
  forEachImageFile(fn: PathHandler): void;
  forEachAudioFile(fn: PathHandler): void;
  getLastScanTime(): Date | null;
  // When we rescan files, look at file path diffs
  rescanFiles(
    addAudioFile?: PathHandler,
    delAudioFile?: PathHandler,
    addImageFile?: PathHandler,
    delImageFile?: PathHandler,
  ): Promise<void>;
};

const indexLookup = new Map<string, AudioFileIndex>();

// Given a song key, this finds the file index that contains
// SongKey's are formatted like this: S{hash-b16384}:{key-b64}
export function getIndexForKey(key: SongKey): AudioFileIndex | undefined {
  const indexPortion = key.substring(1, key.indexOf(':'));
  return indexLookup.get(indexPortion);
}

export async function MakeAudioFileIndex(
  location: string,
  fragmentHash: number,
): Promise<AudioFileIndex> {
  /*
   * "member" data goes here
   */
  // non-const: these things update "atomically" so the whole array gets changed
  let songList: string[] = [];
  let picList: string[] = [];
  let lastScanTime: Date | null = null;
  const prefix = location + (location[location.length] === '/' ? '' : '/');
  const hashEnc = Uencode(fragmentHash);
  // TODO: Provide a file index location override, yes?
  const fileIndex = MakeFileIndex(location, watchTypes);

  // A hash table of h32's to path-names
  const existingSongKeys = new Map<number, string>();

  function getSongKey(songPath: string) {
    if (songPath.startsWith(prefix)) {
      const shortPath = songPath.substr(prefix.length);
      let hash = h32(shortPath, fragmentHash).toNumber();
      while (existingSongKeys.has(hash)) {
        const val = existingSongKeys.get(hash);
        if (Type.isString(val) && pathCompare(val, shortPath) === 0) {
          break;
        }
        err(`songKey hash collision: "${songPath}"`);
        // Feed the old hash into the new hash to get a new value, cuz y not?
        hash = h32(songPath, hash).toNumber();
      }
      existingSongKeys.set(hash, shortPath);
      return `S${hashEnc}:${Uencode(hash)}`;
    }
    throw Error(`Invalid prefix ${prefix} for songPath ${songPath}`);
  }
  /*
   *
   * Begin 'constructor' code here:
   *
   */

  return {
    // Don't know if this is necessary
    getHash: () => fragmentHash,
    getLocation: () => location,
    getLastScanTime: () => lastScanTime,
    forEachImageFile: (fn: PathHandler) => picList.forEach(fn),
    forEachAudioFile: (fn: PathHandler) => songList.forEach(fn),
    rescanFiles,
  };
}
