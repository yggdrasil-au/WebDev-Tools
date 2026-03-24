import path from "node:path";

import chalk from "chalk";
import cliProgress from "cli-progress";
import type { SFTPWrapper } from "ssh2";

import type { DeploymentProfile } from "../config.js";
import type { SshClient } from "../utils/ssh.js";
import { sftpCreateRecursive, sftpFastPut } from "../utils/sftp.js";

export class SftpDeployment {
    public constructor (
        private readonly config: DeploymentProfile,
        private readonly localRoot: string
    ) {
        void this.config;
    }

    public async uploadAsync(
        ssh: SshClient,
        sftp: SFTPWrapper,
        files: string[],
        remoteRoot: string
    ): Promise<void> {
        void ssh;

        const normalizedRemoteRoot: string = remoteRoot.replace(/\\/g, "/").replace(/\/$/, "");
        console.log(chalk.cyan(`Uploading ${files.length} files via SFTP...`));

        const directoriesToCreate: string[] = [...new Set(
            files
                .map((filePath) => {
                    const relativeDir: string = path.dirname(path.relative(this.localRoot, filePath)).replace(/\\/g, "/");
                    return relativeDir === "." ? "" : relativeDir;
                })
                .filter((entry) => entry.length > 0)
        )].sort((left, right) => left.length - right.length);

        if (directoriesToCreate.length > 0) {
            console.log(chalk.gray(`Ensuring ${directoriesToCreate.length} remote directories exist...`));
            for (const directory of directoriesToCreate) {
                await sftpCreateRecursive(sftp, `${normalizedRemoteRoot}/${directory}`);
            }
        }

        const progress = new cliProgress.SingleBar(
            {
                format: `${chalk.green("Uploading")} [{bar}] {percentage}% | ETA: {eta}s | {value}/{total}`,
            },
            cliProgress.Presets.shades_classic
        );

        progress.start(files.length, 0);

        for (const filePath of files) {
            const relativePath: string = path.relative(this.localRoot, filePath).replace(/\\/g, "/");
            const remotePath: string = `${normalizedRemoteRoot}/${relativePath.replace(/^\//, "")}`;

            await sftpFastPut(sftp, filePath, remotePath);
            progress.increment();
        }

        progress.stop();
    }
}
