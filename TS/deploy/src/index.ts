#!/usr/bin/env node

import fs from "node:fs";

import chalk from "chalk";
import yaml from "yaml";

import type { DeployConfig, DeploymentProfile } from "./config.js";
import { mergeDefaults } from "./config.js";
import { Deployer } from "./core/Deployer.js";

/* :: :: Entrypoint :: START :: */

void main();

async function main(): Promise<void> {
    console.log(chalk.greenBright.bold("\nDeploy\n"));

    try {
        const config: DeployConfig = loadConfig();
        const profileName: string | null = parseProfile(process.argv, config);

        if (!profileName) {
            console.log(chalk.red("No profile specified."));
            console.log("Usage: deploy --<profile> or --profile <profile>");
            console.log(`Available profiles: ${Object.keys(config.deployments ?? {}).join(", ")}`);
            process.exit(1);
            return;
        }

        const profile: DeploymentProfile | undefined = config.deployments?.[profileName];
        if (!profile) {
            console.log(chalk.red(`Profile '${profileName}' not found.`));
            process.exit(1);
            return;
        }

        mergeDefaults(profile, config.defaults);

        validateProfile(profile);

        profile.preCommands ??= [];
        profile.postCommands ??= [];
        profile.preserveFiles ??= [];

        const deployer = new Deployer(profile);
        await deployer.runAsync();

        process.exit(0);
    } catch (error) {
        const message: string = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(message));
        process.exit(1);
    }
}

/* :: :: Entrypoint :: END :: */

// //

/* :: :: Config Loading :: START :: */

function loadConfig(): DeployConfig {
    const paths: string[] = ["deploy.config.yaml", "deploy.config.yml", "deploy.config.json"];

    for (const filePath of paths) {
        if (!fs.existsSync(filePath)) {
            continue;
        }

        console.log(chalk.gray(`Loading config from ${filePath}`));

        let rawConfigText: string = fs.readFileSync(filePath, "utf8");

        const firstPassConfig: DeployConfig = yaml.parse(rawConfigText) as DeployConfig;
        const vars: Record<string, string> = firstPassConfig?.vars ?? {};

        rawConfigText = applyVarsWithValidation(rawConfigText, vars, filePath);

        return yaml.parse(rawConfigText) as DeployConfig;
    }

    throw new Error("deploy.config.yaml not found");
}

function parseProfile(args: string[], config: DeployConfig): string | null {
    for (let index: number = 0; index < args.length; index += 1) {
        if (args[index] === "--profile" && index + 1 < args.length) {
            return args[index + 1];
        }

        if (args[index].startsWith("--")) {
            const profileName: string = args[index].slice(2);
            if (config.deployments && profileName in config.deployments) {
                return profileName;
            }
        }
    }

    return null;
}

function applyVarsWithValidation(
    rawText: string,
    vars: Record<string, string>,
    configPath: string
): string {
    const placeholderRegex: RegExp = /{{([a-zA-Z0-9_]+)}}/g;
    const matches: RegExpMatchArray[] = Array.from(rawText.matchAll(placeholderRegex));

    if (matches.length === 0) {
        return rawText;
    }

    const unknownNames: Set<string> = new Set<string>();
    const distinctPlaceholders: Set<string> = new Set<string>();

    for (const match of matches) {
        const name: string = match[1];
        distinctPlaceholders.add(name);

        if (!(name in vars)) {
            unknownNames.add(name);
        }
    }

    if (unknownNames.size > 0) {
        let message: string = `Unknown template variables in deploy config '${configPath}':\n`;

        for (const name of unknownNames) {
            const relatedMatch: RegExpMatchArray | undefined = matches.find((entry) => entry[1] === name);
            const context: string = relatedMatch ? ` (near: ...${relatedMatch[0]}...)` : "";
            message += `- ${name}${context}\n`;
        }

        throw new Error(message);
    }

    if (Object.keys(vars).length > 0) {
        console.log(chalk.gray(`Substituting ${distinctPlaceholders.size} variables...`));

        for (const [name, value] of Object.entries(vars)) {
            const placeholder: string = `{{${name}}}`;
            rawText = rawText.split(placeholder).join(value);
        }
    }

    return rawText;
}

/* :: :: Config Loading :: END :: */

// //

/* :: :: Validation :: START :: */

function validateProfile(profile: DeploymentProfile): void {
    if (!profile.host) {
        throw new Error("Host is required");
    }

    if (!profile.remoteDir) {
        throw new Error("RemoteDir is required");
    }

    if (!profile.localDir) {
        throw new Error("LocalDir is required");
    }

    if (!fs.existsSync(profile.localDir)) {
        throw new Error(`Local directory '${profile.localDir}' does not exist`);
    }

    if (!profile.strategy) {
        console.log(chalk.yellow("Warning: 'strategy' not defined. Defaulting to 'inplace'."));
        profile.strategy = "inplace";
    }

    if (!profile.transfer) {
        console.log(chalk.yellow("Warning: 'transfer' not defined. Defaulting to 'sftp'."));
        profile.transfer = "sftp";
    }

    if (profile.port == null) {
        console.log(chalk.yellow("Warning: 'port' not defined. Defaulting to 22."));
        profile.port = 22;
    }

    if (profile.archiveExisting === true && !profile.archiveDir) {
        console.log(chalk.yellow("Warning: 'archiveExisting' is true but 'archiveDir' is not defined. Defaulting to '../archive' relative to RemoteDir."));
    }
}

/* :: :: Validation :: END :: */
