// SHA-256（16進・小文字64文字）。署名済み PDF の「指紋」として DB に残し、あとで同じファイルかを照合できるようにする（監査 2026-11-11 M2）
export async function sha256Hex(src: Blob | ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = src instanceof Uint8Array ? src : new Uint8Array(src instanceof ArrayBuffer ? src : await src.arrayBuffer());
  const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, "0")).join("");
}
