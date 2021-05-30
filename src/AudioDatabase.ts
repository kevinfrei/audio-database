import {
  Helpers,
  MakeError,
  MakeLogger,
  MakeMultiMap,
  MakeSingleWaiter,
  MultiMap,
  Operations,
  Pickle,
  ToU8,
  Type,
  Unpickle,
} from '@freik/core-utils';
import {
  Album,
  AlbumKey,
  Artist,
  ArtistKey,
  FullMetadata,
  isAlbumKey,
  isArtistKey,
  isSongKey,
  MediaKey,
  SongKey,
} from '@freik/media-core';
import { MakePersistence, Persist } from '@freik/node-utils';
import { promises as fsp } from 'fs';
import path from 'path';
import { h32 } from 'xxhashjs';
import { SongWithPath, VAType } from '.';
import {
  AudioFileIndex,
  GetIndexForKey,
  GetIndexForPath,
  MakeAudioFileIndex,
} from './AudioFileIndex';
import { MusicSearch, SearchResults } from './MusicSearch';
import { MakeSearchable } from './Search';

// eslint-disable-next-line
const log = MakeLogger('AudioDatabase');
const err = MakeError('AudioDatabase-err');

export type FlatAudioDatabase = {
  songs: SongWithPath[];
  artists: Artist[];
  albums: Album[];
};

export type AudioDatabase = {
  // General stuff
  addAudioFileIndex(idx: AudioFileIndex): Promise<boolean>;
  removeAudioFileIndex(idx: AudioFileIndex): Promise<boolean>;
  addFileLocation(str: string): Promise<boolean>;
  removeFileLocation(str: string): Promise<boolean>;
  getLocations(): string[];
  getAlbumPicture(key: AlbumKey): Promise<Buffer | void>;
  setAlbumPicture(key: AlbumKey, filepath: string): Promise<void>;
  getArtistPicture(key: ArtistKey): Promise<Buffer | void>;
  setArtistPicture(key: ArtistKey, filepath: string): Promise<void>;
  getSongPicture(key: SongKey): Promise<Buffer | void>;
  setSongPicture(key: SongKey, filepath: string): Promise<void>;
  addSongFromPath(filepath: string): void; // Some Testing
  delSongByPath(filepath: string): boolean; // Some Testing
  delSongByKey(key: SongKey): boolean; // Some Testing
  // For all the 'parsed' data
  getFlatDatabase(): FlatAudioDatabase; // Some Testing
  // Loading from/saving to persistence
  load(): Promise<boolean>; // Some Testing
  save(): Promise<void>; // Some Testing
  // Updating
  refresh(): Promise<boolean>;
  updateMetadata(fullPath: string, newMetadata: Partial<FullMetadata>): boolean;
  addOrUpdateSong(md: FullMetadata): void;
  getMetadata(fullPathOrKey: string): Promise<FullMetadata | void>;
  // API
  getSong(key: SongKey): SongWithPath | void;
  getAlbum(key: AlbumKey): Album | void;
  getArtist(key: ArtistKey): Artist | void;
  searchIndex(substring: boolean, term: string): SearchResults;
};

function normalizeName(n: string): string {
  return Helpers.NormalizeText(Helpers.StripInitialArticles(n));
}

type PrivateAudioData = {
  dbAudioIndices: Map<string, AudioFileIndex>;
  dbSongs: Map<SongKey, SongWithPath>;
  dbAlbums: Map<AlbumKey, Album>;
  dbArtists: Map<ArtistKey, Artist>;
  albumTitleIndex: MultiMap<string, AlbumKey>;
  artistNameIndex: Map<string, ArtistKey>;
  keywordIndex: MusicSearch | null;
};

const artistHash = new Map<number, string>();
function newArtistKey(artistName: string): string {
  const name = normalizeName(artistName);
  let hashNum = h32().update(name).digest().toNumber();
  while (artistHash.has(hashNum)) {
    const checkName = artistHash.get(hashNum);
    if (checkName === name) {
      break;
    }
    // There's a hash conflict :/
    log('ArtistKey conflict discovered!');
    hashNum = h32(hashNum).update(name).digest().toNumber();
  }
  artistHash.set(hashNum, name);
  return `R${ToU8(hashNum)}`;
}

const albumHash = new Map<number, string>();
function newAlbumKey(
  albumName: string,
  artistName: string,
  year: number,
): string {
  const artistSummary = `${normalizeName(albumName)}*${normalizeName(
    artistName,
  )}*${year}`;
  let hashNum = h32().update(artistSummary).digest().toNumber();
  while (albumHash.has(hashNum)) {
    const checkName = albumHash.get(hashNum);
    if (checkName === artistSummary) {
      break;
    }
    // There's a hash conflict :/
    log('AlbumKey conflict discovered!');
    hashNum = h32(hashNum).update(artistSummary).digest().toNumber();
  }
  artistHash.set(hashNum, artistSummary);
  return `L${ToU8(hashNum)}`;
}

export async function MakeAudioDatabase(
  localStorageLocation: string | Persist,
  audioKey?: string,
): Promise<AudioDatabase> {
  const persistenceIdName = audioKey || 'audio-database';
  const persist = Type.isString(localStorageLocation)
    ? MakePersistence(localStorageLocation)
    : localStorageLocation;
  /*
   * Private member data
   */
  const data: PrivateAudioData = {
    dbAudioIndices: new Map<string, AudioFileIndex>(),
    dbSongs: new Map<SongKey, SongWithPath>(),
    dbAlbums: new Map<AlbumKey, Album>(),
    dbArtists: new Map<ArtistKey, Artist>(),
    albumTitleIndex: MakeMultiMap<string, AlbumKey>(),
    artistNameIndex: new Map<string, ArtistKey>(),
    keywordIndex: null,
  };

  function getSongKey(songPath: string): string {
    const index = GetIndexForPath(songPath);
    if (!index) {
      throw new Error(`Can't find an index for the path ${songPath}`);
    }
    return index.makeSongKey(songPath);
  }

  const singleWaiter = MakeSingleWaiter(100);
  /*
   * Member functions
   */
  async function getPicture(key: MediaKey): Promise<Buffer | void> {
    if (isAlbumKey(key)) {
      const album = data.dbAlbums.get(key);
      if (album) {
        for (const songKey of album.songs) {
          const res = await getPicture(songKey);
          if (res instanceof Buffer) {
            return res;
          }
        }
      }
    } else if (isArtistKey(key)) {
      const artist = data.dbArtists.get(key);
      if (artist) {
        for (const songKey of artist.songs) {
          const res = await getPicture(songKey);
          if (res instanceof Buffer) {
            return res;
          }
        }
      }
    } else if (isSongKey(key)) {
      const idx = GetIndexForKey(key);
      const song = data.dbSongs.get(key);
      if (idx && song) {
        return idx.getImageForSong(song.path);
      }
    }
    // TODO: Return the default picture?
  }

  async function setPicture(key: MediaKey, filePath: string): Promise<void> {
    // TODO: This is *not* correct for non-Song keys.
    // Need more capabilities from AFI
    const afi = GetIndexForKey(key);
    if (afi && isSongKey(key)) {
      const buf = await fsp.readFile(filePath);
      await afi.setImageForSong(key, buf);
    }
  }

  function getOrNewArtist(name: string): Artist {
    const maybeKey: ArtistKey | undefined = data.artistNameIndex.get(
      normalizeName(name),
    );
    if (maybeKey) {
      const art = data.dbArtists.get(maybeKey);
      if (art) {
        return art;
      }
      err("DB inconsistency - artist key by name doesn't exist in key index");
      // Fall-through and just overwrite the artistNameIndex with a new key...
    }
    const key: ArtistKey = newArtistKey(name);
    data.artistNameIndex.set(normalizeName(name), key);
    const artist: Artist = { name, songs: [], albums: [], key };
    data.dbArtists.set(key, artist);
    return artist;
  }

  function getOrNewAlbum(
    title: string,
    year: number,
    artists: ArtistKey[],
    secondaryArtists: ArtistKey[],
    vatype: VAType,
    dirName: string,
  ): Album {
    const sharedNames =
      data.albumTitleIndex.get(normalizeName(title)) || new Set<AlbumKey>();
    // sharedNames is the list of existing albums with this title
    // It might be empty (coming from a few lines up there ^^^ )
    for (const albumKey of sharedNames) {
      const alb: Album | undefined = data.dbAlbums.get(albumKey);
      if (!alb) {
        err(
          `DB inconsistency - album (key: ${albumKey}) by title doesn't exist in index`,
        );
        // We don't have an easy recovery from this particular inconsistency
        continue;
      }
      const check: Album = alb;
      if (Helpers.NoArticlesNormalizedStringCompare(check.title, title) !== 0) {
        err(`DB inconsistency - album title index inconsistency`);
        continue;
      }
      if (check.year !== year) {
        continue;
      }
      // For VA type albums, we can ignore the artist list
      if (check.vatype === vatype && vatype.length > 0) {
        return check;
      }
      // Set equality...
      if (!Operations.ArraySetEqual(check.primaryArtists, artists)) {
        // If the primaryArtists is different, but the files are in the same
        // location, override the VA type update the primaryArtists list and
        // return this one.
        const anotherSong = data.dbSongs.get(check.songs[0]);
        if (!anotherSong) {
          continue;
        }
        /*
        This makes things mess up a bit, so let's not do it...
        if (path.dirname(anotherSong.path) !== dirName) {
          continue;
        }
        */
        // Check to see if there's a common subset of artists
        const commonArtists = Operations.ArrayIntersection(
          check.primaryArtists,
          artists,
        );
        const demoteArtists = (
          primaryArtists: ArtistKey[],
          secondArtists: ArtistKey[],
        ) => {
          for (let i = primaryArtists.length - 1; i >= 0; i--) {
            if (commonArtists.has(primaryArtists[i])) {
              continue;
            }
            // THIS MUTATES THE TWO ARRAYS! THIS IS BY DESIGN :O
            secondArtists.push(primaryArtists[i]);
            primaryArtists.splice(i, 1);
          }
        };
        if (commonArtists.size > 0) {
          // This means we still have a common set of artists, but we need to
          // "demote" some artists from primary to secondary
          // First, let's demote the song's artists
          demoteArtists(artists, secondaryArtists);
          // Okay, done with the song. For the album, we need to demote primary
          // artists not just for the album, but for any songs already on the
          // album already...
          for (let j = check.primaryArtists.length - 1; j >= 0; j--) {
            if (commonArtists.has(check.primaryArtists[j])) {
              continue;
            }
            // This artist needs to be removed. First, bump it to secondary for
            // each song
            for (const s of check.songs) {
              const sng = data.dbSongs.get(s);
              if (!sng) {
                err('Unable to find a referenced song');
                continue;
              }
              demoteArtists(sng.artistIds, sng.secondaryIds);
            }
          }
          return check;
        }
        if (false) {
          err('Found a likely mismarked VA song:');
          err(check);
          err('For this directory:');
          err(dirName);
          err('Artists:');
          err(artists);
        }
        check.vatype = 'va';
        check.primaryArtists = [];
        return check;
      }
      // If we're here, we've found the album we're looking for
      // Before returning, ensure that the artists have this album in their set
      for (const art of artists) {
        const thisArtist: Artist | undefined = data.dbArtists.get(art);
        if (!thisArtist) {
          continue;
        }
        const albums: Set<AlbumKey> = new Set(thisArtist.albums);
        if (albums.has(check.key)) {
          continue;
        }
        thisArtist.albums.push(check.key);
      }
      return check;
    }
    // If we've reached this code, we need to create a new album
    // sharedNames is already the (potentially empty) array of albumKeys
    // for the given title, so we can just add it to that array
    const key: AlbumKey = newAlbumKey(
      title,
      vatype === '' ? artists.join('/') : vatype,
      year,
    );
    const album: Album = {
      year,
      primaryArtists: vatype === '' ? artists : [],
      title,
      vatype,
      songs: [],
      key,
    };
    data.albumTitleIndex.set(normalizeName(title), key);
    data.dbAlbums.set(key, album);
    return album;
  }

  function addOrUpdateSong(md: FullMetadata) {
    // TODO: Make this remove an existing song if it conflicts, maybe?
    // We need to go from textual metadata to artist, album, and song keys
    // First, get the primary artist
    const tmpArtist: string | string[] = md.artist;
    const artists = typeof tmpArtist === 'string' ? [tmpArtist] : tmpArtist;
    const allArtists = artists.map((a) => getOrNewArtist(a));
    const artistIds: ArtistKey[] = allArtists.map((a) => a.key);
    const secondaryIds: ArtistKey[] = [];
    for (const sa of md.moreArtists || []) {
      const moreArt: Artist = getOrNewArtist(sa);
      allArtists.push(moreArt);
      secondaryIds.push(moreArt.key);
    }
    const album = getOrNewAlbum(
      md.album,
      md.year || 0,
      artistIds,
      secondaryIds,
      md.vaType || '',
      path.dirname(md.originalPath),
    );
    const theSong: SongWithPath = {
      path: md.originalPath,
      artistIds,
      secondaryIds,
      albumId: album.key,
      track: md.track + (md.disk || 0) * 100,
      title: md.title,
      key: getSongKey(md.originalPath),
    };
    if (md.variations !== undefined) {
      theSong.variations = md.variations;
    }
    album.songs.push(theSong.key);
    allArtists.forEach((artist) => {
      artist.songs.push(theSong.key);
      if (artist.albums.indexOf(album.key) < 0) {
        artist.albums.push(album.key);
      }
    });
    data.dbSongs.set(theSong.key, theSong);
  }

  function delSongByKey(key: SongKey): boolean {
    // First, remove the song itself, then remove the reference to the artist
    // and album. If the artist & album are now "empty" remove them as well

    const theSong = data.dbSongs.get(key);
    if (theSong === undefined) {
      return false;
    }
    if (!data.dbSongs.delete(key)) {
      err(`Unabled to delete the song:${theSong.title}`);
      return false;
    }
    const artists = new Set([...theSong.artistIds, ...theSong.secondaryIds]);
    // Remove the song from the album
    const theAlbum = data.dbAlbums.get(theSong.albumId);
    if (theAlbum) {
      const theEntry = theAlbum.songs.indexOf(key);
      if (theEntry >= 0) {
        theAlbum.songs.splice(theEntry, 1);
        if (theAlbum.songs.length === 0) {
          // Delete the album (shouldn't need to remove artists)
          if (!data.dbAlbums.delete(theAlbum.key)) {
            err(`Unable to delete the artist ${theAlbum.title}`);
          }
          // Delete the album from the name index
          const nameElem = data.albumTitleIndex.get(
            normalizeName(theAlbum.title),
          );
          if (nameElem === undefined) {
            err(`Unable to find ${theAlbum.title} in the title index`);
          } else {
            data.albumTitleIndex.remove(
              normalizeName(theAlbum.title),
              theAlbum.key,
            );
          }
        }
      } else {
        err(`Can't remove song ${theSong.title} from album ${theAlbum.title}`);
      }
    }
    for (const artistKey of artists) {
      const theArtist = data.dbArtists.get(artistKey);
      if (theArtist) {
        const theEntry = theArtist.songs.indexOf(key);
        if (theEntry >= 0) {
          theArtist.songs.splice(theEntry, 1);
          if (theArtist.songs.length === 0) {
            if (
              theArtist.albums.length !== 1 &&
              theArtist.albums[0] !== theSong.albumId
            ) {
              err(`${theArtist.name} still has albums, which seems wrong`);
            }
            if (!data.dbArtists.delete(theArtist.key)) {
              err(`Unable to delete the artist ${theArtist.name}`);
            }
            if (!data.artistNameIndex.delete(normalizeName(theArtist.name))) {
              err(
                `Unable to delete the artist ${theArtist.name} from name index`,
              );
            }
          }
        } else {
          err(
            `Can't remove song ${theSong.title} from artist ${theArtist.name}`,
          );
        }
      } else {
        err(`Can't find the album for the song ${theSong.title}`);
      }
    }
    return true;
  }

  function delSongByPath(filepath: string): boolean {
    const idx = GetIndexForPath(filepath);
    if (!idx) {
      return false;
    }
    const key = idx.makeSongKey(filepath);
    // Now, let's see if we can find this song
    return data.dbSongs.has(key) ? delSongByKey(key) : false;
  }

  // Returns true if we should look inside the file for metadata
  async function addSongFromPath(filePath: string): Promise<boolean> {
    // First, figure out if this is from an index or not
    const afi = GetIndexForPath(filePath);
    if (!afi) {
      // TODO: Make a "everything else" index.
      return false;
    }
    const md = await afi.getMetadataForSong(filePath);
    if (!md) {
      return false;
    }
    // We *could* save this data to disk, but honestly,
    // I don't think it's going to be measurably faster,
    // and I'd rather not waste the space or deal with data in multiple
    // places are now out of sync issues
    addOrUpdateSong(md);
    return true;
  }

  async function addAudioFileIndex(idx: AudioFileIndex): Promise<boolean> {
    // Keep this thing around for future updating when the metadata
    // caching is moved into the file index
    // TODO: Rebuild the search index
    // TODO: Migrate metadata caching/overrides to the AFI, perhaps?
    const filePath = idx.getLocation();
    if (data.dbAudioIndices.get(filePath)) {
      return false;
    }
    data.dbAudioIndices.set(filePath, idx);
    await idx.forEachAudioFile(addSongFromPath);
    return true;
  }
  async function addFileLocation(filePath: string): Promise<boolean> {
    const afi = await MakeAudioFileIndex(
      filePath,
      h32(filePath, 0xdeadbeef).toNumber(),
    );
    return await addAudioFileIndex(afi);
  }
  async function removeFileLocation(filepath: string): Promise<boolean> {
    const res = data.dbAudioIndices.delete(filepath);
    if (res) {
      return await refresh();
    }
    return false;
  }
  async function removeAudioFileIndex(idx: AudioFileIndex): Promise<boolean> {
    const filepath = idx.getLocation();
    return await removeFileLocation(filepath);
  }
  function getLocations(): string[] {
    return [...data.dbAudioIndices.keys()];
  }

  function rebuildIndex() {
    const songs = MakeSearchable(
      data.dbSongs.keys(),
      (key: SongKey) => data.dbSongs.get(key)?.title || '',
    );
    const albums = MakeSearchable(
      data.dbAlbums.keys(),
      (key: AlbumKey) => data.dbAlbums.get(key)?.title || '',
    );
    const artists = MakeSearchable(
      data.dbArtists.keys(),
      (key: ArtistKey) => data.dbArtists.get(key)?.name || '',
    );
    data.keywordIndex = { songs, artists, albums };
  }

  /**
   * @param  {boolean} substr - true for mid-word substring searches, false for
   * only 'starts with' search
   * @param  {string} term - The space-separated list of words to search for
   * @returns 3 arrays (songs, albums, artists) that have words that begin with
   * all of the search terms
   */
  function searchIndex(substr: boolean, terms: string): SearchResults {
    if (data.keywordIndex === null) {
      rebuildIndex();
    }
    if (data.keywordIndex === null) {
      throw Error('Bad news');
    }
    let first = true;
    let songs: Set<SongKey> = new Set();
    let albums: Set<AlbumKey> = new Set();
    let artists: Set<ArtistKey> = new Set();
    for (const t of terms.split(' ').map((s) => s.trim())) {
      if (t.length > 0) {
        const sng = data.keywordIndex.songs(t, substr);
        const alb = data.keywordIndex.albums(t, substr);
        const art = data.keywordIndex.artists(t, substr);
        songs = first
          ? new Set<string>(sng)
          : Operations.SetIntersection(songs, sng);
        albums = first
          ? new Set<string>(alb)
          : Operations.SetIntersection(albums, alb);
        artists = first
          ? new Set<string>(art)
          : Operations.SetIntersection(artists, art);
        first = false;
      }
    }
    log('songs:');
    log(songs);
    log('albums:');
    log(albums);
    log('artists:');
    log(artists);
    return {
      songs: [...songs],
      albums: [...albums],
      artists: [...artists],
    };
  }

  // Run a full rescan, dealing with new files/deletion of old files
  async function refresh(): Promise<boolean> {
    if (await singleWaiter.wait()) {
      try {
        await Promise.all(
          // TODO: Also handle adding/deleting/changing images?
          [...data.dbAudioIndices.values()].map((afi) =>
            afi.rescanFiles(addSongFromPath, delSongByPath),
          ),
        );
        // TODO: It should rebuild the keyword index
        log('Finished');
      } finally {
        singleWaiter.leave();
      }
      return true;
    } else {
      return false;
    }
  }

  function getFlatDatabase(): FlatAudioDatabase {
    return {
      songs: [...data.dbSongs.values()],
      artists: [...data.dbArtists.values()],
      albums: [...data.dbAlbums.values()],
    };
  }

  async function load(): Promise<boolean> {
    const stringVal = await persist.getItemAsync(persistenceIdName);
    const flattened = Unpickle(stringVal || '0');
    if (
      !flattened ||
      !Type.has(flattened, 'dbSongs') ||
      !Type.has(flattened, 'dbAlbums') ||
      !Type.has(flattened, 'dbArtists') ||
      !Type.has(flattened, 'albumTitleIndex') ||
      !Type.has(flattened, 'artistNameIndex') ||
      !Type.has(flattened, 'indices')
    ) {
      return false;
    }
    // TODO: Extra validation?
    const songs = flattened.dbSongs as Map<SongKey, SongWithPath>;
    const albums = flattened.dbAlbums as Map<AlbumKey, Album>;
    const artists = flattened.dbArtists as Map<ArtistKey, Artist>;
    const titleIndex = flattened.albumTitleIndex as MultiMap<string, AlbumKey>;
    const nameIndex = flattened.artistNameIndex as Map<string, ArtistKey>;
    const idx = flattened.indices as { location: string; hash: number }[];
    const audioIndices = new Map(
      (
        await Promise.all(
          idx.map(({ location, hash }) => MakeAudioFileIndex(location, hash)),
        )
      ).map((afi): [string, AudioFileIndex] => [afi.getLocation(), afi]),
    );
    data.dbSongs = songs;
    data.dbArtists = artists;
    data.dbAlbums = albums;
    data.albumTitleIndex = titleIndex;
    data.artistNameIndex = nameIndex;
    data.dbAudioIndices = audioIndices;
    return true;
  }

  async function save(): Promise<void> {
    // I think this should just be handled automatically, instead of requiring
    // clients to remember to do this..
    await persist.setItemAsync(
      persistenceIdName,
      Pickle({
        dbSongs: data.dbSongs,
        dbAlbums: data.dbAlbums,
        dbArtists: data.dbArtists,
        albumTitleIndex: data.albumTitleIndex,
        artistNameIndex: data.artistNameIndex,
        indices: [...data.dbAudioIndices].map(([loc, afi]) => ({
          location: loc,
          hash: afi.getHashForIndex(),
        })),
      }),
    );
  }

  function updateMetadata(
    fullPath: string,
    newMetadata: Partial<FullMetadata>,
  ): boolean {
    // Update this to delete the old song and add the new one...
    const indexForPath = GetIndexForPath(fullPath);
    if (!indexForPath) {
      return false;
    }
    indexForPath.updateMetadata({ ...newMetadata, originalPath: fullPath });
    return true;
  }

  async function getMetadata(
    fullPathOrKey: string,
  ): Promise<FullMetadata | void> {
    const isPath = fullPathOrKey.indexOf('/') >= 0;
    const afi = isPath
      ? GetIndexForPath(fullPathOrKey)
      : GetIndexForKey(fullPathOrKey);
    if (!afi) {
      // TODO: Make a "everything else" index?
      return;
    }
    const key = isPath ? afi.makeSongKey(fullPathOrKey) : fullPathOrKey;
    const song = data.dbSongs.get(key);
    if (!song) {
      return;
    }
    return await afi.getMetadataForSong(song.path);
  }
  /*
   *
   * Begin 'constructor' code here
   *
   */
  await load();

  return {
    getSong: (key: SongKey) => data.dbSongs.get(key),
    getArtist: (key: ArtistKey) => data.dbArtists.get(key),
    getAlbum: (key: AlbumKey) => data.dbAlbums.get(key),
    addAudioFileIndex,
    addFileLocation,
    removeAudioFileIndex,
    removeFileLocation,
    getLocations,
    getArtistPicture: getPicture,
    setArtistPicture: setPicture,
    getAlbumPicture: getPicture,
    setAlbumPicture: setPicture,
    getSongPicture: getPicture,
    setSongPicture: setPicture,
    addSongFromPath,
    addOrUpdateSong,
    delSongByPath,
    delSongByKey,
    getFlatDatabase,
    getMetadata,
    load,
    save,
    refresh,
    searchIndex,
    updateMetadata,
  };
}
