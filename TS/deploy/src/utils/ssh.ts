import { Client, type ConnectConfig, type SFTPWrapper } from "ssh2";

export interface SshExecResult {
    stdout: string;
    stderr: string;
    code: number;
}

export class SshClient {
    private readonly client: Client;
    public sftpWrapper: SFTPWrapper | null;

    public constructor (
        private readonly config: ConnectConfig
    ) {
        this.client = new Client();
        this.sftpWrapper = null;
    }

    public async connect(): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            this.client
                .on("ready", () => {
                    resolve();
                })
                .on("error", (error: Error) => {
                    reject(error);
                })
                .connect(this.config);
        });
    }

    public async connectSftp(): Promise<SFTPWrapper> {
        const sftp: SFTPWrapper = await new Promise<SFTPWrapper>((resolve, reject) => {
            this.client.sftp((error: Error | undefined, wrapper: SFTPWrapper) => {
                if (error) {
                    reject(error);
                    return;
                }

                resolve(wrapper);
            });
        });

        this.sftpWrapper = sftp;
        return sftp;
    }

    public async exec(command: string): Promise<SshExecResult> {
        return await new Promise<SshExecResult>((resolve, reject) => {
            this.client.exec(command, (error, stream) => {
                if (error) {
                    reject(error);
                    return;
                }

                let stdout: string = "";
                let stderr: string = "";
                let exitCode: number = -1;

                stream.on("data", (data: Buffer) => {
                    stdout += data.toString("utf8");
                });

                stream.stderr.on("data", (data: Buffer) => {
                    stderr += data.toString("utf8");
                });

                stream.on("exit", (code: number | undefined) => {
                    exitCode = code ?? -1;
                });

                stream.on("close", () => {
                    resolve({
                        stdout,
                        stderr,
                        code: exitCode,
                    });
                });
            });
        });
    }

    public disconnect(): void {
        this.client.end();
    }
}
