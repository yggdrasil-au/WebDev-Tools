import * as fsPromises from 'node:fs/promises';

import {
    APACHE_DIR,
    CORE_LISTEN_PORT_START,
    MANAGED_DOCUMENT_ROOT_CONF_PATH,
    PHP_DIR,
    VHOSTS_CONF_PATH,
} from './constants.ts';
import type {
    TrackedVHost,
} from './types.ts';
import {
    normalizePathForApache,
} from './utils.ts';

/* :: :: Apache Config Helpers :: START :: */

const CORE_LISTEN_MARKER: string = '# Apache CLI managed core listener';
const MANAGED_DOCUMENT_ROOT_INCLUDE_MARKER: string = '# Apache CLI managed document root include';
const DOCUMENT_ROOT_MARKER_START: string = '# Apache CLI managed document root start';
const DOCUMENT_ROOT_MARKER_END: string = '# Apache CLI managed document root end';

function buildVHostHeader (): string {
    return [
        '# Apache CLI managed vhosts',
        '# This file is auto-generated. Manual changes may be overwritten.',
        '',
    ].join('\n');
}

function renderVHost (
    vhost: TrackedVHost
): string {
    const safeDocumentRoot: string = normalizePathForApache(vhost.documentRoot);

    return [
        `# Apache CLI managed host start: ${vhost.id}`,
        `Listen ${vhost.port}`,
        `<VirtualHost *:${vhost.port}>`,
        `    ServerName ${vhost.serverName}`,
        `    DocumentRoot "${safeDocumentRoot}"`,
        `    ErrorLog "logs/apache-cli-${vhost.id}-error.log"`,
        `    CustomLog "logs/apache-cli-${vhost.id}-access.log" common`,
        `    <Directory "${safeDocumentRoot}">`,
        '        AllowOverride All',
        '        Require all granted',
        '    </Directory>',
        '</VirtualHost>',
        `# Apache CLI managed host end: ${vhost.id}`,
        '',
    ].join('\n');
}

function buildManagedDocumentRootHeader (): string {
    return [
        '# Apache CLI managed document root',
        '# This file is auto-generated. Manual changes may be overwritten.',
        '',
    ].join('\n');
}

function buildManagedDocumentRootBlock (
    documentRootPath: string
): string {
    const safeDocumentRoot: string = normalizePathForApache(documentRootPath);

    return [
        DOCUMENT_ROOT_MARKER_START,
        `DocumentRoot "${safeDocumentRoot}"`,
        `<Directory "${safeDocumentRoot}">`,
        '    AllowOverride All',
        '    Require all granted',
        '</Directory>',
        DOCUMENT_ROOT_MARKER_END,
        '',
    ].join('\n');
}

function removeManagedListenDirectives (
    httpdConfContent: string
): string {
    return httpdConfContent
        .replace(/^\s*#?\s*Listen\s+.*$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trimEnd();
}

function removeManagedDocumentRootBlock (
    httpdConfContent: string
): string {
    const managedPattern: RegExp = new RegExp(
        `${DOCUMENT_ROOT_MARKER_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\s\S]*?${DOCUMENT_ROOT_MARKER_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\n?`,
        'm'
    );

    return httpdConfContent.replace(managedPattern, '').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function setManagedCoreListenPort (
    httpdConfContent: string,
    coreListenPort: number
): string {
    const withoutExistingMarker: string = httpdConfContent.replace(/^# Apache CLI managed core listener\s*\n?/m, '').trimEnd();
    return `${withoutExistingMarker}\n\n${CORE_LISTEN_MARKER}\nListen ${coreListenPort}\n`;
}

function setManagedDocumentRootInclude (
    httpdConfContent: string
): string {
    const managedLine: string = `${MANAGED_DOCUMENT_ROOT_INCLUDE_MARKER}\nInclude conf/extra/apache-cli-document-root.conf`;
    const managedPattern: RegExp = new RegExp(
        `${MANAGED_DOCUMENT_ROOT_INCLUDE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\nInclude\s+conf\/extra\/apache-cli-document-root\.conf`,
        'm'
    );

    if (managedPattern.test(httpdConfContent)) {
        return httpdConfContent.replace(managedPattern, managedLine);
    }

    return `${httpdConfContent.trimEnd()}\n\n${managedLine}\n`;
}

export function applyBuildPreset (
    httpdConfContent: string
): string {
    const apachePathPosix: string = normalizePathForApache(APACHE_DIR);
    const phpPathPosix: string = normalizePathForApache(PHP_DIR);

    let nextContent: string = httpdConfContent;

    nextContent = nextContent.replace(/c:\/Apache24/gi, apachePathPosix);
    nextContent = nextContent.replace(/^LoadModule\s+cgi_module/gm, '#LoadModule cgi_module');
    nextContent = nextContent.replace(/^LoadModule\s+userdir_module/gm, '#LoadModule userdir_module');
    nextContent = nextContent.replace(/^#\s*LoadModule\s+rewrite_module/gm, 'LoadModule rewrite_module');

    nextContent = removeManagedListenDirectives(nextContent);
    nextContent = removeManagedDocumentRootBlock(nextContent);
    nextContent = setManagedCoreListenPort(nextContent, CORE_LISTEN_PORT_START);
    nextContent = setManagedDocumentRootInclude(nextContent);

    if (/^\s*#\s*Include\s+conf\/extra\/httpd-vhosts\.conf\s*$/m.test(nextContent)) {
        nextContent = nextContent.replace(/^\s*#\s*Include\s+conf\/extra\/httpd-vhosts\.conf\s*$/m, 'Include conf/extra/httpd-vhosts.conf');
    } else if (!/^\s*Include\s+conf\/extra\/httpd-vhosts\.conf\s*$/m.test(nextContent)) {
        nextContent = `${nextContent.trimEnd()}\n\nInclude conf/extra/httpd-vhosts.conf\n`;
    }

    const phpMarker: string = '# Apache CLI Custom PHP Setup';
    if (!nextContent.includes(phpMarker)) {
        const phpSetupBlock: string = `\n${phpMarker}\nLoadModule php_module "${phpPathPosix}/php8apache2_4.dll"\nAddHandler application/x-httpd-php .php\nPHPIniDir "${phpPathPosix}"\n`;
        nextContent = `${nextContent.trimEnd()}\n${phpSetupBlock}`;
    }

    return nextContent;
}

export function applyStartConfig (
    httpdConfContent: string,
    serverNamePort: string,
    coreListenPort: number
): string {
    let nextContent: string = removeManagedListenDirectives(httpdConfContent);
    nextContent = removeManagedDocumentRootBlock(nextContent);
    nextContent = setManagedCoreListenPort(nextContent, coreListenPort);
    nextContent = setManagedDocumentRootInclude(nextContent);

    if (/^#?ServerName\s+localhost:\d+/gm.test(nextContent)) {
        nextContent = nextContent.replace(/^#?ServerName\s+localhost:\d+/gm, `ServerName localhost:${serverNamePort}`);
    } else if (/^#?ServerName\s+/gm.test(nextContent)) {
        nextContent = nextContent.replace(/^#?ServerName\s+.+$/gm, `ServerName localhost:${serverNamePort}`);
    } else {
        nextContent = `${nextContent.trimEnd()}\nServerName localhost:${serverNamePort}\n`;
    }

    return nextContent;
}

export async function clearVHostsConfigFile (): Promise<void> {
    const header: string = buildVHostHeader();
    await fsPromises.writeFile(VHOSTS_CONF_PATH, header, 'utf8');
}

export async function writeManagedVHosts (
    entries: TrackedVHost[]
): Promise<void> {
    const header: string = buildVHostHeader();
    const sections: string[] = entries.map((entry: TrackedVHost) => {
        return renderVHost(entry);
    });

    const nextContent: string = `${header}${sections.join('')}`;
    await fsPromises.writeFile(VHOSTS_CONF_PATH, nextContent, 'utf8');
}

export async function clearManagedDocumentRootConfigFile (): Promise<void> {
    await fsPromises.writeFile(MANAGED_DOCUMENT_ROOT_CONF_PATH, `${buildManagedDocumentRootHeader()}\n`, 'utf8');
}

export async function writeManagedDocumentRootConfig (
    documentRootPath: string
): Promise<void> {
    const content: string = `${buildManagedDocumentRootHeader()}${buildManagedDocumentRootBlock(documentRootPath)}`;
    await fsPromises.writeFile(MANAGED_DOCUMENT_ROOT_CONF_PATH, content, 'utf8');
}

/* :: :: Apache Config Helpers :: END :: */