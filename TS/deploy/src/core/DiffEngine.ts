import fs from "node:fs";
import path from "node:path";

import chalk from "chalk";
import ora from "ora";

import type { DeploymentMode } from "../config.js";
import type { SshClient } from "../utils/ssh.js";

export class DiffEngine {
    public constructor (
        private readonly ssh: SshClient,
        private readonly localPath: string,
        private readonly mode: DeploymentMode
    ) {
    }

    public async getChangedFilesAsync(remotePath: string): Promise<string[]> {
        if (this.mode === "file") {
            return await this.getChangedFileAsync(remotePath);
        }

        return await this.getChangedDirectoryFilesAsync(remotePath);
    }

    /* :: :: Private Helpers :: START :: */

    private async getChangedDirectoryFilesAsync(remoteRoot: string): Promise<string[]> {
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

        const allLocalFiles: string[] = this.getAllFiles(this.localPath);
        const changedFiles: string[] = [];

        for (const filePath of allLocalFiles) {
            const relativePath: string = path.relative(this.localPath, filePath).replace(/\\/g, "/");
            const localSize: number = fs.statSync(filePath).size;

            if (!remoteFiles.has(relativePath) || remoteFiles.get(relativePath) !== localSize) {
                changedFiles.push(filePath);
            }
        }

        console.log(chalk.gray(`Remote: ${remoteFiles.size}, Local: ${allLocalFiles.length}, Changed: ${changedFiles.length}`));
        return changedFiles;
    }

    private async getChangedFileAsync(remoteFilePath: string): Promise<string[]> {
        const spinner = ora("Calculating diffs...").start();

        try {
            const localSize: number = fs.statSync(this.localPath).size;
            const escapedRemotePath: string = this.escapeForBashDoubleQuotes(remoteFilePath);
            const command: string =
                `if [ -f "${escapedRemotePath}" ]; then ` +
                `stat -c %s "${escapedRemotePath}" 2>/dev/null || wc -c < "${escapedRemotePath}"; ` +
                "else echo __MISSING__; fi";

            const result = await this.ssh.exec(command);
            const remoteSizeText: string = result.stdout.trim();

            if (remoteSizeText === "__MISSING__") {
                console.log(chalk.gray("Remote file is missing. Uploading local file."));
                return [this.localPath];
            }

            const remoteSize: number = Number.parseInt(remoteSizeText, 10);
            if (Number.isNaN(remoteSize)) {
                throw new Error(`Unable to determine remote file size for '${remoteFilePath}'`);
            }

            if (remoteSize !== localSize) {
                console.log(chalk.gray(`Remote: ${remoteSize} bytes, Local: ${localSize} bytes, Changed: 1`));
                return [this.localPath];
            }

            console.log(chalk.gray(`Remote: ${remoteSize} bytes, Local: ${localSize} bytes, Changed: 0`));
            return [];
        } finally {
            spinner.stop();
        }
    }

    private escapeForBashDoubleQuotes(value: string): string {
        return value
            .replace(/\\/g, "\\\\")
            .replace(/\"/g, "\\\"")
            .replace(/\$/g, "\\$")
            .replace(/`/g, "\\`");
    }

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
