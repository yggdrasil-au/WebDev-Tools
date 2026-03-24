import fs from "node:fs";
import path from "node:path";

import chalk from "chalk";
import ora from "ora";

import type { SshClient } from "../utils/ssh.js";

export class DiffEngine {
    public constructor (
        private readonly ssh: SshClient,
        private readonly localRoot: string
    ) {
    }

    public async getChangedFilesAsync(remoteRoot: string): Promise<string[]> {
        const remoteFiles: Map<string, number> = new Map<string, number>();

        const spinner = ora("Calculating diffs...").start();

        const command: string = `[ -d "${remoteRoot}" ] && find "${remoteRoot}" -type f -printf '%P|%s\\n'`;
        const result = await this.ssh.exec(command);

        spinner.stop();

        if (result.code === 0 && result.stdout.trim().length > 0) {
            for (const line of result.stdout.split("\n").filter((entry) => entry.trim().length > 0)) {
                const parts: string[] = line.split("|");
                if (parts.length < 2) {
                    continue;
                }

                const size: number = Number.parseInt(parts[1], 10);
                if (Number.isNaN(size)) {
                    continue;
                }

                remoteFiles.set(parts[0].replace(/\\/g, "/"), size);
            }
        }

        const allLocalFiles: string[] = this.getAllFiles(this.localRoot);
        const changedFiles: string[] = [];

        for (const filePath of allLocalFiles) {
            const relativePath: string = path.relative(this.localRoot, filePath).replace(/\\/g, "/");
            const localSize: number = fs.statSync(filePath).size;

            if (!remoteFiles.has(relativePath) || remoteFiles.get(relativePath) !== localSize) {
                changedFiles.push(filePath);
            }
        }

        console.log(chalk.gray(`Remote: ${remoteFiles.size}, Local: ${allLocalFiles.length}, Changed: ${changedFiles.length}`));
        return changedFiles;
    }

    /* :: :: Private Helpers :: START :: */

    private getAllFiles(
        directoryPath: string,
        files: string[] = []
    ): string[] {
        const entries: string[] = fs.readdirSync(directoryPath);

        for (const entry of entries) {
            const fullPath: string = path.join(directoryPath, entry);
            const stat = fs.statSync(fullPath);

            if (stat.isDirectory()) {
                this.getAllFiles(fullPath, files);
            } else {
                files.push(fullPath);
            }
        }

        return files;
    }

    /* :: :: Private Helpers :: END :: */
}
