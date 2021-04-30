/* 
import { FullMetadata } from '@freik/media-core';
import { Persist } from '@freik/node-utils';
export declare type MinimumMetadata = {
    originalPath: string;
} & Partial<FullMetadata>;

export declare function getMediaInfo(mediaPath: string): Promise<Map<string, string>>;
export declare type MetadataStore = {
    get: (path: string) => MinimumMetadata | void;
    set: (path: string, md: MinimumMetadata) => void;
    fail: (path: string) => void;
    shouldTry: (path: string) => boolean;
    save: () => void;
    load: () => Promise<boolean>;
};
export declare function IsOnlyMetadata(obj: unknown): obj is MinimumMetadata;
export declare function IsFullMetadata(obj: unknown): obj is FullMetadata;
export declare function GetMetadataStore(persist: Persist, name: string): Promise<MetadataStore>;
*/

import { IsOnlyMetadata } from '../DbMetadata';

it('DbMetadata tests', () => {
  expect(IsOnlyMetadata({ originalPath: '/a/file/path.mp3', track: 1 })).toBe(
    true,
  );
});
