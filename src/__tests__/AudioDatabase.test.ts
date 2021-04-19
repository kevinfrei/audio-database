import { MakePersistence } from '@freik/node-utils';
import fs from 'fs';
import { MakeAudioDatabase } from '../AudioDatabase';
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

it('Make a flat Audio Database', async () => {
  const db = await MakeAudioDatabase(persist);
  expect(db).toBeDefined();
  const flat = db.getFlatDatabase();
  expect(flat).toEqual({ albums: [], artists: [], songs: [] });
});

/* it('Add individual file to the db', async () => {
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
