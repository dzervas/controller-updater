// Download Sony's DualSense firmware index and every latest FWUPDATE image into
// data/dualsense/ so the static page can read them same-origin. Sony's CDN
// sends no CORS headers.
//
// info.json maps each updater target to its latest version, e.g.
//   "FwUpdate000ELatestVersion": "0x0641"
// and each image lives at fwupdate<target>/<version>/FWUPDATE<target>.bin.
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE_URL = "https://fwupdater.dl.playstation.net/fwupdater/";
const INFO_URL = `${BASE_URL}info.json`;
const OUT_DIR = "data/dualsense";

function sha256Base64Url(bytes) {
  return createHash("sha256")
    .update(bytes)
    .digest("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_");
}

async function fetchOk(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response;
}

const info = await (await fetchOk(INFO_URL)).json();
const firmware = [];
for (const [key, version] of Object.entries(info)) {
  const target = key.match(/^FwUpdate([0-9A-F]{4})LatestVersion$/i)?.[1];
  if (!target) continue;
  if (!/^0x[0-9a-f]{4}$/i.test(version)) throw new Error(`${key}: unexpected version ${version}`);
  const file = `fwupdate${target}/${version}/FWUPDATE${target}.bin`;
  const bytes = new Uint8Array(await (await fetchOk(BASE_URL + file)).arrayBuffer());
  // Same header checks as the page: target at 0x74, update version at 0x78.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 256 || view.getUint16(0x74, true) !== parseInt(target, 16) ||
      view.getUint16(0x78, true) !== parseInt(version, 16)) {
    throw new Error(`${file}: header does not match target ${target} version ${version}`);
  }
  firmware.push({
    target,
    version,
    file,
    size: bytes.length,
    sha256: sha256Base64Url(bytes),
    bytes,
  });
}
if (firmware.length === 0) throw new Error("info.json lists no firmware targets");

await rm(OUT_DIR, { recursive: true, force: true });
for (const { file, bytes } of firmware) {
  await mkdir(path.join(OUT_DIR, path.dirname(file)), { recursive: true });
  await writeFile(path.join(OUT_DIR, file), bytes);
  console.log(`downloaded ${file} (${bytes.length} bytes)`);
}
const feed = {
  sourceUrl: INFO_URL,
  generated: new Date().toISOString(),
  firmware: firmware.map(({ bytes, ...entry }) => entry),
};
await writeFile(path.join(OUT_DIR, "feed.json"), `${JSON.stringify(feed, null, 2)}\n`);
console.log(`wrote ${OUT_DIR}/feed.json (${firmware.length} targets)`);
