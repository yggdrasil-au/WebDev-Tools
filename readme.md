# Tools

This Repo contains various utility scripts and tools required by yggdrasil web projects such as [Anime-Dimension](https://github.com/yggdrasil-au/Anime-Dimension) to function.

## Available Tools

| Tool                                            | Package Name                     | Description                                              |
|-------------------------------------------------|----------------------------------|----------------------------------------------------------|
| **[build-core](build-core/)**                   | `@yggdrasil-au/build-core`       | Shared build primitives for core www projects.           |
| **[capacitor-assets](capacitor-assets/)**       | `@yggdrasil-au/capacitor-assets` | Generates icons and splash screens for PWAs.             |
| **[Deploy](Deploy/)**                           | `@yggdrasil-au/deploy`           | SFTP/SSH deployment utility.                             |
| **[htm-minify](htm-minify/)**                   | `@yggdrasil-au/htm-minify`       | Minifies HTML files.                                     |
| **[js-minify](js-minify/)**                     | `@yggdrasil-au/js-minify`        | Minifies JavaScript files.                               |
| **[php-handler](php-handler/)**                 | `@yggdrasil-au/php-handler`      | Handles PHP in astro build process.                      |
| **[ts-builder](ts-builder/)**                   | `@yggdrasil-au/ts-builder`       | Shared TypeScript builder configuration and script.      |
| **[web-image-converter](web-image-converter/)** | `@yggdrasil-au/ygg-webp`         | Tool for converting images to WebP format.               |
| **[WLAP-CLI](WLAP-Server-CLI/)**                | `lampctl-cli`                    | Development xampp web server management CLI.             |

## Usage

Most tools are designed to be used as CLI utilities or imported into pnpm projects. Refer to the individual tools for more specific usage.

the WLAP cli tool is a independent submodule, more information can be found in the [WLAP-Server-CLI repo](https://github.com/yggdrasil-au/xampp-cli).
