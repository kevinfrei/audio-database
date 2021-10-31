import { Type } from '@freik/core-utils';
import { promises as fsp } from 'node:fs';
import rmfr from 'rmfr';

export async function remove(name: string) {
  try {
    await fsp.rm(name);
  } catch (e) {}
}

export async function removeDir(name: string) {
  try {
    await rmfr(name);
  } catch (e) {
    if (!Type.hasStr(e, 'code') || e.code !== 'ENOENT') {
      console.error(e);
    }
  }
}
