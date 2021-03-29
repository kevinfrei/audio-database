import { MakeAudioDatabase } from '../AudioDatabase';

it('Make an empty Audio Database', async () => {
  const db = await MakeAudioDatabase('./');
  expect(db).toBeDefined();
  const flat = db.getFlatDatabase();
  expect(flat).toEqual({ albums: [], artists: [], songs: [] });
});

it('Add some individual files to the db', async () => {
  const songPath = '/The Artist - 2000 - The Album/01 - A Song.mp3';
  const db = await MakeAudioDatabase('./');
  expect(db).toBeDefined();
  db.addSongFromPath(songPath);
  const flat = db.getFlatDatabase();
  expect(flat).toEqual({
    songs: [
      {
        key: 'S0',
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
        songs: ['S0'],
      },
    ],
    artists: [
      {
        key: 'R0',
        name: 'The Artist',
        albums: ['L0'],
        songs: ['S0'],
      },
    ],
  });
  expect(db.delSongByPath(songPath)).toEqual(true);
  const emptyFlat = db.getFlatDatabase();
  expect(emptyFlat).toEqual({ albums: [], artists: [], songs: [] });
});
