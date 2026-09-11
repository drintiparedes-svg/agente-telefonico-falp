import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verificación de la firma HMAC de los webhooks entrantes.
 *
 * Formato de la cabecera: `t=<unix>,v0=<hex>`, y la firma se calcula sobre
 * `<t>.<cuerpo crudo>`. Se verifica sobre el cuerpo CRUDO: reserializar el JSON
 * cambia los bytes y la firma deja de coincidir.
 */
export interface ResultadoVerificacion {
  valida: boolean;
  motivo: string;
}

const TOLERANCIA_SEGUNDOS = 30 * 60;

export function verificarFirma(
  cuerpoCrudo: string,
  cabecera: string | undefined,
  secreto: string,
  ahoraMs: number = Date.now(),
): ResultadoVerificacion {
  if (!cabecera) return { valida: false, motivo: 'Falta la cabecera de firma.' };

  const partes = Object.fromEntries(
    cabecera.split(',').map((p) => {
      const i = p.indexOf('=');
      return i === -1 ? [p.trim(), ''] : [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  ) as Record<string, string>;

  const t = partes['t'];
  const v0 = partes['v0'];
  if (!t || !v0) return { valida: false, motivo: 'Cabecera de firma mal formada.' };

  const ts = Number(t);
  if (!Number.isFinite(ts)) return { valida: false, motivo: 'Marca de tiempo inválida.' };

  const desfase = Math.abs(Math.floor(ahoraMs / 1000) - ts);
  if (desfase > TOLERANCIA_SEGUNDOS) {
    return { valida: false, motivo: `Marca de tiempo fuera de tolerancia (${desfase} s).` };
  }

  const esperado = createHmac('sha256', secreto).update(`${t}.${cuerpoCrudo}`).digest('hex');
  const a = Buffer.from(esperado, 'utf8');
  const b = Buffer.from(v0, 'utf8');
  if (a.length !== b.length) return { valida: false, motivo: 'Firma no coincide.' };
  // timingSafeEqual para no filtrar información por el tiempo de comparación.
  if (!timingSafeEqual(a, b)) return { valida: false, motivo: 'Firma no coincide.' };

  return { valida: true, motivo: '' };
}

/** Utilidad para pruebas y para el simulador de llamadas. */
export function firmar(cuerpoCrudo: string, secreto: string, ahoraMs: number = Date.now()): string {
  const t = Math.floor(ahoraMs / 1000).toString();
  const v0 = createHmac('sha256', secreto).update(`${t}.${cuerpoCrudo}`).digest('hex');
  return `t=${t},v0=${v0}`;
}
