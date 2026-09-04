export interface RunpodConnection {
  username: string;
  hostname: string;
  port: number;
  identityFile?: string;
}

export type RunpodConnectionErrorCode = 'missing' | 'invalid-format' | 'invalid-field';

export class RunpodConnectionError extends Error {
  constructor(readonly code: RunpodConnectionErrorCode) {
    super(
      code === 'missing'
        ? 'RunPod is not configured.'
        : 'RUNPOD_CONNECTION is not a supported, valid SSH connection command.',
    );
    this.name = 'RunpodConnectionError';
  }
}

function tokenize(value: string): string[] {
  const tokens: string[] = [];
  let token = '';
  let quote: 'single' | 'double' | undefined;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '\0' || character === '\n' || character === '\r') {
      throw new RunpodConnectionError('invalid-format');
    }
    if (quote === 'single') {
      if (character === "'") quote = undefined;
      else token += character;
      continue;
    }
    if (quote === 'double') {
      if (character === '"') quote = undefined;
      else token += character;
      continue;
    }
    if (character === "'") quote = 'single';
    else if (character === '"') quote = 'double';
    else if (/\s/.test(character)) {
      if (token) tokens.push(token);
      token = '';
    } else token += character;
  }

  if (quote) throw new RunpodConnectionError('invalid-format');
  if (token) tokens.push(token);
  return tokens;
}

function validHostname(hostname: string): boolean {
  if (hostname.length < 1 || hostname.length > 253 || hostname.startsWith('-')) return false;
  if (hostname.includes(':')) return /^[0-9a-f:]+$/i.test(hostname);
  return hostname.split('.').every((label) =>
    label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
  );
}

/** Parse a narrow SSH command without invoking a shell or retaining the source value. */
export function parseRunpodConnection(value: string | undefined): RunpodConnection {
  if (!value?.trim()) throw new RunpodConnectionError('missing');
  const tokens = tokenize(value.trim());
  if (tokens.shift()?.toLowerCase() !== 'ssh') throw new RunpodConnectionError('invalid-format');

  let port = 22;
  let identityFile: string | undefined;
  let destination: string | undefined;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '-p') {
      const rawPort = tokens[++index];
      if (!rawPort || !/^\d{1,5}$/.test(rawPort)) throw new RunpodConnectionError('invalid-field');
      port = Number(rawPort);
    } else if (token === '-i') {
      identityFile = tokens[++index];
      if (!identityFile || identityFile.startsWith('-')) throw new RunpodConnectionError('invalid-field');
    } else if (!token.startsWith('-') && !destination) {
      destination = token;
    } else {
      throw new RunpodConnectionError('invalid-format');
    }
  }

  const match = /^([A-Za-z0-9._-]+)@(?:\[([0-9a-f:]+)\]|([^\s@]+))$/i.exec(destination ?? '');
  const username = match?.[1];
  const hostname = match?.[2] ?? match?.[3];
  if (!username || !hostname || !validHostname(hostname) || port < 1 || port > 65535) {
    throw new RunpodConnectionError('invalid-field');
  }

  return { username, hostname, port, identityFile };
}

export function buildSshBaseArgs(connection: RunpodConnection): string[] {
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-p', String(connection.port),
  ];
  if (connection.identityFile) args.push('-i', connection.identityFile);
  args.push(`${connection.username}@${connection.hostname}`);
  return args;
}

export function buildSshTunnelArgs(connection: RunpodConnection, localPort: number, remotePort = 11434): string[] {
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535 ||
      !Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
    throw new RunpodConnectionError('invalid-field');
  }
  const args = buildSshBaseArgs(connection);
  const destination = args.pop();
  return [...args, '-N', '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`, destination!];
}
