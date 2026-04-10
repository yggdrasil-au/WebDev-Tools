import path from 'node:path';

export const CWD = Deno.cwd();
export const CONFIG_FILES = {
    vars: path.join(CWD, 'vars.yaml'),
    scripts: path.join(CWD, 'scripts.yaml')
};
