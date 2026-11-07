import net from 'node:net';

/**
 * A minimal RESP server for exercising the real node-redis client's connection
 * handling in the default test run, which has no Redis available. It understands
 * just enough of the protocol for a handshake, strings, and MULTI/EXEC, and
 * answers anything else with +OK or :0.
 */
export interface FakeRedis {
  readonly port: number;
  readonly url: string;
  /** Every command received, in order. Each is `[NAME, ...args]`, with NAME uppercased. */
  readonly commands: string[][];
  /** Connections accepted since the server was created. */
  connectionCount(): number;
  /** Connections open right now, as this server sees them. */
  openConnectionCount(): number;
  /** Return a raw RESP reply to send instead of the usual answer, such as an error. */
  reply: (command: string[]) => string | undefined;
  /** Return true to leave a command unanswered, as a stalled server would. */
  hold: (command: string[]) => boolean;
  /** Close every client connection. The server keeps listening. */
  dropConnections(): void;
  /** Stop listening and close every connection. */
  stop(): Promise<void>;
  /** Listen again on the same port. */
  start(): Promise<void>;
  /** Resolves once a command matching `predicate` has been received. */
  waitForCommand(predicate: (command: string[]) => boolean, timeoutMs?: number): Promise<void>;
}

/** Commands node-redis sends while establishing a connection. */
export const isHandshakeCommand = (command: string[]): boolean =>
  ['CLIENT', 'HELLO', 'AUTH', 'SELECT'].includes(command[0]);

/** Parse every complete RESP array in `input`; returns the commands and the unread remainder. */
function parseCommands(input: Buffer): { commands: string[][]; rest: Buffer } {
  const commands: string[][] = [];
  let offset = 0;
  const readLine = (from: number): { line: string; next: number } | undefined => {
    const end = input.indexOf('\r\n', from);
    return end === -1 ? undefined : { line: input.toString('utf8', from, end), next: end + 2 };
  };
  for (;;) {
    const header = readLine(offset);
    if (!header) break;
    let cursor = header.next;
    const args: string[] = [];
    let complete = true;
    for (let i = 0; i < Number(header.line.slice(1)); i++) {
      const size = readLine(cursor);
      if (!size) {
        complete = false;
        break;
      }
      const length = Number(size.line.slice(1));
      if (input.length < size.next + length + 2) {
        complete = false;
        break;
      }
      args.push(input.toString('utf8', size.next, size.next + length));
      cursor = size.next + length + 2;
    }
    if (!complete) break;
    commands.push([args[0].toUpperCase(), ...args.slice(1)]);
    offset = cursor;
  }
  return { commands, rest: input.subarray(offset) };
}

export async function startFakeRedis(options?: { auth?: 'reject' }): Promise<FakeRedis> {
  const values = new Map<string, string>();
  const sockets = new Set<net.Socket>();
  const commands: string[][] = [];
  const waiters: Array<{ predicate: (command: string[]) => boolean; resolve: () => void }> = [];
  let connections = 0;

  const respond = (command: string[], state: { queued: string[][] | null }): string => {
    const [name, ...args] = command;
    if (name === 'AUTH' && options?.auth === 'reject') {
      return '-WRONGPASS invalid username-password pair\r\n';
    }
    if (name === 'MULTI') {
      state.queued = [];
      return '+OK\r\n';
    }
    if (name === 'EXEC') {
      const queued = state.queued ?? [];
      state.queued = null;
      return `*${queued.length}\r\n${queued.map((c) => respond(c, state)).join('')}`;
    }
    if (state.queued) {
      state.queued.push(command);
      return '+QUEUED\r\n';
    }
    switch (name) {
      case 'PING':
        return '+PONG\r\n';
      case 'SET':
        values.set(args[0], args[1]);
        return '+OK\r\n';
      case 'GET': {
        const value = values.get(args[0]);
        return value === undefined ? '$-1\r\n' : `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
      }
      case 'SCARD':
      case 'ZCARD':
      case 'SADD':
      case 'SREM':
      case 'DEL':
      case 'EXPIRE':
      case 'ZADD':
      case 'ZREM':
      case 'RPUSH':
      case 'HSET':
        return ':0\r\n';
      case 'HGET':
        return '$-1\r\n';
      case 'HGETALL':
      case 'SMEMBERS':
      case 'ZRANGE':
      case 'LRANGE':
        return '*0\r\n';
      default:
        return '+OK\r\n';
    }
  };

  const fake: FakeRedis = {
    port: 0,
    url: '',
    commands,
    connectionCount: () => connections,
    openConnectionCount: () => sockets.size,
    reply: () => undefined,
    hold: () => false,
    dropConnections() {
      for (const socket of sockets) socket.destroy();
    },
    async stop() {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      fake.dropConnections();
      await closed;
    },
    async start() {
      server = createServer();
      await new Promise<void>((resolve) => server.listen(fake.port, '127.0.0.1', resolve));
    },
    waitForCommand(predicate, timeoutMs = 2000) {
      if (commands.some(predicate)) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('fake redis: timed out waiting for a command')),
          timeoutMs,
        );
        waiters.push({
          predicate,
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
        });
      });
    },
  };

  const createServer = () =>
    net.createServer((socket) => {
      connections++;
      sockets.add(socket);
      // Only the client's sockets should show up as keeping the process alive.
      socket.unref();
      let buffered = Buffer.alloc(0) as Buffer;
      const state: { queued: string[][] | null } = { queued: null };
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
      socket.on('data', (chunk) => {
        const parsed = parseCommands(Buffer.concat([buffered, chunk as Buffer]));
        buffered = parsed.rest;
        for (const command of parsed.commands) {
          commands.push(command);
          for (const waiter of [...waiters]) {
            if (waiter.predicate(command)) {
              waiters.splice(waiters.indexOf(waiter), 1);
              waiter.resolve();
            }
          }
          if (fake.hold(command)) continue;
          socket.write(fake.reply(command) ?? respond(command, state));
        }
      });
    });

  let server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  (fake as { port: number }).port = port;
  (fake as { url: string }).url = `redis://127.0.0.1:${port}`;
  return fake;
}
