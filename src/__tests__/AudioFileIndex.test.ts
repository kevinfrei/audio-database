/*
type AudioFileIndex = {
  getHash: () => number;
  getLocation: () => string;
  forEachAudioFile: (fn: PathHandler) => void;
  forEachImageFile: (fn: PathHandler) => void;
  getLastScanTime: () => Date | null;
  // When we rescan files, look at file path diffs
  rescanFiles: (
    addAudio: PathHandler,
    delAudio: PathHandler,
    addImage: PathHandler,
    delImage: PathHandler,
  ) => Promise<void>;
};
*/

import { MakeAudioFileIndex } from '../AudioFileIndex';

it('Create the index', async () => {
  const afi = await MakeAudioFileIndex('./src/__tests__/fileIndex', 0x1badcafe);
  expect(afi).toBeDefined();
});
