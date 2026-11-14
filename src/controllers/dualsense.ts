/** Experimental Sony DualSense updater: HID feature reports F4/F5.
 * Adapted from nchie/dualsense-updater-rs (MIT). No firmware is bundled.
 * Explicitly fail closed for unsupported hardware and unexpected statuses.
 */
import { byId, setStatus, errorMessage } from "../ui.js";
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
const MAX_POLLS = 1000;

function hid(): HidApi | null {
  return (navigator as Navigator & {hid?: HidApi}).hid ?? null;
}

function expectDevice(device: HidDevice): void {
  if (device.vendorId !== VENDOR || device.productId !== PRODUCT)
    throw new Error("Unsupported device: expected standard wired DualSense (054c:0ce6).");
}

function firmwareVersion(bytes: Uint8Array): number {
  if (bytes.length < HEADER_SIZE || bytes.length > MAX_IMAGE_SIZE)
    throw new Error("Invalid firmware size.");
  return bytes[0x78] | (bytes[0x79] << 8);
}

function hex(value: number): string { return `0x${value.toString(16).padStart(4, "0")}`; }
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function parseInfo(report: DataView): {version: number; date: string; time: string} {
  // WebHID DataView excludes the report ID. The native hidapi implementation
  // receives the report ID and historically slices the following 64 bytes.
  if (report.byteLength < 46) throw new Error("Firmware info report is too short.");
  const ascii = (start: number, end: number) =>
    Array.from(new Uint8Array(report.buffer, report.byteOffset + start, end - start))
      .map((value) => String.fromCharCode(value)).join("").replace(/\0.*$/, "").trim();
  return {date: ascii(0, 12), time: ascii(12, 20), version: report.getUint16(44, true)};
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
  const report = await device.receiveFeatureReport(STATUS_REPORT);
  // WebHID strips the report ID; hidapi returns [0xf5, command, status, ...].
  if (report.byteLength < 2 || report.getUint8(0) !== expectedCommand)
    throw new Error(`Unexpected F5 response to command ${expectedCommand}.`);
  return report.getUint8(1);
}

async function waitFor(
  device: HidDevice, kind: number, pending: number[], accepted: number[],
): Promise<number> {
  for (let poll = 0; poll < MAX_POLLS; poll++) {
    const result = await status(device, kind);
    if (accepted.includes(result)) return result;
    if (!pending.includes(result))
      throw new Error(`Firmware command ${kind} failed with status ${hex(result)}.`);
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
  const picker = byId<HTMLInputElement>("ds-image");
  const imageStatus = byId<HTMLElement>("ds-image-status");
  const confirm = byId<HTMLInputElement>("ds-confirm");
  const update = byId<HTMLButtonElement>("ds-update");
  const updateStatus = byId<HTMLElement>("ds-update-status");
  const progress = byId<HTMLProgressElement>("ds-progress");
  const logEl = byId<HTMLPreElement>("ds-log");
  let device: HidDevice | null = null;
  let image: Uint8Array | null = null;
  let busy = false;
  let currentVersion: number | null = null;

  function ready(): void {
    update.disabled = busy || !device?.opened || !image || !confirm.checked;
    connect.disabled = busy;
    picker.disabled = busy;
    confirm.disabled = busy;
  }
  const log = (message: string) => { logEl.textContent += `${message}\n`; };

  async function attach(selected: HidDevice): Promise<void> {
    expectDevice(selected);
    if (device && device !== selected && device.opened) await device.close();
    device = selected;
    if (!device.opened) await device.open();
    const info = parseInfo(await device.receiveFeatureReport(INFO_REPORT));
    currentVersion = info.version;
    infoEl.replaceChildren();
    for (const [key, value] of Object.entries({
      Product: device.productName,
      "Firmware version": hex(info.version),
      "Build date": info.date,
      "Build time": info.time,
    })) {
      const dt = document.createElement("dt"); dt.textContent = key;
      const dd = document.createElement("dd"); dd.textContent = value;
      infoEl.append(dt, dd);
    }
    setStatus(connectionStatus, "Connected; firmware metadata read.", "ok");
    ready();
  }

  connect.addEventListener("click", async () => {
    const api = hid();
    if (!api) { setStatus(connectionStatus, "WebHID is unavailable; use desktop Chromium.", "error"); return; }
    try {
      const selected = await api.requestDevice({filters: [{vendorId: VENDOR, productId: PRODUCT}]});
      if (!selected.length) return;
      await attach(selected[0]);
    } catch (error) {
      setStatus(connectionStatus, errorMessage(error), "error");
    }
  });

  picker.addEventListener("change", async () => {
    const file = picker.files?.[0];
    image = null;
    confirm.checked = false;
    currentVersion = device?.opened ? currentVersion : null;
    try {
      if (!file || !/^FWUPDATE[0-9a-f]{4}\.bin$/i.test(file.name))
        throw new Error("Select an official FWUPDATE####.bin file.");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const nextVersion = firmwareVersion(bytes);
      if (currentVersion !== null && nextVersion <= currentVersion)
        throw new Error(`Image ${hex(nextVersion)} is not newer than ${hex(currentVersion)}.`);
      image = bytes;
      setStatus(imageStatus,
        `${file.name}: ${bytes.length} bytes; target firmware ${hex(nextVersion)}. ` +
          "Image authenticity and hardware compatibility NOT verified.", "warn");
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
  return {
    id: "dualsense", tabLabel: "DualSense", flow, help,
    async detect(): Promise<Detection> {
      const known = await hid()?.getDevices() ?? [];
      const found = known.some((item) => item.vendorId === VENDOR && item.productId === PRODUCT);
      return {detected: found, detail: found ? "Previously authorized HID device available." : ""};
    },
    activate(): void { ready(); },
    deactivate(): void { /* Do not close an in-progress flash on tab switch. */ },
  };
}
