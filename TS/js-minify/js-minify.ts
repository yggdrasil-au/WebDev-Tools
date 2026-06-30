#!/usr/bin/env deno

import { exists, existsSync } from "@std/fs";
import { basename, dirname, join } from "@std/path";
import fg from "fast-glob";
import { minify } from "terser";

async function minifyOne(file: string, noSourcemap: boolean, deleteSource: boolean): Promise<void> {
    const mapPath = `${file}.map`;
    const outFile = file.replace(/\.js$/i, ".min.js");
    const outMapName = basename(file).replace(/\.js$/i, ".min.js.map");

    // Ensure output directory exists (mirrors input structure)
    await Deno.mkdir(dirname(outFile), { recursive: true });

    const code = await Deno.readTextFile(file);
    const prevMap = await exists(mapPath) ? await Deno.readTextFile(mapPath) : undefined;

    const minifyOptions: any = {
        compress: { passes: 2 },
        mangle: true,
        format: { comments: /^!/ },
    };

    if (!noSourcemap) {
        minifyOptions.sourceMap = {
            content: prevMap,
            filename: basename(outFile),
            url: outMapName,
        };
    }

    const result = await minify(code, minifyOptions);

    if (!result || typeof result.code !== "string") {
        throw new Error(`Terser failed to produce output for ${file}`);
    }

    await Deno.writeTextFile(outFile, result.code);
    if (!noSourcemap && result.map) {
        await Deno.writeTextFile(`${outFile}.map`, typeof result.map === "string" ? result.map : JSON.stringify(result.map));
    }
    console.log(`Minified: ${file} -> ${outFile}`);

    if (deleteSource) {
        try {
            await Deno.remove(file);
            if (existsSync(mapPath)) {
                await Deno.remove(mapPath);
            }
            console.log(`Deleted source: ${file}`);
        } catch (err) {
            console.error(`Failed to delete source: ${file}`, err);
        }
    }
}

async function run(): Promise<void> {
    const args = Deno.args;
    const inputDirs: string[] = [];
    let noSourcemap = false;
    let deleteSource = false;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--inputDir") {
            if (i + 1 < args.length) {
                inputDirs.push(args[i + 1]);
                i++;
            }
        } else if (args[i] === "--no-sourcemap" || args[i] === "--no-source-map") {
            noSourcemap = true;
        } else if (args[i] === "--delete-source") {
            deleteSource = true;
        }
    }

    if (inputDirs.length === 0) {
        console.error("Error: No input directories specified. Usage: js-minify --inputDir <path> [--inputDir <path> ...] [--no-sourcemap] [--delete-source]");
        Deno.exit(1);
    }

    console.log(`Searching for files in: ${inputDirs.join(", ")}`);
    console.log(`Options: Source Maps: ${!noSourcemap}, Delete Source: ${deleteSource}`);

    const patterns = inputDirs.flatMap(dir => {
        const cleanDir = dir.replace(/\\/g, "/").replace(/\/$/, "");
        return [`${cleanDir}/**/*.js`, `!${cleanDir}/**/*.min.js`];
    });

    const files = await fg(patterns);
    for (const file of files) {
        await minifyOne(file, noSourcemap, deleteSource);
    }
}

try {
    await run();
} catch (error) {
    console.error(error);
    Deno.exitCode = 1;
}