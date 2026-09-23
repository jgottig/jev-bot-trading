/**
 * Redondeo de cantidades y precios.
 *
 * Los exchanges rechazan ordenes con mas decimales de los permitidos, y los
 * flotantes de JS arrastran error (0.1 + 0.2 !== 0.3). Escalamos a entero antes
 * de redondear para que el resultado sea el que espera el exchange.
 */
export function roundTo(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return 0;
  const f = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * f) / f;
}

/**
 * Trunca hacia abajo con los decimales dados. Para cantidades a comprar usamos
 * truncado y no redondeo: redondear hacia arriba puede pedir mas de lo que hay
 * en la cuenta y hacer que el exchange rechace la orden entera.
 */
export function floorTo(value: number, decimals: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const f = 10 ** decimals;
  return Math.floor(value * f + Number.EPSILON) / f;
}

/** Formatea con decimales fijos, como espera el campo de texto del exchange. */
export function fixed(value: number, decimals: number): string {
  return value.toFixed(decimals);
}

/** Acota un valor al rango [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Variacion porcentual de `from` a `to`, en porcentaje (no en fraccion). */
export function pctChange(from: number, to: number): number {
  if (from === 0) return 0;
  return ((to - from) / from) * 100;
}

/** Redondea para mostrar en logs y en el estado que ve el modelo. */
export function r(value: number, decimals = 4): number {
  return roundTo(value, decimals);
}
