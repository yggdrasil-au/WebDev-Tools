import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import chalk from "chalk";
import ora from "ora";
import type { ConnectConfig } from "ssh2";
import * as tar from "tar";

import type { DeploymentProfile } from "../config.js";
import { SshClient } from "../utils/ssh.js";
import { sftpFastPut } from "../utils/sftp.js";

export class RelayDeployment {
    public constructor (
        private readonly config: DeploymentProfile,
        private readonly localRoot: string
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

        const tempLocalTarPath: string = path.join(os.tmpdir(), `relay-${Date.now()}.tar.gz`);
        const compressSpinner = ora("Compressing files...").start();

        const relativeFiles: string[] = files.map((filePath) => path.relative(this.localRoot, filePath).replace(/\\/g, "/"));
        await tar.create({ gzip: true, file: tempLocalTarPath, cwd: this.localRoot }, relativeFiles);

        compressSpinner.stop();

        const timestamp: number = Date.now();
        const tarName: string = `deploy-${timestamp}.tar.gz`;
        const keyName: string = `deploy-key-${timestamp}.pem`;
        const relayTempDirectory: string = "/tmp";

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

            const archiveSize: number = fs.statSync(tempLocalTarPath).size;
            console.log(chalk.green(`Uploading bundle to relay (${Math.round(archiveSize / 1024)} KB)...`));

            await sftpFastPut(relaySftp, tempLocalTarPath, `${relayTempDirectory}/${tarName}`);

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

            const scpCommand: string = `scp -o StrictHostKeyChecking=no -i ${relayTempDirectory}/${keyName} ${relayTempDirectory}/${tarName} ${targetUser}@${targetHost}:/tmp/${tarName}`;
            await this.runRelayCommand(relayClient, scpCommand, "Relaying bundle to target");

            const extractCommand: string = `ssh -o StrictHostKeyChecking=no -i ${relayTempDirectory}/${keyName} ${targetUser}@${targetHost} \"mkdir -p ${remoteRoot} && tar -xzf /tmp/${tarName} -C ${remoteRoot} && rm /tmp/${tarName}\"`;
            await this.runRelayCommand(relayClient, extractCommand, "Extracting on target");

            console.log(chalk.green("Relay deployment complete."));
        } finally {
            console.log(chalk.gray("Cleaning up relay..."));
            try {
                await relayClient.exec(`rm -f ${relayTempDirectory}/${tarName} ${relayTempDirectory}/${keyName}`);
            } catch {
                // Ignore cleanup failures to preserve original deployment result.
            }

            relayClient.disconnect();

            if (fs.existsSync(tempLocalTarPath)) {
                fs.unlinkSync(tempLocalTarPath);
            }
        }
    }

    /* :: :: Private Helpers :: START :: */

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
