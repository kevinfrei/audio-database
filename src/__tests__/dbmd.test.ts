/* 
export declare function getMediaInfo(mediaPath: string): Promise<Map<string, string>>;
export declare type MetadataStore = {
    get: (path: string) => MinimumMetadata | void;
    set: (path: string, md: MinimumMetadata) => void;
    fail: (path: string) => void;
    shouldTry: (path: string) => boolean;
    save: () => void;
    load: () => Promise<boolean>;
};
export declare function GetMetadataStore(persist: Persist, name: string): Promise<MetadataStore>;
*/

import { FullMetadata } from '@freik/media-core';
import { IsFullMetadata, IsOnlyMetadata } from '../DbMetadata';

it('Full/Partial Metadata tests', () => {
  const partial = { originalPath: '/a/file/path.mp3', track: 1 };
  const fullmd: FullMetadata = {
    originalPath: 'thePath.flac',
    artist: ['artist1', 'artist2'],
    album: 'album',
    // year?: number;
    track: 3,
    title: 'title',
    // vaType?: 'va' | 'ost';
    // moreArtists?: string[];
    // variations?: string[];
    // disk?: number;
  };
  expect(IsOnlyMetadata(partial)).toBe(true);
  expect(IsFullMetadata(partial)).toBe(false);
  expect(IsOnlyMetadata(fullmd)).toBe(true);
  expect(IsFullMetadata(fullmd)).toBe(true);
  const aFewMore = { vaType: 'va', ...fullmd };
  expect(IsOnlyMetadata(aFewMore)).toBe(true);
  expect(IsFullMetadata(aFewMore)).toBe(true);
  const extras = { notOK: false, ...aFewMore };
  expect(IsOnlyMetadata(extras)).toBe(false);
  expect(IsFullMetadata(extras)).toBe(false);
});
