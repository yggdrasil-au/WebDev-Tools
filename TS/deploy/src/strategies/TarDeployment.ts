import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import chalk from "chalk";
import cliProgress from "cli-progress";
import type { ConnectConfig, SFTPWrapper } from "ssh2";
import * as tar from "tar";

import type { DeploymentMode, DeploymentProfile } from "../config.js";
import type { SshClient } from "../utils/ssh.js";
import { sftpCreateRecursive, sftpFastPut } from "../utils/sftp.js";
import { SshClient as SshClientImpl } from "../utils/ssh.js";

interface TarBatch {
    files: string[];
    size: number;
}

export class TarDeployment {
    public constructor (
        private readonly config: DeploymentProfile,
        private readonly localPath: string,
        private readonly mode: DeploymentMode
    ) {
    }

    public async uploadAsync(
        ssh: SshClient,
        sftp: SFTPWrapper,
        files: string[],
        remoteRoot: string
    ): Promise<void> {
        if (this.mode === "file") {
            await this.uploadSingleFileAsync(sftp, files, remoteRoot);
            return;
        }

        void ssh;
        void sftp;

        const batches: TarBatch[] = this.createBatches(files);
        const totalSize: number = batches.reduce((sum, batch) => sum + batch.size, 0);

        console.log(chalk.cyan(`Found ${files.length} files (${(totalSize / 1024 / 1024).toFixed(2)} MB).`));
        console.log(chalk.cyan(`Split into ${batches.length} batches (Limit: ${this.config.batchSizeMB ?? 50}MB).`));
        console.log(chalk.cyan(`Concurrency: ${this.config.concurrency ?? 1}`));

        const multiBar = new cliProgress.MultiBar(
            {
                clearOnComplete: false,
                hideCursor: true,
                format: "{label} [{bar}] {percentage}% | {value}/{total}",
            },
            cliProgress.Presets.shades_classic
        );

        const mainBar = multiBar.create(batches.length, 0, { label: chalk.green("Overall Progress") });

        const queue: Array<Promise<void>> = [];
        const concurrency: number = this.config.concurrency ?? 1;

        for (let index = 0; index < batches.length; index += 1) {
            const task: Promise<void> = this.processBatchAsync(
                batches[index],
                index,
                remoteRoot,
                multiBar
            ).finally(() => {
                mainBar.increment();
            });

            queue.push(task);

            if (queue.length >= concurrency) {
                await Promise.race(queue.map(async (running) => {
                    await running;
                    const itemIndex: number = queue.indexOf(running);
                    if (itemIndex >= 0) {
                        queue.splice(itemIndex, 1);
                    }
                }));
            }
        }

        await Promise.all(queue);
        multiBar.stop();
    }

    /* :: :: Private Helpers :: START :: */

    private async processBatchAsync(
        batch: TarBatch,
        index: number,
        remoteRoot: string,
        multiBar: cliProgress.MultiBar
    ): Promise<void> {
        const tempTarPath: string = path.join(os.tmpdir(), `deploy-${Date.now()}-${index}.tar.gz`);
        const batchLabel: string = `Batch ${index + 1}`;

        const batchBar = multiBar.create(100, 0, { label: chalk.yellow(`${batchLabel}: Starting...`) });

        const connectionInfo: ConnectConfig = this.createConnectionInfo();
        const client = new SshClientImpl(connectionInfo);

        try {
            batchBar.update(0, { label: chalk.yellow(`${batchLabel}: Connecting...`) });
            await client.connect();
            const sftp = await client.connectSftp();

            batchBar.update(10, { label: chalk.yellow(`${batchLabel}: Compressing...`) });
            const relativeFiles: string[] = batch.files.map((filePath) => path.relative(this.localPath, filePath).replace(/\\/g, "/"));
            await tar.create({ gzip: true, file: tempTarPath, cwd: this.localPath }, relativeFiles);
            batchBar.update(40);

            const remoteTarPath: string = `${remoteRoot}/deploy-batch-${index}-${Date.now()}.tar.gz`;
            const archiveSize: number = fs.statSync(tempTarPath).size;

            batchBar.update(40, { label: chalk.blue(`${batchLabel}: Uploading (${Math.round(archiveSize / 1024)} KB)...`) });
            await sftpFastPut(sftp, tempTarPath, remoteTarPath, (transferred) => {
                const ratio: number = transferred / archiveSize;
                batchBar.update(Math.round(40 + (ratio * 50)));
            });

            batchBar.update(90, { label: chalk.magenta(`${batchLabel}: Extracting...`) });
            const extractResult = await client.exec(`tar -xzf "${remoteTarPath}" -C "${remoteRoot}" && rm "${remoteTarPath}"`);
            if (extractResult.code !== 0) {
                throw new Error(`Extraction failed: ${extractResult.stderr || extractResult.stdout}`);
            }

            batchBar.update(100, { label: chalk.green(`${batchLabel}: Done`) });
        } catch (error) {
            batchBar.update(100, { label: chalk.red(`${batchLabel}: Failed`) });
            throw error;
        } finally {
            if (fs.existsSync(tempTarPath)) {
                fs.unlinkSync(tempTarPath);
            }
            client.disconnect();
        }
    }

    private createBatches(files: string[]): TarBatch[] {
        const limitBytes: number = (this.config.batchSizeMB ?? 50) * 1024 * 1024;

        const batches: TarBatch[] = [];
        let currentBatch: string[] = [];
        let currentSize: number = 0;

        for (const filePath of files) {
            const size: number = fs.statSync(filePath).size;

            if (currentBatch.length > 0 && currentSize + size > limitBytes) {
                batches.push({
                    files: currentBatch,
                    size: currentSize,
                });

                currentBatch = [];
                currentSize = 0;
            }

            currentBatch.push(filePath);
            currentSize += size;
        }

        if (currentBatch.length > 0) {
            batches.push({
                files: currentBatch,
                size: currentSize,
            });
        }

        return batches;
    }

    private createConnectionInfo(): ConnectConfig {
        const info: ConnectConfig = {
            host: this.config.host,
            port: this.config.port ?? 22,
            username: this.config.username,
            readyTimeout: 14_400_000,
            keepaliveInterval: 60_000,
            keepaliveCountMax: 10,
        };

        if (this.config.privateKeyPath && fs.existsSync(this.config.privateKeyPath)) {
            info.privateKey = fs.readFileSync(this.config.privateKeyPath);
            if (this.config.passphrase) {
                info.passphrase = this.config.passphrase;
            }
        } else if (this.config.password) {
            info.password = this.config.password;
        }

        return info;
    }

    private async uploadSingleFileAsync(
        sftp: SFTPWrapper,
        files: string[],
        remoteFilePath: string
    ): Promise<void> {
        if (files.length !== 1) {
            throw new Error(`File mode expected exactly 1 file, got ${files.length}`);
        }

        const normalizedRemoteFilePath: string = remoteFilePath.replace(/\\/g, "/").replace(/\/$/, "");
        const remoteDirectoryPath: string = path.posix.dirname(normalizedRemoteFilePath);

        if (remoteDirectoryPath && remoteDirectoryPath !== "." && remoteDirectoryPath !== "/") {
            await sftpCreateRecursive(sftp, remoteDirectoryPath);
        }

        console.log(chalk.cyan("Tar transfer selected in file mode. Falling back to direct single-file SFTP upload."));
        await sftpFastPut(sftp, files[0], normalizedRemoteFilePath);
    }

    /* :: :: Private Helpers :: END :: */
}
