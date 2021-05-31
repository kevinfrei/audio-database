import { Song } from '@freik/media-core';
export * from './AudioDatabase';
export { GetMediaInfo, IsFullMetadata, IsOnlyMetadata } from './DbMetadata';

export type VAType = '' | 'ost' | 'va';
export type SongWithPath = Song & { path: string };
