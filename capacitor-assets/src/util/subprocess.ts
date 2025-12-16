import { Subprocess, SubprocessError } from '@ionic/utils-subprocess';

import c from '../colors';

export async function runCommand(command: string, args: string[], options = {}): Promise<void> {
  console.log(c.strong(`> ${command} ${args.join(' ')}`));

  const p = new Subprocess(command, args, options);

  try {
    // return await p.output();
    return await p.run();
  } catch (e) {
    if (e instanceof SubprocessError) {
      // old behavior of just throwing the stdout/stderr strings
      const msg = ((): string => {
        if (typeof e.output === 'string' && e.output.length > 0) {
          return e.output;
        }
        if (typeof e.code !== 'undefined') {
          return String(e.code);
        }
        // fall back to message if present
        if (e.message) {
          return e.message;
        }
        return 'Unknown error';
      })();
      throw msg;
    }

    throw e;
  }
}
