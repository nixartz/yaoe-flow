// Diff linha-a-linha bem simples (LCS clássico) — suficiente pra comparar
// duas versões de SOUL na tela Agents (§6.5). Sem dependência nova.
export type DiffOp = { type: "equal" | "add" | "remove"; line: string };

export function diffLines(a: string, b: string): DiffOp[] {
  const A = a.split("\n");
  const B = b.split("\n");
  const n = A.length;
  const m = B.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = A[i] === B[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      ops.push({ type: "equal", line: A[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ type: "remove", line: A[i] });
      i++;
    } else {
      ops.push({ type: "add", line: B[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: "remove", line: A[i++] });
  while (j < m) ops.push({ type: "add", line: B[j++] });
  return ops;
}
