import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/* :: :: Constants :: START :: */

export const APACHE_URL: string = 'https://www.apachelounge.com/download/VS18/binaries/httpd-2.4.66-260223-Win64-VS18.zip';
export const PHP_URL: string = 'https://downloads.php.net/~windows/releases/archives/php-8.5.4-Win32-vs17-x64.zip';

const CURRENT_MODULE_FILE_PATH: string = fileURLToPath(import.meta.url);
const PACKAGE_ROOT_DIR: string = path.resolve(path.dirname(CURRENT_MODULE_FILE_PATH), '..');

export const RUNTIME_DIR: string = path.join(PACKAGE_ROOT_DIR, '.runtime');
export const APACHE_DIR: string = path.join(RUNTIME_DIR, 'Apache24');
export const PHP_DIR: string = path.join(RUNTIME_DIR, 'php');

export const APACHE_ZIP_PATH: string = path.join(RUNTIME_DIR, 'apache.zip');
export const PHP_ZIP_PATH: string = path.join(RUNTIME_DIR, 'php.zip');

export const PROCESS_REGISTRY_PATH: string = path.join(RUNTIME_DIR, 'apache-processes.json');
export const VHOST_REGISTRY_PATH: string = path.join(RUNTIME_DIR, 'apache-vhosts.json');

export const HTTPD_CONF_PATH: string = path.join(APACHE_DIR, 'conf', 'httpd.conf');
export const VHOSTS_CONF_PATH: string = path.join(APACHE_DIR, 'conf', 'extra', 'httpd-vhosts.conf');
export const CORE_LISTEN_PORT_START: number = 65535;

export const REQUEST_TIMEOUT_MS: number = 30000;

/* :: :: Constants :: END :: */
