import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import chalk from "chalk";
import ora from "ora";
import type { ConnectConfig } from "ssh2";
import * as tar from "tar";

import type { DeploymentMode, DeploymentProfile } from "../config.js";
import { SshClient } from "../utils/ssh.js";
import { sftpFastPut } from "../utils/sftp.js";

export class RelayDeployment {
    public constructor (
        private readonly config: DeploymentProfile,
        private readonly localPath: string,
        private readonly mode: DeploymentMode
    ) {
    }

    public async uploadAsync(
        files: string[],
        remoteRoot: string
    ): Promise<void> {
        if (!this.config.relayHost) {
            throw new Error("RelayHost is required for 'relay' transfer mode.");
        }

        const relayUser: string | undefined = this.config.relayUsername ?? this.config.username;
        const relayKeyPath: string | undefined = this.config.relayPrivateKeyPath ?? this.config.privateKeyPath;
        const relayPort: number = this.config.relayPort ?? 22;

        console.log(chalk.magenta(`Preparing Relay Transfer via ${this.config.relayHost}...`));

        const timestamp: number = Date.now();
        const relayTempDirectory: string = "/tmp";
        const localPayloadPath: string = this.mode === "file"
            ? this.getSingleFilePath(files)
            : path.join(os.tmpdir(), `relay-${timestamp}.tar.gz`);
        const relayPayloadName: string = this.mode === "file"
            ? `deploy-file-${timestamp}-${path.basename(localPayloadPath)}`
            : `deploy-${timestamp}.tar.gz`;
        const keyName: string = `deploy-key-${timestamp}.pem`;

        if (this.mode === "directory") {
            const compressSpinner = ora("Compressing files...").start();
            try {
                const relativeFiles: string[] = files.map((filePath) => path.relative(this.localPath, filePath).replace(/\\/g, "/"));
                await tar.create({ gzip: true, file: localPayloadPath, cwd: this.localPath }, relativeFiles);
            } finally {
                compressSpinner.stop();
            }
        }

        const relayConnectionInfo: ConnectConfig = this.createConnectionInfo(
            this.config.relayHost,
            relayPort,
            relayUser,
            relayKeyPath
        );

        const relayClient = new SshClient(relayConnectionInfo);

        try {
            console.log(chalk.gray(`Connecting to Relay (${this.config.relayHost})...`));
            await relayClient.connect();
            const relaySftp = await relayClient.connectSftp();

            const archiveSize: number = fs.statSync(localPayloadPath).size;
            console.log(chalk.green(`Uploading bundle to relay (${Math.round(archiveSize / 1024)} KB)...`));

            await sftpFastPut(relaySftp, localPayloadPath, `${relayTempDirectory}/${relayPayloadName}`);

            if (this.config.privateKeyPath && fs.existsSync(this.config.privateKeyPath)) {
                console.log(chalk.gray("Uploading ephemeral key..."));
                await sftpFastPut(relaySftp, this.config.privateKeyPath, `${relayTempDirectory}/${keyName}`);
                await relayClient.exec(`chmod 600 ${relayTempDirectory}/${keyName}`);
            }

            console.log(chalk.yellow("Executing relay jump..."));

            const targetHost: string | undefined = this.config.host;
            const targetUser: string | undefined = this.config.username;

            if (!targetHost || !targetUser) {
                throw new Error("Target host and username are required for relay transfer.");
            }

            if (this.mode === "file") {
                const remoteFilePath: string = remoteRoot.replace(/\\/g, "/").replace(/\/$/, "");
                const remoteDirectoryPath: string = path.posix.dirname(remoteFilePath);
                const escapedRemoteDirectoryPath: string = this.escapeForBashDoubleQuotes(remoteDirectoryPath);
                const escapedRemoteFilePath: string = this.escapeForBashDoubleQuotes(remoteFilePath);

                const ensureDirectoryCommand: string =
                    `ssh -o StrictHostKeyChecking=no -i ${relayTempDirectory}/${keyName} ${targetUser}@${targetHost} ` +
                    `\"mkdir -p \\\"${escapedRemoteDirectoryPath}\\\"\"`;
                await this.runRelayCommand(relayClient, ensureDirectoryCommand, "Preparing target directory");

                const copyFileCommand: string =
                    `scp -o StrictHostKeyChecking=no -i ${relayTempDirectory}/${keyName} ` +
                    `${relayTempDirectory}/${relayPayloadName} ${targetUser}@${targetHost}:\"${escapedRemoteFilePath}\"`;
                await this.runRelayCommand(relayClient, copyFileCommand, "Relaying file to target");
            } else {
                const scpCommand: string = `scp -o StrictHostKeyChecking=no -i ${relayTempDirectory}/${keyName} ${relayTempDirectory}/${relayPayloadName} ${targetUser}@${targetHost}:/tmp/${relayPayloadName}`;
                await this.runRelayCommand(relayClient, scpCommand, "Relaying bundle to target");

                const escapedRemoteDirectoryPath: string = this.escapeForBashDoubleQuotes(remoteRoot);
                const extractCommand: string =
                    `ssh -o StrictHostKeyChecking=no -i ${relayTempDirectory}/${keyName} ${targetUser}@${targetHost} ` +
                    `\"mkdir -p \\\"${escapedRemoteDirectoryPath}\\\" && tar -xzf /tmp/${relayPayloadName} -C \\\"${escapedRemoteDirectoryPath}\\\" && rm /tmp/${relayPayloadName}\"`;
                await this.runRelayCommand(relayClient, extractCommand, "Extracting on target");
            }

            console.log(chalk.green("Relay deployment complete."));
        } finally {
            console.log(chalk.gray("Cleaning up relay..."));
            try {
                await relayClient.exec(`rm -f ${relayTempDirectory}/${relayPayloadName} ${relayTempDirectory}/${keyName}`);
            } catch {
                // Ignore cleanup failures to preserve original deployment result.
            }

            relayClient.disconnect();

            if (this.mode === "directory" && fs.existsSync(localPayloadPath)) {
                fs.unlinkSync(localPayloadPath);
            }
        }
    }

    /* :: :: Private Helpers :: START :: */

    private getSingleFilePath(files: string[]): string {
        if (files.length !== 1) {
            throw new Error(`File mode expected exactly 1 file, got ${files.length}`);
        }

        return files[0];
    }

    private escapeForBashDoubleQuotes(value: string): string {
        return value
            .replace(/\\/g, "\\\\")
            .replace(/\"/g, "\\\"")
            .replace(/\$/g, "\\$")
            .replace(/`/g, "\\`");
    }

    private async runRelayCommand(
        client: SshClient,
        command: string,
        description: string
    ): Promise<void> {
        console.log(chalk.gray(`> ${description}`));
        const result = await client.exec(command);

        if (result.code !== 0) {
            throw new Error(`Relay command failed: ${result.stderr}\nOutput: ${result.stdout}`);
        }
    }

    private createConnectionInfo(
        host?: string,
        port?: number,
        username?: string,
        keyPath?: string
    ): ConnectConfig {
        if (!host || !username) {
            throw new Error("Relay host and username are required.");
        }

        const info: ConnectConfig = {
            host,
            port: port ?? 22,
            username,
            readyTimeout: 14_400_000,
            keepaliveInterval: 60_000,
            keepaliveCountMax: 10,
        };

        if (keyPath && fs.existsSync(keyPath)) {
            info.privateKey = fs.readFileSync(keyPath);
            if (this.config.passphrase) {
                info.passphrase = this.config.passphrase;
            }
        } else if (this.config.password) {
            info.password = this.config.password;
        }

        return info;
    }

    /* :: :: Private Helpers :: END :: */
}
