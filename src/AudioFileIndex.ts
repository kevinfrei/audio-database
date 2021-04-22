/* eslint-disable no-underscore-dangle */
import {
  FromU8,
  MakeError,
  MakeLogger,
  MaybeWait,
  ToPathSafeName,
  ToU8,
  Type,
} from '@freik/core-utils';
import {
  FullMetadata,
  isSongKey,
  MediaKey,
  SimpleMetadata,
  SongKey,
} from '@freik/media-core';
import { Covers, Metadata } from '@freik/media-utils';
import {
  MakePersistence,
  MakeSuffixWatcher,
  PathUtil,
} from '@freik/node-utils';
import { hideFile } from '@freik/node-utils/lib/file';
import { MakeFileIndex, pathCompare } from '@freik/node-utils/lib/FileIndex';
import { constants as FS_CONST, promises as fsp } from 'fs';
import path from 'path';
import { h32 } from 'xxhashjs';
import { MakeBlobStore } from './BlobStore';
import {
  GetMetadataStore,
  IsFullMetadata,
  MinimumMetadata,
} from './DbMetadata';

// eslint-disable-next-line
const log = MakeLogger('AudioFileIndex', true);
const err = MakeError('AudioFileIndex-err');

type PathHandlerAsync = (pathName: string) => Promise<void>;
type PathHandlerSync = (pathName: string) => void;
type PathHandlerBoth = (pathName: string) => Promise<void> | void;
type PathHandlerEither = PathHandlerSync | PathHandlerAsync | PathHandlerBoth;

export type AudioFileIndex = {
  getHash(): string;
  getLocation(): string;
  makeSongKey(songPath: string): SongKey;
  forEachImageFile(fn: PathHandlerEither): Promise<void>;
  forEachAudioFile(fn: PathHandlerEither): Promise<void>;
  forEachImageFileSync(fn: PathHandlerSync): void;
  forEachAudioFileSync(fn: PathHandlerSync): void;
  getLastScanTime(): Date | null;
  // When we rescan files, look at file path diffs
  rescanFiles(
    addAudioFile?: PathHandlerEither,
    delAudioFile?: PathHandlerEither,
    addImageFile?: PathHandlerEither,
    delImageFile?: PathHandlerEither,
  ): Promise<void>;
  updateMetadata(newMetadata: MinimumMetadata): void;
  getMetadataForSong(filePath: string): Promise<FullMetadata | void>;
  setImageForSong(filePath: string, buf: Buffer): Promise<void>;
  getImageForSong(
    filePath: string,
    preferInternal?: boolean,
  ): Promise<Buffer | void>;
  destroy(): void;
};

// Helpers for the file list stuff
const audioTypes = MakeSuffixWatcher('flac', 'mp3', 'aac', 'm4a');
// Any other image types to care about?
const imageTypes = MakeSuffixWatcher('png', 'jpg', 'jpeg', 'heic', 'hei');
function watchTypes(pathName: string) {
  return (
    imageTypes(pathName) ||
    (audioTypes(pathName) && !path.basename(pathName).startsWith('.'))
  );
}

async function isWritableDir(pathName: string): Promise<boolean> {
  try {
    await fsp.access(pathName, FS_CONST.W_OK);
    const s = await fsp.stat(pathName);
    return s.isDirectory();
  } catch (e) {
    return false;
  }
}

// An "audio data fragment" is a list of files and metadata info.
// The idea is that it should be a handful of files to read, instead of an
// entire directory structure to scan (i.e. fast, and easy to update)

// An ADF should be fed into the Music Scanner,
// which adds the fragment to the database.

// For cache's, song-specific preferences, and metadata overrides,
// they should be routed to the appropriate MDF to update.

// "Static" data for looking up stuff across multiple indices
type IndexLocation = { location: string; index: AudioFileIndex };
const lengthSortedPaths: IndexLocation[] = [];
const indexKeyLookup = new Map<string, AudioFileIndex | null>();

// Given a song key, this finds the file index that contains
// SongKey's are formatted like this: S{hash-b16384}:{key-b64}
export function GetIndexForKey(key: SongKey): AudioFileIndex | void {
  const indexPortion = key.substring(1, key.indexOf(':'));
  const res = indexKeyLookup.get(indexPortion);
  if (res) return res;
}

export function GetIndexForPath(pathName: string): AudioFileIndex | void {
  for (const { location, index } of lengthSortedPaths) {
    if (pathCompare(pathName.substring(0, location.length), location) === 0) {
      return index;
    }
  }
}

// Adds an index with the given hash value and location
// It returns the encoded hash value for the location
function addIndex(
  hashValue: number,
  location: string,
  index: AudioFileIndex,
): string {
  let u8 = ToU8(hashValue);
  while (indexKeyLookup.has(u8)) {
    const idx = indexKeyLookup.get(u8);
    if (idx === index) {
      return u8;
    }
    // There's a hash conflict :/
    hashValue = h32(hashValue).update(location).digest().toNumber();
    u8 = ToU8(hashValue);
  }
  indexKeyLookup.set(u8, index);
  let i = 0;
  for (; i < lengthSortedPaths.length; i++) {
    if (lengthSortedPaths[i].location.length >= i) {
      break;
    }
  }
  lengthSortedPaths.splice(i, 0, { location, index });
  return u8;
}

// Remove the idnex from the location list
// It hangs out in the WeakMap, cuz why not...
function delIndex(index: AudioFileIndex) {
  // remove it from the path list
  const loc = index.getLocation();
  for (let i = 0; i < lengthSortedPaths.length; i++) {
    if (lengthSortedPaths[i].index === index) {
      if (lengthSortedPaths[i].location !== loc) {
        err(`Index and location are mismatched for ${loc}`);
      }
      lengthSortedPaths.splice(i, 1);
      return;
    }
  }
  // Clear it from the map
  // We don't delete it for consistent hashing? I haven't though through
  // collisions very well
  indexKeyLookup.set(index.getHash(), null);
}

// Helper for the file watcher stuff
async function maybeCallAndAdd(
  checker: (arg: string) => boolean,
  theSet: Set<string>,
  pathName: string,
  func?: PathHandlerEither,
): Promise<void> {
  if (checker(pathName)) {
    if (func) {
      await MaybeWait(() => func(pathName));
    }
    theSet.add(pathName);
  }
}

// The constructor for an AudioFileIndex
// It takes a file location name, a "hash" for that location (ideally, on that's
// stable *across operatings systems!* and a potential location for where to
// store metadata & whatnot if the file system is read-only
export async function MakeAudioFileIndex(
  locationName: string,
  fragmentHash: number,
  readonlyFallbackLocation?: string,
): Promise<AudioFileIndex> {
  /*
   * "member" data goes here
   */
  const _location = PathUtil.trailingSlash(path.resolve(locationName));
  // IIFE
  const _persist = await (async () => {
    const pathName = path.join(_location, '.emp');
    try {
      if (!(await isWritableDir(pathName))) {
        const str = await fsp.mkdir(pathName, { recursive: true });
        if (Type.isString(str)) {
          // If we created the folder, we also want to hide it, cuz turd files
          // are truly annoying
          await hideFile(pathName);
        }
      }
      return MakePersistence(pathName);
    } catch (e) {
      // Probably a read only file system
    }
    // For readonly stuff, use the fallback location
    if (Type.isString(readonlyFallbackLocation)) {
      return MakePersistence(path.resolve(locationName));
    } else {
      throw new Error(`Non-writable location: ${locationName}`);
    }
  })();
  const data = {
    songList: ((): string[] => [])(), // IIFE's instead of a full type
    picList: ((): string[] => [])(), // Same here
    lastScanTime: ((): Date | null => null)(), // And here :)
    location: _location,
    indexHashString: '',
    persist: _persist,
    fileIndex: await MakeFileIndex(
      _location,
      watchTypes,
      path.join(_persist.getLocation(), 'fileIndex.txt'),
    ),
    metadataCache: await GetMetadataStore(_persist, 'metadataCache'),
    metadataOverride: await GetMetadataStore(_persist, 'metadataOverride'),
    // A hash table of h32's to path-names
    existingSongKeys: new Map<number, string>(),
    pictures: await MakeBlobStore(
      (key: MediaKey) => ToPathSafeName(key),
      path.join(_location, 'images'),
    ),
  };

  // "this"
  const res: AudioFileIndex = {
    // Don't know if this is necessary
    getHash: () => data.indexHashString,
    getLocation: () => data.location,
    getLastScanTime: () => data.lastScanTime,
    makeSongKey,
    forEachImageFile,
    forEachAudioFile,
    forEachImageFileSync: (fn: PathHandlerSync) => data.picList.forEach(fn),
    forEachAudioFileSync: (fn: PathHandlerSync) => data.songList.forEach(fn),
    rescanFiles,
    updateMetadata,
    getMetadataForSong,
    getImageForSong,
    setImageForSong,
    destroy: () => delIndex(res),
  };
  data.indexHashString = addIndex(fragmentHash, data.location, res);
  data.fileIndex.forEachFileSync((pathName: string) => {
    if (audioTypes(pathName)) {
      data.songList.push(pathName);
    } else {
      // assert(imageTypes(pathName));
      data.picList.push(pathName);
    }
  });

  // public
  async function forEachImageFile(fn: PathHandlerEither): Promise<void> {
    for (const pic of data.picList) {
      await MaybeWait(() => fn(pic));
    }
  }

  // public
  async function forEachAudioFile(fn: PathHandlerEither): Promise<void> {
    for (const song of data.songList) {
      await MaybeWait(() => fn(song));
    }
  }

  // Pull out a relative path that we can use as an OS agnostic locater
  function getRelativePath(songPath: string): string {
    const absPath = path.resolve(songPath);
    if (!absPath.startsWith(data.location)) {
      throw Error(`Invalid prefix ${data.location} for songPath ${absPath}`);
    }
    return absPath.substr(data.location.length);
  }

  // From a (possibly) relative path, get something we can read data from
  function getFullPath(relPath: string): string {
    return path.isAbsolute(relPath)
      ? path.resolve(relPath)
      : path.resolve(path.join(data.location, relPath));
  }

  // This will return the AFI hash and the songkey hash,
  // or false if the thing isn't a songkey
  function getAFIKey(keyorpath: string): [number, number] | false {
    try {
      if (keyorpath[0] === 'S') {
        const split = keyorpath.indexOf(':');
        if (split > 1) {
          // If we've made it this far, the exception path is fine; odds are
          // it's a song key, so it's not likely to raise an exception
          // Windows paths won't match, because we're not allowing a colon
          // at index 1: It has to be greater than index 1
          const indexNum = FromU8(keyorpath.substring(1, split));
          const keyNum = FromU8(keyorpath.substring(split + 1));
          return [indexNum, keyNum];
        }
      }
    } catch (e) {} // eslint-disable-line no-empty
    return false;
  }

  // Given either a key or a path, this returns a full path
  function pathFromKeyOrPath(keyorpath: string): string {
    // First, pull out the number from the key
    if (isSongKey(keyorpath)) {
      const keyData = getAFIKey(keyorpath);
      if (
        keyData !== false &&
        ToU8(keyData[0]) === data.indexHashString &&
        data.existingSongKeys.has(keyData[1])
      ) {
        const relPath = data.existingSongKeys.get(keyData[1]);
        if (relPath) {
          return getFullPath(relPath);
        }
      }
    }
    // If this doesn't throw an exception, we're golden
    makeSongKey(keyorpath);
    return getFullPath(keyorpath);
  }

  // This *should* be pretty stable, with the rare exceptions of hash collisions
  // public
  function makeSongKey(songPath: string): SongKey {
    const relPath = getRelativePath(songPath);
    let hash = h32(relPath, fragmentHash).toNumber();
    while (data.existingSongKeys.has(hash)) {
      const val = data.existingSongKeys.get(hash);
      if (Type.isString(val) && pathCompare(val, relPath) === 0) {
        break;
      }
      err(`songKey hash collision: "${songPath}"`);
      // Feed the old hash into the new hash to get a new value, cuz y not?
      hash = h32(songPath, hash).toNumber();
    }
    data.existingSongKeys.set(hash, relPath);
    return `S${data.indexHashString}:${ToU8(hash)}`;
  }

  function updateList(
    list: string[],
    adds: Set<string>,
    dels: Set<string>,
  ): string[] {
    return list.concat([...adds]).filter((val) => !dels.has(val));
  }

  // public
  async function rescanFiles(
    addAudioFile?: PathHandlerEither,
    delAudioFile?: PathHandlerEither,
    addImageFile?: PathHandlerEither,
    delImageFile?: PathHandlerEither,
  ) {
    const audioAdds = new Set<string>();
    const imageAdds = new Set<string>();
    const audioDels = new Set<string>();
    const imageDels = new Set<string>();
    await data.fileIndex.rescanFiles(
      async (pathName: string) => {
        await maybeCallAndAdd(audioTypes, audioAdds, pathName, addAudioFile);
        await maybeCallAndAdd(imageTypes, imageAdds, pathName, addImageFile);
      },
      async (pathName: string) => {
        await maybeCallAndAdd(audioTypes, audioDels, pathName, delAudioFile);
        await maybeCallAndAdd(imageTypes, imageDels, pathName, delImageFile);
      },
    );
    data.songList = updateList(data.songList, audioAdds, audioDels);
    data.picList = updateList(data.picList, imageAdds, imageDels);
    data.lastScanTime = new Date();
  }

  // public
  async function getMetadataForSong(
    pathName: string,
  ): Promise<FullMetadata | void> {
    const relPath = getRelativePath(pathName);

    // If we've previously failed doing anything with this file, don't keep
    // banging our head against a wall
    if (!data.metadataCache.shouldTry(relPath)) {
      return;
    }
    // Cached data overrides file path acquired metadata
    const mdOverride = data.metadataOverride.get(relPath);
    const littlemd: SimpleMetadata | void = Metadata.FromPath(relPath);
    if (littlemd) {
      const fullPath = getFullPath(relPath);
      const pathMd = Metadata.FullFromObj(fullPath, littlemd as any);
      const md = { ...pathMd, ...mdOverride, originalPath: fullPath };

      if (IsFullMetadata(md)) {
        return md;
      }
    }
    // This does some stuff about trying harder for files that don't parse right
    let maybeMetadata = null;
    try {
      maybeMetadata = await Metadata.FromFileAsync(relPath);
    } catch (e) {
      err(`Failed acquiring metadata from ${relPath}:`);
      err(e);
    }
    if (!maybeMetadata) {
      log(`Complete metadata failure for ${relPath}`);
      data.metadataCache.fail(relPath);
      return;
    }
    const fullMd = Metadata.FullFromObj(relPath, maybeMetadata as any);
    if (!fullMd) {
      log(`Partial metadata failure for ${relPath}`);
      data.metadataCache.fail(relPath);
      return;
    }
    const overridden = { ...fullMd, ...mdOverride };
    data.metadataCache.set(relPath, overridden);
    // Don't need to wait on this one:
    void data.metadataCache.save();
    return overridden;
  }

  // public
  function updateMetadata(newMetadata: MinimumMetadata): void {
    const relName = getRelativePath(newMetadata.originalPath);
    data.metadataOverride.set(relName, {
      ...newMetadata,
      originalPath: relName,
    });
  }

  // public
  async function setImageForSong(
    keyOrPath: SongKey | string,
    buf: Buffer,
  ): Promise<void> {
    const key = getAFIKey(keyOrPath) ? keyOrPath : makeSongKey(keyOrPath);
    await data.pictures.put(buf, key);
  }

  // public
  async function getImageForSong(
    keyOrPath: SongKey | string,
    preferInternal?: boolean,
  ): Promise<Buffer | void> {
    const key = getAFIKey(keyOrPath) ? keyOrPath : makeSongKey(keyOrPath);
    // first check the blob-store
    const maybe = await data.pictures.get(key);
    if (maybe) {
      return maybe;
    }

    // Next, check the song or the album
    if (preferInternal) {
      // TODO: Continue
    }
    // First, pull out the number from the key
    const localPiece = key.substr(key.indexOf(':') + 1);
    const val = FromU8(localPiece);
    // Look up the relative path
    const relName = data.existingSongKeys.get(val);
    if (relName) {
      const fullpath = getFullPath(relName);
      // TODO: Maybe keep track of which files we've already ready from, so we
      // can skip this step in the future, yes?
      // Or instead leave this up to the AFI consumer to implement?
      const maybeData = await Covers.ReadFromFile(fullpath);
      if (maybeData) {
        const buffer = Buffer.from(maybeData.data, 'base64');
        // TODO: Save this outside the file, right?
        return buffer;
      }
      // We didn't find anything in the file, time to look in the folder
    }
  }

  /* async */ function handleAlbumCovers() {
    // Get all pictures from each directory.
    // Find the biggest and make it the album picture for any albums in that dir
    /*
    const dirsToPics = new Map<string, Set<string>>();
    idx.forEachImageFile((p) => {
      const dirName = path.dirname(p);
      const val = dirsToPics.get(dirName);
      if (val) {
        val.add(p);
      } else {
        dirsToPics.set(dirName, new Set([p]));
      }
    });
    const dirsToAlbums = new Map<string, Set<Album>>();
    for (const a of data.dbAlbums.values()) {
      for (const s of a.songs) {
        const theSong = data.dbSongs.get(s);
        if (!theSong) {
          continue;
        }
        const thePath = theSong.path;
        const dirName = path.dirname(thePath);
        // We only need to track directories if we found folders in them...
        if (!dirsToPics.has(dirName)) {
          continue;
        }
        const val = dirsToAlbums.get(dirName);
        if (val) {
          val.add(a);
        } else {
          dirsToAlbums.set(dirName, new Set([a]));
        }
      }
    }
    // Now, for each dir, find the biggest file and dump it in the database
    // for each album that has stuff in that directory
    type SizeAndName = { size: number; name: string };

    for (const [dirName, setOfFiles] of dirsToPics) {
      const albums = dirsToAlbums.get(dirName);
      if (!albums || !albums.size) {
        continue;
      }
      let largest: SizeAndName = { size: 0, name: '' };
      for (const cur of setOfFiles.values()) {
        const fileStat = await fsp.stat(cur);
        if (fileStat.size > largest.size) {
          largest = { size: fileStat.size, name: cur };
        }
      }
      for (const album of albums) {
        data.dbPictures.set(album.key, largest.name);
      }
    }
    */
    // Metadata-hosted album covers are only acquired "on demand"
  }

  return res;
}
