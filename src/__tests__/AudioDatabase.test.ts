import { ArrayIntersection } from '@freik/core-utils/lib/Operations';
import { Album, Artist } from '@freik/media-core';
import { MakePersistence } from '@freik/node-utils';
import fs from 'fs';
import { MakeAudioDatabase } from '../AudioDatabase';
import { MakeAudioFileIndex } from '../AudioFileIndex';
import { remove } from './AudioFileIndex.test';

const persist = MakePersistence('./src/__tests__/persist-basic/');
const {
  songPath,
  songPath2,
  flatDBWithJustOne,
  flatDBwithBoth,
  flatDBwithSecond,
} = JSON.parse(fs.readFileSync('./src/__tests__/data.json').toString()) as any;

// Initialization if we need anything
beforeAll(() => {
  return;
});

afterAll(async () => {
  // Clean-up after the test
  remove('./src/__tests__/persist-basic/test.json');
});

function swap<T>(items: T[]) {
  const a = items[0];
  items[0] = items[1];
  items[1] = a;
}

it('dummy test', async () => {
  const db = await MakeAudioDatabase(persist);
  expect(db).toBeDefined();
  const flat = db.getFlatDatabase();
  expect(flat).toEqual({ albums: [], artists: [], songs: [] });
  expect(true).toBeTruthy();
});

it('Querty a reasonably sized database', async () => {
  const db = await MakeAudioDatabase(persist);
  expect(db).toBeDefined();
  const afi = await MakeAudioFileIndex('./src/__tests__/NotActuallyFiles', 0);
  expect(afi).toBeDefined();
  await afi.rescanFiles();
  await db.addAudioFileIndex(afi);
  const flat = db.getFlatDatabase();
  // Some basic stupidity:
  expect(flat.songs.length).toEqual(735);
  expect(flat.albums.length).toEqual(187);
  expect(flat.artists.length).toEqual(271);
  // More basic stupidity:
  for (const song of flat.songs) {
    expect(db.getSong(song.key)).toEqual(song);
  }
  for (const album of flat.albums) {
    expect(db.getAlbum(album.key)).toEqual(album);
  }
  // let's find an artist, while we're at it
  let paulSimon: Artist | undefined = undefined;
  for (const artist of flat.artists) {
    expect(db.getArtist(artist.key)).toEqual(artist);
    if (artist.name.toLocaleLowerCase() === 'paul simon') {
      paulSimon = artist;
    }
  }
  expect(paulSimon).toBeDefined();
  expect(paulSimon!.albums.length).toEqual(3);
  expect(paulSimon!.songs.length).toEqual(5);

  // Now let's do some 'internal consistency' checking
  // Check for song back-pointers
  for (const song of flat.songs) {
    // We can get at the album
    const album: Album | void = db.getAlbum(song.albumId);
    expect(album).toBeDefined();
    if (!album) continue;
    // The album has this song
    expect(album.songs.indexOf(song.key)).toBeGreaterThan(-1);
    for (const artistKey of [...song.artistIds, ...song.secondaryIds]) {
      // We can get to each artist
      const artist = db.getArtist(artistKey);
      expect(artist).toBeDefined();
      if (!artist) continue;
      // The artist has this song, too
      expect(artist.songs.indexOf(song.key)).toBeGreaterThan(-1);
    }
  }
  // Check for album back-pointers
  for (const album of flat.albums) {
    // Artist sanity checks
    if (album.vatype) {
      expect(album.primaryArtists.length).toEqual(0);
    } else {
      for (const artistKey of album.primaryArtists) {
        const artist = db.getArtist(artistKey);
        expect(artist).toBeDefined();
        if (!artist) continue;
        // The artist has this album
        expect(artist.albums.indexOf(album.key)).toBeGreaterThan(-1);
      }
    }
    for (const songKey of album.songs) {
      const song = db.getSong(songKey);
      expect(song).toBeDefined();
      if (!song) continue;
      // The song is on this album
      expect(song.albumId).toEqual(album.key);
    }
  }
  // And finally, artist back-pointers
  for (const artist of flat.artists) {
    for (const songKey of artist.songs) {
      const song = db.getSong(songKey);
      expect(song).toBeDefined();
      if (!song) continue;
      const pri = song.artistIds.indexOf(artist.key);
      const alt = song.secondaryIds.indexOf(artist.key);
      // One of them should be negative
      expect(pri * alt).toBeLessThanOrEqual(0);
      // And one should be positive (or zero)
      expect(pri > alt || alt > pri).toBeTruthy();
    }
    for (const albumKey of artist.albums) {
      const album = db.getAlbum(albumKey);
      expect(album).toBeDefined();
      if (!album) continue;
      const idx = album.primaryArtists.indexOf(artist.key);
      if (idx < 0) {
        // If we didn't find this artist as a primary artist
        // Check to see if one of the songs has the artist
        const songsInCommon = ArrayIntersection(artist.songs, album.songs);
        expect(songsInCommon.size).toBeGreaterThan(0);
      }
    }
  }
});

/*
 it('Add individual file to the db', async () => {
  const db = await MakeAudioDatabase(persist);
  db.addSongFromPath(songPath);
  const flat = db.getFlatDatabase();
  expect(flat).toEqual(flatDBWithJustOne);
});

it('Delete file by path', async () => {
  const db = await MakeAudioDatabase(persist);
  db.addSongFromPath(songPath);
  expect(db.delSongByPath(songPath)).toEqual(true);
  const emptyFlat = db.getFlatDatabase();
  expect(emptyFlat).toEqual({ albums: [], artists: [], songs: [] });
});

it('Delete file by key', async () => {
  const db = await MakeAudioDatabase(persist);
  db.addSongFromPath(songPath);
  db.addSongFromPath(songPath2);
  const biggerFlat = db.getFlatDatabase();
  expect(biggerFlat).toEqual(flatDBwithBoth);
  db.delSongByKey('S1');
  const secondFlat = db.getFlatDatabase();
  expect(secondFlat).toEqual(flatDBwithSecond);
});

it('Re-adding a file', async () => {
  const db = await MakeAudioDatabase(persist);
  db.addSongFromPath(songPath);
  db.addSongFromPath(songPath2);
  db.delSongByKey('S1');
  db.addSongFromPath(songPath);
  const finalFlat = db.getFlatDatabase();
  // Mutate flatDBwithBoth for the new file order
  const newFlat = JSON.parse(JSON.stringify(flatDBwithBoth));
  swap(newFlat.songs);
  swap(newFlat.albums[0].songs);
  swap(newFlat.artists[0].songs);
  expect(finalFlat).toEqual(newFlat);
});

it('Save/Load consistency', async () => {
  const db = await MakeAudioDatabase(persist);
  db.addSongFromPath(songPath);
  db.addSongFromPath(songPath2);
  await db.save('test');
  db.addSongFromPath('/a - 1999 - b/2 - song.flac');
  const ld = await db.load('test');
  expect(ld).toBe(true);
  const loadedFlat = db.getFlatDatabase();
  expect(loadedFlat).toEqual(flatDBwithBoth);
});
*/
