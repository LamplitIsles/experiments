import { storagePrefix, readingCache } from "./api";
export const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";
export type ImageDraft = { id: string; file: File };
type Record = { key: string; images: ImageDraft[]; text: string; at: number };
let database: Promise<IDBDatabase> | undefined;
function db() {
  return (database ??= new Promise((resolve, reject) => {
    const open = indexedDB.open(`${storagePrefix}/images`, 1);
    open.onupgradeneeded = () =>
      open.result.createObjectStore("drafts", { keyPath: "key" });
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => {
      database = undefined;
      reject(
        new Error(
          "Could not save images on this device. Keep this page open and try again.",
        ),
      );
    };
  }));
}
function done(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () =>
      reject(
        new Error(
          "Image storage full or unavailable. Keep this page open and try again.",
        ),
      );
  });
}
function result<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function loadImages(key: string): Promise<Record | undefined> {
  const database = await db();
  return result(database.transaction("drafts").objectStore("drafts").get(key));
}
let queue = Promise.resolve();
export function saveImages(key: string, images: ImageDraft[], text = "") {
  const snapshot = images.map((image) => ({ id: image.id, file: image.file }));
  const work = queue
    .catch(() => {})
    .then(async () => {
      const database = await db();
      const tx = database.transaction("drafts", "readwrite");
      const completion = done(tx);
      const store = tx.objectStore("drafts");
      const records: Record[] = await result(store.getAll());
      // Device-owned blob storage has an explicit aggregate bound. No media base64.
      const bytes =
        records
          .filter((r) => r.key !== key)
          .flatMap((r) => r.images)
          .reduce((n, i) => n + i.file.size, 0) +
        snapshot.reduce((n, i) => n + i.file.size, 0);
      if (
        bytes > 200 * 1024 * 1024 ||
        (records.length >= 200 && !records.some((r) => r.key === key))
      ) {
        tx.abort();
        await completion;
      }
      if (!snapshot.length && !text) store.delete(key);
      else store.put({ key, images: snapshot, text, at: Date.now() });
      await completion;
    });
  queue = work;
  return work;
}
export const draftKey = (agent: string) => `draft/${agent}`;
export const operationKey = (agent: string, operation: string) =>
  `operation/${agent}/${operation}`;
export async function restoreImages(
  agent: string,
  operation: string,
  text: string,
) {
  const original = await loadImages(operationKey(agent, operation));
  const newer = await loadImages(draftKey(agent));
  const combined = [
    ...(newer?.images ?? []),
    ...(original?.images ?? []).filter(
      (i) => !newer?.images.some((n) => n.id === i.id),
    ),
  ];
  // A recovery may contain a full older batch alongside a newer batch; no silent
  // discard. The Composer asks the user to remove images before resubmitting.
  const textKey = `${storagePrefix}/composer/${agent}`;
  const newerText = localStorage.getItem(textKey) ?? "";
  const recovered = newerText.trim() ? `${newerText}\n\n${text}` : text;
  await saveImages(draftKey(agent), combined);
  readingCache.writeDevice(textKey, recovered);
  window.dispatchEvent(
    new CustomEvent("grove-image-recovery", { detail: agent }),
  );
}
export function intakeError(current: ImageDraft[], files: File[]) {
  if (current.length + files.length > 5)
    return "Choose up to 5 images per message.";
  if (files.some((f) => !IMAGE_ACCEPT.split(",").includes(f.type)))
    return "Choose PNG, JPEG, WebP or non-animated GIF.";
  if (files.some((f) => !f.size || f.size > 5 * 1024 * 1024))
    return "Each image must be at most 5 MiB.";
  if (
    [...current.map((i) => i.file), ...files].reduce((n, f) => n + f.size, 0) >
    20 * 1024 * 1024
  )
    return "Images must total at most 20 MiB.";
  return "";
}

// Preview encoding is intentionally lossy and separate from the retained original.
export async function imagePreview(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not prepare image preview.");
    for (const [side, quality] of [
      [480, 0.8],
      [320, 0.5],
    ]) {
      const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const preview = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/webp", quality),
      );
      if (preview && preview.size <= 160_000) return preview;
    }
    throw new Error("Could not prepare a bounded image preview.");
  } finally {
    bitmap.close();
  }
}
