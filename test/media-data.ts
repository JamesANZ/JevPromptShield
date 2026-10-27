import { readFileSync } from "node:fs";

export const pngBytes = readFileSync(new URL("../../test/fixtures/benign.png", import.meta.url));
export const jpegBytes = readFileSync(new URL("../../test/fixtures/benign.jpg", import.meta.url));
export const wavBytes = readFileSync(new URL("../../test/fixtures/benign.wav", import.meta.url));
export const pngBase64 = pngBytes.toString("base64");
export const wavBase64 = wavBytes.toString("base64");
