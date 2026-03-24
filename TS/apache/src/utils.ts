import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';

/* :: :: Utility Helpers :: START :: */

export function normalizePathForApache (
    inputPath: string
): string {
    return inputPath.replace(/\\/g, '/');
}

export function escapeRegExp (
    value: string
): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function formatUnknownError (
    error: unknown
): string {
    if (error instanceof AggregateError) {
        const childMessages: string[] = [];

        for (const childError of error.errors) {
            childMessages.push(formatUnknownError(childError));
        }

        const aggregateBaseMessage: string = error.message || 'AggregateError';
        if (childMessages.length > 0) {
            return `${aggregateBaseMessage}: ${childMessages.join(' | ')}`;
        }

        return aggregateBaseMessage;
    }

    if (error instanceof Error) {
        const maybeCode: string | undefined = (error as NodeJS.ErrnoException).code;
        const maybeCauseMessage: string | undefined = error.cause instanceof Error ? error.cause.message : undefined;
        const coreMessage: string = error.message || error.name;

        if (maybeCode && maybeCauseMessage) {
            return `${coreMessage} [${maybeCode}] (cause: ${maybeCauseMessage})`;
        }

        if (maybeCode) {
            return `${coreMessage} [${maybeCode}]`;
        }

        return coreMessage;
    }

    return String(error);
}

export async function ensureDirectory (
    directoryPath: string
): Promise<void> {
    await fsPromises.mkdir(directoryPath, { recursive: true });
}

export async function safeUnlink (
    filePath: string
): Promise<void> {
    try {
        await fsPromises.unlink(filePath);
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
        }
    }
}

export async function writeJsonFile (
    filePath: string,
    value: unknown
): Promise<void> {
    await ensureDirectory(path.dirname(filePath));
    await fsPromises.writeFile(filePath, JSON.stringify(value, null, 4), 'utf8');
}

/* :: :: Utility Helpers :: END :: */
