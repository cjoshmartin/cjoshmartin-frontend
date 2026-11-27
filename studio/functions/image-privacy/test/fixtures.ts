/**
 * Images for the tests, built byte by byte: a tiny real JPEG with and without EXIF GPS, camera
 * make and orientation, so the orchestrator runs the real stripper.
 */
import {concat} from '../../privacy/exif'

export const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAIAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAWEAEBAQAAAAAAAAAAAAAAAAAAFWL/xAAVAQEBAAAAAAAAAAAAAAAAAAAFB//EABkRAAEFAAAAAAAAAAAAAAAAAAAFFlOR8P/aAAwDAQACEQMRAD8AjdnQCtM1Jj1DLsU5NZ//2Q==',
  'base64',
)

const u16 = (n: number) => Uint8Array.from([n >> 8, n & 0xff])
const u32 = (n: number) => Uint8Array.from([n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff])

/** A big-endian EXIF block: IFD0 with Make and Orientation 6, and a GPS IFD with a latitude ref. */
function gpsExif(): Uint8Array {
  // Header (8) | IFD0: 3 entries (2 + 36 + 4 = 42) at 8 | GPS IFD: 1 entry (18) at 50 | "TestCameraMake\0" at 68.
  const make = new TextEncoder().encode('TestCameraMake\0')
  return concat([
    Uint8Array.from([0x4d, 0x4d, 0, 42]), u32(8),
    u16(3),
    u16(271), u16(2), u32(make.length), u32(68),
    u16(274), u16(3), u32(1), u16(6), u16(0),
    u16(34853), u16(4), u32(1), u32(50),
    u32(0),
    u16(1),
    u16(1), u16(2), u32(2), Uint8Array.from([0x4e, 0, 0, 0]),
    u32(0),
    make,
  ])
}

function segment(marker: number, data: Uint8Array): Uint8Array {
  return concat([Uint8Array.from([0xff, marker]), u16(data.length + 2), data])
}

/** TINY_JPEG with an EXIF APP1 segment (GPS, Make, orientation 6) after its JFIF segment. */
export function jpegWithGps(): Uint8Array {
  const jfifEnd = 2 + 2 + ((TINY_JPEG[4] << 8) | TINY_JPEG[5])
  const exif = segment(0xe1, concat([new TextEncoder().encode('Exif\0\0'), gpsExif()]))
  return concat([TINY_JPEG.subarray(0, jfifEnd), exif, TINY_JPEG.subarray(jfifEnd)])
}
