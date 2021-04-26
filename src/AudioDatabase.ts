import {
  Helpers,
  MakeError,
  MakeLogger,
  MakeMultiMap,
  MakeSingleWaiter,
  MultiMap,
  Operations,
  Pickle,
  SeqNum,
  Type,
  Unpickle,
} from '@freik/core-utils';
import {
  Album,
  AlbumKey,
  Artist,
  ArtistKey,
  FullMetadata,
  MediaKey,
  SongKey,
} from '@freik/media-core';
import { MakePersistence, Persist } from '@freik/node-utils';
import path from 'path';
import { SongWithPath, VAType } from '.';
import {
  AudioFileIndex,
  GetIndexForPath,
  MakeAudioFileIndex,
} from './AudioFileIndex';
import { MusicSearch, SearchResults } from './MusicSearch';
import { MakeSearchable } from './Search';

// eslint-disable-next-line
const log = MakeLogger('AudioDatabase', true);
const err = MakeError('AudioDatabase-err');

export type FlatAudioDatabase = {
  songs: SongWithPath[];
  artists: Artist[];
  albums: Album[];
};

export type AudioDatabase = {
  // General stuff
  addAudioFileIndex(idx: AudioFileIndex): void;
  getAlbumPicture(key: AlbumKey): string;
  setAlbumPicture(key: AlbumKey, filepath: string): void;
  getArtistPicture(key: ArtistKey): string;
  setArtistPicture(key: ArtistKey, filepath: string): void;
  getSongPicture(key: SongKey): string;
  setSongPicture(key: SongKey, filepath: string): void;
  addSongFromPath(filepath: string): void; // Some Testing
  addOrUpdateSong(md: FullMetadata): void;
  delSongByPath(filepath: string): boolean; // Some Testing
  delSongByKey(key: SongKey): boolean; // Some Testing
  // For all the 'parsed' data
  getFlatDatabase(): FlatAudioDatabase; // Some Testing
  // Loading/saving
  load(filename: string): Promise<boolean>; // Some Testing
  save(filename: string): Promise<void>; // Some Testing
  // Updating
  refresh(): Promise<boolean>;
  updateMetadata(fullPath: string, newMetadata: Partial<FullMetadata>): boolean;

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
  dbAudioIndices: AudioFileIndex[];
  dbSongs: Map<SongKey, SongWithPath>;
  dbAlbums: Map<AlbumKey, Album>;
  dbArtists: Map<ArtistKey, Artist>;
  dbPictures: Map<MediaKey, string>;
  albumTitleIndex: MultiMap<string, AlbumKey>;
  artistNameIndex: Map<string, ArtistKey>;
  keywordIndex: MusicSearch | null;
};

export async function MakeAudioDatabase(
  localStorageLocation: string | Persist,
): Promise<AudioDatabase> {
  const persist = Type.isString(localStorageLocation)
    ? MakePersistence(localStorageLocation)
    : localStorageLocation;
  /*
   * Private member data
   */
  const data: PrivateAudioData = {
    dbAudioIndices: [],
    dbSongs: new Map<SongKey, SongWithPath>(),
    dbAlbums: new Map<AlbumKey, Album>(),
    dbArtists: new Map<ArtistKey, Artist>(),
    dbPictures: new Map<MediaKey, string>(),
    albumTitleIndex: MakeMultiMap<string, AlbumKey>(),
    artistNameIndex: new Map<string, ArtistKey>(),
    keywordIndex: null,
  };

  const newAlbumKey = SeqNum('L');
  const newArtistKey = SeqNum('R');
  let existingKeys: Map<string, SongKey> | null = null;

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
  function getPicture(key: MediaKey): string {
    // TODO: This is *not* correct: Update this to get the picture from the AFI
    const p = data.dbPictures.get(key);
    if (p) {
      return p;
    }
    return '*TODO: Default Picture Path*';
  }

  function setPicture(key: MediaKey, filePath: string) {
    // TODO: This is *not* correct: Update this to forward the data to the AFI
    data.dbPictures.set(key, filePath);
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
    const key: ArtistKey = newArtistKey();
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
    const key: AlbumKey = newAlbumKey();
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
      variations: md.variations,
    };
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

  function addAudioFileIndex(idx: AudioFileIndex) {
    // Keep this thing around for future updating when the metadata
    // caching is moved into the file index
    // TODO: Add the *files* from the AFI (and rebuild the search index)
    // TODO: Migrate metadata caching/overrides to the AFI
    data.dbAudioIndices.push(idx);
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
          data.dbAudioIndices.map((afi) =>
            afi.rescanFiles(addSongFromPath, delSongByPath),
          ),
        );
        // TODO: It should rebuild the keyword index
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

  async function load(filename: string): Promise<boolean> {
    const stringVal = await persist.getItemAsync(filename);
    const flattened = Unpickle(stringVal || '0');
    if (
      !flattened ||
      !Type.has(flattened, 'dbSongs') ||
      !Type.has(flattened, 'dbAlbums') ||
      !Type.has(flattened, 'dbArtists') ||
      !Type.has(flattened, 'dbPictures') ||
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
    const pictures = flattened.dbPictures as Map<MediaKey, string>;
    const titleIndex = flattened.albumTitleIndex as MultiMap<string, AlbumKey>;
    const nameIndex = flattened.artistNameIndex as Map<string, ArtistKey>;
    const idx = flattened.indices as { location: string; hash: number }[];
    const audioIndices = await Promise.all(
      idx.map(({ location, hash }) => MakeAudioFileIndex(location, hash)),
    );
    data.dbSongs = songs;
    data.dbArtists = artists;
    data.dbAlbums = albums;
    data.dbPictures = pictures;
    data.albumTitleIndex = titleIndex;
    data.artistNameIndex = nameIndex;
    data.dbAudioIndices = audioIndices;
    return true;
  }

  async function save(filename: string): Promise<void> {
    // I think this should just be handled automatically, instead of requiring
    // clients to remember to do this..
    await persist.setItemAsync(
      filename,
      Pickle({
        dbSongs: data.dbSongs,
        dbAlbums: data.dbAlbums,
        dbArtists: data.dbArtists,
        dbPictures: data.dbPictures,
        albumTitleIndex: data.albumTitleIndex,
        artistNameIndex: data.artistNameIndex,
        indices: data.dbAudioIndices.map((afi) => ({
          location: afi.getLocation(),
          hash: afi.getHash(),
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
  /*
   *
   * Begin 'constructor' code here
   *
   */

  // Get the list of existing paths to song-keys
  const maybeSongHash = await persist.getItemAsync('songHashIndex');
  if (maybeSongHash) {
    const songHash = Unpickle(maybeSongHash);
    if (Type.isMapOfStrings(songHash)) {
      existingKeys = songHash;
    }
  }
  if (!existingKeys) {
    existingKeys = new Map<string, SongKey>();
  }

  return {
    getSong: (key: SongKey) => data.dbSongs.get(key),
    getArtist: (key: ArtistKey) => data.dbArtists.get(key),
    getAlbum: (key: AlbumKey) => data.dbAlbums.get(key),
    addAudioFileIndex,
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
    load,
    save,
    refresh,
    searchIndex,
    updateMetadata,
  };
}
