# Tools

This Repo contains various utility scripts and tools required by yggdrasil web projects such as [Anime-Dimension](https://github.com/yggdrasil-au/Anime-Dimension) to function.

## Available Tools

| Tool                                                 | Package Name                     | Description                                                       |
|------------------------------------------------------|----------------------------------|-------------------------------------------------------------------|
| **[apache](TS/apache/)**                            | `@yggdrasil-au/apache-cli`       | Downloads, configures, and runs Apache with PHP runtime.          |
| **[build-core](TS/build-core/)**                    | `@yggdrasil-au/build-core`       | Shared build primitives for the monorepo.                         |
| **[caddy](TS/caddy/)**                              | `@yggdrasil-au/caddy`            | Downloads and runs Caddy with project-specific configuration.     |
| **[capacitor-assets](TS/capacitor-assets/)**        | `@yggdrasil-au/capacitor-assets` | Generates icon and splash screen images for Capacitor apps.       |
| **[deploy](TS/deploy/)**                            | `@yggdrasil-au/deploy`           | Deployment utility with SSH, SFTP, tar, relay, and symlinks.     |
| **[htm-minify](TS/htm-minify/)**                    | `@yggdrasil-au/htm-minify`       | Minifies HTML files.                                              |
| **[js-minify](TS/js-minify/)**                      | `@yggdrasil-au/js-minify`        | Minifies JavaScript files.                                        |
| **[php-handler](TS/php-handler/)**                  | `@yggdrasil-au/php-handler`      | Handles PHP in the Astro build process.                           |
| **[S3](TS/S3/)**                                    | `@yggdrasil-au/cloudflare-r2`    | Uploads files to Cloudflare R2.                                   |
| **[ts-builder](TS/ts-builder/)**                    | `@yggdrasil-au/ts-builder`       | Shared TypeScript builder script and configuration.               |
| **[web-image-converter](TS/web-image-converter/)**  | `@yggdrasil-au/ygg-webp`         | Converts images to WebP format.                                   |
| **[yaml-run](TS/yaml-run/)**                        | `@yggdrasil-au/yaml-run`         | Lightweight YAML-based task runner with workspace support.        |

## Usage

Most tools are designed to be used as CLI utilities or imported into pnpm projects. Refer to the individual tools for more specific usage.
