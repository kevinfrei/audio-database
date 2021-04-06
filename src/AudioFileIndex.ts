import { MakeError, MakeLogger, ToU8, Type } from '@freik/core-utils';
import { FullMetadata, SimpleMetadata, SongKey } from '@freik/media-core';
import { Metadata } from '@freik/media-utils';
import { MakePersistence, MakeSuffixWatcher, Persist } from '@freik/node-utils';
import { hideFile } from '@freik/node-utils/lib/file';
import { MakeFileIndex, pathCompare } from '@freik/node-utils/lib/FileIndex';
import { promises as fsp } from 'fs';
import path from 'path';
import { h32 } from 'xxhashjs';
import { GetMetadataStore, IsFullMetadata } from './DbMetadata';

// eslint-disable-next-line
const log = MakeLogger('AudioFileIndex', true);
const err = MakeError('AudioFileIndex-err');

type PathHandlerAsync = (pathName: string) => Promise<void>;
type PathHandlerSync = (pathName: string) => void;
type PathHandlerBoth = (pathName: string) => Promise<void> | void;
type PathHandlerEither = PathHandlerSync | PathHandlerAsync | PathHandlerBoth;

export type AudioFileIndex = {
  getHash(): number;
  getLocation(): string;
  getSongKey(songPath: string): SongKey;
  /*
  songKeyForPath(pathName: string): SongKey | void;
  pathForSongKey(key: SongKey): string | void;
  */
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
  updateMetadata(
    keyOrPath: SongKey | string,
    newMetadata: Partial<FullMetadata>,
  ): Promise<boolean>;
  getMetadataForSong(filePath: string): Promise<FullMetadata | void>;
  destroy(): void;
};

const audioTypes = MakeSuffixWatcher().addToWatchList(
  'flac',
  'mp3',
  'aac',
  'm4a',
);
const imageTypes = MakeSuffixWatcher().addToWatchList(
  'png',
  'jpg',
  'jpeg',
  'heic',
  'hei',
);

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
const indexKeyLookup = new Map<string, AudioFileIndex>();
type IndexLocation = { location: string; index: AudioFileIndex };
const lengthSortedPaths: IndexLocation[] = [];

// Given a song key, this finds the file index that contains
// SongKey's are formatted like this: S{hash-b16384}:{key-b64}
export function GetIndexForKey(key: SongKey): AudioFileIndex | undefined {
  const indexPortion = key.substring(1, key.indexOf(':'));
  return indexKeyLookup.get(indexPortion);
}

export function GetIndexForPath(pathName: string): AudioFileIndex | undefined {
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

function delIndex(index: AudioFileIndex) {
  // TODO: Remove the index
}

export async function MakeAudioFileIndex(
  locationName: string,
  fragmentHash: number,
  /*  writableLocation: string,*/
): Promise<AudioFileIndex> {
  /*
   * "member" data goes here
   */
  // non-const: these things update "atomically" so the whole array gets changed
  let songList: string[] = [];
  let picList: string[] = [];
  let lastScanTime: Date | null = null;

  const location = path.resolve(
    locationName + (locationName[locationName.length] === '/' ? '' : '/'),
  );

  // "this"
  const res: AudioFileIndex = {
    // Don't know if this is necessary
    getHash: () => fragmentHash,
    getLocation: () => location,
    getLastScanTime: () => lastScanTime,
    getSongKey,
    forEachImageFile,
    forEachAudioFile,
    forEachImageFileSync: (fn: PathHandlerSync) => picList.forEach(fn),
    forEachAudioFileSync: (fn: PathHandlerSync) => songList.forEach(fn),
    rescanFiles,
    updateMetadata,
    getMetadataForSong,
    destroy: () => delIndex(res),
  };

  async function forEachImageFile(fn: PathHandlerEither): Promise<void> {
    for (const pic of picList) {
      const foo = fn(pic);
      if (Type.isPromise(foo)) {
        await foo;
      }
    }
  }

  async function forEachAudioFile(fn: PathHandlerEither): Promise<void> {
    for (const song of songList) {
      const foo = fn(song);
      if (Type.isPromise(foo)) {
        await foo;
      }
    }
  }

  function getShortPath(songPath: string): string {
    const absPath = path.resolve(songPath);
    if (!absPath.startsWith(location)) {
      throw Error(`Invalid prefix ${location} for songPath ${absPath}`);
    }
    return absPath.substr(location.length);
  }

  async function getOrCreateStorage(): Promise<Persist> {
    const pathName = path.join(location, '.emp');
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
  }

  const indexHashString = addIndex(fragmentHash, location, res);
  // TODO: Provide a file index location override, maybe?
  const persist: Persist = await getOrCreateStorage();
  const fileIndex = await MakeFileIndex(
    location,
    watchTypes,
    persist.getLocation(),
  );
  fileIndex.forEachFileSync((pathName: string) => {
    if (audioTypes(pathName)) {
      songList.push(pathName);
    } else {
      // assert(imageTypes(pathName));
      picList.push(pathName);
    }
  });

  // A hash table of h32's to path-names
  const existingSongKeys = new Map<number, string>();

  // This *should* be pretty stable, with the rare exceptions of hash collisions
  function getSongKey(songPath: string): SongKey {
    const shortPath = getShortPath(songPath);
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
    return `S${indexHashString}:${ToU8(hash)}`;
  }

  const metadataCache = await GetMetadataStore(persist, 'metadataCache');
  const metadataOverride = await GetMetadataStore(persist, 'metadataOverride');

  function updateList(
    list: string[],
    adds: Set<string>,
    dels: Set<string>,
  ): string[] {
    return list.concat([...adds]).filter((val) => !dels.has(val));
  }
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
    await fileIndex.rescanFiles(
      async (pathName: string) => {
        if (audioTypes(pathName)) {
          if (addAudioFile) {
            const aaf = addAudioFile(pathName);
            if (Type.isPromise(aaf)) {
              await aaf;
            }
          }
          audioAdds.add(pathName);
        }
        if (imageTypes(pathName)) {
          if (addImageFile) {
            const aif = addImageFile(pathName);
            if (Type.isPromise(aif)) {
              await aif;
            }
          }
          imageAdds.add(pathName);
        }
      },
      async (pathName: string) => {
        if (audioTypes(pathName)) {
          if (delAudioFile) {
            const daf = delAudioFile(pathName);
            if (Type.isPromise(daf)) {
              await daf;
            }
          }
          audioDels.add(pathName);
        }
        if (imageTypes(pathName)) {
          if (delImageFile) {
            const dif = delImageFile(pathName);
            if (Type.isPromise(dif)) {
              await dif;
            }
          }
          imageDels.add(pathName);
        }
      },
    );
    songList = updateList(songList, audioAdds, audioDels);
    picList = updateList(picList, imageAdds, imageDels);
    lastScanTime = new Date();
  }

  async function updateMetadata(
    keyOrPath: SongKey | string,
    newMetadata: Partial<FullMetadata>,
  ): Promise<boolean> {
    // TODO: Fill this in
    return new Promise<boolean>(() => {
      /* */
    });
  }

  async function getMetadataForSong(
    pathName: string,
  ): Promise<FullMetadata | void> {
    const fileName = getShortPath(pathName);

    // If we've previously failed doing anything with this file, don't keep
    // banging our head against a wall
    if (!metadataCache.shouldTry(fileName)) {
      return;
    }
    // Cached data overrides file path acquired metadata
    const mdOverride = metadataOverride.get(fileName);
    const littlemd: SimpleMetadata | void = Metadata.FromPath(fileName);
    if (littlemd) {
      const pathMd = Metadata.FullFromObj(fileName, littlemd as any);
      const md = { ...pathMd, ...mdOverride };

      if (IsFullMetadata(md)) {
        return md;
      }
    }
    // This does some stuff about trying harder for files that don't parse right
    let maybeMetadata = null;
    try {
      maybeMetadata = await Metadata.FromFileAsync(fileName);
    } catch (e) {
      err(`Failed acquiring metadata from ${fileName}:`);
      err(e);
    }
    if (!maybeMetadata) {
      log(`Complete metadata failure for ${fileName}`);
      metadataCache.fail(fileName);
      return;
    }
    const fullMd = Metadata.FullFromObj(fileName, maybeMetadata as any);
    if (!fullMd) {
      log(`Partial metadata failure for ${fileName}`);
      metadataCache.fail(fileName);
      return;
    }
    const overridden = { ...fullMd, ...mdOverride };
    metadataCache.set(fileName, overridden);
    // Don't need to wait on this one:
    void metadataCache.save();
    return overridden;
    /*
    await handleAlbumCovers(idx);
    */
  }

  // TODO: Delegate this to the index
  /* async */ function handleAlbumCovers(idx: AudioFileIndex) {
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
  /*
   *
   * Begin 'constructor' code here:
   *
   */

  return res;
}
