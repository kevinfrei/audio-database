import { MakeSearchable } from '../Search';

test('Make a simple search thing', () => {
  const srch = MakeSearchable(['ab', 'cd', 'abcd'], (arg) => arg);
  expect(srch).toBeDefined();
  const results = new Set(srch('cd', true));
  expect(results.has('cd')).toBeTruthy();
  expect(results.has('abcd')).toBeTruthy();
  expect(results.size).toEqual(2);
  const results2 = new Set(srch('ab'));
  expect(results2.has('ab')).toBeTruthy();
  expect(results2.size).toEqual(1);
});
