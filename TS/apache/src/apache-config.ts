import * as fsPromises from 'node:fs/promises';

import {
    APACHE_DIR,
    CORE_LISTEN_PORT_START,
    PHP_DIR,
    VHOSTS_CONF_PATH,
} from './constants.js';
import {
    TrackedVHost,
} from './types.js';
import {
    normalizePathForApache,
} from './utils.js';

/* :: :: Apache Config Helpers :: START :: */

const CORE_LISTEN_MARKER: string = '# Apache CLI managed core listener';

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
        '        AllowOverride None',
        '        Require all granted',
        '    </Directory>',
        '</VirtualHost>',
        `# Apache CLI managed host end: ${vhost.id}`,
        '',
    ].join('\n');
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

    nextContent = nextContent.replace(/^(\s*)Listen\s+(.+)$/gm, '$1#Listen $2');

    nextContent = setManagedCoreListenPort(nextContent, CORE_LISTEN_PORT_START);

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
    let nextContent: string = setManagedCoreListenPort(httpdConfContent, coreListenPort);

    if (/^#?ServerName\s+localhost:\d+/gm.test(nextContent)) {
        nextContent = nextContent.replace(/^#?ServerName\s+localhost:\d+/gm, `ServerName localhost:${serverNamePort}`);
    } else if (/^#?ServerName\s+/gm.test(nextContent)) {
        nextContent = nextContent.replace(/^#?ServerName\s+.+$/gm, `ServerName localhost:${serverNamePort}`);
    } else {
        nextContent = `${nextContent.trimEnd()}\nServerName localhost:${serverNamePort}\n`;
    }

    return nextContent;
}

export function setManagedCoreListenPort (
    httpdConfContent: string,
    coreListenPort: number
): string {
    const managedLine: string = `${CORE_LISTEN_MARKER}\nListen ${coreListenPort}`;
    const managedPattern: RegExp = new RegExp(`${CORE_LISTEN_MARKER.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\nListen\\s+\\d+`, 'm');

    if (managedPattern.test(httpdConfContent)) {
        return httpdConfContent.replace(managedPattern, managedLine);
    }

    return `${httpdConfContent.trimEnd()}\n\n${managedLine}\n`;
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

/* :: :: Apache Config Helpers :: END :: */
