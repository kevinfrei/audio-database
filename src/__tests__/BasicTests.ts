import { MakePersistence } from '@freik/node-utils';
import { MakeAudioDatabase } from '../AudioDatabase';

const persist = MakePersistence('./src/__tests__/persist-basic/');

it('Make an empty Audio Database', async () => {
  const db = await MakeAudioDatabase(persist);
  expect(db).toBeDefined();
  const flat = db.getFlatDatabase();
  expect(flat).toEqual({ albums: [], artists: [], songs: [] });
});

function swap<T>(items: T[]) {
  const a = items[0];
  items[0] = items[1];
  items[1] = a;
}

it('Add some individual files to the db', async () => {
  const songPath = '/The Artist - 2000 - The Album/01 - A Song.mp3';
  const songPath2 = '/The Artist - 2000 - The Album/02 - Another Song.mp3';
  const flatDBWithJustOne = {
    songs: [
      {
        key: 'S1',
        path: songPath,
        secondaryIds: [],
        title: 'A Song',
        track: 1,
        variations: undefined,
        albumId: 'L0',
        artistIds: ['R0'],
      },
    ],
    albums: [
      {
        key: 'L0',
        title: 'The Album',
        vatype: '',
        year: 2000,
        primaryArtists: ['R0'],
        songs: ['S1'],
      },
    ],
    artists: [
      {
        key: 'R0',
        name: 'The Artist',
        albums: ['L0'],
        songs: ['S1'],
      },
    ],
  };
  const flatDBwithBoth = {
    songs: [
      {
        key: 'S1',
        path: songPath,
        secondaryIds: [],
        title: 'A Song',
        track: 1,
        variations: undefined,
        albumId: 'L1',
        artistIds: ['R1'],
      },
      {
        key: 'S2',
        path: songPath2,
        secondaryIds: [],
        title: 'Another Song',
        track: 2,
        variations: undefined,
        albumId: 'L1',
        artistIds: ['R1'],
      },
    ],
    albums: [
      {
        key: 'L1',
        title: 'The Album',
        vatype: '',
        year: 2000,
        primaryArtists: ['R1'],
        songs: ['S1', 'S2'],
      },
    ],
    artists: [
      {
        key: 'R1',
        name: 'The Artist',
        albums: ['L1'],
        songs: ['S1', 'S2'],
      },
    ],
  };
  const flatDBwithSecond = {
    songs: [
      {
        key: 'S2',
        path: songPath2,
        secondaryIds: [],
        title: 'Another Song',
        track: 2,
        variations: undefined,
        albumId: 'L1',
        artistIds: ['R1'],
      },
    ],
    albums: [
      {
        key: 'L1',
        title: 'The Album',
        vatype: '',
        year: 2000,
        primaryArtists: ['R1'],
        songs: ['S2'],
      },
    ],
    artists: [
      {
        key: 'R1',
        name: 'The Artist',
        albums: ['L1'],
        songs: ['S2'],
      },
    ],
  };
  const db = await MakeAudioDatabase(persist);
  expect(db).toBeDefined();
  db.addSongFromPath(songPath);
  const flat = db.getFlatDatabase();
  expect(flat).toEqual(flatDBWithJustOne);
  expect(db.delSongByPath(songPath)).toEqual(true);
  const emptyFlat = db.getFlatDatabase();
  expect(emptyFlat).toEqual({ albums: [], artists: [], songs: [] });
  db.addSongFromPath(songPath);
  db.addSongFromPath(songPath2);
  const biggerFlat = db.getFlatDatabase();
  expect(biggerFlat).toEqual(flatDBwithBoth);
  db.delSongByKey('S1');
  const secondFlat = db.getFlatDatabase();
  expect(secondFlat).toEqual(flatDBwithSecond);
  db.addSongFromPath(songPath);
  const finalFlat = db.getFlatDatabase();
  // Just mutate the flatDBwithBoth for the new file order, since it doesn't
  // actually matter
  swap(flatDBwithBoth.songs);
  swap(flatDBwithBoth.albums[0].songs);
  swap(flatDBwithBoth.artists[0].songs);
  expect(finalFlat).toEqual(flatDBwithBoth);
});
