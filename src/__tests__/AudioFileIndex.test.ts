import { promises as fsp } from 'fs';
import path from 'path';
import { MakeAudioFileIndex } from '../AudioFileIndex';

/*
export type AudioFileIndex = {
  getHash(): number;
  getLocation(): string;
  getSongKey(songPath: string): SongKey;

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
*/

async function cleanup() {
  try {
    await fsp.rm('src/__tests__/audiofileindex/.emp/fileIndex.txt');
  } catch (e) {}
}

beforeAll(cleanup);
afterAll(cleanup);

it('Some basic AudioFileIndex tests', async () => {
  const afi = await MakeAudioFileIndex(
    'src/__tests__/audiofileindex',
    0x1badcafe,
  );
  expect(afi).toBeDefined();
  let count = 0;
  afi.forEachAudioFileSync((pn) => {
    count++;
  });

  expect(count).toEqual(6);
  expect(afi.getHash()).toEqual(0x1badcafe);
  expect(afi.getLocation()).toEqual(
    path.resolve('src/__tests__/audiofileindex') + '/',
  );
  const songPathName =
    "Test Artist - 2010 - Test Album/01 - This isn't actually an mp3.mp3";
  const fullPath = path.join(afi.getLocation(), songPathName);
  const theKey = afi.makeSongKey(fullPath);
  expect(theKey).toMatch(/^S[^a-z0-9A-Z]+:[^a-z0-9A-Z]+$/);
  const md = await afi.getMetadataForSong(fullPath);
  expect(md).toEqual({
    album: 'Test Album',
    artist: 'Test Artist',
    title: "This isn't actually an mp3",
    track: 1,
    year: 2010,
    originalPath: fullPath,
  });
});
