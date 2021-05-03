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

import { Type } from '@freik/core-utils';
import { FullMetadata } from '@freik/media-core';
import { promises as fsp } from 'fs';
import { getMediaInfo, IsFullMetadata, IsOnlyMetadata } from '../DbMetadata';

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

it('Generic getMediaInfo tests', async () => {
  const data = await fsp.readFile('src/__tests__/dbmdData.json');
  const dataParse = JSON.parse(data.toString());

  const flacMap = new Map<string, string>(dataParse['flac']);
  const flacFile =
    'src/__tests__/metadata/Album - 2005 - Artist/01 - quiet.flac';
  const miFlac = await getMediaInfo(flacFile);
  expect(Type.isMap(miFlac)).toBeTruthy();
  expect(miFlac).toEqual(flacMap);

  const m4aMap = new Map<string, string>(dataParse['m4a']);
  const m4aFile =
    'src/__tests__/metadata/Album - 2005 - Artist/02 - quiet2.m4a';
  const mim4a = await getMediaInfo(m4aFile);
  expect(Type.isMap(mim4a)).toBeTruthy();
  expect(mim4a).toEqual(m4aMap);

  const mp3Map = new Map<string, string>(dataParse['mp3']);
  const mp3File =
    'src/__tests__/metadata/Album - 2005 - Artist/03 - Quiet3.mp3';
  const mimp3 = await getMediaInfo(mp3File);
  expect(Type.isMap(mimp3)).toBeTruthy();
  expect(mimp3).toEqual(mp3Map);

  /*  const flacMap = new Map<string, string>(dataParse);
  const flacFile =
    'src/__tests__/metadata/Album - 2005 - Artist/01 - quiet.flac';
  const miFlac = await getMediaInfo(flacFile);
  expect(Type.isMap(miFlac)).toBeTruthy();
  expect(miFlac).toEqual(flacMap);

  const flacMap = new Map<string, string>(dataParse);
  const flacFile =
    'src/__tests__/metadata/Album - 2005 - Artist/01 - quiet.flac';
  const miFlac = await getMediaInfo(flacFile);
  expect(Type.isMap(miFlac)).toBeTruthy();
  expect(miFlac).toEqual(flacMap);*/
});
