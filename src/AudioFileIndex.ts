import { MakeError, MakeLogger, Type } from '@freik/core-utils';
import { ForFiles, MakeStringWatcher, StringWatcher } from '@freik/node-utils';
import { promises as fsp } from 'fs';
import path from 'path';
import { h32 } from 'xxhashjs';

// eslint-disable-next-line
const log = MakeLogger('AudioFileIndex', true);
const err = MakeError('AudioFileIndex-err');

const existingSongKeys = new Map<number, [string, string]>();

function getSongKey(prefix: string, fragmentNum: number, songPath: string) {
  if (songPath.startsWith(prefix)) {
    let hash = h32(songPath, fragmentNum).toNumber();
    while (existingSongKeys.has(hash)) {
      const val = existingSongKeys.get(hash);
      if (Type.isArray(val) && val[0] === prefix && songPath === val[1]) {
        break;
      }
      err(`songKey hash collision: "${songPath}"`);
      hash = h32(songPath, hash).toNumber();
    }
    existingSongKeys.set(hash, [prefix, songPath]);
    return `S${hash.toString(36)}`;
  }
  throw Error(`Invalid prefix ${prefix} for songPath ${songPath}`);
}

const audioTypes = new Set(['.flac', '.mp3', '.aac', '.m4a']);
const imageTypes = new Set(['.png', '.jpg', '.jpeg']);
const allTypes = [...audioTypes, ...imageTypes];
const fileWatcher = MakeStringWatcher().addToWatchList(allTypes);

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

const isMusicType = (filename: string) => isOfType(filename, audioTypes);
// Hidden images are fine for cover art (actually, maybe preferred!
const isImageType = (filename: string) => isOfType(filename, imageTypes, true);

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
  getHash: () => number;
  getLocation: () => string;
  forEachImageFile: (fn: PathHandler) => void;
  forEachAudioFile: (fn: PathHandler) => void;
  getLastScanTime: () => Date | null;
  // When we rescan files, look at file path diffs
  rescanFiles: (
    addAudioFile: PathHandler,
    delAudioFile: PathHandler,
    addImageFile: PathHandler,
    delImageFile: PathHandler,
  ) => Promise<void>;
};

const nullFn = () => {
  return;
};

function pathCompare(a: string | null, b: string | null): number {
  if (a === null) return b ? 1 : 0;
  if (b === null) return a ? -1 : 0;
  const m = a.toLocaleUpperCase();
  const n = b.toLocaleUpperCase();
  // Don't use localeCompare: it will make some things equal that aren't *quite*
  return (m > n ? 1 : 0) - (m < n ? 1 : 0);
}

/* This requires that both arrays are already sorted */
function SortedArrayDiff(
  oldList: string[],
  newList: string[],
  delFn: PathHandler,
  addFn: PathHandler,
): void {
  let oldIndex = 0;
  let newIndex = 0;
  let count = 0;
  for (; oldIndex < oldList.length || newIndex < newList.length; ) {
    const oldItem = oldIndex < oldList.length ? oldList[oldIndex] : null;
    const newItem = newIndex < newList.length ? newList[newIndex] : null;
    const comp = pathCompare(oldItem, newItem);
    if (comp === 0) {
      oldIndex++;
      newIndex++;
      continue;
    } else if (comp < 0 && oldItem !== null) {
      // old item goes "before" new item, so we've deleted old item
      delFn(oldItem);
      oldIndex++;
      count--;
    } else if (comp > 0 && newItem !== null) {
      // new item goes "before" old item, so we've added new item
      addFn(newItem);
      newIndex++;
      count++;
    }
  }
  if (count !== 0) {
    log(`Total delta from SortedArrayDiff: ${count}`);
  }
}

export async function MakeAudioFileIndex(
  location: string,
  fragmentHash: number,
  typesToWatch: StringWatcher,
): Promise<AudioFileIndex> {
  /*
   * "member" data goes here
   */
  // non-const: these things update "atomically" so the whole array gets changed
  let songList: string[] = [];
  let picList: string[] = [];
  let lastScanTime: Date | null = null;

  // TODO: Read this stuff from disk, either from the MDF cache,
  // or directly from the path provided
  async function loadExistingFileIndex(): Promise<boolean> {
    try {
      const dir = await fsp.opendir(path.join(location, '.emp'));
      await dir.close();
      // TODO: Make this check it for validity
      return true;
    } catch (e) {
      /* */
    }
    return false;
  }

  // Rescan the location, calling a function for each add/delete of image
  // or audio files
  async function rescanFiles(
    addAudioFn: PathHandler,
    delAudioFn: PathHandler,
    addImageFn: PathHandler,
    delImageFn: PathHandler,
  ): Promise<void> {
    const oldSongList = songList;
    const oldPicList = picList;
    const newSongList: string[] = [];
    const newPicList: string[] = [];
    const newLastScanTime = new Date();
    await ForFiles(
      location,
      (filePath: string) => {
        if (isMusicType(filePath)) {
          newSongList.push(filePath);
        } else if (isImageType(filePath)) {
          newPicList.push(filePath);
        } else {
          return false;
        }
        return true;
      },
      {
        recurse: true,
        keepGoing: true,
        fileTypes: [...allTypes],
      },
    );
    songList = newSongList.sort(pathCompare);
    picList = newPicList.sort(pathCompare);
    lastScanTime = newLastScanTime;
    // Alright, we've got the new list, now call the handlers to
    // post-process any differences from the previous list
    SortedArrayDiff(oldSongList, songList, delAudioFn, addAudioFn);
    SortedArrayDiff(oldPicList, picList, delImageFn, addImageFn);
    // TODO: Save the new list back to disk in the .emp file index
  }

  /*
   *
   * Begin 'constructor' code here:
   *
   */
  if (!(await loadExistingFileIndex())) {
    songList = [];
    picList = [];
    // Just rebuild the file list, don't do any processing right now
    await rescanFiles(nullFn, nullFn, nullFn, nullFn);
    // TODO: Write the stuff we just read into the .emp file
    // Also: Do the rest of the AudioFileIndex stuff:
    // image caches
    // file metadata cache
    // file metadata override
  }
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
