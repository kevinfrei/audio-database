import { Type } from '@freik/core-utils';
import { ArrayIntersection } from '@freik/core-utils/lib/Operations';
import { Album, Artist } from '@freik/media-core';
import { MakePersistence } from '@freik/node-utils';
import { MakeAudioDatabase } from '../AudioDatabase';
import { MakeAudioFileIndex } from '../AudioFileIndex';
import { remove, removeDir } from './AudioFileIndex.test';

jest.useFakeTimers();

const persist = MakePersistence('./src/__tests__/persist-basic/');

async function cleanup() {
  remove('./src/__tests__/persist-basic/test.json');
  removeDir('./src/__tests__/NotActuallyFiles/.afi');
}

// Initialization if we need anything
beforeAll(cleanup);

afterAll(async () => {
  await cleanup();
  return new Promise((resolve) => {
    // eslint-disable-next-line no-restricted-globals
    setTimeout(cleanup, 100);
    // eslint-disable-next-line no-restricted-globals
    setTimeout(resolve, 200);
    jest.runAllTimers();
  });
});

it('Query a reasonably sized database', async () => {
  const db = await MakeAudioDatabase(persist);
  expect(db).toBeDefined();
  const afi = await MakeAudioFileIndex('./src/__tests__/NotActuallyFiles', 0);
  expect(afi).toBeDefined();
  await db.addAudioFileIndex(afi);
  await db.refresh();
  const flat = db.getFlatDatabase();

  // Some basic stupidity:
  expect(flat.songs.length).toEqual(735);
  expect(flat.albums.length).toEqual(188);
  expect(flat.artists.length).toEqual(271);

  // More basic stupidity:
  for (const song of flat.songs) {
    expect(db.getSong(song.key)).toEqual(song);
  }

  // Look for a particular album for picture checking
  let negot: Album | undefined = undefined;
  for (const album of flat.albums) {
    expect(db.getAlbum(album.key)).toEqual(album);
    const ttl = album.title.toLocaleLowerCase();
    if (ttl === "'71-'86 negotiations & love songs") {
      negot = album;
    }
  }
  expect(negot).toBeDefined();
  if (!negot) throw Error('bad news');
  const pic = await db.getAlbumPicture(negot.key);
  expect(pic).toBeDefined();
  expect(pic).toBeInstanceOf(Buffer);
  if (!pic) throw Error('Not Buffer');
  expect(pic.length).toEqual(19);

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
  let unsorted: Album | null = null;
  let axemas: Album | null = null;
  let various: Album[] = [];
  // Check for album back-pointers
  for (const album of flat.albums) {
    // Artist sanity checks
    if (album.vatype) {
      expect(album.primaryArtists.length).toEqual(0);
      // Let's check for a couple albums with multiple disks
      if (album.title === 'Unsorted' && unsorted === null) {
        unsorted = album;
      } else if (album.title === 'Merry Axemas' && axemas === null) {
        axemas = album;
      }
    } else {
      if (album.title === 'Various') {
        various.push(album);
      }
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
  expect(await db.refresh()).toBeTruthy();
  const newFlat = db.getFlatDatabase();
  expect(newFlat).toEqual(flat);
  // A bunch of diskName checks:
  expect(unsorted).toBeDefined();
  if (!unsorted) throw Error('nope');
  expect(unsorted.diskNames).toBeDefined();
  if (!unsorted.diskNames) throw Error('nope');
  expect(unsorted.diskNames.length).toEqual(2);
  expect(unsorted.diskNames[0]).toEqual('Some Stuff');
  expect(unsorted.diskNames[1]).toEqual('Other Stuff');
  expect(axemas).toBeDefined();
  if (!axemas) throw Error('nope');
  expect(axemas.diskNames).toBeDefined();
  if (!axemas.diskNames) throw Error('nope');
  expect(axemas.diskNames.length).toEqual(2);
  expect(axemas.diskNames).toEqual(['', '']);
  expect(various.length).toEqual(3);
  const va = various.filter((alb) => Type.isArrayOfString(alb.diskNames));
  expect(va.length).toEqual(1);
  const alb = va[0];
  expect(alb.diskNames).toBeDefined();
  if (!alb.diskNames) throw Error('nope');
  expect(alb.diskNames).toEqual(['', 'moar']);
  let disk0 = 0;
  let disk2 = 0;
  for (const sngKey of alb.songs) {
    const sng = db.getSong(sngKey);
    expect(sng).toBeDefined();
    if (!sng) throw Error('nope');
    // Only 0-99 or 200+, no 100's
    const disk = Math.floor(sng.track / 100);
    expect(disk).not.toEqual(1);
    if (disk === 0) disk0++;
    else if (disk === 2) disk2++;
    else expect(disk).toEqual(-1234);
  }
  expect(disk0).toEqual(9);
  expect(disk2).toEqual(7);
});

it('Rebuilding a DB after initial creation', async () => {
  const db = await MakeAudioDatabase(persist);
  expect(db).toBeDefined();
  expect(
    await db.addFileLocation('./src/__tests__/NotActuallyFiles'),
  ).toBeTruthy();
  expect(await db.refresh()).toBeTruthy();
  const flat = db.getFlatDatabase();
  expect(flat).toBeDefined();
  expect(flat.songs.length).toEqual(735);
  expect(await db.refresh()).toBeTruthy();
  const newFlat = db.getFlatDatabase();
  expect(newFlat.songs.length).toEqual(735);
  expect(
    await db.removeFileLocation('./src/__tests__/NotActuallyFiles'),
  ).toBeTruthy();
  const emptyFlat = db.getFlatDatabase();
  expect(emptyFlat).toEqual({ songs: [], albums: [], artists: [] });
  expect(
    await db.addFileLocation('./src/__tests__/NotActuallyFiles'),
  ).toBeTruthy();
  expect(await db.refresh()).toBeTruthy();
  const finalFlat = db.getFlatDatabase();
  expect(finalFlat).toBeDefined();
  expect(finalFlat.songs.length).toEqual(735);
});
