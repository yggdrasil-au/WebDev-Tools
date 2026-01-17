import path from 'node:path';

export const normalizeRemote = (p) => String(p).replace(/\\+/g, '/').replace(/\/+$/, '');
export const joinRemote = (...p) => path.posix.join(...p.map(x => String(x).replace(/\\+/g, '/')));
export const remoteBaseName = (p) => path.posix.basename(normalizeRemote(p));
export const remoteDirName = (p) => path.posix.dirname(normalizeRemote(p));
