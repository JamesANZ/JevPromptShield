/** Stable 32-bit FNV-1a. Even hashes are dev, odd hashes are test. */
export function splitForId(id: string): "dev" | "test" {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 2 === 0 ? "dev" : "test";
}
