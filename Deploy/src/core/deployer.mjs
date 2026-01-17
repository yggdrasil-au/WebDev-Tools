import SftpClient from 'ssh2-sftp-client';
import fs from 'node:fs';
import { runCommandsOverSSH } from './ssh.mjs';
import { normalizeRemote, joinRemote, remoteBaseName, remoteDirName } from '../utils/paths.mjs';
import { uploadSftp } from '../strategies/sftp.mjs';
import { uploadTar } from '../strategies/tar.mjs';

export class Deployer {
    constructor(config) {
        this.config = config;
        this.client = new SftpClient();
    }

    async run() {
        const { 
            host, port, username, privateKeyPath, passphrase, password,
            preCommands, postCommands,
            strategy, transfer,
            remoteDir, releasesDir, keepReleases,
            localDir,
            archiveExisting, archiveDir, cleanRemote,
            preserveFiles, preserveDir
        } = this.config;

        // Load Key
        const privateKey = privateKeyPath ? fs.readFileSync(privateKeyPath) : undefined;
        // Construct connection object for SSH helper
        const sshConn = { host, port, username, privateKey, passphrase, password };
        // Construct config for internal helpers that need credentials/paths
        // We pass the raw privateKey buffer/string, not just the path
        const fullConfig = { ...this.config, privateKey };

        // 1. Run Pre-commands
        if (preCommands.length) {
            console.log('[deploy] Executing pre-commands...');
            await runCommandsOverSSH(sshConn, preCommands);
        }

        console.log(`[deploy] Connecting to ${host}...`);
        await this.client.connect({ host, port, username, privateKey, passphrase, password });

        try {
            // Derived Paths
            const remoteDirNorm = normalizeRemote(remoteDir);
            let targetUploadDir = '';
            let releasesRoot = '';
            let previousReleaseLink = '';

            if (strategy === 'symlink') {
                const ts = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
                releasesRoot = releasesDir ? normalizeRemote(releasesDir) : joinRemote(remoteDirName(remoteDirNorm), 'releases');
                targetUploadDir = joinRemote(releasesRoot, ts);
                previousReleaseLink = remoteDirNorm;

                // Ensure releases root exists
                if (!(await this.client.exists(releasesRoot))) await this.client.mkdir(releasesRoot, true);
                if (!(await this.client.exists(targetUploadDir))) await this.client.mkdir(targetUploadDir, true);

            } else {
                targetUploadDir = remoteDirNorm;
                
                // Inplace preparation
                if (await this.client.exists(remoteDirNorm)) {
                    if (archiveExisting) {
                        const ts = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
                        const arcParent = archiveDir ? normalizeRemote(archiveDir) : remoteDirName(remoteDirNorm);
                        if (!(await this.client.exists(arcParent))) await this.client.mkdir(arcParent, true);
                        const arcPath = joinRemote(arcParent, `${remoteBaseName(remoteDirNorm)}-${ts}`);
                        console.log(`[deploy] Archiving existing: ${arcPath}`);
                        await this.client.rename(remoteDirNorm, arcPath);
                        await this.client.mkdir(remoteDirNorm, true);
                    } else if (cleanRemote) {
                        await this.client.rmdir(remoteDirNorm, true);
                        await this.client.mkdir(remoteDirNorm, true);
                    }
                } else {
                     await this.client.mkdir(remoteDirNorm, true);
                }
            }

            // 3. Upload Content
            if (transfer === 'tar') {
                await uploadTar(this.client, fullConfig, targetUploadDir);
            } else {
                await uploadSftp(this.client, localDir, targetUploadDir);
            }

            // 4. Handle Preserve Files
            if (strategy === 'symlink' && preserveFiles && preserveFiles.length) {
                console.log('[deploy] Copying preserved files...');
                const sourceBase = preserveDir ? normalizeRemote(preserveDir) : previousReleaseLink;
                
                // We typically use SSH cp for speed and permission retention compared to sftp download/upload
                if (await this.client.exists(sourceBase)) {
                     for (const f of preserveFiles) {
                        const src = joinRemote(sourceBase, f);
                        const dest = joinRemote(targetUploadDir, f);
                        try {
                            // Using ssh copy on remote
                            await runCommandsOverSSH(
                                sshConn,
                                [`[ -e "${src}" ] && cp -rp "${src}" "${dest}" || true`],
                                { verbose: false }
                            );
                        } catch (e) {
                             console.warn(`  ! Failed to copy ${f}: ${e.message}`); 
                        }
                    }
                }
            }

            // 5. Finalize / Switch
            if (strategy === 'symlink') {
                console.log(`[deploy] Linking ${previousReleaseLink} -> ${targetUploadDir}`);
                await runCommandsOverSSH(sshConn, [`ln -sfn "${targetUploadDir}" "${previousReleaseLink}"`]);

                console.log('[deploy] Cleaning up old releases...');
                const releases = await this.client.list(releasesRoot);
                const sorted = releases
                    .filter(r => r.type === 'd' && /^\d{14}$/.test(r.name))
                    .sort((a, b) => b.name.localeCompare(a.name));

                const toRemove = sorted.slice(keepReleases);
                for (const r of toRemove) {
                    await this.client.rmdir(joinRemote(releasesRoot, r.name), true);
                }
            }

            // 6. Post Commands
            if (postCommands.length) {
                console.log('[deploy] Executing post-commands...');
                await runCommandsOverSSH(sshConn, postCommands);
            }
            
            console.log('[deploy] Success!');

        } finally {
            await this.client.end();
        }
    }
}
