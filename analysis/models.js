// Small, dependency-free statistical models used by the build step.
// Rows are sparse: an array of [featureIndex, value] pairs.

export function mean(xs) {
  if (!xs.length) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

export function std(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}

export function pearson(a, b) {
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

// Solve (A) x = b for symmetric positive-definite A (dense, row-major Float64Array n*n).
function choleskySolve(A, b, n) {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) L[i * n + i] = Math.sqrt(Math.max(s, 1e-12));
      else L[i * n + j] = s / L[j * n + j];
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k];
    y[i] = s / L[i * n + i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k];
    x[i] = s / L[i * n + i];
  }
  return x;
}

// Ridge regression on sparse rows. Intercept is fitted unpenalised by centring y.
// penalties: optional per-feature multiplier on lambda (defaults to 1).
export function fitRidge(rows, y, nFeatures, lambda, penalties) {
  const n = nFeatures;
  const yMean = mean(y);
  // Centre features so the intercept stays unpenalised.
  const colMean = new Float64Array(n);
  for (const row of rows) for (const [j, v] of row) colMean[j] += v;
  for (let j = 0; j < n; j++) colMean[j] /= rows.length || 1;

  const A = new Float64Array(n * n);
  const b = new Float64Array(n);
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const yc = y[r] - yMean;
    for (const [j, v] of row) {
      b[j] += v * yc;
      for (const [k, w] of row) A[j * n + k] += v * w;
    }
  }
  // Subtract the mean outer product: sum (x - m)(x - m)^T = sum x x^T - N m m^T.
  // Also b: sum (x - m) yc = sum x yc (since sum yc = 0).
  const N = rows.length;
  for (let j = 0; j < n; j++) {
    if (!colMean[j]) continue;
    for (let k = 0; k < n; k++) {
      if (colMean[k]) A[j * n + k] -= N * colMean[j] * colMean[k];
    }
  }
  for (let j = 0; j < n; j++) A[j * n + j] += lambda * (penalties ? penalties[j] : 1);
  const w = choleskySolve(A, b, n);
  let intercept = yMean;
  for (let j = 0; j < n; j++) intercept -= w[j] * colMean[j];
  return { w, intercept };
}

export function predictSparse(model, row) {
  let s = model.intercept;
  for (const [j, v] of row) s += model.w[j] * v;
  return s;
}

// Deterministic shuffle so CV folds (and the reported accuracy) are stable between builds.
export function seededOrder(n, seed = 7) {
  const idx = Array.from({ length: n }, (_, i) => i);
  let s = seed >>> 0;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx;
}

// K-fold cross-validated ridge. Returns the best lambda and out-of-fold predictions.
export function cvRidge(rows, y, nFeatures, lambdas, k = 5, penalties) {
  const order = seededOrder(rows.length);
  const folds = Array.from({ length: k }, () => []);
  order.forEach((idx, i) => folds[i % k].push(idx));
  let best = null;
  for (const lambda of lambdas) {
    const oof = new Float64Array(rows.length);
    for (let f = 0; f < k; f++) {
      const test = new Set(folds[f]);
      const trR = [], trY = [];
      for (let i = 0; i < rows.length; i++) if (!test.has(i)) { trR.push(rows[i]); trY.push(y[i]); }
      const m = fitRidge(trR, trY, nFeatures, lambda, penalties);
      for (const i of folds[f]) oof[i] = predictSparse(m, rows[i]);
    }
    let mae = 0, mse = 0;
    for (let i = 0; i < rows.length; i++) {
      const p = clamp(oof[i], 0.5, 5);
      mae += Math.abs(p - y[i]);
      mse += (p - y[i]) ** 2;
    }
    mae /= rows.length || 1;
    const rmse = Math.sqrt(mse / (rows.length || 1));
    if (!best || rmse < best.rmse) best = { lambda, mae, rmse, oof: Array.from(oof) };
  }
  return best;
}

export function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

// L2-regularised logistic regression on dense, standardised features (gradient descent).
export function fitLogistic(X, y, { lambda = 1, iters = 3000, lr = 0.1, weights } = {}) {
  const n = X.length, p = X[0]?.length || 0;
  const w = new Float64Array(p);
  let b = 0;
  const sw = weights || X.map(() => 1);
  const tot = sw.reduce((a, c) => a + c, 0) || 1;
  for (let it = 0; it < iters; it++) {
    const gw = new Float64Array(p);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = b;
      for (let j = 0; j < p; j++) z += w[j] * X[i][j];
      const pr = 1 / (1 + Math.exp(-z));
      const e = (pr - y[i]) * sw[i];
      gb += e;
      for (let j = 0; j < p; j++) gw[j] += e * X[i][j];
    }
    for (let j = 0; j < p; j++) w[j] -= lr * (gw[j] / tot + (lambda / tot) * w[j]);
    b -= lr * (gb / tot);
  }
  return { w: Array.from(w), b };
}

export function logisticProb(model, x) {
  let z = model.b;
  for (let j = 0; j < x.length; j++) z += model.w[j] * x[j];
  return 1 / (1 + Math.exp(-z));
}

// Dense ridge (small p), used for the rank-position model.
export function fitDenseRidge(X, y, lambda = 1) {
  const rows = X.map(r => r.map((v, j) => [j, v]));
  return fitRidge(rows, y, X[0]?.length || 0, lambda);
}

export function standardiser(X) {
  const p = X[0]?.length || 0;
  const mu = [], sd = [];
  for (let j = 0; j < p; j++) {
    const col = X.map(r => r[j]);
    mu.push(mean(col));
    sd.push(std(col) || 1);
  }
  return { mu, sd, apply: r => r.map((v, j) => (v - mu[j]) / sd[j]) };
}

// Area under the ROC curve (rank-based).
export function auc(scores, labels) {
  const pairs = scores.map((s, i) => [s, labels[i]]).sort((a, b) => a[0] - b[0]);
  let rankSum = 0, pos = 0, neg = 0;
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i][1]) { rankSum += i + 1; pos++; } else neg++;
  }
  if (!pos || !neg) return null;
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

export function spearman(a, b) {
  const rank = xs => {
    const idx = xs.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
    const r = new Array(xs.length);
    idx.forEach(([, i], k) => (r[i] = k));
    return r;
  };
  return pearson(rank(a), rank(b));
}
