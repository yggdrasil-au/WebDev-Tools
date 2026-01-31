import path from 'node:path';

export const CWD = process.cwd();
export const CONFIG_FILES = {
    vars: path.join(CWD, 'vars.yaml'),
    scripts: path.join(CWD, 'scripts.yaml')
};
