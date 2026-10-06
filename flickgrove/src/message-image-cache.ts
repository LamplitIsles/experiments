// Preview blobs survive row recycling; object URLs remain component-owned.
// No persistence, originals, credentials or message copies. 32 x 160KB previews.
const previews = new Map<string, Promise<Blob>>();
export function messageImagePreview(key: string, load: () => Promise<Blob>) {
  let preview = previews.get(key);
  if (!preview) preview = load();
  previews.delete(key);
  previews.set(key, preview);
  if (previews.size > 32) previews.delete(previews.keys().next().value!);
  return preview;
}

// Explicit retry also replaces a retained rejected request after row recycling.
export function retryMessageImagePreview(key: string) {
  previews.delete(key);
}

export function hasMessageImagePreview(key: string) {
  return previews.has(key);
}
