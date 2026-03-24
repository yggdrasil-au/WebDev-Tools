# @yggdrasil-au/cloudflare-r2

Upload files to Cloudflare R2 (S3-compatible).

This package supports both:
- importing from other Node scripts, and
- running as a CLI via the `cloudflare-r2` bin.

## Library usage

```js
import { uploadToR2 } from '@yggdrasil-au/cloudflare-r2';

await uploadToR2({
    filePath: './local/logo.png',
    destinationKey: 'assets/logo.png',

    // Option A: provide config directly
    config: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        endpoint: process.env.R2_ENDPOINT,
        bucket: process.env.R2_BUCKET,
        region: 'auto',
    },
});
```

### SQLite-config usage

If you use your existing SQLite config DB (table `r2_config`), you can load config automatically:

```js
import { uploadToR2 } from '@yggdrasil-au/cloudflare-r2';

await uploadToR2({
    filePath: './local/data.json',
    destinationKey: 'data/data.json',

    // Option B: load config from SQLite
    rootPath: 'a:/WebDev/Sites/Anime-Dimension/main',
    // or explicitly:
    // configDbPath: 'a:/.../config.sqlite3',
    // sqlWasmPath: 'a:/.../sql-wasm.wasm',
});
```

## CLI usage

```sh
cloudflare-r2 --help

cloudflare-r2 --file ./logo.png --key assets/logo.png --root a:/WebDev/Sites/Anime-Dimension/main

cloudflare-r2 --file ./data.json --key data/data.json \
  --configDb a:/path/config.sqlite3 \
  --sqlWasm a:/path/sql-wasm.wasm

cloudflare-r2 --file ./logo.png --key assets/logo.png \
  --accessKeyId "..." --secretAccessKey "..." --endpoint "..." --bucket "..." --region auto
```

## Files

- Main implementation: `cloudflare-R2.mjs`
- CLI wrapper (bin target): `cloudflare-r2.mjs`
- Public exports: `index.js`
