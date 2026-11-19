/**
 * 生成 UUID v4。
 *
 * crypto.randomUUID() 只在安全上下文（HTTPS / localhost）可用；
 * 通过局域网 IP 走 http 访问时该方法不存在，这里降级用
 * crypto.getRandomValues() 手动拼装符合 RFC 4122 的 v4 字符串。
 */

export function generateUUID() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  if (
    typeof crypto !== "undefined" &&
    typeof crypto.getRandomValues === "function"
  ) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));

    // 版本位：0100（v4）；变体位：10xx
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    const hex = Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");

    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20),
    ].join("-");
  }

  throw new Error("当前浏览器不支持生成随机 ID，请使用 HTTPS 或 localhost 访问。");
}
