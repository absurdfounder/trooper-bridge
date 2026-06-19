import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const script = readFileSync(join(__dirname, '..', 'setup-local-mac-host.sh'), 'utf8');

test('mac local installer runs in the signed-in user session', () => {
  assert.match(script, /Run this installer as your signed-in macOS user, not with sudo/);
  assert.match(script, /launchctl bootstrap "gui\/\$\(id -u\)"/);
  assert.doesNotMatch(script, /launchctl load/);
});

test('mac local installer gives LaunchAgents a stable user environment', () => {
  assert.match(script, /<key>EnvironmentVariables<\/key>/);
  assert.match(script, /<key>HOME<\/key><string>\$HOME<\/string>/);
  assert.match(script, /<key>TROOPER_HOME<\/key><string>\$TROOPER_HOME<\/string>/);
});

test('mac local installer repairs old root-owned runtime before creating subdirectories', () => {
  assert.match(script, /TROOPER_PARENT_DIR="\$\(dirname "\$TROOPER_HOME"\)"/);
  assert.ok(
    script.indexOf('sudo chown -R "$(id -u):$(id -g)"') < script.indexOf('mkdir -p \\'),
  );
});

test('mac local installer writes sourceable environment files for paths with spaces', () => {
  assert.match(script, /write_env_line\(\) \{/);
  assert.match(script, /printf '%s=%q\\n'/);
  assert.match(script, /write_env_line TROOPER_HOME "\$TROOPER_HOME"/);
  assert.match(script, /write_env_line OPENCLAW_DATA_ROOT "\$OPENCLAW_DATA_DIR"/);
  assert.match(script, /write_env_line OPENCLAW_CONFIG_ROOT "\$OPENCLAW_DATA_DIR\/config"/);
  assert.match(script, /write_env_line OPENCLAW_WORKSPACE_HOST_ROOT "\$OPENCLAW_DATA_DIR\/workspace"/);
  assert.match(script, /write_env_line BRIDGE_DEVICE_IDENTITY_PATH "\$BRIDGE_DIR\/device-identity\.json"/);
  assert.match(script, /write_env_line TROOPER_DIAGNOSTICS_DIR "\$OPENCLAW_DATA_DIR\/diagnostics"/);
  assert.match(script, /write_env_line PATH "\$PATH"/);
});

test('mac local installer can install and start a CLI Docker runtime with Colima', () => {
  assert.match(script, /OPENCLAW_DOCKER_IMAGE="\$\{OPENCLAW_DOCKER_IMAGE:-ghcr\.io\/absurdfounder\/trooper-gateway:latest\}"/);
  assert.match(script, /OPENCLAW_GATEWAY_CONTAINER="\$\{OPENCLAW_GATEWAY_CONTAINER:-openclaw-openclaw-gateway-1\}"/);
  assert.match(script, /docker pull "\$OPENCLAW_DOCKER_IMAGE"/);
  assert.match(script, /write_env_line OPENCLAW_GATEWAY_CONTAINER "\$OPENCLAW_GATEWAY_CONTAINER"/);
  assert.match(script, /download\.docker\.com\/mac\/static\/stable\/\$\{docker_arch\}\/docker-\$\{DOCKER_CLI_VERSION\}\.tgz/);
  assert.match(script, /github\.com\/lima-vm\/lima\/releases\/download\/v\$\{LIMA_VERSION\}/);
  assert.match(script, /github\.com\/abiosoft\/colima\/releases\/download\/\$\{COLIMA_VERSION\}/);
  assert.match(script, /github\.com\/docker\/compose\/releases\/download\/\$\{DOCKER_COMPOSE_VERSION\}/);
  assert.match(script, /github\.com\/docker\/buildx\/releases\/download\/\$\{DOCKER_BUILDX_VERSION\}/);
  assert.match(script, /colima start --runtime docker --vm-type vz --mount-type virtiofs/);
  assert.match(script, /NONINTERACTIVE=1 \/bin\/bash -c "\$\(curl -fsSL https:\/\/raw\.githubusercontent\.com\/Homebrew\/install\/HEAD\/install\.sh\)"/);
  assert.match(script, /load_homebrew_path/);
  assert.match(script, /brew install colima docker docker-compose docker-buildx/);
  assert.match(script, /mkdir -p "\$HOME\/\.docker\/cli-plugins"/);
  assert.match(script, /docker-compose" "\$HOME\/\.docker\/cli-plugins\/docker-compose"/);
  assert.match(script, /docker-buildx" "\$HOME\/\.docker\/cli-plugins\/docker-buildx"/);
  assert.match(script, /colima start/);
  assert.doesNotMatch(script, /open "https:\/\/brew\.sh\/"/);
  assert.match(script, /docker rm -f "\$\{OPENCLAW_GATEWAY_CONTAINER\}" trooper-local-gateway/);
  assert.match(script, /docker run --name "\$\{OPENCLAW_GATEWAY_CONTAINER\}" --pull=missing/);
  assert.match(script, /-v "\$\{OPENCLAW_DATA_DIR\}:\/home\/node\/\.openclaw"/);
});

test('mac local installer unloads stale LaunchAgents before bootstrapping', () => {
  assert.match(script, /launchctl bootout "gui\/\$\(id -u\)\/\$label"/);
  assert.match(script, /launchctl bootout "gui\/\$\(id -u\)" "\$PLIST_DIR\/\$label\.plist"/);
  assert.match(script, /launchctl print "gui\/\$\(id -u\)\/\$label"/);
});

test('mac local installer can use an existing Docker Desktop fallback', () => {
  assert.match(script, /\/Applications\/Docker\.app\/Contents\/Resources\/bin/);
  assert.match(script, /open -a Docker/);
  assert.match(script, /TROOPER_SKIP_DOCKER_DESKTOP/);
});
