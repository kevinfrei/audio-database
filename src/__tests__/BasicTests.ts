import { MakeAudioDatabase } from '../AudioDatabase';

it('Make an empty Audio Database', async () => {
  const db = await MakeAudioDatabase('./');
  expect(db).toBeDefined();
  const flat = db.getFlatDatabase();
  expect(flat).toEqual({ albums: [], artists: [], songs: [] });
});
