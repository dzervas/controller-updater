/** Experimental Sony DualSense updater: HID feature reports F4/F5.
 * Adapted from nchie/dualsense-updater-rs (MIT). Firmware comes from Sony's
 * index (bundled snapshot or proxy, see dualsense-feed.ts) or a local file.
 * Explicitly fail closed for unsupported hardware and unexpected statuses.
 */
import {
  downloadDualSenseFirmware,
  fetchDualSenseFeed,
  sonyFirmwareUrl,
  type DualSenseFeed,
  type DualSenseFirmware,
} from "../dualsense-feed.js";
import { sha256Base64Url } from "../feed.js";
import { addKv, byId, clear, compactBytes, errorMessage, setStatus } from "../ui.js";
import type { ControllerTool, Detection } from "./types.js";

interface HidDevice {
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
  readonly opened: boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  receiveFeatureReport(reportId: number): Promise<DataView>;
  sendFeatureReport(reportId: number, data: BufferSource): Promise<void>;
}
interface HidApi {
  getDevices(): Promise<HidDevice[]>;
  requestDevice(options: {filters: {vendorId: number; productId: number}[]}): Promise<HidDevice[]>;
}

const VENDOR = 0x054c;
const PRODUCT = 0x0ce6;
const INFO_REPORT = 0x20;
const COMMAND_REPORT = 0xf4;
const STATUS_REPORT = 0xf5;
const HEADER_SIZE = 256;
const CHUNK_SIZE = 0x39;
const BLOCK_SIZE = 0x8000;
const MAX_IMAGE_SIZE = 4 * 1024 * 1024;
// The reference polls without a limit; StartUpdate erases flash first.
const COMMAND_TIMEOUT_MS = 60_000;

// Board byte (hw_info bits 8-15) -> board name, from dualshock-tools
// (ds5-controller.js hwToBoardModel). BDM-020..050 -> target follows the
// dualsense-updater-rs README. The BDM-060 variants do not all share a target:
// each image header carries a board byte at 0x6d (0004: 0x13, 000B: 0x11,
// 000E: 0x09), and a BDM-060M (0x11, main firmware 0x0110xxxx) rejected the
// 000E image (main firmware 0x010dxxxx) with a header CMAC error. A wrong
// target is rejected at StartUpdate before anything is written, and the
// target can be overridden in the page.
const BOARDS: Record<number, {board: string; target: string}> = {
  0x04: {board: "BDM-020", target: "0004"},
  0x05: {board: "BDM-030", target: "0004"},
  0x06: {board: "BDM-040", target: "0004"},
  0x07: {board: "BDM-050", target: "000B"},
  0x08: {board: "BDM-050", target: "000B"},
  0x09: {board: "BDM-060R", target: "000E"},
  0x11: {board: "BDM-060M", target: "000B"},
  0x13: {board: "BDM-060X", target: "0004"},
};

// F5 status codes, named as in dualsense-updater-rs protocol.rs.
const STATUS_NAMES: Record<number, Record<number, string>> = {
  0: {
    0x01: "header CMAC check error", 0x02: "header version check error (not newer)",
    0x03: "header capability info error (wrong target?)", 0x05: "flash erase error",
    0x06: "header info not received", 0x11: "header common param error",
  },
  1: {
    0x02: "flash write error", 0x04: "update not started", 0x11: "common param error",
  },
  2: {
    0x01: "header CMAC check error", 0x02: "header version check error",
    0x03: "capability info error", 0x04: "firmware body CMAC check error",
    0x11: "common param error",
  },
};

function hid(): HidApi | null {
  return (navigator as Navigator & {hid?: HidApi}).hid ?? null;
}

function expectDevice(device: HidDevice): void {
  if (device.vendorId !== VENDOR || device.productId !== PRODUCT)
    throw new Error("Unsupported device: expected standard wired DualSense (054c:0ce6).");
}

interface ImageHeader { productId: number; target: string; version: number }

/** Header fields checked against all of Sony's images: PID 0x62, target 0x74, version 0x78. */
function parseImage(bytes: Uint8Array): ImageHeader {
  if (bytes.length < HEADER_SIZE || bytes.length > MAX_IMAGE_SIZE)
    throw new Error("Invalid firmware size.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    productId: view.getUint16(0x62, true),
    target: view.getUint16(0x74, true).toString(16).toUpperCase().padStart(4, "0"),
    version: view.getUint16(0x78, true),
  };
}

function hex(value: number, digits = 4): string { return `0x${value.toString(16).padStart(digits, "0")}`; }
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Chromium returns feature reports with the report ID as byte 0, like hidapi. */
async function featureReport(device: HidDevice, reportId: number): Promise<DataView> {
  const report = await device.receiveFeatureReport(reportId);
  if (report.byteLength < 1 || report.getUint8(0) !== reportId)
    throw new Error(`Feature report ${hex(reportId, 2)} came back without its report ID.`);
  return report;
}

interface DeviceInfo { version: number; date: string; time: string; hwInfo: number; fwVersion: number }

function parseInfo(report: DataView): DeviceInfo {
  // Offsets include the report ID byte, as in dualsense-updater-rs and dualshock-tools.
  if (report.byteLength < 46) throw new Error("Firmware info report is too short.");
  const ascii = (start: number, end: number) =>
    Array.from(new Uint8Array(report.buffer, report.byteOffset + start, end - start))
      .map((value) => String.fromCharCode(value)).join("").replace(/\0.*$/, "").trim();
  return {
    date: ascii(1, 12),
    time: ascii(12, 20),
    hwInfo: report.getUint32(24, true),
    fwVersion: report.getUint32(28, true),
    version: report.getUint16(44, true),
  };
}

async function command(device: HidDevice, kind: number, bytes: Uint8Array): Promise<void> {
  for (let offset = 0; offset < Math.max(1, bytes.length); offset += CHUNK_SIZE) {
    const part = bytes.subarray(offset, offset + CHUNK_SIZE);
    const packet = new Uint8Array(2 + part.length);
    packet[0] = kind;
    packet[1] = part.length;
    packet.set(part, 2);
    await device.sendFeatureReport(COMMAND_REPORT, packet);
  }
}

async function status(device: HidDevice, expectedCommand: number): Promise<number> {
  // [0xf5, command, status, ...]
  const report = await featureReport(device, STATUS_REPORT);
  if (report.byteLength < 3 || report.getUint8(1) !== expectedCommand)
    throw new Error(`Unexpected F5 response to command ${expectedCommand}.`);
  return report.getUint8(2);
}

async function waitFor(
  device: HidDevice, kind: number, pending: number[], accepted: number[],
): Promise<number> {
  const deadline = Date.now() + COMMAND_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await status(device, kind);
    if (accepted.includes(result)) return result;
    if (!pending.includes(result)) {
      const name = STATUS_NAMES[kind]?.[result];
      throw new Error(`Firmware command ${kind} failed with status ${hex(result, 2)}` +
        `${name ? ` (${name})` : ""}.`);
    }
    await sleep(10);
  }
  throw new Error(`Timeout waiting for firmware command ${kind}.`);
}

async function flash(
  device: HidDevice, image: Uint8Array, progress: (fraction: number) => void,
  log: (message: string) => void,
): Promise<void> {
  expectDevice(device);
  log("Starting update. DO NOT DISCONNECT THE CONTROLLER.");
  await command(device, 0, image.subarray(0, HEADER_SIZE));
  await waitFor(device, 0, [0x04, 0x10], [0x00]);
  log("Header accepted.");

  // The reference updater sends 0x8000-byte blocks subdivided into 57-byte
  // F4 feature reports. Read acknowledgement after EACH sub-report.
  for (let block = 0; block < image.length; block += BLOCK_SIZE) {
    const data = image.subarray(block, block + BLOCK_SIZE);
    for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
      const fragment = data.subarray(offset, offset + CHUNK_SIZE);
      await command(device, 1, fragment);
      await waitFor(device, 1, [0x01, 0x10], [0x00, 0x03]);
    }
    progress(Math.min(0.98, (block + data.length) / image.length));
    log(`Sent ${Math.min(image.length, block + data.length)} / ${image.length} bytes`);
  }
  await command(device, 2, new Uint8Array());
  await waitFor(device, 2, [0x10], [0x00]);
  log("Image verified by the controller.");
  await command(device, 3, new Uint8Array());
  progress(1);
  log("Finalize command sent. Reconnect to check the reported version.");
}

export function createDualSenseTool(): ControllerTool {
  const flow = byId<HTMLElement>("dualsense-flow");
  const help = byId<HTMLElement>("dualsense-help");
  const connect = byId<HTMLButtonElement>("ds-connect");
  const connectionStatus = byId<HTMLElement>("ds-status");
  const infoEl = byId<HTMLElement>("ds-info");
  const feedStatus = byId<HTMLElement>("ds-feed-status");
  const feedInfo = byId<HTMLElement>("ds-feed-info");
  const targetSelect = byId<HTMLSelectElement>("ds-target");
  const downloadBtn = byId<HTMLButtonElement>("ds-download");
  const manualLink = byId<HTMLAnchorElement>("ds-manual-link");
  const downloadProgress = byId<HTMLProgressElement>("ds-download-progress");
  const picker = byId<HTMLInputElement>("ds-image");
  const imageStatus = byId<HTMLElement>("ds-image-status");
  const confirm = byId<HTMLInputElement>("ds-confirm");
  const update = byId<HTMLButtonElement>("ds-update");
  const updateStatus = byId<HTMLElement>("ds-update-status");
  const progress = byId<HTMLProgressElement>("ds-progress");
  const logEl = byId<HTMLPreElement>("ds-log");
  let device: HidDevice | null = null;
  let info: DeviceInfo | null = null;
  let feed: DualSenseFeed | null = null;
  let image: Uint8Array | null = null;
  let busy = false;

  const selected = (): DualSenseFirmware | null =>
    feed?.firmware.find((entry) => entry.target === targetSelect.value) ?? null;
  const detectedTarget = (): string | null =>
    info ? BOARDS[(info.hwInfo >> 8) & 0xff]?.target ?? null : null;

  function ready(): void {
    update.disabled = busy || !device?.opened || !image || !confirm.checked;
    connect.disabled = busy;
    picker.disabled = busy;
    confirm.disabled = busy;
    targetSelect.disabled = busy || !feed;
    downloadBtn.disabled = busy || !selected();
  }
  const log = (message: string) => { logEl.textContent += `${message}\n`; };

  function clearImage(): void {
    image = null;
    confirm.checked = false;
    setStatus(imageStatus, "", "");
  }

  /** Render the feed entry for the selected target and how it compares to the controller. */
  function renderFirmware(): void {
    clear(feedInfo);
    const entry = selected();
    manualLink.hidden = !entry;
    if (!feed) return;
    addKv(feedInfo, "Source", feed.source === "bundled" ? "Sony index (bundled snapshot)" : "Sony index (live, via proxy)");
    if (info) {
      const board = BOARDS[(info.hwInfo >> 8) & 0xff];
      addKv(feedInfo, "Hardware", `${hex(info.hwInfo, 8)}${board ? ` · ${board.board}` : " · unknown board"}`);
    }
    if (!entry) {
      setStatus(feedStatus, info
        ? "Could not map this controller's board to a firmware target. Choose the target manually."
        : "Connect the controller to select its firmware target, or choose one.", "warn");
      return;
    }
    manualLink.href = sonyFirmwareUrl(entry);
    addKv(feedInfo, "Target", `FWUPDATE${entry.target}${entry.target === detectedTarget() ? " (auto-detected)" : ""}`);
    addKv(feedInfo, "Latest", entry.version);
    if (!info) {
      setStatus(feedStatus, `Latest FWUPDATE${entry.target} is ${entry.version}.`, "ok");
      return;
    }
    const latest = parseInt(entry.version, 16);
    addKv(feedInfo, "Controller", hex(info.version));
    if (latest > info.version) {
      setStatus(feedStatus, `Update available: ${hex(info.version)} → ${entry.version}. Download it, or choose a file you already have.`, "ok");
    } else {
      setStatus(feedStatus, `Controller is up to date (${hex(info.version)}; latest ${entry.version}).`, "ok");
    }
  }

  function selectTarget(target: string): void {
    targetSelect.value = feed?.firmware.some((entry) => entry.target === target) ? target : "";
    clearImage();
    renderFirmware();
    ready();
  }

  async function loadFeed(): Promise<void> {
    setStatus(feedStatus, "Looking up Sony's firmware index…", "busy");
    try {
      feed = await fetchDualSenseFeed();
      clear(targetSelect);
      targetSelect.append(new Option("Choose…", ""));
      for (const entry of feed.firmware)
        targetSelect.append(new Option(`FWUPDATE${entry.target} (${entry.version})`, entry.target));
      selectTarget(detectedTarget() ?? "");
    } catch (error) {
      feed = null;
      setStatus(feedStatus, `Could not load Sony's firmware index: ${errorMessage(error)}. ` +
        "Choose a local FWUPDATE*.bin instead.", "error");
      ready();
    }
  }

  /** Accept an image only if its header matches this controller and the selected target. */
  async function loadImage(bytes: Uint8Array, label: string): Promise<void> {
    const header = parseImage(bytes);
    const entry = selected();
    if (!entry) throw new Error("Choose the firmware target first.");
    if (header.target !== entry.target)
      throw new Error(`Image is for target ${header.target}, not the selected ${entry.target}.`);
    if (header.productId !== PRODUCT)
      throw new Error(`Image is for USB product ${hex(header.productId)}, not 054c:0ce6.`);
    if (info && header.version <= info.version)
      throw new Error(`Image ${hex(header.version)} is not newer than ${hex(info.version)}.`);
    const verified = Boolean(entry.sha256) && entry.version === hex(header.version) &&
      (await sha256Base64Url(bytes)) === entry.sha256;
    image = bytes;
    setStatus(imageStatus,
      `${label}: ${compactBytes(bytes.length)}, FWUPDATE${header.target} ${hex(header.version)}. ` +
        (verified ? "SHA-256 matches the bundled snapshot. " : "Not checked against a bundled hash. ") +
        "The controller verifies Sony's signature before committing.", verified ? "ok" : "warn");
  }

  async function attach(next: HidDevice): Promise<void> {
    expectDevice(next);
    if (device && device !== next && device.opened) await device.close();
    device = next;
    clearImage();
    if (!device.opened) await device.open();
    info = parseInfo(await featureReport(device, INFO_REPORT));
    infoEl.replaceChildren();
    addKv(infoEl, "Product", device.productName);
    addKv(infoEl, "Firmware version", hex(info.version));
    addKv(infoEl, "Build", `${info.date} ${info.time}`);
    addKv(infoEl, "Main firmware", hex(info.fwVersion, 8));
    setStatus(connectionStatus, "Connected; firmware metadata read.", "ok");
    if (feed) selectTarget(detectedTarget() ?? targetSelect.value);
    ready();
  }

  connect.addEventListener("click", async () => {
    const api = hid();
    if (!api) { setStatus(connectionStatus, "WebHID is unavailable; use desktop Chromium.", "error"); return; }
    try {
      const chosen = await api.requestDevice({filters: [{vendorId: VENDOR, productId: PRODUCT}]});
      if (!chosen.length) return;
      await attach(chosen[0]);
    } catch (error) {
      setStatus(connectionStatus, errorMessage(error), "error");
    }
  });

  targetSelect.addEventListener("change", () => selectTarget(targetSelect.value));

  downloadBtn.addEventListener("click", async () => {
    const entry = selected();
    if (!feed || !entry || busy) return;
    busy = true; ready();
    clearImage();
    downloadProgress.hidden = false;
    downloadProgress.removeAttribute("value");
    try {
      const bytes = await downloadDualSenseFirmware(feed, entry, ({received, total}) => {
        if (total > 0) downloadProgress.value = Math.min(1, received / total);
        setStatus(imageStatus, `Downloading ${compactBytes(received)}…`, "busy");
      });
      downloadProgress.value = 1;
      await loadImage(bytes, `FWUPDATE${entry.target}.bin`);
    } catch (error) {
      setStatus(imageStatus, `Download failed: ${errorMessage(error)}. ` +
        "Use Direct download, then choose the file.", "error");
    } finally {
      busy = false; ready();
    }
  });

  picker.addEventListener("change", async () => {
    const file = picker.files?.[0];
    picker.value = "";
    if (!file) return;
    clearImage();
    try {
      await loadImage(new Uint8Array(await file.arrayBuffer()), file.name);
    } catch (error) {
      setStatus(imageStatus, errorMessage(error), "error");
    }
    ready();
  });
  confirm.addEventListener("change", ready);

  update.addEventListener("click", async () => {
    if (!device?.opened || !image || !confirm.checked || busy) return;
    busy = true; ready();
    progress.hidden = false; progress.value = 0;
    logEl.textContent = "";
    try {
      setStatus(updateStatus, "Flashing; do not disconnect.", "busy");
      await flash(device, image, (fraction) => {progress.value = fraction;}, log);
      setStatus(updateStatus, "Finalize sent; reconnect and verify firmware.", "ok");
    } catch (error) {
      log(errorMessage(error));
      setStatus(updateStatus, `Update stopped: ${errorMessage(error)}`, "error");
    } finally {
      busy = false; confirm.checked = false; ready();
    }
  });

  if (!hid()) setStatus(connectionStatus, "WebHID unavailable (desktop Chromium required).", "warn");
  void loadFeed();
  return {
    id: "dualsense", tabLabel: "DualSense", flow, help,
    async detect(): Promise<Detection> {
      const known = await hid()?.getDevices() ?? [];
      if (known.some((item) => item.vendorId === VENDOR && item.productId === PRODUCT))
        return {detected: true, detail: "Previously authorized HID device available."};
      // Chromium gamepad ids end in "(… Vendor: 054c Product: 0ce6)".
      const pad = Array.from(navigator.getGamepads?.() ?? [])
        .some((candidate) => candidate && /Vendor: 054c Product: 0ce6/i.test(candidate.id));
      return {detected: pad, detail: pad ? "DualSense gamepad detected; press Connect DualSense." : ""};
    },
    activate(): void { ready(); },
    deactivate(): void { /* Do not close an in-progress flash on tab switch. */ },
  };
}
