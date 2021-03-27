import {
  Album,
  AlbumKey,
  Artist,
  ArtistKey,
  FullMetadata,
  Song,
  SongKey,
} from "@freik/media-core";
export { AudioFileIndex, MakeAudioFileIndex } from "./AudioFileIndex";
export { MusicSearch, SearchResults } from "./MusicSearch";

export type VAType = "" | "ost" | "va";

export type ServerSong = Song & { path: string };

export type AudioDatabase = {
  // General stuff
  addAudioFileIndex: (idx: AudioFileIndex) => Promise<void>;
  getPicture: (key: AlbumKey) => string;
  setPicture: (key: AlbumKey, filepath: string) => void;
  addSongFromPath: (filepath: string) => void;
  addOrUpdateSong: (md: FullMetadata) => void;
  delSongFromPath: (filepath: string) => boolean;
  delSongFromKey: (key: SongKey) => boolean;
  // Update the renderer
  sendUpdate: () => void;
  // Loading/saving
  load: () => Promise<boolean>;
  save: () => Promise<void>;
  // Updating
  refresh: () => Promise<void>;
  // API
  getSong: (key: SongKey) => ServerSong | void;
  getAlbum: (key: AlbumKey) => Album | void;
  getArtist: (key: ArtistKey) => Artist | void;
  searchIndex: (substring: boolean, term: string) => SearchResults;
};
