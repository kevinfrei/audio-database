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
it('BlobStore test', async () => {
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
});

it('Restore a BlobStore test', async () => {
  const blobs = await MakeBlobStore(
    (k: string) => k,
    'src/__tests__/blob-test',
  );
  expect(blobs).toBeDefined();
  const buf = Buffer.from(aString);
  const newBuf = await blobs.get('theKey');
  expect(newBuf).toBeDefined();
  expect(buf.toString()).toEqual((newBuf as Buffer).toString());
});
