import {execFile} from 'node:child_process'
import {createHash} from 'node:crypto'
import {createReadStream, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs'
import path from 'node:path'

export async function hashFile(filePath: string, algorithm: 'sha1' | 'sha256'): Promise<string> {
  const hash = createHash(algorithm)
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** Writes JSON atomically (temp file + rename) so an interrupted run never leaves half a file. */
export function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), {recursive: true})
  const tmp = `${filePath}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  renameSync(tmp, filePath)
}

export function writeText(filePath: string, text: string): void {
  mkdirSync(path.dirname(filePath), {recursive: true})
  const tmp = `${filePath}.tmp-${process.pid}`
  writeFileSync(tmp, text)
  renameSync(tmp, filePath)
}

export function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T
}

export interface RunResult {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * Runs a command without a shell and fails with its output when it exits non-zero, unless the
 * exit code is one of `okExitCodes` (for tools that report findings with an exit code).
 * `secretValues` are masked in any error message, in case a tool echoes them.
 */
export function run(
  command: string,
  args: string[],
  options: {cwd?: string; env?: NodeJS.ProcessEnv; secretValues?: string[]; timeoutMs?: number; okExitCodes?: number[]} = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        env: options.env ?? process.env,
        maxBuffer: 256 * 1024 * 1024,
        timeout: options.timeoutMs ?? 0,
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code === 'number' && !error.killed && (options.okExitCodes ?? []).includes(error.code)) {
          resolve({stdout: String(stdout), stderr: String(stderr), exitCode: error.code})
          return
        }
        if (error) {
          const mask = (text: string) =>
            (options.secretValues ?? []).reduce(
              (acc, secret) => (secret ? acc.split(secret).join('<redacted>') : acc),
              text,
            )
          reject(
            new Error(
              `${command} ${args.join(' ')} failed (${error.code ?? error.signal ?? 'error'}):\n` +
                mask(String(stderr || stdout || error.message)).slice(-8000),
            ),
          )
          return
        }
        resolve({stdout: String(stdout), stderr: String(stderr), exitCode: 0})
      },
    )
  })
}

export function log(message: string): void {
  process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${message}\n`)
}

/** Stable JSON (sorted object keys) for comparing documents regardless of key order. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Groups items by a key, keeping first-seen order. */
export function groupBy<T, K>(items: Iterable<T>, key: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>()
  for (const item of items) {
    const k = key(item)
    const list = groups.get(k)
    if (list) list.push(item)
    else groups.set(k, [item])
  }
  return groups
}
