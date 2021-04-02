import { Song } from '@freik/media-core';
export * from './AudioDatabase';
export * from './AudioFileIndex';
// export { MusicSearch, SearchResults } from "./MusicSearch";

export type VAType = '' | 'ost' | 'va';
export type SongWithPath = Song & { path: string };
