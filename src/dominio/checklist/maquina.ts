/**
 * Máquina de estados del checklist de preparación.
 *
 * Recorre seis puntos en orden fijo y no avanza sin confirmación explícita del
 * anterior. La máquina es determinista: dado un estado y una clasificación,
 * el siguiente estado y la línea a pronunciar están completamente determinados.
 * El modelo de lenguaje no participa en esta decisión.
 */
import {
  ESTADOS_TERMINALES,
  type Clasificacion,
  type ContextoLlamada,
  type Estado,
  type EventoAuditoria,
} from '../tipos.js';
import { evaluarGuardrails, verificarContenidoCerrado, type Veredicto } from '../guardrails/index.js';
import { guion, todasLasLineas } from './guion.js';
import { coincideDiaMes, coincideDigitos, coincideHora, extraerHoraDicha, formatearHora } from './numeros.js';

export interface EstadoLlamada {
  idLlamada: string;
  estado: Estado;
  identidadVerificada: boolean;
  /** Cuántos factores de identidad se han confirmado. Se exige 2. */
  factoresConfirmados: number;
  /** Índice del fármaco que se está revisando. */
  indiceFarmaco: number;
  intentosAclaracion: number;
  grabacionAceptada: boolean;
  /** Datos capturados durante la llamada, sin interpretar. */
  capturado: {
    horaAyunoRepetida: string;
    farmacosConfirmados: string[];
    farmacosNoConfirmados: string[];
    examenesFaltantes: string;
    acompananteConfirmado: boolean | null;
    sintomaLiteral: string;
    consultaLiteral: string;
    solicitoPersona: boolean;
    rechazoGrabacion: boolean;
  };
  auditoria: EventoAuditoria[];
}

export function estadoInicial(idLlamada: string): EstadoLlamada {
  return {
    idLlamada,
    estado: 'apertura',
    identidadVerificada: false,
    factoresConfirmados: 0,
    indiceFarmaco: 0,
    intentosAclaracion: 0,
    grabacionAceptada: true,
    capturado: {
      horaAyunoRepetida: '',
      farmacosConfirmados: [],
      farmacosNoConfirmados: [],
      examenesFaltantes: '',
      acompananteConfirmado: null,
      sintomaLiteral: '',
      consultaLiteral: '',
      solicitoPersona: false,
      rechazoGrabacion: false,
    },
    auditoria: [],
  };
}

export interface ResultadoPaso {
  estado: EstadoLlamada;
  /** Línea que el agente debe pronunciar. Siempre proviene del guion. */
  salida: string;
  /** Si la llamada debe transferirse a una persona tras pronunciar la salida. */
  transferir: boolean;
  /** Si la llamada termina tras pronunciar la salida. */
  terminar: boolean;
}

/** Primer turno: el agente habla antes de que el paciente diga nada. */
export function abrir(ctx: ContextoLlamada, st: EstadoLlamada): ResultadoPaso {
  const salida = guion.apertura(ctx);
  const nuevo = registrar(st, st.estado, 'apertura', 'Inicio de llamada.', '', salida, null);
  return { estado: nuevo, salida, transferir: false, terminar: false };
}

/**
 * Avanza un turno. Recibe lo que dijo el paciente y su clasificación.
 * Devuelve el nuevo estado y la línea a pronunciar.
 */
export function avanzar(
  ctx: ContextoLlamada,
  st: EstadoLlamada,
  entradaPaciente: string,
  cls: Clasificacion,
): ResultadoPaso {
  if (ESTADOS_TERMINALES.includes(st.estado)) {
    return { estado: st, salida: '', transferir: false, terminar: true };
  }

  // Los guardrails se evalúan SIEMPRE y antes de cualquier lógica de avance.
  const v = evaluarGuardrails({
    estadoActual: st.estado,
    identidadVerificada: st.identidadVerificada,
    entradaPaciente,
    clasificacion: cls,
    intentosAclaracion: st.intentosAclaracion,
  });

  if (v.tipo !== 'continuar') {
    return aplicarVeredicto(ctx, st, entradaPaciente, cls, v);
  }

  // Situaciones que no son guardrail pero sí cortan el flujo normal.
  if (cls.intencion === 'no_es_buen_momento') {
    const salida = guion.noEsBuenMomento();
    return terminarCon(st, 'terminada_rechazo', 'El paciente pidió ser llamado en otro momento.', entradaPaciente, salida, null);
  }
  if (cls.intencion === 'rechaza_grabacion') {
    const salida = guion.rechazoGrabacion();
    const s = { ...st, grabacionAceptada: false, capturado: { ...st.capturado, rechazoGrabacion: true } };
    const nuevo = registrar(s, st.estado, st.estado, 'Rechazo de grabación. La llamada continúa sin grabar.', entradaPaciente, salida, 'consentimiento_grabacion');
    return { estado: nuevo, salida, transferir: false, terminar: false };
  }
  if (cls.intencion === 'pide_repetir') {
    return repetir(ctx, st, entradaPaciente);
  }

  return transicion(ctx, st, entradaPaciente, cls);
}

// ---------------------------------------------------------------------------

function transicion(
  ctx: ContextoLlamada,
  st: EstadoLlamada,
  entrada: string,
  cls: Clasificacion,
): ResultadoPaso {
  const anterior = st.estado;

  switch (st.estado) {
    case 'apertura': {
      if (cls.intencion === 'confirma') {
        const salida = guion.pedirVerificacion();
        return avanzarA(st, anterior, 'verificacion_identidad', 'El interlocutor afirma ser el paciente. Se pide primer factor.', entrada, salida);
      }
      // Cualquier respuesta que no sea una confirmación clara cierra sin contenido clínico.
      const salida = guion.verificacionFallida();
      return terminarCon(st, 'terminada_sin_verificar', 'El interlocutor no confirmó ser el paciente.', entrada, salida, 'compuerta_identidad');
    }

    case 'verificacion_identidad': {
      if (cls.intencion !== 'responde_dato') {
        return reintentar(ctx, st, entrada, 'No se obtuvo el dato de verificación.');
      }
      // Lo dicho puede venir en cifras o en palabras; se compara como número.
      const dicho = cls.valorLiteral || entrada;
      const coincide =
        st.factoresConfirmados === 0
          ? coincideDigitos(dicho, ctx.verificacion.rutUltimosCuatro)
          : coincideDiaMes(dicho, ctx.verificacion.diaMesProcedimiento);
      if (!coincide) {
        const salida = guion.verificacionFallida();
        return terminarCon(st, 'terminada_sin_verificar', `Factor de verificación incorrecto (posición ${st.factoresConfirmados + 1}).`, entrada, salida, 'compuerta_identidad');
      }
      const factores = st.factoresConfirmados + 1;
      if (factores < 2) {
        const salida = guion.pedirSegundoFactor();
        const s = { ...st, factoresConfirmados: factores, intentosAclaracion: 0 };
        const nuevo = registrar(s, anterior, 'verificacion_identidad', 'Primer factor correcto. Se pide el segundo.', entrada, salida, null);
        return { estado: nuevo, salida, transferir: false, terminar: false };
      }
      // Dos factores correctos: recién ahora es lícito entregar contenido clínico.
      const salida = guion.ayuno(ctx);
      const s = { ...st, factoresConfirmados: factores, identidadVerificada: true, intentosAclaracion: 0 };
      const nuevo = registrar(s, anterior, 'ayuno', 'Identidad verificada con dos factores. Se abre el contenido clínico.', entrada, salida, 'compuerta_identidad');
      return { estado: { ...nuevo, estado: 'ayuno' }, salida, transferir: false, terminar: false };
    }

    case 'ayuno': {
      // Se exige que el paciente REPITA la hora. Un "sí" no cuenta como comprensión.
      // «A las diez» vale por 22:00 en un ayuno nocturno; «diez de la mañana» no.
      if (coincideHora(cls.valorLiteral || entrada, ctx.indicacion.horaInicioAyuno)) {
        const s = { ...st, intentosAclaracion: 0, capturado: { ...st.capturado, horaAyunoRepetida: ctx.indicacion.horaInicioAyuno } };
        return siguienteBloqueTrasAyuno(ctx, s, entrada);
      }
      if (st.intentosAclaracion >= 1) {
        // Segundo fallo: no se da por comprendido. Pasa a una persona.
        const salida = guion.transferenciaIncomprension();
        return transferirCon(st, 'transferida_incomprension', 'El paciente no repitió correctamente la hora de ayuno tras dos intentos.', entrada, salida, 'ayuno_no_comprendido');
      }
      const salida = guion.ayunoNoConfirmado(ctx);
      const s = { ...st, intentosAclaracion: st.intentosAclaracion + 1 };
      const nuevo = registrar(s, anterior, 'ayuno', 'La hora repetida no coincide. Se repite la indicación.', entrada, salida, null);
      return { estado: nuevo, salida, transferir: false, terminar: false };
    }

    case 'farmacos': {
      const f = ctx.indicacion.farmacosASuspender[st.indiceFarmaco];
      if (!f) return siguienteBloqueTrasFarmacos(ctx, st, entrada);

      if (cls.intencion === 'confirma') {
        const s = {
          ...st,
          indiceFarmaco: st.indiceFarmaco + 1,
          intentosAclaracion: 0,
          capturado: { ...st.capturado, farmacosConfirmados: [...st.capturado.farmacosConfirmados, f.nombre] },
        };
        return siguienteFarmacoOBloque(ctx, s, entrada);
      }
      if (st.intentosAclaracion >= 1) {
        // El fármaco es el ítem de mayor consecuencia clínica: no se deja pasar.
        const salida = guion.transferenciaIncomprension();
        const s = {
          ...st,
          capturado: { ...st.capturado, farmacosNoConfirmados: [...st.capturado.farmacosNoConfirmados, f.nombre] },
        };
        return transferirCon(s, 'transferida_incomprension', `Fármaco "${f.nombre}" no confirmado tras dos intentos.`, entrada, salida, 'farmaco_no_confirmado');
      }
      const salida = guion.farmacoNoConfirmado(ctx, st.indiceFarmaco);
      const s = { ...st, intentosAclaracion: st.intentosAclaracion + 1 };
      const nuevo = registrar(s, anterior, 'farmacos', `Sin confirmación de "${f.nombre}". Se repite.`, entrada, salida, null);
      return { estado: nuevo, salida, transferir: false, terminar: false };
    }

    case 'examenes': {
      if (cls.intencion === 'confirma') {
        const s = { ...st, intentosAclaracion: 0 };
        return siguienteBloqueTrasExamenes(ctx, s, entrada);
      }
      if (cls.intencion === 'niega' && st.capturado.examenesFaltantes === '') {
        const salida = guion.examenesCuales();
        const s = { ...st, capturado: { ...st.capturado, examenesFaltantes: 'pendiente' } };
        const nuevo = registrar(s, anterior, 'examenes', 'El paciente declara no tener todos los exámenes. Se pregunta cuáles.', entrada, salida, null);
        return { estado: nuevo, salida, transferir: false, terminar: false };
      }
      // Se registra literalmente lo que falta, sin interpretar.
      const s = {
        ...st,
        intentosAclaracion: 0,
        capturado: { ...st.capturado, examenesFaltantes: cls.valorLiteral || entrada },
      };
      return siguienteBloqueTrasExamenes(ctx, s, entrada);
    }

    case 'logistica': {
      const requiere = ctx.indicacion.requiereAcompanante;
      const acompanante = requiere ? cls.intencion === 'confirma' : null;
      const s = { ...st, intentosAclaracion: 0, capturado: { ...st.capturado, acompananteConfirmado: acompanante } };
      const salida = guion.cierre();
      const nuevo = registrar(s, anterior, 'cierre', requiere ? `Acompañante: ${acompanante ? 'confirmado' : 'no confirmado'}.` : 'Hora de llegada comunicada.', entrada, salida, null);
      return { estado: { ...nuevo, estado: 'terminada_ok' }, salida, transferir: false, terminar: true };
    }

    case 'divulgacion':
    case 'cierre':
    default: {
      const salida = guion.cierre();
      return terminarCon(st, 'terminada_ok', 'Cierre de llamada.', entrada, salida, null);
    }
  }
}

// ---- avance entre bloques -------------------------------------------------

function siguienteBloqueTrasAyuno(ctx: ContextoLlamada, st: EstadoLlamada, entrada: string): ResultadoPaso {
  if (ctx.indicacion.farmacosASuspender.length > 0) {
    const salida = guion.farmaco(ctx, 0);
    const nuevo = registrar({ ...st, indiceFarmaco: 0 }, st.estado, 'farmacos', 'Ayuno comprendido. Se abre el bloque de fármacos.', entrada, salida, null);
    return { estado: { ...nuevo, estado: 'farmacos' }, salida, transferir: false, terminar: false };
  }
  return siguienteBloqueTrasFarmacos(ctx, st, entrada);
}

function siguienteFarmacoOBloque(ctx: ContextoLlamada, st: EstadoLlamada, entrada: string): ResultadoPaso {
  if (st.indiceFarmaco < ctx.indicacion.farmacosASuspender.length) {
    const salida = guion.farmaco(ctx, st.indiceFarmaco);
    const nuevo = registrar(st, 'farmacos', 'farmacos', 'Fármaco confirmado. Se pasa al siguiente.', entrada, salida, null);
    return { estado: nuevo, salida, transferir: false, terminar: false };
  }
  return siguienteBloqueTrasFarmacos(ctx, st, entrada);
}

function siguienteBloqueTrasFarmacos(ctx: ContextoLlamada, st: EstadoLlamada, entrada: string): ResultadoPaso {
  if (ctx.indicacion.examenesRequeridos.length > 0) {
    const salida = guion.examenes(ctx);
    const nuevo = registrar(st, st.estado, 'examenes', 'Se abre el bloque de exámenes.', entrada, salida, null);
    return { estado: { ...nuevo, estado: 'examenes' }, salida, transferir: false, terminar: false };
  }
  return siguienteBloqueTrasExamenes(ctx, st, entrada);
}

function siguienteBloqueTrasExamenes(ctx: ContextoLlamada, st: EstadoLlamada, entrada: string): ResultadoPaso {
  const salida = ctx.indicacion.requiereAcompanante
    ? guion.logisticaConAcompanante(ctx)
    : guion.logisticaSinAcompanante(ctx);
  const nuevo = registrar(st, st.estado, 'logistica', 'Se abre el bloque de logística.', entrada, salida, null);
  return { estado: { ...nuevo, estado: 'logistica' }, salida, transferir: false, terminar: false };
}

// ---- utilidades -----------------------------------------------------------

function aplicarVeredicto(
  ctx: ContextoLlamada,
  st: EstadoLlamada,
  entrada: string,
  cls: Clasificacion,
  v: Veredicto,
): ResultadoPaso {
  if (v.tipo === 'terminar') {
    const salida = guion.verificacionFallida();
    return terminarCon(st, v.estado, v.detalle, entrada, salida, v.guardrail);
  }
  if (v.tipo === 'transferir') {
    switch (v.motivo) {
      case 'sintoma_alarma': {
        const s = { ...st, capturado: { ...st.capturado, sintomaLiteral: cls.sintomaLiteral || entrada } };
        return transferirCon(s, 'transferida_alarma', v.detalle, entrada, guion.transferenciaAlarma(), v.guardrail);
      }
      case 'consulta_clinica': {
        const s = { ...st, capturado: { ...st.capturado, consultaLiteral: cls.preguntaLiteral || entrada } };
        return transferirCon(s, 'transferida_consulta', v.detalle, entrada, guion.transferenciaConsulta(), v.guardrail);
      }
      case 'solicitud_del_paciente': {
        const s = { ...st, capturado: { ...st.capturado, solicitoPersona: true } };
        return transferirCon(s, 'transferida_consulta', v.detalle, entrada, guion.transferenciaSolicitada(), v.guardrail);
      }
      default:
        return transferirCon(st, 'transferida_incomprension', v.detalle, entrada, guion.transferenciaIncomprension(), v.guardrail);
    }
  }
  return { estado: st, salida: '', transferir: false, terminar: false };
}

function repetir(ctx: ContextoLlamada, st: EstadoLlamada, entrada: string): ResultadoPaso {
  const salida = lineaActual(ctx, st);
  const s = { ...st, intentosAclaracion: st.intentosAclaracion + 1 };
  const nuevo = registrar(s, st.estado, st.estado, 'El paciente pidió repetir.', entrada, salida, null);
  return { estado: nuevo, salida, transferir: false, terminar: false };
}

function reintentar(ctx: ContextoLlamada, st: EstadoLlamada, entrada: string, motivo: string): ResultadoPaso {
  const salida = lineaActual(ctx, st);
  const s = { ...st, intentosAclaracion: st.intentosAclaracion + 1 };
  const nuevo = registrar(s, st.estado, st.estado, motivo, entrada, salida, null);
  return { estado: nuevo, salida, transferir: false, terminar: false };
}

/** Devuelve la línea correspondiente al estado actual, para repeticiones. */
function lineaActual(ctx: ContextoLlamada, st: EstadoLlamada): string {
  switch (st.estado) {
    case 'apertura':
      return guion.apertura(ctx);
    case 'verificacion_identidad':
      return st.factoresConfirmados === 0 ? guion.pedirVerificacion() : guion.pedirSegundoFactor();
    case 'ayuno':
      return guion.ayunoNoConfirmado(ctx);
    case 'farmacos':
      return guion.farmacoNoConfirmado(ctx, st.indiceFarmaco);
    case 'examenes':
      return guion.examenes(ctx);
    case 'logistica':
      return ctx.indicacion.requiereAcompanante
        ? guion.logisticaConAcompanante(ctx)
        : guion.logisticaSinAcompanante(ctx);
    default:
      return guion.noEscucho();
  }
}

function avanzarA(st: EstadoLlamada, anterior: Estado, nuevoEstado: Estado, motivo: string, entrada: string, salida: string): ResultadoPaso {
  const s = registrar({ ...st, intentosAclaracion: 0 }, anterior, nuevoEstado, motivo, entrada, salida, null);
  return { estado: { ...s, estado: nuevoEstado }, salida, transferir: false, terminar: false };
}

function transferirCon(st: EstadoLlamada, estado: Estado, motivo: string, entrada: string, salida: string, guardrail: string | null): ResultadoPaso {
  const s = registrar(st, st.estado, estado, motivo, entrada, salida, guardrail);
  return { estado: { ...s, estado }, salida, transferir: true, terminar: false };
}

function terminarCon(st: EstadoLlamada, estado: Estado, motivo: string, entrada: string, salida: string, guardrail: string | null): ResultadoPaso {
  const s = registrar(st, st.estado, estado, motivo, entrada, salida, guardrail);
  return { estado: { ...s, estado }, salida, transferir: false, terminar: true };
}

function registrar(
  st: EstadoLlamada,
  anterior: Estado,
  nuevo: Estado,
  motivo: string,
  entrada: string,
  salida: string,
  guardrail: string | null,
): EstadoLlamada {
  const evento: EventoAuditoria = {
    idLlamada: st.idLlamada,
    ts: new Date().toISOString(),
    estadoAnterior: anterior,
    estadoNuevo: nuevo,
    motivo,
    entradaPaciente: entrada,
    salidaAgente: salida,
    guardrail,
  };
  return { ...st, auditoria: [...st.auditoria, evento] };
}

/** Extrae una hora HH:MM de un texto, en cifras o en palabras. Sin hora reconocible devuelve ''. */
export function extraerHora(texto: string): string {
  const h = extraerHoraDicha(texto);
  return h ? formatearHora(h) : '';
}

/**
 * Verifica que toda salida producida por la máquina pertenezca al guion.
 * Se invoca desde la capa de transporte antes de entregar el texto a la voz.
 */
export function validarSalida(ctx: ContextoLlamada, salida: string): { valida: boolean; motivo: string } {
  if (salida === '') return { valida: true, motivo: '' };
  return verificarContenidoCerrado(salida, todasLasLineas(ctx));
}
