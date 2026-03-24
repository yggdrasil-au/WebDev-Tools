import type { SFTPWrapper } from "ssh2";

/* :: :: Helpers :: START :: */

export async function sftpStat (
    sftp: SFTPWrapper,
    path: string
): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
        sftp.stat(path, (error) => {
            resolve(!error);
        });
    });
}

export async function sftpReadDir (
    sftp: SFTPWrapper,
    path: string
): Promise<Array<{ filename: string }>> {
    return await new Promise<Array<{ filename: string }>>((resolve, reject) => {
        sftp.readdir(path, (error, list) => {
            if (error) {
                reject(error);
                return;
            }

            const normalized: Array<{ filename: string }> = (list ?? [])
                .filter((item) => item.filename !== "." && item.filename !== "..")
                .map((item) => ({ filename: item.filename }));

            resolve(normalized);
        });
    });
}

export async function sftpMkdir (
    sftp: SFTPWrapper,
    path: string
): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        sftp.mkdir(path, (error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}

export async function sftpRename (
    sftp: SFTPWrapper,
    oldPath: string,
    newPath: string
): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        sftp.rename(oldPath, newPath, (error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}

export async function sftpUnlink (
    sftp: SFTPWrapper,
    path: string
): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        sftp.unlink(path, (error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}

export async function sftpFastPut (
    sftp: SFTPWrapper,
    localPath: string,
    remotePath: string,
    step?: (totalTransferred: number, chunk: number, total: number) => void
): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        if (step) {
            sftp.fastPut(localPath, remotePath, { step }, (error) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve();
            });
            return;
        }

        sftp.fastPut(localPath, remotePath, (error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}

export async function sftpCreateRecursive (
    sftp: SFTPWrapper,
    dirPath: string
): Promise<void> {
    const normalizedPath: string = dirPath.replace(/\\/g, "/").replace(/\/$/, "");
    const parts: string[] = normalizedPath.replace(/^\//, "").split("/");

    let currentPath: string = normalizedPath.startsWith("/") ? "/" : "";

    for (const part of parts) {
        if (!part) {
            continue;
        }

        currentPath = currentPath === "" || currentPath === "/"
            ? `${currentPath}${part}`
            : `${currentPath}/${part}`;

        const exists: boolean = await sftpStat(sftp, currentPath);
        if (!exists) {
            await sftpMkdir(sftp, currentPath);
        }
    }
}

/* :: :: Helpers :: END :: */
