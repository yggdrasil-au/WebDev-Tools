# @yggdrasil-au/deploy

Deployment CLI for SSH targets with directory and single-file deployment modes.

Supported deployment features include:

- In-place deployment.
- Symlink release deployment.
- SFTP, tar-stream, and relay transfer paths.
- Diff-based uploads (size comparison).
- Pre and post remote command hooks.
- Optional archive of existing remote content.
- Optional preservation of files across symlink releases.

## CLI Usage

Run from the directory that contains your deploy config file.

```bash
deploy --profile production
deploy --production
```

If no profile is selected, deploy exits with usage info and available profiles.

## Config Files and Load Order

Deploy looks for config files in this exact order:

1. deploy.config.yaml
2. deploy.config.yml
3. deploy.config.json

The first file found is loaded.

## Template Variables (vars)

You can define placeholders in config text using the syntax {{NAME}}.

```yaml
vars:
    DEPLOY_HOST: 192.168.1.50

defaults:
    host: "{{DEPLOY_HOST}}"
```

Validation behavior:

- If any placeholder is used but missing from vars, startup fails.
- Unknown placeholder names are listed in the error output.
- Substitution is text replacement before final YAML parse.

## Profile Merge Behavior

Each selected profile is merged with defaults before validation.

Important details:

- Scalar fields use fill-if-missing behavior.
- preCommands, postCommands, and preserveFiles are copied from defaults only when the profile does not define values.
- Target fields have mode-aware merging:
    - If profile uses file fields, file defaults are applied.
    - If profile uses directory fields, directory defaults are applied.
    - If profile uses neither, both sets can be inherited, which may create ambiguity.

## Deployment Model

A profile must choose exactly one target mode:

- Directory mode: localDir + remoteDir
- File mode: localFile + remoteFile

Invalid:

- Mixing directory and file mode fields in one profile.
- Partial mode pairs (for example localDir without remoteDir).

## Auto Defaults and Fallbacks

If omitted:

- strategy defaults to inplace with a warning.
- transfer defaults to sftp with a warning.
- port defaults to 22 with a warning.

If odd values are set:

- Unknown strategy values are treated like inplace.
- Unknown transfer values are treated like sftp.
- privateKeyPath is used only when the file exists; otherwise deploy falls back to password when provided.

## Field Reference

### Top-Level Fields

| Field | Type | Required | Notes |
|---|---|---|---|
| vars | Record<string, string> | No | Template variables for {{NAME}} placeholders. Missing variables fail startup. |
| defaults | DeploymentProfile | No | Base values merged into each selected profile. |
| deployments | Record<string, DeploymentProfile> | Yes | Map of profile names to profile settings. |

### DeploymentProfile Fields

| Field | Type | Values / Default | Applies To | Behavior |
|---|---|---|---|---|
| host | string | required | all | Target SSH host. Missing host fails validation. |
| port | number | default 22 | all | SSH port to target host. |
| username | string | no hard default | all | SSH username for target host. |
| privateKeyPath | string | optional | all | Preferred auth if path exists and is readable. |
| passphrase | string | optional | key auth | Used for encrypted private keys. |
| password | string | optional | all | Used only when key path is missing or unreadable. |
| relayHost | string | required for transfer=relay | relay | Relay host used for jump deployment. |
| relayPort | number | default 22 | relay | Relay SSH port. |
| relayUsername | string | fallback to username | relay | Relay SSH username. |
| relayPrivateKeyPath | string | fallback to privateKeyPath | relay | Relay SSH key path. |
| localDir | string | required with remoteDir | directory mode | Local source directory. Must exist and be directory. |
| remoteDir | string | required with localDir | directory mode | Remote destination directory. |
| localFile | string | required with remoteFile | file mode | Local source file. Must exist and be file. |
| remoteFile | string | required with localFile | file mode | Remote destination file. Must not end with slash. |
| releasesDir | string | computed if omitted | symlink | Release root path. Default differs for directory vs file mode. |
| minRemoteDepth | number | merged default 2 | all | Currently accepted but not enforced by runtime logic. |
| strategy | string | inplace default | all | symlink triggers symlink flow; other values run inplace flow. |
| transfer | string | sftp default | all | relay and tar have specialized flow; other values run sftp flow. |
| batchSizeMB | number | default 50 | transfer=tar | Batch size for tar directory mode processing. |
| concurrency | number | default 1 | transfer=tar | Parallel tar batch workers in directory mode. |
| keepReleases | number | optional | strategy=symlink | Cleanup currently executes in symlink file mode only. |
| cleanRemote | boolean | optional | all | Currently accepted but not enforced by runtime logic. |
| archiveExisting | boolean | default false | strategy=inplace | Archives existing remote content before upload when true. |
| archiveDir | string | computed for directory mode | archiveExisting | Archive target path. File mode has rename fallback if omitted. |
| preCommands | string[] | default [] | all | Runs before upload flow. Failures prompt Retry / Skip / Quit. |
| postCommands | string[] | default [] | all | Runs after upload flow. Failures prompt Retry / Skip / Quit. |
| preserveFiles | string[] | default [] | symlink directory | Copied from previous release or preserveDir before symlink switch. Entries must be relative, without .., and without newline or null chars. |
| preserveDir | string | optional | symlink directory | First lookup source for preserveFiles entries. |

## Strategy Details

### inplace Strategy

- Uploads directly to remote path.
- If archiveExisting is true and target exists:
    - Directory mode: moves remote contents to archiveDir/timestamp.
    - File mode:
        - If archiveDir exists: moves file to archiveDir/filename.timestamp.
        - If archiveDir missing: renames to remoteFile.timestamp.
- If strategy is anything other than symlink, deploy follows this branch.

### symlink Strategy

Directory mode:

- Creates releasesDir/timestamp.
- Uploads changed files there.
- Optionally preserves paths from existing active release or preserveDir.
- Updates remoteDir symlink to new release.

File mode:

- Creates releasesDir/timestamp/filename.
- Uploads changed file there.
- Updates remoteFile symlink to the new release file.
- keepReleases cleanup is executed here when keepReleases > 0.

## Transfer Details

### sftp Transfer

- Uploads changed files directly with SFTP.
- Ensures parent directories exist.
- Used as default and as fallback for unknown transfer values.

### tar Transfer

Directory mode:

- Splits files into batches by batchSizeMB.
- Creates tar.gz locally for each batch.
- Uploads tarball and extracts remotely.
- Runs up to concurrency batches in parallel.
- batchSizeMB defaults to 50 when omitted.
- batchSizeMB set to 0 or a negative value is not validated by runtime and can produce inefficient batching.

File mode:

- Logs a fallback message and uploads the single file via SFTP directly.
- batchSizeMB and concurrency are effectively irrelevant in file mode.

### relay Transfer

- Requires relayHost.
- Uploads payload to relay host and then relays to target.
- Directory mode relays tar archive, extracts on target, and removes temp archive.
- File mode relays file directly.
- Relay cleanup removes temp payload and temp key files.

Important practical requirement:

- Current relay jump commands use ssh and scp with -i key path for target access.
- In practice, configure target privateKeyPath for relay deployments.
- Password-only auth to the final target is not a reliable relay path with current implementation.

## Diff Behavior

Deploy uploads only changed files, based on size comparisons:

- Directory mode compares relative file path and file size.
- File mode compares local and remote file size.

Consequence:

- Content changes with identical byte size are not detected.

## Validation and Safety Behavior

Before upload, deploy validates:

- Required profile shape and mode pairing.
- Local path existence and expected type.
- remoteFile format (must not end with slash).
- SFTP write access to required remote directories.

Current limitations (important):

- minRemoteDepth is not currently enforced by runtime deployment logic.
- cleanRemote is not currently enforced by runtime deployment logic.
- keepReleases cleanup currently executes only in symlink file mode.

## Incompatible or Ignored Combinations

- preserveFiles and preserveDir in file mode: ignored with warnings.
- archiveExisting in symlink strategy: not used.
- localDir/remoteDir mixed with localFile/remoteFile: hard validation error.
- remoteFile ending with slash: hard validation error.

## Hooks and Failure Flow

preCommands and postCommands run sequentially on target host.

If a command fails (non-zero exit), deploy prompts:

- Retry
- Skip
- Quit

Behavior:

- Retry reruns the same command.
- Skip continues to the next command.
- Quit aborts deployment with error.

## Example Layout

For a complete example containing all fields and compatibility notes, see:

- deploy.config.example.yaml

## Troubleshooting

Common startup failures:

- Host is required.
- Profile not found.
- Unknown template variables in config.
- Mixed mode fields in one profile.
- Local source path missing or wrong type.

Common runtime failures:

- SFTP validation failed: remote path not writable.
- Relay transfer missing relayHost.
- Relay jump auth mismatch when key-based target auth is not configured.
- Remote command hook failure due to permissions or service command errors.
