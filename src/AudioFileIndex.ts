/* eslint-disable no-underscore-dangle */
import { MakeError, MakeLogger, ToU8, Type } from '@freik/core-utils';
import { FullMetadata, SimpleMetadata, SongKey } from '@freik/media-core';
import { Metadata } from '@freik/media-utils';
import { MakePersistence, MakeSuffixWatcher, Persist } from '@freik/node-utils';
import { hideFile } from '@freik/node-utils/lib/file';
import {
  FileIndex,
  MakeFileIndex,
  pathCompare,
} from '@freik/node-utils/lib/FileIndex';
import { promises as fsp } from 'fs';
import path from 'path';
import { h32 } from 'xxhashjs';
import {
  GetMetadataStore,
  IsFullMetadata,
  MetadataStore,
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
  destroy(): void;
};

const audioTypes = MakeSuffixWatcher('flac', 'mp3', 'aac', 'm4a');
const imageTypes = MakeSuffixWatcher('png', 'jpg', 'jpeg', 'heic', 'hei');

function watchTypes(pathName: string) {
  return (
    imageTypes(pathName) ||
    (audioTypes(pathName) && !path.basename(pathName).startsWith('.'))
  );
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

// Make sure the path has a final slash on it
function trailingSlash(pathName: string): string {
  if (pathName.endsWith('/')) {
    return pathName;
  } else {
    return pathName + '/';
  }
}

// If the result is a promise, await it, otherwise don't
async function maybeWait<T>(func: () => Promise<T> | T): Promise<T> {
  const res = func();
  if (Type.isPromise(res)) {
    return await res;
  } else {
    return res;
  }
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
      await maybeWait(() => func(pathName));
    }
    theSet.add(pathName);
  }
}

type PrivateAudioFileIndexData = {
  songList: string[];
  picList: string[];
  lastScanTime: Date | null;
  location: string;
  indexHashString: string;
  persist: Persist;
  fileIndex: FileIndex;
  metadataCache: MetadataStore;
  metadataOverride: MetadataStore;
  existingSongKeys: Map<number, string>;
  // TODO: Add an album cover storage location, too!
};

export async function MakeAudioFileIndex(
  locationName: string,
  fragmentHash: number,
  /*  writableLocation: string,*/
): Promise<AudioFileIndex> {
  /*
   * "member" data goes here
   */
  const _location = trailingSlash(path.resolve(locationName));
  // IIFE
  const _persist = await (async () => {
    const pathName = path.join(_location, '.emp');
    try {
      const str = await fsp.mkdir(pathName, { recursive: true });
      if (Type.isString(str)) {
        // If we created the folder, we also want to hide it, cuz turd files
        // are truly annoying
        await hideFile(pathName);
      } else {
        // TODO: Handle read-only file systems in here?
      }
    } catch (e) {
      // TODO: Handle read-only file systems in here?
    }
    return MakePersistence(pathName);
  })();
  const data: PrivateAudioFileIndexData = {
    songList: [],
    picList: [],
    lastScanTime: null,
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
      await maybeWait(() => fn(pic));
    }
  }

  // public
  async function forEachAudioFile(fn: PathHandlerEither): Promise<void> {
    for (const song of data.songList) {
      await maybeWait(() => fn(song));
    }
  }

  function getRelativePath(songPath: string): string {
    const absPath = path.resolve(songPath);
    if (!absPath.startsWith(data.location)) {
      throw Error(`Invalid prefix ${data.location} for songPath ${absPath}`);
    }
    return absPath.substr(data.location.length);
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
      const pathMd = Metadata.FullFromObj(
        path.resolve(path.join(data.location, relPath)),
        littlemd as any,
      );
      const md = { ...pathMd, ...mdOverride };

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
    data.metadataCache.set(relName, { ...newMetadata, originalPath: relName });
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
