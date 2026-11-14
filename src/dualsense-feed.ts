/**
 * Sony's DualSense firmware index (fwupdater.dl.playstation.net).
 *
 * Like the Xbox feed, the deployed page reads a bundled snapshot from
 * ./data/dualsense/ because Sony's CDN has no CORS headers. Without a snapshot
 * it reads info.json and the image through the public allorigins proxy.
 */

import { downloadFirmware, proxyUrl, sha256Base64Url, type DownloadProgress } from "./feed.js";

export const SONY_BASE_URL = "https://fwupdater.dl.playstation.net/fwupdater/";
export const SONY_INFO_URL = `${SONY_BASE_URL}info.json`;
const LOCAL_DIR = "./data/dualsense/";

export interface DualSenseFirmware {
  /** Updater target, e.g. "000E". */
  target: string;
  /** Update version as Sony writes it, e.g. "0x0641". */
  version: string;
  /** Path relative to Sony's base URL and to the bundled snapshot. */
  file: string;
  /** Bundled snapshots only; a live entry has no size or hash. */
  size?: number;
  sha256?: string;
}

export interface DualSenseFeed {
  source: "bundled" | "live";
  firmware: DualSenseFirmware[];
}

export async function fetchDualSenseFeed(): Promise<DualSenseFeed> {
  try {
    const local = await fetch(`${LOCAL_DIR}feed.json`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (local.ok) {
      const feed = (await local.json()) as { firmware?: DualSenseFirmware[] };
      if (Array.isArray(feed.firmware) && feed.firmware.length > 0) {
        return { source: "bundled", firmware: feed.firmware };
      }
    }
  } catch {
    // No snapshot (or a broken one): use the live proxy below.
  }

  const response = await fetch(proxyUrl(SONY_INFO_URL), {
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Sony firmware index request failed: HTTP ${response.status}`);
  const info = (await response.json()) as Record<string, string>;
  const firmware: DualSenseFirmware[] = [];
  for (const [key, version] of Object.entries(info)) {
    const target = key.match(/^FwUpdate([0-9A-F]{4})LatestVersion$/i)?.[1];
    if (target && /^0x[0-9a-f]{4}$/i.test(version)) {
      firmware.push({ target, version, file: `fwupdate${target}/${version}/FWUPDATE${target}.bin` });
    }
  }
  if (firmware.length === 0) throw new Error("Sony firmware index lists no targets");
  return { source: "live", firmware };
}

export function sonyFirmwareUrl(firmware: DualSenseFirmware): string {
  return SONY_BASE_URL + firmware.file;
}

export async function downloadDualSenseFirmware(
  feed: DualSenseFeed,
  firmware: DualSenseFirmware,
  onProgress: (progress: DownloadProgress) => void,
): Promise<Uint8Array> {
  const url = feed.source === "bundled" ? LOCAL_DIR + firmware.file : sonyFirmwareUrl(firmware);
  const bytes = await downloadFirmware(url, onProgress);
  if (firmware.size !== undefined && bytes.length !== firmware.size) {
    throw new Error(`firmware size mismatch: got ${bytes.length} bytes, expected ${firmware.size}`);
  }
  if (firmware.sha256) {
    const actual = await sha256Base64Url(bytes);
    if (actual !== firmware.sha256) {
      throw new Error(`SHA-256 mismatch: got ${actual}, expected ${firmware.sha256}`);
    }
  }
  return bytes;
}
