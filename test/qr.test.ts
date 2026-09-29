import { describe, expect, test } from "bun:test";
import { qrMatrix, qrTerminal } from "../src/qr";

// Decoding was checked against zbarimg for versions 1, 4, 8, 13 and 26; these tests pin the structure.
describe("qr", () => {
  test("picks the smallest version that fits", () => {
    expect(qrMatrix("hi").length).toBe(21); // version 1
    expect(qrMatrix("http://neptune:4747/?key=abcdefghijklmnopqrstuvwxyz012345").length).toBe(33); // version 4
    expect(() => qrMatrix("x".repeat(3000))).toThrow();
  });

  test("draws the finder patterns and timing lines", () => {
    const m = qrMatrix("http://example.com/");
    const n = m.length;
    for (const [x0, y0] of [[0, 0], [n - 7, 0], [0, n - 7]])
      for (let d = 0; d < 7; d++) {
        expect(m[y0][x0 + d]).toBe(true);
        expect(m[y0 + 6][x0 + d]).toBe(true);
        expect(m[y0 + 1][x0 + 1 + (d % 5)]).toBe(false);
      }
    for (let i = 8; i < n - 8; i++) {
      expect(m[6][i]).toBe(i % 2 === 0);
      expect(m[i][6]).toBe(i % 2 === 0);
    }
    expect(m[n - 8][8]).toBe(true); // the dark module
  });

  test("writes format bits for level M with a valid BCH code, twice", () => {
    const m = qrMatrix("hello");
    const n = m.length;
    let a = 0;
    let b = 0;
    const first = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
    first.forEach(([x, y], i) => (a |= (m[y][x] ? 1 : 0) << i));
    for (let i = 0; i < 8; i++) b |= (m[8][n - 1 - i] ? 1 : 0) << i;
    for (let i = 8; i < 15; i++) b |= (m[n - 15 + i][8] ? 1 : 0) << i;
    expect(a).toBe(b);
    const f = a ^ 0x5412;
    expect(f >>> 13).toBe(0); // level M
    let rem = f >>> 10;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    expect(rem & 0x3ff).toBe(f & 0x3ff);
  });

  test("renders two rows per line with a quiet zone", () => {
    const lines = qrTerminal("hi").split("\n");
    expect(lines.length).toBe(Math.ceil((21 + 8) / 2));
    const plain = lines[0].replace(/\x1b\[[\d;]*m/g, "");
    expect(plain).toBe(" ".repeat(29));
  });
});
