import { Song } from '@freik/media-core';
export * from './AudioFileIndex';
export * from './AudioDatabase';
// export { MusicSearch, SearchResults } from "./MusicSearch";

export type VAType = '' | 'ost' | 'va';
export type SongWithPath = Song & { path: string };
