/**
 * The bundled ffmpeg binary (npm ffmpeg-static) and how it is run.
 *
 * The Function runs on AWS Lambda linux/arm64. `blueprints deploy` installs the function's
 * dependencies on the deploying machine, so ffmpeg-static downloads the binary for that machine
 * unless the deploy runs with npm_config_platform=linux npm_config_arch=arm64 (see README.md).
 * The binary is therefore checked against the sha256 of the linux-arm64 build before it is
 * used, and the conversion fails with a clear message (fail closed) when it does not match.
 */
import {spawn} from 'node:child_process'
import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {access, constants as fsConstants, stat} from 'node:fs/promises'
import {pipeline} from 'node:stream/promises'

/**
 * sha256 of ffmpeg-static@5.3.0's linux-arm64 binary: John Van Sickle's static build
 * ffmpeg-7.0.2-arm64-static, 51,134,160 bytes, GPLv3, with libx264 (measured by the spike,
 * docs/sanity-migration/reports/video-spike.md).
 */
export const FFMPEG_LINUX_ARM64_SHA256 =
  '6bb182d0d75d23028db82e9e4f723ca69b853d055698486e6984ddb2c06fb8ce'

export class FfmpegUnavailableError extends Error {
  override name = 'FfmpegUnavailableError'
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

export async function sha1File(file: string): Promise<string> {
  const hash = createHash('sha1')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

/** Path of the ffmpeg-static binary for this platform. */
export async function ffmpegStaticPath(): Promise<string> {
  // ffmpeg-static is CommonJS (`module.exports = path`), so its default import is the path.
  const imported: unknown = await import('ffmpeg-static')
  const binary = (imported as {default?: unknown}).default
  if (typeof binary !== 'string' || binary === '') {
    throw new FfmpegUnavailableError(
      `ffmpeg-static has no binary for ${process.platform}/${process.arch}`,
    )
  }
  return binary
}

const verified = new Map<string, Promise<string>>()

/**
 * Checks that `binary` exists, is executable and has `expectedSha256`, once per path and
 * container. Resolves to the path.
 */
export function verifyFfmpegBinary(binary: string, expectedSha256: string): Promise<string> {
  const cacheKey = `${binary}\n${expectedSha256}`
  let check = verified.get(cacheKey)
  if (!check) {
    check = (async () => {
      try {
        await access(binary, fsConstants.X_OK)
      } catch (error) {
        throw new FfmpegUnavailableError(
          `the bundled ffmpeg at ${binary} is missing or not executable (${(error as Error).message})`,
        )
      }
      const [actual, info] = await Promise.all([sha256File(binary), stat(binary)])
      if (actual !== expectedSha256) {
        throw new FfmpegUnavailableError(
          `the bundled ffmpeg (${info.size} bytes, sha256 ${actual}) is not the expected ` +
            `${process.platform}/${process.arch} build (sha256 ${expectedSha256}); redeploy the ` +
            'Function with npm_config_platform=linux npm_config_arch=arm64',
        )
      }
      return binary
    })()
    // A failed check is not cached, so a transient read error can be retried by the next run.
    check.catch(() => verified.delete(cacheKey))
    verified.set(cacheKey, check)
  }
  return check
}

export interface ProcessResult {
  code: number | null
  signal: NodeJS.Signals | null
  /** The last STDERR_TAIL_BYTES of stderr, without the lines `onStderrLine` consumed. */
  stderr: string
  killedAtDeadline: boolean
  wallMs: number
}

export interface RunFfmpegOptions {
  /**
   * Called with every complete stderr line (and the last, unterminated one). Return true to
   * consume the line, so it is left out of `stderr`; for example the per-frame showinfo lines,
   * which would otherwise push the error messages out of the kept tail.
   */
  onStderrLine?: (line: string) => boolean
}

const STDERR_TAIL_BYTES = 16_000

/**
 * Runs ffmpeg asynchronously (never spawnSync: the range proxy serving its input runs on the same
 * event loop). It is killed with SIGKILL at `deadline` (epoch ms).
 */
export function runFfmpeg(
  binary: string,
  args: string[],
  deadline: number,
  options: RunFfmpegOptions = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    if (deadline <= started) {
      resolve({code: null, signal: null, stderr: '', killedAtDeadline: true, wallMs: 0})
      return
    }
    const child = spawn(binary, args, {stdio: ['ignore', 'ignore', 'pipe']})
    let stderr = ''
    let partial = ''
    let lineError: unknown
    let killedAtDeadline = false
    const keep = (line: string) => {
      if (lineError === undefined && options.onStderrLine) {
        try {
          if (options.onStderrLine(line)) return
        } catch (error) {
          // A line the caller cannot handle ends the run; the error is raised once ffmpeg exits.
          lineError = error
          child.kill('SIGKILL')
        }
      }
      stderr = (stderr + line + '\n').slice(-STDERR_TAIL_BYTES)
    }
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      const lines = (partial + chunk).split(/\r?\n/)
      partial = lines.pop() ?? ''
      for (const line of lines) keep(line)
    })
    const timer = setTimeout(() => {
      killedAtDeadline = true
      child.kill('SIGKILL')
    }, deadline - started)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (partial !== '') keep(partial)
      if (lineError !== undefined) {
        reject(lineError)
        return
      }
      resolve({code, signal, stderr, killedAtDeadline, wallMs: Date.now() - started})
    })
  })
}
