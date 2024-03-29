import { Type } from '@freik/core-utils';
import { promises as fsp } from 'node:fs';
import rmfr from 'rmfr';

/* istanbul ignore next */
export async function remove(name: string) {
  try {
    await fsp.rm(name);
  } catch (e) {}
}

/* istanbul ignore next */
export async function removeDir(name: string) {
  try {
    await rmfr(name);
  } catch (e) {
    if (!Type.hasStr(e, 'code') || e.code !== 'ENOENT') {
      console.error(e);
    }
  }
}
