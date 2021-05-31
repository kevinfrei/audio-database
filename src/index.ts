import { Song } from '@freik/media-core';
export * from './AudioDatabase';
export {
  GetMediaInfo,
  IsFullMetadata,
  IsOnlyMetadata,
  MinimumMetadata,
} from './DbMetadata';
export { SearchResults } from './MusicSearch';

export type VAType = '' | 'ost' | 'va';
export type SongWithPath = Song & { path: string };
