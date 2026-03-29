import fs from "node:fs";
import path from "node:path";

import chalk from "chalk";
import Enquirer from "enquirer";
import ora from "ora";
import type { ConnectConfig, SFTPWrapper } from "ssh2";

import { resolveDeploymentTarget, type DeploymentTarget, type DeploymentProfile } from "../config.js";
import { DiffEngine } from "./DiffEngine.js";
import { RelayDeployment } from "../strategies/RelayDeployment.js";
import { SftpDeployment } from "../strategies/SftpDeployment.js";
import { TarDeployment } from "../strategies/TarDeployment.js";
import { SshClient, type SshExecResult } from "../utils/ssh.js";
import {
    sftpCreateRecursive,
    sftpMkdir,
    sftpReadDir,
    sftpRename,
    sftpStat,
    sftpUnlink,
} from "../utils/sftp.js";

interface SelectPrompt {
    run(): Promise<string>;
}

export class Deployer {
    public constructor (
        private readonly config: DeploymentProfile
    ) {
    }

    public async runAsync(): Promise<void> {
        const deploymentTarget: DeploymentTarget = this.getDeploymentTargetOrThrow();
        const connectionInfo: ConnectConfig = this.createConnectionInfo();
        const client = new SshClient(connectionInfo);

        const spinner = ora(`Connecting to ${this.config.host}...`).start();

        try {
            await client.connect();
            const sftp = await client.connectSftp();
            spinner.succeed("Connected.");

            await this.validateSftpAccess(sftp, deploymentTarget);

            if (this.config.archiveExisting === true && this.config.strategy !== "symlink") {
                if (deploymentTarget.mode === "file") {
                    await this.archiveExistingFile(sftp, deploymentTarget.remotePath);
                } else {
                    await this.archiveExistingContent(client, sftp, deploymentTarget.remotePath);
                }
            }

            if (this.config.preCommands && this.config.preCommands.length > 0) {
                console.log(chalk.yellow("Executing pre-commands..."));
                for (const command of this.config.preCommands) {
                    await this.runCommand(client, command);
                }
            }

            if (this.config.strategy === "symlink") {
                if (deploymentTarget.mode === "file") {
                    await this.runSymlinkFileStrategy(client, sftp, deploymentTarget);
                } else {
                    await this.runSymlinkDirectoryStrategy(client, sftp, deploymentTarget);
                }
            } else {
                await this.uploadContent(client, sftp, deploymentTarget.remotePath, deploymentTarget);
            }

            if (this.config.postCommands && this.config.postCommands.length > 0) {
                console.log(chalk.yellow("Executing post-commands..."));
                for (const command of this.config.postCommands) {
                    await this.runCommand(client, command);
                }
            }

            console.log(chalk.green.bold("Deployment Success!"));
        } finally {
            spinner.stop();
            client.disconnect();
        }
    }

    /* :: :: Archive :: START :: */

    private async archiveExistingContent(
        ssh: SshClient,
        sftp: SFTPWrapper,
        remoteDirectoryPath: string
    ): Promise<void> {
        const remoteDir: string = remoteDirectoryPath.replace(/\/$/, "");
        if (!remoteDir) {
            return;
        }

        let archiveDir: string = (this.config.archiveDir ?? "").replace(/\/$/, "");
        if (!archiveDir) {
            archiveDir = `${remoteDir}/../archive`;
        }

        const remoteExists: boolean = await sftpStat(sftp, remoteDir);
        if (!remoteExists) {
            console.log(chalk.gray("Remote directory does not exist, skipping archive."));
            return;
        }

        const items = await sftpReadDir(sftp, remoteDir);
        const itemCountBefore: number = items.length;

        if (itemCountBefore === 0) {
            console.log(chalk.gray("Remote directory is empty, skipping archive."));
            return;
        }

        const timestamp: string = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
        const targetArchive: string = `${archiveDir}/${timestamp}`;

        await sftpCreateRecursive(sftp, archiveDir);

        let sshShellEnabled: boolean = false;

        try {
            const environmentResult = await ssh.exec("env");
            sshShellEnabled = !environmentResult.stdout.includes("not enabled");
        } catch {
            sshShellEnabled = false;
        }

        if (sshShellEnabled) {
            await this.archiveExistingContentSsh(ssh, targetArchive, remoteDir, itemCountBefore);
        } else {
            const prompt: SelectPrompt = new (Enquirer as unknown as { Select: new (options: object) => SelectPrompt }).Select({
                name: "choice",
                message: chalk.yellow("SSH shell is disabled. Choose archive method:"),
                choices: ["SFTP (Per-file move)", "Skip Archive"],
            });

            const choice: string = await prompt.run();
            if (choice === "SFTP (Per-file move)") {
                await this.archiveExistingContentSftp(sftp, items, targetArchive, itemCountBefore, remoteDir);
            } else {
                console.log(chalk.yellow("Skipping archive..."));
                return;
            }
        }

        const remoteDirExistsAfter: boolean = await sftpStat(sftp, remoteDir);
        if (!remoteDirExistsAfter) {
            await sftpMkdir(sftp, remoteDir);
        }
    }

    private async archiveExistingFile(
        sftp: SFTPWrapper,
        remoteFilePath: string
    ): Promise<void> {
        const normalizedRemoteFilePath: string = remoteFilePath.replace(/\\/g, "/").replace(/\/$/, "");
        const remoteFileExists: boolean = await sftpStat(sftp, normalizedRemoteFilePath);

        if (!remoteFileExists) {
            console.log(chalk.gray("Remote file does not exist, skipping archive."));
            return;
        }

        const timestamp: string = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
        let archiveTargetPath: string;

        if (this.config.archiveDir) {
            const normalizedArchiveDirectoryPath: string = this.config.archiveDir.replace(/\\/g, "/").replace(/\/$/, "");
            await sftpCreateRecursive(sftp, normalizedArchiveDirectoryPath);
            archiveTargetPath = `${normalizedArchiveDirectoryPath}/${path.posix.basename(normalizedRemoteFilePath)}.${timestamp}`;
        } else {
            archiveTargetPath = `${normalizedRemoteFilePath}.${timestamp}`;
            console.log(chalk.yellow("archiveExisting fallback active: archiveDir was not set, so the current remote file will be renamed to '<remoteFile>.<timestamp>'."));
        }

        await sftpRename(sftp, normalizedRemoteFilePath, archiveTargetPath);
        console.log(chalk.green(`Archived remote file to ${archiveTargetPath}`));
    }

    private async archiveExistingContentSsh(
        ssh: SshClient,
        targetArchive: string,
        remoteDir: string,
        itemCountBefore: number
    ): Promise<void> {
        console.log(chalk.yellow(`Archiving ${itemCountBefore} items to ${targetArchive} via SSH (fast move)...`));

        await this.runCommand(ssh, `mkdir -p \"${targetArchive}\" && mv \"${remoteDir}\"/* \"${targetArchive}/\" 2>/dev/null`);

        const verifyResult: SshExecResult = await ssh.exec(`ls -A \"${targetArchive}\" | wc -l`);
        const countAfterMove: number = Number.parseInt(verifyResult.stdout.trim(), 10);

        if (Number.isNaN(countAfterMove) || countAfterMove === 0) {
            throw new Error(`Archive verification failed: ${targetArchive} appears empty after move. Source items before move: ${itemCountBefore}`);
        }

        console.log(chalk.green(`Successfully archived ${countAfterMove} items (verified via SSH).`));
    }

    private async archiveExistingContentSftp(
        sftp: SFTPWrapper,
        items: Array<{ filename: string }>,
        targetArchive: string,
        itemCountBefore: number,
        remoteDir: string
    ): Promise<void> {
        console.log(chalk.yellow(`Archiving ${itemCountBefore} items to ${targetArchive} via SFTP (slower move)...`));

        await sftpMkdir(sftp, targetArchive);

        const spinner = ora("Moving files via SFTP...").start();
        let current: number = 0;

        for (const item of items) {
            current += 1;
            spinner.text = `Moving ${item.filename} (${current}/${itemCountBefore})...`;
            await sftpRename(sftp, `${remoteDir}/${item.filename}`, `${targetArchive}/${item.filename}`);
        }

        spinner.stop();
        console.log(chalk.green(`Successfully archived ${itemCountBefore} items via SFTP.`));
    }

    /* :: :: Archive :: END :: */

    // //

    /* :: :: Strategies :: START :: */

    private async runSymlinkDirectoryStrategy(
        ssh: SshClient,
        sftp: SFTPWrapper,
        deploymentTarget: DeploymentTarget
    ): Promise<void> {
        const remoteDir: string = deploymentTarget.remotePath.replace(/\/$/, "");
        if (!remoteDir) {
            throw new Error("RemoteDir is required for symlink strategy.");
        }

        const timestamp: string = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
        const parentIndex: number = remoteDir.lastIndexOf("/");
        const parentPath: string = parentIndex > 0 ? remoteDir.slice(0, parentIndex) : remoteDir;

        const releasesRoot: string = this.config.releasesDir ?? `${parentPath}/releases`;
        const targetDir: string = `${releasesRoot}/${timestamp}`;

        await this.runCommand(ssh, `mkdir -p \"${targetDir}\"`);
        await this.uploadContent(ssh, sftp, targetDir, deploymentTarget);

        if (this.config.preserveFiles && this.config.preserveFiles.length > 0) {
            await this.preserveFilesFromPreviousRelease(ssh, remoteDir, targetDir);
        }

        console.log(chalk.cyan("Updating symlink..."));
        await this.runCommand(ssh, `ln -sfn \"${targetDir}\" \"${remoteDir}\"`);
    }

    private async runSymlinkFileStrategy(
        ssh: SshClient,
        sftp: SFTPWrapper,
        deploymentTarget: DeploymentTarget
    ): Promise<void> {
        const remoteFilePath: string = deploymentTarget.remotePath.replace(/\\/g, "/").replace(/\/$/, "");
        const fileName: string = path.posix.basename(remoteFilePath);
        const remoteParentPath: string = path.posix.dirname(remoteFilePath);
        const releasesRoot: string = this.config.releasesDir ?? `${remoteParentPath}/releases-${fileName}`;
        const timestamp: string = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);

        const targetReleaseDirectoryPath: string = `${releasesRoot}/${timestamp}`;
        const targetReleaseFilePath: string = `${targetReleaseDirectoryPath}/${fileName}`;

        await this.runCommand(ssh, `mkdir -p \"${this.escapeForBashDoubleQuotes(targetReleaseDirectoryPath)}\"`);
        await this.uploadContent(ssh, sftp, targetReleaseFilePath, deploymentTarget);

        console.log(chalk.cyan("Updating symlink..."));
        await this.runCommand(
            ssh,
            `ln -sfn \"${this.escapeForBashDoubleQuotes(targetReleaseFilePath)}\" \"${this.escapeForBashDoubleQuotes(remoteFilePath)}\"`
        );

        if (this.config.keepReleases && this.config.keepReleases > 0) {
            await this.cleanupOldReleases(ssh, releasesRoot, this.config.keepReleases);
        }
    }

    private async uploadContent(
        ssh: SshClient,
        sftp: SFTPWrapper,
        targetPath: string,
        deploymentTarget: DeploymentTarget
    ): Promise<void> {
        const diffEngine = new DiffEngine(ssh, deploymentTarget.localPath, deploymentTarget.mode);
        const changedFiles: string[] = await diffEngine.getChangedFilesAsync(targetPath);

        if (changedFiles.length === 0) {
            console.log(chalk.green("No changes detected."));
            return;
        }

        const transfer: string = this.config.transfer ?? "sftp";

        if (transfer === "relay") {
            const strategy = new RelayDeployment(this.config, deploymentTarget.localPath, deploymentTarget.mode);
            await strategy.uploadAsync(changedFiles, targetPath);
            return;
        }

        if (transfer === "tar") {
            const strategy = new TarDeployment(this.config, deploymentTarget.localPath, deploymentTarget.mode);
            await strategy.uploadAsync(ssh, sftp, changedFiles, targetPath);
            return;
        }

        const strategy = new SftpDeployment(this.config, deploymentTarget.localPath, deploymentTarget.mode);
        await strategy.uploadAsync(ssh, sftp, changedFiles, targetPath);
    }

    private async cleanupOldReleases(
        ssh: SshClient,
        releasesRoot: string,
        keepReleases: number
    ): Promise<void> {
        const escapedReleasesRoot: string = this.escapeForBashDoubleQuotes(releasesRoot.replace(/\\/g, "/").replace(/\/$/, ""));
        const cleanupCommand: string =
            `if [ -d \"${escapedReleasesRoot}\" ]; then ` +
            `ls -1dt \"${escapedReleasesRoot}\"/* 2>/dev/null | tail -n +${keepReleases + 1} | xargs -r rm -rf --; ` +
            "fi";

        await this.runCommand(ssh, cleanupCommand);
    }

    /* :: :: Strategies :: END :: */

    // //

    /* :: :: Commands and Validation :: START :: */

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

    private async runCommand(
        client: SshClient,
        command: string
    ): Promise<void> {
        while (true) {
            console.log(chalk.gray(`> ${command}`));
            const result: SshExecResult = await client.exec(command);

            if (result.code === 0) {
                return;
            }

            console.log(chalk.red(`Command failed (Exit ${result.code})`));

            if (result.stderr) {
                console.log(chalk.red(`Error: ${result.stderr}`));
            }

            if (result.stdout) {
                console.log(chalk.gray(`Output: ${result.stdout}`));
            }

            const prompt: SelectPrompt = new (Enquirer as unknown as { Select: new (options: object) => SelectPrompt }).Select({
                name: "choice",
                message: "How do you want to proceed?",
                choices: ["Retry", "Skip", "Quit"],
            });

            const choice: string = await prompt.run();

            if (choice === "Skip") {
                console.log(chalk.yellow("Skipping..."));
                return;
            }

            if (choice === "Quit") {
                throw new Error(`Command failed (Exit ${result.code}): ${result.stderr}`);
            }

            console.log(chalk.yellow("Retrying..."));
        }
    }

    private async preserveFilesFromPreviousRelease(
        ssh: SshClient,
        remoteDir: string,
        targetDir: string
    ): Promise<void> {
        const preserveFiles: string[] = this.normalizeAndValidatePreserveFiles(this.config.preserveFiles ?? []);

        if (preserveFiles.length === 0) {
            return;
        }

        const escapedRemoteDir: string = this.escapeForBashDoubleQuotes(remoteDir);
        const escapedTargetDir: string = this.escapeForBashDoubleQuotes(targetDir);
        const escapedPreserveDir: string = this.config.preserveDir
            ? this.escapeForBashDoubleQuotes(this.config.preserveDir.replace(/\/$/, ""))
            : "";

        const filesList: string = preserveFiles
            .map((filePath) => `\"${this.escapeForBashDoubleQuotes(filePath)}\"`)
            .join(" ");

        const command: string =
            `remoteDir=\"${escapedRemoteDir}\"; ` +
            `targetDir=\"${escapedTargetDir}\"; ` +
            `preserveDir=\"${escapedPreserveDir}\"; ` +
            "active=\"\"; " +
            "active=$(readlink -f -- \"$remoteDir\" 2>/dev/null || true); " +
            "if [ -z \"$active\" ]; then active=\"$remoteDir\"; fi; " +
            "echo \"[preserve] active=$active\"; " +
            `for f in ${filesList}; do ` +
            "src=\"\"; dst=\"$targetDir/$f\"; " +
            "if [ -n \"$preserveDir\" ] && [ -e \"$preserveDir/$f\" ]; then src=\"$preserveDir/$f\"; " +
            "elif [ -e \"$active/$f\" ]; then src=\"$active/$f\"; fi; " +
            "if [ -z \"$src\" ]; then echo \"[preserve] missing: $f\"; continue; fi; " +
            "if [ -e \"$dst\" ]; then echo \"[preserve] exists: $f\"; continue; fi; " +
            "mkdir -p -- \"$(dirname -- \"$dst\")\"; " +
            "cp -a -- \"$src\" \"$dst\"; " +
            "echo \"[preserve] copied: $f\"; " +
            "done";

        console.log(chalk.cyan(`Preserving ${preserveFiles.length} file(s)...`));
        await this.runCommand(ssh, command);
    }

    private normalizeAndValidatePreserveFiles(preserveFiles: string[]): string[] {
        const normalized: string[] = [];

        for (const entry of preserveFiles) {
            if (!entry.trim()) {
                continue;
            }

            const filePath: string = entry.trim().replace(/\\/g, "/");

            if (filePath.startsWith("/")) {
                throw new Error(`preserveFiles entry must be relative, got '${entry}'`);
            }

            if (filePath.includes("..")) {
                throw new Error(`preserveFiles entry must not contain '..', got '${entry}'`);
            }

            if (/[\n\r\0]/.test(filePath)) {
                throw new Error(`preserveFiles entry contains invalid characters, got '${entry}'`);
            }

            normalized.push(filePath);
        }

        return normalized;
    }

    private escapeForBashDoubleQuotes(value: string): string {
        return value
            .replace(/\\/g, "\\\\")
            .replace(/\"/g, "\\\"")
            .replace(/\$/g, "\\$")
            .replace(/`/g, "\\`");
    }

    private getDeploymentTargetOrThrow(): DeploymentTarget {
        const deploymentTarget: DeploymentTarget | null = resolveDeploymentTarget(this.config);

        if (!deploymentTarget) {
            throw new Error("Invalid deployment target. Define either localDir+remoteDir or localFile+remoteFile.");
        }

        return deploymentTarget;
    }

    private async validateSftpAccess(
        sftp: SFTPWrapper,
        deploymentTarget: DeploymentTarget
    ): Promise<void> {
        const targets: string[] = [];

        if (deploymentTarget.mode === "directory") {
            targets.push(deploymentTarget.remotePath);
        } else {
            const parentPath: string = path.posix.dirname(deploymentTarget.remotePath.replace(/\\/g, "/").replace(/\/$/, ""));
            targets.push(parentPath);
        }

        if (this.config.archiveDir) {
            targets.push(this.config.archiveDir);
        }

        for (const target of targets) {
            const directory: string = target.replace(/\\/g, "/").replace(/\/$/, "");

            if (!directory) {
                continue;
            }

            const spinner = ora(`Validating SFTP access to ${directory}...`).start();

            try {
                await sftpCreateRecursive(sftp, directory);

                const testPath: string = `${directory}/deploy_validation_test.txt`;

                await new Promise<void>((resolve, reject) => {
                    const stream = sftp.createWriteStream(testPath);

                    stream.on("close", () => {
                        resolve();
                    });

                    stream.on("error", (error: Error) => {
                        reject(error);
                    });

                    stream.write(Buffer.from("test", "utf8"));
                    stream.end();
                });

                await sftpUnlink(sftp, testPath);

                spinner.succeed(chalk.gray(`Validated SFTP write access to ${directory}`));
            } catch (error) {
                spinner.fail();

                const message: string = error instanceof Error ? error.message : String(error);
                throw new Error(`SFTP validation failed for '${directory}'. Ensure directory exists and is writable.\nError: ${message}`);
            }
        }
    }

    /* :: :: Commands and Validation :: END :: */
}
