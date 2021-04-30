import { Sleep } from '@freik/core-utils';
import { promises as fsp } from 'fs';
import path from 'path';
import { MakeBlobStore } from '../BlobStore';

beforeAll(async () => {
  await fsp.mkdir(path.resolve('src/__tests__/blob-test'));
});

afterAll(async () => {
  await fsp.rm(path.resolve('src/__tests__/blob-test'), { recursive: true });
});

const aString = 'asdflakjsdflaksdjf';

test('BlobStore test', async () => {
  const blobs = await MakeBlobStore(
    (key: string) => key,
    'src/__tests__/blob-test',
  );
  expect(blobs).toBeDefined();
  const buf = Buffer.from(aString);
  await blobs.put(buf, 'theKey');
  const newBuf = await blobs.get('theKey');
  expect(newBuf).toBeDefined();
  expect(buf.toString()).toEqual((newBuf as Buffer).toString());
  // This basically forces a flush
  await Sleep(1000);
});

test('Restore a BlobStore test', async () => {
  const blobs = await MakeBlobStore(
    (k: string) => k,
    'src/__tests__/blob-test',
  );
  expect(blobs).toBeDefined();
  const buf = Buffer.from(aString);
  const newBuf = await blobs.get('theKey');
  expect(newBuf).toBeDefined();
  expect(buf.toString()).toEqual((newBuf as Buffer).toString());
  const buf2 = Buffer.from('abcd');
  await blobs.put(buf2, 'anotherKey');
  const newBuf2 = await blobs.get('anotherKey');
  const oldBuf2 = await blobs.get('theKey');
  expect(newBuf2).toBeDefined();
  expect(oldBuf2).toBeDefined();
  if (!newBuf2 || !oldBuf2) throw new Error('badness');
  expect(newBuf2.toString() === oldBuf2.toString()).toBeFalsy();
  await blobs.putMany(buf2, ['ab', 'bc', 'de', 'ef']);
  const ab = await blobs.get('ab');
  const bc = await blobs.get('bc');
  const de = await blobs.get('de');
  expect(ab).toBeDefined();
  expect(bc).toBeDefined();
  expect(de).toBeDefined();
  if (!ab || !bc || !de) throw new Error('More badness');
  expect(ab.toString()).toEqual(bc.toString());
  expect(bc.toString()).toEqual(de.toString());
  await blobs.delete('ab');
  expect(await blobs.get('ab')).toBeUndefined();
  expect(await blobs.get('bc')).toBeDefined();
  await blobs.delete(['bc', 'de']);
  expect(await blobs.get('de')).toBeUndefined();
});

test('Restore, then clear', async () => {
  const blobs = await MakeBlobStore(
    (k: string) => k,
    'src/__tests__/blob-test',
  );
  await blobs.clear();
  await Sleep(2000);
  const files = await fsp.readdir(path.resolve('src/__tests__/blob-test'));
  console.log(files);
  expect(files.length).toEqual(1);
});
