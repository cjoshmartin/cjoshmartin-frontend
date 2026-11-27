/**
 * ffmpeg for the media tests. By default the ffmpeg on PATH. With FFMPEG_LINUX_ARM64 set to the
 * path of ffmpeg-static 5.3.0's linux-arm64 binary (the Function's ffmpeg 7.0.2), it runs that
 * binary in Docker (public.ecr.aws/lambda/nodejs:24, linux/arm64), so the tests exercise exactly
 * what runs in the Function. Every absolute path in the arguments is mounted at the same path.
 */
import {spawn} from 'node:child_process'
import path from 'node:path'

import type {FfmpegRunner} from '../video-strip'

export const LINUX_FFMPEG = process.env.FFMPEG_LINUX_ARM64

function exec(command: string, args: string[]): Promise<{code: number | null; stderr: string}> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {stdio: ['ignore', 'ignore', 'pipe']})
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-64_000)
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({code, stderr}))
  })
}

/** A runner for `ffmpeg`; `mounts` are the directories the arguments refer to (Docker only). */
export function ffmpegRunner(mounts: string[]): FfmpegRunner {
  return async (args) => {
    if (!LINUX_FFMPEG) {
      const result = await exec('ffmpeg', args)
      return {...result, killedAtDeadline: false}
    }
    const volumes = [...new Set(mounts.map((m) => path.resolve(m)))].flatMap((dir) => ['-v', `${dir}:${dir}`])
    const result = await exec('docker', [
      'run',
      '--rm',
      '--platform',
      'linux/arm64',
      '-v',
      `${LINUX_FFMPEG}:/opt/ffmpeg:ro`,
      ...volumes,
      '--entrypoint',
      '/opt/ffmpeg',
      'public.ecr.aws/lambda/nodejs:24',
      ...args,
    ])
    return {...result, killedAtDeadline: false}
  }
}
