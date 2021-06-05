import { ToB64 } from '@freik/core-utils';
import { promises as fsp } from 'fs';
import path from 'path';
import { MakeAudioFileIndex } from '../AudioFileIndex';

export async function remove(name: string) {
  try {
    await fsp.rm(name);
  } catch (e) {}
}

export async function removeDir(name: string) {
  try {
    await fsp.rm(name, { recursive: true });
  } catch (e) {}
}

async function cleanup() {
  await removeDir('src/__tests__/audiofileindex/.afi');
}

beforeAll(cleanup);
afterAll(cleanup);
let songKey = '';

it('Some basic AudioFileIndex tests', async () => {
  const beforeCreation = new Date();
  const afi = await MakeAudioFileIndex(
    'src/__tests__/audiofileindex',
    0x1badcafe,
  );
  const scanTime = afi.getLastScanTime();
  const afterCreation = new Date();
  expect(afi).toBeDefined();
  expect(scanTime).toBeTruthy();
  const actualTime = scanTime ? scanTime : new Date();
  expect(actualTime.getTime()).toBeGreaterThanOrEqual(beforeCreation.getTime());
  expect(actualTime.getTime()).toBeLessThanOrEqual(afterCreation.getTime());
  let count = 0;
  afi.forEachAudioFileSync((pn) => {
    count++;
  });
  expect(count).toEqual(6);
  expect(afi.getHashForIndex()).toEqual(ToB64(0x1badcafe));
  expect(afi.getLocation()).toEqual(
    path.resolve('src/__tests__/audiofileindex') + '/',
  );
  const songPathName =
    "Test Artist - 2010 - Test Album/01 - This isn't actually an mp3.mp3";
  const fullPath = path.join(afi.getLocation(), songPathName);
  const theKey = afi.makeSongKey(fullPath);
  expect(theKey).toMatch(/^S[+/a-z0-9A-Z]+:[+/a-z0-9A-Z]+$/);
  songKey = theKey;
  const md = await afi.getMetadataForSong(fullPath);
  expect(md).toEqual({
    album: 'Test Album',
    artist: 'Test Artist',
    title: "This isn't actually an mp3",
    track: 1,
    year: 2010,
    originalPath: fullPath,
  });
  afi.updateMetadata({
    title: 'This is an empty mp3 file',
    originalPath: fullPath,
    track: 3,
  });
  const newMd = await afi.getMetadataForSong(fullPath);
  expect(newMd).toEqual({
    album: 'Test Album',
    artist: 'Test Artist',
    title: 'This is an empty mp3 file',
    track: 3,
    year: 2010,
    originalPath: fullPath,
  });
  afi.destroy();
});

it('Follow up tests', async () => {
  const afi = await MakeAudioFileIndex(
    'src/__tests__/audiofileindex',
    0x1badcafe,
  );
  const songPathName =
    "Test Artist - 2010 - Test Album/01 - This isn't actually an mp3.mp3";
  const fullPath = path.join(afi.getLocation(), songPathName);
  const theKey = afi.makeSongKey(fullPath);
  expect(theKey).toEqual(songKey);
  const md = await afi.getMetadataForSong(fullPath);
  // Make sure that our metadata changes from the previous test sticks
  expect(md).toEqual({
    album: 'Test Album',
    artist: 'Test Artist',
    title: 'This is an empty mp3 file',
    track: 3,
    year: 2010,
    originalPath: fullPath,
  });
  await afi.rescanFiles();
  const newMd = await afi.getMetadataForSong(fullPath);
  // Make sure that our metadata changes from the previous test sticks
  expect(newMd).toEqual({
    album: 'Test Album',
    artist: 'Test Artist',
    title: 'This is an empty mp3 file',
    track: 3,
    year: 2010,
    originalPath: fullPath,
  });
  afi.destroy();
});
